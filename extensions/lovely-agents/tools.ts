import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { AgentsConfig, AgentsConfigWarning, ModelChoice } from "./config.js"
import { resolveConfiguredModels } from "./config.js"
import { getAgentCoordinator } from "./coordinator.js"
import { type AgentDefinition, discoverAgentDefinitions } from "./definitions.js"
import {
	acquireParentLease,
	countRetainedOutputLines,
	displayWorkspacePath,
	type MetadataDiagnostic,
	parentStoragePaths,
	type RetainedPaths,
	readRetainedOutput,
	readTaskMetadata,
	releaseParentLeaseFor,
	retainedPaths,
	TASK_REFERENCE_PATTERN,
	type TaskMetadata,
	type TaskStoragePaths,
	taskStoragePaths
} from "./state.js"

const TASK_STATE_ORDER: Record<TaskMetadata["state"], number> = {
	running: 0,
	suspended: 1,
	queued: 2,
	interrupted: 3,
	idle: 4
}

export type RosterDefinition = {
	name: string
	description: string
	source: "user" | "project"
	path: string
	model?: string
	thinking?: string
	tools?: string[]
	exclude_agents_md?: boolean
}

export type RosterDiagnostic = {
	type: "error" | "warning"
	code: string
	message: string
	path?: string
	name?: string
	pattern?: string
	source?: string
}

export type RosterModel = {
	id: string
}

export type AgentRosterResult = {
	definitions: RosterDefinition[]
	diagnostics: RosterDiagnostic[]
	models: RosterModel[]
	depth: { current: number; maximum: number }
}

export type DescendantSummary = {
	total: number
	states: Record<TaskMetadata["state"], number>
	outcomes: Record<NonNullable<TaskMetadata["latestOutcome"]>, number>
	activeLabels: string[]
}

export type TaskListRow = {
	id: string
	kind: "agent"
	label: string
	definition: string
	state: TaskMetadata["state"]
	latestOutcome: TaskMetadata["latestOutcome"]
	model: string
	thinking: TaskMetadata["thinking"]
	createdAt: number
	updatedAt: number
	acceptedAt: number | null
	startedAt: number | null
	detachedAt: number | null
	queuedFollowUps: number
	outputLines: number | null
	paths: RetainedPaths
	descendants: DescendantSummary
}

export type TaskDiagnostic = {
	code: string
	message: string
	path: string
	id?: string
}

export type TaskListResult = {
	tasks: TaskListRow[]
	diagnostics: TaskDiagnostic[]
	total: number
}

export type TaskOutputResult = Awaited<ReturnType<typeof readRetainedOutput>> & {
	id: string
	queuedFollowUps: number
}

export function registerRosterTool(
	pi: ExtensionAPI,
	options: {
		getConfig: () => AgentsConfig
		getConfigWarnings: () => readonly AgentsConfigWarning[]
		getDepth?: () => number
		getAgentDir?: () => string
	}
): void {
	pi.registerTool({
		name: "agent_roster",
		label: "Agent Roster",
		description: "List available Lovely Agent definitions, configured model choices, validation diagnostics, and delegation depth.",
		promptSnippet: "List available Lovely Agent definitions and model choices",
		promptGuidelines: ["Call agent_roster before delegating work and after editing Agent Definition files."],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const config = options.getConfig()
			const resolvedModels = await resolveConfiguredModels(config, ctx)
			const discovered = discoverAgentDefinitions({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				toolNames: pi.getAllTools().map(tool => tool.name),
				models: ctx.modelRegistry.getAll(),
				...(options.getAgentDir ? { agentDir: options.getAgentDir() } : {})
			})
			return buildRosterToolResult({
				definitions: discovered.definitions,
				diagnostics: [
					...discovered.diagnostics,
					...options.getConfigWarnings().map(warning => ({
						type: "warning" as const,
						code: warning.key ? "invalid-config-value" : "invalid-config-file",
						message: warning.message,
						path: warning.path,
						source: warning.scope,
						...(warning.key ? { name: warning.key } : {})
					})),
					...resolvedModels.diagnostics.map(diagnostic => ({
						...diagnostic,
						source: "models"
					}))
				],
				models: resolvedModels.models,
				currentDepth: options.getDepth?.() ?? 0,
				maximumDepth: config.maxDepth
			})
		}
	})
}

