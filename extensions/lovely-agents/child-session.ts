import { AsyncLocalStorage } from "node:async_hooks"
import { lstat, open } from "node:fs/promises"
import {
	type AgentSession,
	type BuildSystemPromptOptions,
	createAgentSession,
	DefaultResourceLoader,
	formatSkillsForPrompt,
	getAgentDir,
	type LoadExtensionsResult,
	type PromptOptions,
	type ScopedModel,
	SessionManager,
	SettingsManager
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { MODEL_ALIASES, type ModelAliasChoice } from "./config.js"
import { getAgentCoordinator } from "./coordinator.js"
import type { AgentDefinition, AgentThinkingLevel } from "./definitions.js"
import { mutateTaskMetadata, TaskProgressSchema, type TaskStoragePaths } from "./state.js"
import { hasCode } from "./utils.js"

const PROMPT_EXTENSION_PATH = "<inline:lovely-agent-prompt>"
const CREATION_TOOL_NAMES = new Set(["agent", "agent_roster"])

export type ChildSessionSelection = {
	model: ScopedModel["model"]
	thinking: AgentThinkingLevel
}

export type ChildToolPolicy = {
	tools?: string[]
	excludeTools: string[]
	depth: number
	allowAgents: boolean
}

export type CreateChildSessionOptions = {
	cwd: string
	paths: TaskStoragePaths
	definition: AgentDefinition
	selection: ChildSessionSelection
	scopedModels: readonly ScopedModel[]
	parentDepth: number
	maximumDepth: number
	allowAgents: boolean
	projectTrusted: boolean
	expectedSessionId?: string
	agentDir?: string
}

export type ChildSessionHandle = {
	session: AgentSession
	extensionsResult: LoadExtensionsResult
	depth: number
	allowAgents: boolean
	/** Binds tool execution to this immutable run, including delayed async callbacks. */
	prompt(runId: string, text: string, options?: PromptOptions): Promise<void>
	dispose(): void
}

export function childPromptOptions(expandPromptTemplates: boolean): PromptOptions {
	return { expandPromptTemplates }
}

export function resolveChildSessionSelection(options: {
	callModel?: string
	callThinking?: AgentThinkingLevel
	definition: AgentDefinition
	configuredModels: readonly ScopedModel[]
	aliases?: readonly ModelAliasChoice[]
	availableModels: readonly ScopedModel["model"][]
	parentModel: ScopedModel["model"] | undefined
	parentThinking: AgentThinkingLevel
}): ChildSessionSelection {
	let model: ScopedModel["model"] | undefined
	const reference = options.callModel ?? options.definition.model
	const alias = options.aliases?.find(alias => alias.name === reference)
	if (reference && Object.hasOwn(MODEL_ALIASES, reference) && !alias) {
		throw new Error(`Model alias "${reference}" is not configured or its model is unavailable`)
	}
	if (alias) {
		model = alias.model
	} else if (options.callModel) {
		model = options.configuredModels.find(choice => modelId(choice.model) === options.callModel)?.model
		if (!model) throw new Error(`Model "${options.callModel}" is not an available configured choice`)
	} else if (options.definition.model) {
		model = options.availableModels.find(candidate => modelId(candidate) === options.definition.model)
		if (!model) throw new Error(`Agent Definition model "${options.definition.model}" is not authenticated`)
	} else {
		model = options.parentModel
		if (!model) throw new Error("No parent model is available")
	}
	return {
		model,
		thinking:
			options.callThinking ??
			(options.callModel ? alias?.thinkingLevel : undefined) ??
			options.definition.thinking ??
			alias?.thinkingLevel ??
			options.parentThinking
	}
}

export function resolveChildToolPolicy(options: {
	definitionTools?: readonly string[]
	parentDepth: number
	maximumDepth: number
	allowAgents: boolean
}): ChildToolPolicy {
	if (!Number.isSafeInteger(options.parentDepth) || options.parentDepth < 0)
		throw new Error("Parent depth must be a nonnegative safe integer")
	if (!Number.isSafeInteger(options.maximumDepth) || options.maximumDepth < 0) {
		throw new Error("Maximum depth must be a nonnegative safe integer")
	}
	const depth = options.parentDepth + 1
	if (depth > options.maximumDepth) throw new Error(`Agent depth ${depth} exceeds configured maximum ${options.maximumDepth}`)
	const allowAgents = options.allowAgents && depth < options.maximumDepth
	const excludeTools = allowAgents ? [] : [...CREATION_TOOL_NAMES]
	const tools = options.definitionTools?.filter(name => allowAgents || !CREATION_TOOL_NAMES.has(name))
	return { ...(tools ? { tools } : {}), excludeTools, depth, allowAgents }
}

export async function createChildSession(options: CreateChildSessionOptions): Promise<ChildSessionHandle> {
	const policy = resolveChildToolPolicy({
		...(options.definition.tools ? { definitionTools: options.definition.tools } : {}),
		parentDepth: options.parentDepth,
		maximumDepth: options.maximumDepth,
		allowAgents: options.allowAgents
	})
	const agentDir = options.agentDir ?? getAgentDir()
	const settingsManager = SettingsManager.create(options.cwd, agentDir)
	settingsManager.setProjectTrusted(options.projectTrusted)
	const runContext = new AsyncLocalStorage<string>()
	const lifetime = new AbortController()
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir,
		settingsManager,
		systemPromptOverride: () => options.definition.systemPrompt,
		...(options.definition.excludeAgentsMd ? { agentsFilesOverride: () => ({ agentsFiles: [] }) } : {}),
		extensionFactories: [
			{
				name: "lovely-agent-prompt",
				hidden: true,
				factory(pi) {
					pi.registerTool({
						name: "task_update",
						label: "Task Update",
						description:
							"Report a short progress line for your own current task run (up to 240 characters). Does not change its label or lifecycle state, or notify the parent.",
						promptSnippet: "Update your task's progress in the panel and task inspection",
						promptGuidelines: [
							"Use task_update for meaningful phase changes or blockers: what is achieved and what remains. Do not report every tool call or invent percentages. Updates do not interrupt or wake the parent."
						],
						parameters: Type.Object({ progress: TaskProgressSchema }, { additionalProperties: false }),
						async execute(_toolCallId, params, signal, _onUpdate, ctx) {
							const runId = runContext.getStore()
							if (!runId) throw new Error("task_update requires a managed task run")
							if (!Value.Check(TaskProgressSchema, params.progress)) throw new Error("progress must be 1–240 characters")
							const progress = params.progress.replace(/\s+/g, " ").trim()
							if (!progress || /\p{Cc}/u.test(progress)) throw new Error("progress must be nonempty text without control characters")
							const childSessionId = ctx.sessionManager.getSessionId()
							await mutateTaskMetadata(options.paths, metadata => {
								signal?.throwIfAborted()
								lifetime.signal.throwIfAborted()
								if (
									metadata.kind !== "agent" ||
									metadata.childSessionId !== childSessionId ||
									metadata.activeRun?.id !== runId ||
									metadata.state !== "running" ||
									metadata.discardedAt !== null
								) {
									throw new Error("task_update can only update its own active run")
								}
								return { ...metadata, progress, updatedAt: Date.now() }
							})
							return { content: [{ type: "text", text: "Progress updated." }], details: { progress } }
						}
					})
					pi.on("before_agent_start", event => ({
						systemPrompt: buildDefinitionSystemPrompt(event.systemPromptOptions)
					}))
				}
			}
		],
		extensionsOverride: base => {
			const composer = base.extensions.find(extension => extension.path === PROMPT_EXTENSION_PATH)
			if (!composer) return base
			return { ...base, extensions: [composer, ...base.extensions.filter(extension => extension !== composer)] }
		}
	})
	await resourceLoader.reload()
	if (!resourceLoader.getExtensions().extensions.some(extension => extension.path === PROMPT_EXTENSION_PATH)) {
		throw new Error("Could not load the Lovely Agents prompt composer")
	}

	await reserveSessionFile(options.paths.session)
	const sessionManager = SessionManager.open(options.paths.session, options.paths.taskDirectory, options.cwd)
	const result = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		model: options.selection.model,
		thinkingLevel: options.selection.thinking,
		scopedModels: [...options.scopedModels],
		...(policy.tools ? { tools: policy.tools } : {}),
		excludeTools: policy.excludeTools,
		resourceLoader,
		sessionManager,
		settingsManager
	})
	if (options.expectedSessionId && result.session.sessionId !== options.expectedSessionId) {
		result.session.dispose()
		throw new Error(`Child session identity mismatch: expected ${options.expectedSessionId}, found ${result.session.sessionId}`)
	}

	const unbindContext = getAgentCoordinator().bindSessionContext(result.session.sessionId, {
		depth: policy.depth,
		allowAgents: policy.allowAgents,
		disposeSignal: lifetime.signal
	})
	try {
		await result.session.bindExtensions({ mode: "print" })
	} catch (error) {
		lifetime.abort()
		unbindContext()
		result.session.dispose()
		throw error
	}
	let disposed = false
	return {
		session: result.session,
		extensionsResult: result.extensionsResult,
		depth: policy.depth,
		allowAgents: policy.allowAgents,
		prompt: (runId, text, promptOptions) => runContext.run(runId, () => result.session.prompt(text, promptOptions)),
		dispose() {
			if (disposed) return
			disposed = true
			lifetime.abort()
			unbindContext()
			result.session.dispose()
		}
	}
}

