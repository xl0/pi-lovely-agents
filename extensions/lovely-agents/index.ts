import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { ScopedConfigEditor } from "@xl0/pi-lovely-config"
import { registerAgentTool } from "./agent.js"
import { type AgentsConfig, type AgentsConfigWarning, createAgentsConfigSpec, defaultAgentsConfig, resolveAgentsConfig } from "./config.js"
import { getAgentCoordinator } from "./coordinator.js"
import { discoverAgentDefinitions } from "./definitions.js"
import { reconcileParentTasks, stopOwnedTaskTree } from "./lifecycle.js"
import { openManagementUi, stopFixtureTimersFor } from "./management.js"
import { loadTaskList, registerRosterTool, registerTaskTools } from "./tools.js"

export default function lovelyAgentsExtension(pi: ExtensionAPI) {
	let configValue = defaultAgentsConfig
	let configWarnings: AgentsConfigWarning[] = []
	let currentDepth = 0

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

	pi.on("session_start", async (_event, ctx) => {
		try {
			currentDepth = getAgentCoordinator().getSessionContext(ctx.sessionManager.getSessionId())?.depth ?? 0
			loadConfig(ctx)
		} catch (error) {
			configValue = defaultAgentsConfig
			configWarnings = []
			getAgentCoordinator(defaultAgentsConfig.maxConcurrency).setMaxConcurrency(defaultAgentsConfig.maxConcurrency)
			ctx.ui.notify(`Lovely Agents config error: ${errorMessage(error)}`, "error")
		}
		if (_event.reason !== "reload") {
			try {
				const reconciled = await reconcileParentTasks(ctx.cwd, ctx.sessionManager.getSessionId())
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
	})

	pi.registerCommand("lovely-agents", {
		description: "Manage Lovely Agent definitions, tasks, fixtures, and settings",
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") return
			try {
				await openManagementUi(ctx, {
					discoverDefinitions: () =>
						discoverAgentDefinitions({
							cwd: ctx.cwd,
							projectTrusted: ctx.isProjectTrusted(),
							toolNames: pi.getAllTools().map(tool => tool.name),
							models: ctx.modelRegistry.getAll()
						}),
					loadTasks: async () => (await loadTaskList(ctx.cwd, ctx.sessionManager.getSessionId())).details,
					openConfig: async () => {
						const config = loadConfig(ctx)
						await ctx.ui.custom<void>(
							(tui, theme, _keybindings, done) =>
								new ScopedConfigEditor({
									tui,
									theme,
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
