import { lstat, readFile } from "node:fs/promises"
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Container, Key, matchesKey, type SelectItem, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui"
import type { AgentDefinition, DefinitionDiagnostic, DefinitionDiscoveryResult } from "./definitions.js"
import { type PruneResult, pruneTasks } from "./prune.js"
import { displayWorkspacePath, parentStoragePaths, readRetainedOutput, readTaskMetadata, taskStoragePaths } from "./state.js"
import { relativeTime, type TaskListResult, type TaskListRow } from "./tools.js"
import { bindTaskUpdateRoute } from "./updates.js"
import { hasCode } from "./utils.js"

export type ManagementUiOptions = {
	discoverDefinitions: () => DefinitionDiscoveryResult
	loadTasks: () => Promise<TaskListResult>
	focusTasks: () => Promise<void>
	openConfig: () => Promise<void>
	/** False means the foreground input was cancelled and must not be reported accepted. */
	inputTask: (id: string, content: string, delivery: "followup" | "steer" | "stdin", eof?: boolean) => Promise<undefined | false>
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
			{ value: "tasks", label: `Tasks (${tasks.tasks.length})`, description: "Inspect durable direct children" },
			{ value: "config", label: "Configuration", description: "Edit user and workspace settings" },
			{ value: "prune", label: "Prune discarded tasks", description: "Permanently delete discarded task files in this workspace" }
		])
		if (!choice) return

		switch (choice) {
			case "definitions":
				await showDefinitions(ctx, definitions)
				break
			case "tasks":
				await options.focusTasks()
				return
			case "config":
				await options.openConfig()
				break
			case "prune":
				await pruneDiscardedTasks(ctx)
				break
		}
	}
}

/** Dry-run first; deletion needs an explicit confirmation of the exact candidate list. */
async function pruneDiscardedTasks(ctx: ExtensionContext): Promise<void> {
	const dry = await pruneTasks(ctx.cwd)
	const report = (result: PruneResult, paths: string[], verb: string) =>
		[
			`${verb}: ${paths.length} task(s)`,
			...paths.map(path => `  ${displayWorkspacePath(ctx.cwd, path)}`),
			...(result.diagnostics.length > 0 ? ["", "Retained:", ...result.diagnostics.map(line => `  ${line}`)] : [])
		].join("\n")
	await showText(ctx, "Prune discarded tasks (dry run)", report(dry, dry.candidates, "Would delete"))
	if (dry.candidates.length === 0) return
	if (!(await ctx.ui.confirm("Prune discarded tasks", `Permanently delete ${dry.candidates.length} discarded task(s)?`))) return
	const applied = await pruneTasks(ctx.cwd, true)
	await showText(ctx, "Prune discarded tasks", report(applied, applied.deleted, "Deleted"))
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
			{
				value: "output",
				label: "Live output",
				description: task.kind === "bash" ? "Command output tail and exit status" : "Latest assistant reply and run status"
			},
			{
				value: "history",
				label: "Inputs / history",
				description: task.kind === "bash" ? "Command, stdin, and outcome" : "Current and queued inputs, past runs, and delivered Steers"
			},
			...(task.kind === "bash"
				? task.state === "running"
					? [
							{ value: "stdin", label: "Write stdin", description: "Send literal input; include a newline if the command expects one" },
							{ value: "eof", label: "Close stdin", description: "Send EOF; stdin cannot be reopened" }
						]
					: []
				: [
						{ value: "prompt", label: "System prompt", description: "Captured Pi system prompt" },
						{ value: "followup", label: "Follow-up", description: "Run more work in this retained session" },
						{ value: "steer", label: "Steer", description: "Redirect running work; otherwise becomes a Follow-up" }
					]),
			{ value: "stop", label: "Stop", description: "Stop work and preserve retained files" },
			{ value: "discard", label: "Discard", description: "Stop and remove from active work; keep files in place" }
		])
		if (!choice) return
		if (choice === "details") await showText(ctx, task.label, renderTask(task))
		else if (choice === "output") await showLiveTaskOutput(ctx, task)
		else if (choice === "history" || choice === "prompt") await showTaskContext(ctx, task, choice)
		else if (choice === "followup" || choice === "steer" || choice === "stdin") {
			const content = await ctx.ui.editor(`${title(choice)} ${task.id}`)
			if (content !== undefined && (choice === "stdin" ? content.length > 0 : !!content.trim())) {
				if ((await options.inputTask(task.id, content, choice)) !== false) {
					ctx.ui.notify(`${title(choice)} accepted for ${task.id}`, "info")
				}
			}
		} else if (choice === "eof") {
			if (await ctx.ui.confirm(`Close stdin for ${task.id}?`, "This cannot be undone.")) {
				if ((await options.inputTask(task.id, "", "stdin", true)) !== false) ctx.ui.notify(`Stdin closed for ${task.id}`, "info")
			}
		} else if (choice === "stop") {
			if (
				await ctx.ui.confirm(
					`Stop ${task.id}?`,
					task.kind === "bash" ? "The command will not restart. Output remains available." : "The retained session remains reusable."
				)
			) {
				await options.controlTask(task.id, "stop")
			}
		} else if (
			await ctx.ui.confirm(`Discard ${task.id}?`, "Files stay at their original paths. Results remain readable; further input is rejected.")
		) {
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
		if (metadata.kind !== "agent") throw new Error("Bash tasks do not have a system prompt")
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
	let closed = false
	let loading = false
	let refreshAgain = false
	await showScrollable(ctx, {
		follow: task.kind === "bash",
		header: theme => [
			theme.fg(
				"accent",
				theme.bold(
					`${task.id} · ${output.state}${output.latestOutcome ? `/${output.latestOutcome}` : ""}${output.streaming ? " · streaming" : ""}${
						output.exitCode !== undefined ? ` · Exit code: ${output.exitCode ?? "unknown"} · Signal: ${output.signal ?? "none"}` : ""
					}`
				)
			),
			`Capacity: ${output.capacity.active}/${output.capacity.limit} execution permits`,
			...(output.progress ? [`Progress: ${JSON.stringify(output.progress)}`] : []),
			...(output.queueReason ? [`Waiting: ${output.queueReason}`] : []),
			...(output.lastActivity ? [`${output.lastActivity.action} · ${relativeTime(output.lastActivity.at, Date.now())}`] : []),
			""
		],
		body: () => output.text || "(no output)",
		subscribe(rerender) {
			const unbind = bindTaskUpdateRoute(ctx.cwd, ctx.sessionManager.getSessionId(), async () => {
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
						rerender()
					} while (refreshAgain)
				} finally {
					loading = false
				}
			})
			return () => {
				closed = true
				unbind()
			}
		}
	})
}

