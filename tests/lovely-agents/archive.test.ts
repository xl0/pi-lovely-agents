import { expect, test } from "bun:test"
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { controlTaskLifecycle } from "../../extensions/lovely-agents/agent.js"
import { getAgentCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import {
	archivedTaskStoragePaths,
	ensureParentStorage,
	readRetainedOutput,
	releaseParentLeaseFor,
	reserveTaskStorage
} from "../../extensions/lovely-agents/state.js"
import { loadTaskList } from "../../extensions/lovely-agents/tools.js"
import { withTempWorkspace } from "./test-helpers.js"

test("archives unsupported Bash identities without a fabricated child session and enforces kind prefixes", async () => {
	await withTempWorkspace(async workspace => {
		const parent = await ensureParentStorage(workspace.cwd, "parent")
		const paths = await reserveTaskStorage(parent, () => "b_11111111")
		const value = { version: 99, kind: "bash", taskRef: paths.taskRef, parentSessionId: "parent", pid: 123, futureField: true }
		for (const patch of [{ kind: "agent" }, { childSessionId: "child" }]) {
			await writeFile(paths.metadata, JSON.stringify({ ...value, ...patch }))
			await expect(controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")).rejects.toThrow()
		}
		const original = JSON.stringify(value)
		await writeFile(paths.metadata, original)
		await writeFile(paths.output, "shell evidence")
		await controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")
		const archived = archivedTaskStoragePaths(paths)
		expect(await readFile(archived.metadata, "utf8")).toBe(original)
		expect(await readFile(archived.output, "utf8")).toBe("shell evidence")
		await expect(stat(archived.session)).rejects.toMatchObject({ code: "ENOENT" })
		await expect(readRetainedOutput(paths)).rejects.toThrow("discarded")
		await controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")
		const candidates = [paths.taskRef, "b_22222222"]
		expect((await reserveTaskStorage(parent, () => candidates.shift() ?? "b_22222222")).taskRef).toBe("b_22222222")
		await releaseParentLeaseFor(workspace.cwd, "parent")
	})
})

test("archives unsupported versions and descendants unchanged, stops residents, and never reuses their IDs", async () => {
	await withTempWorkspace(async workspace => {
		const parent = await ensureParentStorage(workspace.cwd, "parent")
		const paths = await oldTask(workspace.cwd, "parent", "a_11111111", "child")
		const child = await oldTask(workspace.cwd, "child", "a_22222222", "leaf", 99)
		const original = await readFile(paths.metadata, "utf8")
		const originalChild = await readFile(child.metadata, "utf8")
		let stopped = 0
		const unbind = getAgentCoordinator().bindResident(child.taskDirectory, {
			stop() {
				stopped++
			},
			dispose() {}
		})
		try {
			const ctx = context(workspace.cwd)
			const results = await Promise.all([
				controlTaskLifecycle(ctx, paths.taskRef, "discard"),
				controlTaskLifecycle(ctx, paths.taskRef, "discard")
			])
			expect(results[0]).toMatchObject({ discarded: true, archiveDirectory: ".pi/lovely-agents/archive/parent/a_11111111" })
			expect(stopped).toBe(1)
			const archived = archivedTaskStoragePaths(paths)
			expect(await readFile(archived.metadata, "utf8")).toBe(original)
			expect(await readFile(archivedTaskStoragePaths(child).metadata, "utf8")).toBe(originalChild)
			expect(await readFile(join(archived.taskDirectory, "output.md"), "utf8")).toBe("Retained evidence\n")
			await expect(stat(paths.taskDirectory)).rejects.toMatchObject({ code: "ENOENT" })
			await expect(stat(child.taskDirectory)).rejects.toMatchObject({ code: "ENOENT" })
			expect((await loadTaskList(workspace.cwd, "parent")).details).toMatchObject({ tasks: [], diagnostics: [] })
			expect(await controlTaskLifecycle(ctx, paths.taskRef, "discard")).toMatchObject({ discarded: true })
			await expect(readRetainedOutput(paths)).rejects.toThrow("discarded")
			const candidates = [paths.taskRef, "a_33333333"]
			expect((await reserveTaskStorage(parent, () => candidates.shift() ?? "a_33333333")).taskRef).toBe("a_33333333")
			await expect(controlTaskLifecycle(context(workspace.cwd, "foreign"), paths.taskRef, "discard")).rejects.toThrow(
				"Unknown Task Reference"
			)
		} finally {
			unbind()
			await releaseParentLeaseFor(workspace.cwd, "parent")
			await releaseParentLeaseFor(workspace.cwd, "foreign")
		}
	})
})

test("refuses ownership mismatches, unsafe child identities, and malformed metadata without moving files", async () => {
	await withTempWorkspace(async workspace => {
		const paths = await oldTask(workspace.cwd, "parent", "a_11111111", "child")
		const original = JSON.parse(await readFile(paths.metadata, "utf8"))
		for (const patch of [
			{ taskRef: "a_99999999" },
			{ parentSessionId: "foreign" },
			{ childSessionId: "../escape" },
			{ childSessionId: "parent" }
		]) {
			await writeFile(paths.metadata, JSON.stringify({ ...original, ...patch }))
			await expect(controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")).rejects.toThrow()
			expect((await stat(paths.taskDirectory)).isDirectory()).toBe(true)
		}
		await writeFile(paths.metadata, "{invalid")
		await expect(controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")).rejects.toThrow()
		expect(await readFile(paths.metadata, "utf8")).toBe("{invalid")
		await releaseParentLeaseFor(workspace.cwd, "parent")
	})
})

test("archive collisions preserve both copies", async () => {
	await withTempWorkspace(async workspace => {
		const paths = await oldTask(workspace.cwd, "parent", "a_11111111", "child")
		const archived = archivedTaskStoragePaths(paths)
		await mkdir(archived.taskDirectory, { recursive: true })
		await writeFile(join(archived.taskDirectory, "evidence"), "Do not overwrite")
		await expect(controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")).rejects.toThrow("Archive already exists")
		expect((await stat(paths.taskDirectory)).isDirectory()).toBe(true)
		expect(await readFile(join(archived.taskDirectory, "evidence"), "utf8")).toBe("Do not overwrite")
		await releaseParentLeaseFor(workspace.cwd, "parent")
	})
})

test("a failed resident stop leaves the task unarchived and allows retry", async () => {
	await withTempWorkspace(async workspace => {
		const paths = await oldTask(workspace.cwd, "parent", "a_11111111", "child")
		const unbind = getAgentCoordinator().bindResident(paths.taskDirectory, {
			stop() {
				throw new Error("stop failed")
			},
			dispose() {}
		})
		try {
			await expect(controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")).rejects.toThrow("stop failed")
			expect((await stat(paths.taskDirectory)).isDirectory()).toBe(true)
			await expect(stat(archivedTaskStoragePaths(paths).taskDirectory)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			unbind()
		}
		await controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")
		expect((await stat(archivedTaskStoragePaths(paths).taskDirectory)).isDirectory()).toBe(true)
		await releaseParentLeaseFor(workspace.cwd, "parent")
	})
})

test("rejects archive symlinks instead of moving files outside storage", async () => {
	if (process.platform === "win32") return
	await withTempWorkspace(async workspace => {
		const paths = await oldTask(workspace.cwd, "parent", "a_11111111", "child")
		await symlink(workspace.agentDir, join(paths.root, "archive"), "dir")
		await expect(controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")).rejects.toThrow("not a regular directory")
		expect((await stat(paths.taskDirectory)).isDirectory()).toBe(true)
		await releaseParentLeaseFor(workspace.cwd, "parent")
	})
})

function context(cwd: string, parent = "parent"): ExtensionContext {
	return { cwd, sessionManager: { getSessionId: () => parent } } as unknown as ExtensionContext
}

async function oldTask(cwd: string, parent: string, id: string, child: string, version = 2) {
	const paths = await reserveTaskStorage(await ensureParentStorage(cwd, parent), () => id)
	await writeFile(
		paths.metadata,
		JSON.stringify({
			version,
			taskRef: id,
			parentSessionId: parent,
			childSessionId: child,
			state: "idle",
			futureField: "preserve"
		})
	)
	await writeFile(join(paths.taskDirectory, "output.md"), "Retained evidence\n")
	return paths
}
