import { describe, expect, test } from "bun:test"
import { readFile, unlink } from "node:fs/promises"
import { resolve } from "node:path"
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent"
import type { TSchema } from "typebox"
import { Value } from "typebox/value"
import {
	type AgentCreationResult,
	registerAgentTool,
	registerTaskInputTool,
	sendTaskInput,
	type TaskInputResult
} from "../../extensions/lovely-agents/agent.js"
import type { ChildSessionHandle, CreateChildSessionOptions } from "../../extensions/lovely-agents/child-session.js"
import { type AgentsConfig, defaultAgentsConfig } from "../../extensions/lovely-agents/config.js"
import { getAgentCoordinator, type ResidentInputOptions } from "../../extensions/lovely-agents/coordinator.js"
import {
	ensureParentStorage,
	initializeRetainedLogs,
	mutateTaskMetadata,
	parentStoragePaths,
	readRetainedOutput,
	readTaskMetadata,
	releaseParentLeaseFor,
	reserveTaskStorage,
	taskStoragePaths,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import { loadTaskList } from "../../extensions/lovely-agents/tools.js"
import { definitionSource, withTempWorkspace } from "./test-helpers.js"

const selectedModel = model("anthropic", "sonnet")
const config: AgentsConfig = {
	...defaultAgentsConfig,
	models: [],
	maxConcurrency: 2,
	maxDepth: 2,
	waitMs: 1_000,
	expandPromptTemplates: false
}

describe("agent tool", () => {
	test("resolves aliases before creation and retains the concrete model across later alias edits", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const first = fakeChild(async child => child.assistant("first"))
			const second = fakeChild(async child => child.assistant("second"))
			const children = [first.handle, second.handle]
			const received: CreateChildSessionOptions[] = []
			const currentConfig = { ...config, fastModel: "anthropic/sonnet" }
			const tools = captureAgentTools(
				workspace.agentDir,
				async options => {
					received.push(options)
					const child = children.shift()
					if (!child) throw new Error("Unexpected child creation")
					return child
				},
				currentConfig
			)
			try {
				const created = await tools.agent.execute(
					"create",
					{ definition: "reviewer", label: "Alias", prompt: "initial", model: "fast" },
					undefined,
					taskContext(workspace.cwd)
				)
				const id = (created.details as AgentCreationResult).id
				const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
				expect(received[0]?.selection).toEqual({ model: selectedModel, thinking: "low" })
				const saved = await readTaskMetadata(paths)
				if (saved.status !== "ok" || saved.metadata.kind !== "agent") throw new Error("Invalid saved agent")
				expect(saved.metadata.model).toEqual({ provider: "anthropic", id: "sonnet" })
				while (!first.disposed) await Bun.sleep(1)
				currentConfig.fastModel = "unavailable/model"
				currentConfig.fastThinking = "max"
				await tools.input.execute("follow", { id, content: "again" }, undefined, taskContext(workspace.cwd))
				await waitForRunCount(paths, 2)
				expect(received[1]?.selection).toEqual({ model: selectedModel, thinking: saved.metadata.thinking })
				await expect(
					tools.agent.execute(
						"unavailable",
						{ definition: "reviewer", label: "Alias", prompt: "new", model: "fast" },
						undefined,
						taskContext(workspace.cwd)
					)
				).rejects.toThrow('Model alias "fast" is not configured or its model is unavailable')
				expect(received).toHaveLength(2)
			} finally {
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})

	test("accepts and returns a synchronously completed initial run", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => {
				child.systemPrompt = "Changed after agent_start"
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
				queuedFollowUps: 0,
				detached: false
			})
			expect(details.output.text).toBe("Completed review")
			expect(result.content[0]?.text).not.toContain("tasks:")
			expect(await readFile(resolve(workspace.cwd, details.output.paths.history), "utf8")).toContain("<tool read ok>")
			expect(fake.prompts).toEqual([{ text: "Inspect this change", expandPromptTemplates: false }])
			while (!fake.disposed) await Bun.sleep(1)
			expect(fake.disposed).toBe(true)
			expect(getAgentCoordinator().residentCount).toBe(0)
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), details.id)
			const metadata = await readTaskMetadata(paths)
			expect(metadata.status === "ok" ? metadata.metadata.notifications : null).toEqual([])
			expect(metadata.status === "ok" && metadata.metadata.kind === "agent" ? metadata.metadata.effectiveSystemPrompt : null).toBe(
				"Effective fixture prompt"
			)
			expect(JSON.stringify(result)).not.toContain("Effective fixture prompt")
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("retains streaming snapshots, replacing prior messages without exposing inputs or tools", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const finishReply = deferred<void>()
			const finishRun = deferred<void>()
			const fake = fakeChild(async child => {
				child.assistant("Preamble")
				child.tool("read", { path: "secret-input" }, { content: "tool result" })
				child.assistant("", "message_start")
				child.assistant("Draft", "message_update")
				await finishReply.promise
				child.assistant("Final answer")
				await finishRun.promise
			})
			const tool = captureAgentTool(workspace.agentDir, fake.handle)
			const result = await tool.execute(
				"create",
				{
					definition: "reviewer",
					label: "Streaming",
					prompt: "Private input",
					waitMs: 0
				},
				undefined,
				taskContext(workspace.cwd)
			)
			const { id } = result.details as AgentCreationResult
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
			try {
				let partial = await readRetainedOutput(paths)
				for (let attempt = 0; attempt < 20 && partial.text !== "Draft"; attempt++) {
					partial = await readRetainedOutput(paths, { waitMs: 50 })
				}
				expect(partial).toMatchObject({
					text: "Draft",
					streaming: true,
					state: "running",
					latestOutcome: null,
					lastActivity: { action: "responding" }
				})
				finishReply.resolve(undefined)
				let final = await readRetainedOutput(paths)
				for (let attempt = 0; attempt < 20 && final.streaming; attempt++) {
					final = await readRetainedOutput(paths, { waitMs: 50 })
				}
				expect(final).toMatchObject({
					text: "Final answer",
					streaming: false,
					state: "running",
					latestOutcome: null,
					lastActivity: { action: "reply complete" }
				})
			} finally {
				finishReply.resolve(undefined)
				finishRun.resolve(undefined)
				await waitForOutcome(paths)
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
			const history = await readFile(paths.history, "utf8")
			expect(history).toContain("Private input")
			expect(history).toContain("<agent>\nPreamble")
			expect(history).toContain("<tool read ok>")
			expect(history).toContain("<agent>\nFinal answer")
			expect(history).not.toContain("Draft")
		})
	})

	test("reports thinking and tool activity without leaking reasoning or tool payloads", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const allowTool = deferred<void>()
			const finish = deferred<void>()
			const fake = fakeChild(async child => {
				child.assistant("", "message_start")
				for (let i = 0; i < 20; i++) child.thinking("private reasoning")
				await allowTool.promise
				child.assistant("")
				child.tool("read", { path: "private-path" }, { content: "private-result" })
				await finish.promise
				child.assistant("Done")
			})
			const tool = captureAgentTool(workspace.agentDir, fake.handle)
			const result = await tool.execute(
				"create",
				{ definition: "reviewer", label: "Activity", prompt: "Inspect", waitMs: 0 },
				undefined,
				taskContext(workspace.cwd)
			)
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), (result.details as AgentCreationResult).id)
			try {
				let output = await readRetainedOutput(paths)
				for (let attempt = 0; attempt < 20 && output.lastActivity?.action !== "thinking"; attempt++) {
					output = await readRetainedOutput(paths, { waitMs: 50 })
				}
				expect(output).toMatchObject({ text: "", lastActivity: { action: "thinking" }, state: "running" })
				allowTool.resolve(undefined)
				for (let attempt = 0; attempt < 20 && output.lastActivity?.action !== "tool read complete"; attempt++) {
					output = await readRetainedOutput(paths, { waitMs: 50 })
				}
				expect(output).toMatchObject({ text: "", lastActivity: { action: "tool read complete" }, state: "running" })
				expect(await readFile(paths.metadata, "utf8")).not.toContain("private")
			} finally {
				allowTool.resolve(undefined)
				finish.resolve(undefined)
				await waitForOutcome(paths)
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
			expect(await readFile(paths.history, "utf8")).not.toContain("private reasoning")
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
			expect(await waitForOutcome(paths)).toBe("succeeded")
			expect(fake.prompts).toHaveLength(1)
			const completed = await readTaskMetadata(paths)
			const notifications = completed.status === "ok" ? completed.metadata.notifications : []
			expect(notifications).toHaveLength(1)
			expect(notifications[0]).toMatchObject({ id: `${details.id}:${active.metadata.activeRun?.id}:completion`, type: "completion" })
			expect(notifications[0]?.deliveredAt).toBeUndefined()
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
			const blocker = await coordinator.acquire({})
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
				expect(details.output).toMatchObject({ queueReason: "capacity", capacity: { active: 1, limit: 1 } })
				expect(result.content[0]?.text).toContain("waiting: capacity (1/1 execution permits)")
				blocker.release()
				const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), details.id)
				expect(await waitForOutcome(paths)).toBe("succeeded")
			} finally {
				blocker.release()
				coordinator.setMaxConcurrency(2)
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})
})