async function select(ctx: ExtensionContext, title: string, items: SelectItem[]): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container()
		container.addChild(new DynamicBorder(text => theme.fg("accent", text)))
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
		container.addChild(new DynamicBorder(text => theme.fg("accent", text)))
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

function showText(ctx: ExtensionContext, title: string, content: string): Promise<void> {
	return showScrollable(ctx, {
		header: theme => [theme.fg("accent", theme.bold(title.replace(/[\r\n]+/g, " ")))],
		body: () => content
	})
}

/** Wrapped, bounded viewport. `follow` sticks to the bottom until the user scrolls up; End resumes it. */
async function showScrollable(
	ctx: ExtensionContext,
	view: {
		header(theme: ExtensionContext["ui"]["theme"]): string[]
		body(): string
		follow?: boolean
		subscribe?(rerender: () => void): () => void
	}
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let offset = 0
		let pageSize = 1
		let total = 0
		let follow = view.follow ?? false
		const unsubscribe = view.subscribe?.(() => tui.requestRender())
		return {
			render(width: number) {
				const header = view.header(theme)
				const lines = new Text(view.body(), 0, 0).render(width)
				total = lines.length
				pageSize = Math.max(1, Math.floor(tui.terminal.rows * 0.6) - header.length - 1)
				const maxOffset = Math.max(0, total - pageSize)
				offset = follow ? maxOffset : Math.max(0, Math.min(offset, maxOffset))
				const position = `${Math.min(offset + 1, total)}-${Math.min(offset + pageSize, total)}/${total}${follow ? " · follow" : ""}`
				return [
					...header,
					...lines.slice(offset, offset + pageSize),
					theme.fg("dim", `Enter/Esc back · ↑↓ PgUp/PgDn Home/End · ${position}`)
				].map(line => truncateToWidth(line, width))
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done(undefined)
				if (matchesKey(data, Key.up)) offset--
				else if (matchesKey(data, Key.down)) offset++
				else if (matchesKey(data, Key.pageUp)) offset -= pageSize
				else if (matchesKey(data, Key.pageDown)) offset += pageSize
				else if (matchesKey(data, Key.home)) offset = 0
				else if (matchesKey(data, Key.end)) offset = total - pageSize
				else return
				const maxOffset = Math.max(0, total - pageSize)
				offset = Math.max(0, Math.min(offset, maxOffset))
				// Following is only meaningful for views that asked for it.
				follow = view.follow === true && offset >= maxOffset
				tui.requestRender()
			},
			dispose() {
				unsubscribe?.()
			}
		}
	})
}

async function isRegularFile(path: string): Promise<boolean> {
	try {
		const stats = await lstat(path)
		return stats.isFile() && !stats.isSymbolicLink()
	} catch (error) {
		if (hasCode(error, "ENOENT")) return false
		throw error
	}
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
		...(task.progress ? [`Progress: ${JSON.stringify(task.progress)}`] : []),
		...(task.kind === "bash"
			? [
					`Command: ${task.command}`,
					`Working directory: ${task.cwd}`,
					`Exit code: ${task.exitCode ?? "none"}`,
					`Signal: ${task.signal ?? "none"}`
				]
			: [
					`Definition: ${task.definition}`,
					`Model: ${task.model}`,
					`Thinking: ${task.thinking}`,
					`Queued Follow-ups: ${task.queuedFollowUps}`
				]),
		`Output lines: ${task.outputLines}`,
		...(task.queueReason ? [`Waiting: ${task.queueReason}`] : []),
		...(task.lastActivity ? [`Last activity: ${task.lastActivity.action} (${relativeTime(task.lastActivity.at, Date.now())})`] : []),
		...(task.kind === "agent" ? [`Descendants: ${task.descendants}`] : []),
		"",
		`History: ${task.paths.history}`,
		task.kind === "bash" ? `Output: ${task.paths.output}` : `Session: ${task.paths.session}`
	].join("\n")
}

function title(value: string): string {
	return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`
}
