#!/usr/bin/env bun
import { lstat, readdir, readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
	acquireParentLease,
	type ParentLease,
	parentStoragePaths,
	readTaskMetadata,
	releaseParentLease,
	SESSION_ID_PATTERN,
	TASK_REFERENCE_PATTERN,
	type TaskMetadata,
	type TaskStoragePaths,
	taskStoragePaths
} from "../extensions/lovely-agents/state.js"
import { errorMessage, hasCode, isRealDirectory } from "../extensions/lovely-agents/utils.js"

export type PruneResult = { apply: boolean; candidates: string[]; deleted: string[]; diagnostics: string[] }
type RecordEntry = { paths: TaskStoragePaths; metadata?: TaskMetadata; reason?: string }

/**
 * Explicit maintenance only. Coarse workspace-wide leases deliberately trade
 * availability for safety; narrow locking only if offline pruning becomes a bottleneck.
 */
export async function pruneTasks(cwd: string, apply = false): Promise<PruneResult> {
	cwd = resolve(cwd)
	const result: PruneResult = { apply, candidates: [], deleted: [], diagnostics: [] }
	const root = parentStoragePaths(cwd, "prune").root
	const leases: ParentLease[] = []
	try {
		try {
			await lstat(root)
		} catch (error) {
			if (hasCode(error, "ENOENT")) return result
			throw error
		}
		const parents = await parentIds()
		const lockIds = new Set(parents)
		// Include absent child partitions: their lease fences creation while owners are removed.
		for (const id of parents) {
			const parent = parentStoragePaths(cwd, id)
			await assertStorageDirectory(parent)
			for (const entry of await readdir(parent.parentDirectory, { withFileTypes: true })) {
				if (!entry.isDirectory() || !TASK_REFERENCE_PATTERN.test(entry.name)) continue
				// Invalid records remain in place and block removal of their owner below.
				const loaded = await readTaskMetadata(taskStoragePaths(parent, entry.name))
				if (loaded.status === "ok" && loaded.metadata.kind === "agent") lockIds.add(loaded.metadata.childSessionId)
			}
		}
		for (const id of [...lockIds].sort()) {
			const parent = parentStoragePaths(cwd, id)
			try {
				// acquireParentLease intentionally reuses in-process leases; maintenance must not.
				const stats = await lstat(parent.lease)
				if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Unsafe parent lease: ${parent.lease}`)
				const current = JSON.parse(await readFile(parent.lease, "utf8"))
				if (current?.pid === process.pid) throw new Error(`Parent partition is already open in this process: ${parent.parentDirectory}`)
			} catch (error) {
				if (!hasCode(error, "ENOENT")) throw error
			}
			leases.push(await acquireParentLease(cwd, id))
		}
		if ((await parentIds()).some(id => !lockIds.has(id))) throw new Error("Parent partitions changed during lease acquisition; retry")

		const partitions = new Map<string, RecordEntry[]>()
		const unsafePartitions = new Set<string>()
		const owners = new Map<string, RecordEntry[]>()
		for (const id of lockIds) {
			const parent = parentStoragePaths(cwd, id)
			await assertStorageDirectory(parent)
			const records: RecordEntry[] = []
			partitions.set(id, records)
			for (const entry of await readdir(parent.parentDirectory, { withFileTypes: true })) {
				if (entry.name === ".lease" && entry.isFile()) continue
				// Browsing index written by 0.1.2; left in place.
				if (entry.name === "active" && entry.isDirectory()) continue
				if (!TASK_REFERENCE_PATTERN.test(entry.name) || !entry.isDirectory()) {
					unsafePartitions.add(id)
					result.diagnostics.push(`${join(parent.parentDirectory, entry.name)}: unrecognized partition entry retained`)
					continue
				}
				const paths = taskStoragePaths(parent, entry.name)
				const record: RecordEntry = { paths }
				records.push(record)
				try {
					const loaded = await readTaskMetadata(paths)
					if (loaded.status !== "ok") throw new Error(loaded.status === "invalid" ? loaded.diagnostic.message : "Missing metadata")
					if (loaded.metadata.kind === "agent") {
						const child = loaded.metadata.childSessionId
						if (!lockIds.has(child)) throw new Error("Child ownership changed during lease acquisition; retry")
						owners.set(child, [...(owners.get(child) ?? []), record])
					}
					record.metadata = loaded.metadata
					if (loaded.metadata.discardedAt === null) throw new Error("Not explicitly discarded")
					if (loaded.metadata.activeRun || loaded.metadata.queuedFollowUps.length) throw new Error("Unsettled work retained")
					if (loaded.metadata.notifications.some(notification => notification.deliveredAt === undefined)) {
						throw new Error("Pending notifications retained")
					}
					await validateTree(paths.taskDirectory)
				} catch (error) {
					record.reason = errorMessage(error)
				}
			}
		}
		for (const group of owners.values()) {
			if (group.length > 1) {
				for (const record of group) record.reason = "Ambiguous child partition ownership"
			}
		}
		for (const [id, records] of partitions) {
			if ((owners.get(id)?.length ?? 0) > 1) {
				for (const record of records) record.reason = "Ambiguous parent partition ownership"
			}
		}
		const eligible = new Map<RecordEntry, boolean>()
		const visiting = new Set<RecordEntry>()
		const ordered: RecordEntry[] = []
		function canRemove(record: RecordEntry): boolean {
			const cached = eligible.get(record)
			if (cached !== undefined) return cached
			if (visiting.has(record)) {
				record.reason = "Cyclic child ownership"
				return false
			}
			visiting.add(record)
			if (record.metadata?.kind === "agent") {
				const child = record.metadata.childSessionId
				// Evaluate all descendants even when the owner is retained.
				const children = (partitions.get(child) ?? []).map(canRemove)
				if (unsafePartitions.has(child) || children.some(value => !value)) {
					record.reason ??= "Retained or corrupt descendants"
				}
			}
			visiting.delete(record)
			const remove = !record.reason && record.metadata !== undefined
			eligible.set(record, remove)
			if (remove) ordered.push(record)
			return remove
		}
		for (const records of partitions.values()) {
			for (const record of records) canRemove(record)
		}
		for (const records of partitions.values()) {
			for (const record of records) {
				if (record.reason) result.diagnostics.push(`${record.paths.taskDirectory}: ${record.reason}`)
			}
		}
		result.candidates = ordered.map(record => record.paths.taskDirectory)
		if (apply) {
			for (const { paths } of ordered) {
				await assertStorageDirectory(paths)
				if (!(await isRealDirectory(paths.taskDirectory))) throw new Error(`Not a task directory: ${paths.taskDirectory}`)
				await validateTree(paths.taskDirectory)
				await rm(paths.taskDirectory, { recursive: true })
				result.deleted.push(paths.taskDirectory)
			}
		}
	} catch (error) {
		result.diagnostics.push(errorMessage(error))
	} finally {
		for (const lease of leases.reverse()) {
			try {
				await releaseParentLease(lease)
			} catch (error) {
				result.diagnostics.push(errorMessage(error))
			}
		}
	}
	return result

	async function parentIds(): Promise<string[]> {
		// Validate root components before readdir, including .pi symlinks.
		for (const directory of [join(cwd, ".pi"), root]) {
			const stats = await lstat(directory)
			if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Unsafe storage directory: ${directory}`)
		}
		const ids: string[] = []
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (entry.name === ".gitignore" && entry.isFile()) continue
			if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name)) {
				throw new Error(`Unrecognized storage root entry retained: ${join(root, entry.name)}`)
			}
			ids.push(entry.name)
		}
		return ids.sort()
	}
}

