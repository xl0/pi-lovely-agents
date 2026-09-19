import { describe, expect, test } from "bun:test"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent"
import { getBashCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import {
	appendHistoryLog,
	ensureParentStorage,
	initializeRetainedLogs,
	mutateTaskMetadata,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	type TaskMetadata,
	type TaskStoragePaths,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import { loadTaskList, registerTaskTools, type TaskListResult, type TaskOutputResult } from "../../extensions/lovely-agents/tools.js"
import { withTempWorkspace } from "./test-helpers.js"

describe("read-only task tools", () => {
	test("lists mixed direct ownership and reads Bash tails, full logs, exit status, and its own capacity", async () => {
		await withTempWorkspace(async workspace => {
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000001",
				childSessionId: "child",
				label: "Agent",
				state: "idle",
				updatedAt: 1
			})
			const bash = await createTask(workspace.cwd, "parent-session", {
				id: "b_00000001",
				label: "Shell",
				state: "idle",
				updatedAt: 1,
				outcome: "failed",
				output: "last output"
			})
			await createTask(workspace.cwd, "child", {
				id: "b_00000002",
				label: "Nested shell",
				state: "running",
				updatedAt: 1
			})
			await writeFile(bash.output, "earlier output\nlast output")
			await appendHistoryLog(bash, { type: "stdin", content: "literal\n", timestamp: 1, eof: true })
			await appendHistoryLog(bash, { type: "output", content: "last output" })
			expect((await readdir(bash.taskDirectory)).sort()).toEqual(["history.md", "metadata.json", "output.log"])
			expect(await readFile(bash.history, "utf8")).toContain("<stdin>\nliteral\n<stdin EOF>")
			if (process.platform !== "win32") expect((await stat(bash.output)).mode & 0o077).toBe(0)
			const pool = getBashCoordinator()
			const permit = await pool.acquire({})
			const captured = captureTaskTools()
			try {
				const list = await loadTaskList(workspace.cwd, "parent-session")
				expect(list.details.tasks.map(task => task.id)).toEqual(["a_00000001", "b_00000001"])
				expect(list.details.tasks[0]?.descendants).toBe(1)
				const row = list.details.tasks[1]
				expect(row).toMatchObject({ kind: "bash", exitCode: 7, signal: null, descendants: 0 })
				expect(row).not.toHaveProperty("model")
				expect(row).not.toHaveProperty("thinking")
				expect(row).not.toHaveProperty("definition")
				expect(row?.paths).not.toHaveProperty("session")
				expect(row?.paths.output).toEndWith("/b_00000001/output.log")
				expect(list.details.bashCapacity).toEqual({ active: 1, limit: pool.maxConcurrency })
				const result = await captured.tools.get("task_output")?.execute("read", { id: bash.taskRef }, undefined, taskContext(workspace.cwd))
				expect(result?.details).toMatchObject({ exitCode: 7, signal: null, capacity: { active: 1, limit: pool.maxConcurrency } })
				expect(result?.content[0]?.text).toContain("last output")
				expect(result?.content[0]?.text).toContain("output.log")
				expect(result?.content[0]?.text).not.toContain("earlier output")
				expect(result?.content[0]?.text).not.toContain("session.jsonl")
				await expect(
					captured.tools.get("task_output")?.execute("foreign", { id: "b_00000002" }, undefined, taskContext(workspace.cwd))
				).rejects.toThrow("Unknown Task Reference")
			} finally {
				permit.release()
				await captured.shutdown?.({ type: "session_shutdown", reason: "quit" }, taskContext(workspace.cwd))
			}
		})
	})

	test("input previews are loaded only for human task views, including settled runs", async () => {
		await withTempWorkspace(async workspace => {
			const paths = await createTask(workspace.cwd, "parent-session", {
				id: "a_00000001",
				childSessionId: "child-one",
				label: "Preview",
				state: "queued",
				updatedAt: 10
			})
			await mutateTaskMetadata(paths, current => ({ ...current, state: "idle", activeRun: null, latestOutcome: "succeeded" }))
			const ui = await loadTaskList(workspace.cwd, "parent-session", { includeInputPreviews: true })
			expect(ui.details.tasks[0]?.inputPreview).toBe("Inspect")
			const { tools } = captureTaskTools()
			const tool = tools.get("task_list")
			if (!tool) throw new Error("Missing task_list")
			const result = await tool.execute("call", {}, undefined, taskContext(workspace.cwd))
			expect(JSON.stringify(result)).not.toContain("inputPreview")
			expect(JSON.stringify(result)).not.toContain("Inspect")
		})
	})

	test("lists every direct task in stable order with diagnostics and descendant counts", async () => {
		await withTempWorkspace(async workspace => {
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000001",
				childSessionId: "child-one",
				label: "Older running",
				state: "running",
				updatedAt: 10,
				output: "one\ntwo\n",
				queuedFollowUps: 1
			})
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000006",
				childSessionId: "child-six",
				label: "Newer running",
				state: "running",
				updatedAt: 20,
				lastActivity: { at: 20, action: "thinking" }
			})
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000000",
				childSessionId: "child-zero",
				label: "Tie-break running",
				state: "running",
				updatedAt: 10
			})
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000003",
				childSessionId: "child-three",
				label: "Queued",
				state: "queued",
				updatedAt: 40
			})
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000004",
				childSessionId: "child-four",
				label: "Interrupted",
				state: "interrupted",
				updatedAt: 50,
				outcome: "interrupted"
			})
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000005",
				childSessionId: "child-five",
				label: "Idle",
				state: "idle",
				updatedAt: 60,
				outcome: "succeeded"
			})
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000007",
				childSessionId: "child-seven",
				label: "Discarded",
				state: "idle",
				updatedAt: 70,
				discarded: true
			})
			const corrupt = await reserveTaskStorage(await ensureParentStorage(workspace.cwd, "parent-session"), () => "a_00000008")
			await writeFile(corrupt.metadata, "{broken", "utf8")

			await createTask(workspace.cwd, "child-one", {
				id: "a_10000001",
				childSessionId: "grandchild-one",
				label: "Nested queued",
				state: "queued",
				updatedAt: 10
			})
			await createTask(workspace.cwd, "grandchild-one", {
				id: "a_20000001",
				childSessionId: "leaf-one",
				label: "Nested running",
				state: "running",
				updatedAt: 20
			})

			const captured = captureTaskTools()
			const ctx = taskContext(workspace.cwd)
			const full = await captured.tools.get("task_list")?.execute("list", {}, undefined, ctx)
			if (!full) throw new Error("task_list was not registered")
			const details = full.details as TaskListResult
			expect(details.tasks.map(task => task.id)).toEqual([
				"a_00000006",
				"a_00000000",
				"a_00000001",
				"a_00000003",
				"a_00000004",
				"a_00000005"
			])
			expect(details.tasks[0]?.lastActivity).toEqual({ at: 20, action: "thinking" })
			expect(details.diagnostics).toHaveLength(1)
			expect(details.diagnostics[0]?.id).toBe("a_00000008")
			expect(details.tasks.some(task => task.id === "a_10000001")).toBe(false)
			const parent = details.tasks.find(task => task.id === "a_00000001")
			expect(parent?.queuedFollowUps).toBe(1)
			expect(parent?.outputLines).toBe(2)
			expect(parent?.descendants).toBe(2)
			expect(full.content[0]?.text).toContain("Older running")
			expect(full.content[0]?.text).toContain("anthropic/sonnet:high")

			const leasePath = (await ensureParentStorage(workspace.cwd, "parent-session")).lease
			await captured.shutdown?.({ type: "session_shutdown", reason: "reload" }, ctx)
			expect((await stat(leasePath)).isFile()).toBe(true)
			await captured.shutdown?.({ type: "session_shutdown", reason: "quit" }, ctx)
			await expect(stat(leasePath)).rejects.toMatchObject({ code: "ENOENT" })
		})
	})

	test("reads owned replies, including discarded tasks, with run status", async () => {
		await withTempWorkspace(async workspace => {
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000001",
				childSessionId: "child-one",
				label: "Output task",
				state: "running",
				updatedAt: 1,
				output: "first\nsecond\nthird\n",
				lastActivity: { at: 1, action: "reply complete" },
				queuedFollowUps: 1
			})
			await createTask(workspace.cwd, "child-one", {
				id: "a_10000001",
				childSessionId: "leaf-one",
				label: "Nested",
				state: "idle",
				updatedAt: 1
			})
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000002",
				childSessionId: "child-two",
				label: "Discarded",
				state: "idle",
				updatedAt: 1,
				discarded: true
			})

			const captured = captureTaskTools()
			const ctx = taskContext(workspace.cwd)
			const result = await captured.tools.get("task_output")?.execute("output", { id: "a_00000001" }, undefined, ctx)
			if (!result) throw new Error("task_output was not registered")
			const details = result.details as TaskOutputResult
			expect(result.content[0]?.text).toContain("last_activity: reply complete")
			expect(result.content[0]?.text).toContain("execution permits")
			expect(details).toMatchObject({
				id: "a_00000001",
				state: "running",
				queuedFollowUps: 1,
				totalLines: 3,
				streaming: false,
				latestOutcome: null
			})
			expect(result.content[0]?.text).toContain("task_output run=1 state=running outcome=none streaming=false queued=1")
			expect(result.content[0]?.text).toContain("first\nsecond\nthird")
			expect(details.paths.history).toBe(".pi/lovely-agents/parent-session/a_00000001/history.md")
			expect(result.content[0]?.text).not.toContain("activity.md")

			await expect(captured.tools.get("task_output")?.execute("nested", { id: "a_10000001" }, undefined, ctx)).rejects.toThrow(
				"Unknown Task Reference"
			)
			const discarded = await captured.tools.get("task_output")?.execute("discarded", { id: "a_00000002" }, undefined, ctx)
			expect(discarded?.details).toMatchObject({ id: "a_00000002", state: "idle" })
			await captured.shutdown?.({ type: "session_shutdown", reason: "quit" }, ctx)
		})
	})

	test("runs semantic shutdown cleanup for every replacement reason but not reload", async () => {
		await withTempWorkspace(async workspace => {
			const cleaned: string[] = []
			const captured = captureTaskTools(async (_cwd, _parentSessionId) => {
				cleaned.push("cleanup")
			})
			const ctx = taskContext(workspace.cwd)
			for (const reason of ["quit", "new", "resume", "fork", "reload"] as const) {
				await captured.shutdown?.({ type: "session_shutdown", reason }, ctx)
			}
			expect(cleaned).toHaveLength(4)
		})
	})
})

