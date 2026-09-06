import { BorderedLoader, CustomEditor, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent"
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
import { renderAgentNotification } from "./rendering.js"
import { createTaskPanel } from "./task-panel.js"
import { loadTaskList, registerRosterTool, registerTaskTools } from "./tools.js"
import { bindTaskUpdateRoute } from "./updates.js"

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>
const CREATION_TOOLS = new Set(["agent", "agent_roster"])
const TASK_TOOLS = new Set(["task_list", "task_output", "task_input", "task_stop", "task_discard"])

export default function lovelyAgentsExtension(pi: ExtensionAPI) {
	let configValue = defaultAgentsConfig
	let configWarnings: AgentsConfigWarning[] = []
	let currentDepth = 0
	let unbindNotificationRoute: (() => void) | undefined
	let taskPanel: ReturnType<typeof createTaskPanel> | undefined
	let previousEditorFactory: EditorFactory | undefined
	let taskEditorFactory: EditorFactory | undefined
	let unbindToolUpdates: (() => void) | undefined
	let unbindDisposal: (() => void) | undefined
	let toolRevision = 0
	let toolSession = 0
	const hiddenTools = new Set<string>()

	pi.registerMessageRenderer(NOTIFICATION_CUSTOM_TYPE, renderAgentNotification)

	const disposeBindings = () => {
		toolRevision++
		toolSession++
		unbindToolUpdates?.()
		unbindToolUpdates = undefined
		unbindNotificationRoute?.()
		unbindNotificationRoute = undefined
		unbindDisposal?.()
		unbindDisposal = undefined
	}

	const refreshToolVisibility = async (ctx: ExtensionContext) => {
		const revision = ++toolRevision
		const session = getAgentCoordinator().getSessionContext(ctx.sessionManager.getSessionId())
		const active = pi.getActiveTools()
		const canCreate =
			session?.allowAgents !== false &&
			(session?.depth ?? 0) < configValue.maxDepth &&
			(active.includes("agent") || hiddenTools.has("agent"))
		// Unimplemented fork/Bash capabilities are not task producers yet.
		const owned = canCreate ? undefined : (await loadTaskList(ctx.cwd, ctx.sessionManager.getSessionId())).details
		if (revision !== toolRevision) return
		const canControl = canCreate || (!!owned && (owned.total > 0 || owned.diagnostics.length > 0))
		const current = pi.getActiveTools()
		const allowed = (name: string) => (CREATION_TOOLS.has(name) ? canCreate : TASK_TOOLS.has(name) ? canControl : true)
		const next = current.filter(name => {
			if (allowed(name)) return true
			hiddenTools.add(name)
			return false
		})
		// Restore only tools this extension hid, never bypass an SDK/Definition allowlist.
		for (const name of hiddenTools) {
			if (!allowed(name)) continue
			if (!next.includes(name)) next.push(name)
			hiddenTools.delete(name)
		}
		if (next.join("\0") !== current.join("\0")) pi.setActiveTools(next)
	}
	const updateTools = (ctx: ExtensionContext) => {
		const revision = toolRevision + 1
		void refreshToolVisibility(ctx).catch(error => {
			if (revision === toolRevision) ctx.ui.notify(`Lovely Agents tool visibility: ${errorMessage(error)}`, "error")
		})
	}

	const applyConfig = (value: AgentsConfig, warnings: AgentsConfigWarning[], ctx: ExtensionContext) => {
		configValue = value
		configWarnings = warnings
		getAgentCoordinator(value.maxConcurrency).setMaxConcurrency(value.maxConcurrency)
		notifyConfigWarnings(ctx, warnings)
		registerAgentTool(pi, { getConfig: () => configValue, canDelegate: () => currentDepth + 1 < configValue.maxDepth })
		registerTaskInputTool(pi, { getConfig: () => configValue })
		updateTools(ctx)
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
		loadTasks: async () => (await loadTaskList(ctx.cwd, ctx.sessionManager.getSessionId(), { includeInputPreviews: true })).details,
		focusTasks: async () => {
			await taskPanel?.refresh()
			taskPanel?.focus()
		},
		inputTask: async (id, content, delivery) => {
			const options = { getConfig: () => configValue }
			if (configValue.capabilities.includes("backgroundAgents")) {
				await sendTaskInput(ctx, options, id, content, delivery)
				return
			}
			const failed = await ctx.ui.custom<{ error: unknown; cancelled: boolean } | undefined>((tui, theme, _keys, done) => {
				const loader = new BorderedLoader(tui, theme, `Running ${delivery} for ${id}…`)
				// Esc aborts the run; keep the dialog until its owned work has stopped.
				void sendTaskInput(ctx, options, id, content, delivery, loader.signal).then(
					() => done(undefined),
					error => done({ error, cancelled: loader.signal.aborted })
				)
				return loader
			})
			if (failed?.cancelled) return false
			if (failed) throw failed.error
		},
		controlTask: async (id, action) => {
			await controlTaskLifecycle(ctx, id, action)
			if (action === "discard") {
				pi.sendMessage(
					{
						customType: NOTIFICATION_CUSTOM_TYPE,
						content: `User manually discarded task ${id} and its descendants.\nFiles are archived; these tasks cannot receive further input.`,
						display: true
					},
					{ deliverAs: "steer", triggerTurn: false }
				)
			}
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
		disposeBindings()
		const toolSessionId = ++toolSession
		const disposeSignal = getAgentCoordinator().getSessionContext(parentSessionId)?.disposeSignal
		if (disposeSignal) {
			disposeSignal.addEventListener("abort", disposeBindings, { once: true })
			unbindDisposal = () => disposeSignal.removeEventListener("abort", disposeBindings)
		}
		unbindToolUpdates = bindTaskUpdateRoute(ctx.cwd, parentSessionId, () => {
			if (toolSessionId === toolSession) updateTools(ctx)
		})
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
		taskPanel?.dispose()
		taskPanel = undefined
		if (ctx.mode === "tui") {
			const options = managementOptions(ctx)
			taskPanel = createTaskPanel(ctx, {
				loadTasks: options.loadTasks,
				openSelection: selection => openTaskManagementUi(ctx, options, selection)
			})
		}
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
								if (taskPanel?.handleInput(data, target.getText() === "")) return
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
		await taskPanel?.refresh().catch(error => ctx.ui.notify(`Lovely Agents status refresh failed: ${errorMessage(error)}`, "warning"))
		await refreshToolVisibility(ctx)
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
		disposeBindings()
		if (event.reason === "reload" && hiddenTools.size > 0) {
			pi.setActiveTools([...new Set([...pi.getActiveTools(), ...hiddenTools])])
		}
		hiddenTools.clear()
		taskPanel?.dispose()
		taskPanel = undefined
		if (ctx.mode === "tui") {
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
	registerAgentTool(pi, { getConfig: () => configValue, canDelegate: () => currentDepth + 1 < configValue.maxDepth })
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
