import { lstat, readdir } from "node:fs/promises"
import { getAgentCoordinator } from "./coordinator.js"
import { appendTaskNotification, prepareTaskNotification } from "./notifications.js"
import {
	acquireParentLease,
	appendHistoryLog,
	archivedTaskStoragePaths,
	archiveTaskStorage,
	mutateTaskMetadata,
	parentStoragePaths,
	readTaskIdentity,
	readTaskMetadata,
	releaseParentLease,
	type TaskMetadata,
	type TaskStoragePaths,
	taskStoragePaths
} from "./state.js"

export type ReconciliationResult = {
	interrupted: number
	diagnostics: string[]
}

export type RecoveryResult = {
	resumed: number
	diagnostics: string[]
}

const DISCARD_OPERATIONS = Symbol.for("@xl0/pi-lovely-agents/discards/v1")

/** Stops and archives an owned subtree, decoding only identity for unsupported versions. */
export function discardTask(paths: TaskStoragePaths, visited = new Set([paths.parentSessionId])): Promise<void> {
	const global = globalThis as typeof globalThis & { [DISCARD_OPERATIONS]?: Map<string, Promise<void>> }
	global[DISCARD_OPERATIONS] ??= new Map()
	const operations = global[DISCARD_OPERATIONS]
	const existing = operations.get(paths.taskDirectory)
	if (existing) return existing
	const pending = (async () => {
		const identity = await readTaskIdentity(paths)
		if (!identity) {
			if (await readTaskIdentity(archivedTaskStoragePaths(paths))) return
			throw new Error(`Unknown Task Reference: ${paths.taskRef}`)
		}
		if (visited.has(identity.childSessionId)) throw new Error("Cyclic task ownership")
		const descendants = new Set([...visited, identity.childSessionId])
		const loaded = await readTaskMetadata(paths)
		if (loaded.status === "ok") {
			await stopTask(paths)
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				discardedAt: metadata.discardedAt ?? Date.now(),
				queuedFollowUps: [],
				updatedAt: Date.now()
			}))
			// Fence input that raced the first stop before the tombstone committed.
			await stopTask(paths)
		} else if (loaded.status === "invalid" && loaded.diagnostic.code === "unsupported-version") {
			await getAgentCoordinator().getResident(paths.taskDirectory)?.stop()
		} else {
			throw new Error(loaded.status === "invalid" ? loaded.diagnostic.message : `Missing metadata: ${paths.metadata}`)
		}
		const lease = await acquireParentLease(paths.workspace, identity.childSessionId)
		try {
			for (const child of await directTaskPaths(paths.workspace, identity.childSessionId)) {
				await discardTask(child, descendants)
			}
		} finally {
			await releaseParentLease(lease)
		}
		await archiveTaskStorage(paths)
	})().finally(() => {
		if (operations.get(paths.taskDirectory) === pending) operations.delete(paths.taskDirectory)
	})
	operations.set(paths.taskDirectory, pending)
	return pending
}

/** Marks stale direct work interrupted after a non-reload parent session start. */
export async function reconcileParentTasks(cwd: string, parentSessionId: string): Promise<ReconciliationResult> {
	const parent = parentStoragePaths(cwd, parentSessionId)
	if (!(await isDirectory(parent.parentDirectory))) return { interrupted: 0, diagnostics: [] }
	await acquireParentLease(cwd, parentSessionId)

	const result: ReconciliationResult = { interrupted: 0, diagnostics: [] }
	for (const paths of await directTaskPaths(cwd, parentSessionId)) {
		const loaded = await readTaskMetadata(paths)
		if (loaded.status !== "ok") {
			if (loaded.status === "invalid") result.diagnostics.push(`${paths.taskDirectory}: ${loaded.diagnostic.message}`)
			continue
		}
		if (getAgentCoordinator().getResident(paths.taskDirectory)) continue
		if (loaded.metadata.state === "idle" || loaded.metadata.state === "interrupted") {
			if (loaded.metadata.queuedFollowUps.length > 0) {
				await mutateTaskMetadata(paths, metadata => ({ ...metadata, queuedFollowUps: [], updatedAt: Date.now() }))
			}
			continue
		}
		let notification: TaskMetadata["notifications"][number] | undefined
		if (loaded.metadata.activeRun?.background) {
			try {
				notification = await prepareTaskNotification(paths, loaded.metadata, loaded.metadata.activeRun, "interruption", "interrupted")
			} catch (error) {
				result.diagnostics.push(`${paths.taskDirectory}: could not prepare interruption notification: ${errorMessage(error)}`)
			}
		}
		const settled: { run: TaskMetadata["activeRun"] } = { run: null }
		const updatedAt = Date.now()
		const changed = await mutateTaskMetadata(paths, metadata => {
			if (metadata.state === "idle") return metadata
			settled.run = metadata.activeRun
			return {
				...metadata,
				state: "interrupted",
				latestOutcome: "interrupted",
				activeRun: null,
				queuedFollowUps: [],
				updatedAt,
				notifications: notification ? appendTaskNotification(metadata.notifications, notification) : metadata.notifications
			}
		})
		if (!settled.run || changed.latestOutcome !== "interrupted") continue
		await appendHistoryLog(paths, {
			type: "run-end",
			sequence: settled.run.sequence,
			outcome: "interrupted",
			timestamp: updatedAt
		})
		result.interrupted++
	}
	return result
}

