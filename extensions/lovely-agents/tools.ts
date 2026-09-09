import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import type { AgentsConfig, AgentsConfigWarning, ModelAliasChoice, ModelChoice } from "./config.js"
import { MODEL_ALIASES, resolveConfiguredModels } from "./config.js"
import { getAgentCoordinator, getBashCoordinator } from "./coordinator.js"
import { type AgentDefinition, discoverAgentDefinitions } from "./definitions.js"
import { renderExpandableResult } from "./rendering.js"
import {
	type AgentTaskMetadata,
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
	taskSchedulingStatus,
	taskStoragePaths
} from "./state.js"
import { readTaskDiscardMarker } from "./storage.js"

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
	aliases: Array<{ name: ModelAliasChoice["name"]; model: string; thinking: ModelAliasChoice["thinkingLevel"]; description: string }>
	depth: { current: number; maximum: number }
	capacity: { active: number; limit: number }
	bashCapacity: { active: number; limit: number }
}

export type DescendantSummary = {
	total: number
	states: Record<TaskMetadata["state"], number>
	outcomes: Record<NonNullable<TaskMetadata["latestOutcome"]>, number>
	activeLabels: string[]
}

export type TaskListRow = {
	id: string
	kind: TaskMetadata["kind"]
	label: string
	/** Human-only bounded run input; omitted from ordinary tool loads. */
	inputPreview?: string
	definition?: string
	state: TaskMetadata["state"]
	latestOutcome: TaskMetadata["latestOutcome"]
	model?: string
	thinking?: AgentTaskMetadata["thinking"]
	command?: string
	cwd?: string
	exitCode?: number | null
	signal?: string | null
	createdAt: number
	updatedAt: number
	acceptedAt: number | null
	startedAt: number | null
	detachedAt: number | null
	queuedFollowUps: number
	outputLines: number | null
	lastActivity: NonNullable<TaskMetadata["lastActivity"]> | null
	queueReason: ReturnType<typeof taskSchedulingStatus>["queueReason"]
	capacity?: ReturnType<typeof taskSchedulingStatus>["capacity"]
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
	capacity: ReturnType<typeof taskSchedulingStatus>["capacity"]
	bashCapacity: ReturnType<typeof taskSchedulingStatus>["capacity"]
}

export type TaskOutputResult = Awaited<ReturnType<typeof readRetainedOutput>> & {
	id: string
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
		description:
			"List available Lovely Agent definitions, configured models and aliases, diagnostics, delegation depth, and process-wide held/max execution permits.",
		promptSnippet: "List available Lovely Agent definitions, model choices, and aliases",
		promptGuidelines: [
			"Call agent_roster before delegating work and after editing Agent Definition files.",
			"Choose any model ID or alias listed by agent_roster. Alias descriptions are guidance, not routing rules; explicit thinking overrides the preset."
		],
		parameters: Type.Object({}),
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_roster")), 0, 0)
		},
		renderResult(result, { expanded }, theme) {
			return renderExpandableResult(result, expanded, theme)
		},
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
				aliases: resolvedModels.aliases,
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
	aliases?: readonly ModelAliasChoice[]
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
		aliases: (options.aliases ?? []).map(alias => ({
			name: alias.name,
			model: `${alias.model.provider}/${alias.model.id}`,
			thinking: alias.thinkingLevel,
			description: MODEL_ALIASES[alias.name]
		})),
		depth: { current: options.currentDepth, maximum: options.maximumDepth },
		capacity: { active: getAgentCoordinator().activeCount, limit: getAgentCoordinator().maxConcurrency },
		bashCapacity: { active: getBashCoordinator().activeCount, limit: getBashCoordinator().maxConcurrency }
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

	if (result.aliases.length > 0) {
		lines.push("aliases:")
		for (const alias of result.aliases) {
			lines.push(`  - name: ${alias.name}`)
			lines.push(`    model: ${yamlScalar(`${alias.model}:${alias.thinking}`)}`)
			lines.push(`    description: ${yamlScalar(alias.description)}`)
		}
	}
	lines.push(result.models.length === 0 ? "models: []" : "models:")
	for (const model of result.models) {
		lines.push(`  - ${yamlScalar(model.id)}`)
	}
	lines.push(`depth: ${result.depth.current}/${result.depth.maximum}`)
	lines.push(
		`capacity: ${result.capacity.active}/${result.capacity.limit} agent, ${result.bashCapacity.active}/${result.bashCapacity.limit} Bash (process-wide held/max permits; task_list shows only this parent's tasks)`
	)

	return { content: [{ type: "text", text: lines.join("\n") }], details: result }
}

