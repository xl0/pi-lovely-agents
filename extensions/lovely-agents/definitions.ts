import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	parseFrontmatter,
	type ScopedModel
} from "@earendil-works/pi-coding-agent"
import { MODEL_ALIASES, THINKING_LEVELS } from "./config.js"
import { errorMessage, hasCode } from "./utils.js"

const ALLOWED_KEYS = new Set(["name", "description", "model", "thinking", "tools", "exclude_agents_md"])
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type DefinitionSource = "user" | "project"
export type AgentThinkingLevel = (typeof THINKING_LEVELS)[number]

export type AgentDefinition = {
	name: string
	description: string
	systemPrompt: string
	source: DefinitionSource
	filePath: string
	displayPath: string
	model?: string
	thinking?: AgentThinkingLevel
	tools?: string[]
	excludeAgentsMd?: boolean
}

export type DefinitionDiagnostic = {
	type: "error" | "warning"
	code: string
	message: string
	source: DefinitionSource
	path: string
	name?: string
}

export type DefinitionDiscoveryResult = {
	definitions: AgentDefinition[]
	diagnostics: DefinitionDiagnostic[]
}

type DefinitionCandidate = {
	definition?: AgentDefinition
	declaredName?: string
	diagnostics: DefinitionDiagnostic[]
	filePath: string
	displayPath: string
	source: DefinitionSource
}

type AgentFrontmatter = Record<string, unknown> & {
	name?: unknown
	description?: unknown
	model?: unknown
	thinking?: unknown
	tools?: unknown
	exclude_agents_md?: unknown
}

/**
 * Pi reports projects without trust-requiring resources as trusted without asking,
 * and `.pi/agents` and Lovely config are not among those resources. Accept Pi's
 * answer only when it actually evaluated trust; otherwise require a saved /trust decision.
 */
export function projectResourcesTrusted(ctx: { cwd: string; isProjectTrusted(): boolean }): boolean {
	if (!ctx.isProjectTrusted()) return false
	return hasTrustRequiringProjectResources(ctx.cwd) || new ProjectTrustStore(getAgentDir()).get(ctx.cwd) === true
}

export function discoverAgentDefinitions(options: {
	cwd: string
	projectTrusted: boolean
	toolNames: readonly string[]
	models: readonly ScopedModel["model"][]
	agentDir?: string
	homeDir?: string
}): DefinitionDiscoveryResult {
	const cwd = resolve(options.cwd)
	const homeDir = resolve(options.homeDir ?? homedir())
	const userDir = join(options.agentDir ?? getAgentDir(), "agents")
	const projectAgentsDir = options.projectTrusted ? findNearestProjectAgentsDir(cwd) : undefined
	const userCandidates = scanDefinitionDirectory(userDir, "user", options.toolNames, options.models, cwd, homeDir)
	const projectCandidates = projectAgentsDir
		? scanDefinitionDirectory(projectAgentsDir, "project", options.toolNames, options.models, cwd, homeDir)
		: []

	invalidateDuplicates(userCandidates)
	invalidateDuplicates(projectCandidates)

	const diagnostics = [...userCandidates, ...projectCandidates].flatMap(candidate => candidate.diagnostics)
	const projectNames = new Set(projectCandidates.flatMap(candidate => candidate.declaredName ?? []))
	const definitions: AgentDefinition[] = []

	for (const candidate of userCandidates) {
		if (!candidate.definition) continue
		if (projectNames.has(candidate.definition.name)) {
			diagnostics.push({
				type: "warning",
				code: "shadowed",
				message: `User definition "${candidate.definition.name}" is shadowed by the project scope`,
				source: "user",
				path: candidate.displayPath,
				name: candidate.definition.name
			})
			continue
		}
		definitions.push(candidate.definition)
	}
	for (const candidate of projectCandidates) {
		if (candidate.definition) definitions.push(candidate.definition)
	}

	return {
		definitions: definitions.sort((left, right) => compareText(left.name, right.name)),
		diagnostics: diagnostics.sort(compareDiagnostics)
	}
}

