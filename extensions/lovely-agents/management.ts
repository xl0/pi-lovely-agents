import { randomBytes } from "node:crypto"
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Container, Key, matchesKey, type SelectItem, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui"
import type { AgentDefinition, DefinitionDiagnostic, DefinitionDiscoveryResult } from "./definitions.js"
import {
	acquireParentLease,
	appendHistoryLog,
	ensureParentStorage,
	initializeRetainedLogs,
	mutateTaskMetadata,
	parentStoragePaths,
	readRetainedOutput,
	readTaskMetadata,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	TASK_REFERENCE_PATTERN,
	type TaskMetadata,
	type TaskStoragePaths,
	taskStoragePaths,
	writeTaskMetadata
} from "./state.js"
import { relativeTime, type TaskListResult, type TaskListRow } from "./tools.js"
import { bindTaskUpdateRoute } from "./updates.js"

const FIXTURE_MARKER = ".fixture"
const FIXTURE_DEFINITION = "lovely-fixture"
const FIXTURE_LIVE_INTERVAL_MS = 500
const FIXTURE_TIMERS = Symbol.for("@xl0/pi-lovely-agents/fixture-timers")
type FixtureTimer = ReturnType<typeof setInterval>
type FixtureLiveTask = { timer?: FixtureTimer; pending?: Promise<void> }
type FixtureTimerRegistry = Map<string, Set<FixtureLiveTask>>

export type ManagementUiOptions = {
	discoverDefinitions: () => DefinitionDiscoveryResult
	loadTasks: () => Promise<TaskListResult>
	focusTasks: () => Promise<void>
	openConfig: () => Promise<void>
	/** False means the foreground input was cancelled and must not be reported accepted. */
	inputTask: (id: string, content: string, delivery: "followup" | "steer") => Promise<undefined | false>
	controlTask: (id: string, action: "stop" | "discard") => Promise<void>
}

export async function openManagementUi(ctx: ExtensionContext, options: ManagementUiOptions): Promise<void> {
	while (true) {
		const definitions = options.discoverDefinitions()
		const tasks = await options.loadTasks()
		const choice = await select(ctx, "Lovely Agents", [
			{
				value: "definitions",
				label: `Agent definitions (${definitions.definitions.length})`,
				description: `${definitions.diagnostics.length} diagnostics`
			},
			{ value: "tasks", label: `Tasks (${tasks.total})`, description: "Inspect durable direct children" },
			{ value: "fixtures", label: "Developer fixtures", description: "Create or remove dummy tasks in this session" },
			{ value: "config", label: "Configuration", description: "Edit user and workspace settings" }
		])
		if (!choice) return

		switch (choice) {
			case "definitions":
				await showDefinitions(ctx, definitions)
				break
			case "tasks":
				await options.focusTasks()
				return
			case "fixtures":
				await showFixtureMenu(ctx)
				break
			case "config":
				await options.openConfig()
				break
		}
	}
}

export async function openTaskManagementUi(ctx: ExtensionContext, options: ManagementUiOptions, selection: string): Promise<void> {
	if (selection.startsWith("task:")) {
		await manageTask(ctx, selection.slice("task:".length), options)
	} else {
		const tasks = await options.loadTasks()
		const diagnostic = tasks.diagnostics.find(item => item.path === selection.slice("diagnostic:".length))
		if (diagnostic) await showText(ctx, diagnostic.code, `${diagnostic.message}\n\n${diagnostic.path}`)
	}
}

export async function seedFixtureTasks(cwd: string, parentSessionId: string): Promise<string[]> {
	await acquireParentLease(cwd, parentSessionId)
	const fixtures: Array<{ label: string; state: TaskMetadata["state"]; outcome: TaskMetadata["latestOutcome"] }> = [
		{ label: "Running", state: "running", outcome: null },
		{ label: "Suspended", state: "suspended", outcome: null },
		{ label: "Queued", state: "queued", outcome: null },
		{ label: "Interrupted", state: "interrupted", outcome: "interrupted" },
		{ label: "Succeeded", state: "idle", outcome: "succeeded" },
		{ label: "Failed", state: "idle", outcome: "failed" },
		{ label: "Stopped", state: "idle", outcome: "stopped" }
	]
	const ids: string[] = []
	for (const fixture of fixtures) {
		const paths = await createFixtureTask(
			cwd,
			parentSessionId,
			parentSessionId,
			`[fixture] ${fixture.label}`,
			fixture.state,
			fixture.outcome
		)
		ids.push(paths.taskRef)
	}
	return ids
}

