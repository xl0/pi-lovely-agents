import { afterEach, expect, test } from "bun:test"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { type Component, visibleWidth } from "@earendil-works/pi-tui"
import { createTaskPanel } from "../../extensions/lovely-agents/task-panel.js"
import type { TaskListResult, TaskListRow } from "../../extensions/lovely-agents/tools.js"
import { publishSchedulerUpdate, publishTaskUpdate } from "../../extensions/lovely-agents/updates.js"

const down = "\x1b[B"
const up = "\x1b[A"
const esc = "\x1b"
const cleanups: Array<() => void> = []
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
})

test("one panel switches from active rows to all tasks; keys return to the editor unchanged", async () => {
	const h = harness()
	await h.panel.refresh()
	expect(h.lines().join("\n")).toContain("running")
	expect(h.lines().join("\n")).not.toContain("idle")
	expect(h.panel.handleInput(down, false)).toBe(false)
	expect(h.panel.handleInput("x", true)).toBe(false)
	expect(h.panel.handleInput(down, true)).toBe(true)
	expect(h.lines().join("\n")).toContain("→ a_00000000")
	expect(h.lines().join("\n")).toContain("idle")
	expect(h.panel.handleInput(up, true)).toBe(true)
	expect(h.lines().join("\n")).not.toContain("Tasks")

	for (const data of ["hello", "界", "\x1b[200~pasted\ntext\x1b[201~", "\x0f"]) {
		h.panel.focus()
		expect(h.panel.handleInput(data, true)).toBe(false)
		expect(h.lines().join("\n")).not.toContain("Tasks")
	}
	h.panel.focus()
	expect(h.panel.handleInput(esc, true)).toBe(true)
	expect(h.lines().join("\n")).not.toContain("Tasks")
})

test("navigation scrolls five rows, bounds width, and preserves selection across live reorder/removal", async () => {
	const h = harness()
	h.result.tasks = Array.from({ length: 9 }, (_, index) => row(index))
	await h.panel.refresh()
	h.panel.focus()
	for (let index = 0; index < 8; index++) h.panel.handleInput(down, true)
	expect(h.lines().join("\n")).toContain("→ a_00000008")
	expect(h.lines()).toHaveLength(8) // heading, five rows, position, help
	for (const width of [1, 20, 40, 120]) {
		expect(h.lines(width).every(line => visibleWidth(line) <= width)).toBe(true)
	}
	h.panel.handleInput(down, true)
	expect(h.lines().join("\n")).toContain("→ a_00000008")
	h.result.tasks.reverse()
	publishTaskUpdate(h.ctx.cwd, "parent")
	await h.panel.refresh()
	expect(h.lines().join("\n")).toContain("→ a_00000008")
	h.result.tasks.shift()
	await h.panel.refresh()
	expect(h.lines().join("\n")).toContain("→ a_00000007")
})

test("shows queue reasons, capacity, and activity through event-driven updates", async () => {
	const h = harness()
	const task = h.result.tasks[0]
	if (!task) throw new Error("Missing fixture task")
	task.state = "queued"
	task.queueReason = "capacity"
	h.result.capacity = { active: 4, limit: 4 }
	await h.panel.refresh()
	expect(h.lines().join("\n")).toContain("waiting: capacity")
	h.panel.focus()
	expect(h.lines().join("\n")).toContain("capacity 4/4")
	task.queueReason = "provider-limit"
	h.result.capacity = { active: 0, limit: 4 }
	publishSchedulerUpdate()
	await Bun.sleep(0)
	expect(h.lines().join("\n")).toContain("waiting: provider-limit")
	expect(h.lines().join("\n")).toContain("capacity 0/4")
	task.state = "running"
	task.queueReason = null
	task.lastActivity = { at: Date.now() - 20_000, action: "thinking" }
	publishTaskUpdate(h.ctx.cwd, "parent")
	await Bun.sleep(0)
	expect(h.lines().join("\n")).toContain("thinking")
	h.panel.handleInput(esc, true)
	expect(h.lines().join("\n")).toMatch(/thinking \(\d+s ago\)/)
})