export function buildRosterToolResult(options: {
	definitions: readonly AgentDefinition[]
	diagnostics: readonly RosterDiagnostic[]
	models: readonly ModelChoice[]
	currentDepth: number
	maximumDepth: number
}): {
	content: [{ type: "text"; text: string }]
	details: AgentRosterResult
} {
	const result: AgentRosterResult = {
		definitions: options.definitions.map(definition => ({
			name: definition.name,
			description: definition.description,
			source: definition.source,
			path: definition.displayPath,
			...(definition.model ? { model: definition.model } : {}),
			...(definition.thinking ? { thinking: definition.thinking } : {}),
			...(definition.tools ? { tools: definition.tools } : {}),
			...(definition.excludeAgentsMd !== undefined ? { exclude_agents_md: definition.excludeAgentsMd } : {})
		})),
		diagnostics: [...options.diagnostics],
		models: options.models.map(choice => ({
			id: `${choice.model.provider}/${choice.model.id}`
		})),
		depth: { current: options.currentDepth, maximum: options.maximumDepth }
	}
	const lines: string[] = []
	if (result.definitions.length === 0) {
		lines.push("definitions: []")
	} else {
		lines.push("definitions:")
		for (const definition of result.definitions) {
			lines.push(`  - name: ${yamlScalar(definition.name)}`)
			lines.push(`    description: ${yamlScalar(definition.description)}`)
			lines.push(`    path: ${yamlScalar(definition.path)}`)
			if (definition.model) lines.push(`    model: ${yamlScalar(definition.model)}`)
			if (definition.thinking) lines.push(`    thinking: ${definition.thinking}`)
			if (definition.tools) lines.push(`    tools: [${definition.tools.map(yamlScalar).join(", ")}]`)
			if (definition.exclude_agents_md) lines.push("    exclude_agents_md: true")
		}
	}

	if (result.diagnostics.length > 0) {
		lines.push("diagnostics:")
		for (const diagnostic of result.diagnostics) {
			lines.push(`  - type: ${diagnostic.type}`)
			lines.push(`    code: ${yamlScalar(diagnostic.code)}`)
			lines.push(`    message: ${yamlScalar(diagnostic.message)}`)
			if (diagnostic.source) lines.push(`    source: ${yamlScalar(diagnostic.source)}`)
			if (diagnostic.path) lines.push(`    path: ${yamlScalar(diagnostic.path)}`)
			if (diagnostic.name) lines.push(`    name: ${yamlScalar(diagnostic.name)}`)
			if (diagnostic.pattern) lines.push(`    pattern: ${yamlScalar(diagnostic.pattern)}`)
		}
	}

	lines.push(result.models.length === 0 ? "models: []" : "models:")
	for (const model of result.models) {
		lines.push(`  - ${yamlScalar(model.id)}`)
	}
	lines.push(`depth: ${result.depth.current}/${result.depth.maximum}`)

	return { content: [{ type: "text", text: lines.join("\n") }], details: result }
}

