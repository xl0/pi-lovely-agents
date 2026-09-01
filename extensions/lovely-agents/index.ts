import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function lovelyAgentsExtension(pi: ExtensionAPI) {
	pi.registerCommand("continue", {
		description: "Continue after an error or aborted turn",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is still running", "warning")
				return
			}
			pi.sendUserMessage("Continue.")
		}
	})
}
