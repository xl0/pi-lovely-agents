import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, mkdir, open, readdir, readlink, symlink, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
	type ParentStoragePaths,
	readTaskIdentity,
	readTaskMetadata,
	SESSION_ID_PATTERN,
	TASK_REFERENCE_PATTERN,
	type TaskStoragePaths,
	taskStoragePaths
} from "./state.js"
import { publishTaskUpdate } from "./updates.js"

/** Ancillary index failures are warnings, never failures of an already committed metadata write. */
export async function syncActiveTaskLink(paths: TaskStoragePaths, discarded: boolean): Promise<string | undefined> {
	try {
		await assertCanonicalTaskDirectory(paths)
		const directory = join(paths.parentDirectory, "active")
		if (!discarded) {
			try {
				await mkdir(directory, { mode: 0o700 })
			} catch (error) {
				if (!hasCode(error, "EEXIST")) throw error
			}
		}
		if (!(await optionalDirectory(directory))) return
		const path = join(directory, paths.taskRef)
		try {
			const stats = await lstat(path)
			if (!stats.isSymbolicLink()) throw new Error(`Active task index entry is not a symlink: ${path}`)
			if (discarded) await unlink(path)
			else if ((await readlink(path)) !== `../${paths.taskRef}`) {
				await unlink(path)
				await symlink(`../${paths.taskRef}`, path, "dir")
			}
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error
			if (!discarded) await symlink(`../${paths.taskRef}`, path, "dir")
		}
	} catch (error) {
		return errorMessage(error)
	}
}

/** Rebuild only recognized index links, never touching unexpected files or canonical records. */
export async function rebuildActiveTaskLinks(parent: ParentStoragePaths): Promise<string[]> {
	const diagnostics: string[] = []
	await assertStorageDirectory(parent)
	const expected = new Set<string>()
	for (const entry of await readdir(parent.parentDirectory, { withFileTypes: true })) {
		if (!TASK_REFERENCE_PATTERN.test(entry.name)) continue
		const paths = taskStoragePaths(parent, entry.name)
		try {
			await assertCanonicalTaskDirectory(paths)
			const loaded = await readTaskMetadata(paths)
			const marked = await readTaskDiscardMarker(paths)
			if (loaded.status !== "ok" && !marked) {
				if (loaded.status === "invalid" && loaded.diagnostic.code === "unsupported-version" && (await readTaskIdentity(paths))) {
					diagnostics.push(`${paths.taskDirectory}: ${loaded.diagnostic.message}`)
				} else {
					throw new Error(loaded.status === "invalid" ? loaded.diagnostic.message : "Missing task metadata")
				}
			}
			const discarded = marked || (loaded.status === "ok" && loaded.metadata.discardedAt !== null)
			const warning = await syncActiveTaskLink(paths, discarded)
			if (warning) diagnostics.push(warning)
			if (!discarded) expected.add(entry.name)
		} catch (error) {
			diagnostics.push(`${paths.taskDirectory}: ${errorMessage(error)}`)
		}
	}
	const directory = join(parent.parentDirectory, "active")
	if (await optionalDirectory(directory)) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isSymbolicLink() && TASK_REFERENCE_PATTERN.test(entry.name) && !expected.has(entry.name)) {
				await unlink(join(directory, entry.name))
			}
		}
	}
	return diagnostics
}

