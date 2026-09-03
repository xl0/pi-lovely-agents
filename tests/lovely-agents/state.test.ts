import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
	createTaskReference,
	ensureParentStorage,
	mutateTaskMetadata,
	parentStoragePaths,
	readTaskMetadata,
	reserveTaskStorage,
	STORAGE_GITIGNORE,
	TASK_METADATA_VERSION,
	type TaskMetadata,
	type TaskStoragePaths,
	taskStoragePaths,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import { withTempWorkspace } from "./test-helpers.js"

describe("private task storage", () => {
	test("creates private parent storage and preserves an existing gitignore", async () => {
		await withTempWorkspace(async workspace => {
			const configDirectory = join(workspace.cwd, ".pi")
			await mkdir(configDirectory, { mode: 0o755 })
			if (process.platform !== "win32") await chmod(configDirectory, 0o755)
			const paths = await ensureParentStorage(workspace.cwd, "parent-session")
			expect(await readFile(join(paths.root, ".gitignore"), "utf8")).toBe(STORAGE_GITIGNORE)
			if (process.platform !== "win32") {
				expect((await stat(configDirectory)).mode & 0o777).toBe(0o755)
				expect((await stat(paths.root)).mode & 0o077).toBe(0)
				expect((await stat(paths.parentDirectory)).mode & 0o077).toBe(0)
				expect((await stat(join(paths.root, ".gitignore"))).mode & 0o077).toBe(0)
			}

			await writeFile(join(paths.root, ".gitignore"), "custom\n", "utf8")
			await ensureParentStorage(workspace.cwd, "parent-session")
			expect(await readFile(join(paths.root, ".gitignore"), "utf8")).toBe("custom\n")
		})
	})

	test("rejects unsafe identifiers and storage redirected outside the workspace", async () => {
		expect(() => parentStoragePaths("/tmp/project", "../other")).toThrow("Invalid parent session ID")
		const parent = parentStoragePaths("/tmp/project", "parent")
		expect(() => taskStoragePaths(parent, "a_../../etc")).toThrow("Invalid Task Reference")

		if (process.platform === "win32") return
		await withTempWorkspace(async workspace => {
			await mkdir(join(workspace.cwd, ".pi"), { recursive: true })
			await symlink(workspace.agentDir, join(workspace.cwd, ".pi", "lovely-agents"), "dir")
			await expect(ensureParentStorage(workspace.cwd, "parent")).rejects.toThrow("not a regular directory")
		})
	})

	test("generates shaped references and retries directory collisions atomically", async () => {
		await withTempWorkspace(async workspace => {
			expect(createTaskReference()).toMatch(/^a_[0-9a-f]{8}$/)

			const parent = await ensureParentStorage(workspace.cwd, "parent")
			await mkdir(join(parent.parentDirectory, "a_deadbeef"), { mode: 0o700 })
			const references = ["a_deadbeef", "a_cafebabe"]
			const paths = await reserveTaskStorage(parent, () => references.shift() ?? "a_cafebabe")
			expect(paths.taskRef).toBe("a_cafebabe")
			if (process.platform !== "win32") expect((await stat(paths.taskDirectory)).mode & 0o077).toBe(0)
		})
	})
})

describe("task metadata", () => {
	test("atomically writes and strictly reads a versioned snapshot", async () => {
		await withTaskStorage(async paths => {
			const value = metadata(paths)
			await writeTaskMetadata(paths, value)
			expect(await readTaskMetadata(paths)).toEqual({ status: "ok", metadata: value })
			if (process.platform !== "win32") expect((await stat(paths.metadata)).mode & 0o077).toBe(0)
			expect((await readdir(paths.taskDirectory)).filter(name => name.endsWith(".tmp"))).toEqual([])
		})
	})

	test("reports malformed and unsupported snapshots without changing them", async () => {
		await withTaskStorage(async paths => {
			for (const fixture of [
				{ source: "{broken", code: "invalid-json" },
				{ source: JSON.stringify({ version: TASK_METADATA_VERSION + 1 }), code: "unsupported-version" },
				{ source: JSON.stringify({ ...metadata(paths), unexpected: true }), code: "invalid-metadata" }
			] as const) {
				await writeFile(paths.metadata, fixture.source, { mode: 0o600 })
				const result = await readTaskMetadata(paths)
				expect(result.status).toBe("invalid")
				if (result.status === "invalid") expect(result.diagnostic.code).toBe(fixture.code)
				expect(await readFile(paths.metadata, "utf8")).toBe(fixture.source)
			}
		})
	})

	test("ignores orphaned temporary files and preserves snapshots after failed mutations", async () => {
		await withTaskStorage(async paths => {
			const initial = metadata(paths)
			await writeTaskMetadata(paths, initial)
			await writeFile(join(paths.taskDirectory, ".metadata.json.interrupted.tmp"), "partial", "utf8")
			const before = await readFile(paths.metadata, "utf8")

			await expect(
				mutateTaskMetadata(paths, () => {
					throw new Error("mutation failed")
				})
			).rejects.toThrow("mutation failed")
			expect(await readFile(paths.metadata, "utf8")).toBe(before)
			expect(await readTaskMetadata(paths)).toEqual({ status: "ok", metadata: initial })
		})
	})

	test("serializes concurrent mutations in invocation order", async () => {
		await withTaskStorage(async paths => {
			await writeTaskMetadata(paths, metadata(paths))
			const observed: number[] = []
			await Promise.all(
				Array.from({ length: 20 }, (_, index) =>
					mutateTaskMetadata(paths, async current => {
						observed.push(current.lastRunSequence)
						await Bun.sleep(index % 3)
						return { ...current, lastRunSequence: current.lastRunSequence + 1, updatedAt: current.updatedAt + 1 }
					})
				)
			)
			expect(observed).toEqual(Array.from({ length: 20 }, (_, index) => index))
			const result = await readTaskMetadata(paths)
			expect(result.status === "ok" ? result.metadata.lastRunSequence : undefined).toBe(20)
		})
	})

	test("rejects invalid writes without replacing valid metadata", async () => {
		await withTaskStorage(async paths => {
			await writeTaskMetadata(paths, metadata(paths))
			const before = await readFile(paths.metadata, "utf8")
			await expect(writeTaskMetadata(paths, { ...metadata(paths), label: "" })).rejects.toThrow("/label")
			expect(await readFile(paths.metadata, "utf8")).toBe(before)
		})
	})
})

async function withTaskStorage(run: (paths: TaskStoragePaths) => Promise<void>): Promise<void> {
	await withTempWorkspace(async workspace => {
		const parent = await ensureParentStorage(workspace.cwd, "parent-session")
		const paths = await reserveTaskStorage(parent, () => "a_0123abcd")
		await run(paths)
	})
}

function metadata(paths: TaskStoragePaths): TaskMetadata {
	return {
		version: TASK_METADATA_VERSION,
		kind: "agent",
		taskRef: paths.taskRef,
		parentSessionId: paths.parentSessionId,
		childSessionId: "child-session",
		definitionName: "reviewer",
		label: "Review change",
		model: { provider: "anthropic", id: "sonnet" },
		thinking: "high",
		depth: 1,
		allowAgents: false,
		state: "idle",
		latestOutcome: null,
		lastRunSequence: 0,
		activeRun: null,
		queuedFollowUps: [],
		notifications: [],
		discardedAt: null,
		createdAt: 1,
		updatedAt: 1
	}
}
