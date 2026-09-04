import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent"
import { type AgentCreationResult, registerAgentTool } from "../../extensions/lovely-agents/agent.js"
import type { ChildSessionHandle, CreateChildSessionOptions } from "../../extensions/lovely-agents/child-session.js"
import type { AgentsConfig } from "../../extensions/lovely-agents/config.js"
import { getAgentCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import {
	parentStoragePaths,
	readRetainedOutput,
	readTaskMetadata,
	releaseParentLeaseFor,
	taskStoragePaths
} from "../../extensions/lovely-agents/state.js"
import { definitionSource, withTempWorkspace } from "./test-helpers.js"

const selectedModel = model("anthropic", "sonnet")
const config: AgentsConfig = {
	models: [],
	maxConcurrency: 2,
	maxDepth: 2,
	waitMs: 1_000,
	expandPromptTemplates: false
}

describe("agent tool", () => {
	test("accepts and returns a synchronously completed initial run", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => {
				child.tool("read", { path: "README.md" }, { content: "file" })
				child.assistant("Completed review")
			})
			const tool = captureAgentTool(workspace.agentDir, fake.handle)
			const result = await tool.execute(
				"create",
				{ definition: "reviewer", label: "Review", prompt: "Inspect this change" },
				undefined,
				taskContext(workspace.cwd)
			)
			const details = result.details as AgentCreationResult
			expect(details).toMatchObject({
				label: "Review",
				definition: "reviewer",
				state: "idle",
				latestOutcome: "succeeded",
				detached: false
			})
			expect(details.output.text).toContain("Completed review")
			expect(await readFile(resolve(workspace.cwd, details.output.paths.activity), "utf8")).toContain("## read")
			expect(fake.prompts).toEqual([{ text: "Inspect this change", expandPromptTemplates: false }])
			expect(fake.disposed).toBe(true)
			expect(getAgentCoordinator().residentCount).toBe(0)
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("detaches immediately without stopping or restarting the accepted run", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const finish = deferred<void>()
			const fake = fakeChild(async child => {
				await finish.promise
				child.assistant("Detached completion")
			})
			const tool = captureAgentTool(workspace.agentDir, fake.handle)
			const abort = new AbortController()
			const result = await tool.execute(
				"create",
				{ definition: "reviewer", label: "Long review", prompt: "Inspect slowly", waitMs: 0 },
				abort.signal,
				taskContext(workspace.cwd)
			)
			const details = result.details as AgentCreationResult
			expect(details.detached).toBe(true)
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), details.id)
			const active = await readTaskMetadata(paths)
			expect(active.status).toBe("ok")
			if (active.status !== "ok") throw new Error("Accepted task metadata is invalid")
			expect(active.metadata.activeRun?.detachedAt).toBeNumber()

			abort.abort()
			finish.resolve(undefined)
			expect(await waitForOutcome(paths, details.output.nextOffset)).toBe("succeeded")
			expect(fake.prompts).toHaveLength(1)
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("records accepted child failures as task outcomes", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async () => {
				throw new Error("provider failed")
			})
			const tool = captureAgentTool(workspace.agentDir, fake.handle)
			const result = await tool.execute(
				"create",
				{ definition: "reviewer", label: "Failing review", prompt: "Inspect" },
				undefined,
				taskContext(workspace.cwd)
			)
			expect(result.details).toMatchObject({ state: "idle", latestOutcome: "failed", detached: false })
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("stops accepted synchronous work when the caller aborts", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => {
				await child.aborted
				throw new Error("aborted")
			})
			const tool = captureAgentTool(workspace.agentDir, fake.handle)
			const abort = new AbortController()
			const execution = tool.execute(
				"create",
				{ definition: "reviewer", label: "Cancelled review", prompt: "Inspect" },
				abort.signal,
				taskContext(workspace.cwd)
			)
			while (fake.prompts.length === 0) await Bun.sleep(1)
			abort.abort()
			const result = await execution
			expect(result.details).toMatchObject({ state: "idle", latestOutcome: "stopped", detached: false })
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("detaches when accepted work remains queued past its wait deadline", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const coordinator = getAgentCoordinator()
			coordinator.setMaxConcurrency(1)
			const blocker = await coordinator.acquire({ tuple: { provider: "other", model: "busy" } })
			const fake = fakeChild(async child => {
				child.assistant("Queued completion")
			})
			const tool = captureAgentTool(workspace.agentDir, fake.handle, { ...config, maxConcurrency: 1 })
			try {
				const result = await tool.execute(
					"create",
					{ definition: "reviewer", label: "Queued review", prompt: "Inspect", waitMs: 1 },
					undefined,
					taskContext(workspace.cwd)
				)
				const details = result.details as AgentCreationResult
				expect(details).toMatchObject({ state: "queued", detached: true })
				blocker.release()
				const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), details.id)
				expect(await waitForOutcome(paths, details.output.nextOffset)).toBe("succeeded")
			} finally {
				blocker.release()
				coordinator.setMaxConcurrency(2)
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})
})

