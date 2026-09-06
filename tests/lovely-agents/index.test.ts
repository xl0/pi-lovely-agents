import { describe, expect, test } from "bun:test"
import {
	type ExtensionAPI,
	type ExtensionContext,
	initTheme,
	type SessionEntry,
	type ToolDefinition
} from "@earendil-works/pi-coding-agent"
import { getAgentCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import lovelyAgentsExtension, { latestReplyWasInterrupted, successfulTurnTuple } from "../../extensions/lovely-agents/index.js"
import { seedFixtureTasks } from "../../extensions/lovely-agents/management.js"
import { notificationRouteKey } from "../../extensions/lovely-agents/notifications.js"
import { ensureParentStorage, releaseParentLeaseFor, taskStoragePaths } from "../../extensions/lovely-agents/state.js"
import { renderActiveTaskRows } from "../../extensions/lovely-agents/task-panel.js"
import { publishSchedulerUpdate, publishTaskUpdate } from "../../extensions/lovely-agents/updates.js"
import { withTempWorkspace } from "./test-helpers.js"

test("capability schemas and tool visibility follow config without hiding controls for retained tasks", async () => {
	await withTempWorkspace(async workspace => {
		await workspace.write("workspace/.pi/xl0-pi-lovely-agents.json", JSON.stringify({ backgroundAgents: false, backgroundBash: false }))
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>()
		const tools = new Map<string, ToolDefinition>()
		let active = ["read"]
		const lifetime = new AbortController()
		const unbindContext = getAgentCoordinator().bindSessionContext("parent", {
			depth: 0,
			allowAgents: true,
			disposeSignal: lifetime.signal
		})
		let disposed = false
		let staleCalls = 0
		let toolReads = 0
		const assertLive = () => {
			if (disposed) {
				staleCalls++
				throw new Error("Extension context is stale")
			}
		}
		lovelyAgentsExtension({
			registerMessageRenderer() {},
			registerCommand() {},
			registerTool(tool: ToolDefinition) {
				if (!tools.has(tool.name)) active.push(tool.name)
				tools.set(tool.name, tool)
			},
			getActiveTools: () => {
				assertLive()
				toolReads++
				return [...active]
			},
			setActiveTools: (names: string[]) => {
				assertLive()
				active = names
			},
			on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler])
			}
		} as unknown as ExtensionAPI)
		const errors: string[] = []
		const ctx = {
			cwd: workspace.cwd,
			mode: "print",
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
			get ui() {
				assertLive()
				return { notify: (message: string) => errors.push(message) }
			}
		} as unknown as ExtensionContext
		const emit = async (name: string, reason: string) => {
			for (const handler of handlers.get(name) ?? []) await handler({ reason }, ctx)
		}
		const environment = process.env as { PI_CODING_AGENT_DIR?: string }
		const previous = environment.PI_CODING_AGENT_DIR
		environment.PI_CODING_AGENT_DIR = workspace.agentDir
		try {
			await emit("session_start", "reload")
			expect(active).toContain("agent")
			expect(active).toContain("task_input")
			expect(active).not.toContain("bash_bg")
			expect(tools.get("task_input")).not.toHaveProperty("parameters.properties.eof")
			expect(tools.get("agent")).not.toHaveProperty("parameters.properties.waitMs")
			expect(tools.get("agent")?.description).toContain("terminal result")
			active = active.filter(name => name !== "task_stop")
			await emit("session_shutdown", "reload")
			await workspace.write(
				"workspace/.pi/xl0-pi-lovely-agents.json",
				JSON.stringify({
					backgroundAgents: true,
					backgroundBash: true,
					maxDepth: 0
				})
			)
			await emit("session_start", "reload")
			expect(active).toContain("bash_bg")
			expect(active).toContain("task_input")
			expect(active).not.toContain("agent")
			expect(tools.get("task_input")).toHaveProperty("parameters.properties.eof")
			expect(tools.get("task_input")).not.toHaveProperty("parameters.properties.delivery")
			expect(tools.get("agent")).toHaveProperty("parameters.properties.waitMs")
			expect(tools.get("agent")).not.toHaveProperty("parameters.properties.allowAgents")
			expect(tools.get("agent")).not.toHaveProperty("parameters.properties.fork")
			await seedFixtureTasks(workspace.cwd, "parent")
			for (let i = 0; i < 200 && !active.includes("task_discard"); i++) await Bun.sleep(5)
			expect(active).toContain("task_discard")
			expect(active).toContain("task_output")
			expect(active).not.toContain("task_stop")
			expect(active).not.toContain("agent")
			expect(active).not.toContain("agent_roster")
			expect(tools.get("task_input")).toHaveProperty("parameters.properties.delivery")
			expect(errors).toEqual([])

			const bash = tools.get("bash_bg")
			if (!bash) throw new Error("Missing Bash tool")
			await bash.execute("retained-bash", { command: "printf kept", label: "Retained Bash", waitMs: 1000 }, undefined, undefined, ctx)
			await emit("session_shutdown", "reload")
			await workspace.write(
				"workspace/.pi/xl0-pi-lovely-agents.json",
				JSON.stringify({ backgroundAgents: false, backgroundBash: false, maxDepth: 0 })
			)
			await emit("session_start", "reload")
			expect(active).not.toContain("bash_bg")
			expect(active).toContain("task_input")
			expect(tools.get("task_input")).toHaveProperty("parameters.properties.eof")

			// SDK idle disposal has no session_shutdown: cancel pending reads and queued callbacks.
			const reads = toolReads
			publishSchedulerUpdate()
			await Promise.resolve()
			expect(toolReads).toBeGreaterThan(reads)
			publishTaskUpdate(workspace.cwd, "parent")
			lifetime.abort()
			disposed = true
			expect(getAgentCoordinator().getNotificationRoute(notificationRouteKey(workspace.cwd, "parent"))).toBeUndefined()
			publishSchedulerUpdate()
			publishTaskUpdate(workspace.cwd, "parent")
			await Bun.sleep(50)
			expect(staleCalls).toBe(0)
			expect(errors).toEqual([])
		} finally {
			lifetime.abort()
			unbindContext()
			if (previous === undefined) delete environment.PI_CODING_AGENT_DIR
			else environment.PI_CODING_AGENT_DIR = previous
			if (!disposed) await emit("session_shutdown", "quit")
			else await releaseParentLeaseFor(workspace.cwd, "parent")
		}
	})
})