export function registerTaskTools(
	pi: ExtensionAPI,
	options: { beforeParentLeaseRelease?: (cwd: string, parentSessionId: string) => void | Promise<void> } = {}
): void {
	pi.registerTool({
		name: "task_list",
		label: "Task List",
		description: "List durable Lovely Agent tasks owned by this exact Pi session.",
		promptSnippet: "List durable tasks owned by this session",
		promptGuidelines: ["Use task_list to inspect existing work before starting duplicate agents."],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return loadTaskList(ctx.cwd, ctx.sessionManager.getSessionId())
		}
	})

	pi.registerTool({
		name: "task_output",
		label: "Task Output",
		description: "Read retained output from a Lovely Agent task, optionally waiting for live changes.",
		promptSnippet: "Read retained output from a durable task",
		promptGuidelines: ["Use task_output with nextOffset to follow detached work without rereading prior output."],
		parameters: Type.Object(
			{
				id: Type.String({ pattern: TASK_REFERENCE_PATTERN.source, description: "Task Reference" }),
				offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed output line" })),
				limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum output lines" })),
				waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600_000, description: "Maximum wait for output or state changes" }))
			},
			{ additionalProperties: false }
		),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId()
			const lease = await acquireParentLease(ctx.cwd, parentSessionId)
			const paths = taskStoragePaths(lease.paths, params.id)
			const loaded = await readTaskMetadata(paths)
			if (loaded.status === "missing") throw new Error(`Unknown Task Reference: ${params.id}`)
			if (loaded.status === "invalid") {
				throw new Error(`${loaded.diagnostic.message}: ${displayWorkspacePath(ctx.cwd, loaded.diagnostic.path)}`)
			}
			if (loaded.metadata.discardedAt !== null) throw new Error(`Task ${params.id} has been discarded`)

			const readOutput = () =>
				readRetainedOutput(paths, {
					...(params.offset !== undefined ? { offset: params.offset } : {}),
					...(params.limit !== undefined ? { limit: params.limit } : {}),
					...(params.waitMs !== undefined ? { waitMs: params.waitMs } : {}),
					...(signal ? { signal } : {})
				})
			const shouldLend = (params.waitMs ?? 0) > 0 && isActiveState(loaded.metadata.state)
			const output = shouldLend ? await getAgentCoordinator().withLentPermit(readOutput, signal) : await readOutput()
			const refreshed = await readTaskMetadata(paths)
			return buildTaskOutputToolResult(
				params.id,
				refreshed.status === "ok" ? refreshed.metadata.queuedFollowUps.length : loaded.metadata.queuedFollowUps.length,
				output
			)
		}
	})

	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "reload") {
			const parentSessionId = ctx.sessionManager.getSessionId()
			await options.beforeParentLeaseRelease?.(ctx.cwd, parentSessionId)
			await releaseParentLeaseFor(ctx.cwd, parentSessionId)
		}
	})
}

export async function loadTaskList(cwd: string, parentSessionId: string): Promise<ReturnType<typeof buildTaskListToolResult>> {
	await acquireParentLease(cwd, parentSessionId)
	return buildTaskListToolResult(await scanDirectTasks(cwd, parentSessionId))
}

export function buildTaskListToolResult(options: { rows: readonly TaskListRow[]; diagnostics: readonly TaskDiagnostic[] }): {
	content: [{ type: "text"; text: string }]
	details: TaskListResult
} {
	const tasks = [...options.rows].sort(compareTaskRows)
	const result: TaskListResult = { tasks, diagnostics: [...options.diagnostics], total: tasks.length }
	return { content: [{ type: "text", text: renderTaskListResult(result) }], details: result }
}

export function buildTaskOutputToolResult(
	id: string,
	queuedFollowUps: number,
	output: Awaited<ReturnType<typeof readRetainedOutput>>
): {
	content: [{ type: "text"; text: string }]
	details: TaskOutputResult
} {
	const result: TaskOutputResult = { id, queuedFollowUps, ...output }
	const range = result.returnedLines > 0 ? `${result.startLine}-${result.endLine}/${result.totalLines}` : `none/${result.totalLines}`
	const lines = [
		`task: ${result.id}`,
		`state: ${result.state}; queued_followups: ${result.queuedFollowUps}; lines: ${range}`,
		`source: ${yamlScalar(result.paths.output)}`,
		...(result.timedOut ? ["timed_out: true"] : []),
		"output:",
		result.text || "(no output)"
	]
	return { content: [{ type: "text", text: lines.join("\n") }], details: result }
}