export async function seedFixtureEdgeCases(cwd: string, parentSessionId: string): Promise<string[]> {
	await acquireParentLease(cwd, parentSessionId)
	const showcase = await createFixtureTask(
		cwd,
		parentSessionId,
		parentSessionId,
		"[fixture] Follow-up, descendants, and large UTF-8",
		"idle",
		"succeeded"
	)
	await mutateTaskMetadata(showcase, metadata => ({
		...metadata,
		lastRunSequence: 2,
		latestReply: { text: `Large UTF-8 line: ${"🦋".repeat(20_000)}`, streaming: false },
		queuedFollowUps: [
			{
				id: `r_${randomBytes(8).toString("hex")}`,
				sequence: 2,
				content: "Queued fixture Follow-up",
				acceptedAt: Date.now()
			}
		],
		updatedAt: Date.now()
	}))
	await appendHistoryLog(showcase, { type: "assistant", content: `Large UTF-8 line: ${"🦋".repeat(20_000)}` })
	const loaded = await readTaskMetadata(showcase)
	if (loaded.status !== "ok") throw new Error(`Could not read fixture ${showcase.taskRef}`)
	await createFixtureTask(cwd, loaded.metadata.childSessionId, parentSessionId, "[fixture] Nested running child", "running", null)

	const discarded = await createFixtureTask(cwd, parentSessionId, parentSessionId, "[fixture] Discarded", "idle", "stopped")
	await mutateTaskMetadata(discarded, metadata => ({ ...metadata, discardedAt: Date.now(), updatedAt: Date.now() }))

	const corrupt = await reserveTaskStorage(await ensureParentStorage(cwd, parentSessionId))
	await writeFile(join(corrupt.taskDirectory, FIXTURE_MARKER), parentSessionId, { flag: "wx", mode: 0o600 })
	await writeFile(corrupt.metadata, "{ malformed fixture metadata", { flag: "wx", mode: 0o600 })
	return [showcase.taskRef, discarded.taskRef, corrupt.taskRef]
}

export async function seedLiveFixtureTask(cwd: string, parentSessionId: string): Promise<string> {
	await acquireParentLease(cwd, parentSessionId)
	const paths = await createFixtureTask(cwd, parentSessionId, parentSessionId, "[fixture] Live output", "running", null)
	let tick = 0
	const live: FixtureLiveTask = {}
	const timer = setInterval(() => {
		if (live.pending) return
		live.pending = (async () => {
			tick++
			await appendHistoryLog(paths, { type: "assistant", content: `Fixture update ${tick}` })
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				latestReply: { text: `Fixture update ${tick}`, streaming: false },
				updatedAt: Date.now()
			}))
			if (tick < 5) return
			clearInterval(timer)
			await appendHistoryLog(paths, { type: "run-end", sequence: 1, outcome: "succeeded", timestamp: Date.now() })
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				state: "idle",
				latestOutcome: "succeeded",
				activeRun: null,
				updatedAt: Date.now()
			}))
			unregisterFixtureTimer(cwd, parentSessionId, live)
		})()
		void live.pending
			.catch(() => {
				clearInterval(timer)
				unregisterFixtureTimer(cwd, parentSessionId, live)
			})
			.finally(() => {
				delete live.pending
			})
	}, FIXTURE_LIVE_INTERVAL_MS)
	live.timer = timer
	timer.unref()
	registerFixtureTimer(cwd, parentSessionId, live)
	return paths.taskRef
}

export async function clearFixtureTasks(cwd: string, parentSessionId: string): Promise<number> {
	await acquireParentLease(cwd, parentSessionId)
	await stopFixtureTimersFor(cwd, parentSessionId)
	const parent = await ensureParentStorage(cwd, parentSessionId)
	let removed = 0
	for (const partition of await readdir(parent.root, { withFileTypes: true })) {
		if (!partition.isDirectory() || partition.isSymbolicLink()) continue
		const partitionDirectory = join(parent.root, partition.name)
		for (const entry of await readdir(partitionDirectory, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || !TASK_REFERENCE_PATTERN.test(entry.name)) continue
			const taskDirectory = join(partitionDirectory, entry.name)
			if (!(await isOwnedFixture(join(taskDirectory, FIXTURE_MARKER), parentSessionId))) continue
			await rm(taskDirectory, { recursive: true })
			removed++
		}
	}
	return removed
}