/** Unknown metadata is never rewritten. The marker is bound to its exact ownership identity. */
export async function readTaskDiscardMarker(paths: TaskStoragePaths): Promise<boolean> {
	const path = join(paths.taskDirectory, ".discarded.json")
	let source: string
	try {
		await assertCanonicalTaskDirectory(paths)
		const stats = await lstat(path)
		if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Discard marker is not a regular file: ${path}`)
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
		try {
			if (!(await handle.stat()).isFile()) throw new Error(`Discard marker is not a regular file: ${path}`)
			source = await handle.readFile("utf8")
		} finally {
			await handle.close()
		}
	} catch (error) {
		if (hasCode(error, "ENOENT")) return false
		throw error
	}
	const marker = JSON.parse(source)
	const identity = await readTaskIdentity(paths)
	const keys = ["version", "taskRef", "parentSessionId", "kind", "discardedAt"]
	if (identity?.kind === "agent") keys.push("childSessionId")
	if (
		!identity ||
		!marker ||
		typeof marker !== "object" ||
		Object.keys(marker).sort().join() !== keys.sort().join() ||
		marker.version !== 1 ||
		marker.taskRef !== paths.taskRef ||
		marker.parentSessionId !== paths.parentSessionId ||
		marker.kind !== identity.kind ||
		(identity.kind === "agent" && marker.childSessionId !== identity.childSessionId) ||
		!Number.isSafeInteger(marker.discardedAt) ||
		marker.discardedAt < 0
	) {
		throw new Error(`Invalid discard marker ownership: ${path}`)
	}
	return true
}

export async function writeTaskDiscardMarker(paths: TaskStoragePaths): Promise<void> {
	await assertCanonicalTaskDirectory(paths)
	const identity = await readTaskIdentity(paths)
	if (!identity) throw new Error(`Unknown Task Reference: ${paths.taskRef}`)
	if (!(await readTaskDiscardMarker(paths))) {
		const path = join(paths.taskDirectory, ".discarded.json")
		const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
		const handle = await open(temporary, "wx", 0o600)
		try {
			await handle.writeFile(
				`${JSON.stringify({ version: 1, taskRef: paths.taskRef, parentSessionId: paths.parentSessionId, ...identity, discardedAt: Date.now() })}\n`
			)
			await handle.sync()
			await handle.close()
			try {
				await link(temporary, path)
			} catch (error) {
				if (!hasCode(error, "EEXIST") || !(await readTaskDiscardMarker(paths))) throw error
			}
			const directory = await open(paths.taskDirectory, "r")
			try {
				await directory.sync()
			} finally {
				await directory.close()
			}
		} finally {
			await handle.close()
			await unlink(temporary)
		}
	}
	const warning = await syncActiveTaskLink(paths, true)
	if (warning) throw new Error(warning)
	publishTaskUpdate(paths.workspace, paths.parentSessionId)
}

/** Verify every storage component without following directory symlinks. */
export async function assertStorageDirectory(parent: ParentStoragePaths): Promise<void> {
	for (const directory of [dirname(parent.root), parent.root, parent.parentDirectory]) {
		if (!(await optionalDirectory(directory))) throw new Error(`Missing storage directory: ${directory}`)
	}
}

export async function assertCanonicalTaskDirectory(paths: TaskStoragePaths): Promise<void> {
	if (
		paths.root !== join(paths.workspace, ".pi", "lovely-agents") ||
		paths.parentDirectory !== join(paths.root, paths.parentSessionId) ||
		paths.taskDirectory !== join(paths.parentDirectory, paths.taskRef) ||
		paths.metadata !== join(paths.taskDirectory, "metadata.json") ||
		!SESSION_ID_PATTERN.test(paths.parentSessionId) ||
		!TASK_REFERENCE_PATTERN.test(paths.taskRef)
	) {
		throw new Error(`Not a canonical task path: ${paths.taskDirectory}`)
	}
	await assertStorageDirectory(paths)
	if (!(await optionalDirectory(paths.taskDirectory))) {
		const error = new Error(`Unknown Task Reference: ${paths.taskRef}`)
		Object.assign(error, { code: "ENOENT" })
		throw error
	}
}

async function optionalDirectory(path: string): Promise<boolean> {
	try {
		const stats = await lstat(path)
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Storage path is not a regular directory: ${path}`)
		return true
	} catch (error) {
		if (hasCode(error, "ENOENT")) return false
		throw error
	}
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