async function scanDirectTasks(cwd: string, parentSessionId: string): Promise<{ rows: TaskListRow[]; diagnostics: TaskDiagnostic[] }> {
	const parent = parentStoragePaths(cwd, parentSessionId)
	const entries = await readTaskDirectory(parent.parentDirectory)
	const rows: TaskListRow[] = []
	const diagnostics: TaskDiagnostic[] = []
	for (const entry of entries) {
		if (!TASK_REFERENCE_PATTERN.test(entry.name)) continue
		const paths = taskStoragePaths(parent, entry.name)
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			diagnostics.push({
				code: "invalid-task-directory",
				message: "Task path is not a regular directory",
				path: displayWorkspacePath(cwd, paths.taskDirectory),
				id: entry.name
			})
			continue
		}
		const loaded = await readTaskMetadata(paths)
		if (loaded.status === "missing") {
			diagnostics.push({
				code: "missing-metadata",
				message: "Task metadata is missing",
				path: displayWorkspacePath(cwd, paths.metadata),
				id: entry.name
			})
			continue
		}
		if (loaded.status === "invalid") {
			diagnostics.push(metadataTaskDiagnostic(cwd, loaded.diagnostic, entry.name))
			continue
		}
		if (loaded.metadata.discardedAt !== null) continue

		let outputLines: number | null = null
		try {
			outputLines = await countRetainedOutputLines(paths)
		} catch (error) {
			diagnostics.push({
				code: "unreadable-output",
				message: errorMessage(error),
				path: displayWorkspacePath(cwd, paths.output),
				id: entry.name
			})
		}
		rows.push(await taskListRow(cwd, paths, loaded.metadata, outputLines))
	}
	return { rows, diagnostics }
}

async function taskListRow(cwd: string, paths: TaskStoragePaths, metadata: TaskMetadata, outputLines: number | null): Promise<TaskListRow> {
	const descendants = emptyDescendantAccumulator()
	await collectDescendants(cwd, metadata.childSessionId, new Set([metadata.parentSessionId]), descendants)
	const activeRun = metadata.activeRun
	return {
		id: metadata.taskRef,
		kind: "agent",
		label: metadata.label,
		definition: metadata.definitionName,
		state: metadata.state,
		latestOutcome: metadata.latestOutcome,
		model: `${metadata.model.provider}/${metadata.model.id}`,
		thinking: metadata.thinking,
		createdAt: metadata.createdAt,
		updatedAt: metadata.updatedAt,
		acceptedAt: activeRun?.acceptedAt ?? null,
		startedAt: activeRun?.startedAt ?? null,
		detachedAt: activeRun?.detachedAt ?? null,
		queuedFollowUps: metadata.queuedFollowUps.length,
		outputLines,
		paths: retainedPaths(paths),
		descendants: {
			total: descendants.total,
			states: descendants.states,
			outcomes: descendants.outcomes,
			activeLabels: descendants.active
				.sort(
					(left, right) =>
						TASK_STATE_ORDER[left.state] - TASK_STATE_ORDER[right.state] ||
						right.updatedAt - left.updatedAt ||
						left.label.localeCompare(right.label)
				)
				.slice(0, 3)
				.map(item => item.label)
		}
	}
}

type DescendantAccumulator = Omit<DescendantSummary, "activeLabels"> & {
	active: Array<{ label: string; state: TaskMetadata["state"]; updatedAt: number }>
}

async function collectDescendants(
	cwd: string,
	parentSessionId: string,
	visited: Set<string>,
	summary: DescendantAccumulator
): Promise<void> {
	if (visited.has(parentSessionId)) return
	visited.add(parentSessionId)
	const parent = parentStoragePaths(cwd, parentSessionId)
	for (const entry of await readTaskDirectory(parent.parentDirectory)) {
		if (!entry.isDirectory() || entry.isSymbolicLink() || !TASK_REFERENCE_PATTERN.test(entry.name)) continue
		const loaded = await readTaskMetadata(taskStoragePaths(parent, entry.name))
		if (loaded.status !== "ok" || loaded.metadata.discardedAt !== null) continue
		summary.total++
		summary.states[loaded.metadata.state]++
		if (loaded.metadata.latestOutcome) summary.outcomes[loaded.metadata.latestOutcome]++
		if (isActiveState(loaded.metadata.state)) {
			summary.active.push({ label: loaded.metadata.label, state: loaded.metadata.state, updatedAt: loaded.metadata.updatedAt })
		}
		await collectDescendants(cwd, loaded.metadata.childSessionId, visited, summary)
	}
}