test("Enter opens the selected task once, hides duplicate rows, then returns to its selection", async () => {
	let finish!: () => void
	const h = harness(
		() =>
			new Promise<void>(resolve => {
				finish = resolve
			})
	)
	await h.panel.refresh()
	h.panel.focus()
	h.panel.handleInput(down, true)
	h.panel.handleInput("\r", true)
	h.panel.handleInput("\r", true)
	expect(h.opened).toEqual(["task:a_00000001"])
	expect(h.lines()).toEqual([])
	await h.panel.refresh()
	expect(h.lines()).toEqual([])
	finish()
	await Bun.sleep(0)
	expect(h.lines().join("\n")).toContain("→ a_00000001")
})

test("empty and diagnostic-only partitions remain navigable", async () => {
	const h = harness()
	h.result.tasks = []
	await h.panel.refresh()
	expect(h.lines()).toEqual([])
	h.panel.focus()
	expect(h.lines().join("\n")).toContain("No durable tasks")
	h.panel.handleInput("\r", true)
	expect(h.opened).toEqual([])
	h.result.diagnostics = [{ code: "invalid", path: "/task/metadata.json", message: "Bad metadata" }]
	await h.panel.refresh()
	expect(h.lines().join("\n")).toContain("[error] invalid")
	h.panel.handleInput("\r", true)
	expect(h.opened).toEqual(["diagnostic:/task/metadata.json"])
	await Bun.sleep(0)
})

test("refresh coalesces updates during reads; disposal fences in-flight writes and unsubscribes", async () => {
	const h = harness()
	let finish!: (result: TaskListResult) => void
	let reads = 0
	h.load = () => {
		reads++
		if (reads === 1)
			return new Promise(resolve => {
				finish = resolve
			})
		return Promise.resolve(h.result)
	}
	const pending = h.panel.refresh()
	publishTaskUpdate(h.ctx.cwd, "parent")
	finish({ ...h.result, tasks: [] })
	await pending
	expect(reads).toBe(2)
	expect(h.lines().join("\n")).toContain("running")

	h.load = () =>
		new Promise(resolve => {
			finish = resolve
		})
	const stale = h.panel.refresh()
	h.panel.dispose()
	const writes = h.writes
	finish(h.result)
	await stale
	publishTaskUpdate(h.ctx.cwd, "parent")
	await Bun.sleep(0)
	expect(h.writes).toBe(writes)
	expect(h.lines()).toEqual([])
	expect(h.panel.handleInput(down, true)).toBe(false)
})

test("failed action restores the panel and reports the error", async () => {
	const h = harness(async () => {
		throw new Error("Task has been discarded")
	})
	await h.panel.refresh()
	h.panel.focus()
	h.panel.handleInput("\r", true)
	await Bun.sleep(0)
	expect(h.errors).toEqual(["Lovely Agents task panel: Task has been discarded"])
	expect(h.lines().join("\n")).toContain("Tasks")
})

function row(index: number): TaskListRow {
	return {
		id: `a_0000000${index}`,
		label: `Task ${index}`,
		state: index % 2 ? "idle" : "running",
		model: "provider/model",
		queuedFollowUps: 0
	} as TaskListRow
}

function harness(open: () => Promise<void> = async () => {}) {
	let component: Component | undefined
	const h = {
		result: { tasks: [row(0), row(1)], diagnostics: [], total: 2, capacity: { active: 1, limit: 4 } } as TaskListResult,
		load: (): Promise<TaskListResult> => Promise.resolve(h.result),
		opened: [] as string[],
		errors: [] as string[],
		writes: 0
	}
	const theme = { fg: (_color: string, text: string) => text }
	const ctx = {
		cwd: `/test/task-panel-${crypto.randomUUID()}`,
		sessionManager: { getSessionId: () => "parent" },
		ui: {
			setStatus: () => {
				h.writes++
			},
			setWidget: (_id: string, factory: ((_tui: unknown, theme: unknown) => Component) | undefined) => {
				h.writes++
				component = factory?.({}, theme)
			},
			notify: (message: string) => {
				h.errors.push(message)
			}
		}
	} as unknown as ExtensionContext
	const panel = createTaskPanel(ctx, {
		loadTasks: () => h.load(),
		openSelection: async value => {
			h.opened.push(value)
			await open()
		}
	})
	cleanups.push(() => panel.dispose())
	return Object.assign(h, { ctx, panel, lines: (width = 120) => component?.render(width) ?? [] })
}