export function findNearestProjectAgentsDir(cwd: string): string | undefined {
	let directory = resolve(cwd)
	while (true) {
		const candidate = join(directory, CONFIG_DIR_NAME, "agents")
		try {
			const stats = statSync(candidate)
			// Trust covers the user's own tree, not e.g. another user's /tmp/.pi/agents.
			if (stats.isDirectory() && (process.getuid === undefined || stats.uid === process.getuid())) return candidate
		} catch {
			// Missing, inaccessible, and broken links do not stop the ancestor walk.
		}
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

function scanDefinitionDirectory(
	directory: string,
	source: DefinitionSource,
	toolNames: readonly string[],
	models: readonly ScopedModel["model"][],
	cwd: string,
	homeDir: string
): DefinitionCandidate[] {
	let entries: Dirent[]
	try {
		entries = readdirSync(directory, { withFileTypes: true })
	} catch (error) {
		if (hasCode(error, "ENOENT")) return []
		return [diagnosticCandidate(directory, source, "directory-unreadable", errorMessage(error), cwd, homeDir)]
	}

	const candidates: DefinitionCandidate[] = []
	for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue
		const filePath = join(directory, entry.name)
		const displayPath = formatDisplayPath(filePath, source, cwd, homeDir)
		if (entry.isSymbolicLink()) {
			try {
				if (!statSync(filePath).isFile()) {
					candidates.push(diagnosticCandidate(filePath, source, "not-file", "Definition link does not target a regular file", cwd, homeDir))
					continue
				}
			} catch (error) {
				candidates.push(diagnosticCandidate(filePath, source, "unreadable-link", errorMessage(error), cwd, homeDir))
				continue
			}
		}
		candidates.push(parseDefinitionFile(filePath, displayPath, source, toolNames, models))
	}
	return candidates
}

function parseDefinitionFile(
	filePath: string,
	displayPath: string,
	source: DefinitionSource,
	toolNames: readonly string[],
	models: readonly ScopedModel["model"][]
): DefinitionCandidate {
	const candidate: DefinitionCandidate = { diagnostics: [], filePath, displayPath, source }
	let content: string
	try {
		content = readFileSync(filePath, "utf8")
	} catch (error) {
		candidate.diagnostics.push(makeDiagnostic(candidate, "unreadable", errorMessage(error)))
		return candidate
	}

	let frontmatter: AgentFrontmatter
	let body: string
	try {
		const parsed = parseFrontmatter<AgentFrontmatter>(content)
		frontmatter = parsed.frontmatter
		body = parsed.body
	} catch (error) {
		candidate.diagnostics.push(makeDiagnostic(candidate, "invalid-frontmatter", errorMessage(error)))
		return candidate
	}
	if (!isRecord(frontmatter)) {
		candidate.diagnostics.push(makeDiagnostic(candidate, "invalid-frontmatter", "Frontmatter must be a mapping"))
		return candidate
	}

	const rawName = frontmatter.name
	if (typeof rawName === "string" && NAME_PATTERN.test(rawName)) candidate.declaredName = rawName
	if (typeof rawName !== "string" || !NAME_PATTERN.test(rawName)) {
		candidate.diagnostics.push(
			makeDiagnostic(
				candidate,
				"invalid-name",
				"name must match [a-z0-9][a-z0-9_-]{0,63}",
				typeof rawName === "string" ? rawName : undefined
			)
		)
	}

	const unknownKeys = Object.keys(frontmatter)
		.filter(key => !ALLOWED_KEYS.has(key))
		.sort(compareText)
	for (const key of unknownKeys) {
		candidate.diagnostics.push(makeDiagnostic(candidate, "unknown-key", `Unknown frontmatter key "${key}"`, candidate.declaredName))
	}

	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : ""
	if (!description || Buffer.byteLength(description, "utf8") > 500) {
		candidate.diagnostics.push(
			makeDiagnostic(candidate, "invalid-description", "description must be nonempty and at most 500 UTF-8 bytes", candidate.declaredName)
		)
	}
	if (!body.trim())
		candidate.diagnostics.push(makeDiagnostic(candidate, "empty-body", "Definition body must be nonempty", candidate.declaredName))

	const model = parseDefinitionModel(frontmatter.model, models)
	if (model.error) candidate.diagnostics.push(makeDiagnostic(candidate, "invalid-model", model.error, candidate.declaredName))

	const thinking = parseThinkingLevel(frontmatter.thinking)
	if (thinking.error) candidate.diagnostics.push(makeDiagnostic(candidate, "invalid-thinking", thinking.error, candidate.declaredName))

	const tools = parseTools(frontmatter.tools, toolNames)
	if (tools.error) candidate.diagnostics.push(makeDiagnostic(candidate, "invalid-tools", tools.error, candidate.declaredName))

	const excludeAgentsMd = frontmatter.exclude_agents_md
	if (excludeAgentsMd !== undefined && typeof excludeAgentsMd !== "boolean") {
		candidate.diagnostics.push(
			makeDiagnostic(candidate, "invalid-exclude-agents-md", "exclude_agents_md must be boolean", candidate.declaredName)
		)
	}

	if (candidate.diagnostics.length === 0 && candidate.declaredName) {
		candidate.definition = {
			name: candidate.declaredName,
			description,
			systemPrompt: body,
			source,
			filePath,
			displayPath,
			...(model.value ? { model: model.value } : {}),
			...(thinking.value ? { thinking: thinking.value } : {}),
			...(tools.value ? { tools: tools.value } : {}),
			...(typeof excludeAgentsMd === "boolean" ? { excludeAgentsMd } : {})
		}
	}
	return candidate
}

function parseDefinitionModel(value: unknown, models: readonly ScopedModel["model"][]): { value?: string; error?: string } {
	if (value === undefined) return {}
	if (typeof value !== "string" || !value.trim()) return { error: "model must be a nonempty string" }
	const reference = value.trim().toLowerCase()
	if (Object.hasOwn(MODEL_ALIASES, reference)) return { value: reference }
	const canonical = models.filter(model => `${model.provider}/${model.id}`.toLowerCase() === reference)
	if (canonical.length === 1) return { value: `${canonical[0]?.provider}/${canonical[0]?.id}` }
	const byId = models.filter(model => model.id.toLowerCase() === reference)
	if (byId.length === 1) return { value: `${byId[0]?.provider}/${byId[0]?.id}` }
	if (byId.length > 1) {
		return {
			error: `model "${value.trim()}" is ambiguous: ${byId
				.map(model => `${model.provider}/${model.id}`)
				.sort(compareText)
				.join(", ")}`
		}
	}
	return { error: `unknown model "${value.trim()}"` }
}

function parseThinkingLevel(value: unknown): { value?: AgentThinkingLevel; error?: string } {
	if (value === undefined) return {}
	if (typeof value !== "string" || !(THINKING_LEVELS as readonly string[]).includes(value)) {
		return { error: `thinking must be one of: ${THINKING_LEVELS.join(", ")}` }
	}
	return { value: value as AgentThinkingLevel }
}

function parseTools(value: unknown, knownTools: readonly string[]): { value?: string[]; error?: string } {
	if (value === undefined) return {}
	const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined
	if (!raw || raw.some(tool => typeof tool !== "string" || !tool.trim())) {
		return { error: "tools must be a comma-separated string or a list of nonempty strings" }
	}
	const tools = raw.map(tool => (tool as string).trim())
	const duplicate = tools.find((tool, index) => tools.indexOf(tool) !== index)
	if (duplicate) return { error: `duplicate tool "${duplicate}"` }
	// This tool is registered only inside managed children, not in the parent's roster.
	const unknown = tools.filter(tool => tool !== "task_update" && !knownTools.includes(tool))
	if (unknown.length > 0) return { error: `unknown tools: ${unknown.sort(compareText).join(", ")}` }
	return { value: tools }
}

function invalidateDuplicates(candidates: DefinitionCandidate[]): void {
	const byName = new Map<string, DefinitionCandidate[]>()
	for (const candidate of candidates) {
		if (!candidate.declaredName) continue
		const group = byName.get(candidate.declaredName) ?? []
		group.push(candidate)
		byName.set(candidate.declaredName, group)
	}
	for (const [name, group] of byName) {
		if (group.length < 2) continue
		const paths = group
			.map(candidate => candidate.displayPath)
			.sort(compareText)
			.join(", ")
		for (const candidate of group) {
			delete candidate.definition
			candidate.diagnostics.push(
				makeDiagnostic(candidate, "duplicate-name", `Duplicate name "${name}" in ${candidate.source} scope: ${paths}`, name)
			)
		}
	}
}

function diagnosticCandidate(
	filePath: string,
	source: DefinitionSource,
	code: string,
	message: string,
	cwd: string,
	homeDir: string
): DefinitionCandidate {
	const candidate: DefinitionCandidate = {
		diagnostics: [],
		filePath,
		displayPath: formatDisplayPath(filePath, source, cwd, homeDir),
		source
	}
	candidate.diagnostics.push(makeDiagnostic(candidate, code, message))
	return candidate
}

function makeDiagnostic(candidate: DefinitionCandidate, code: string, message: string, name?: string): DefinitionDiagnostic {
	return {
		type: "error",
		code,
		message,
		source: candidate.source,
		path: candidate.displayPath,
		...(name ? { name } : {})
	}
}

function formatDisplayPath(filePath: string, source: DefinitionSource, cwd: string, homeDir: string): string {
	const absolute = resolve(filePath)
	if (source === "user" && isWithin(homeDir, absolute)) return join("~", relative(homeDir, absolute))
	const workspaceRelative = relative(cwd, absolute)
	return workspaceRelative && !isAbsolute(workspaceRelative) ? workspaceRelative : basename(absolute)
}

function isWithin(parent: string, child: string): boolean {
	const path = relative(parent, child)
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function compareDiagnostics(left: DefinitionDiagnostic, right: DefinitionDiagnostic): number {
	return compareText(left.path, right.path) || compareText(left.code, right.code) || compareText(left.message, right.message)
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}