async function validateTree(directory: string): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`Unsafe retained artifact: ${path}`)
		if (entry.isDirectory()) await validateTree(path)
	}
}

/** Verify every storage component without following directory symlinks. */
async function assertStorageDirectory(parent: { root: string; parentDirectory: string }): Promise<void> {
	for (const directory of [dirname(parent.root), parent.root, parent.parentDirectory]) {
		if (!(await isRealDirectory(directory))) throw new Error(`Unsafe or missing storage directory: ${directory}`)
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2)
	const apply = args.includes("--apply")
	const positional = args.filter(arg => arg !== "--apply")
	if (positional.length > 1 || positional.some(arg => arg.startsWith("-")) || args.filter(arg => arg === "--apply").length > 1) {
		console.error("Usage: bun scripts/prune-tasks.ts [workspace] [--apply]")
		process.exitCode = 1
	} else {
		const result = await pruneTasks(positional[0] ?? process.cwd(), apply)
		for (const diagnostic of result.diagnostics) console.error(`Retained: ${diagnostic}`)
		for (const path of apply ? result.deleted : result.candidates) console.log(`${apply ? "Deleted" : "Would delete"}: ${path}`)
		console.log(`${apply ? "Applied" : "Dry run"}: ${apply ? result.deleted.length : result.candidates.length} task(s)`)
	}
}
