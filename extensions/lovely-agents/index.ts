import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { ScopedConfigEditor } from "@xl0/pi-lovely-config"
import { type AgentsConfig, type AgentsConfigWarning, createAgentsConfigSpec, defaultAgentsConfig, resolveAgentsConfig } from "./config.js"
import { registerRosterTool } from "./tools.js"

export default function lovelyAgentsExtension(pi: ExtensionAPI) {
	let configValue = defaultAgentsConfig
	let configWarnings: AgentsConfigWarning[] = []

	const applyConfig = (value: AgentsConfig, warnings: AgentsConfigWarning[], ctx: ExtensionContext) => {
		configValue = value
		configWarnings = warnings
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
			loadConfig(ctx)
		} catch (error) {
			configValue = defaultAgentsConfig
			configWarnings = []
			ctx.ui.notify(`Lovely Agents config error: ${errorMessage(error)}`, "error")
		}
	})

	pi.registerCommand("lovely-agents", {
		description: "Configure Lovely Agents settings",
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") return
			try {
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
			} catch (error) {
				ctx.ui.notify(`Lovely Agents config error: ${errorMessage(error)}`, "error")
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
		getConfigWarnings: () => configWarnings
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
