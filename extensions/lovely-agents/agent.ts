import { randomBytes } from "node:crypto"
import { rm } from "node:fs/promises"
import type { AgentSessionEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import {
	type ChildSessionHandle,
	childPromptOptions,
	createChildSession,
	resolveChildSessionSelection,
	resolveChildToolPolicy
} from "./child-session.js"
import type { AgentsConfig } from "./config.js"
import { resolveConfiguredModels } from "./config.js"
import { getAgentCoordinator, type ModelTuple, type ResidentAgent } from "./coordinator.js"
import { discoverAgentDefinitions } from "./definitions.js"
import {
	acquireParentLease,
	appendActivityLog,
	appendOutputLog,
	ensureParentStorage,
	initializeRetainedLogs,
	MAX_AGENT_INPUT_BYTES,
	MAX_AGENT_LABEL_BYTES,
	mutateTaskMetadata,
	readRetainedOutput,
	readTaskMetadata,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	type TaskMetadata,
	type TaskStoragePaths,
	writeTaskMetadata
} from "./state.js"
import { loadTaskList } from "./tools.js"

const ThinkingLevel = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max")
])

export type AgentCreationResult = {
	id: string
	label: string
	definition: string
	state: TaskMetadata["state"]
	latestOutcome: TaskMetadata["latestOutcome"]
	model: string
	thinking: TaskMetadata["thinking"]
	depth: number
	allowAgents: boolean
	detached: boolean
	output: Awaited<ReturnType<typeof readRetainedOutput>>
	tasks: Awaited<ReturnType<typeof loadTaskList>>["details"]
}