describe("task_input tool", () => {
	test("dispatches omitted delivery to live Bash stdin, preserves literal bytes and EOF after disabling creation", async () => {
		await withTempWorkspace(async workspace => {
			const paths = await reserveTaskStorage(await ensureParentStorage(workspace.cwd, "parent-session"), () => "b_12345678")
			await initializeRetainedLogs(paths)
			await writeTaskMetadata(paths, {
				version: 3,
				kind: "bash",
				taskRef: paths.taskRef,
				parentSessionId: "parent-session",
				label: "Input",
				command: "cat",
				cwd: workspace.cwd,
				exitCode: null,
				signal: null,
				state: "running",
				latestOutcome: null,
				latestReply: null,
				lastRunSequence: 1,
				activeRun: {
					id: "r_1111111111111111",
					sequence: 1,
					kind: "initial",
					state: "running",
					input: "cat",
					acceptedAt: 1,
					startedAt: 1
				},
				queuedFollowUps: [],
				notifications: [],
				discardedAt: null,
				createdAt: 1,
				updatedAt: 1
			})
			const currentConfig = { ...config, backgroundBash: false }
			const noColdLoad = async () => {
				throw new Error("Must not cold-load Bash")
			}
			const tools = captureAgentTools(workspace.agentDir, noColdLoad, currentConfig)
			expect(Value.Check(tools.input.parameters, { id: paths.taskRef, content: "", eof: true })).toBe(true)
			const ctx = taskContext(workspace.cwd)
			await expect(tools.input.execute("cold", { id: paths.taskRef, content: "x" }, undefined, ctx)).rejects.toThrow(
				"live running resident"
			)
			const delivered: Array<{ content: string; delivery: string; options: ResidentInputOptions | undefined }> = []
			const unbind = getAgentCoordinator().bindResident(paths.taskDirectory, {
				stop() {},
				dispose() {},
				async input(content, delivery, options) {
					delivered.push({ content, delivery, options })
					return { run: 1, delivery: "stdin", queuePosition: null, queuedFollowUps: 0 }
				}
			})
			try {
				const literal = `  /template \${HOME}\n`
				const result = await tools.input.execute("stdin", { id: paths.taskRef, content: literal }, undefined, ctx)
				expect(result.details).toMatchObject({ effectiveDelivery: "stdin", queuePosition: null, queuedFollowUps: 0 })
				expect(delivered[0]).toMatchObject({ content: literal, delivery: "stdin" })
				expect(result.content[0]?.text).toContain("stdin delivered")
				await tools.input.execute("eof", { id: paths.taskRef, content: "", eof: true }, undefined, ctx)
				expect(delivered[1]).toMatchObject({ content: "", delivery: "stdin", options: { eof: true } })
				// The successful runtime write owns history; the shared sender must not duplicate it.
				expect(await readFile(paths.history, "utf8")).toBe("")
				await sendTaskInput(ctx, { getConfig: () => currentConfig }, paths.taskRef, "🙂".repeat(16384), undefined)
				expect(delivered).toHaveLength(3)
				for (const params of [
					{ content: "x", delivery: "followup" },
					{ content: "x", delivery: "steer" },
					{ content: "", eof: false },
					{ content: "" },
					{ content: "🙂".repeat(16385) }
				]) {
					await expect(tools.input.execute("invalid", { id: paths.taskRef, ...params }, undefined, ctx)).rejects.toThrow()
				}
				await expect(
					tools.input.execute("foreign", { id: paths.taskRef, content: "x" }, undefined, {
						...ctx,
						sessionManager: { getSessionId: () => "foreign" }
					} as ExtensionContext)
				).rejects.toThrow("Unknown Task Reference")
				for (const state of ["queued", "idle", "interrupted"] as const) {
					await mutateTaskMetadata(paths, metadata => ({
						...metadata,
						state,
						activeRun: state === "queued" && metadata.activeRun ? { ...metadata.activeRun, state } : null
					}))
					await expect(tools.input.execute("not-running", { id: paths.taskRef, content: "x" }, undefined, ctx)).rejects.toThrow(
						"live running resident"
					)
				}
				expect(delivered).toHaveLength(3)
			} finally {
				unbind()
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
				await releaseParentLeaseFor(workspace.cwd, "foreign")
			}
		})
	})

	test("runs accepted Follow-ups sequentially in the same resident session", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const releaseInitial = deferred<void>()
			const fake = fakeChild(async child => {
				if (child.prompts.length === 1) await releaseInitial.promise
				child.assistant(`reply ${child.prompts.length}`)
			})
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle)
			const created = await tools.agent.execute(
				"create",
				{ definition: "reviewer", label: "Review", prompt: "initial", waitMs: 0 },
				undefined,
				taskContext(workspace.cwd)
			)
			const id = (created.details as AgentCreationResult).id
			const first = await tools.input.execute("input-1", { id, content: "follow one" }, undefined, taskContext(workspace.cwd))
			const second = await tools.input.execute(
				"input-2",
				{ id, content: "follow two", delivery: "followup" },
				undefined,
				taskContext(workspace.cwd)
			)
			expect(first.details).toMatchObject({ run: 2, effectiveDelivery: "followup", queuePosition: 1, queuedFollowUps: 1 })
			expect(second.details).toMatchObject({ run: 3, effectiveDelivery: "followup", queuePosition: 2, queuedFollowUps: 2 })
			const acceptedPaths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
			expect(await readRetainedOutput(acceptedPaths, { run: 2 })).toMatchObject({ run: 2, state: "queued", text: "" })
			const waitForSecond = readRetainedOutput(acceptedPaths, { run: 2, waitMs: 1_000 })
			const accepted = await readTaskMetadata(acceptedPaths)
			if (accepted.status !== "ok") throw new Error("Accepted task metadata is invalid")
			const acceptanceOrders = [
				accepted.metadata.activeRun?.acceptanceOrder,
				...accepted.metadata.queuedFollowUps.map(followUp => followUp.acceptanceOrder)
			]
			expect(
				acceptanceOrders.every((order, index) => typeof order === "number" && (index === 0 || order > (acceptanceOrders[index - 1] ?? 0)))
			).toBe(true)

			releaseInitial.resolve(undefined)
			const paths = acceptedPaths
			await waitForRunCount(paths, 3)
			expect(await waitForSecond).toMatchObject({ run: 2, state: "idle", text: "reply 2", latestOutcome: "succeeded" })
			for (const run of [1, 2, 3]) {
				expect(await readRetainedOutput(paths, { run })).toMatchObject({ run, text: `reply ${run}`, latestOutcome: "succeeded" })
			}
			expect(fake.prompts.map(prompt => prompt.text)).toEqual(["initial", "follow one", "follow two"])
			const output = await readFile(paths.history, "utf8")
			expect(output).toContain("<run 2 followup>")
			expect(output).toContain("<user>\nfollow one")
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("records a failed Follow-up independently from an earlier successful reply", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const releaseInitial = deferred<void>()
			const fake = fakeChild(async child => {
				if (child.prompts.length === 1) {
					await releaseInitial.promise
					child.assistant("initial success")
					return
				}
				throw new Error("follow-up failed")
			})
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle)
			const created = await tools.agent.execute(
				"create",
				{ definition: "reviewer", label: "Review", prompt: "initial", waitMs: 0 },
				undefined,
				taskContext(workspace.cwd)
			)
			const id = (created.details as AgentCreationResult).id
			await tools.input.execute("follow", { id, content: "failing follow-up" }, undefined, taskContext(workspace.cwd))
			releaseInitial.resolve(undefined)
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
			await waitForRunCount(paths, 2)
			const loaded = await readTaskMetadata(paths)
			expect(loaded.status === "ok" ? loaded.metadata.latestOutcome : null).toBe("failed")
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("delivers a running Steer without creating another run", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const finish = deferred<void>()
			const fake = fakeChild(async child => {
				await finish.promise
				child.assistant("steered reply")
			})
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle)
			const created = await tools.agent.execute(
				"create",
				{ definition: "reviewer", label: "Review", prompt: "initial", waitMs: 0 },
				undefined,
				taskContext(workspace.cwd)
			)
			const id = (created.details as AgentCreationResult).id
			while (!fake.streaming) await Bun.sleep(1)
			const input = await tools.input.execute(
				"steer",
				{ id, content: "change direction", delivery: "steer" },
				undefined,
				taskContext(workspace.cwd)
			)
			expect(input.details).toMatchObject({
				effectiveDelivery: "steer",
				queuePosition: null,
				queuedFollowUps: 0
			} satisfies Partial<TaskInputResult>)
			expect(input.content[0]?.text.split("\n")).toHaveLength(1)
			expect(fake.steers).toEqual(["change direction"])
			expect(fake.steerExpansions).toEqual([false])
			finish.resolve(undefined)
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
			await waitForRunCount(paths, 1)
			expect(await readFile(paths.history, "utf8")).toContain("<steer>\nchange direction")
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("correlates multiple duplicate Steers after the primary run input", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const finish = deferred<void>()
			const fake = fakeChild(async child => {
				await finish.promise
				child.assistant("steered reply")
			})
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle)
			const created = await tools.agent.execute(
				"create",
				{ definition: "reviewer", label: "Review", prompt: "primary input", waitMs: 0 },
				undefined,
				taskContext(workspace.cwd)
			)
			const id = (created.details as AgentCreationResult).id
			while (!fake.streaming) await Bun.sleep(1)
			await Promise.all(
				["same steer", "same steer"].map((content, index) =>
					tools.input.execute(`steer-${index}`, { id, content, delivery: "steer" }, undefined, taskContext(workspace.cwd))
				)
			)
			finish.resolve(undefined)
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
			await waitForRunCount(paths, 1)
			const output = await readFile(paths.history, "utf8")
			expect(output.match(/<steer>/g)).toHaveLength(2)
			expect(output.match(/same steer/g)).toHaveLength(2)
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("cold-loads an idle session for a Follow-up", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const first = fakeChild(async child => child.assistant("initial reply"))
			const second = fakeChild(async child => child.assistant("cold reply"))
			const children = [first.handle, second.handle]
			const opened: CreateChildSessionOptions[] = []
			const tools = captureAgentTools(workspace.agentDir, async options => {
				opened.push(options)
				const child = children.shift()
				if (!child) throw new Error("unexpected child creation")
				return child
			})
			const created = await tools.agent.execute(
				"create",
				{ definition: "reviewer", label: "Review", prompt: "initial" },
				undefined,
				taskContext(workspace.cwd)
			)
			const id = (created.details as AgentCreationResult).id
			await unlink(resolve(workspace.agentDir, "agents/reviewer.md"))
			const input = await tools.input.execute("follow", { id, content: "cold follow-up" }, undefined, taskContext(workspace.cwd))
			expect(input.details).toMatchObject({ effectiveDelivery: "followup", queuePosition: 1 })
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
			await waitForRunCount(paths, 2)
			expect(second.prompts.map(prompt => prompt.text)).toEqual(["cold follow-up"])
			expect(opened[1]?.definition.systemPrompt).toBe("System prompt for reviewer.")
			while (!second.disposed) await Bun.sleep(1)
			expect(second.disposed).toBe(true)
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("falls back to a cold Follow-up when completion beats a requested Steer", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const first = fakeChild(async child => child.assistant("initial reply"))
			const second = fakeChild(async child => child.assistant("follow-up reply"))
			const children = [first.handle, second.handle]
			const tools = captureAgentTools(workspace.agentDir, async () => {
				const child = children.shift()
				if (!child) throw new Error("unexpected child creation")
				return child
			})
			const created = await tools.agent.execute(
				"create",
				{ definition: "reviewer", label: "Review", prompt: "initial" },
				undefined,
				taskContext(workspace.cwd)
			)
			const id = (created.details as AgentCreationResult).id
			const input = await tools.input.execute(
				"steer",
				{ id, content: "too late to steer", delivery: "steer" },
				undefined,
				taskContext(workspace.cwd)
			)
			expect(input.details).toMatchObject({ requestedDelivery: "steer", effectiveDelivery: "followup", queuePosition: 1 })
			await waitForRunCount(taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id), 2)
			expect(second.prompts.map(prompt => prompt.text)).toEqual(["too late to steer"])
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("falls back from Steer while queued and reports the Follow-up position", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const coordinator = getAgentCoordinator()
			coordinator.setMaxConcurrency(1)
			const blocker = await coordinator.acquire({})
			const fake = fakeChild(async child => child.assistant(`reply ${child.prompts.length}`))
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle, { ...config, maxConcurrency: 1 })
			try {
				const created = await tools.agent.execute(
					"create",
					{ definition: "reviewer", label: "Review", prompt: "initial", waitMs: 0 },
					undefined,
					taskContext(workspace.cwd)
				)
				const id = (created.details as AgentCreationResult).id
				const input = await tools.input.execute(
					"steer",
					{ id, content: "queued redirect", delivery: "steer" },
					undefined,
					taskContext(workspace.cwd)
				)
				expect(input.details).toMatchObject({
					run: 2,
					requestedDelivery: "steer",
					effectiveDelivery: "followup",
					conversionReason: expect.stringContaining("queued"),
					queuePosition: 1,
					queuedFollowUps: 1
				})
				blocker.release()
				await waitForRunCount(taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id), 2)
				expect(fake.prompts.map(prompt => prompt.text)).toEqual(["initial", "queued redirect"])
			} finally {
				blocker.release()
				coordinator.setMaxConcurrency(2)
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})

	test("accepts a cold Follow-up from interrupted state", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const first = fakeChild(async child => child.assistant("initial reply"))
			const second = fakeChild(async child => child.assistant("recovered reply"))
			const children = [first.handle, second.handle]
			const tools = captureAgentTools(workspace.agentDir, async () => {
				const child = children.shift()
				if (!child) throw new Error("unexpected child creation")
				return child
			})
			const created = await tools.agent.execute(
				"create",
				{ definition: "reviewer", label: "Review", prompt: "initial" },
				undefined,
				taskContext(workspace.cwd)
			)
			const id = (created.details as AgentCreationResult).id
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				state: "interrupted",
				latestOutcome: "interrupted",
				activeRun: null,
				updatedAt: Date.now()
			}))
			const input = await tools.input.execute("follow", { id, content: "resume explicitly" }, undefined, taskContext(workspace.cwd))
			expect(input.details).toMatchObject({ effectiveDelivery: "followup", queuePosition: 1 })
			await waitForRunCount(paths, 2)
			expect(second.prompts.map(prompt => prompt.text)).toEqual(["resume explicitly"])
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("drops an undelivered Steer from retained output when stopped", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => {
				await child.aborted
				throw new Error("aborted")
			}, false)
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle)
			const created = await tools.agent.execute(
				"create",
				{ definition: "reviewer", label: "Review", prompt: "initial", waitMs: 0 },
				undefined,
				taskContext(workspace.cwd)
			)
			const id = (created.details as AgentCreationResult).id
			while (!fake.streaming) await Bun.sleep(1)
			await tools.input.execute("steer", { id, content: "never delivered", delivery: "steer" }, undefined, taskContext(workspace.cwd))
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
			await getAgentCoordinator().getResident(paths.taskDirectory)?.stop()
			expect(await readFile(paths.history, "utf8")).not.toContain("<steer>")
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("enforces the 32-entry queued Follow-up limit", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => {
				await child.aborted
				throw new Error("aborted")
			})
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle)
			const created = await tools.agent.execute(
				"create",
				{ definition: "reviewer", label: "Review", prompt: "initial", waitMs: 0 },
				undefined,
				taskContext(workspace.cwd)
			)
			const id = (created.details as AgentCreationResult).id
			await Promise.all(
				Array.from({ length: 32 }, (_, index) =>
					tools.input.execute(`follow-${index}`, { id, content: `follow ${index}` }, undefined, taskContext(workspace.cwd))
				)
			)
			await expect(tools.input.execute("overflow", { id, content: "one too many" }, undefined, taskContext(workspace.cwd))).rejects.toThrow(
				"32 queued Follow-ups"
			)
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
			const loaded = await readTaskMetadata(paths)
			expect(loaded.status === "ok" ? loaded.metadata.queuedFollowUps : []).toHaveLength(32)
			await getAgentCoordinator().getResident(paths.taskDirectory)?.stop()
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("validates direct ownership, retained state, and input bounds", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => child.assistant("done"))
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle)
			const ctx = taskContext(workspace.cwd)
			await expect(tools.input.execute("missing", { id: "a_ffffffff", content: "work" }, undefined, ctx)).rejects.toThrow(
				"Unknown Task Reference"
			)
			await expect(tools.input.execute("blank", { id: "a_ffffffff", content: "   " }, undefined, ctx)).rejects.toThrow("nonblank")
			await expect(tools.input.execute("large", { id: "a_ffffffff", content: "x".repeat(64 * 1024 + 1) }, undefined, ctx)).rejects.toThrow(
				"65536 UTF-8 bytes"
			)

			const created = await tools.agent.execute("create", { definition: "reviewer", label: "Review", prompt: "initial" }, undefined, ctx)
			const id = (created.details as AgentCreationResult).id
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
			for (const eof of [true, false]) {
				await expect(tools.input.execute("agent-eof", { id, content: "work", eof }, undefined, ctx)).rejects.toThrow(
					"only supported for Bash"
				)
			}
			await mutateTaskMetadata(paths, metadata => ({ ...metadata, discardedAt: Date.now(), updatedAt: Date.now() }))
			await expect(tools.input.execute("discarded", { id, content: "work" }, undefined, ctx)).rejects.toThrow("discarded")
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})
})

