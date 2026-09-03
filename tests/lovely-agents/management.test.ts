import { describe, expect, test } from "bun:test"
import { readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
	clearFixtureTasks,
	renderDefinition,
	seedFixtureEdgeCases,
	seedFixtureTasks,
	seedLiveFixtureTask
} from "../../extensions/lovely-agents/management.js"
import {
	countRetainedOutputLines,
	ensureParentStorage,
	readRetainedOutput,
	readTaskMetadata,
	releaseParentLeaseFor,
	reserveTaskStorage,
	taskStoragePaths
} from "../../extensions/lovely-agents/state.js"
import { withTempWorkspace } from "./test-helpers.js"

describe("management fixtures", () => {
	test("renders the Agent Definition body in its preview", () => {
		const preview = renderDefinition({
			name: "reviewer",
			description: "Review changes",
			systemPrompt: "Inspect the complete diff.\nReport concrete defects.",
			source: "project",
			filePath: "/workspace/.pi/agents/reviewer.md",
			displayPath: ".pi/agents/reviewer.md"
		})
		expect(preview).toContain("Body:\nInspect the complete diff.\nReport concrete defects.")
	})

	test("seeds every visible state and removes only marked fixtures", async () => {
		await withTempWorkspace(async workspace => {
			const ids = await seedFixtureTasks(workspace.cwd, "parent-session")
			expect(ids).toHaveLength(7)
			expect(ids.every(id => /^a_[0-9a-f]{8}$/.test(id))).toBe(true)

			const parent = await ensureParentStorage(workspace.cwd, "parent-session")
			const loaded = await Promise.all(ids.map(id => readTaskMetadata(taskStoragePaths(parent, id))))
			const metadata = loaded.flatMap(result => (result.status === "ok" ? [result.metadata] : []))
			expect(metadata.map(task => task.state).sort()).toEqual(["idle", "idle", "idle", "interrupted", "queued", "running", "suspended"])
			expect(
				metadata
					.map(task => task.latestOutcome)
					.filter(Boolean)
					.sort()
			).toEqual(["failed", "interrupted", "stopped", "succeeded"])
			expect(metadata.every(task => task.definitionName === "lovely-fixture")).toBe(true)
			expect(await Promise.all(ids.map(id => countRetainedOutputLines(taskStoragePaths(parent, id))))).not.toContain(0)

			const foreignFixture = await reserveTaskStorage(parent, () => "a_ffffffff")
			await writeFile(join(foreignFixture.taskDirectory, ".fixture"), "another-parent")
			expect(await clearFixtureTasks(workspace.cwd, "parent-session")).toBe(7)
			expect((await stat(foreignFixture.taskDirectory)).isDirectory()).toBe(true)
			const first = ids[0]
			if (!first) throw new Error("Fixture task was not created")
			await expect(stat(taskStoragePaths(parent, first).taskDirectory)).rejects.toMatchObject({ code: "ENOENT" })
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("seeds nested, queued, discarded, corrupt, and large-output cases", async () => {
		await withTempWorkspace(async workspace => {
			const ids = await seedFixtureEdgeCases(workspace.cwd, "parent-session")
			expect(ids).toHaveLength(3)
			const [showcaseId, discardedId, corruptId] = ids
			if (!showcaseId || !discardedId || !corruptId) throw new Error("Edge-case fixtures were not created")
			const parent = await ensureParentStorage(workspace.cwd, "parent-session")
			const showcase = await readTaskMetadata(taskStoragePaths(parent, showcaseId))
			expect(showcase.status).toBe("ok")
			if (showcase.status !== "ok") throw new Error("Showcase fixture is invalid")
			expect(showcase.metadata.queuedFollowUps).toHaveLength(1)
			expect((await stat(taskStoragePaths(parent, showcaseId).output)).size).toBeGreaterThan(50_000)

			const descendantParent = await ensureParentStorage(workspace.cwd, showcase.metadata.childSessionId)
			const descendants = (await readdir(descendantParent.parentDirectory)).filter(name => /^a_[0-9a-f]{8}$/.test(name))
			expect(descendants).toHaveLength(1)
			const discarded = await readTaskMetadata(taskStoragePaths(parent, discardedId))
			expect(discarded.status).toBe("ok")
			if (discarded.status !== "ok") throw new Error("Discarded fixture is invalid")
			expect(discarded.metadata.discardedAt).not.toBeNull()
			expect((await readTaskMetadata(taskStoragePaths(parent, corruptId))).status).toBe("invalid")

			expect(await clearFixtureTasks(workspace.cwd, "parent-session")).toBe(4)
			expect((await readdir(descendantParent.parentDirectory)).filter(name => /^a_[0-9a-f]{8}$/.test(name))).toHaveLength(0)
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("live fixtures produce observable output growth", async () => {
		await withTempWorkspace(async workspace => {
			const id = await seedLiveFixtureTask(workspace.cwd, "parent-session")
			const parent = await ensureParentStorage(workspace.cwd, "parent-session")
			const paths = taskStoragePaths(parent, id)
			const nextOffset = (await countRetainedOutputLines(paths)) + 1
			const update = await readRetainedOutput(paths, { offset: nextOffset, waitMs: 2_000 })
			expect(update.timedOut).toBe(false)
			expect(update.text).toContain("Fixture update 1")
			let completion = update
			for (let attempt = 0; attempt < 6 && completion.state !== "idle"; attempt++) {
				completion = await readRetainedOutput(paths, { offset: completion.nextOffset, waitMs: 1_000 })
			}
			expect(completion.timedOut).toBe(false)
			expect(completion.state).toBe("idle")
			expect(await clearFixtureTasks(workspace.cwd, "parent-session")).toBe(1)
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})
})