export function registerAgentTool(
	pi: ExtensionAPI,
	options: { getConfig: () => AgentsConfig; createChild?: typeof createChildSession; getAgentDir?: () => string }
): void {
	pi.registerTool({
		name: "agent",
		label: "Agent",
		description: "Create a durable Lovely Agent session and start its initial run.",
		promptSnippet: "Create or delegate work to a durable agent",
		promptGuidelines: ["Call agent_roster before creating an agent and use task tools for existing work."],
		parameters: Type.Object(
			{
				definition: Type.String({ minLength: 1, description: "Agent Definition name" }),
				label: Type.String({ minLength: 1, description: "Short task label" }),
				prompt: Type.String({ minLength: 1, description: "Initial task prompt" }),
				waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600_000 })),
				model: Type.Optional(Type.String({ minLength: 1, description: "Configured provider/model choice" })),
				thinking: Type.Optional(ThinkingLevel),
				allowAgents: Type.Optional(Type.Boolean({ description: "Allow this child to create descendants" }))
			},
			{ additionalProperties: false }
		),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw abortError(signal)
			const config = options.getConfig()
			validateInput(params.label, "label", MAX_AGENT_LABEL_BYTES)
			validateInput(params.prompt, "prompt", MAX_AGENT_INPUT_BYTES)
			const parentSessionId = ctx.sessionManager.getSessionId()
			const coordinator = getAgentCoordinator(config.maxConcurrency)
			const parentDepth = coordinator.getSessionContext(parentSessionId)?.depth ?? 0
			resolveChildToolPolicy({
				parentDepth,
				maximumDepth: config.maxDepth,
				allowAgents: params.allowAgents ?? false
			})
			const discovered = discoverAgentDefinitions({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				toolNames: pi.getAllTools().map(tool => tool.name),
				models: ctx.modelRegistry.getAll(),
				...(options.getAgentDir ? { agentDir: options.getAgentDir() } : {})
			})
			const definition = discovered.definitions.find(candidate => candidate.name === params.definition)
			if (!definition) throw new Error(`Unknown or invalid Agent Definition: ${params.definition}`)
			const configuredModels = await resolveConfiguredModels(config, ctx)
			const selection = resolveChildSessionSelection({
				...(params.model ? { callModel: params.model } : {}),
				...(params.thinking ? { callThinking: params.thinking } : {}),
				definition,
				configuredModels: configuredModels.models,
				availableModels: ctx.modelRegistry.getAvailable(),
				parentModel: ctx.model,
				parentThinking: ctx.thinkingLevel ?? "medium"
			})
			await acquireParentLease(ctx.cwd, parentSessionId)
			const paths = await reserveTaskStorage(await ensureParentStorage(ctx.cwd, parentSessionId))
			let child: ChildSessionHandle | undefined
			let accepted = false
			try {
				await initializeRetainedLogs(paths)
				child = await (options.createChild ?? createChildSession)({
					cwd: ctx.cwd,
					paths,
					definition,
					selection,
					scopedModels: configuredModels.models,
					parentDepth,
					maximumDepth: config.maxDepth,
					allowAgents: params.allowAgents ?? false,
					projectTrusted: ctx.isProjectTrusted()
				})
				const acceptedAt = Date.now()
				const runId = createRunId()
				const metadata: TaskMetadata = {
					version: TASK_METADATA_VERSION,
					kind: "agent",
					taskRef: paths.taskRef,
					parentSessionId,
					childSessionId: child.session.sessionId,
					definitionName: definition.name,
					label: params.label.trim(),
					model: { provider: child.session.model?.provider ?? selection.model.provider, id: child.session.model?.id ?? selection.model.id },
					thinking: child.session.thinkingLevel,
					depth: child.depth,
					allowAgents: child.allowAgents,
					state: "queued",
					latestOutcome: null,
					lastRunSequence: 1,
					activeRun: {
						id: runId,
						sequence: 1,
						kind: "initial",
						state: "queued",
						input: params.prompt,
						acceptedAt
					},
					queuedFollowUps: [],
					notifications: [],
					discardedAt: null,
					createdAt: acceptedAt,
					updatedAt: acceptedAt
				}
				await appendOutputLog(paths, { type: "run-start", sequence: 1, kind: "initial", timestamp: acceptedAt })
				await appendOutputLog(paths, { type: "input", delivery: "initial", timestamp: acceptedAt, content: params.prompt })
				await writeTaskMetadata(paths, metadata)
				accepted = true

				const runtime = new InitialAgentRun(paths, child, metadata, config.expandPromptTemplates)
				child = undefined
				runtime.start()
				const waitMs = params.waitMs ?? config.waitMs
				const wait = () => runtime.wait(waitMs, signal)
				const detached = waitMs === 0 ? await wait() : await coordinator.withLentPermit(wait, signal)
				const loaded = await readTaskMetadata(paths)
				if (loaded.status !== "ok") throw new Error(`Could not read accepted task ${paths.taskRef}`)
				const output = await readRetainedOutput(paths)
				const tasks = (await loadTaskList(ctx.cwd, parentSessionId)).details
				return buildAgentCreationToolResult(loaded.metadata, detached, output, tasks)
			} finally {
				child?.dispose()
				if (!accepted) await rm(paths.taskDirectory, { recursive: true, force: true })
			}
		}
	})
}

class InitialAgentRun implements ResidentAgent {
	readonly #paths: TaskStoragePaths
	readonly #child: ChildSessionHandle
	readonly #metadata: TaskMetadata
	readonly #expandPromptTemplates: boolean
	readonly #scheduleAbort = new AbortController()
	readonly #completion = deferred<void>()
	readonly #toolArguments = new Map<string, { name: string; arguments: string }>()
	#unbindResident: (() => void) | undefined
	#unsubscribe: (() => void) | undefined
	#eventWrites: Promise<void> = Promise.resolve()
	#eventWriteFailed = false
	#started = false
	#stopRequested = false

	constructor(paths: TaskStoragePaths, child: ChildSessionHandle, metadata: TaskMetadata, expandPromptTemplates: boolean) {
		this.#paths = paths
		this.#child = child
		this.#metadata = metadata
		this.#expandPromptTemplates = expandPromptTemplates
		this.#unbindResident = getAgentCoordinator().bindResident(paths.taskDirectory, this)
		this.#unsubscribe = child.session.subscribe(event => this.recordEvent(event))
	}