describe("task lifecycle controls", () => {
	test("cancels queued work before it starts", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const coordinator = getAgentCoordinator()
			coordinator.setMaxConcurrency(1)
			const blocker = await coordinator.acquire({})
			const fake = fakeChild(async child => child.assistant("unexpected"))
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle, { ...config, maxConcurrency: 1 })
			const ctx = taskContext(workspace.cwd)
			try {
				const created = await tools.agent.execute(
					"create",
					{ definition: "reviewer", label: "Review", prompt: "wait", waitMs: 0 },
					undefined,
					ctx
				)
				const id = (created.details as AgentCreationResult).id
				const stopped = await tools.stop.execute("stop", { id }, undefined, ctx)
				expect(stopped.details).toMatchObject({ id, state: "idle", latestOutcome: "stopped" })
				expect(fake.prompts).toHaveLength(0)
			} finally {
				blocker.release()
				coordinator.setMaxConcurrency(2)
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})

	test("stops running work, clears Follow-ups, and is idempotent", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => {
				await child.aborted
				throw new Error("aborted")
			})
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle)
			const ctx = taskContext(workspace.cwd)
			const created = await tools.agent.execute(
				"create",
				{ definition: "reviewer", label: "Review", prompt: "wait", waitMs: 0 },
				undefined,
				ctx
			)
			const id = (created.details as AgentCreationResult).id
			while (fake.prompts.length === 0) await Bun.sleep(1)
			await tools.input.execute("follow", { id, content: "later" }, undefined, ctx)

			const first = await tools.stop.execute("stop", { id }, undefined, ctx)
			expect(first.details).toMatchObject({ id, action: "stop", state: "idle", latestOutcome: "stopped", queuedFollowUps: 0 })
			const second = await tools.stop.execute("stop-again", { id }, undefined, ctx)
			expect(second.details).toMatchObject({ id, state: "idle", latestOutcome: "stopped", queuedFollowUps: 0 })
			expect(fake.prompts).toHaveLength(1)
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("stop preserves an idle completion", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => child.assistant("done"))
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle)
			const ctx = taskContext(workspace.cwd)
			const created = await tools.agent.execute("create", { definition: "reviewer", label: "Review", prompt: "finish" }, undefined, ctx)
			const details = created.details as AgentCreationResult
			const idle = await tools.stop.execute("stop-idle", { id: details.id }, undefined, ctx)
			expect(idle.details).toMatchObject({ state: "idle", latestOutcome: "succeeded" })
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("discards permanently without deleting retained files", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => child.assistant("done"))
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle)
			const ctx = taskContext(workspace.cwd)
			const created = await tools.agent.execute("create", { definition: "reviewer", label: "Review", prompt: "finish" }, undefined, ctx)
			const details = created.details as AgentCreationResult

			const discarded = await tools.discard.execute("discard", { id: details.id }, undefined, ctx)
			expect(discarded.details).toMatchObject({ id: details.id, action: "discard", discarded: true })
			const again = await tools.discard.execute("discard-again", { id: details.id }, undefined, ctx)
			expect(again.details).toMatchObject({ id: details.id, discarded: true })
			const listed = await loadTaskList(workspace.cwd, "parent-session")
			expect(listed.details.tasks).toHaveLength(0)
			const retained = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), details.id)
			expect(await readFile(retained.history, "utf8")).toContain("done")
			expect(await readRetainedOutput(retained, { run: 1 })).toMatchObject({ text: "done", run: 1 })
			await expect(tools.input.execute("input", { id: details.id, content: "later" }, undefined, ctx)).rejects.toThrow("has been discarded")
			await expect(tools.stop.execute("stop", { id: details.id }, undefined, ctx)).rejects.toThrow("has been discarded")
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})
})