test("manual controls cancel foreground input and notify only successful discard", async () => {
	initTheme("dark")
	await withTempWorkspace(async workspace => {
		await workspace.write("workspace/.pi/xl0-pi-lovely-agents.json", JSON.stringify({ backgroundAgents: false }))
		const ids = await seedFixtureTasks(workspace.cwd, "parent")
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>()
		const messages: Array<{ content: string; options: unknown }> = []
		const errors: string[] = []
		lovelyAgentsExtension({
			registerMessageRenderer() {},
			registerTool() {},
			registerCommand() {},
			getActiveTools: () => [],
			setActiveTools() {},
			on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler])
			},
			sendMessage(message: { content: string }, options: unknown) {
				messages.push({ content: message.content, options })
			}
		} as unknown as ExtensionAPI)
		const editor = { getText: () => "", handleInput(_data: string) {} }
		let factory = () => editor
		let confirmed = false
		let choice: string | undefined = "discard"
		let inputSignal: AbortSignal | undefined
		let inputStopped = false
		let inputDialog = false
		const parent = await ensureParentStorage(workspace.cwd, "parent")
		const unbindResidents = ids.map(id =>
			getAgentCoordinator().bindResident(taskStoragePaths(parent, id).taskDirectory, {
				stop() {},
				dispose() {},
				async input(_content, _delivery, options) {
					expect(options?.background).toBe(false)
					inputSignal = options?.signal
					if (!inputSignal) throw new Error("Missing UI cancellation signal")
					return new Promise((_resolve, reject) =>
						inputSignal?.addEventListener(
							"abort",
							() => {
								inputStopped = true
								reject(inputSignal?.reason)
							},
							{ once: true }
						)
					)
				}
			})
		)
		const ctx = {
			cwd: workspace.cwd,
			mode: "tui",
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
			ui: {
				setStatus() {},
				setWidget() {},
				notify(message: string) {
					errors.push(message)
				},
				getEditorComponent: () => factory,
				setEditorComponent(value: typeof factory) {
					factory = value
				},
				confirm: async () => confirmed,
				editor: async () => "Follow-up",
				custom: async (create: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
					if (inputDialog) {
						inputDialog = false
						return new Promise((resolve, reject) => {
							let component: { dispose?(): void } | undefined
							void Promise.resolve(
								create({ requestRender() {} } as never, { fg: (_color: string, text: string) => text } as never, {} as never, result => {
									component?.dispose?.()
									resolve(result)
								})
							)
								.then(async created => {
									component = created
									for (let i = 0; i < 200 && !inputSignal; i++) await Bun.sleep(5)
									expect(inputSignal).toBeDefined()
									created.handleInput?.("\x1b")
								})
								.catch(reject)
						})
					}
					const value = choice
					choice = undefined
					if (value === "followup") inputDialog = true
					return value
				}
			}
		} as unknown as ExtensionContext
		const agentDirVariable = "PI_CODING_AGENT_DIR"
		const previousAgentDir = process.env[agentDirVariable]
		process.env[agentDirVariable] = workspace.agentDir
		try {
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "reload" }, ctx)
			const wrapped = factory()
			wrapped.handleInput("\x1b[B")
			wrapped.handleInput("\r")
			await Bun.sleep(30)
			expect(messages).toHaveLength(0)
			choice = "followup"
			wrapped.handleInput("\r")
			for (let i = 0; i < 200 && !inputStopped && errors.length === 0; i++) await Bun.sleep(5)
			expect(errors).toEqual([])
			expect(inputStopped).toBe(true)
			await Bun.sleep(30)
			expect(errors).toEqual([])
			expect(messages).toHaveLength(0)
			for (const unbind of unbindResidents) unbind()
			confirmed = true
			choice = "discard"
			wrapped.handleInput("\r")
			for (let attempts = 0; attempts < 200 && messages.length === 0 && errors.length === 0; attempts++) await Bun.sleep(5)
			expect(errors).toEqual([])
			expect(messages).toHaveLength(1)
			expect(messages[0]?.content).toContain("User manually discarded task a_")
			expect(messages[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: false })
		} finally {
			for (const unbind of unbindResidents) unbind()
			if (previousAgentDir === undefined) delete process.env[agentDirVariable]
			else process.env[agentDirVariable] = previousAgentDir
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx)
		}
	})
})

