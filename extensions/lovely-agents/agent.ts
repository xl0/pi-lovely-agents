import { randomBytes } from "node:crypto"
import { rm } from "node:fs/promises"
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent"
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
import { type AgentReservation, getAgentCoordinator, type ModelTuple, type ResidentAgent, type ResidentInputResult } from "./coordinator.js"
import { type AgentDefinition, discoverAgentDefinitions } from "./definitions.js"
import {
	acquireParentLease,
	appendActivityLog,
	appendOutputLog,
	ensureParentStorage,
	initializeRetainedLogs,
	MAX_AGENT_INPUT_BYTES,
	MAX_AGENT_LABEL_BYTES,
	MAX_QUEUED_FOLLOWUPS,
	mutateTaskMetadata,
	readRetainedOutput,
	readTaskMetadata,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	TASK_REFERENCE_PATTERN,
	type TaskMetadata,
	type TaskStoragePaths,
	taskStoragePaths,
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
	queuedFollowUps: number
	output: Awaited<ReturnType<typeof readRetainedOutput>>
	tasks: Awaited<ReturnType<typeof loadTaskList>>["details"]
}

export type TaskInputResult = {
	id: string
	requestedDelivery: "followup" | "steer"
	effectiveDelivery: "followup" | "steer"
	queuePosition: number | null
	state: TaskMetadata["state"]
	latestOutcome: TaskMetadata["latestOutcome"]
	queuedFollowUps: number
}

export type AgentToolOptions = {
	getConfig: () => AgentsConfig
	createChild?: typeof createChildSession
	getAgentDir?: () => string
}

