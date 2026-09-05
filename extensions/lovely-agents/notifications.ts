import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { getAgentCoordinator } from "./coordinator.js"
import {
	MAX_NOTIFICATION_CONTENT_BYTES,
	MAX_TASK_NOTIFICATIONS,
	mutateTaskMetadata,
	parentStoragePaths,
	readTaskMetadata,
	retainedPaths,
	type TaskMetadata,
	type TaskStoragePaths,
	taskStoragePaths
} from "./state.js"
import { loadTaskList } from "./tools.js"

export const NOTIFICATION_CUSTOM_TYPE = "lovely-agents:notification"
export const NOTIFICATION_OUTPUT_PREVIEW_BYTES = 2 * 1024
const NOTIFICATION_IN_FLIGHT_SYMBOL = Symbol.for("@xl0/pi-lovely-agents/notification-in-flight/v1")

type TaskNotification = TaskMetadata["notifications"][number]
type NotificationType = TaskNotification["type"]
type ActiveRun = NonNullable<TaskMetadata["activeRun"]>

/** Stable process-global route identity for one workspace/session partition. */
export function notificationRouteKey(cwd: string, parentSessionId: string): string {
	return `${resolve(cwd)}\0${parentSessionId}`
}

/** Drops process-local send suppression when an exact parent runtime closes. */
export function clearNotificationInFlight(cwd: string, parentSessionId: string): void {
	const prefix = `${notificationRouteKey(cwd, parentSessionId)}\0`
	const inFlight = notificationInFlight()
	for (const key of [...inFlight]) {
		if (key.startsWith(prefix)) inFlight.delete(key)
	}
}

/** Builds one bounded durable notification before its state transition commits. */
export async function prepareTaskNotification(
	paths: TaskStoragePaths,
	metadata: TaskMetadata,
	run: ActiveRun,
	type: NotificationType,
	outcome?: TaskMetadata["latestOutcome"]
): Promise<TaskNotification> {
	const output = truncateUtf8(metadata.latestReply?.text ?? "", NOTIFICATION_OUTPUT_PREVIEW_BYTES)
	const taskList = await loadTaskList(paths.workspace, metadata.parentSessionId).catch(() => undefined)
	const descendants = taskList?.details.tasks.find(task => task.id === metadata.taskRef)?.descendants
	const descendantText = descendants && descendants.total > 0 ? `\nDescendants: ${JSON.stringify(descendants)}` : ""
	const pathsForDisplay = retainedPaths(paths)
	const status = type === "suspension" ? "suspended by a provider limit" : type === "interruption" ? "interrupted" : `completed: ${outcome}`
	const content = truncateUtf8(
		[
			`[Lovely Agent ${metadata.taskRef}:${run.id}:${type}]`,
			`Task ${metadata.taskRef} ${JSON.stringify(metadata.label)} ${status}`,
			`Model: ${metadata.model.provider}/${metadata.model.id}:${metadata.thinking}`,
			output ? `Output:\n${output}` : "Output: (empty)",
			`Files: history=${pathsForDisplay.history} session=${pathsForDisplay.session}${descendantText}`
		].join("\n"),
		MAX_NOTIFICATION_CONTENT_BYTES
	)
	return {
		id: `${metadata.taskRef}:${run.id}:${type}`,
		type,
		runId: run.id,
		content,
		createdAt: Date.now()
	}
}

/** Appends idempotently while keeping the durable queue bounded. */
export function appendTaskNotification(notifications: TaskNotification[], notification: TaskNotification): TaskNotification[] {
	if (notifications.some(existing => existing.id === notification.id)) return notifications
	if (notifications.length < MAX_TASK_NOTIFICATIONS) return [...notifications, notification]
	const delivered = notifications.findIndex(existing => existing.deliveredAt !== undefined)
	const retained = notifications.filter((_, index) => index !== (delivered >= 0 ? delivered : 0))
	return [...retained, notification]
}

/** Sends every pending notification for one task, without marking delivery. */
export async function deliverTaskNotifications(paths: TaskStoragePaths): Promise<number> {
	const loaded = await readTaskMetadata(paths)
	if (loaded.status !== "ok" || loaded.metadata.discardedAt !== null) return 0
	const routeKey = notificationRouteKey(paths.workspace, loaded.metadata.parentSessionId)
	const route = getAgentCoordinator().getNotificationRoute(routeKey)
	if (!route) return 0
	const inFlight = notificationInFlight()
	let sent = 0
	for (const notification of loaded.metadata.notifications) {
		if (notification.deliveredAt !== undefined) continue
		const key = `${routeKey}\0${notification.id}`
		if (inFlight.has(key)) continue
		inFlight.add(key)
		try {
			await route({ id: notification.id, taskRef: loaded.metadata.taskRef, content: notification.content })
			sent++
		} catch (error) {
			inFlight.delete(key)
			throw error
		}
	}
	return sent
}

