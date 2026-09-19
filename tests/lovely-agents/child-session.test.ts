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
import type { ModelAliasChoice } from "../../extensions/lovely-agents/config.js"
import { getAgentCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import type { AgentDefinition } from "../../extensions/lovely-agents/definitions.js"
import {
	ensureParentStorage,
	initializeRetainedLogs,
	mutateTaskMetadata,
	readRetainedOutput,
	readTaskMetadata,
	releaseParentLeaseFor,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import { buildTaskOutputToolResult, loadTaskList } from "../../extensions/lovely-agents/tools.js"
import { bindTaskUpdateRoute } from "../../extensions/lovely-agents/updates.js"
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
	test("alias presets honor explicit overrides without affecting explicit IDs or parent inheritance", () => {
		const aliases: ModelAliasChoice[] = [{ name: "fast", model: callModel, thinkingLevel: "low" }]
		const options = {
			definition,
			aliases,
			configuredModels: [{ model: callModel }],
			availableModels: [definitionModel, callModel],
			parentModel,
			parentThinking: "medium" as const
		}
		expect(resolveChildSessionSelection({ ...options, callModel: "fast" })).toEqual({ model: callModel, thinking: "low" })
		expect(resolveChildSessionSelection({ ...options, callModel: "fast", callThinking: "max" })).toEqual({
			model: callModel,
			thinking: "max"
		})
		expect(resolveChildSessionSelection({ ...options, callModel: "provider/call" })).toEqual({ model: callModel, thinking: "high" })
		expect(resolveChildSessionSelection({ ...options, definition: { ...inheritedDefinition, model: "fast" } })).toEqual({
			model: callModel,
			thinking: "low"
		})
		expect(resolveChildSessionSelection({ ...options, definition: { ...definition, model: "fast" } })).toEqual({
			model: callModel,
			thinking: "high"
		})
		expect(resolveChildSessionSelection({ ...options, definition: inheritedDefinition })).toEqual({
			model: parentModel,
			thinking: "medium"
		})
		expect(() => resolveChildSessionSelection({ ...options, callModel: "smart" })).toThrow('Model alias "smart" is not configured')
		expect(() => resolveChildSessionSelection({ ...options, definition: { ...definition, model: "smart" } })).toThrow(
			'Model alias "smart" is not configured'
		)
	})

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
			excludeTools: ["agent", "agent_roster"],
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
			excludeTools: ["agent", "agent_roster"],
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
		expect(prompt).toContain("Use bash to load a skill")
		expect(prompt).toContain("Current working directory: C:/workspace")
		expect(childPromptOptions(false)).toEqual({ expandPromptTemplates: false })
		expect(childPromptOptions(true)).toEqual({ expandPromptTemplates: true })
	})
})