	start(): void {
		if (this.#started) return
		this.#started = true
		void this.run().catch(() => {})
	}

	async wait(waitMs: number, signal?: AbortSignal): Promise<boolean> {
		if (waitMs === 0) {
			await this.detach()
			return true
		}
		if (signal?.aborted) await this.stop()
		let timer: ReturnType<typeof setTimeout> | undefined
		let onAbort: (() => void) | undefined
		const timeout = new Promise<"timeout">(resolve => {
			timer = setTimeout(() => resolve("timeout"), waitMs)
			timer.unref()
		})
		const aborted = signal
			? new Promise<"aborted">(resolve => {
					onAbort = () => resolve("aborted")
					signal.addEventListener("abort", onAbort, { once: true })
				})
			: undefined
		const result = await Promise.race([this.#completion.promise.then(() => "completed" as const), timeout, ...(aborted ? [aborted] : [])])
		if (timer) clearTimeout(timer)
		if (signal && onAbort) signal.removeEventListener("abort", onAbort)
		if (result === "aborted") {
			await this.stop()
			await this.#completion.promise
			return false
		}
		if (result === "timeout") {
			await this.detach()
			return true
		}
		return false
	}

	async stop(): Promise<void> {
		if (this.#stopRequested) return this.#completion.promise
		this.#stopRequested = true
		this.#scheduleAbort.abort(new Error("Agent run stopped"))
		await this.#child.session.abort()
		await this.settle("stopped")
		await this.#completion.promise
	}

	dispose(): void {
		this.#unsubscribe?.()
		this.#unsubscribe = undefined
		this.#unbindResident?.()
		this.#unbindResident = undefined
		this.#child.dispose()
	}

	private async run(): Promise<void> {
		const tuple: ModelTuple = { provider: this.#metadata.model.provider, model: this.#metadata.model.id }
		try {
			await getAgentCoordinator().run({ tuple, signal: this.#scheduleAbort.signal }, async () => {
				if (this.#stopRequested) return
				const startedAt = Date.now()
				await mutateTaskMetadata(this.#paths, metadata => {
					const activeRun = metadata.activeRun
					if (!activeRun || activeRun.id !== this.#metadata.activeRun?.id) return metadata
					return {
						...metadata,
						state: "running",
						activeRun: { ...activeRun, state: "running", startedAt },
						updatedAt: startedAt
					}
				})
				await this.#child.session.prompt(this.#metadata.activeRun?.input ?? "", childPromptOptions(this.#expandPromptTemplates))
			})
			await this.#eventWrites
			if (this.#eventWriteFailed) throw new Error("Could not retain one or more child session events")
			await this.settle(this.#stopRequested ? "stopped" : latestOutcome(this.#child))
		} catch {
			await this.#eventWrites
			await this.settle(this.#stopRequested ? "stopped" : "failed")
		} finally {
			this.dispose()
			this.#completion.resolve(undefined)
		}
	}

	private async detach(): Promise<void> {
		const detachedAt = Date.now()
		await mutateTaskMetadata(this.#paths, metadata => {
			const activeRun = metadata.activeRun
			if (!activeRun || activeRun.id !== this.#metadata.activeRun?.id || activeRun.detachedAt !== undefined) return metadata
			return { ...metadata, activeRun: { ...activeRun, detachedAt }, updatedAt: detachedAt }
		})
	}

	private async settle(outcome: NonNullable<TaskMetadata["latestOutcome"]>): Promise<void> {
		let won = false
		const timestamp = Date.now()
		await mutateTaskMetadata(this.#paths, metadata => {
			if (metadata.activeRun?.id !== this.#metadata.activeRun?.id) return metadata
			won = true
			return { ...metadata, state: "idle", latestOutcome: outcome, activeRun: null, updatedAt: timestamp }
		})
		if (won) await appendOutputLog(this.#paths, { type: "run-end", sequence: 1, outcome, timestamp })
	}

	private recordEvent(event: AgentSessionEvent): void {
		if (event.type === "tool_execution_start") {
			this.#toolArguments.set(event.toolCallId, { name: event.toolName, arguments: renderUnknown(event.args) })
			return
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const content = event.message.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("")
			if (content) this.queueEventWrite(() => appendOutputLog(this.#paths, { type: "assistant", content }))
			return
		}
		if (event.type === "tool_execution_end") {
			const started = this.#toolArguments.get(event.toolCallId)
			this.#toolArguments.delete(event.toolCallId)
			this.queueEventWrite(() =>
				appendActivityLog(this.#paths, {
					tool: started?.name ?? event.toolName,
					timestamp: Date.now(),
					arguments: started?.arguments ?? "(unavailable)",
					result: renderUnknown(event.result),
					isError: event.isError
				})
			)
		}
	}

	private queueEventWrite(write: () => Promise<void>): void {
		this.#eventWrites = this.#eventWrites.then(write).catch(() => {
			this.#eventWriteFailed = true
		})
	}
}

function buildAgentCreationToolResult(
	metadata: TaskMetadata,
	detached: boolean,
	output: Awaited<ReturnType<typeof readRetainedOutput>>,
	tasks: Awaited<ReturnType<typeof loadTaskList>>["details"]
): { content: [{ type: "text"; text: string }]; details: AgentCreationResult } {
	const result: AgentCreationResult = {
		id: metadata.taskRef,
		label: metadata.label,
		definition: metadata.definitionName,
		state: metadata.state,
		latestOutcome: metadata.latestOutcome,
		model: `${metadata.model.provider}/${metadata.model.id}`,
		thinking: metadata.thinking,
		depth: metadata.depth,
		allowAgents: metadata.allowAgents,
		detached,
		output,
		tasks
	}
	const inventory = result.tasks.tasks.slice(0, 10)
	const inventoryLines =
		inventory.length === 0
			? ["tasks: []"]
			: [
					"tasks:",
					...inventory.flatMap(task => [
						`  - id: ${task.id}`,
						`    label: ${JSON.stringify(task.label)}`,
						`    state: ${task.state}`,
						`    outcome: ${task.latestOutcome ?? "none"}`
					]),
					...(result.tasks.total > inventory.length ? [`  # ${result.tasks.total - inventory.length} more; use task_list`] : [])
				]
	return {
		content: [
			{
				type: "text",
				text: [
					`task: ${result.id}`,
					`label: ${JSON.stringify(result.label)}`,
					`definition: ${result.definition}`,
					`state: ${result.state}`,
					`outcome: ${result.latestOutcome ?? "none"}`,
					`model: ${result.model}`,
					`thinking: ${result.thinking}`,
					`depth: ${result.depth}`,
					`detached: ${result.detached}`,
					"output:",
					result.output.text || "(no output)",
					"",
					...inventoryLines
				].join("\n")
			}
		],
		details: result
	}
}

function latestOutcome(child: ChildSessionHandle): NonNullable<TaskMetadata["latestOutcome"]> {
	for (let index = child.session.messages.length - 1; index >= 0; index--) {
		const message = child.session.messages[index]
		if (message?.role !== "assistant") continue
		return message.stopReason === "error" || message.stopReason === "aborted" ? "failed" : "succeeded"
	}
	return "failed"
}

function validateInput(value: string, name: string, maximumBytes: number): void {
	if (!value.trim()) throw new Error(`${name} must be nonblank`)
	if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error(`${name} must be at most ${maximumBytes} UTF-8 bytes`)
}

function createRunId(): string {
	return `r_${randomBytes(8).toString("hex")}`
}

function renderUnknown(value: unknown): string {
	if (typeof value === "string") return value
	try {
		return JSON.stringify(value) ?? String(value)
	} catch {
		return String(value)
	}
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Agent creation aborted")
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>(resolvePromise => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}
