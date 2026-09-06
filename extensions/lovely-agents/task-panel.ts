import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Key, matchesKey, type SelectItem, SelectList, truncateToWidth } from "@earendil-works/pi-tui"
import type { TaskListResult, TaskListRow } from "./tools.js"
import { bindTaskUpdateRoute } from "./updates.js"

const PANEL_ID = "lovely-agents"

/** One below-editor surface: passive active rows, or a focused list of all direct tasks. */
export function createTaskPanel(
	ctx: ExtensionContext,
	options: { loadTasks: () => Promise<TaskListResult>; openSelection: (value: string) => Promise<void> }
) {
	let tasks: TaskListResult["tasks"] = []
	let items: SelectItem[] = []
	let capacity = { active: 0, limit: 0 }
	let selected: string | undefined
	let focused = false
	let opening = false
	let disposed = false
	let pending: Promise<void> | undefined
	let refreshAgain = false

	function draw() {
		if (disposed) return
		const active = tasks.filter(task => task.state === "queued" || task.state === "running" || task.state === "suspended")
		ctx.ui.setStatus(PANEL_ID, active.length > 0 ? `agents:${active.length} slots:${capacity.active}/${capacity.limit}` : undefined)
		if (opening || (!focused && active.length === 0)) {
			ctx.ui.setWidget(PANEL_ID, undefined)
			return
		}
		ctx.ui.setWidget(
			PANEL_ID,
			(_tui, theme) => ({
				render(width) {
					if (!focused) return renderActiveTaskRows(active).map(line => truncateToWidth(line, width))
					const list = new SelectList(
						items,
						5,
						{
							selectedPrefix: text => theme.fg("accent", text),
							selectedText: text => theme.fg("accent", text),
							description: text => theme.fg("muted", text),
							scrollInfo: text => theme.fg("dim", text),
							noMatch: text => theme.fg("warning", text)
						},
						{ truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth) }
					)
					list.setSelectedIndex(items.findIndex(item => item.value === selected))
					return [
						...(items.length > 0 ? list.render(width) : ["No durable tasks for this session."]),
						theme.fg("dim", "↑↓ navigate · Enter actions · Esc/↑ at top editor · type to edit")
					].map(line => truncateToWidth(line, width))
				},
				invalidate() {}
			}),
			{ placement: "belowEditor" }
		)
	}

	function refresh(): Promise<void> {
		if (disposed) return Promise.resolve()
		refreshAgain = true
		pending ??= (async () => {
			do {
				refreshAgain = false
				const result = await options.loadTasks()
				if (disposed) return
				const oldIndex = items.findIndex(item => item.value === selected)
				tasks = [...result.tasks].sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
				capacity = result.capacity
				items = [
					...tasks.map(task => ({
						value: `task:${task.id}`,
						// One full-width row, not SelectList's fixed-width label/description columns.
						label: (
							`${task.id} ${task.state}${task.latestOutcome ? `/${task.latestOutcome}` : ""} ${task.label} · ` +
							`${task.queueReason ? `waiting: ${task.queueReason} · ` : ""}${task.model}${task.queuedFollowUps ? ` (+${task.queuedFollowUps})` : ""}` +
							(task.inputPreview ? ` · ${JSON.stringify(task.inputPreview)}` : "")
						).replace(/[\r\n]+/g, " ")
					})),
					...result.diagnostics.map(diagnostic => ({
						value: `diagnostic:${diagnostic.path}`,
						label: `[error] ${diagnostic.id ?? diagnostic.code}`,
						description: diagnostic.message
					}))
				]
				// Keep identity across live reordering; on removal select the nearest remaining row.
				if (!items.some(item => item.value === selected)) {
					selected = items[Math.max(0, Math.min(oldIndex, items.length - 1))]?.value
				}
				draw()
			} while (refreshAgain)
		})().finally(() => {
			pending = undefined
		})
		return pending
	}

	function focus() {
		if (disposed || opening) return
		focused = true
		selected = items[0]?.value
		draw()
	}

	async function openSelected(value: string) {
		opening = true
		draw()
		try {
			await options.openSelection(value)
		} finally {
			opening = false
			if (!disposed) {
				draw()
				await refresh()
			}
		}
	}

	const reportError = (error: unknown) => {
		if (!disposed) ctx.ui.notify(`Lovely Agents task panel: ${error instanceof Error ? error.message : String(error)}`, "error")
	}
	const unbind = bindTaskUpdateRoute(ctx.cwd, ctx.sessionManager.getSessionId(), () => refresh().catch(reportError))
	return {
		refresh,
		focus,
		/** True consumes input; false delegates the original bytes to the existing editor. */
		handleInput(data: string, editorEmpty: boolean): boolean {
			if (disposed) return false
			if (opening) return true
			if (!focused) {
				if (!editorEmpty || !matchesKey(data, Key.down)) return false
				focus()
				return true
			}
			const index = items.findIndex(item => item.value === selected)
			if (matchesKey(data, Key.escape) || (matchesKey(data, Key.up) && index <= 0)) {
				focused = false
			} else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
				const delta = matchesKey(data, Key.up) ? -1 : 1
				selected = items[Math.max(0, Math.min(index + delta, items.length - 1))]?.value
			} else if (matchesKey(data, Key.enter)) {
				if (selected) void openSelected(selected).catch(reportError)
			} else {
				focused = false
				draw()
				return false
			}
			draw()
			return true
		},
		dispose() {
			if (disposed) return
			disposed = true
			unbind()
			ctx.ui.setStatus(PANEL_ID, undefined)
			ctx.ui.setWidget(PANEL_ID, undefined)
		}
	}
}

export function renderActiveTaskRows(
	tasks: readonly ({
		id: string
		label: string
		state: string
		queuedFollowUps: number
	} & Partial<Pick<TaskListRow, "queueReason" | "inputPreview">>)[]
): string[] {
	const rows = tasks
		.slice(0, 5)
		.map(
			task =>
				`↳ ${task.id} ${task.state} ${task.label.replace(/[\r\n]+/g, " ")}${task.queuedFollowUps ? ` (+${task.queuedFollowUps})` : ""}` +
				(task.queueReason ? ` · waiting: ${task.queueReason}` : "") +
				(task.inputPreview ? ` · ${JSON.stringify(task.inputPreview)}` : "")
		)
	if (tasks.length > rows.length) rows.push(`  … ${tasks.length - rows.length} more active`)
	return rows
}