describe("delegation and cancellation", () => {
	test("static schemas accept waitMs and allowAgents; execution rejects delegation past the depth limit", async () => {
		await withTempWorkspace(async workspace => {
			const current = { ...config }
			const tools = captureAgentTools(
				workspace.agentDir,
				async () => {
					throw new Error("Must not create")
				},
				current
			)
			const args = { definition: "reviewer", label: "Review", prompt: "work" }
			expect(Value.Check(tools.agent.parameters, args)).toBe(true)
			expect(Value.Check(tools.agent.parameters, { ...args, waitMs: 0, allowAgents: true })).toBe(true)
			const limited = captureAgentTools(
				workspace.agentDir,
				async () => {
					throw new Error("Must not create")
				},
				{ ...current, maxDepth: 1 }
			)
			await expect(
				limited.agent.execute("hidden-delegation", { ...args, allowAgents: true }, undefined, taskContext(workspace.cwd))
			).rejects.toThrow("cannot delegate")
		})
	})

	test("cancels accepted capacity waits without starting them later", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => child.assistant("Must not run"))
			const coordinator = getAgentCoordinator()
			const limit = coordinator.maxConcurrency
			coordinator.setMaxConcurrency(1)
			const blocker = await coordinator.acquire({})
			const abort = new AbortController()
			const tool = captureAgentTool(workspace.agentDir, fake.handle)
			const pending = tool.execute(
				"queued",
				{ definition: "reviewer", label: "Queued", prompt: "work" },
				abort.signal,
				taskContext(workspace.cwd)
			)
			try {
				while (coordinator.queuedCount === 0) await Bun.sleep(1)
				abort.abort(new Error("cancelled"))
				expect((await pending).details).toMatchObject({ state: "idle", latestOutcome: "stopped", detached: false })
				blocker.release()
				await Bun.sleep(10)
				expect(fake.prompts).toEqual([])
				expect(fake.disposed).toBe(true)
				expect(coordinator.queuedCount).toBe(0)
				const list = await loadTaskList(workspace.cwd, "parent-session")
				expect(list.details.tasks[0]).toMatchObject({ state: "idle", latestOutcome: "stopped" })
			} finally {
				abort.abort(new Error("cancelled"))
				blocker.release()
				coordinator.setMaxConcurrency(limit)
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})

	test("settles a provider error reply as failed without restarting it", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => child.assistantError("429 rate limit exceeded"))
			const tool = captureAgentTool(workspace.agentDir, fake.handle)
			try {
				const result = await tool.execute(
					"limit",
					{ definition: "reviewer", label: "Foreground", prompt: "work" },
					undefined,
					taskContext(workspace.cwd)
				)
				expect(result.details).toMatchObject({ state: "idle", latestOutcome: "failed", detached: false })
				expect(fake.prompts).toHaveLength(1)
			} finally {
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})

	test("enforces parent allowAgents even when the tool is directly invoked", async () => {
		await withTempWorkspace(async workspace => {
			const tool = captureAgentTool(workspace.agentDir, fakeChild(async () => {}).handle)
			const unbind = getAgentCoordinator().bindSessionContext("parent-session", { depth: 1, allowAgents: false })
			try {
				await expect(
					tool.execute("forged", { definition: "reviewer", label: "Denied", prompt: "work" }, undefined, taskContext(workspace.cwd))
				).rejects.toThrow("not allowed to delegate")
			} finally {
				unbind()
			}
		})
	})

	test("cancels nested work while all managed permits are lent", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const coordinator = getAgentCoordinator()
			const limit = coordinator.maxConcurrency
			coordinator.setMaxConcurrency(1)
			const nestedAbort = new AbortController()
			const started = deferred<void>()
			const nested = fakeChild(
				async child => {
					started.resolve(undefined)
					await child.aborted
				},
				true,
				"grandchild-session"
			)
			const parent = fakeChild(async child => {
				void child.aborted.then(() => nestedAbort.abort(new Error("parent cancelled")))
				await tools.agent.execute("nested", { definition: "reviewer", label: "Nested", prompt: "nested work" }, nestedAbort.signal, {
					...taskContext(workspace.cwd),
					sessionManager: { getSessionId: () => child.handle.session.sessionId }
				} as ExtensionContext)
			})
			const children = [parent.handle, nested.handle]
			const tools = captureAgentTools(
				workspace.agentDir,
				async options => {
					const child = children.shift()
					if (!child) throw new Error("Unexpected child")
					const depth = options.parentDepth + 1
					const unbind = coordinator.bindSessionContext(child.session.sessionId, { depth, allowAgents: options.allowAgents })
					return {
						...child,
						depth,
						allowAgents: options.allowAgents,
						dispose() {
							unbind()
							child.dispose()
						}
					}
				},
				{ ...config }
			)
			const abort = new AbortController()
			const pending = tools.agent.execute(
				"parent",
				{
					definition: "reviewer",
					label: "Parent",
					prompt: "delegate",
					allowAgents: true
				},
				abort.signal,
				taskContext(workspace.cwd)
			)
			try {
				await started.promise
				expect(coordinator.activeCount).toBe(1)
				abort.abort(new Error("cancelled"))
				expect((await pending).details).toMatchObject({ state: "idle", latestOutcome: "stopped" })
				expect(parent.disposed).toBe(true)
				expect(nested.disposed).toBe(true)
				expect(coordinator.activeCount).toBe(0)
				expect(coordinator.residentCount).toBe(0)
				const tasks = (await loadTaskList(workspace.cwd, "parent-session")).details.tasks
				expect(tasks[0]).toMatchObject({ state: "idle", latestOutcome: "stopped" })
			} finally {
				abort.abort(new Error("cancelled"))
				nestedAbort.abort(new Error("cancelled"))
				coordinator.setMaxConcurrency(limit)
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
				await releaseParentLeaseFor(workspace.cwd, "child-session")
			}
		})
	})
})

