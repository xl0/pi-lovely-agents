import { expect, test } from "bun:test"
import { lstat, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pruneTasks } from "../../extensions/lovely-agents/prune.js"
import {
	acquireParentLease,
	ensureParentStorage,
	holdsParentLease,
	mutateTaskMetadata,
	parentStoragePaths,
	releaseParentLease,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	type TaskMetadata,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import { withTempWorkspace } from "./test-helpers.js"

test("pruning defaults to dry-run, deletes only explicit tombstones, and is idempotent", async () => {
	await withTempWorkspace(async workspace => {
		const discarded = await task(workspace.cwd, "parent", "b_11111111", { discardedAt: 2 })
		const idle = await task(workspace.cwd, "parent", "b_22222222")
		const stale = await task(workspace.cwd, "parent", "b_33333333", {
			state: "running",
			activeRun: {
				id: "r_1111111111111111",
				sequence: 1,
				kind: "initial",
				state: "running",
				input: "old work",
				acceptedAt: 1,
				startedAt: 1
			}
		})
		await writeFile(discarded.output, "retained output")
		// Browsing index left by 0.1.2 must not block pruning.
		await mkdir(join(discarded.parentDirectory, "active"))
		const dry = await pruneTasks(workspace.cwd)
		expect(dry.candidates).toEqual([discarded.taskDirectory])
		expect(dry.deleted).toEqual([])
		expect(await readFile(discarded.output, "utf8")).toBe("retained output")
		const applied = await pruneTasks(workspace.cwd, true)
		expect(applied.deleted).toEqual([discarded.taskDirectory])
		await expect(lstat(discarded.taskDirectory)).rejects.toMatchObject({ code: "ENOENT" })
		for (const paths of [idle, stale]) expect((await lstat(paths.taskDirectory)).isDirectory()).toBe(true)
		expect((await pruneTasks(workspace.cwd, true)).deleted).toEqual([])
	})
})

test("pruning retains pending notices, unknown schemas, corrupt metadata and symlink artifacts", async () => {
	await withTempWorkspace(async workspace => {
		const pending = await task(workspace.cwd, "parent", "b_11111111", {
			discardedAt: 2,
			notifications: [{ id: "notice", runId: "r_1111111111111111", type: "completion", content: "evidence", createdAt: 1 }]
		})
		const unsupported = await task(workspace.cwd, "parent", "b_22222222")
		await writeFile(
			unsupported.metadata,
			JSON.stringify({ version: 99, kind: "bash", taskRef: unsupported.taskRef, parentSessionId: "parent" })
		)
		const corrupt = await task(workspace.cwd, "parent", "b_33333333", { discardedAt: 2 })
		await writeFile(corrupt.metadata, "{broken")
		const unsafe = await task(workspace.cwd, "parent", "b_44444444", { discardedAt: 2 })
		await symlink(workspace.agentDir, join(unsafe.taskDirectory, "escape"))
		const result = await pruneTasks(workspace.cwd, true)
		expect(result.deleted).toEqual([])
		expect(result.diagnostics).toHaveLength(4)
		for (const paths of [pending, unsupported, corrupt, unsafe]) expect((await lstat(paths.taskDirectory)).isDirectory()).toBe(true)
	})
})

test("retained or corrupt descendants block owner removal; eligible trees delete descendants first", async () => {
	await withTempWorkspace(async workspace => {
		const owner = await task(workspace.cwd, "parent", "a_11111111", { discardedAt: 2 }, "child")
		const child = await task(workspace.cwd, "child", "b_22222222")
		expect((await pruneTasks(workspace.cwd, true)).deleted).toEqual([])
		await mutateTaskMetadata(child, metadata => ({ ...metadata, discardedAt: 2 }))
		await writeFile(join(child.parentDirectory, "orphan"), "evidence")
		expect((await pruneTasks(workspace.cwd, true)).deleted).toEqual([child.taskDirectory])
		expect((await lstat(owner.taskDirectory)).isDirectory()).toBe(true)
		await unlink(join(child.parentDirectory, "orphan"))
		const second = await task(workspace.cwd, "child", "b_33333333", { discardedAt: 2 })
		expect((await pruneTasks(workspace.cwd, true)).deleted).toEqual([second.taskDirectory, owner.taskDirectory])
	})
})

test("pruning refuses another process's live lease and keeps this process's own", async () => {
	await withTempWorkspace(async workspace => {
		const owner = await task(workspace.cwd, "parent", "a_11111111", { discardedAt: 2 }, "child")
		await task(workspace.cwd, "child", "b_22222222", { discardedAt: 2 })
		const foreign = `${JSON.stringify({ version: 1, pid: process.ppid, token: "f".repeat(32), createdAt: 1 })}\n`
		const childLease = parentStoragePaths(workspace.cwd, "child").lease
		await writeFile(childLease, foreign, { mode: 0o600 })
		const refused = await pruneTasks(workspace.cwd, true)
		expect(refused.deleted).toEqual([])
		expect(refused.diagnostics.join()).toContain("owned by live process")
		expect(await readFile(childLease, "utf8")).toBe(foreign)
		await unlink(childLease)

		// The session running the command owns its partition; pruning must not release it.
		const own = await acquireParentLease(workspace.cwd, "parent")
		expect((await pruneTasks(workspace.cwd, true)).deleted).toHaveLength(2)
		await expect(lstat(owner.taskDirectory)).rejects.toMatchObject({ code: "ENOENT" })
		expect(await holdsParentLease(workspace.cwd, "parent")).toBe(true)
		expect(await holdsParentLease(workspace.cwd, "child")).toBe(false)
		await releaseParentLease(own)
	})
})

test("pruning refuses corrupt or linked descendants and ambiguous ownership", async () => {
	await withTempWorkspace(async workspace => {
		const owner = await task(workspace.cwd, "parent", "a_11111111", { discardedAt: 2 }, "child")
		const child = await task(workspace.cwd, "child", "b_22222222", { discardedAt: 2 })
		const original = await readFile(child.metadata, "utf8")
		await writeFile(child.metadata, "{}")
		expect((await pruneTasks(workspace.cwd, true)).deleted).toEqual([])
		await writeFile(child.metadata, original)
		await rm(child.taskDirectory, { recursive: true })
		await symlink(workspace.agentDir, child.taskDirectory)
		expect((await pruneTasks(workspace.cwd, true)).deleted).toEqual([])
		await unlink(child.taskDirectory)
		await task(workspace.cwd, "other", "a_33333333", { discardedAt: 2 }, "child")
		await task(workspace.cwd, "child", "b_44444444", { discardedAt: 2 })
		expect((await pruneTasks(workspace.cwd, true)).deleted).toEqual([])
		expect((await lstat(owner.taskDirectory)).isDirectory()).toBe(true)
	})
})

test("cyclic ownership and symlinked root storage are never pruned", async () => {
	await withTempWorkspace(async workspace => {
		const owner = await task(workspace.cwd, "parent", "a_11111111", { discardedAt: 2 }, "child")
		await task(workspace.cwd, "child", "a_22222222", { discardedAt: 2 }, "parent")
		expect((await pruneTasks(workspace.cwd, true)).deleted).toEqual([])
		await symlink(join(workspace.cwd, ".pi"), join(workspace.agentDir, ".pi"))
		const result = await pruneTasks(workspace.agentDir, true)
		expect(result.deleted).toEqual([])
		expect(result.diagnostics.join()).toContain("Unsafe storage directory")
		expect((await lstat(owner.taskDirectory)).isDirectory()).toBe(true)
	})
})

async function task(cwd: string, parent: string, id: string, patch: Partial<TaskMetadata> = {}, child?: string) {
	const paths = await reserveTaskStorage(await ensureParentStorage(cwd, parent), () => id)
	await writeTaskMetadata(paths, {
		version: TASK_METADATA_VERSION,
		...(child
			? {
					kind: "agent",
					childSessionId: child,
					definitionName: "reviewer",
					model: { provider: "p", id: "m" },
					thinking: "off",
					depth: 1,
					allowAgents: false,
					sessionConfig: { systemPrompt: "Review", tools: null, excludeAgentsMd: false, scopedModels: [] }
				}
			: { kind: "bash", command: "true", cwd, exitCode: null, signal: null }),
		taskRef: id,
		parentSessionId: parent,
		label: "task",
		state: "idle",
		latestOutcome: null,
		latestReply: null,
		lastRunSequence: 1,
		activeRun: null,
		queuedFollowUps: [],
		notifications: [],
		discardedAt: null,
		createdAt: 1,
		updatedAt: 2,
		...patch
	} as TaskMetadata)
	return paths
}
