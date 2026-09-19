import { afterEach, describe, expect, test } from "bun:test"
import type { ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent"
import {
	createAgentsConfigSpec,
	defaultAgentsConfig,
	loadAgentsConfig,
	resolveConfiguredModels,
	resolveModelChoices
} from "../../extensions/lovely-agents/config.js"
import { withTempWorkspace } from "./test-helpers.js"

const environment = process.env as { PI_CODING_AGENT_DIR?: string }
const previousAgentDir = environment.PI_CODING_AGENT_DIR
const models = [model("anthropic", "sonnet"), model("openai", "gpt")] as const
const configContext = {
	model: models[0],
	modelRegistry: { getAvailable: () => models }
} as unknown as Pick<ExtensionContext, "model" | "modelRegistry">

afterEach(() => {
	if (previousAgentDir === undefined) delete environment.PI_CODING_AGENT_DIR
	else environment.PI_CODING_AGENT_DIR = previousAgentDir
})

describe("Lovely Agents config", () => {
	test("background features are independent on-by-default switches with scoped overrides", async () => {
		await withTempWorkspace(async workspace => {
			environment.PI_CODING_AGENT_DIR = workspace.agentDir
			let config = createAgentsConfigSpec(configContext).load(workspace.cwd)
			expect(config.value).toMatchObject({ backgroundAgents: true, backgroundBash: true, maxBashConcurrency: 4 })
			config = config.update("user", "backgroundAgents", false)
			expect(config.value).toMatchObject({ backgroundAgents: false, backgroundBash: true })
			config = config.update("workspace", "backgroundAgents", true)
			config = config.update("workspace", "backgroundBash", false)
			expect(config.value).toMatchObject({ backgroundAgents: true, backgroundBash: false })
		})
	})

	test("loads defaults, merges scopes, and isolates invalid values", async () => {
		await withTempWorkspace(async workspace => {
			environment.PI_CODING_AGENT_DIR = workspace.agentDir
			await workspace.write(
				"agent/xl0-pi-lovely-agents.json",
				JSON.stringify({ maxConcurrency: 3, maxDepth: 4, waitMs: 1000, expandPromptTemplates: true })
			)
			await workspace.write(
				"workspace/.pi/xl0-pi-lovely-agents.json",
				JSON.stringify({ models: ["openai/gpt"], maxConcurrency: 2.5, maxBashConcurrency: 1.5, maxDepth: -1 })
			)

			const loaded = loadAgentsConfig(workspace.cwd, configContext)
			expect(loaded.value).toEqual({
				...defaultAgentsConfig,
				models: ["openai/gpt"],
				maxConcurrency: 3,
				maxDepth: 4,
				waitMs: 1000,
				expandPromptTemplates: true
			})
			expect(loaded.warnings.map(warning => warning.key)).toEqual(["maxDepth", "maxConcurrency", "maxBashConcurrency"])
		})
	})

	test("reports malformed files without failing", async () => {
		await withTempWorkspace(async workspace => {
			environment.PI_CODING_AGENT_DIR = workspace.agentDir
			await workspace.write("workspace/.pi/xl0-pi-lovely-agents.json", "not json")
			const loaded = loadAgentsConfig(workspace.cwd, configContext)
			expect(loaded.value.maxConcurrency).toBe(4)
			expect(loaded.warnings).toHaveLength(1)
			expect(loaded.warnings[0]?.message).toContain("Invalid config")
		})
	})

	test("unavailable saved models do not discard available choices or trigger a parent fallback", async () => {
		await withTempWorkspace(async workspace => {
			environment.PI_CODING_AGENT_DIR = workspace.agentDir
			const config = createAgentsConfigSpec(configContext).load(workspace.cwd)
			config.update("user", "models", ["anthropic/sonnet"])
			for (const selections of [["openai/gpt", "missing/model"], ["missing/model"]]) {
				config.update("workspace", "models", selections)
				const loaded = loadAgentsConfig(workspace.cwd, configContext)
				expect(loaded.value.models).toEqual(selections)
				expect(loaded.warnings).toHaveLength(1)
				expect(loaded.warnings[0]).toMatchObject({ scope: "workspace", key: "models" })
				const result = resolveConfiguredModels(loaded.value, configContext as ExtensionContext)
				expect(result.models).toEqual(selections.includes("openai/gpt") ? [{ model: models[1] }] : [])
				expect(result.diagnostics).toMatchObject([{ code: "no-match", pattern: "missing/model" }])
			}
		})
	})
})

describe("model choice", () => {
	test("alias targets join model choices without duplicating IDs or imposing their thinking on explicit IDs", () => {
		const result = resolveConfiguredModels(
			{
				...defaultAgentsConfig,
				fastModel: "openai/gpt",
				smartModel: "openai/gpt",
				workhorseModel: "anthropic/sonnet"
			},
			configContext as ExtensionContext
		)
		expect(result.models).toEqual([{ model: models[0] }, { model: models[1] }])
		expect(result.aliases).toEqual([
			{ name: "fast", model: models[1], thinkingLevel: "low" },
			{ name: "smart", model: models[1], thinkingLevel: "high" },
			{ name: "workhorse", model: models[0], thinkingLevel: "medium" }
		])
		expect(result.diagnostics).toEqual([])
		const explicit = resolveConfiguredModels(
			{
				...defaultAgentsConfig,
				models: ["openai/gpt"],
				fastModel: "openai/gpt"
			},
			configContext as ExtensionContext
		)
		expect(explicit.models).toEqual([{ model: models[1] }])
	})

	test("disabled aliases disappear and unavailable targets are diagnosed, never rerouted", () => {
		expect(resolveConfiguredModels(defaultAgentsConfig, configContext as ExtensionContext).aliases).toEqual([])
		const result = resolveConfiguredModels(
			{
				...defaultAgentsConfig,
				fastModel: "missing/model"
			},
			configContext as ExtensionContext
		)
		expect(result.aliases).toEqual([])
		expect(result.diagnostics[0]?.message).toContain('Model alias "fast" targets unavailable model')
		expect(result.models).toEqual([{ model: models[0] }])
	})

	test("resolves the parent fallback or selected models", () => {
		expect(resolveModelChoices({ selections: [], availableModels: models, parentModel: models[0] }).models).toEqual([{ model: models[0] }])
		expect(
			resolveModelChoices({
				selections: ["openai/gpt", "anthropic/sonnet"],
				availableModels: models,
				parentModel: models[0]
			}).models
		).toEqual([{ model: models[1] }, { model: models[0] }])
	})

	test("reports a selected model that is no longer available", () => {
		const result = resolveModelChoices({ selections: ["missing/model"], availableModels: models, parentModel: models[0] })
		expect(result.models).toEqual([])
		expect(result.diagnostics[0]).toMatchObject({ code: "no-match", pattern: "missing/model" })
	})
})

function model(provider: string, id: string): ScopedModel["model"] {
	return { provider, id, name: id } as ScopedModel["model"]
}
