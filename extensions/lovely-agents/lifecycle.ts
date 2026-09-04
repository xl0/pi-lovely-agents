import { lstat, readdir } from "node:fs/promises"
import { getAgentCoordinator } from "./coordinator.js"
import {
	acquireParentLease,
	appendOutputLog,
	mutateTaskMetadata,
	parentStoragePaths,
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
				notifications: metadata.activeRun
					? [
							...metadata.notifications,
							{
								id: `${metadata.taskRef}:${metadata.activeRun.id}:interruption`,
								type: "interruption",
								runId: metadata.activeRun.id,
								createdAt: Date.now(),
								content: `Agent ${metadata.taskRef} was interrupted before this process started.`
							}
						]
					: metadata.notifications
			}
		})
		if (!settled.run || changed.latestOutcome !== "interrupted") continue
		await appendOutputLog(paths, {
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
		await appendOutputLog(paths, {
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
