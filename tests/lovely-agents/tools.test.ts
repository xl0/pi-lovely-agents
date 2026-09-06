import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent"
import { type AgentsConfig, defaultAgentsConfig } from "../../extensions/lovely-agents/config.js"
import { type buildRosterToolResult, registerRosterTool } from "../../extensions/lovely-agents/tools.js"
import { definitionSource, withTempWorkspace } from "./test-helpers.js"

describe("agent_roster tool", () => {
	test("rescans definitions on every call", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/alpha.md", definitionSource("alpha"))
			let currentConfig = config
			let captured: CapturedTool | undefined
			const api = {
				registerTool(tool: unknown) {
					captured = tool as CapturedTool
				},
				getAllTools() {
					return [{ name: "read" }, { name: "agent_roster" }]
				}
			} as unknown as ExtensionAPI
			registerRosterTool(api, {
				getConfig: () => currentConfig,
				getConfigWarnings: () => [],
				getDepth: () => 1,
				getAgentDir: () => workspace.agentDir
			})
			if (!captured) throw new Error("agent_roster was not registered")
			const ctx = {
				cwd: workspace.cwd,
				model: model("anthropic", "sonnet"),
				modelRegistry: {
					getAvailable: () => [model("anthropic", "sonnet")],
					getAll: () => [model("anthropic", "sonnet")]
				},
				isProjectTrusted: () => true
			} as unknown as ExtensionContext

			const first = await captured.execute("one", {}, undefined, undefined, ctx)
			expect(first.details.definitions.map(item => item.name)).toEqual(["alpha"])

			await workspace.write("agent/agents/beta.md", definitionSource("beta"))
			const second = await captured.execute("two", {}, undefined, undefined, ctx)
			expect(second.details.definitions.map(item => item.name)).toEqual(["alpha", "beta"])
			expect(second.details.models).toEqual([{ id: "anthropic/sonnet" }])
			expect(second.content[0]?.text).toContain("name: beta")
			currentConfig = { ...config, fastModel: "anthropic/sonnet", fastThinking: "low" }
			const aliased = await captured.execute("alias", {}, undefined, undefined, ctx)
			expect(aliased.details.aliases).toMatchObject([
				{
					name: "fast",
					model: "anthropic/sonnet",
					thinking: "low"
				}
			])
			expect(aliased.details.models).toEqual([{ id: "anthropic/sonnet" }])
			expect(aliased.content[0]?.text).toContain("name: fast\n    model: anthropic/sonnet:low")
			currentConfig = { ...currentConfig, fastThinking: "high" }
			expect((await captured.execute("changed", {}, undefined, undefined, ctx)).details.aliases[0]?.thinking).toBe("high")
		})
	})
})

const config: AgentsConfig = {
	...defaultAgentsConfig,
	models: [],
	maxConcurrency: 4,
	maxDepth: 2,
	waitMs: 30_000,
	expandPromptTemplates: false
}

type CapturedTool = {
	execute(
		toolCallId: string,
		params: Record<string, never>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext
	): Promise<ReturnType<typeof buildRosterToolResult>>
}

function model(provider: string, id: string): ScopedModel["model"] {
	return { provider, id, name: id } as ScopedModel["model"]
}
