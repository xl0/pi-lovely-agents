import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent"
import {
	createAgentsConfigSpec,
	loadAgentsConfig,
	resolveAgentsConfig,
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
	test("loads defaults, merges scopes, and isolates invalid values", async () => {
		await withTempWorkspace(async workspace => {
			environment.PI_CODING_AGENT_DIR = workspace.agentDir
			await workspace.write(
				"agent/xl0-pi-lovely-agents.json",
				JSON.stringify({ maxConcurrency: 3, maxDepth: 4, waitMs: 1000, expandPromptTemplates: true })
			)
			await workspace.write(
				"workspace/.pi/xl0-pi-lovely-agents.json",
				JSON.stringify({ models: ["openai/gpt"], maxConcurrency: 2.5, maxDepth: -1 })
			)

			const loaded = loadAgentsConfig(workspace.cwd, configContext)
			expect(loaded.value).toEqual({
				models: ["openai/gpt"],
				maxConcurrency: 3,
				maxDepth: 4,
				waitMs: 1000,
				expandPromptTemplates: true
			})
			expect(loaded.warnings.map(warning => warning.key)).toEqual(["maxDepth", "maxConcurrency"])
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

	test("editor writes are reflected immediately", async () => {
		await withTempWorkspace(async workspace => {
			environment.PI_CODING_AGENT_DIR = workspace.agentDir
			const config = createAgentsConfigSpec(configContext).load(workspace.cwd)
			const updated = config.update("workspace", "waitMs", 0)
			expect(resolveAgentsConfig(updated).value.waitMs).toBe(0)
			expect(await Bun.file(join(workspace.cwd, ".pi/xl0-pi-lovely-agents.json")).json()).toEqual({ waitMs: 0 })
		})
	})

	test("builds a searchable selector from authenticated models", () => {
		const field = createAgentsConfigSpec(configContext).fields.find(field => field.key === "models")
		if (field?.kind !== "multiEnum") throw new Error("models field is not a multi-enum")
		expect(field).toMatchObject({
			kind: "multiEnum",
			values: ["anthropic/sonnet", "openai/gpt"],
			default: []
		})
		const sonnet: string = "anthropic/sonnet"
		expect(field.valueDescriptions?.[sonnet]).toBe("sonnet")
	})
})

describe("model choice", () => {
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