export function buildDefinitionSystemPrompt(options: BuildSystemPromptOptions): string {
	const body = options.customPrompt?.trim()
	if (!body) throw new Error("Agent Definition body is empty")
	const tools = options.selectedTools ?? []
	const visibleTools = tools.filter(name => options.toolSnippets?.[name])
	const toolList = visibleTools.length > 0 ? visibleTools.map(name => `- ${name}: ${options.toolSnippets?.[name]}`).join("\n") : "(none)"
	const guidelines: string[] = []
	const seen = new Set<string>()
	const addGuideline = (value: string) => {
		const guideline = value.trim()
		if (!guideline || seen.has(guideline)) return
		seen.add(guideline)
		guidelines.push(guideline)
	}
	const hasBash = tools.includes("bash")
	const hasPowerShell = tools.includes("powershell")
	if ((hasBash || hasPowerShell) && !tools.some(name => name === "grep" || name === "find" || name === "ls")) {
		addGuideline(
			hasBash && hasPowerShell
				? "Use bash or PowerShell for file operations like listing, searching, and finding files"
				: hasPowerShell
					? "Use PowerShell for file operations like listing, searching, and finding files"
					: "Use bash for file operations like ls, rg, find"
		)
	}
	for (const name of tools) for (const guideline of options.toolGuidelines?.[name] ?? []) addGuideline(guideline)
	for (const guideline of options.promptGuidelines ?? []) addGuideline(guideline)
	addGuideline("Be concise in your responses")
	addGuideline("Show file paths clearly when working with files")

	let prompt = `${body}\n\nAvailable tools:\n${toolList}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n${guidelines.map(value => `- ${value}`).join("\n")}`
	if (options.appendSystemPrompt) prompt += `\n\n${options.appendSystemPrompt}`
	if (options.contextFiles && options.contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n"
		for (const file of options.contextFiles) {
			prompt += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`
		}
		prompt += "</project_context>\n"
	}
	const skillReadTool = (["read", "bash"] as const).find(name => tools.includes(name))
	if (skillReadTool && options.skills && options.skills.length > 0) {
		prompt += formatSkillsForPrompt(options.skills, skillReadTool)
	}
	prompt += `\nCurrent working directory: ${options.cwd.replace(/\\/g, "/")}\n`
	return prompt
}

function modelId(model: ScopedModel["model"]): string {
	return `${model.provider}/${model.id}`
}

async function reserveSessionFile(path: string): Promise<void> {
	try {
		const file = await open(path, "wx", 0o600)
		await file.close()
	} catch (error) {
		if (!hasCode(error, "EEXIST")) throw error
		const stats = await lstat(path)
		if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Child session path is not a regular file: ${path}`)
	}
}