export async function stopFixtureTimersFor(cwd: string, parentSessionId: string): Promise<void> {
	const registry = fixtureTimerRegistry()
	const key = fixtureTimerKey(cwd, parentSessionId)
	const liveTasks = [...(registry.get(key) ?? [])]
	for (const live of liveTasks) {
		if (live.timer) clearInterval(live.timer)
	}
	await Promise.allSettled(liveTasks.flatMap(live => live.pending ?? []))
	registry.delete(key)
}

async function showDefinitions(ctx: ExtensionContext, discovered: DefinitionDiscoveryResult): Promise<void> {
	while (true) {
		const items: SelectItem[] = [
			...discovered.definitions.map(definition => ({
				value: `definition:${definition.name}`,
				label: definition.name,
				description: `${definition.description} · ${definition.source}`
			})),
			...discovered.diagnostics.map((diagnostic, index) => ({
				value: `diagnostic:${index}`,
				label: `[${diagnostic.type}] ${diagnostic.code}`,
				description: diagnostic.message
			}))
		]
		if (items.length === 0) {
			await showText(ctx, "Agent definitions", "No Agent Definitions or diagnostics.")
			return
		}
		const choice = await select(ctx, "Agent definitions", items)
		if (!choice) return
		if (choice.startsWith("definition:")) {
			const definition = discovered.definitions.find(item => item.name === choice.slice("definition:".length))
			if (definition) await showText(ctx, definition.name, renderDefinition(definition))
		} else {
			const diagnostic = discovered.diagnostics[Number(choice.slice("diagnostic:".length))]
			if (diagnostic) await showText(ctx, diagnostic.code, renderDiagnostic(diagnostic))
		}
	}
}

async function manageTask(ctx: ExtensionContext, id: string, options: ManagementUiOptions): Promise<void> {
	while (true) {
		const task = (await options.loadTasks()).tasks.find(candidate => candidate.id === id)
		if (!task) return
		const choice = await select(ctx, task.label, [
			{ value: "details", label: "Details", description: `${task.state}${task.latestOutcome ? `/${task.latestOutcome}` : ""}` },
			{ value: "output", label: "Live output", description: "Latest assistant reply and run status" },
			{ value: "history", label: "Inputs / history", description: "Current and queued inputs, past runs, and delivered Steers" },
			{ value: "prompt", label: "System prompt", description: "Captured Pi system prompt" },
			{ value: "followup", label: "Follow-up", description: "Run more work in this retained session" },
			{ value: "steer", label: "Steer", description: "Redirect running work; otherwise becomes a Follow-up" },
			{ value: "stop", label: "Stop", description: "Stop work and preserve the session" },
			{ value: "discard", label: "Discard", description: "Stop and archive this task and its descendants" }
		])
		if (!choice) return
		if (choice === "details") await showText(ctx, task.label, renderTask(task))
		else if (choice === "output") await showLiveTaskOutput(ctx, task)
		else if (choice === "history" || choice === "prompt") await showTaskContext(ctx, task, choice)
		else if (choice === "followup" || choice === "steer") {
			const content = await ctx.ui.editor(`${title(choice)} ${task.id}`)
			if (content?.trim()) {
				if ((await options.inputTask(task.id, content, choice)) !== false) {
					ctx.ui.notify(`${title(choice)} accepted for ${task.id}`, "info")
				}
			}
		} else if (choice === "stop") {
			if (await ctx.ui.confirm(`Stop ${task.id}?`, "The retained session remains reusable.")) {
				await options.controlTask(task.id, "stop")
			}
		} else if (await ctx.ui.confirm(`Discard ${task.id}?`, "Files move to the archive. Later model I/O is rejected.")) {
			await options.controlTask(task.id, "discard")
			return
		}
	}
}

