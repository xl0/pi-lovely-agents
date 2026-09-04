import { describe, expect, test } from "bun:test"
import { readFile, stat, writeFile } from "node:fs/promises"
import { getAgentCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import { reconcileParentTasks, stopOwnedTaskTree } from "../../extensions/lovely-agents/lifecycle.js"
import {
	ensureParentStorage,
	initializeRetainedLogs,
	readTaskMetadata,
	releaseParentLeaseFor,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	type TaskMetadata,
	type TaskStoragePaths,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import { withTempWorkspace } from "./test-helpers.js"

describe("task lifecycle recovery", () => {
	test("marks stale accepted work interrupted and records one notification", async () => {
		await withTempWorkspace(async workspace => {
			const paths = await createTask(workspace.cwd, "parent", "a_11111111", "child", "running")
			const result = await reconcileParentTasks(workspace.cwd, "parent")
			expect(result).toEqual({ interrupted: 1, diagnostics: [] })
			const loaded = await readTaskMetadata(paths)
			expect(loaded.status === "ok" ? loaded.metadata : null).toMatchObject({
				state: "interrupted",
				latestOutcome: "interrupted",
				activeRun: null,
				queuedFollowUps: [],
				notifications: [{ id: "a_11111111:r_1111111111111111:interruption", type: "interruption" }]
			})
			expect(await readFile(paths.output, "utf8")).toContain("interrupted")
			expect(await reconcileParentTasks(workspace.cwd, "parent")).toEqual({ interrupted: 0, diagnostics: [] })
			const repeated = await readTaskMetadata(paths)
			expect(repeated.status === "ok" ? repeated.metadata.notifications : []).toHaveLength(1)
			await releaseParentLeaseFor(workspace.cwd, "parent")
		})
	})

	test("recursively stops retained work and clears queued follow-ups", async () => {
		await withTempWorkspace(async workspace => {
			const direct = await createTask(workspace.cwd, "parent", "a_22222222", "child", "running")
			const nested = await createTask(workspace.cwd, "child", "a_33333333", "grandchild", "suspended")
			await stopOwnedTaskTree(workspace.cwd, "parent")
			for (const paths of [direct, nested]) {
				const loaded = await readTaskMetadata(paths)
				expect(loaded.status === "ok" ? loaded.metadata : null).toMatchObject({
					state: "idle",
					latestOutcome: "stopped",
					activeRun: null,
					queuedFollowUps: []
				})
			}
			expect(await releaseParentLeaseFor(workspace.cwd, "parent")).toBe(false)
			expect(await releaseParentLeaseFor(workspace.cwd, "child")).toBe(false)
		})
	})

	test("reconciles queued, running, and suspended state while preserving stable records", async () => {
		await withTempWorkspace(async workspace => {
			const fixtures = [
				["a_50000001", "queued"],
				["a_50000002", "running"],
				["a_50000003", "suspended"],
				["a_50000004", "idle"],
				["a_50000005", "interrupted"]
			] as const
			const paths = await Promise.all(
				fixtures.map(([id, state], index) => createTask(workspace.cwd, "parent", id, `child-${index}`, state))
			)
			expect((await reconcileParentTasks(workspace.cwd, "parent")).interrupted).toBe(3)
			const states = await Promise.all(
				paths.map(async path => {
					const loaded = await readTaskMetadata(path)
					return loaded.status === "ok" ? loaded.metadata.state : null
				})
			)
			expect(states).toEqual(["interrupted", "interrupted", "interrupted", "idle", "interrupted"])
			await releaseParentLeaseFor(workspace.cwd, "parent")
		})
	})

	test("does not interrupt a process-resident run", async () => {
		await withTempWorkspace(async workspace => {
			const paths = await createTask(workspace.cwd, "parent", "a_44444444", "child", "queued")
			const unbind = getAgentCoordinator().bindResident(paths.taskDirectory, {
				stop: async () => {},
				dispose: () => {}
			})
			try {
				expect(await reconcileParentTasks(workspace.cwd, "parent")).toEqual({ interrupted: 0, diagnostics: [] })
				const loaded = await readTaskMetadata(paths)
				expect(loaded.status === "ok" ? loaded.metadata.state : null).toBe("queued")
			} finally {
				unbind()
				await releaseParentLeaseFor(workspace.cwd, "parent")
			}
		})
	})

	test("reports malformed direct records without deleting orphaned files", async () => {
		await withTempWorkspace(async workspace => {
			const paths = await reserveTaskStorage(await ensureParentStorage(workspace.cwd, "parent"), () => "a_66666666")
			await initializeRetainedLogs(paths)
			await writeFile(paths.metadata, "{}\n", "utf8")
			const result = await reconcileParentTasks(workspace.cwd, "parent")
			expect(result.interrupted).toBe(0)
			expect(result.diagnostics).toHaveLength(1)
			expect((await stat(paths.taskDirectory)).isDirectory()).toBe(true)
			await releaseParentLeaseFor(workspace.cwd, "parent")
		})
	})
})

async function createTask(
	cwd: string,
	parentSessionId: string,
	id: string,
	childSessionId: string,
	state: TaskMetadata["state"]
): Promise<TaskStoragePaths> {
	const paths = await reserveTaskStorage(await ensureParentStorage(cwd, parentSessionId), () => id)
	await initializeRetainedLogs(paths)
	await writeTaskMetadata(paths, {
		version: TASK_METADATA_VERSION,
		kind: "agent",
		taskRef: id,
		parentSessionId,
		childSessionId,
		definitionName: "reviewer",
		label: id,
		createdAt: 1,
		updatedAt: 1,
		state,
		latestOutcome: state === "interrupted" ? "interrupted" : null,
		activeRun:
			state === "idle" || state === "interrupted"
				? null
				: {
						id: "r_1111111111111111",
						sequence: 1,
						kind: "initial",
						state,
						input: "work",
						acceptedAt: 1,
						...(state === "queued" ? {} : { startedAt: 2 })
					},
		lastRunSequence: 2,
		model: { provider: "provider", id: "model" },
		thinking: "medium",
		allowAgents: false,
		sessionConfig: {
			systemPrompt: "Review work.",
			tools: null,
			excludeAgentsMd: false,
			scopedModels: [{ provider: "provider", id: "model" }]
		},
		depth: 1,
		queuedFollowUps: [{ id: "r_2222222222222222", sequence: 2, content: "later", acceptedAt: 2 }],
		notifications: [],
		discardedAt: null
	} satisfies TaskMetadata)
	return paths
}