/** Reconciles transcript evidence, then resends only still-absent direct notices. */
export async function reconcileParentNotifications(
	cwd: string,
	parentSessionId: string,
	entries: readonly unknown[]
): Promise<{ delivered: number; sent: number; diagnostics: string[] }> {
	const observed = observedNotificationIds(entries)
	const result = { delivered: 0, sent: 0, diagnostics: [] as string[] }
	for (const paths of await directTaskPaths(cwd, parentSessionId)) {
		const loaded = await readTaskMetadata(paths)
		if (loaded.status !== "ok") {
			if (loaded.status === "invalid") result.diagnostics.push(`${paths.taskDirectory}: ${loaded.diagnostic.message}`)
			continue
		}
		const pendingObserved = loaded.metadata.notifications.filter(
			notification => notification.deliveredAt === undefined && observed.has(notification.id)
		)
		if (pendingObserved.length > 0) {
			const ids = new Set(pendingObserved.map(notification => notification.id))
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				notifications: metadata.notifications.map(notification =>
					ids.has(notification.id) && notification.deliveredAt === undefined ? { ...notification, deliveredAt: Date.now() } : notification
				),
				updatedAt: Date.now()
			}))
			result.delivered += ids.size
		}
		try {
			result.sent += await deliverTaskNotifications(paths)
		} catch (error) {
			result.diagnostics.push(`${paths.taskDirectory}: notification delivery failed: ${errorMessage(error)}`)
		}
	}
	return result
}

/** Marks one observed custom message delivered in its owning direct task. */
export async function observeNotification(cwd: string, parentSessionId: string, taskRef: string, notificationId: string): Promise<boolean> {
	const paths = taskStoragePaths(parentStoragePaths(cwd, parentSessionId), taskRef)
	let changed = false
	await mutateTaskMetadata(paths, metadata => {
		if (metadata.parentSessionId !== parentSessionId || metadata.taskRef !== taskRef) return metadata
		const notifications = metadata.notifications.map(notification => {
			if (notification.id !== notificationId || notification.deliveredAt !== undefined) return notification
			changed = true
			return { ...notification, deliveredAt: Date.now() }
		})
		return changed ? { ...metadata, notifications, updatedAt: Date.now() } : metadata
	})
	notificationInFlight().delete(`${notificationRouteKey(cwd, parentSessionId)}\0${notificationId}`)
	return changed
}

export function observedNotificationIds(entries: readonly unknown[]): Set<string> {
	const ids = new Set<string>()
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue
		const candidate = entry as { type?: unknown; customType?: unknown; details?: unknown }
		if (candidate.type !== "custom_message" || candidate.customType !== NOTIFICATION_CUSTOM_TYPE) continue
		if (!candidate.details || typeof candidate.details !== "object") continue
		const id = (candidate.details as { notificationId?: unknown }).notificationId
		if (typeof id === "string" && id) ids.add(id)
	}
	return ids
}

export function notificationDetails(value: unknown): { notificationId: string; taskRef: string } | undefined {
	if (!value || typeof value !== "object") return undefined
	const details = value as { notificationId?: unknown; taskRef?: unknown }
	return typeof details.notificationId === "string" && typeof details.taskRef === "string"
		? { notificationId: details.notificationId, taskRef: details.taskRef }
		: undefined
}

function notificationInFlight(): Set<string> {
	const global = globalThis as typeof globalThis & { [NOTIFICATION_IN_FLIGHT_SYMBOL]?: Set<string> }
	global[NOTIFICATION_IN_FLIGHT_SYMBOL] ??= new Set()
	return global[NOTIFICATION_IN_FLIGHT_SYMBOL]
}

async function directTaskPaths(cwd: string, parentSessionId: string): Promise<TaskStoragePaths[]> {
	const parent = parentStoragePaths(cwd, parentSessionId)
	let entries: Dirent[]
	try {
		entries = await readdir(parent.parentDirectory, { withFileTypes: true })
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return []
		throw error
	}
	return entries
		.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^a_[0-9a-f]{8}$/.test(entry.name))
		.map(entry => taskStoragePaths(parent, entry.name))
		.sort((left, right) => left.taskDirectory.localeCompare(right.taskDirectory))
}

function truncateUtf8(content: string, maximumBytes: number): string {
	const bytes = Buffer.from(content)
	if (bytes.length <= maximumBytes) return content
	let end = maximumBytes - 3
	while (end > 0 && isUtf8Continuation(bytes[end])) end--
	return `${bytes.subarray(0, end).toString("utf8")}...`
}

function isUtf8Continuation(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