async function showTaskContext(ctx: ExtensionContext, task: TaskListRow, view: "history" | "prompt"): Promise<void> {
	const paths = taskStoragePaths(parentStoragePaths(ctx.cwd, ctx.sessionManager.getSessionId()), task.id)
	const loaded = await readTaskMetadata(paths)
	if (loaded.status !== "ok") throw new Error(`Cannot inspect ${task.id}: invalid or missing metadata`)
	const metadata = loaded.metadata
	if (metadata.discardedAt !== null) throw new Error(`Task ${task.id} has been discarded`)
	if (view === "prompt") {
		const captured = metadata.effectiveSystemPrompt
		if (captured === undefined) {
			ctx.ui.notify("No system prompt captured for this run.", "info")
			return
		}
		await showText(ctx, `${task.id} · System prompt`, captured)
	} else {
		if (!(await isRegularFile(paths.history))) throw new Error(`Cannot inspect ${task.id}: history.md is missing or not a regular file`)
		await showText(
			ctx,
			`${task.id} · Inputs / history`,
			[
				...(metadata.activeRun ? [`Current run ${metadata.activeRun.sequence} (${metadata.state}):`, metadata.activeRun.input, ""] : []),
				...metadata.queuedFollowUps.flatMap(input => [`Queued Follow-up ${input.sequence} (not started):`, input.content, ""]),
				await readFile(paths.history, "utf8")
			].join("\n")
		)
	}
}

async function showLiveTaskOutput(ctx: ExtensionContext, task: TaskListRow): Promise<void> {
	const paths = taskStoragePaths(parentStoragePaths(ctx.cwd, ctx.sessionManager.getSessionId()), task.id)
	let output = await readRetainedOutput(paths)
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let closed = false
		let loading = false
		let refreshAgain = false
		const refresh = async () => {
			if (closed) return
			refreshAgain = true
			if (loading) return
			loading = true
			try {
				do {
					refreshAgain = false
					const latest = await readRetainedOutput(paths)
					if (closed) return
					output = latest
					tui.requestRender()
				} while (refreshAgain)
			} finally {
				loading = false
			}
		}
		const unbind = bindTaskUpdateRoute(ctx.cwd, ctx.sessionManager.getSessionId(), refresh)
		return {
			render(width: number) {
				const heading = theme.fg(
					"accent",
					theme.bold(
						`${task.id} · ${output.state}${output.latestOutcome ? `/${output.latestOutcome}` : ""}${output.streaming ? " · streaming" : ""}`
					)
				)
				const progress = [
					`Capacity: ${output.capacity.active}/${output.capacity.limit} execution permits`,
					...(output.queueReason ? [`Waiting: ${output.queueReason}`] : []),
					...(output.lastActivity ? [`${output.lastActivity.action} · ${relativeTime(output.lastActivity.at, Date.now())}`] : [])
				].join("\n")
				return new Text(
					`${heading}\n${progress}\n\n${output.text || "(no output)"}\n\n${theme.fg("dim", "Esc or Enter to go back")}`,
					1,
					0
				).render(width)
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) done(undefined)
			},
			dispose() {
				closed = true
				unbind()
			}
		}
	})
}

async function showFixtureMenu(ctx: ExtensionContext): Promise<void> {
	const choice = await select(ctx, "Developer fixtures", [
		{ value: "states", label: "Seed task states", description: "Create running, suspended, queued, interrupted, and idle tasks" },
		{
			value: "edges",
			label: "Seed edge cases",
			description: "Create queued Follow-up, descendant, discarded, corrupt, and large UTF-8 data"
		},
		{ value: "live", label: "Seed live task", description: "Append five updates, then complete automatically" },
		{ value: "clear", label: "Remove fixtures", description: "Permanently delete marked fixture task directories" }
	])
	if (!choice) return
	const parentSessionId = ctx.sessionManager.getSessionId()
	if (choice === "states") {
		const ids = await seedFixtureTasks(ctx.cwd, parentSessionId)
		ctx.ui.notify(`Created fixture tasks: ${ids.join(", ")}`, "info")
	} else if (choice === "edges") {
		const ids = await seedFixtureEdgeCases(ctx.cwd, parentSessionId)
		ctx.ui.notify(`Created fixture edge cases: ${ids.join(", ")}`, "info")
	} else if (choice === "live") {
		const id = await seedLiveFixtureTask(ctx.cwd, parentSessionId)
		ctx.ui.notify(`Created live fixture ${id}`, "info")
	} else if (await ctx.ui.confirm("Remove Lovely Agent fixtures?", "Only task directories marked as fixtures will be deleted.")) {
		const count = await clearFixtureTasks(ctx.cwd, parentSessionId)
		ctx.ui.notify(`Removed ${count} fixture task${count === 1 ? "" : "s"}`, "info")
	}
}

