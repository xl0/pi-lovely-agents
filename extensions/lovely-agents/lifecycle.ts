import { lstat, readdir } from "node:fs/promises"
import { getAgentCoordinator } from "./coordinator.js"
import { appendTaskNotification, prepareTaskNotification } from "./notifications.js"
import {
	acquireParentLease,
	appendHistoryLog,
	mutateTaskMetadata,
	type ParentLease,
	parentStoragePaths,
	readTaskIdentity,
	readTaskMetadata,
	releaseParentLease,
	TASK_REFERENCE_PATTERN,
	type TaskMetadata,
	type TaskStoragePaths,
	taskStoragePaths
} from "./state.js"
import { readTaskDiscardMarker, rebuildActiveTaskLinks, syncActiveTaskLink, writeTaskDiscardMarker } from "./storage.js"

export type ReconciliationResult = {
	interrupted: number
	diagnostics: string[]
}

export type RecoveryResult = {
	resumed: number
	diagnostics: string[]
}

const DISCARD_OPERATIONS = Symbol.for("@xl0/pi-lovely-agents/discards/v1")

/** Stops and tombstones an owned subtree without changing its canonical paths. */
export function discardTask(paths: TaskStoragePaths, visited = new Set([paths.parentSessionId])): Promise<void> {
	const global = globalThis as typeof globalThis & { [DISCARD_OPERATIONS]?: Map<string, Promise<void>> }
	global[DISCARD_OPERATIONS] ??= new Map()
	const operations = global[DISCARD_OPERATIONS]
	const existing = operations.get(paths.taskDirectory)
	if (existing) return existing
	const pending = (async () => {
		const identity = await readTaskIdentity(paths)
		if (!identity) throw new Error(`Unknown Task Reference: ${paths.taskRef}`)
		if (identity.kind === "agent" && visited.has(identity.childSessionId)) throw new Error("Cyclic task ownership")
		const marked = await readTaskDiscardMarker(paths)
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
		} else if (marked || (loaded.status === "invalid" && loaded.diagnostic.code === "unsupported-version")) {
			if (!marked) {
				await getAgentCoordinator().getResident(paths.taskDirectory)?.stop()
				await writeTaskDiscardMarker(paths)
			}
		} else {
			throw new Error(loaded.status === "invalid" ? loaded.diagnostic.message : `Missing metadata: ${paths.metadata}`)
		}
		if (identity.kind === "agent") {
			const descendants = new Set([...visited, identity.childSessionId])
			const lease = await acquireParentLease(paths.workspace, identity.childSessionId)
			for (const child of await directTaskPaths(paths.workspace, identity.childSessionId, true)) {
				await discardTask(child, descendants)
			}
			// Failed cleanup may leave residents using this borrowed partition lease.
			await releaseParentLease(lease)
		}
		const warning = await syncActiveTaskLink(paths, true)
		if (warning) throw new Error(warning)
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
	try {
		result.diagnostics.push(...(await rebuildActiveTaskLinks(parent)))
	} catch (error) {
		result.diagnostics.push(`Active task index: ${errorMessage(error)}`)
	}
	for (const paths of await directTaskPaths(cwd, parentSessionId)) {
		try {
			if (await readTaskDiscardMarker(paths)) continue
		} catch (error) {
			result.diagnostics.push(`${paths.taskDirectory}: ${errorMessage(error)}`)
			continue
		}
		const loaded = await readTaskMetadata(paths)
		if (loaded.status !== "ok") {
			if (loaded.status === "invalid") {
				const diagnostic = `${paths.taskDirectory}: ${loaded.diagnostic.message}`
				if (!result.diagnostics.includes(diagnostic)) result.diagnostics.push(diagnostic)
			}
			continue
		}
		if (loaded.metadata.discardedAt !== null || getAgentCoordinator().getResident(paths.taskDirectory)) continue
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
	const leases: ParentLease[] = []
	await stopPartition(cwd, parentSessionId, new Set(), leases)
	// A failed owner can remain live even when stopping its descendants succeeded.
	for (const lease of leases.reverse()) await releaseParentLease(lease)
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

async function stopPartition(cwd: string, parentSessionId: string, visited: Set<string>, leases: ParentLease[]): Promise<void> {
	if (visited.has(parentSessionId)) return
	visited.add(parentSessionId)
	const parent = parentStoragePaths(cwd, parentSessionId)
	if (!(await isDirectory(parent.parentDirectory))) return
	leases.push(await acquireParentLease(cwd, parentSessionId))
	const errors: unknown[] = []

	for (const paths of await directTaskPaths(cwd, parentSessionId)) {
		const loaded = await readTaskMetadata(paths)
		if (loaded.status !== "ok") {
			if (getAgentCoordinator().getResident(paths.taskDirectory)) {
				errors.push(new Error(`Cannot validate live task ownership: ${paths.metadata}`))
			}
			continue
		}
		try {
			await stopTask(paths)
		} catch (error) {
			errors.push(error)
		}
		try {
			if (loaded.metadata.kind === "agent") await stopPartition(cwd, loaded.metadata.childSessionId, visited, leases)
		} catch (error) {
			errors.push(error)
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, `Failed to stop ${errors.length} owned task operation(s)`)
}

async function recoverPartition(cwd: string, parentSessionId: string, visited: Set<string>, result: RecoveryResult): Promise<void> {
	if (visited.has(parentSessionId)) return
	visited.add(parentSessionId)
	const parent = parentStoragePaths(cwd, parentSessionId)
	if (!(await isDirectory(parent.parentDirectory))) return

	for (const paths of await directTaskPaths(cwd, parentSessionId)) {
		try {
			if (await readTaskDiscardMarker(paths)) continue
		} catch (error) {
			result.diagnostics.push(`${paths.taskDirectory}: ${errorMessage(error)}`)
			continue
		}
		const loaded = await readTaskMetadata(paths)
		if (loaded.status !== "ok") {
			if (loaded.status === "invalid") result.diagnostics.push(`${paths.taskDirectory}: ${loaded.diagnostic.message}`)
			continue
		}
		if (loaded.metadata.discardedAt !== null || loaded.metadata.kind !== "agent") continue
		if (loaded.metadata.state === "suspended" && loaded.metadata.activeRun?.background) {
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

async function directTaskPaths(cwd: string, parentSessionId: string, strict = false): Promise<TaskStoragePaths[]> {
	const parent = parentStoragePaths(cwd, parentSessionId)
	const entries = await readdir(parent.parentDirectory, { withFileTypes: true })
	if (strict) {
		for (const entry of entries) {
			if (TASK_REFERENCE_PATTERN.test(entry.name) && (!entry.isDirectory() || entry.isSymbolicLink())) {
				throw new Error(`Unsafe descendant task path: ${parent.parentDirectory}/${entry.name}`)
			}
		}
	}
	return entries
		.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && TASK_REFERENCE_PATTERN.test(entry.name))
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