function emptyDescendantAccumulator(): DescendantAccumulator {
	return {
		total: 0,
		states: { idle: 0, queued: 0, running: 0, suspended: 0, interrupted: 0 },
		outcomes: { succeeded: 0, failed: 0, stopped: 0, interrupted: 0 },
		active: []
	}
}

async function readTaskDirectory(path: string): Promise<Dirent[]> {
	try {
		return (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
	} catch (error) {
		if (hasCode(error, "ENOENT")) return []
		throw error
	}
}

function metadataTaskDiagnostic(cwd: string, diagnostic: MetadataDiagnostic, id: string): TaskDiagnostic {
	return { code: diagnostic.code, message: diagnostic.message, path: displayWorkspacePath(cwd, diagnostic.path), id }
}

function compareTaskRows(left: TaskListRow, right: TaskListRow): number {
	return TASK_STATE_ORDER[left.state] - TASK_STATE_ORDER[right.state] || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
}

function renderTaskListResult(result: TaskListResult): string {
	const lines = result.tasks.length === 0 ? ["tasks: []"] : ["tasks:"]
	for (const task of result.tasks) {
		lines.push(`  - id: ${task.id}`)
		lines.push(`    kind: ${task.kind}`)
		lines.push(`    label: ${yamlScalar(task.label)}`)
		lines.push(`    definition: ${task.definition}`)
		lines.push(`    state: ${task.state}`)
		lines.push(`    outcome: ${task.latestOutcome ?? "none"}`)
		lines.push(`    model: ${yamlScalar(task.model)}`)
		lines.push(`    thinking: ${task.thinking}`)
		lines.push(`    created_at: ${task.createdAt}`)
		lines.push(`    updated_at: ${task.updatedAt}`)
		if (task.acceptedAt !== null) lines.push(`    accepted_at: ${task.acceptedAt}`)
		if (task.startedAt !== null) lines.push(`    started_at: ${task.startedAt}`)
		if (task.detachedAt !== null) lines.push(`    detached_at: ${task.detachedAt}`)
		lines.push(`    queued_followups: ${task.queuedFollowUps}`)
		lines.push(`    output_lines: ${task.outputLines ?? "unknown"}`)
		lines.push(`    descendants: ${renderDescendantSummary(task.descendants)}`)
		lines.push(`    task_dir: ${yamlScalar(dirname(task.paths.output))}`)
	}
	if (result.diagnostics.length > 0) {
		lines.push("diagnostics:")
		for (const diagnostic of result.diagnostics) {
			lines.push(`  - code: ${diagnostic.code}`)
			lines.push(`    message: ${yamlScalar(diagnostic.message)}`)
			lines.push(`    path: ${yamlScalar(diagnostic.path)}`)
			if (diagnostic.id) lines.push(`    id: ${diagnostic.id}`)
		}
	}
	lines.push(`total: ${result.total}`)
	return lines.join("\n")
}

function renderDescendantSummary(summary: DescendantSummary): string {
	const counts = [
		...Object.entries(summary.states)
			.filter(([, count]) => count > 0)
			.map(([name, count]) => `state.${name}=${count}`),
		...Object.entries(summary.outcomes)
			.filter(([, count]) => count > 0)
			.map(([name, count]) => `outcome.${name}=${count}`)
	]
	const active = summary.activeLabels.length > 0 ? `, active=[${summary.activeLabels.map(yamlScalar).join(", ")}]` : ""
	return `{total=${summary.total}${counts.length > 0 ? `, ${counts.join(", ")}` : ""}${active}}`
}

function isActiveState(state: TaskMetadata["state"]): boolean {
	return state === "running" || state === "suspended" || state === "queued"
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function yamlScalar(value: string): string {
	return /^[A-Za-z0-9_@+./:-]+$/.test(value) && !/^(?:null|true|false|yes|no|on|off|[-+]?(?:\d+\.?\d*|\.\d+))$/i.test(value)
		? value
		: JSON.stringify(value)
}
