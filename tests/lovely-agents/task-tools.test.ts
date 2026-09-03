import { describe, expect, test } from "bun:test"
import { stat, writeFile } from "node:fs/promises"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
	ensureParentStorage,
	initializeRetainedLogs,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	type TaskMetadata,
	type TaskStoragePaths,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import {
	buildTaskListToolResult,
	registerTaskTools,
	type TaskListResult,
	type TaskListRow,
	type TaskOutputResult
} from "../../extensions/lovely-agents/tools.js"
import { withTempWorkspace } from "./test-helpers.js"

describe("read-only task tools", () => {
	test("lists every direct task in stable order with diagnostics and descendant summaries", async () => {
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
				updatedAt: 20
			})
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000000",
				childSessionId: "child-zero",
				label: "Tie-break running",
				state: "running",
				updatedAt: 10
			})
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000002",
				childSessionId: "child-two",
				label: "Suspended",
				state: "suspended",
				updatedAt: 30
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
				label: "Nested suspended",
				state: "suspended",
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
				"a_00000002",
				"a_00000003",
				"a_00000004",
				"a_00000005"
			])
			expect(details.total).toBe(7)
			expect(details.diagnostics).toHaveLength(1)
			expect(details.diagnostics[0]?.id).toBe("a_00000008")
			expect(details.tasks.some(task => task.id === "a_10000001")).toBe(false)
			const parent = details.tasks.find(task => task.id === "a_00000001")
			expect(parent?.queuedFollowUps).toBe(1)
			expect(parent?.outputLines).toBe(2)
			expect(parent?.descendants).toEqual({
				total: 2,
				states: { idle: 0, queued: 0, running: 1, suspended: 1, interrupted: 0 },
				outcomes: { succeeded: 0, failed: 0, stopped: 0, interrupted: 0 },
				activeLabels: ["Nested running", "Nested suspended"]
			})
			expect(JSON.stringify(parent?.descendants)).not.toContain("a_10000001")

			const leasePath = (await ensureParentStorage(workspace.cwd, "parent-session")).lease
			await captured.shutdown?.({ reason: "reload" }, ctx)
			expect((await stat(leasePath)).isFile()).toBe(true)
			await captured.shutdown?.({ reason: "quit" }, ctx)
			await expect(stat(leasePath)).rejects.toMatchObject({ code: "ENOENT" })
		})
	})

	test("reads only owned, non-discarded task output with continuation metadata", async () => {
		await withTempWorkspace(async workspace => {
			await createTask(workspace.cwd, "parent-session", {
				id: "a_00000001",
				childSessionId: "child-one",
				label: "Output task",
				state: "running",
				updatedAt: 1,
				output: "first\nsecond\nthird\n",
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
			const result = await captured.tools.get("task_output")?.execute("output", { id: "a_00000001", offset: 2, limit: 1 }, undefined, ctx)
			if (!result) throw new Error("task_output was not registered")
			const details = result.details as TaskOutputResult
			expect(details).toMatchObject({
				id: "a_00000001",
				state: "running",
				queuedFollowUps: 1,
				startLine: 2,
				endLine: 2,
				totalLines: 3,
				nextOffset: 3
			})
			expect(result.content[0]?.text).toContain("second\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]")

			await expect(captured.tools.get("task_output")?.execute("nested", { id: "a_10000001" }, undefined, ctx)).rejects.toThrow(
				"Unknown Task Reference"
			)
			await expect(captured.tools.get("task_output")?.execute("discarded", { id: "a_00000002" }, undefined, ctx)).rejects.toThrow(
				"discarded"
			)
			await captured.shutdown?.({ reason: "quit" }, ctx)
		})
	})

	test("returns the complete list without pagination or truncation", () => {
		const rows = Array.from({ length: 100 }, (_, index) => largeRow(index))
		const result = buildTaskListToolResult({ rows, diagnostics: [] })
		expect(result.details.tasks).toHaveLength(100)
		expect(result.details.total).toBe(100)
		expect(result.content[0].text).toContain(`id: ${rows[99]?.id}`)
	})
})