export function registerTaskTools(
	pi: ExtensionAPI,
	options: { beforeParentLeaseRelease?: (cwd: string, parentSessionId: string) => void | Promise<void> } = {}
): void {
	pi.registerTool({
		name: "task_list",
		label: "Task List",
		description:
			"List durable Agent and Background Bash tasks owned by this exact Pi session, with queue reasons, capacity, and last activity.",
		promptSnippet: "List durable tasks owned by this session",
		promptGuidelines: ["Use task_list to inspect existing work before starting duplicate agents."],
		parameters: Type.Object({}, { additionalProperties: false }),
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("task_list")), 0, 0)
		},
		renderResult(result, { expanded }, theme) {
			return renderExpandableResult(result, expanded, theme)
		},
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return loadTaskList(ctx.cwd, ctx.sessionManager.getSessionId())
		}
	})

	pi.registerTool({
		name: "task_output",
		label: "Task Output",
		description:
			"Read a task's current reply or select a 1-based run, including completed and discarded tasks. Bash lines selects the last N output lines. Snapshots are capped at 2,000 lines/50 KiB; full agent replies are in history.md and full Bash output in output.log.",
		promptSnippet: "Read a task's latest reply, progress, and current run status",
		promptGuidelines: [
			"task_output returns one run's snapshot, not history. With waitMs, wait for the selected/current run to end or suspend, or for the timeout; later Follow-ups do not replace its result. Omit waitMs for an immediate snapshot. Prefer completion notices while doing other work, or one meaningful bounded wait when blocked on a result—not repeated short polling."
		],
		parameters: Type.Object(
			{
				id: Type.String({ pattern: TASK_REFERENCE_PATTERN.source, description: "Task Reference" }),
				run: Type.Optional(Type.Integer({ minimum: 1, description: "1-based run index; omit for the current run" })),
				lines: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 2_000, description: "Bash only: last N output lines (status and log path are kept)" })
				),
				waitMs: Type.Optional(
					Type.Integer({ minimum: 0, maximum: 600_000, description: "Maximum wait for the current run to end or suspend" })
				)
			},
			{ additionalProperties: false }
		),
		renderCall(args, theme) {
			const range = [args.run ? `run=${args.run}` : "", args.lines ? `lines=${args.lines}` : "", args.waitMs ? `wait=${args.waitMs}ms` : ""]
				.filter(Boolean)
				.join(" ")
			return new Text(
				`${theme.fg("toolTitle", theme.bold("task_output"))}${args.id ? ` ${theme.fg("muted", args.id)}` : ""}${range ? ` ${theme.fg("dim", range)}` : ""}`,
				0,
				0
			)
		},
		renderResult(result, { expanded }, theme) {
			return renderExpandableResult(result, expanded, theme)
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId()
			const lease = await acquireParentLease(ctx.cwd, parentSessionId)
			const paths = taskStoragePaths(lease.paths, params.id)
			const loaded = await readTaskMetadata(paths)
			if (loaded.status === "missing") throw new Error(`Unknown Task Reference: ${params.id}`)
			if (loaded.status === "invalid") {
				throw new Error(`${loaded.diagnostic.message}: ${displayWorkspacePath(ctx.cwd, loaded.diagnostic.path)}`)
			}
			const readOutput = () =>
				readRetainedOutput(paths, {
					...(params.run !== undefined ? { run: params.run } : {}),
					...(params.lines !== undefined ? { lines: params.lines } : {}),
					...(params.waitMs !== undefined ? { waitMs: params.waitMs } : {}),
					...(signal ? { signal } : {})
				})
			const shouldLend = (params.waitMs ?? 0) > 0 && (loaded.metadata.state === "queued" || loaded.metadata.state === "running")
			const output = shouldLend ? await getAgentCoordinator().withLentPermit(readOutput, signal) : await readOutput()
			return buildTaskOutputToolResult(params.id, output)
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

export async function loadTaskList(
	cwd: string,
	parentSessionId: string,
	options: { includeInputPreviews?: boolean } = {}
): Promise<ReturnType<typeof buildTaskListToolResult>> {
	await acquireParentLease(cwd, parentSessionId)
	return buildTaskListToolResult(await scanDirectTasks(cwd, parentSessionId, options.includeInputPreviews ?? false))
}

export function buildTaskListToolResult(options: { rows: readonly TaskListRow[]; diagnostics: readonly TaskDiagnostic[] }): {
	content: [{ type: "text"; text: string }]
	details: TaskListResult
} {
	const tasks = [...options.rows].sort(compareTaskRows)
	const coordinator = getAgentCoordinator()
	const bashCoordinator = getBashCoordinator()
	const result: TaskListResult = {
		tasks,
		diagnostics: [...options.diagnostics],
		total: tasks.length,
		capacity: { active: coordinator.activeCount, limit: coordinator.maxConcurrency },
		bashCapacity: { active: bashCoordinator.activeCount, limit: bashCoordinator.maxConcurrency }
	}
	return { content: [{ type: "text", text: renderTaskListResult(result) }], details: result }
}

export function buildTaskOutputToolResult(
	id: string,
	output: Awaited<ReturnType<typeof readRetainedOutput>>
): {
	content: [{ type: "text"; text: string }]
	details: TaskOutputResult
} {
	const result: TaskOutputResult = { id, ...output }
	const lines = [
		`task_output run=${result.run ?? "unknown"} state=${result.state} outcome=${result.latestOutcome ?? "none"} streaming=${result.streaming} queued=${result.queuedFollowUps}`,
		`capacity=${result.capacity.active}/${result.capacity.limit} execution permits${result.queueReason ? ` waiting=${result.queueReason}` : ""}`,
		...(result.exitCode !== undefined ? [`exit_code=${result.exitCode ?? "unknown"} signal=${result.signal ?? "none"}`] : []),
		...(result.lastActivity ? [`last_activity: ${result.lastActivity.action} (${relativeTime(result.lastActivity.at, Date.now())})`] : []),
		...(result.timedOut ? ["timed_out=true"] : []),
		"",
		result.text || "(no reply yet)"
	]
	return { content: [{ type: "text", text: lines.join("\n") }], details: result }
}

async function scanDirectTasks(
	cwd: string,
	parentSessionId: string,
	includeInputPreviews: boolean
): Promise<{ rows: TaskListRow[]; diagnostics: TaskDiagnostic[] }> {
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
			try {
				if (await readTaskDiscardMarker(paths)) continue
			} catch (error) {
				diagnostics.push({
					code: "invalid-discard-marker",
					message: errorMessage(error),
					path: displayWorkspacePath(cwd, paths.taskDirectory),
					id: entry.name
				})
				continue
			}
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
				path: displayWorkspacePath(cwd, paths.metadata),
				id: entry.name
			})
		}
		rows.push(await taskListRow(cwd, paths, loaded.metadata, outputLines, includeInputPreviews))
	}
	return { rows, diagnostics }
}

