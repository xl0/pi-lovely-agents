import { getAgentCoordinator } from "./coordinator.js"
import { appendTaskNotification, prepareTaskNotification } from "./notifications.js"
import {
	acquireParentLease,
	appendHistoryLog,
	directTaskPaths,
	mutateTaskMetadata,
	type ParentLease,
	parentStoragePaths,
	readTaskMetadata,
	releaseParentLease,
	type TaskMetadata,
	type TaskStoragePaths
} from "./state.js"
import { errorMessage, isRealDirectory } from "./utils.js"

export type ReconciliationResult = {
	interrupted: number
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
		const loaded = await readTaskMetadata(paths)
		if (loaded.status === "missing") throw new Error(`Unknown Task Reference: ${paths.taskRef}`)
		if (loaded.status === "invalid") throw new Error(loaded.diagnostic.message)
		const childSessionId = loaded.metadata.kind === "agent" ? loaded.metadata.childSessionId : undefined
		if (childSessionId && visited.has(childSessionId)) throw new Error("Cyclic task ownership")
		await stopTask(paths)
		await mutateTaskMetadata(paths, metadata => ({
			...metadata,
			discardedAt: metadata.discardedAt ?? Date.now(),
			queuedFollowUps: [],
			updatedAt: Date.now()
		}))
		// Fence input that raced the first stop before the tombstone committed.
		await stopTask(paths)
		if (childSessionId && (await isRealDirectory(parentStoragePaths(paths.workspace, childSessionId).parentDirectory))) {
			const descendants = new Set([...visited, childSessionId])
			const lease = await acquireParentLease(paths.workspace, childSessionId)
			for (const child of await directTaskPaths(paths.workspace, childSessionId)) await discardTask(child, descendants)
			// Failed cleanup may leave residents using this borrowed partition lease.
			await releaseParentLease(lease)
		}
	})().finally(() => {
		if (operations.get(paths.taskDirectory) === pending) operations.delete(paths.taskDirectory)
	})
	operations.set(paths.taskDirectory, pending)
	return pending
}

/** Marks stale direct work interrupted after a non-reload parent session start. */
export async function reconcileParentTasks(cwd: string, parentSessionId: string): Promise<ReconciliationResult> {
	// Never create storage for sessions that own no tasks.
	if (!(await isRealDirectory(parentStoragePaths(cwd, parentSessionId).parentDirectory))) return { interrupted: 0, diagnostics: [] }
	await acquireParentLease(cwd, parentSessionId)

	const result: ReconciliationResult = { interrupted: 0, diagnostics: [] }
	for (const paths of await directTaskPaths(cwd, parentSessionId)) {
		const loaded = await readTaskMetadata(paths)
		if (loaded.status !== "ok") {
			if (loaded.status === "invalid") result.diagnostics.push(`${paths.taskDirectory}: ${loaded.diagnostic.message}`)
			continue
		}
		if (loaded.metadata.discardedAt !== null || getAgentCoordinator().getResident(paths.taskDirectory)) continue
		let notification: TaskMetadata["notifications"][number] | undefined
		if (loaded.metadata.activeRun) {
			try {
				notification = await prepareTaskNotification(paths, loaded.metadata, loaded.metadata.activeRun, "interruption", "interrupted")
			} catch (error) {
				result.diagnostics.push(`${paths.taskDirectory}: could not prepare interruption notification: ${errorMessage(error)}`)
			}
		}
		if (await settleRetained(paths, "interrupted", notification)) result.interrupted++
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

/** Stops one retained task through its resident runtime when available. */
export async function stopTask(paths: TaskStoragePaths): Promise<void> {
	const resident = getAgentCoordinator().getResident(paths.taskDirectory)
	if (resident) await resident.stop()
	else await settleRetained(paths, "stopped")
}

async function stopPartition(cwd: string, parentSessionId: string, visited: Set<string>, leases: ParentLease[]): Promise<void> {
	if (visited.has(parentSessionId)) return
	visited.add(parentSessionId)
	if (!(await isRealDirectory(parentStoragePaths(cwd, parentSessionId).parentDirectory))) return
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

/** Settles a run that has no resident runtime and clears queued input; true when a run was settled. */
async function settleRetained(
	paths: TaskStoragePaths,
	outcome: "stopped" | "interrupted",
	notification?: TaskMetadata["notifications"][number]
): Promise<boolean> {
	const settled: { run: TaskMetadata["activeRun"] } = { run: null }
	const updatedAt = Date.now()
	await mutateTaskMetadata(paths, metadata => {
		if (metadata.state === "idle" || metadata.state === "interrupted" || !metadata.activeRun) {
			return metadata.queuedFollowUps.length === 0 ? metadata : { ...metadata, queuedFollowUps: [], updatedAt }
		}
		settled.run = metadata.activeRun
		return {
			...metadata,
			state: outcome === "interrupted" ? "interrupted" : "idle",
			latestOutcome: outcome,
			activeRun: null,
			queuedFollowUps: [],
			notifications: notification ? appendTaskNotification(metadata.notifications, notification) : metadata.notifications,
			updatedAt
		}
	})
	if (!settled.run) return false
	await appendHistoryLog(paths, { type: "run-end", sequence: settled.run.sequence, outcome, timestamp: updatedAt })
	return true
}