/** Stops active work and clears queued input throughout an owned task tree. */
export async function stopOwnedTaskTree(cwd: string, parentSessionId: string): Promise<void> {
	await stopPartition(cwd, parentSessionId, new Set())
}

/** Requeues resident suspended work in the exact owned descendant tree. */
export async function recoverOwnedTaskTree(cwd: string, parentSessionId: string): Promise<RecoveryResult> {
	const result: RecoveryResult = { resumed: 0, diagnostics: [] }
	await recoverPartition(cwd, parentSessionId, new Set(), result)
	return result
}

/** Stops one retained task through its resident runtime when available. */
export async function stopTask(paths: TaskStoragePaths): Promise<void> {
	const resident = getAgentCoordinator().getResident(paths.taskDirectory)
	if (resident) await resident.stop()
	else await settleStopped(paths)
}

async function stopPartition(cwd: string, parentSessionId: string, visited: Set<string>): Promise<void> {
	if (visited.has(parentSessionId)) return
	visited.add(parentSessionId)
	const parent = parentStoragePaths(cwd, parentSessionId)
	if (!(await isDirectory(parent.parentDirectory))) return
	const lease = await acquireParentLease(cwd, parentSessionId)
	const errors: unknown[] = []

	try {
		for (const paths of await directTaskPaths(cwd, parentSessionId)) {
			const loaded = await readTaskMetadata(paths)
			if (loaded.status !== "ok") continue
			try {
				await stopTask(paths)
			} catch (error) {
				errors.push(error)
			}
			try {
				await stopPartition(cwd, loaded.metadata.childSessionId, visited)
			} catch (error) {
				errors.push(error)
			}
		}
	} finally {
		await releaseParentLease(lease)
	}
	if (errors.length > 0) throw new AggregateError(errors, `Failed to stop ${errors.length} owned task operation(s)`)
}

async function recoverPartition(cwd: string, parentSessionId: string, visited: Set<string>, result: RecoveryResult): Promise<void> {
	if (visited.has(parentSessionId)) return
	visited.add(parentSessionId)
	const parent = parentStoragePaths(cwd, parentSessionId)
	if (!(await isDirectory(parent.parentDirectory))) return

	for (const paths of await directTaskPaths(cwd, parentSessionId)) {
		const loaded = await readTaskMetadata(paths)
		if (loaded.status !== "ok") {
			if (loaded.status === "invalid") result.diagnostics.push(`${paths.taskDirectory}: ${loaded.diagnostic.message}`)
			continue
		}
		if (loaded.metadata.discardedAt === null && loaded.metadata.state === "suspended" && loaded.metadata.activeRun?.background) {
			const resident = getAgentCoordinator().getResident(paths.taskDirectory)
			if (!resident?.recover) result.diagnostics.push(`${paths.taskDirectory}: suspended task has no recoverable resident`)
			else if (await resident.recover()) result.resumed++
		}
		await recoverPartition(cwd, loaded.metadata.childSessionId, visited, result)
	}
}

async function settleStopped(paths: TaskStoragePaths): Promise<void> {
	const settled: { run: TaskMetadata["activeRun"] } = { run: null }
	const updatedAt = Date.now()
	await mutateTaskMetadata(paths, metadata => {
		if (metadata.state === "idle" || metadata.state === "interrupted" || !metadata.activeRun) {
			return metadata.queuedFollowUps.length === 0 ? metadata : { ...metadata, queuedFollowUps: [], updatedAt }
		}
		settled.run = metadata.activeRun
		return { ...metadata, state: "idle", latestOutcome: "stopped", activeRun: null, queuedFollowUps: [], updatedAt }
	})
	if (settled.run) {
		await appendHistoryLog(paths, {
			type: "run-end",
			sequence: settled.run.sequence,
			outcome: "stopped",
			timestamp: updatedAt
		})
	}
}

async function directTaskPaths(cwd: string, parentSessionId: string): Promise<TaskStoragePaths[]> {
	const parent = parentStoragePaths(cwd, parentSessionId)
	const entries = await readdir(parent.parentDirectory, { withFileTypes: true })
	return entries
		.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^a_[0-9a-f]{8}$/.test(entry.name))
		.map(entry => taskStoragePaths(parent, entry.name))
		.sort((a, b) => a.taskDirectory.localeCompare(b.taskDirectory))
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		const stats = await lstat(path)
		return stats.isDirectory() && !stats.isSymbolicLink()
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
