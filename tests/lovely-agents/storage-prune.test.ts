import { expect, spyOn, test } from "bun:test"
import { lstat, mkdir, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
	acquireParentLease,
	ensureParentStorage,
	mutateTaskMetadata,
	releaseParentLease,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	type TaskMetadata,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import {
	readTaskDiscardMarker,
	rebuildActiveTaskLinks,
	syncActiveTaskLink,
	writeTaskDiscardMarker
} from "../../extensions/lovely-agents/storage.js"
import { pruneTasks } from "../../scripts/prune-tasks.js"
import { withTempWorkspace } from "./test-helpers.js"

test("active index includes idle tasks, rebuilds missing links and removes only index symlinks", async () => {
	await withTempWorkspace(async workspace => {
		const paths = await task(workspace.cwd, "parent", "b_11111111")
		await syncActiveTaskLink(paths, false)
		const active = join(paths.parentDirectory, "active")
		const link = join(active, paths.taskRef)
		expect(await readlink(link)).toBe(`../${paths.taskRef}`)
		await syncActiveTaskLink(paths, false)
		await unlink(link)
		await symlink("../b_99999999", join(active, "b_99999999"))
		await writeFile(join(active, "notes"), "not ours")
		expect(await rebuildActiveTaskLinks(paths)).toEqual([])
		expect(await readlink(link)).toBe(`../${paths.taskRef}`)
		await expect(lstat(join(active, "b_99999999"))).rejects.toMatchObject({ code: "ENOENT" })
		await mutateTaskMetadata(paths, metadata => ({ ...metadata, discardedAt: 2 }))
		expect(await rebuildActiveTaskLinks(paths)).toEqual([])
		await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" })
		expect(await readFile(join(active, "notes"), "utf8")).toBe("not ours")
		expect((await lstat(paths.taskDirectory)).isDirectory()).toBe(true)
	})
})

test("index repair never follows symlinks or replaces non-link evidence", async () => {
	await withTempWorkspace(async workspace => {
		const paths = await task(workspace.cwd, "parent", "b_11111111")
		await syncActiveTaskLink(paths, false)
		const link = join(paths.parentDirectory, "active", paths.taskRef)
		await unlink(link)
		await symlink(workspace.agentDir, link)
		await syncActiveTaskLink(paths, false)
		expect(await readlink(link)).toBe(`../${paths.taskRef}`)
		await unlink(link)
		await writeFile(link, "evidence")
		expect(await syncActiveTaskLink(paths, true)).toContain("not a symlink")
		expect(await readFile(link, "utf8")).toBe("evidence")
	})
})

test("ancillary index failure cannot turn committed metadata acceptance into failure", async () => {
	await withTempWorkspace(async workspace => {
		const parent = await ensureParentStorage(workspace.cwd, "parent")
		await writeFile(join(parent.parentDirectory, "active"), "keep this evidence")
		const warning = spyOn(console, "warn").mockImplementation(() => {})
		try {
			const paths = await task(workspace.cwd, "parent", "b_11111111")
			await mutateTaskMetadata(paths, metadata => ({ ...metadata, discardedAt: 2 }))
			expect(JSON.parse(await readFile(paths.metadata, "utf8")).discardedAt).toBe(2)
			expect(warning).toHaveBeenCalled()
			expect(await readFile(join(parent.parentDirectory, "active"), "utf8")).toBe("keep this evidence")
		} finally {
			warning.mockRestore()
		}
	})
})

test("discard markers reject symlinks and changed ownership without rewriting unknown schemas", async () => {
	await withTempWorkspace(async workspace => {
		const paths = await task(workspace.cwd, "parent", "b_11111111")
		const original = JSON.stringify({ version: 99, kind: "bash", taskRef: paths.taskRef, parentSessionId: "parent" })
		await writeFile(paths.metadata, original)
		await rm(join(paths.parentDirectory, "active"), { recursive: true })
		expect((await rebuildActiveTaskLinks(paths)).join()).toContain("Unsupported metadata version")
		expect(await readlink(join(paths.parentDirectory, "active", paths.taskRef))).toBe(`../${paths.taskRef}`)
		await writeTaskDiscardMarker(paths)
		await writeTaskDiscardMarker(paths)
		expect(await readTaskDiscardMarker(paths)).toBe(true)
		expect(await rebuildActiveTaskLinks(paths)).toEqual([])
		await expect(lstat(join(paths.parentDirectory, "active", paths.taskRef))).rejects.toMatchObject({ code: "ENOENT" })
		expect(await readFile(paths.metadata, "utf8")).toBe(original)
		await writeFile(paths.metadata, original.replace('"parent"', '"foreign"'))
		await expect(readTaskDiscardMarker(paths)).rejects.toThrow("identity")
		await writeFile(paths.metadata, original)
		const marker = join(paths.taskDirectory, ".discarded.json")
		const source = await readFile(marker, "utf8")
		await unlink(marker)
		const outside = join(workspace.agentDir, "marker")
		await writeFile(outside, source)
		await symlink(outside, marker)
		await expect(readTaskDiscardMarker(paths)).rejects.toThrow()
		expect(await readFile(outside, "utf8")).toBe(source)
	})
})

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
		const archive = join(discarded.root, "archive")
		await mkdir(archive)
		await writeFile(join(archive, "legacy-evidence"), "untouched")
		const dry = await pruneTasks(workspace.cwd)
		expect(dry.candidates).toEqual([discarded.taskDirectory])
		expect(dry.deleted).toEqual([])
		expect(await readFile(discarded.output, "utf8")).toBe("retained output")
		const [applied, overlapping] = await Promise.all([pruneTasks(workspace.cwd, true), pruneTasks(workspace.cwd, true)])
		expect(applied.deleted).toEqual([discarded.taskDirectory])
		expect(overlapping.deleted).toEqual([])
		expect(overlapping.diagnostics.join()).toContain("already running")
		await expect(lstat(discarded.taskDirectory)).rejects.toMatchObject({ code: "ENOENT" })
		for (const paths of [idle, stale]) expect((await lstat(paths.taskDirectory)).isDirectory()).toBe(true)
		expect((await pruneTasks(workspace.cwd, true)).deleted).toEqual([])
		expect(await readFile(join(archive, "legacy-evidence"), "utf8")).toBe("untouched")
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
		await writeTaskDiscardMarker(unsupported)
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

test("pruning refuses live parent or descendant leases without releasing another owner's lease", async () => {
	await withTempWorkspace(async workspace => {
		const owner = await task(workspace.cwd, "parent", "a_11111111", { discardedAt: 2 }, "child")
		await task(workspace.cwd, "child", "b_22222222", { discardedAt: 2 })
		for (const id of ["parent", "child"]) {
			const lease = await acquireParentLease(workspace.cwd, id)
			try {
				const original = await readFile(lease.paths.lease, "utf8")
				const result = await pruneTasks(workspace.cwd, true)
				expect(result.deleted).toEqual([])
				expect(result.diagnostics.join()).toContain("already open")
				expect(await readFile(lease.paths.lease, "utf8")).toBe(original)
				const child = Bun.spawn(["bun", join(import.meta.dir, "../../scripts/prune-tasks.ts"), workspace.cwd, "--apply"], {
					stdout: "pipe",
					stderr: "pipe"
				})
				expect(await child.exited).toBe(0)
				expect(await new Response(child.stderr).text()).toContain("owned by live process")
				expect(await readFile(lease.paths.lease, "utf8")).toBe(original)
			} finally {
				await releaseParentLease(lease)
			}
		}
		expect((await lstat(owner.taskDirectory)).isDirectory()).toBe(true)
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

test("standalone pruning requires explicit --apply and rejects unknown flags", async () => {
	await withTempWorkspace(async workspace => {
		const paths = await task(workspace.cwd, "parent", "b_11111111", { discardedAt: 2 })
		const script = join(import.meta.dir, "../../scripts/prune-tasks.ts")
		for (const args of [[workspace.cwd], ["--unknown"]]) {
			const process = Bun.spawn(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" })
			const output = await new Response(process.stdout).text()
			expect(await process.exited).toBe(args[0] === "--unknown" ? 1 : 0)
			if (args[0] !== "--unknown") expect(output).toContain("Would delete")
			expect((await lstat(paths.taskDirectory)).isDirectory()).toBe(true)
		}
		const process = Bun.spawn(["bun", script, workspace.cwd, "--apply"], { stdout: "pipe", stderr: "pipe" })
		expect(await process.exited).toBe(0)
		expect(await new Response(process.stdout).text()).toContain("Deleted")
		await expect(lstat(paths.taskDirectory)).rejects.toMatchObject({ code: "ENOENT" })
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