export function registerAgentTool(pi: ExtensionAPI, options: AgentToolOptions): void {
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
				const acceptanceOrder = coordinator.nextAcceptanceOrder()
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
					sessionConfig: {
						systemPrompt: definition.systemPrompt,
						tools: definition.tools ?? null,
						excludeAgentsMd: definition.excludeAgentsMd ?? false,
						scopedModels: configuredModels.models.map(choice => ({
							provider: choice.model.provider,
							id: choice.model.id,
							...(choice.thinkingLevel ? { thinkingLevel: choice.thinkingLevel } : {})
						}))
					},
					state: "queued",
					latestOutcome: null,
					lastRunSequence: 1,
					activeRun: {
						id: runId,
						sequence: 1,
						acceptanceOrder,
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

				const runtime = new AgentRuntime(paths, child, metadata, config.expandPromptTemplates)
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

export function registerTaskInputTool(pi: ExtensionAPI, options: AgentToolOptions): void {
	pi.registerTool({
		name: "task_input",
		label: "Task Input",
		description: "Send a durable Follow-up or live Steer to an owned Lovely Agent task.",
		promptSnippet: "Send Follow-up work or a live Steer to a durable task",
		promptGuidelines: ["Use Follow-up for later work; use Steer only to redirect a currently running agent."],
		parameters: Type.Object(
			{
				id: Type.String({ pattern: TASK_REFERENCE_PATTERN.source, description: "Task Reference" }),
				content: Type.String({ minLength: 1, description: "Input text" }),
				delivery: Type.Optional(Type.Union([Type.Literal("followup"), Type.Literal("steer")]))
			},
			{ additionalProperties: false }
		),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw abortError(signal)
			validateInput(params.content, "content", MAX_AGENT_INPUT_BYTES)
			const parentSessionId = ctx.sessionManager.getSessionId()
			const lease = await acquireParentLease(ctx.cwd, parentSessionId)
			const paths = taskStoragePaths(lease.paths, params.id)
			const loaded = await readTaskMetadata(paths)
			if (loaded.status === "missing") throw new Error(`Unknown Task Reference: ${params.id}`)
			if (loaded.status === "invalid") throw new Error(loaded.diagnostic.message)
			if (loaded.metadata.discardedAt !== null) throw new Error(`Task ${params.id} has been discarded`)
			const requestedDelivery = params.delivery ?? "followup"
			let accepted: ResidentInputResult | undefined
			while (!accepted) {
				if (signal?.aborted) throw abortError(signal)
				const runtime = await controllableRuntime(ctx, paths, options)
				try {
					accepted = await runtime.input(params.content, requestedDelivery)
				} catch (error) {
					if (!isRuntimeClosingError(error)) throw error
					await new Promise(resolve => setTimeout(resolve, 0))
				}
			}
			const current = await readTaskMetadata(paths)
			if (current.status !== "ok") throw new Error(`Could not read accepted task ${params.id}`)
			const result: TaskInputResult = {
				id: params.id,
				requestedDelivery,
				effectiveDelivery: accepted.delivery,
				queuePosition: accepted.queuePosition,
				state: current.metadata.state,
				latestOutcome: current.metadata.latestOutcome,
				queuedFollowUps: current.metadata.queuedFollowUps.length
			}
			return {
				content: [
					{
						type: "text",
						text:
							result.effectiveDelivery === "steer"
								? `${result.id}: steer delivered (${result.state}; ${result.queuedFollowUps} Follow-ups queued)`
								: `${result.id}: followup accepted (position ${result.queuePosition}; ${result.state}; ${result.queuedFollowUps} queued)`
					}
				],
				details: result
			}
		}
	})
}

class AgentRuntime implements ResidentAgent {
	readonly #paths: TaskStoragePaths
	readonly #child: ChildSessionHandle
	readonly #expandPromptTemplates: boolean
	readonly #tuple: ModelTuple
	readonly #scheduleAbort = new AbortController()
	readonly #initialRunId: string | undefined
	readonly #initialCompletion = deferred<void>()
	readonly #runtimeCompletion = deferred<void>()
	readonly #toolArguments = new Map<string, { name: string; arguments: string }>()
	readonly #pendingSteers: Array<{ content: string }> = []
	readonly #reservations = new Map<string, AgentReservation>()
	#unbindResident: (() => void) | undefined
	#unsubscribe: (() => void) | undefined
	#eventWrites: Promise<void> = Promise.resolve()
	#eventWriteFailed = false
	#started = false
	#stopRequested = false
	#accepting = true
	#disposed = false
	#awaitingPrimaryInput = false
	#lastAssistantOutcome: NonNullable<TaskMetadata["latestOutcome"]> | undefined

	constructor(paths: TaskStoragePaths, child: ChildSessionHandle, metadata: TaskMetadata, expandPromptTemplates: boolean) {
		this.#paths = paths
		this.#child = child
		this.#initialRunId = metadata.activeRun?.kind === "initial" ? metadata.activeRun.id : undefined
		this.#expandPromptTemplates = expandPromptTemplates
		this.#tuple = { provider: metadata.model.provider, model: metadata.model.id }
		if (metadata.activeRun) this.reserveRun(metadata.activeRun)
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
		const result = await Promise.race([
			this.#initialCompletion.promise.then(() => "completed" as const),
			timeout,
			...(aborted ? [aborted] : [])
		])
		if (timer) clearTimeout(timer)
		if (signal && onAbort) signal.removeEventListener("abort", onAbort)
		if (result === "aborted") {
			await this.stop()
			return false
		}
		if (result === "timeout") {
			await this.detach()
			return true
		}
		return false
	}

	async stop(): Promise<void> {
		if (this.#stopRequested) return this.#runtimeCompletion.promise
		this.#stopRequested = true
		this.#accepting = false
		this.#scheduleAbort.abort(new Error("Agent run stopped"))
		await this.#child.session.abort()
		const loaded = await readTaskMetadata(this.#paths)
		if (loaded.status === "ok" && loaded.metadata.activeRun) {
			await this.settle(loaded.metadata.activeRun, "stopped", true)
		} else if (loaded.status === "ok" && loaded.metadata.queuedFollowUps.length > 0) {
			await mutateTaskMetadata(this.#paths, metadata => ({
				...metadata,
				queuedFollowUps: [],
				updatedAt: Date.now()
			}))
		}
		if (!this.#started) {
			this.dispose()
			this.#runtimeCompletion.resolve(undefined)
			this.#initialCompletion.resolve(undefined)
		}
		await this.#runtimeCompletion.promise
	}

	dispose(): void {
		if (this.#disposed) return
		this.#disposed = true
		this.#unsubscribe?.()
		this.#unsubscribe = undefined
		this.#unbindResident?.()
		this.#unbindResident = undefined
		this.#child.dispose()
	}

	async input(content: string, delivery: "followup" | "steer"): Promise<ResidentInputResult> {
		if (!this.#accepting || this.#disposed) throw new RuntimeClosingError()
		let result: ResidentInputResult | undefined
		let acceptedRun: NonNullable<TaskMetadata["activeRun"]> | undefined
		try {
			await mutateTaskMetadata(this.#paths, async metadata => {
				if (!this.#accepting || this.#disposed) throw new RuntimeClosingError()
				if (metadata.discardedAt !== null) throw new Error(`Task ${metadata.taskRef} has been discarded`)
				if (delivery === "steer" && metadata.state === "running" && metadata.activeRun && this.#child.session.isStreaming) {
					const pending = { content }
					this.#pendingSteers.push(pending)
					try {
						await this.#child.session.prompt(content, {
							...childPromptOptions(this.#expandPromptTemplates),
							streamingBehavior: "steer"
						})
					} catch (error) {
						const index = this.#pendingSteers.indexOf(pending)
						if (index >= 0) this.#pendingSteers.splice(index, 1)
						throw error
					}
					result = { delivery: "steer", queuePosition: null, queuedFollowUps: metadata.queuedFollowUps.length }
					return metadata
				}
				if (metadata.queuedFollowUps.length >= MAX_QUEUED_FOLLOWUPS) {
					throw new Error(`Task ${metadata.taskRef} already has ${MAX_QUEUED_FOLLOWUPS} queued Follow-ups`)
				}
				const acceptedAt = Date.now()
				const sequence = metadata.lastRunSequence + 1
				const runId = createRunId()
				const acceptanceOrder = getAgentCoordinator().nextAcceptanceOrder()
				const queuePosition = metadata.activeRun ? metadata.queuedFollowUps.length + 1 : 1
				result = { delivery: "followup", queuePosition, queuedFollowUps: metadata.queuedFollowUps.length + 1 }
				acceptedRun = {
					id: runId,
					sequence,
					acceptanceOrder,
					kind: "followup",
					state: "queued",
					input: content,
					acceptedAt
				}
				if (!metadata.activeRun) {
					result.queuedFollowUps = 0
					return {
						...metadata,
						state: "queued",
						activeRun: acceptedRun,
						lastRunSequence: sequence,
						updatedAt: acceptedAt
					}
				}
				return {
					...metadata,
					lastRunSequence: sequence,
					queuedFollowUps: [...metadata.queuedFollowUps, { id: runId, sequence, acceptanceOrder, content, acceptedAt }],
					updatedAt: acceptedAt
				}
			})
		} catch (error) {
			if (!this.#started) {
				this.#accepting = false
				this.dispose()
				this.#runtimeCompletion.resolve(undefined)
				this.#initialCompletion.resolve(undefined)
			}
			throw error
		}
		if (!result) throw new Error("Task input was not accepted")
		if (acceptedRun) this.reserveRun(acceptedRun)
		this.start()
		return result
	}

	private async run(): Promise<void> {
		try {
			while (!this.#stopRequested) {
				const activeRun = await this.nextRun()
				if (!activeRun) break
				await this.executeRun(activeRun)
			}
		} finally {
			this.dispose()
			this.#initialCompletion.resolve(undefined)
			this.#runtimeCompletion.resolve(undefined)
		}
	}

	private async nextRun(): Promise<NonNullable<TaskMetadata["activeRun"]> | null> {
		const selected: { run: NonNullable<TaskMetadata["activeRun"]> | null } = { run: null }
		await mutateTaskMetadata(this.#paths, metadata => {
			if (metadata.activeRun) {
				selected.run = metadata.activeRun
				return metadata
			}
			const [next, ...remaining] = metadata.queuedFollowUps
			if (!next) {
				this.#accepting = false
				return metadata
			}
			selected.run = {
				id: next.id,
				sequence: next.sequence,
				...(next.acceptanceOrder ? { acceptanceOrder: next.acceptanceOrder } : {}),
				kind: "followup",
				state: "queued",
				input: next.content,
				acceptedAt: next.acceptedAt
			}
			return { ...metadata, state: "queued", activeRun: selected.run, queuedFollowUps: remaining, updatedAt: Date.now() }
		})
		if (selected.run) this.reserveRun(selected.run)
		return selected.run
	}

	private async executeRun(run: NonNullable<TaskMetadata["activeRun"]>): Promise<void> {
		let outcome: NonNullable<TaskMetadata["latestOutcome"]> = "failed"
		this.#lastAssistantOutcome = undefined
		let settled = false
		try {
			await this.reserveRun(run).run(async () => {
				if (this.#stopRequested) return
				try {
					let won = false
					const startedAt = Date.now()
					await mutateTaskMetadata(this.#paths, metadata => {
						const activeRun = metadata.activeRun
						if (!activeRun || activeRun.id !== run.id) return metadata
						won = true
						return {
							...metadata,
							state: "running",
							activeRun: { ...activeRun, state: "running", startedAt },
							updatedAt: startedAt
						}
					})
					if (!won) return
					if (run.kind === "followup") {
						await appendOutputLog(this.#paths, {
							type: "run-start",
							sequence: run.sequence,
							kind: "followup",
							timestamp: startedAt
						})
						await appendOutputLog(this.#paths, {
							type: "input",
							delivery: "followup",
							timestamp: startedAt,
							content: run.input
						})
					}
					this.#awaitingPrimaryInput = true
					await this.#child.session.prompt(run.input, childPromptOptions(this.#expandPromptTemplates))
					await this.#eventWrites
					if (this.#eventWriteFailed) throw new Error("Could not retain one or more child session events")
					outcome = this.#stopRequested ? "stopped" : (this.#lastAssistantOutcome ?? "failed")
				} catch {
					await this.#eventWrites
					outcome = this.#stopRequested ? "stopped" : "failed"
				}
				const promoted = await this.settle(run, outcome, this.#stopRequested)
				settled = true
				if (promoted) this.reserveRun(promoted).activate()
			})
		} catch {
			await this.#eventWrites
			outcome = this.#stopRequested ? "stopped" : "failed"
		}
		this.#reservations.delete(run.id)
		if (!settled) {
			const promoted = await this.settle(run, outcome, this.#stopRequested)
			if (promoted) this.reserveRun(promoted).activate()
		}
	}

	private async detach(): Promise<void> {
		const detachedAt = Date.now()
		await mutateTaskMetadata(this.#paths, metadata => {
			const activeRun = metadata.activeRun
			if (!activeRun || activeRun.id !== this.#initialRunId || activeRun.detachedAt !== undefined) return metadata
			return { ...metadata, activeRun: { ...activeRun, detachedAt }, updatedAt: detachedAt }
		})
	}

	private async settle(
		run: NonNullable<TaskMetadata["activeRun"]>,
		outcome: NonNullable<TaskMetadata["latestOutcome"]>,
		clearFollowUps = false
	): Promise<NonNullable<TaskMetadata["activeRun"]> | null> {
		let won = false
		const promoted: { run: NonNullable<TaskMetadata["activeRun"]> | null } = { run: null }
		const timestamp = Date.now()
		await mutateTaskMetadata(this.#paths, metadata => {
			if (metadata.activeRun?.id !== run.id) return clearFollowUps ? { ...metadata, queuedFollowUps: [], updatedAt: timestamp } : metadata
			won = true
			const [next, ...remaining] = clearFollowUps ? [] : metadata.queuedFollowUps
			if (next) {
				promoted.run = {
					id: next.id,
					sequence: next.sequence,
					...(next.acceptanceOrder ? { acceptanceOrder: next.acceptanceOrder } : {}),
					kind: "followup",
					state: "queued",
					input: next.content,
					acceptedAt: next.acceptedAt
				}
				return {
					...metadata,
					state: "queued",
					latestOutcome: outcome,
					activeRun: promoted.run,
					queuedFollowUps: remaining,
					updatedAt: timestamp
				}
			}
			return {
				...metadata,
				state: "idle",
				latestOutcome: outcome,
				activeRun: null,
				...(clearFollowUps ? { queuedFollowUps: [] } : {}),
				updatedAt: timestamp
			}
		})
		if (won) await appendOutputLog(this.#paths, { type: "run-end", sequence: run.sequence, outcome, timestamp })
		if (run.id === this.#initialRunId) this.#initialCompletion.resolve(undefined)
		return promoted.run
	}

	private reserveRun(run: NonNullable<TaskMetadata["activeRun"]>): AgentReservation {
		const existing = this.#reservations.get(run.id)
		if (existing) return existing
		const reservation = getAgentCoordinator().reserve({
			tuple: this.#tuple,
			signal: this.#scheduleAbort.signal,
			...(run.acceptanceOrder ? { acceptanceOrder: run.acceptanceOrder } : {})
		})
		this.#reservations.set(run.id, reservation)
		return reservation
	}

	private recordEvent(event: AgentSessionEvent): void {
		if (event.type === "tool_execution_start") {
			this.#toolArguments.set(event.toolCallId, { name: event.toolName, arguments: renderUnknown(event.args) })
			return
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			this.#lastAssistantOutcome = event.message.stopReason === "error" || event.message.stopReason === "aborted" ? "failed" : "succeeded"
			const content = event.message.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("")
			if (content) this.queueEventWrite(() => appendOutputLog(this.#paths, { type: "assistant", content }))
			return
		}
		if (event.type === "message_start" && event.message.role === "user" && this.#awaitingPrimaryInput) {
			this.#awaitingPrimaryInput = false
			return
		}
		if (event.type === "message_start" && event.message.role === "user" && this.#pendingSteers.length > 0) {
			const delivered = this.#pendingSteers.shift()
			if (delivered) {
				const content =
					typeof event.message.content === "string"
						? event.message.content
						: event.message.content
								.filter(part => part.type === "text")
								.map(part => part.text)
								.join("")
				this.queueEventWrite(() =>
					appendOutputLog(this.#paths, {
						type: "input",
						delivery: "steer",
						timestamp: Date.now(),
						content: content || delivered.content
					})
				)
			}
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

class RuntimeClosingError extends Error {
	constructor() {
		super("Agent runtime is closing")
		this.name = "LovelyAgentRuntimeClosingError"
	}
}

function isRuntimeClosingError(error: unknown): boolean {
	return error instanceof RuntimeClosingError || (error instanceof Error && error.name === "LovelyAgentRuntimeClosingError")
}

type ControllableResident = ResidentAgent & {
	input(content: string, delivery: "followup" | "steer"): Promise<ResidentInputResult>
}

const COLD_RUNTIME_LOADS = Symbol.for("@xl0/pi-lovely-agents/cold-runtime-loads/v1")

async function controllableRuntime(
	ctx: ExtensionContext,
	paths: TaskStoragePaths,
	options: AgentToolOptions
): Promise<ControllableResident> {
	const resident = getAgentCoordinator().getResident(paths.taskDirectory)
	if (resident) {
		if (!resident.input) throw new Error(`Task ${paths.taskRef} does not accept input`)
		return resident as ControllableResident
	}
	const loads = coldRuntimeLoads()
	let pending = loads.get(paths.taskDirectory)
	if (pending) return pending
	pending = openColdRuntime(ctx, paths, options)
	loads.set(paths.taskDirectory, pending)
	try {
		return await pending
	} finally {
		if (loads.get(paths.taskDirectory) === pending) loads.delete(paths.taskDirectory)
	}
}

async function openColdRuntime(ctx: ExtensionContext, paths: TaskStoragePaths, options: AgentToolOptions): Promise<AgentRuntime> {
	const loaded = await readTaskMetadata(paths)
	if (loaded.status !== "ok") throw new Error(`Could not load task ${paths.taskRef}`)
	const metadata = loaded.metadata
	if (metadata.discardedAt !== null) throw new Error(`Task ${paths.taskRef} has been discarded`)
	if (metadata.state !== "idle" && metadata.state !== "interrupted") {
		throw new Error(`Task ${paths.taskRef} has active state ${metadata.state} but no resident runtime`)
	}
	const definition: AgentDefinition = {
		name: metadata.definitionName,
		description: `Retained configuration for ${metadata.definitionName}`,
		systemPrompt: metadata.sessionConfig.systemPrompt,
		source: "project",
		filePath: paths.metadata,
		displayPath: paths.metadata,
		...(metadata.sessionConfig.tools ? { tools: [...metadata.sessionConfig.tools] } : {}),
		excludeAgentsMd: metadata.sessionConfig.excludeAgentsMd
	}
	const model = ctx.modelRegistry
		.getAvailable()
		.find(candidate => candidate.provider === metadata.model.provider && candidate.id === metadata.model.id)
	if (!model) throw new Error(`Task model "${metadata.model.provider}/${metadata.model.id}" is not authenticated`)
	const config = options.getConfig()
	const scopedModels: ScopedModel[] = metadata.sessionConfig.scopedModels.map(saved => {
		const savedModel = ctx.modelRegistry.getAll().find(candidate => candidate.provider === saved.provider && candidate.id === saved.id)
		if (!savedModel) throw new Error(`Retained scoped model "${saved.provider}/${saved.id}" is no longer available`)
		return { model: savedModel, ...(saved.thinkingLevel ? { thinkingLevel: saved.thinkingLevel } : {}) }
	})
	const child = await (options.createChild ?? createChildSession)({
		cwd: ctx.cwd,
		paths,
		definition,
		selection: { model, thinking: metadata.thinking },
		scopedModels,
		parentDepth: metadata.depth - 1,
		maximumDepth: metadata.depth + (metadata.allowAgents ? 1 : 0),
		allowAgents: metadata.allowAgents,
		projectTrusted: ctx.isProjectTrusted(),
		expectedSessionId: metadata.childSessionId,
		...(options.getAgentDir ? { agentDir: options.getAgentDir() } : {})
	})
	return new AgentRuntime(paths, child, metadata, config.expandPromptTemplates)
}

function coldRuntimeLoads(): Map<string, Promise<AgentRuntime>> {
	const global = globalThis as typeof globalThis & { [COLD_RUNTIME_LOADS]?: Map<string, Promise<AgentRuntime>> }
	global[COLD_RUNTIME_LOADS] ??= new Map()
	return global[COLD_RUNTIME_LOADS]
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
		queuedFollowUps: metadata.queuedFollowUps.length,
		output,
		tasks
	}
	const pending = detached && (result.state === "queued" || result.state === "running" || result.state === "suspended")
	return {
		content: [
			{
				type: "text",
				text: [
					`task: ${result.id}`,
					`state: ${result.state}`,
					`outcome: ${result.latestOutcome ?? "none"}`,
					`detached: ${result.detached}`,
					`queued_followups: ${result.queuedFollowUps}`,
					"output:",
					pending ? "(pending; use task_output)" : result.output.text || "(no output)"
				].join("\n")
			}
		],
		details: result
	}
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
