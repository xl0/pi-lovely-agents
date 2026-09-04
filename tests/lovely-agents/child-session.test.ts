import { describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { createSyntheticSourceInfo, ModelRuntime, type ScopedModel, type Skill } from "@earendil-works/pi-coding-agent"
import {
	buildDefinitionSystemPrompt,
	childPromptOptions,
	createChildSession,
	resolveChildSessionSelection,
	resolveChildToolPolicy
} from "../../extensions/lovely-agents/child-session.js"
import { getAgentCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import type { AgentDefinition } from "../../extensions/lovely-agents/definitions.js"
import { ensureParentStorage, initializeRetainedLogs, reserveTaskStorage } from "../../extensions/lovely-agents/state.js"
import { withTempWorkspace } from "./test-helpers.js"

const parentModel = model("provider", "parent")
const definitionModel = model("provider", "definition")
const callModel = model("provider", "call")
const definition: AgentDefinition = {
	name: "reviewer",
	description: "Review changes",
	systemPrompt: "Review the requested change.",
	source: "project",
	filePath: "/workspace/.pi/agents/reviewer.md",
	displayPath: ".pi/agents/reviewer.md",
	model: "provider/definition",
	thinking: "high",
	tools: ["read", "agent"]
}
const inheritedDefinition: AgentDefinition = {
	name: definition.name,
	description: definition.description,
	systemPrompt: definition.systemPrompt,
	source: definition.source,
	filePath: definition.filePath,
	displayPath: definition.displayPath
}

describe("child session selection", () => {
	test("applies call, Definition, and parent precedence", () => {
		expect(
			resolveChildSessionSelection({
				callModel: "provider/call",
				callThinking: "low",
				definition,
				configuredModels: [{ model: callModel }],
				availableModels: [definitionModel],
				parentModel,
				parentThinking: "medium"
			})
		).toEqual({ model: callModel, thinking: "low" })
		expect(
			resolveChildSessionSelection({
				definition,
				configuredModels: [],
				availableModels: [definitionModel],
				parentModel,
				parentThinking: "medium"
			})
		).toEqual({ model: definitionModel, thinking: "high" })
		expect(
			resolveChildSessionSelection({
				definition: inheritedDefinition,
				configuredModels: [],
				availableModels: [],
				parentModel,
				parentThinking: "medium"
			})
		).toEqual({ model: parentModel, thinking: "medium" })
	})

	test("rejects unconfigured call models and unauthenticated Definition models", () => {
		expect(() =>
			resolveChildSessionSelection({
				callModel: "provider/call",
				definition,
				configuredModels: [],
				availableModels: [definitionModel],
				parentModel,
				parentThinking: "medium"
			})
		).toThrow("not an available configured choice")
		expect(() =>
			resolveChildSessionSelection({
				definition,
				configuredModels: [],
				availableModels: [],
				parentModel,
				parentThinking: "medium"
			})
		).toThrow("not authenticated")
	})
})

describe("child tools and prompt", () => {
	test("enforces depth and delegation while preserving explicit allowlists", () => {
		expect(resolveChildToolPolicy({ definitionTools: ["read", "agent"], parentDepth: 0, maximumDepth: 2, allowAgents: false })).toEqual({
			tools: ["read"],
			excludeTools: ["agent"],
			depth: 1,
			allowAgents: false
		})
		expect(resolveChildToolPolicy({ definitionTools: ["read", "agent"], parentDepth: 0, maximumDepth: 2, allowAgents: true })).toEqual({
			tools: ["read", "agent"],
			excludeTools: [],
			depth: 1,
			allowAgents: true
		})
		expect(resolveChildToolPolicy({ parentDepth: 1, maximumDepth: 2, allowAgents: true })).toEqual({
			excludeTools: ["agent"],
			depth: 2,
			allowAgents: false
		})
		expect(() => resolveChildToolPolicy({ parentDepth: 2, maximumDepth: 2, allowAgents: false })).toThrow("exceeds configured maximum")
	})

	test("composes the Definition body with active tools and Pi resources", () => {
		const prompt = buildDefinitionSystemPrompt({
			customPrompt: "Own the review role.",
			selectedTools: ["bash", "review"],
			toolSnippets: { bash: "Run commands", review: "Record a finding" },
			promptGuidelines: ["Verify every claim", "Verify every claim"],
			appendSystemPrompt: "Appended policy",
			contextFiles: [{ path: "/workspace/AGENTS.md", content: "Project policy" }],
			skills: [skill("audit", "Audit changes", "/skills/audit/SKILL.md")],
			cwd: "C:\\workspace"
		})
		expect(prompt.startsWith("Own the review role.\n\nAvailable tools:")).toBe(true)
		expect(prompt).toContain("- review: Record a finding")
		expect(prompt.match(/Verify every claim/g)).toHaveLength(1)
		expect(prompt).toContain("Appended policy")
		expect(prompt).toContain('<project_instructions path="/workspace/AGENTS.md">')
		expect(prompt).toContain("Use the bash tool to load a skill")
		expect(prompt).toContain("Current working directory: C:/workspace")
		expect(childPromptOptions(false)).toEqual({ expandPromptTemplates: false })
		expect(childPromptOptions(true)).toEqual({ expandPromptTemplates: true })
	})
})

describe("persistent child session construction", () => {
	test("uses the retained session path, explicit tools, context policy, and managed depth", async () => {
		await withTempWorkspace(async workspace => {
			const testGlobals = globalThis as typeof globalThis & { __lovelyChildHookStarted?: boolean }
			await workspace.write("workspace/AGENTS.md", "INCLUDED PROJECT POLICY")
			await workspace.write(
				"agent/extensions/child-hook.ts",
				`export default function (pi) {
\tpi.registerTool({
\t\tname: "child_hook",
\t\tlabel: "Child Hook",
\t\tdescription: "Test child extension loading",
\t\tpromptSnippet: "Use the child hook",
\t\tparameters: { type: "object", properties: {}, additionalProperties: false },
\t\texecute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} })
\t})
\tpi.on("session_start", () => { globalThis.__lovelyChildHookStarted = true })
}`
			)
			const paths = await reserveTaskStorage(await ensureParentStorage(workspace.cwd, "parent-session"), () => "a_12345678")
			await initializeRetainedLogs(paths)
			const runtime = await ModelRuntime.create({
				authPath: join(workspace.agentDir, "auth.json"),
				modelsPath: join(workspace.agentDir, "models.json")
			})
			const selectedModel = runtime.getModel("anthropic", "claude-sonnet-4-5")
			if (!selectedModel) throw new Error("Expected built-in test model")
			const handle = await createChildSession({
				cwd: workspace.cwd,
				paths,
				definition: { ...inheritedDefinition, tools: ["read", "child_hook"] },
				selection: { model: selectedModel, thinking: "off" },
				scopedModels: [{ model: selectedModel }],
				parentDepth: 0,
				maximumDepth: 2,
				allowAgents: false,
				projectTrusted: true,
				agentDir: workspace.agentDir
			})
			const childSessionId = handle.session.sessionId
			try {
				expect(handle.session.sessionFile).toBe(paths.session)
				expect((await stat(paths.session)).mode & 0o777).toBe(0o600)
				expect(`${handle.session.model?.provider}/${handle.session.model?.id}`).toBe("anthropic/claude-sonnet-4-5")
				expect(handle.session.thinkingLevel).toBe("off")
				expect(handle.session.scopedModels.map(choice => choice.model.id)).toEqual(["claude-sonnet-4-5"])
				expect(handle.session.agent.state.tools.map(tool => tool.name)).toEqual(["read", "child_hook"])
				expect(handle.session.systemPrompt).toContain("INCLUDED PROJECT POLICY")
				expect(handle.extensionsResult.extensions[0]?.path).toBe("<inline:lovely-agent-prompt>")
				expect(handle.extensionsResult.extensions.some(extension => extension.path.endsWith("child-hook.ts"))).toBe(true)
				expect(testGlobals.__lovelyChildHookStarted).toBe(true)
				expect(getAgentCoordinator().getSessionContext(handle.session.sessionId)).toEqual({ depth: 1, allowAgents: false })
			} finally {
				handle.dispose()
				delete testGlobals.__lovelyChildHookStarted
			}
			expect(getAgentCoordinator().getSessionContext(handle.session.sessionId)).toBeUndefined()
			expect(await Bun.file(paths.session).text()).toContain(childSessionId)
			const reopened = await createChildSession({
				cwd: workspace.cwd,
				paths,
				definition: { ...inheritedDefinition, tools: ["read", "child_hook"] },
				selection: { model: selectedModel, thinking: "off" },
				scopedModels: [{ model: selectedModel }],
				parentDepth: 0,
				maximumDepth: 2,
				allowAgents: false,
				projectTrusted: true,
				expectedSessionId: childSessionId,
				agentDir: workspace.agentDir
			})
			expect(reopened.session.sessionId).toBe(childSessionId)
			reopened.dispose()
			delete testGlobals.__lovelyChildHookStarted

			const excludedPaths = await reserveTaskStorage(await ensureParentStorage(workspace.cwd, "parent-session"), () => "a_87654321")
			await initializeRetainedLogs(excludedPaths)
			const excluded = await createChildSession({
				cwd: workspace.cwd,
				paths: excludedPaths,
				definition: { ...inheritedDefinition, excludeAgentsMd: true },
				selection: { model: selectedModel, thinking: "off" },
				scopedModels: [{ model: selectedModel }],
				parentDepth: 0,
				maximumDepth: 2,
				allowAgents: false,
				projectTrusted: true,
				agentDir: workspace.agentDir
			})
			try {
				expect(excluded.session.systemPrompt).not.toContain("INCLUDED PROJECT POLICY")
				expect(excluded.session.agent.state.tools.map(tool => tool.name)).toContain("child_hook")
			} finally {
				excluded.dispose()
			}
		})
	})
})

function model(provider: string, id: string): ScopedModel["model"] {
	return { provider, id, name: id } as ScopedModel["model"]
}

function skill(name: string, description: string, filePath: string): Skill {
	return {
		name,
		description,
		filePath,
		baseDir: filePath.slice(0, filePath.lastIndexOf("/")),
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
		disableModelInvocation: false
	}
}
