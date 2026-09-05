import { describe, expect, test } from "bun:test"
import { readFile, unlink } from "node:fs/promises"
import { resolve } from "node:path"
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent"
import {
	type AgentCreationResult,
	recoverProviderTuple,
	registerAgentTool,
	registerTaskInputTool,
	type TaskInputResult
} from "../../extensions/lovely-agents/agent.js"
import type { ChildSessionHandle, CreateChildSessionOptions } from "../../extensions/lovely-agents/child-session.js"
import type { AgentsConfig } from "../../extensions/lovely-agents/config.js"
import { getAgentCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import { recoverOwnedTaskTree } from "../../extensions/lovely-agents/lifecycle.js"
import {
	mutateTaskMetadata,
	parentStoragePaths,
	readRetainedOutput,
	readTaskMetadata,
	releaseParentLeaseFor,
	taskStoragePaths
} from "../../extensions/lovely-agents/state.js"
import { loadTaskList } from "../../extensions/lovely-agents/tools.js"
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
				queuedFollowUps: 0,
				detached: false
			})
			expect(details.output.text).toContain("Completed review")
			expect(result.content[0]?.text).not.toContain("tasks:")
			expect(await readFile(resolve(workspace.cwd, details.output.paths.activity), "utf8")).toContain("## read")
			expect(fake.prompts).toEqual([{ text: "Inspect this change", expandPromptTemplates: false }])
			while (!fake.disposed) await Bun.sleep(1)
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

	test("suspends terminal provider limits and closes only that model tuple", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => child.assistantError("HTTP 429 too many requests"))
			const blocked = fakeChild(async child => child.assistant("unexpected"))
			const children = [fake.handle, blocked.handle]
			const tools = captureAgentTools(workspace.agentDir, async () => {
				const child = children.shift()
				if (!child) throw new Error("No fake child remains")
				return child
			})
			const coordinator = getAgentCoordinator()
			const tuple = { provider: selectedModel.provider, model: selectedModel.id }
			coordinator.openTuple(tuple)
			try {
				const result = await tools.agent.execute(
					"create",
					{ definition: "reviewer", label: "Limited review", prompt: "Inspect" },
					undefined,
					taskContext(workspace.cwd)
				)
				const details = result.details as AgentCreationResult
				expect(details).toMatchObject({ state: "suspended", latestOutcome: null, detached: false })
				expect(coordinator.isTupleOpen(tuple)).toBe(false)
				const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), details.id)
				const loaded = await readTaskMetadata(paths)
				expect(loaded.status === "ok" ? loaded.metadata.activeRun?.state : null).toBe("suspended")
				expect(fake.disposed).toBe(false)

				const queued = await tools.agent.execute(
					"queued",
					{ definition: "reviewer", label: "Blocked review", prompt: "Inspect later", waitMs: 0 },
					undefined,
					taskContext(workspace.cwd)
				)
				expect(queued.details).toMatchObject({ state: "queued", detached: true })
				expect(blocked.prompts).toHaveLength(0)
				await tools.stop.execute("stop-queued", { id: (queued.details as AgentCreationResult).id }, undefined, taskContext(workspace.cwd))

				const stopped = await tools.stop.execute("stop", { id: details.id }, undefined, taskContext(workspace.cwd))
				expect(stopped.details).toMatchObject({ state: "idle", latestOutcome: "stopped" })
				expect(coordinator.isTupleOpen(tuple)).toBe(false)
			} finally {
				coordinator.openTuple(tuple)
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})

	test("recovers the same logical run with literal Continue input", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => {
				if (child.prompts.length < 3) child.assistantError("ResourceExhausted")
				else child.assistant("Recovered")
			})
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle)
			const coordinator = getAgentCoordinator()
			const tuple = { provider: selectedModel.provider, model: selectedModel.id }
			coordinator.openTuple(tuple)
			try {
				const created = await tools.agent.execute(
					"create",
					{ definition: "reviewer", label: "Recovering review", prompt: "Inspect" },
					undefined,
					taskContext(workspace.cwd)
				)
				const details = created.details as AgentCreationResult
				const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), details.id)
				expect(details.state).toBe("suspended")

				expect(recoverProviderTuple(tuple)).toBe(1)
				await waitForSuspension(paths, fake, 2)
				expect(coordinator.isTupleOpen(tuple)).toBe(false)

				const recovery = await recoverOwnedTaskTree(workspace.cwd, "parent-session")
				expect(recovery).toEqual({ resumed: 1, diagnostics: [] })
				expect(await recoverOwnedTaskTree(workspace.cwd, "parent-session")).toEqual({ resumed: 0, diagnostics: [] })
				expect(await waitForOutcome(paths, details.output.nextOffset)).toBe("succeeded")
				expect(fake.prompts).toEqual([
					{ text: "Inspect", expandPromptTemplates: false },
					{ text: "Continue.", expandPromptTemplates: false },
					{ text: "Continue.", expandPromptTemplates: false }
				])
				const output = await readFile(paths.output, "utf8")
				expect(output.match(/<run 1 initial>/g)).toHaveLength(1)
				expect(output).not.toContain("<user>\nContinue.")
			} finally {
				coordinator.openTuple(tuple)
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
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

describe("task_input tool", () => {
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
			expect(first.details).toMatchObject({ effectiveDelivery: "followup", queuePosition: 1, queuedFollowUps: 1 })
			expect(second.details).toMatchObject({ effectiveDelivery: "followup", queuePosition: 2, queuedFollowUps: 2 })
			const acceptedPaths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
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
			expect(fake.prompts.map(prompt => prompt.text)).toEqual(["initial", "follow one", "follow two"])
			const output = await readFile(paths.output, "utf8")
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
			expect(await readFile(paths.output, "utf8")).toContain("<steer>\nchange direction")
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
			const output = await readFile(paths.output, "utf8")
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
			const blocker = await coordinator.acquire({ tuple: { provider: "other", model: "busy" } })
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
					requestedDelivery: "steer",
					effectiveDelivery: "followup",
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

	test("falls back from Steer while suspended and preserves the accepted run", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const finish = deferred<void>()
			const fake = fakeChild(async child => {
				if (child.prompts.length === 1) await finish.promise
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
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), id)
			while (!fake.streaming) await Bun.sleep(1)
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				state: "suspended",
				activeRun: metadata.activeRun ? { ...metadata.activeRun, state: "suspended" } : null,
				updatedAt: Date.now()
			}))
			const input = await tools.input.execute(
				"steer",
				{ id, content: "after recovery", delivery: "steer" },
				undefined,
				taskContext(workspace.cwd)
			)
			expect(input.details).toMatchObject({ effectiveDelivery: "followup", queuePosition: 1, queuedFollowUps: 1 })
			finish.resolve(undefined)
			await waitForRunCount(paths, 2)
			expect(fake.prompts.map(prompt => prompt.text)).toEqual(["initial", "after recovery"])
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
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
			expect(await readFile(paths.output, "utf8")).not.toContain("### Steer")
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
			const blocker = await coordinator.acquire({ tuple: { provider: "other", model: "busy" } })
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

	test("preserves an idle completion and settles retained suspended work", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			const fake = fakeChild(async child => child.assistant("done"))
			const tools = captureAgentTools(workspace.agentDir, async () => fake.handle)
			const ctx = taskContext(workspace.cwd)
			const created = await tools.agent.execute("create", { definition: "reviewer", label: "Review", prompt: "finish" }, undefined, ctx)
			const details = created.details as AgentCreationResult
			const paths = taskStoragePaths(parentStoragePaths(workspace.cwd, "parent-session"), details.id)
			const idle = await tools.stop.execute("stop-idle", { id: details.id }, undefined, ctx)
			expect(idle.details).toMatchObject({ state: "idle", latestOutcome: "succeeded" })

			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				state: "suspended",
				activeRun: {
					id: "r_1111111111111111",
					sequence: 2,
					kind: "followup",
					state: "suspended",
					input: "retry",
					acceptedAt: Date.now(),
					startedAt: Date.now()
				},
				lastRunSequence: 3,
				queuedFollowUps: [{ id: "r_2222222222222222", sequence: 3, content: "later", acceptedAt: Date.now() }],
				updatedAt: Date.now()
			}))
			const suspended = await tools.stop.execute("stop-suspended", { id: details.id }, undefined, ctx)
			expect(suspended.details).toMatchObject({ state: "idle", latestOutcome: "stopped", queuedFollowUps: 0 })
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
			expect(await readFile(resolve(workspace.cwd, details.output.paths.output), "utf8")).toContain("done")
			await expect(tools.input.execute("input", { id: details.id, content: "later" }, undefined, ctx)).rejects.toThrow("has been discarded")
			await expect(tools.stop.execute("stop", { id: details.id }, undefined, ctx)).rejects.toThrow("has been discarded")
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
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
		registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }) {
			captured.set(tool.name, {
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
	prompts: Array<{ text: string; expandPromptTemplates: boolean | undefined }>
	readonly disposed: boolean
	readonly aborted: Promise<void>
	readonly streaming: boolean
	steers: string[]
	steerExpansions: Array<boolean | undefined>
	assistant(text: string): void
	assistantError(errorMessage: string): void
	tool(name: string, args: unknown, resultValue: unknown): void
}

function fakeChild(runPrompt: (child: FakeChild) => Promise<void>, deliverSteers = true): FakeChild {
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
		assistant(text: string) {
			const message = { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason: "stop" as const }
			messages.push(message)
			for (const listener of listeners) listener({ type: "message_end", message } as unknown as AgentSessionEvent)
		},
		assistantError(errorMessage: string) {
			const message = { role: "assistant" as const, content: [], stopReason: "error" as const, errorMessage }
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

async function waitForSuspension(paths: ReturnType<typeof taskStoragePaths>, child: FakeChild, promptCount: number): Promise<void> {
	const deadline = Date.now() + 2_000
	while (Date.now() < deadline) {
		const loaded = await readTaskMetadata(paths)
		if (child.prompts.length >= promptCount && loaded.status === "ok" && loaded.metadata.state === "suspended") return
		await Bun.sleep(2)
	}
	throw new Error(`Task did not suspend after ${promptCount} prompts`)
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
