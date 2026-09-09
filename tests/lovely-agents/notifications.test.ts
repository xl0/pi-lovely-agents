import { describe, expect, test } from "bun:test"
import { unlink } from "node:fs/promises"
import { getAgentCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import { discardTask } from "../../extensions/lovely-agents/lifecycle.js"
import {
	appendTaskNotification,
	clearNotificationInFlight,
	deliverTaskNotifications,
	NOTIFICATION_CUSTOM_TYPE,
	notificationRouteKey,
	prepareTaskNotification,
	reconcileParentNotifications
} from "../../extensions/lovely-agents/notifications.js"
import {
	ensureParentStorage,
	initializeRetainedLogs,
	readTaskMetadata,
	releaseParentLeaseFor,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	type TaskMetadata,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import { withTempWorkspace } from "./test-helpers.js"

describe("durable notifications", () => {
	test("Bash notices report command and exit, retain output links, and reconcile through the shared route", async () => {
		await withTempWorkspace(async workspace => {
			const { paths, metadata } = await createTask(workspace.cwd, "parent", "b_12345678")
			if (metadata.kind !== "bash" || !metadata.activeRun) throw new Error("Expected Bash")
			metadata.exitCode = 7
			metadata.latestReply = { text: `Last shell output\n${"🙂".repeat(2_000)}`, streaming: false }
			const notice = await prepareTaskNotification(paths, metadata, metadata.activeRun, "completion", "failed")
			expect(notice.content).toContain("Command: printf hello")
			expect(notice.content).toContain("Exit: 7")
			expect(notice.content).toContain("Last shell output")
			expect(notice.content).toContain('task_output(id: "b_12345678", run: 1)')
			expect(notice.content).toContain("output.log")
			expect(notice.content).not.toContain("Model:")
			expect(notice.content).not.toContain("session.jsonl")
			expect(notice.content).not.toContain("�")
			expect(Buffer.byteLength(notice.content)).toBeLessThanOrEqual(8 * 1024)
			await writeTaskMetadata(paths, {
				...metadata,
				state: "idle",
				activeRun: null,
				latestOutcome: "failed",
				notifications: [notice]
			})
			const notices: string[] = []
			const unbind = getAgentCoordinator().bindNotificationRoute(notificationRouteKey(workspace.cwd, "parent"), notice => {
				notices.push(notice.id)
			})
			try {
				expect(await reconcileParentNotifications(workspace.cwd, "parent", [])).toEqual({ delivered: 0, sent: 1, diagnostics: [] })
				expect(notices).toEqual([notice.id])
				expect(
					await reconcileParentNotifications(workspace.cwd, "parent", [
						{
							type: "custom_message",
							customType: NOTIFICATION_CUSTOM_TYPE,
							details: { notificationId: notice.id }
						}
					])
				).toEqual({ delivered: 1, sent: 0, diagnostics: [] })
			} finally {
				unbind()
				clearNotificationInFlight(workspace.cwd, "parent")
				await releaseParentLeaseFor(workspace.cwd, "parent")
			}
		})
	})

	test("persists before send, suppresses live duplicates, and reconciles transcript evidence", async () => {
		await withTempWorkspace(async workspace => {
			const { paths, metadata } = await createTask(workspace.cwd)
			const run = metadata.activeRun
			if (!run) throw new Error("fixture has no run")
			const notification = await prepareTaskNotification(paths, metadata, run, "completion", "succeeded")
			await writeTaskMetadata(paths, {
				...metadata,
				state: "idle",
				latestOutcome: "succeeded",
				activeRun: null,
				notifications: appendTaskNotification([], notification)
			})

			const delivered: string[] = []
			const routeKey = notificationRouteKey(workspace.cwd, "parent")
			const unbind = getAgentCoordinator().bindNotificationRoute(routeKey, notice => {
				delivered.push(notice.id)
			})
			try {
				expect(await deliverTaskNotifications(paths)).toBe(1)
				expect(await deliverTaskNotifications(paths)).toBe(0)
				expect(delivered).toEqual([notification.id])

				clearNotificationInFlight(workspace.cwd, "parent")
				const resent = await reconcileParentNotifications(workspace.cwd, "parent", [])
				expect(resent).toMatchObject({ delivered: 0, sent: 1, diagnostics: [] })
				expect(delivered).toEqual([notification.id, notification.id])

				await discardTask(paths)
				clearNotificationInFlight(workspace.cwd, "parent")
				expect(await deliverTaskNotifications(paths)).toBe(1)
				expect(delivered).toEqual([notification.id, notification.id, notification.id])
				const observed = await reconcileParentNotifications(workspace.cwd, "parent", [
					{
						type: "custom_message",
						customType: NOTIFICATION_CUSTOM_TYPE,
						details: { notificationId: notification.id, taskRef: metadata.taskRef }
					}
				])
				expect(observed).toMatchObject({ delivered: 1, sent: 0, diagnostics: [] })
				const loaded = await readTaskMetadata(paths)
				expect(loaded.status === "ok" ? loaded.metadata.notifications[0]?.deliveredAt : undefined).toBeNumber()
			} finally {
				unbind()
				await releaseParentLeaseFor(workspace.cwd, "parent")
			}
		})
	})

	test("bounds the latest reply preview without inputs or history dependency", async () => {
		await withTempWorkspace(async workspace => {
			const { paths, metadata } = await createTask(workspace.cwd)
			await createTask(workspace.cwd, "child", "a_87654321", "grandchild")
			metadata.latestReply = { text: `Latest answer\n${"🙂".repeat(2_000)}`, streaming: false }
			const run = metadata.activeRun
			if (!run) throw new Error("fixture has no run")
			const notification = await prepareTaskNotification(paths, metadata, run, "suspension")
			expect(Buffer.byteLength(notification.content)).toBeLessThanOrEqual(8 * 1024)
			expect(notification.content).toContain("Output preview:\nLatest answer")
			expect(notification.content).not.toContain("Inspect")
			expect(notification.content).not.toContain("activity.md")
			expect(notification.content).toContain("Descendants:")
			expect(notification.content).not.toContain("�")
			const full = Array.from({ length: 128 }, (_, index) => ({ ...notification, id: `notice-${index}` }))
			const bounded = appendTaskNotification(full, { ...notification, id: "notice-new" })
			expect(bounded).toHaveLength(128)
			expect(bounded[0]?.id).toBe("notice-1")
			expect(bounded.at(-1)?.id).toBe("notice-new")
			await unlink(paths.history)
			expect((await prepareTaskNotification(paths, metadata, run, "completion", "failed")).content).toContain("Latest answer")
			metadata.latestReply = null
			expect((await prepareTaskNotification(paths, metadata, run, "completion", "failed")).content).toContain("Output preview: (empty)")
			await releaseParentLeaseFor(workspace.cwd, "parent")
		})
	})
})

async function createTask(cwd: string, parentSessionId = "parent", taskRef = "a_12345678", childSessionId = "child") {
	const paths = await reserveTaskStorage(await ensureParentStorage(cwd, parentSessionId), () => taskRef)
	await initializeRetainedLogs(paths)
	const metadata: TaskMetadata = {
		version: TASK_METADATA_VERSION,
		...(taskRef.startsWith("b_")
			? {
					kind: "bash" as const,
					command: "printf hello",
					cwd,
					exitCode: null,
					signal: null
				}
			: {
					kind: "agent" as const,
					childSessionId,
					definitionName: "reviewer",
					model: { provider: "provider", id: "model" },
					thinking: "medium" as const,
					depth: 1,
					allowAgents: false,
					sessionConfig: {
						systemPrompt: "Review.",
						tools: null,
						excludeAgentsMd: false,
						scopedModels: [{ provider: "provider", id: "model" }]
					}
				}),
		taskRef: paths.taskRef,
		parentSessionId,
		label: "Review",
		state: "running",
		latestOutcome: null,
		lastRunSequence: 1,
		latestReply: null,
		activeRun: {
			id: "r_1111111111111111",
			sequence: 1,
			acceptanceOrder: 1,
			kind: "initial",
			state: "running",
			input: "Inspect",
			acceptedAt: 1,
			startedAt: 2,
			detachedAt: 3
		},
		queuedFollowUps: [],
		notifications: [],
		discardedAt: null,
		createdAt: 1,
		updatedAt: 2
	}
	await writeTaskMetadata(paths, metadata)
	return { paths, metadata }
}