type TaskFixture = {
	id: string
	childSessionId: string
	label: string
	state: TaskMetadata["state"]
	updatedAt: number
	outcome?: TaskMetadata["latestOutcome"]
	output?: string
	queuedFollowUps?: number
	discarded?: boolean
}

async function createTask(cwd: string, parentSessionId: string, fixture: TaskFixture): Promise<TaskStoragePaths> {
	const parent = await ensureParentStorage(cwd, parentSessionId)
	const paths = await reserveTaskStorage(parent, () => fixture.id)
	await initializeRetainedLogs(paths)
	await writeTaskMetadata(paths, taskMetadata(paths, fixture))
	if (fixture.output) await writeFile(paths.output, fixture.output, "utf8")
	return paths
}

function taskMetadata(paths: TaskStoragePaths, fixture: TaskFixture): TaskMetadata {
	const activeState = fixture.state === "running" || fixture.state === "queued" || fixture.state === "suspended" ? fixture.state : null
	const queuedFollowUps = Array.from({ length: fixture.queuedFollowUps ?? 0 }, (_, index) => ({
		id: `r_${String(index + 2).padStart(16, "0")}`,
		sequence: index + 2,
		content: `Follow-up ${index + 1}`,
		acceptedAt: fixture.updatedAt
	}))
	return {
		version: TASK_METADATA_VERSION,
		kind: "agent",
		taskRef: paths.taskRef,
		parentSessionId: paths.parentSessionId,
		childSessionId: fixture.childSessionId,
		definitionName: "reviewer",
		label: fixture.label,
		model: { provider: "anthropic", id: "sonnet" },
		thinking: "high",
		depth: 1,
		allowAgents: false,
		state: fixture.state,
		latestOutcome: fixture.outcome ?? null,
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
		createdAt: 1,
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

function captureTaskTools(): {
	tools: Map<string, CapturedTool>
	shutdown?: (event: { reason: "quit" | "reload" }, ctx: ExtensionContext) => Promise<void>
} {
	const tools = new Map<string, CapturedTool>()
	let shutdown: ((event: { reason: "quit" | "reload" }, ctx: ExtensionContext) => Promise<void>) | undefined
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
		on(event: string, handler: (event: { reason: "quit" | "reload" }, ctx: ExtensionContext) => Promise<void>) {
			if (event === "session_shutdown") shutdown = handler
		}
	} as unknown as ExtensionAPI
	registerTaskTools(api)
	return { tools, ...(shutdown ? { shutdown } : {}) }
}

function taskContext(cwd: string): ExtensionContext {
	return {
		cwd,
		sessionManager: { getSessionId: () => "parent-session" }
	} as unknown as ExtensionContext
}

function largeRow(index: number): TaskListRow {
	const id = `a_${index.toString(16).padStart(8, "0")}`
	const longPath = `.pi/lovely-agents/parent-session/${id}/${"p".repeat(1_000)}`
	return {
		id,
		kind: "agent",
		label: "l".repeat(80),
		definition: "reviewer",
		state: "idle",
		latestOutcome: "succeeded",
		model: "anthropic/sonnet",
		thinking: "high",
		createdAt: index,
		updatedAt: index,
		acceptedAt: null,
		startedAt: null,
		detachedAt: null,
		queuedFollowUps: 0,
		outputLines: 1,
		paths: { output: `${longPath}/output.md`, activity: `${longPath}/activity.md`, session: `${longPath}/session.jsonl` },
		descendants: {
			total: 0,
			states: { idle: 0, queued: 0, running: 0, suspended: 0, interrupted: 0 },
			outcomes: { succeeded: 0, failed: 0, stopped: 0, interrupted: 0 },
			activeLabels: []
		}
	}
}
