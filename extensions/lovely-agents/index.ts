import { BorderedLoader, CustomEditor, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent"
import { ScopedConfigEditor } from "@xl0/pi-lovely-config"
import { controlTaskLifecycle, recoverProviderTuple, registerAgentTool, registerTaskInputTool, sendTaskInput } from "./agent.js"
import { registerBashTool } from "./bash.js"
import { type AgentsConfig, type AgentsConfigWarning, createAgentsConfigSpec, defaultAgentsConfig, resolveAgentsConfig } from "./config.js"
import { getAgentCoordinator, getBashCoordinator } from "./coordinator.js"
import { discoverAgentDefinitions, projectResourcesTrusted } from "./definitions.js"
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
import { acquireParentLease, ParentLeaseConflictError } from "./state.js"
import { createTaskPanel } from "./task-panel.js"
import { loadTaskList, registerRosterTool, registerTaskTools } from "./tools.js"

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>
const LOVELY_TOOLS = new Set(["agent", "agent_roster", "bash_bg", "task_list", "task_output", "task_input", "task_stop", "task_discard"])

export default function lovelyAgentsExtension(pi: ExtensionAPI) {
	let configValue = defaultAgentsConfig
	let configWarnings: AgentsConfigWarning[] = []
	let currentDepth = 0
	let unbindNotificationRoute: (() => void) | undefined
	let taskPanel: ReturnType<typeof createTaskPanel> | undefined
	let previousEditorFactory: EditorFactory | undefined
	let taskEditorFactory: EditorFactory | undefined
	let unbindDisposal: (() => void) | undefined
	let ownershipWarning: string | undefined
	/** Hidden only on a lease conflict; tool limits are otherwise enforced at execution. */
	const hiddenTools = new Set<string>()

	pi.registerMessageRenderer(NOTIFICATION_CUSTOM_TYPE, renderAgentNotification)

	const disposeBindings = () => {
		unbindNotificationRoute?.()
		unbindNotificationRoute = undefined
		unbindDisposal?.()
		unbindDisposal = undefined
	}

	const applyConfig = (value: AgentsConfig, warnings: AgentsConfigWarning[], ctx: ExtensionContext) => {
		configValue = value
		configWarnings = warnings
		getAgentCoordinator(value.maxConcurrency).setMaxConcurrency(value.maxConcurrency)
		getBashCoordinator(value.maxBashConcurrency).setMaxConcurrency(value.maxBashConcurrency)
		notifyConfigWarnings(ctx, warnings)
	}
	const loadConfig = (ctx: ExtensionContext) => {
		const config = createAgentsConfigSpec(ctx).load(ctx.cwd)
		const loaded = resolveAgentsConfig(config, projectResourcesTrusted(ctx))
		applyConfig(loaded.value, loaded.warnings, ctx)
		return config
	}
	const managementOptions = (ctx: ExtensionContext): ManagementUiOptions => ({
		discoverDefinitions: () =>
			discoverAgentDefinitions({
				cwd: ctx.cwd,
				projectTrusted: projectResourcesTrusted(ctx),
				toolNames: pi.getAllTools().map(tool => tool.name),
				models: ctx.modelRegistry.getAll()
			}),
		loadTasks: async () => (await loadTaskList(ctx.cwd, ctx.sessionManager.getSessionId(), { includeInputPreviews: true })).details,
		focusTasks: async () => {
			await taskPanel?.refresh()
			taskPanel?.focus()
		},
		inputTask: async (id, content, delivery, eof) => {
			const options = { getConfig: () => configValue }
			const send = (signal?: AbortSignal) =>
				sendTaskInput(ctx, options, id, content, delivery === "stdin" ? undefined : delivery, signal, eof === undefined ? {} : { eof })
			if (configValue.backgroundAgents && delivery !== "stdin") {
				await send()
				return
			}
			const failed = await ctx.ui.custom<{ error: unknown; cancelled: boolean } | undefined>((tui, theme, _keys, done) => {
				const loader = new BorderedLoader(tui, theme, `${delivery === "stdin" ? "Sending" : "Running"} ${delivery} for ${id}…`)
				// Cancel the pending operation; already-written stdin cannot be undone.
				void send(loader.signal).then(
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
						content: `User manually discarded task ${id} and its descendants.\nFiles stay at their original paths for read-only inspection; these tasks cannot receive further input.`,
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
							const loaded = resolveAgentsConfig(config, projectResourcesTrusted(ctx))
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
		taskPanel?.dispose()
		taskPanel = undefined
		ownershipWarning = undefined
		if (ctx.mode === "tui") ctx.ui.setStatus("lovely-agents", undefined)
		// Do not bind routes or reconcile notifications without owning this partition.
		try {
			await acquireParentLease(ctx.cwd, parentSessionId)
		} catch (error) {
			if (!(error instanceof ParentLeaseConflictError)) throw error
			ownershipWarning = `Session already open in Pi PID ${error.ownerPid}. Lovely Agents is disabled here; use /resume to choose another session.`
			if (ctx.mode === "tui") {
				ctx.ui.setStatus(
					"lovely-agents",
					ctx.ui.theme.fg("warning", `⚠ Session in use by PID ${error.ownerPid} — /resume to choose another`)
				)
			}
			pi.setActiveTools(
				pi.getActiveTools().filter(name => {
					if (!LOVELY_TOOLS.has(name)) return true
					hiddenTools.add(name)
					return false
				})
			)
			ctx.ui.notify(ownershipWarning, "warning")
			return
		}
		const disposeSignal = getAgentCoordinator().getSessionContext(parentSessionId)?.disposeSignal
		if (disposeSignal) {
			disposeSignal.addEventListener("abort", disposeBindings, { once: true })
			unbindDisposal = () => disposeSignal.removeEventListener("abort", disposeBindings)
		}
		// Waking an idle managed child would run a turn outside its runtime's permit and
		// provider gate; append instead, so the child sees the notice on its next run.
		const managed = getAgentCoordinator().getSessionContext(parentSessionId) !== undefined
		unbindNotificationRoute = getAgentCoordinator().bindNotificationRoute(notificationRouteKey(ctx.cwd, parentSessionId), notification => {
			pi.sendMessage(
				{
					customType: NOTIFICATION_CUSTOM_TYPE,
					content: notification.content,
					display: true,
					details: { notificationId: notification.id, taskRef: notification.taskRef }
				},
				{ triggerTurn: !managed || !ctx.isIdle(), deliverAs: "steer" }
			)
		})
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
	})

	pi.on("message_end", async (event, ctx) => {
		if (ownershipWarning) return
		if (event.message.role !== "custom" || event.message.customType !== NOTIFICATION_CUSTOM_TYPE) return
		const details = notificationDetails(event.message.details)
		if (!details) return
		try {
			await observeNotification(ctx.cwd, ctx.sessionManager.getSessionId(), details.taskRef, details.notificationId)
		} catch (error) {
			ctx.ui.notify(`Lovely Agents could not mark notification delivered: ${errorMessage(error)}`, "warning")
		}
	})

	// Abort or run-end queue clearing drops steered notices without message_end;
	// the transcript is authoritative once the run has ended.
	pi.on("agent_end", async (_event, ctx) => {
		if (ownershipWarning || !unbindNotificationRoute) return
		const parentSessionId = ctx.sessionManager.getSessionId()
		clearNotificationInFlight(ctx.cwd, parentSessionId)
		try {
			await reconcileParentNotifications(ctx.cwd, parentSessionId, ctx.sessionManager.getBranch())
		} catch (error) {
			ctx.ui.notify(`Lovely Agents notification recovery failed: ${errorMessage(error)}`, "warning")
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
			ctx.ui.setStatus("lovely-agents", undefined)
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
		description: "Manage Lovely Agent definitions, tasks, and settings",
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") return
			if (ownershipWarning) {
				ctx.ui.notify(ownershipWarning, "warning")
				return
			}
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
			if (ownershipWarning) {
				ctx.ui.notify(ownershipWarning, "warning")
				return
			}
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
	registerBashTool(pi, { getConfig: () => configValue })
	registerTaskInputTool(pi, { getConfig: () => configValue })
	registerTaskTools(pi, {
		beforeParentLeaseRelease: async (cwd, parentSessionId) => {
			if (ownershipWarning) return
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
	if (
		message.role !== "assistant" ||
		(message.stopReason !== "stop" && message.stopReason !== "toolUse") ||
		!message.provider ||
		!message.model
	) {
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
	for (const warning of warnings) ctx.ui.notify(`${warning.path}: ${warning.message}`, "warning")
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