type CapturedAgentTool = {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>
}

function captureAgentTool(agentDir: string, child: ChildSessionHandle, toolConfig: AgentsConfig = config): CapturedAgentTool {
	let captured: CapturedAgentTool | undefined
	const api = {
		registerTool(tool: { execute: (...args: unknown[]) => unknown }) {
			captured = {
				execute: (toolCallId, params, signal, ctx) =>
					tool.execute(toolCallId, params, signal, undefined, ctx) as ReturnType<CapturedAgentTool["execute"]>
			}
		},
		getAllTools() {
			return [{ name: "read" }, { name: "agent" }]
		}
	} as unknown as ExtensionAPI
	registerAgentTool(api, {
		getConfig: () => toolConfig,
		getAgentDir: () => agentDir,
		createChild: async (_options: CreateChildSessionOptions) => child
	})
	if (!captured) throw new Error("agent tool was not registered")
	return captured
}

function taskContext(cwd: string): ExtensionContext {
	return {
		cwd,
		model: selectedModel,
		thinkingLevel: "medium",
		modelRegistry: {
			getAvailable: () => [selectedModel],
			getAll: () => [selectedModel]
		},
		sessionManager: { getSessionId: () => "parent-session" },
		isProjectTrusted: () => true
	} as unknown as ExtensionContext
}

type FakeChild = {
	handle: ChildSessionHandle
	prompts: Array<{ text: string; expandPromptTemplates: boolean | undefined }>
	readonly disposed: boolean
	readonly aborted: Promise<void>
	assistant(text: string): void
	tool(name: string, args: unknown, resultValue: unknown): void
}

function fakeChild(runPrompt: (child: FakeChild) => Promise<void>): FakeChild {
	const listeners = new Set<(event: AgentSessionEvent) => void>()
	const messages: Array<{ role: "assistant"; content: Array<{ type: "text"; text: string }>; stopReason: "stop" }> = []
	const aborted = deferred<void>()
	let disposed = false
	const result: FakeChild = {
		prompts: [],
		aborted: aborted.promise,
		get disposed() {
			return disposed
		},
		assistant(text: string) {
			const message = { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason: "stop" as const }
			messages.push(message)
			for (const listener of listeners) listener({ type: "message_end", message } as unknown as AgentSessionEvent)
		},
		tool(name: string, args: unknown, resultValue: unknown) {
			for (const listener of listeners) {
				listener({ type: "tool_execution_start", toolCallId: "tool-1", toolName: name, args } as AgentSessionEvent)
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: name,
					result: resultValue,
					isError: false
				} as AgentSessionEvent)
			}
		},
		handle: {
			session: {
				sessionId: "child-session",
				model: selectedModel,
				thinkingLevel: "medium",
				messages,
				async prompt(text: string, options?: { expandPromptTemplates?: boolean }) {
					result.prompts.push({ text, expandPromptTemplates: options?.expandPromptTemplates })
					await runPrompt(result)
				},
				async abort() {
					aborted.resolve(undefined)
				},
				subscribe(listener: (event: AgentSessionEvent) => void) {
					listeners.add(listener)
					return () => listeners.delete(listener)
				}
			},
			extensionsResult: { extensions: [], errors: [] },
			depth: 1,
			allowAgents: false,
			dispose() {
				disposed = true
			}
		} as unknown as ChildSessionHandle
	}
	return result
}

function model(provider: string, id: string): ScopedModel["model"] {
	return { provider, id, name: id } as ScopedModel["model"]
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>(resolvePromise => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

async function waitForOutcome(paths: ReturnType<typeof taskStoragePaths>, offset: number): Promise<string | null> {
	let nextOffset = offset
	for (let attempt = 0; attempt < 6; attempt++) {
		const loaded = await readTaskMetadata(paths)
		if (loaded.status === "ok" && loaded.metadata.latestOutcome) return loaded.metadata.latestOutcome
		const output = await readRetainedOutput(paths, { offset: nextOffset, waitMs: 2_000 })
		nextOffset = output.nextOffset
	}
	return null
}