async function taskListRow(
	cwd: string,
	paths: TaskStoragePaths,
	metadata: TaskMetadata,
	outputLines: number | null,
	includeInputPreviews: boolean
): Promise<TaskListRow> {
	const descendants = emptyDescendantAccumulator()
	if (metadata.kind === "agent") await collectDescendants(cwd, metadata.childSessionId, new Set([metadata.parentSessionId]), descendants)
	const activeRun = metadata.activeRun
	return {
		id: metadata.taskRef,
		kind: metadata.kind,
		label: metadata.label,
		...(includeInputPreviews && metadata.inputPreview ? { inputPreview: metadata.inputPreview } : {}),
		...(metadata.kind === "agent"
			? { definition: metadata.definitionName, model: `${metadata.model.provider}/${metadata.model.id}`, thinking: metadata.thinking }
			: { command: metadata.command, cwd: metadata.cwd, exitCode: metadata.exitCode, signal: metadata.signal }),
		state: metadata.state,
		latestOutcome: metadata.latestOutcome,
		createdAt: metadata.createdAt,
		updatedAt: metadata.updatedAt,
		acceptedAt: activeRun?.acceptedAt ?? null,
		startedAt: activeRun?.startedAt ?? null,
		detachedAt: activeRun?.detachedAt ?? null,
		queuedFollowUps: metadata.queuedFollowUps.length,
		outputLines,
		lastActivity: metadata.lastActivity ?? null,
		...taskSchedulingStatus(metadata),
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
		if (loaded.metadata.kind === "agent") await collectDescendants(cwd, loaded.metadata.childSessionId, visited, summary)
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
	const lines = [
		`capacity: ${result.capacity.active}/${result.capacity.limit} execution permits`,
		`bash_capacity: ${result.bashCapacity.active}/${result.bashCapacity.limit} execution permits`,
		result.tasks.length === 0 ? "tasks: []" : "tasks:"
	]
	const now = Date.now()
	for (const state of Object.keys(TASK_STATE_ORDER) as TaskMetadata["state"][]) {
		const tasks = result.tasks.filter(task => task.state === state)
		if (tasks.length === 0) continue
		lines.push(`  ${state}:`)
		for (const task of tasks) {
			lines.push(`    - ${task.kind}${task.definition ? ` ${task.definition}` : ""} ${task.id}: ${yamlScalar(task.label)}`)
			if (state === "idle" || state === "interrupted") lines.push(`      outcome: ${task.latestOutcome ?? "none"}`)
			if (task.kind === "agent") lines.push(`      model: ${yamlScalar(`${task.model}:${task.thinking}`)}`)
			else {
				lines.push(`      command: ${yamlScalar(task.command ?? "")}`)
				lines.push(`      exit_code: ${task.exitCode ?? "unknown"} signal: ${task.signal ?? "none"}`)
				lines.push(`      output: ${yamlScalar(task.paths.output ?? "")}`)
			}
			lines.push(`      queued_followups: ${task.queuedFollowUps}`)
			lines.push(`      output_lines: ${task.outputLines ?? "unknown"}`)
			if (task.queueReason) lines.push(`      waiting: ${task.queueReason}`)
			if (task.lastActivity) lines.push(`      last_activity: ${task.lastActivity.action} (${relativeTime(task.lastActivity.at, now)})`)
			if (task.descendants.total > 0) lines.push(`      descendants: ${renderDescendantSummary(task.descendants)}`)
			lines.push(`      created: ${relativeTime(task.createdAt, now)}`)
			lines.push(`      updated: ${relativeTime(task.updatedAt, now)}`)
			lines.push(`      dir: ${yamlScalar(dirname(task.paths.history))}`)
		}
	}
	if (result.diagnostics.length > 0) {
		lines.push("diagnostics:")
		for (const diagnostic of result.diagnostics) {
			lines.push(`  - ${diagnostic.code}${diagnostic.id ? ` ${diagnostic.id}` : ""}: ${yamlScalar(diagnostic.message)}`)
			lines.push(`    path: ${yamlScalar(diagnostic.path)}`)
		}
	}
	return lines.join("\n")
}

export function relativeTime(timestamp: number, now: number): string {
	let seconds = Math.floor(Math.max(0, now - timestamp) / 1_000)
	if (seconds === 0) return "now"
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	seconds %= 60
	if (minutes < 60) return `${minutes}m${seconds ? `${seconds}s` : ""} ago`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	if (hours < 24) return `${hours}h${remainingMinutes ? `${remainingMinutes}m` : ""} ago`
	const days = Math.floor(hours / 24)
	const remainingHours = hours % 24
	return `${days}d${remainingHours ? `${remainingHours}h` : ""} ago`
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
