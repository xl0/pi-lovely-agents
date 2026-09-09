import { expect, test } from "bun:test"
import { mkdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { controlTaskLifecycle } from "../../extensions/lovely-agents/agent.js"
import { getAgentCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import { ensureParentStorage, readRetainedOutput, releaseParentLeaseFor, reserveTaskStorage } from "../../extensions/lovely-agents/state.js"
import { readTaskDiscardMarker, syncActiveTaskLink } from "../../extensions/lovely-agents/storage.js"
import { loadTaskList } from "../../extensions/lovely-agents/tools.js"
import { withTempWorkspace } from "./test-helpers.js"

test("dismisses unsupported Bash identities in place without a fabricated child session and enforces kind prefixes", async () => {
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
		expect(await readFile(paths.metadata, "utf8")).toBe(original)
		expect(await readFile(paths.output, "utf8")).toBe("shell evidence")
		expect(await readTaskDiscardMarker(paths)).toBe(true)
		await expect(stat(paths.session)).rejects.toMatchObject({ code: "ENOENT" })
		await expect(readRetainedOutput(paths)).rejects.toThrow("discarded")
		await controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")
		const candidates = [paths.taskRef, "b_22222222"]
		expect((await reserveTaskStorage(parent, () => candidates.shift() ?? "b_22222222")).taskRef).toBe("b_22222222")
		await releaseParentLeaseFor(workspace.cwd, "parent")
	})
})

test("dismisses unsupported versions and descendants unchanged in place, stops residents, and never reuses their IDs", async () => {
	await withTempWorkspace(async workspace => {
		const parent = await ensureParentStorage(workspace.cwd, "parent")
		const paths = await oldTask(workspace.cwd, "parent", "a_11111111", "child")
		const child = await oldTask(workspace.cwd, "child", "a_22222222", "leaf", 99)
		const original = await readFile(paths.metadata, "utf8")
		const originalChild = await readFile(child.metadata, "utf8")
		for (const task of [paths, child]) {
			await syncActiveTaskLink(task, false)
			expect(await readlink(join(task.parentDirectory, "active", task.taskRef))).toBe(`../${task.taskRef}`)
		}
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
			expect(results[0]).toMatchObject({ discarded: true })
			expect(stopped).toBe(1)
			expect(await readFile(paths.metadata, "utf8")).toBe(original)
			expect(await readFile(child.metadata, "utf8")).toBe(originalChild)
			expect(await readFile(join(paths.taskDirectory, "output.md"), "utf8")).toBe("Retained evidence\n")
			for (const task of [paths, child]) {
				expect((await stat(task.taskDirectory)).isDirectory()).toBe(true)
				expect(await readTaskDiscardMarker(task)).toBe(true)
				await expect(readlink(join(task.parentDirectory, "active", task.taskRef))).rejects.toMatchObject({ code: "ENOENT" })
			}
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

test("invalid discard marker ownership preserves evidence and fails explicitly", async () => {
	await withTempWorkspace(async workspace => {
		const paths = await oldTask(workspace.cwd, "parent", "a_11111111", "child")
		const marker = join(paths.taskDirectory, ".discarded.json")
		await writeFile(marker, JSON.stringify({ version: 1, taskRef: paths.taskRef, parentSessionId: "foreign" }))
		await expect(controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")).rejects.toThrow("Invalid discard marker")
		expect((await stat(paths.taskDirectory)).isDirectory()).toBe(true)
		expect(await readFile(marker, "utf8")).toContain("foreign")
		await releaseParentLeaseFor(workspace.cwd, "parent")
	})
})

test("a failed resident stop leaves the task undiscarded and allows retry", async () => {
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
			expect(await readTaskDiscardMarker(paths)).toBe(false)
		} finally {
			unbind()
		}
		await controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")
		expect((await stat(paths.taskDirectory)).isDirectory()).toBe(true)
		expect(await readTaskDiscardMarker(paths)).toBe(true)
		await releaseParentLeaseFor(workspace.cwd, "parent")
	})
})

test("rejects active-directory symlinks instead of removing files outside storage", async () => {
	if (process.platform === "win32") return
	await withTempWorkspace(async workspace => {
		const paths = await oldTask(workspace.cwd, "parent", "a_11111111", "child")
		await mkdir(workspace.agentDir, { recursive: true })
		await writeFile(join(workspace.agentDir, paths.taskRef), "evidence")
		await symlink(workspace.agentDir, join(paths.parentDirectory, "active"), "dir")
		await expect(controlTaskLifecycle(context(workspace.cwd), paths.taskRef, "discard")).rejects.toThrow("not a regular directory")
		expect((await stat(paths.taskDirectory)).isDirectory()).toBe(true)
		expect(await readFile(join(workspace.agentDir, paths.taskRef), "utf8")).toBe("evidence")
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
