import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function lovelyAgentsExtension(pi: ExtensionAPI) {
	pi.registerCommand("continue", {
		description: "Retry the latest errored or aborted turn",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is still running", "warning")
				return
			}
			const lastAssistant = ctx.sessionManager
				.getBranch()
				.reverse()
				.find(entry => entry.type === "message" && entry.message.role === "assistant")
			if (
				lastAssistant?.type !== "message" ||
				lastAssistant.message.role !== "assistant" ||
				(lastAssistant.message.stopReason !== "error" && lastAssistant.message.stopReason !== "aborted")
			) {
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
}