type TaskFixture = {
	id: string
	childSessionId?: string
	label: string
	state: TaskMetadata["state"]
	updatedAt: number
	outcome?: TaskMetadata["latestOutcome"]
	output?: string
	queuedFollowUps?: number
	discarded?: boolean
	lastActivity?: TaskMetadata["lastActivity"]
}

async function createTask(cwd: string, parentSessionId: string, fixture: TaskFixture): Promise<TaskStoragePaths> {
	const parent = await ensureParentStorage(cwd, parentSessionId)
	const paths = await reserveTaskStorage(parent, () => fixture.id)
	await initializeRetainedLogs(paths)
	await writeTaskMetadata(paths, taskMetadata(paths, fixture))
	return paths
}

function taskMetadata(paths: TaskStoragePaths, fixture: TaskFixture): TaskMetadata {
	const activeState = fixture.state === "running" || fixture.state === "queued" ? fixture.state : null
	const queuedFollowUps = Array.from({ length: fixture.queuedFollowUps ?? 0 }, (_, index) => ({
		id: `r_${String(index + 2).padStart(16, "0")}`,
		sequence: index + 2,
		content: `Follow-up ${index + 1}`,
		acceptedAt: fixture.updatedAt
	}))
	return {
		version: TASK_METADATA_VERSION,
		...(paths.taskRef.startsWith("b_")
			? {
					kind: "bash" as const,
					command: "printf output",
					cwd: paths.workspace,
					exitCode: fixture.outcome === "failed" ? 7 : null,
					signal: null
				}
			: {
					kind: "agent" as const,
					childSessionId: fixture.childSessionId ?? "child",
					definitionName: "reviewer",
					model: { provider: "anthropic", id: "sonnet" },
					thinking: "high" as const,
					depth: 1,
					allowAgents: false,
					sessionConfig: {
						systemPrompt: "Review work.",
						tools: null,
						excludeAgentsMd: false,
						scopedModels: [{ provider: "anthropic", id: "sonnet" }]
					}
				}),
		taskRef: paths.taskRef,
		parentSessionId: paths.parentSessionId,
		label: fixture.label,
		state: fixture.state,
		latestOutcome: fixture.outcome ?? null,
		latestReply: fixture.output ? { text: fixture.output, streaming: false } : null,
		...(fixture.lastActivity ? { lastActivity: fixture.lastActivity } : {}),
		lastRunSequence: activeState ? 1 + queuedFollowUps.length : fixture.outcome ? 1 : 0,
		activeRun: activeState
			? {
					id: "r_0000000000000001",
					sequence: 1,
					kind: "initial",
					state: activeState,
					input: "Inspect",
					acceptedAt: fixture.updatedAt,
					...(fixture.state !== "queued" ? { startedAt: fixture.updatedAt } : {}),
					detachedAt: fixture.updatedAt
				}
			: null,
		queuedFollowUps,
		notifications: [],
		discardedAt: fixture.discarded ? fixture.updatedAt : null,
		createdAt: fixture.updatedAt,
		updatedAt: fixture.updatedAt
	}
}

type CapturedTool = {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>
}

function captureTaskTools(beforeParentLeaseRelease?: (cwd: string, parentSessionId: string) => void | Promise<void>): {
	tools: Map<string, CapturedTool>
	shutdown?: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>
} {
	const tools = new Map<string, CapturedTool>()
	let shutdown: ((event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>) | undefined
	const api = {
		registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }) {
			tools.set(tool.name, {
				execute: (toolCallId, params, signal, ctx) =>
					tool.execute(toolCallId, params, signal, undefined, ctx) as Promise<{
						content: Array<{ type: "text"; text: string }>
						details: unknown
					}>
			})
		},
		on(event: string, handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>) {
			if (event === "session_shutdown") shutdown = handler
		}
	} as unknown as ExtensionAPI
	registerTaskTools(api, beforeParentLeaseRelease ? { beforeParentLeaseRelease } : {})
	return { tools, ...(shutdown ? { shutdown } : {}) }
}

function taskContext(cwd: string): ExtensionContext {
	return {
		cwd,
		sessionManager: { getSessionId: () => "parent-session" }
	} as unknown as ExtensionContext
}