async function select(ctx: ExtensionContext, title: string, items: SelectItem[]): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container()
		container.addChild(border(text => theme.fg("accent", text)))
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0))
		const list = new SelectList(items, Math.min(Math.max(items.length, 1), 15), {
			selectedPrefix: text => theme.fg("accent", text),
			selectedText: text => theme.fg("accent", text),
			description: text => theme.fg("muted", text),
			scrollInfo: text => theme.fg("dim", text),
			noMatch: text => theme.fg("warning", text)
		})
		list.onSelect = item => done(item.value)
		list.onCancel = () => done(null)
		container.addChild(list)
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 1, 0))
		container.addChild(border(text => theme.fg("accent", text)))
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				list.handleInput(data)
				tui.requestRender()
			}
		}
	})
}

async function showText(ctx: ExtensionContext, title: string, content: string): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const body = new Text(content, 0, 0)
		let offset = 0
		let pageSize = 1
		let total = 0
		return {
			render(width: number) {
				const lines = body.render(width)
				total = lines.length
				pageSize = Math.max(1, Math.floor(tui.terminal.rows * 0.6) - 2)
				offset = Math.max(0, Math.min(offset, total - pageSize))
				return [
					truncateToWidth(theme.fg("accent", theme.bold(title.replace(/[\r\n]+/g, " "))), width),
					...lines.slice(offset, offset + pageSize).map(line => truncateToWidth(line, width)),
					truncateToWidth(
						theme.fg(
							"dim",
							`Enter/Esc back · ↑↓ PgUp/PgDn Home/End · ${Math.min(offset + 1, total)}-${Math.min(offset + pageSize, total)}/${total}`
						),
						width
					)
				]
			},
			invalidate: () => body.invalidate(),
			handleInput(data: string) {
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done(undefined)
				if (matchesKey(data, Key.up)) offset--
				else if (matchesKey(data, Key.down)) offset++
				else if (matchesKey(data, Key.pageUp)) offset -= pageSize
				else if (matchesKey(data, Key.pageDown)) offset += pageSize
				else if (matchesKey(data, Key.home)) offset = 0
				else if (matchesKey(data, Key.end)) offset = total - pageSize
				else return
				offset = Math.max(0, Math.min(offset, total - pageSize))
				tui.requestRender()
			}
		}
	})
}

function border(color: (text: string) => string): { render(width: number): string[]; invalidate(): void } {
	return {
		render: width => [color("─".repeat(Math.max(1, width)))],
		invalidate() {}
	}
}

function registerFixtureTimer(cwd: string, parentSessionId: string, live: FixtureLiveTask): void {
	const registry = fixtureTimerRegistry()
	const key = fixtureTimerKey(cwd, parentSessionId)
	const liveTasks = registry.get(key) ?? new Set<FixtureLiveTask>()
	liveTasks.add(live)
	registry.set(key, liveTasks)
}

function unregisterFixtureTimer(cwd: string, parentSessionId: string, live: FixtureLiveTask): void {
	const registry = fixtureTimerRegistry()
	const key = fixtureTimerKey(cwd, parentSessionId)
	const liveTasks = registry.get(key)
	if (!liveTasks) return
	liveTasks.delete(live)
	if (liveTasks.size === 0) registry.delete(key)
}

function fixtureTimerRegistry(): FixtureTimerRegistry {
	const globals = globalThis as unknown as Record<symbol, unknown>
	const existing = globals[FIXTURE_TIMERS]
	if (existing instanceof Map) return existing as FixtureTimerRegistry
	const registry: FixtureTimerRegistry = new Map()
	globals[FIXTURE_TIMERS] = registry
	return registry
}

function fixtureTimerKey(cwd: string, parentSessionId: string): string {
	return `${resolve(cwd)}\0${parentSessionId}`
}