describe("persistent child session construction", () => {
	test("uses the retained session path, explicit tools, context policy, and managed depth", async () => {
		await withTempWorkspace(async workspace => {
			const testGlobals = globalThis as typeof globalThis & { __lovelyChildHookStarted?: boolean; __lovelyChildReadUi?: () => unknown }
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
\tpi.on("session_start", (_event, ctx) => {
\t\tglobalThis.__lovelyChildHookStarted = true
\t\tglobalThis.__lovelyChildReadUi = () => ctx.ui
\t})
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
			const context = getAgentCoordinator().getSessionContext(childSessionId)
			const readUi = testGlobals.__lovelyChildReadUi
			let disposalEvents = 0
			try {
				expect(handle.session.sessionFile).toBe(paths.session)
				expect((await stat(paths.session)).mode & 0o777).toBe(0o600)
				expect(`${handle.session.model?.provider}/${handle.session.model?.id}`).toBe("anthropic/claude-sonnet-4-5")
				expect(handle.session.thinkingLevel).toBe("off")
				expect(handle.session.scopedModels.map(choice => choice.model.id)).toEqual(["claude-sonnet-4-5"])
				expect(handle.session.agent.state.tools.map(tool => tool.name)).toEqual(["read", "child_hook"])
				expect(handle.session.getAllTools().some(tool => tool.name === "task_update")).toBe(false)
				expect(handle.session.systemPrompt).toContain("INCLUDED PROJECT POLICY")
				expect(handle.extensionsResult.extensions[0]?.path).toBe("<inline:lovely-agent-prompt>")
				expect(handle.extensionsResult.extensions.some(extension => extension.path.endsWith("child-hook.ts"))).toBe(true)
				expect(testGlobals.__lovelyChildHookStarted).toBe(true)
				expect(context).toMatchObject({ depth: 1, allowAgents: false })
				expect(context?.disposeSignal?.aborted).toBe(false)
				context?.disposeSignal?.addEventListener("abort", () => {
					disposalEvents++
					expect(readUi?.()).toBeDefined()
				})
			} finally {
				handle.dispose()
				delete testGlobals.__lovelyChildHookStarted
				delete testGlobals.__lovelyChildReadUi
			}
			handle.dispose()
			expect(disposalEvents).toBe(1)
			expect(context?.disposeSignal?.aborted).toBe(true)
			expect(() => readUi?.()).toThrow("stale")
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
			delete testGlobals.__lovelyChildReadUi

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
				expect(excluded.session.agent.state.tools.map(tool => tool.name)).toContain("task_update")
			} finally {
				excluded.dispose()
				delete testGlobals.__lovelyChildHookStarted
				delete testGlobals.__lovelyChildReadUi
			}
		})
	})

	test("task_update persists only its own live run, rejects stale calls, and never notifies the parent", async () => {
		await withTempWorkspace(async workspace => {
			const paths = await reserveTaskStorage(await ensureParentStorage(workspace.cwd, "parent-session"), () => "a_12345678")
			await initializeRetainedLogs(paths)
			const runtime = await ModelRuntime.create({
				authPath: join(workspace.agentDir, "auth.json"),
				modelsPath: join(workspace.agentDir, "models.json")
			})
			const selectedModel = runtime.getModel("anthropic", "claude-sonnet-4-5")
			if (!selectedModel) throw new Error("Expected test model")
			const handle = await createChildSession({
				cwd: workspace.cwd,
				paths,
				definition: { ...inheritedDefinition, tools: ["task_update"] },
				selection: { model: selectedModel, thinking: "off" },
				scopedModels: [{ model: selectedModel }],
				parentDepth: 0,
				maximumDepth: 1,
				allowAgents: false,
				projectTrusted: true,
				agentDir: workspace.agentDir
			})
			const runId = "r_0123456789abcdef"
			await writeTaskMetadata(paths, {
				version: TASK_METADATA_VERSION,
				kind: "agent",
				taskRef: paths.taskRef,
				parentSessionId: paths.parentSessionId,
				childSessionId: handle.session.sessionId,
				definitionName: definition.name,
				label: "Original label",
				model: { provider: selectedModel.provider, id: selectedModel.id },
				thinking: "off",
				depth: 1,
				allowAgents: false,
				sessionConfig: { systemPrompt: definition.systemPrompt, tools: ["task_update"], excludeAgentsMd: false, scopedModels: [] },
				state: "running",
				latestOutcome: null,
				latestReply: null,
				lastRunSequence: 1,
				activeRun: { id: runId, sequence: 1, kind: "initial", state: "running", input: "Work", acceptedAt: 1, startedAt: 1 },
				queuedFollowUps: [],
				notifications: [],
				discardedAt: null,
				createdAt: 1,
				updatedAt: 1
			})
			const update = handle.session.agent.state.tools.find(tool => tool.name === "task_update")
			if (!update) throw new Error("Missing child progress tool")
			let refreshed = 0
			const unbind = bindTaskUpdateRoute(workspace.cwd, paths.parentSessionId, () => {
				refreshed++
			})
			const release = Promise.withResolvers<void>()
			let late: Promise<unknown> | undefined
			try {
				await expect(update.execute("outside", { progress: "Not in a run" })).rejects.toThrow("managed task run")
				handle.session.prompt = async () => {
					for (const progress of [" ", "x".repeat(241), "bad\u001b[31m"]) {
						await expect(update.execute("invalid", { progress })).rejects.toThrow("progress")
					}
					const aborted = AbortSignal.abort(new Error("cancelled"))
					await expect(update.execute("cancelled", { progress: "Not saved" }, aborted)).rejects.toThrow("cancelled")
					await update.execute("progress", { progress: "Root cause found;\n testing 🙂" })
					late = release.promise.then(() => update.execute("late", { progress: "Stale update" }))
				}
				await handle.prompt(runId, "Work")
				const output = await readRetainedOutput(paths)
				expect(output.progress).toBe("Root cause found; testing 🙂")
				expect(buildTaskOutputToolResult(paths.taskRef, output).content[0]?.text).toContain('progress: "Root cause found; testing 🙂"')
				const list = await loadTaskList(workspace.cwd, paths.parentSessionId)
				expect(list.details.tasks[0]).toMatchObject({ label: "Original label", state: "running", progress: output.progress })
				expect(list.content[0]?.text).toContain("Root cause found; testing 🙂")
				expect(refreshed).toBeGreaterThan(0)

				const secondRun = "r_1111111111111111"
				await mutateTaskMetadata(paths, metadata => ({
					...metadata,
					lastRunSequence: 2,
					queuedFollowUps: [{ id: secondRun, sequence: 2, content: "Again", acceptedAt: 2 }]
				}))
				expect(await readRetainedOutput(paths, { run: 2 })).not.toHaveProperty("progress")
				await mutateTaskMetadata(paths, metadata => ({
					...metadata,
					latestOutcome: "succeeded",
					lastRunSequence: 2,
					queuedFollowUps: [],
					activeRun: { id: secondRun, sequence: 2, kind: "followup", state: "running", input: "Again", acceptedAt: 2, startedAt: 2 }
				}))
				expect(await readRetainedOutput(paths)).not.toHaveProperty("progress")
				handle.session.prompt = async () => {
					await update.execute("second", { progress: "Second run" })
				}
				await handle.prompt(secondRun, "Again")
				release.resolve()
				await expect(late).rejects.toThrow("own active run")
				expect((await readRetainedOutput(paths)).progress).toBe("Second run")
				expect((await readRetainedOutput(paths, { run: 1 })).progress).toBe(output.progress)

				await mutateTaskMetadata(paths, metadata => ({
					...metadata,
					state: "idle",
					activeRun: null,
					latestOutcome: "stopped"
				}))
				await expect(handle.prompt(secondRun, "Late")).rejects.toThrow("own active run")
				const saved = await readTaskMetadata(paths)
				expect(saved.status === "ok" && saved.metadata.notifications).toEqual([])
				expect((await readRetainedOutput(paths)).progress).toBe("Second run")
				handle.dispose()
				await expect(handle.prompt(secondRun, "Disposed")).rejects.toThrow()
			} finally {
				release.resolve()
				await late?.catch(() => {})
				unbind()
				handle.dispose()
				await releaseParentLeaseFor(workspace.cwd, paths.parentSessionId)
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
