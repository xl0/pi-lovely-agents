import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
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
import { NOTIFICATION_CUSTOM_TYPE, notificationRouteKey } from "../../extensions/lovely-agents/notifications.js"
import { ensureParentStorage, mutateTaskMetadata, releaseParentLeaseFor, taskStoragePaths } from "../../extensions/lovely-agents/state.js"
import { publishSchedulerUpdate, publishTaskUpdate } from "../../extensions/lovely-agents/updates.js"
import { withTempWorkspace } from "./test-helpers.js"

test("lease conflicts show a persistent warning without recovering, notifying, or stopping foreign tasks", async () => {
	await withTempWorkspace(async workspace => {
		const [id] = await seedFixtureTasks(workspace.cwd, "parent")
		if (!id) throw new Error("Missing fixture task")
		const parent = await ensureParentStorage(workspace.cwd, "parent")
		const paths = taskStoragePaths(parent, id)
		await mutateTaskMetadata(paths, metadata => ({
			...metadata,
			notifications: ["seen", "pending"].map(id => ({
				id,
				type: "completion",
				runId: "r_0000000000000001",
				content: "Foreign completion",
				createdAt: Date.now()
			}))
		}))
		await releaseParentLeaseFor(workspace.cwd, "parent")
		const lease = JSON.stringify({ version: 1, pid: process.ppid, token: "e".repeat(32), createdAt: Date.now() })
		await writeFile(parent.lease, lease, { mode: 0o600 })
		const originalMetadata = await readFile(paths.metadata, "utf8")
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>()
		const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>()
		const errors: string[] = []
		const messages: unknown[] = []
		let active = ["read", "other_tool", "agent", "bash_bg", "task_list", "task_output"]
		let status: string | undefined
		let sessionId = "parent"
		lovelyAgentsExtension({
			registerMessageRenderer() {},
			registerTool() {},
			registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
				commands.set(name, command.handler)
			},
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => {
				active = names
			},
			on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler])
			},
			sendMessage: (message: unknown) => messages.push(message)
		} as unknown as ExtensionAPI)
		const ctx = {
			cwd: workspace.cwd,
			isProjectTrusted: () => true,
			mode: "tui",
			modelRegistry: { getAvailable: () => [] },
			sessionManager: {
				getSessionId: () => sessionId,
				getBranch: () => [{ type: "custom_message", customType: NOTIFICATION_CUSTOM_TYPE, details: { notificationId: "seen" } }]
			},
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setStatus: (_key: string, value: string | undefined) => {
					status = value
				},
				setWidget() {},
				getEditorComponent: () => undefined,
				setEditorComponent() {},
				notify: (message: string) => errors.push(message)
			}
		} as unknown as ExtensionContext
		const emit = async (name: string, event: unknown) => {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx)
		}
		const agentDirVariable = "PI_CODING_AGENT_DIR"
		const previousAgentDir = process.env[agentDirVariable]
		process.env[agentDirVariable] = workspace.agentDir
		try {
			await emit("session_start", { reason: "startup" })
			expect(status).toContain(`Session in use by PID ${process.ppid}`)
			expect(status).toContain("/resume")
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain("Lovely Agents is disabled")
			expect(active).toEqual(["read", "other_tool"])
			expect(getAgentCoordinator().getNotificationRoute(notificationRouteKey(workspace.cwd, "parent"))).toBeUndefined()
			publishSchedulerUpdate()
			publishTaskUpdate(workspace.cwd, "parent")
			await Bun.sleep(0)
			expect(errors).toHaveLength(1)
			expect(status).toContain("/resume")
			await emit("message_end", {
				message: { role: "custom", customType: NOTIFICATION_CUSTOM_TYPE, details: { notificationId: "pending", taskRef: id } }
			})
			await commands.get("continue")?.("", ctx)
			await commands.get("lovely-agents")?.("", ctx)
			await emit("session_shutdown", { reason: "reload" })
			expect(status).toBeUndefined()
			expect(active).toContain("agent")
			await emit("session_start", { reason: "reload" })
			await emit("session_shutdown", { reason: "resume" })
			expect(messages).toEqual([])
			expect(await readFile(paths.metadata, "utf8")).toBe(originalMetadata)
			expect(await readFile(parent.lease, "utf8")).toBe(lease)

			// A different session in the same workspace is unaffected, including its tool allowlist.
			sessionId = "independent"
			active = ["read", "other_tool", "agent", "bash_bg", "task_list", "task_output"]
			await emit("session_start", { reason: "reload" })
			expect(status).toBeUndefined()
			expect(active).toContain("agent")
			expect(active).not.toContain("task_stop")
			await emit("session_shutdown", { reason: "quit" })
			expect(await readFile(paths.metadata, "utf8")).toBe(originalMetadata)
			expect(await readFile(parent.lease, "utf8")).toBe(lease)
		} finally {
			if (previousAgentDir === undefined) delete process.env[agentDirVariable]
			else process.env[agentDirVariable] = previousAgentDir
			await emit("session_shutdown", { reason: "quit" })
		}
	})
})

test("capability schemas and tool visibility follow config without hiding controls for retained tasks", async () => {
	await withTempWorkspace(async workspace => {
		await workspace.write("workspace/.pi/xl0-pi-lovely-agents.json", JSON.stringify({ backgroundAgents: false, backgroundBash: false }))
		// A trust-requiring resource: Pi evaluated trust, so its answer covers the workspace config.
		await workspace.write("workspace/.pi/settings.json", "{}")
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
			isProjectTrusted: () => true,
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
		await workspace.write("workspace/.pi/settings.json", "{}")
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
			isProjectTrusted: () => true,
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

function branch(stopReason: string): SessionEntry[] {
	return [
		{ type: "message", message: { role: "assistant", stopReason } },
		{ type: "custom", customType: "later", data: {} }
	] as SessionEntry[]
}