async function createFixtureTask(
	cwd: string,
	parentSessionId: string,
	fixtureOwnerSessionId: string,
	label: string,
	state: TaskMetadata["state"],
	latestOutcome: TaskMetadata["latestOutcome"]
): Promise<TaskStoragePaths> {
	const paths = await reserveTaskStorage(await ensureParentStorage(cwd, parentSessionId))
	await writeFile(join(paths.taskDirectory, FIXTURE_MARKER), fixtureOwnerSessionId, { flag: "wx", mode: 0o600 })
	await initializeRetainedLogs(paths)
	const now = Date.now()
	const active = state === "queued" || state === "running" || state === "suspended"
	const metadata: TaskMetadata = {
		version: TASK_METADATA_VERSION,
		kind: "agent",
		taskRef: paths.taskRef,
		parentSessionId,
		childSessionId: `fixture-${randomBytes(8).toString("hex")}`,
		definitionName: FIXTURE_DEFINITION,
		label,
		model: { provider: "fixture", id: "dummy" },
		thinking: "off",
		depth: 1,
		allowAgents: false,
		sessionConfig: {
			systemPrompt: "Development fixture agent.",
			tools: null,
			excludeAgentsMd: false,
			scopedModels: [{ provider: "fixture", id: "dummy" }]
		},
		state,
		latestOutcome,
		latestReply: { text: `${title(state)} fixture output.`, streaming: false },
		lastRunSequence: 1,
		activeRun: active
			? {
					id: `r_${randomBytes(8).toString("hex")}`,
					sequence: 1,
					kind: "initial",
					state,
					input: "Exercise the Lovely Agents development UI.",
					acceptedAt: now,
					...(state === "queued" ? {} : { startedAt: now }),
					detachedAt: now
				}
			: null,
		queuedFollowUps: [],
		notifications: [],
		discardedAt: null,
		createdAt: now,
		updatedAt: now
	}
	await writeTaskMetadata(paths, metadata)
	await appendHistoryLog(paths, { type: "run-start", sequence: 1, kind: "initial", timestamp: now })
	await appendHistoryLog(paths, {
		type: "input",
		delivery: "initial",
		timestamp: now,
		content: "Exercise the Lovely Agents development UI."
	})
	await appendHistoryLog(paths, { type: "assistant", content: `${title(state)} fixture output.` })
	if (!active) await appendHistoryLog(paths, { type: "run-end", sequence: 1, outcome: latestOutcome ?? "succeeded", timestamp: now })
	await appendHistoryLog(paths, {
		type: "tool",
		tool: "fixture",
		arguments: JSON.stringify({ state }),
		result: "Fixture task created",
		isError: false
	})
	return paths
}

async function isRegularFile(path: string): Promise<boolean> {
	try {
		const stats = await lstat(path)
		return stats.isFile() && !stats.isSymbolicLink()
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
		throw error
	}
}

async function isOwnedFixture(path: string, parentSessionId: string): Promise<boolean> {
	return (await isRegularFile(path)) && (await readFile(path, "utf8")) === parentSessionId
}

export function renderDefinition(definition: AgentDefinition): string {
	return [
		definition.description,
		`Source: ${definition.source}`,
		`Path: ${definition.displayPath}`,
		`Model: ${definition.model ?? "inherit parent"}`,
		`Thinking: ${definition.thinking ?? "inherit"}`,
		`Tools: ${definition.tools?.join(", ") ?? "default"}`,
		`AGENTS.md: ${definition.excludeAgentsMd ? "excluded" : "included"}`,
		"",
		"Body:",
		definition.systemPrompt
	].join("\n")
}

function renderDiagnostic(diagnostic: DefinitionDiagnostic): string {
	return `${diagnostic.message}\n\nSource: ${diagnostic.source}\nPath: ${diagnostic.path}`
}

function renderTask(task: TaskListRow): string {
	return [
		`Task: ${task.id}`,
		`State: ${task.state}`,
		`Outcome: ${task.latestOutcome ?? "none"}`,
		`Definition: ${task.definition}`,
		`Model: ${task.model}`,
		`Thinking: ${task.thinking}`,
		`Queued Follow-ups: ${task.queuedFollowUps}`,
		`Output lines: ${task.outputLines ?? "unknown"}`,
		...(task.queueReason ? [`Waiting: ${task.queueReason}`] : []),
		...(task.lastActivity ? [`Last activity: ${task.lastActivity.action} (${relativeTime(task.lastActivity.at, Date.now())})`] : []),
		`Descendants: ${task.descendants.total}`,
		"",
		`History: ${task.paths.history}`,
		`Session: ${task.paths.session}`
	].join("\n")
}

function title(value: string): string {
	return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`
}