type CapturedAgentTool = {
	parameters: TSchema
	description: string
	promptSnippet: string
	promptGuidelines: string[]
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>
}

type CapturedAgentTools = {
	agent: CapturedAgentTool
	input: CapturedAgentTool
	stop: CapturedAgentTool
	discard: CapturedAgentTool
}

function captureAgentTool(agentDir: string, child: ChildSessionHandle, toolConfig: AgentsConfig = config): CapturedAgentTool {
	return captureAgentTools(agentDir, async () => child, toolConfig).agent
}

function captureAgentTools(
	agentDir: string,
	createChild: (options: CreateChildSessionOptions) => Promise<ChildSessionHandle>,
	toolConfig: AgentsConfig = config
): CapturedAgentTools {
	const captured = new Map<string, CapturedAgentTool>()
	const api = {
		registerTool(tool: {
			name: string
			parameters: TSchema
			description: string
			promptSnippet: string
			promptGuidelines: string[]
			execute: (...args: unknown[]) => unknown
		}) {
			captured.set(tool.name, {
				parameters: tool.parameters,
				description: tool.description,
				promptSnippet: tool.promptSnippet,
				promptGuidelines: tool.promptGuidelines,
				execute: (toolCallId, params, signal, ctx) =>
					tool.execute(toolCallId, params, signal, undefined, ctx) as ReturnType<CapturedAgentTool["execute"]>
			})
		},
		getAllTools() {
			return [{ name: "read" }, { name: "agent" }]
		}
	} as unknown as ExtensionAPI
	registerAgentTool(api, {
		getConfig: () => toolConfig,
		getAgentDir: () => agentDir,
		createChild
	})
	registerTaskInputTool(api, {
		getConfig: () => toolConfig,
		getAgentDir: () => agentDir,
		createChild
	})
	const agent = captured.get("agent")
	const input = captured.get("task_input")
	const stop = captured.get("task_stop")
	const discard = captured.get("task_discard")
	if (!agent || !input || !stop || !discard) throw new Error("agent tools were not registered")
	return { agent, input, stop, discard }
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
	systemPrompt: string
	prompts: Array<{ text: string; expandPromptTemplates: boolean | undefined }>
	readonly disposed: boolean
	readonly aborted: Promise<void>
	readonly streaming: boolean
	steers: string[]
	steerExpansions: Array<boolean | undefined>
	assistant(text: string, phase?: "message_start" | "message_update" | "message_end"): void
	thinking(text: string): void
	assistantError(errorMessage: string): void
	tool(name: string, args: unknown, resultValue: unknown): void
}

