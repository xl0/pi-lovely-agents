import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent"
import type { AgentsConfig } from "../../extensions/lovely-agents/config.js"
import { buildRosterToolResult, registerRosterTool } from "../../extensions/lovely-agents/tools.js"
import { definitionSource, withTempWorkspace } from "./test-helpers.js"

describe("agent_roster result", () => {
	test("renders compact YAML-like output without empty bookkeeping", () => {
		const roster = buildRosterToolResult({
			definitions: [],
			diagnostics: [],
			models: [{ model: model("openai-codex", "gpt-5.6-sol") }],
			currentDepth: 0,
			maximumDepth: 2
		})
		expect(roster.content[0].text).toBe("definitions: []\nmodels:\n  - openai-codex/gpt-5.6-sol\ndepth: 0/2")
	})
})

describe("agent_roster tool", () => {
	test("rescans definitions on every call", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/alpha.md", definitionSource("alpha"))
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
				getConfig: () => config,
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
			expect(second.content[0]?.text).toBe(`definitions:
  - name: alpha
    description: "Description for alpha"
    path: ../agent/agents/alpha.md
  - name: beta
    description: "Description for beta"
    path: ../agent/agents/beta.md
models:
  - anthropic/sonnet
depth: 1/2`)
		})
	})
})

const config: AgentsConfig = {
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