describe("/continue eligibility", () => {
	test("accepts only the latest errored or aborted assistant reply", () => {
		expect(latestReplyWasInterrupted([])).toBe(false)
		expect(latestReplyWasInterrupted(branch("stop"))).toBe(false)
		expect(latestReplyWasInterrupted(branch("length"))).toBe(false)
		expect(latestReplyWasInterrupted(branch("error"))).toBe(true)
		expect(latestReplyWasInterrupted(branch("aborted"))).toBe(true)
	})
})

describe("automatic tuple recovery", () => {
	test("uses only successful assistant turns with an exact model identity", () => {
		expect(successfulTurnTuple({ role: "assistant", stopReason: "stop", provider: "provider", model: "model" })).toEqual({
			provider: "provider",
			model: "model"
		})
		expect(successfulTurnTuple({ role: "assistant", stopReason: "error", provider: "provider", model: "model" })).toBeUndefined()
		expect(successfulTurnTuple({ role: "assistant", stopReason: "aborted", provider: "provider", model: "model" })).toBeUndefined()
		expect(successfulTurnTuple({ role: "assistant", stopReason: "length", provider: "provider", model: "model" })).toBeUndefined()
		expect(successfulTurnTuple({ role: "user", provider: "provider", model: "model" })).toBeUndefined()
		expect(successfulTurnTuple({ role: "assistant", stopReason: "stop" })).toBeUndefined()
	})
})

test("active task rows stay compact", () => {
	const rows = renderActiveTaskRows(
		Array.from({ length: 7 }, (_, index) => ({
			id: `a_0000000${index}`,
			label: `Task ${index}`,
			state: index % 2 ? "running" : "queued",
			queuedFollowUps: index
		}))
	)
	expect(rows).toHaveLength(6)
	expect(rows[0]).toBe("↳ a_00000000 queued Task 0")
	expect(rows[1]).toContain("(+1)")
	expect(rows.at(-1)).toBe("  … 2 more active")
})

function branch(stopReason: string): SessionEntry[] {
	return [
		{ type: "message", message: { role: "assistant", stopReason } },
		{ type: "custom", customType: "later", data: {} }
	] as SessionEntry[]
}