function fakeChild(runPrompt: (child: FakeChild) => Promise<void>, deliverSteers = true, sessionId = "child-session"): FakeChild {
	const listeners = new Set<(event: AgentSessionEvent) => void>()
	const messages: Array<{
		role: "assistant"
		content: Array<{ type: "text"; text: string }>
		stopReason: "stop" | "error"
		errorMessage?: string
	}> = []
	const aborted = deferred<void>()
	let disposed = false
	let streaming = false
	const result: FakeChild = {
		systemPrompt: "Effective fixture prompt",
		prompts: [],
		steers: [],
		steerExpansions: [],
		aborted: aborted.promise,
		get streaming() {
			return streaming
		},
		get disposed() {
			return disposed
		},
		assistant(text: string, phase = "message_end") {
			const message = { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason: "stop" as const }
			if (phase === "message_end") messages.push(message)
			for (const listener of listeners) {
				listener({ type: phase, message, assistantMessageEvent: { type: "text_delta" } } as unknown as AgentSessionEvent)
			}
		},
		assistantError(errorMessage: string) {
			const message = { role: "assistant" as const, content: [], stopReason: "error" as const, errorMessage }
			messages.push(message)
			for (const listener of listeners) listener({ type: "message_end", message } as unknown as AgentSessionEvent)
		},
		thinking(text: string) {
			const message = { role: "assistant", content: [{ type: "thinking", thinking: text }] }
			for (const listener of listeners) {
				listener({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta" } } as unknown as AgentSessionEvent)
			}
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
			prompt: (_runId: string, text: string, options?: { expandPromptTemplates?: boolean }) => result.handle.session.prompt(text, options),
			session: {
				get systemPrompt() {
					return result.systemPrompt
				},
				sessionId,
				model: selectedModel,
				thinkingLevel: "medium",
				messages,
				get isStreaming() {
					return streaming
				},
				async prompt(text: string, options?: { expandPromptTemplates?: boolean; streamingBehavior?: "steer" | "followUp" }) {
					if ("streamingBehavior" in (options ?? {}) && options?.streamingBehavior === "steer") {
						result.steers.push(text)
						result.steerExpansions.push(options.expandPromptTemplates)
						if (deliverSteers) {
							for (const listener of listeners) {
								listener({
									type: "message_start",
									message: { role: "user", content: text, timestamp: Date.now() }
								} as unknown as AgentSessionEvent)
							}
						}
						return
					}
					result.prompts.push({ text, expandPromptTemplates: options?.expandPromptTemplates })
					streaming = true
					try {
						for (const listener of listeners) listener({ type: "agent_start" })
						for (const listener of listeners) {
							listener({
								type: "message_start",
								message: { role: "user", content: text, timestamp: Date.now() }
							} as unknown as AgentSessionEvent)
						}
						await runPrompt(result)
					} finally {
						streaming = false
					}
				},
				async abort() {
					aborted.resolve(undefined)
				},
				async steer(text: string) {
					await result.handle.session.prompt(text, { expandPromptTemplates: true, streamingBehavior: "steer" })
				},
				agent: {
					steer(message: { content: string }) {
						void result.handle.session.prompt(message.content, { expandPromptTemplates: false, streamingBehavior: "steer" })
					}
				},
				clearQueue() {},
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

async function waitForOutcome(paths: ReturnType<typeof taskStoragePaths>): Promise<string | null> {
	const deadline = Date.now() + 2_000
	while (Date.now() < deadline) {
		const loaded = await readTaskMetadata(paths)
		if (loaded.status === "ok" && loaded.metadata.latestOutcome) return loaded.metadata.latestOutcome
		await Bun.sleep(5)
	}
	return null
}

async function waitForRunCount(paths: ReturnType<typeof taskStoragePaths>, count: number): Promise<void> {
	const deadline = Date.now() + 2_000
	while (Date.now() < deadline) {
		const loaded = await readTaskMetadata(paths)
		if (
			loaded.status === "ok" &&
			loaded.metadata.lastRunSequence >= count &&
			loaded.metadata.state === "idle" &&
			loaded.metadata.queuedFollowUps.length === 0
		)
			return
		await Bun.sleep(2)
	}
	throw new Error(`Task did not finish ${count} runs`)
}
