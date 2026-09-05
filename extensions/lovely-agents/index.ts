import { CustomEditor, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent"
import { Key, matchesKey } from "@earendil-works/pi-tui"
import { ScopedConfigEditor } from "@xl0/pi-lovely-config"
import { controlTaskLifecycle, recoverProviderTuple, registerAgentTool, registerTaskInputTool, sendTaskInput } from "./agent.js"
import { type AgentsConfig, type AgentsConfigWarning, createAgentsConfigSpec, defaultAgentsConfig, resolveAgentsConfig } from "./config.js"
import { getAgentCoordinator } from "./coordinator.js"
import { discoverAgentDefinitions } from "./definitions.js"
import { reconcileParentTasks, recoverOwnedTaskTree, stopOwnedTaskTree } from "./lifecycle.js"
import { type ManagementUiOptions, openManagementUi, openTaskManagementUi, stopFixtureTimersFor } from "./management.js"
import {
	clearNotificationInFlight,
	NOTIFICATION_CUSTOM_TYPE,
	notificationDetails,
	notificationRouteKey,
	observeNotification,
	reconcileParentNotifications
} from "./notifications.js"
import { renderExpandableResult } from "./rendering.js"
import { loadTaskList, registerRosterTool, registerTaskTools } from "./tools.js"
import { bindTaskUpdateRoute } from "./updates.js"

const TASK_STATUS_ID = "lovely-agents"
const TASK_WIDGET_ID = "lovely-agents"
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>

export default function lovelyAgentsExtension(pi: ExtensionAPI) {
	let configValue = defaultAgentsConfig
	let configWarnings: AgentsConfigWarning[] = []
	let currentDepth = 0
	let unbindNotificationRoute: (() => void) | undefined
	let unbindTaskUpdates: (() => void) | undefined
	let previousEditorFactory: EditorFactory | undefined
	let taskEditorFactory: EditorFactory | undefined

	pi.registerMessageRenderer(NOTIFICATION_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter(part => part.type === "text")
						.map(part => part.text)
						.join("\n")
		return renderExpandableResult({ content: [{ type: "text", text: content }] }, expanded, theme, outputPad)
	})

	const applyConfig = (value: AgentsConfig, warnings: AgentsConfigWarning[], ctx: ExtensionContext) => {
		configValue = value
		configWarnings = warnings
		getAgentCoordinator(value.maxConcurrency).setMaxConcurrency(value.maxConcurrency)
		notifyConfigWarnings(ctx, warnings)
	}
	const loadConfig = (ctx: ExtensionContext) => {
		const config = createAgentsConfigSpec(ctx).load(ctx.cwd)
		const loaded = resolveAgentsConfig(config)
		applyConfig(loaded.value, loaded.warnings, ctx)
		return config
	}
	const managementOptions = (ctx: ExtensionContext): ManagementUiOptions => ({
		discoverDefinitions: () =>
			discoverAgentDefinitions({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				toolNames: pi.getAllTools().map(tool => tool.name),
				models: ctx.modelRegistry.getAll()
			}),
		loadTasks: async () => (await loadTaskList(ctx.cwd, ctx.sessionManager.getSessionId())).details,
		inputTask: async (id, content, delivery) => {
			await sendTaskInput(ctx, { getConfig: () => configValue }, id, content, delivery)
		},
		controlTask: async (id, action) => {
			await controlTaskLifecycle(ctx, id, action)
		},
		openConfig: async () => {
			const config = loadConfig(ctx)
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new ScopedConfigEditor({
						tui,
						theme: theme as unknown as ConstructorParameters<typeof ScopedConfigEditor>[0]["theme"],
						config,
						onChange(config) {
							const loaded = resolveAgentsConfig(config)
							applyConfig(loaded.value, loaded.warnings, ctx)
						},
						done
					})
			)
		}
	})

	pi.on("session_start", async (_event, ctx) => {
		const parentSessionId = ctx.sessionManager.getSessionId()
		unbindNotificationRoute?.()
		unbindNotificationRoute = getAgentCoordinator().bindNotificationRoute(notificationRouteKey(ctx.cwd, parentSessionId), notification => {
			pi.sendMessage(
				{
					customType: NOTIFICATION_CUSTOM_TYPE,
					content: notification.content,
					display: true,
					details: { notificationId: notification.id, taskRef: notification.taskRef }
				},
				{ triggerTurn: true, deliverAs: "steer" }
			)
		})
		unbindTaskUpdates?.()
		let refreshing = false
		let refreshAgain = false
		const refreshTasks = async () => {
			if (ctx.mode !== "tui") return
			if (refreshing) {
				refreshAgain = true
				return
			}
			refreshing = true
			try {
				do {
					refreshAgain = false
					const tasks = (await loadTaskList(ctx.cwd, parentSessionId)).details.tasks
					const active = tasks.filter(task => task.state === "queued" || task.state === "running" || task.state === "suspended")
					ctx.ui.setStatus(TASK_STATUS_ID, active.length > 0 ? `agents:${active.length}` : undefined)
					ctx.ui.setWidget(TASK_WIDGET_ID, active.length > 0 ? renderActiveTaskRows(active) : undefined, { placement: "belowEditor" })
				} while (refreshAgain)
			} finally {
				refreshing = false
			}
		}
		unbindTaskUpdates = bindTaskUpdateRoute(ctx.cwd, parentSessionId, refreshTasks)
		try {
			currentDepth = getAgentCoordinator().getSessionContext(parentSessionId)?.depth ?? 0
			loadConfig(ctx)
		} catch (error) {
			configValue = defaultAgentsConfig
			configWarnings = []
			getAgentCoordinator(defaultAgentsConfig.maxConcurrency).setMaxConcurrency(defaultAgentsConfig.maxConcurrency)
			ctx.ui.notify(`Lovely Agents config error: ${errorMessage(error)}`, "error")
		}
		if (_event.reason !== "reload") {
			try {
				const reconciled = await reconcileParentTasks(ctx.cwd, parentSessionId)
				if (reconciled.interrupted > 0) {
					ctx.ui.notify(`Lovely Agents marked ${reconciled.interrupted} stale task(s) interrupted.`, "warning")
				}
				if (reconciled.diagnostics.length > 0) {
					ctx.ui.notify(`Lovely Agents skipped ${reconciled.diagnostics.length} invalid task(s) during recovery.`, "warning")
				}
			} catch (error) {
				ctx.ui.notify(`Lovely Agents recovery failed: ${errorMessage(error)}`, "warning")
			}
		}
		try {
			const notifications = await reconcileParentNotifications(ctx.cwd, parentSessionId, ctx.sessionManager.getBranch())
			if (notifications.diagnostics.length > 0) {
				ctx.ui.notify(`Lovely Agents skipped ${notifications.diagnostics.length} notification task(s).`, "warning")
			}
		} catch (error) {
			ctx.ui.notify(`Lovely Agents notification recovery failed: ${errorMessage(error)}`, "warning")
		}
		if (ctx.mode === "tui") {
			previousEditorFactory = ctx.ui.getEditorComponent()
			const baseFactory: EditorFactory = previousEditorFactory ?? ((tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings))
			taskEditorFactory = (tui, theme, keybindings) => {
				const editor = baseFactory(tui, theme, keybindings)
				return new Proxy(editor, {
					get(target, property) {
						if (property === "handleInput") {
							return (data: string) => {
								if (matchesKey(data, Key.down) && target.getText() === "") {
									void openTaskManagementUi(ctx, managementOptions(ctx)).catch(error =>
										ctx.ui.notify(`Lovely Agents task UI error: ${errorMessage(error)}`, "error")
									)
									return
								}
								target.handleInput(data)
							}
						}
						const value = Reflect.get(target, property, target)
						return typeof value === "function" ? value.bind(target) : value
					},
					set(target, property, value) {
						return Reflect.set(target, property, value, target)
					}
				})
			}
			ctx.ui.setEditorComponent(taskEditorFactory)
		}
		await refreshTasks().catch(error => ctx.ui.notify(`Lovely Agents status refresh failed: ${errorMessage(error)}`, "warning"))
	})

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "custom" || event.message.customType !== NOTIFICATION_CUSTOM_TYPE) return
		const details = notificationDetails(event.message.details)
		if (!details) return
		try {
			await observeNotification(ctx.cwd, ctx.sessionManager.getSessionId(), details.taskRef, details.notificationId)
		} catch (error) {
			ctx.ui.notify(`Lovely Agents could not mark notification delivered: ${errorMessage(error)}`, "warning")
		}
	})

	pi.on("session_shutdown", (event, ctx) => {
		unbindNotificationRoute?.()
		unbindNotificationRoute = undefined
		unbindTaskUpdates?.()
		unbindTaskUpdates = undefined
		if (ctx.mode === "tui") {
			ctx.ui.setStatus(TASK_STATUS_ID, undefined)
			ctx.ui.setWidget(TASK_WIDGET_ID, undefined)
			if (ctx.ui.getEditorComponent() === taskEditorFactory) ctx.ui.setEditorComponent(previousEditorFactory)
			taskEditorFactory = undefined
			previousEditorFactory = undefined
		}
		if (event.reason !== "reload") clearNotificationInFlight(ctx.cwd, ctx.sessionManager.getSessionId())
	})

	pi.on("turn_end", event => {
		const tuple = successfulTurnTuple(event.message)
		if (tuple) recoverProviderTuple(tuple)
	})

	pi.registerCommand("lovely-agents", {
		description: "Manage Lovely Agent definitions, tasks, fixtures, and settings",
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") return
			try {
				await openManagementUi(ctx, managementOptions(ctx))
			} catch (error) {
				ctx.ui.notify(`Lovely Agents management error: ${errorMessage(error)}`, "error")
			}
		}
	})

	pi.registerCommand("continue", {
		description: "Retry the latest errored or aborted turn",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is still running", "warning")
				return
			}
			if (!latestReplyWasInterrupted(ctx.sessionManager.getBranch())) return
			try {
				const recovered = await recoverOwnedTaskTree(ctx.cwd, ctx.sessionManager.getSessionId())
				if (recovered.diagnostics.length > 0) {
					ctx.ui.notify(`Lovely Agents skipped ${recovered.diagnostics.length} task(s) during recovery.`, "warning")
				}
			} catch (error) {
				ctx.ui.notify(`Lovely Agents recovery failed: ${errorMessage(error)}`, "warning")
				return
			}
			pi.sendMessage(
				{
					customType: "lovely-agents:continue",
					content: [],
					display: false
				},
				{ triggerTurn: true, deliverAs: "followUp" }
			)
		}
	})

	registerRosterTool(pi, {
		getConfig: () => configValue,
		getConfigWarnings: () => configWarnings,
		getDepth: () => currentDepth
	})
	registerAgentTool(pi, { getConfig: () => configValue })
	registerTaskInputTool(pi, { getConfig: () => configValue })
	registerTaskTools(pi, {
		beforeParentLeaseRelease: async (cwd, parentSessionId) => {
			try {
				await stopFixtureTimersFor(cwd, parentSessionId)
			} finally {
				await stopOwnedTaskTree(cwd, parentSessionId)
			}
		}
	})
}

export function renderActiveTaskRows(tasks: readonly { id: string; label: string; state: string; queuedFollowUps: number }[]): string[] {
	const rows = tasks
		.slice(0, 5)
		.map(task => `↳ ${task.id} ${task.state} ${task.label}${task.queuedFollowUps ? ` (+${task.queuedFollowUps})` : ""}`)
	if (tasks.length > rows.length) rows.push(`  … ${tasks.length - rows.length} more active`)
	return rows
}

export function successfulTurnTuple(message: {
	role: string
	stopReason?: string
	provider?: string
	model?: string
}): { provider: string; model: string } | undefined {
	if (message.role !== "assistant" || message.stopReason !== "stop" || !message.provider || !message.model) {
		return undefined
	}
	return { provider: message.provider, model: message.model }
}

export function latestReplyWasInterrupted(entries: readonly SessionEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue
		return entry.message.stopReason === "error" || entry.message.stopReason === "aborted"
	}
	return false
}

function notifyConfigWarnings(ctx: ExtensionContext, warnings: readonly AgentsConfigWarning[]): void {
	if (warnings.length === 0) return
	ctx.ui.notify(warnings.map(warning => `${warning.path}: ${warning.message}`).join("\n"), "warning")
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
