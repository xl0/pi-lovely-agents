import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Key, matchesKey, type SelectItem, truncateToWidth } from "@earendil-works/pi-tui"
import type { TaskListResult, TaskListRow } from "./tools.js"
import { bindTaskUpdateRoute } from "./updates.js"

const PANEL_ID = "lovely-agents"
const TASK_STATE_ORDER: Record<TaskListRow["state"], number> = {
	running: 0,
	suspended: 1,
	queued: 2,
	interrupted: 3,
	idle: 4
}
type PanelItem = SelectItem & { group: "Agents" | "Bash" | "Diagnostics" }

/** One below-editor surface: passive active rows, or a focused list of all direct tasks. */
export function createTaskPanel(
	ctx: ExtensionContext,
	options: { loadTasks: () => Promise<TaskListResult>; openSelection: (value: string) => Promise<void> }
) {
	let tasks: TaskListResult["tasks"] = []
	let items: PanelItem[] = []
	let capacity = { active: 0, limit: 0 }
	let bashCapacity = { active: 0, limit: 0 }
	let selected: string | undefined
	let focused = false
	let opening = false
	let disposed = false
	let pending: Promise<void> | undefined
	let refreshAgain = false

	function draw() {
		if (disposed) return
		const active = tasks.filter(task => task.state === "queued" || task.state === "running" || task.state === "suspended")
		const bashCount = active.filter(task => task.kind === "bash").length
		const agentCount = active.length - bashCount
		ctx.ui.setStatus(
			PANEL_ID,
			active.length > 0
				? [
						...(agentCount ? [`agents:${agentCount} slots:${capacity.active}/${capacity.limit}`] : []),
						...(bashCount ? [`bash:${bashCount} slots:${bashCapacity.active}/${bashCapacity.limit}`] : [])
					].join(" ")
				: undefined
		)
		if (opening || (!focused && active.length === 0)) {
			ctx.ui.setWidget(PANEL_ID, undefined)
			return
		}
		ctx.ui.setWidget(
			PANEL_ID,
			(_tui, theme) => ({
				render(width) {
					if (!focused) return renderActiveTaskRows(active).map(line => truncateToWidth(line, width))
					return [
						...(items.length > 0 ? renderFocusedItems(items, selected, width, theme) : ["No durable tasks for this session."]),
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
				tasks = [...result.tasks].sort(comparePanelTasks)
				capacity = result.capacity
				bashCapacity = result.bashCapacity
				items = [
					...tasks.map(task => ({
						value: `task:${task.id}`,
						// One full-width row, not SelectList's fixed-width label/description columns.
						label: (
							`${task.id} ${task.state}${task.latestOutcome ? `/${task.latestOutcome}` : ""} ${task.label} · ` +
							`${task.queueReason ? `waiting: ${task.queueReason} · ` : ""}${task.kind === "bash" ? "bash" : task.model}${task.queuedFollowUps ? ` (+${task.queuedFollowUps})` : ""}` +
							(task.progress || task.inputPreview ? ` · ${JSON.stringify(task.progress ?? task.inputPreview)}` : "")
						).replace(/[\r\n]+/g, " "),
						group: (task.kind === "bash" ? "Bash" : "Agents") as PanelItem["group"]
					})),
					...result.diagnostics.map(diagnostic => ({
						value: `diagnostic:${diagnostic.path}`,
						label: `[error] ${diagnostic.id ?? diagnostic.code}`,
						description: diagnostic.message,
						group: "Diagnostics" as const
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
		state: TaskListRow["state"]
		queuedFollowUps: number
	} & Pick<TaskListRow, "kind" | "createdAt"> &
		Partial<Pick<TaskListRow, "queueReason" | "inputPreview" | "progress">>)[]
): string[] {
	const sorted = [...tasks].sort(comparePanelTasks)
	const rows: string[] = []
	let rendered = 0
	let group: "Agents" | "Bash" | undefined
	for (const task of sorted) {
		if (rendered >= 5) break
		const nextGroup = task.kind === "bash" ? "Bash" : "Agents"
		if (nextGroup !== group) {
			rows.push(nextGroup)
			group = nextGroup
		}
		rows.push(
			`↳ ${task.id} ${task.state} ${task.label.replace(/[\r\n]+/g, " ")}${task.queuedFollowUps ? ` (+${task.queuedFollowUps})` : ""}` +
				(task.queueReason ? ` · waiting: ${task.queueReason}` : "") +
				(task.progress || task.inputPreview ? ` · ${JSON.stringify(task.progress ?? task.inputPreview)}` : "")
		)
		rendered++
	}
	if (sorted.length > rendered) rows.push(`  … ${sorted.length - rendered} more active`)
	return rows
}

function renderFocusedItems(
	items: readonly PanelItem[],
	selected: string | undefined,
	width: number,
	theme: {
		fg: (color: "accent" | "dim", text: string) => string
	}
): string[] {
	const selectedIndex = Math.max(
		0,
		items.findIndex(item => item.value === selected)
	)
	const start = Math.max(0, Math.min(selectedIndex - 2, items.length - 5))
	const visible = items.slice(start, start + 5)
	const lines: string[] = []
	let group: PanelItem["group"] | undefined
	for (const item of visible) {
		if (item.group !== group) {
			lines.push(theme.fg("dim", item.group))
			group = item.group
		}
		const selectedPrefix = item.value === selected ? "→ " : "  "
		const label = truncateToWidth(item.label, Math.max(1, width - 4))
		lines.push(item.value === selected ? theme.fg("accent", `${selectedPrefix}${label}`) : `${selectedPrefix}${label}`)
	}
	if (start > 0 || start + visible.length < items.length) lines.push(theme.fg("dim", `  (${selectedIndex + 1}/${items.length})`))
	return lines
}

function comparePanelTasks(
	left: Pick<TaskListRow, "kind" | "state" | "createdAt" | "id">,
	right: Pick<TaskListRow, "kind" | "state" | "createdAt" | "id">
): number {
	return (
		(left.kind === "agent" ? 0 : 1) - (right.kind === "agent" ? 0 : 1) ||
		TASK_STATE_ORDER[left.state] - TASK_STATE_ORDER[right.state] ||
		right.createdAt - left.createdAt ||
		left.id.localeCompare(right.id)
	)
}
