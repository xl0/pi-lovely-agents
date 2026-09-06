import { randomBytes } from "node:crypto"
import { rm } from "node:fs/promises"
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent"
import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
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
import {
	type AgentReservation,
	getAgentCoordinator,
	type ModelTuple,
	type ResidentAgent,
	type ResidentInputOptions,
	type ResidentInputResult
} from "./coordinator.js"
import { type AgentDefinition, discoverAgentDefinitions } from "./definitions.js"
import { discardTask, stopOwnedTaskTree, stopTask } from "./lifecycle.js"
import { appendTaskNotification, deliverTaskNotifications, prepareTaskNotification } from "./notifications.js"
import { isProviderLimitError } from "./provider-limits.js"
import { renderExpandableResult } from "./rendering.js"
import {
	acquireParentLease,
	appendHistoryLog,
	archivedTaskStoragePaths,
	displayWorkspacePath,
	ensureParentStorage,
	initializeRetainedLogs,
	MAX_AGENT_INPUT_BYTES,
	MAX_AGENT_LABEL_BYTES,
	MAX_QUEUED_FOLLOWUPS,
	mutateTaskMetadata,
	readRetainedOutput,
	readTaskMetadata,
	reserveTaskStorage,
	retainedOutputSnapshot,
	retainedPaths,
	TASK_METADATA_VERSION,
	TASK_REFERENCE_PATTERN,
	type TaskMetadata,
	type TaskStoragePaths,
	taskStoragePaths,
	writeTaskMetadata,
	writeTaskProgress
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

type RecoveryMode = "automatic" | "manual" | "stop"
type SuspendedRuntime = {
	wakeProviderRecovery(mode: RecoveryMode): boolean
}
const SUSPENDED_RUNTIMES_SYMBOL = Symbol.for("@xl0/pi-lovely-agents/suspended-runtimes/v1")

/** Opens one tuple and wakes every process-resident run suspended on it. */
export function recoverProviderTuple(tuple: ModelTuple): number {
	getAgentCoordinator().openTuple(tuple)
	const runtimes = suspendedRuntimes().get(modelTupleKey(tuple))
	if (!runtimes) return 0
	let recovered = 0
	for (const runtime of [...runtimes]) {
		if (runtime.wakeProviderRecovery("automatic")) recovered++
	}
	return recovered
}

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
	output?: Awaited<ReturnType<typeof readRetainedOutput>>
}

export type AgentToolOptions = {
	getConfig: () => AgentsConfig
	createChild?: typeof createChildSession
	getAgentDir?: () => string
	canDelegate?: () => boolean
}

export function registerAgentTool(pi: ExtensionAPI, options: AgentToolOptions): void {
	const background = options.getConfig().capabilities.includes("backgroundAgents")
	pi.registerTool({
		name: "agent",
		label: "Agent",
		description: background
			? "Create a durable Lovely Agent session and start its initial run. waitMs permits background detachment."
			: "Create a durable Lovely Agent session and wait for its terminal result. Cancellation stops the accepted work.",
		promptSnippet: "Create or delegate work to a durable agent",
		promptGuidelines: ["Call agent_roster before creating an agent and use task tools for existing work."],
		parameters: Type.Object(
			{
				definition: Type.String({ minLength: 1, description: "Agent Definition name" }),
				label: Type.String({ minLength: 1, description: "Short task label" }),
				prompt: Type.String({ minLength: 1, description: "Initial task prompt" }),
				...(background ? { waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600_000 })) } : {}),
				model: Type.Optional(
					Type.String({ minLength: 1, description: "Configured provider/model ID or an enabled alias from agent_roster" })
				),
				thinking: Type.Optional(ThinkingLevel),
				...(options.canDelegate?.() === false
					? {}
					: { allowAgents: Type.Optional(Type.Boolean({ description: "Allow this child to create descendants" })) })
			},
			{ additionalProperties: false }
		),
		renderCall(args, theme, context) {
			return {
				render(width) {
					// The result supplies the ID after renderCall; read shared state at paint time.
					const header = `${theme.fg("toolTitle", theme.bold("agent"))}${args.definition ? ` ${theme.fg("muted", args.definition)}` : ""}${args.label ? ` ${theme.fg("dim", `label=${JSON.stringify(args.label)}`)}` : ""}`
					const suffix = context.state.taskRef ? `${theme.fg("muted", " -> ")}${theme.fg("accent", context.state.taskRef)}` : ""
					if (context.expanded) {
						const lines = new Text(header + suffix, 0, 0).render(width)
						if (args.prompt) lines.push(...new Text(`${theme.fg("muted", "Input: ")}${args.prompt}`, 0, 0).render(width))
						return lines
					}
					const available = Math.max(0, width - visibleWidth(suffix))
					const promptWidth = available - visibleWidth(header) - visibleWidth(' prompt=""')
					const preview =
						args.prompt && promptWidth > 0
							? `${header}${theme.fg("muted", ' prompt="')}${truncateToWidth(JSON.stringify(args.prompt.replace(/\s+/g, " ").trim()).slice(1, -1), promptWidth)}${theme.fg("muted", '"')}`
							: truncateToWidth(header, available)
					// Pi's truncation emits full resets; preserve the surrounding tool background.
					return [truncateToWidth(preview + suffix, width).replaceAll("\x1b[0m", "\x1b[22;39m")]
				},
				invalidate() {}
			}
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result.details as Partial<AgentCreationResult> | undefined
			if (typeof details?.id === "string") context.state.taskRef = details.id
			const output = new Container()
			if (expanded || context.isError) {
				output.addChild(new Text(theme.fg("muted", "── Result ──"), 0, 0))
				output.addChild(renderExpandableResult(result, true, theme))
			}
			return output
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw abortError(signal)
			const config = options.getConfig()
			const background = config.capabilities.includes("backgroundAgents")
			if (!background && "waitMs" in params) throw new Error("waitMs requires the backgroundAgents capability")
			if (
				"waitMs" in params &&
				(typeof params.waitMs !== "number" || !Number.isInteger(params.waitMs) || params.waitMs < 0 || params.waitMs > 600_000)
			) {
				throw new Error("waitMs must be an integer from 0 to 600000")
			}
			if ("allowAgents" in params && typeof params.allowAgents !== "boolean") throw new Error("allowAgents must be boolean")
			const allowAgents = params.allowAgents === true
			if (allowAgents && options.canDelegate?.() === false) throw new Error("This child cannot delegate at the current maximum depth")
			validateInput(params.label, "label", MAX_AGENT_LABEL_BYTES)
			validateInput(params.prompt, "prompt", MAX_AGENT_INPUT_BYTES)
			const parentSessionId = ctx.sessionManager.getSessionId()
			const coordinator = getAgentCoordinator(config.maxConcurrency)
			const parentContext = coordinator.getSessionContext(parentSessionId)
			if (parentContext && !parentContext.allowAgents) throw new Error("This parent agent is not allowed to delegate")
			const parentDepth = parentContext?.depth ?? 0
			resolveChildToolPolicy({
				parentDepth,
				maximumDepth: config.maxDepth,
				allowAgents
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
				aliases: configuredModels.aliases,
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
					allowAgents,
					projectTrusted: ctx.isProjectTrusted()
				})
				if (signal?.aborted) throw abortError(signal)
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
					latestReply: null,
					lastActivity: { at: acceptedAt, action: "queued" },
					lastRunSequence: 1,
					activeRun: {
						id: runId,
						sequence: 1,
						acceptanceOrder,
						background,
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
				await appendHistoryLog(paths, { type: "run-start", sequence: 1, kind: "initial", timestamp: acceptedAt })
				await appendHistoryLog(paths, { type: "input", delivery: "initial", timestamp: acceptedAt, content: params.prompt })
				await writeTaskMetadata(paths, metadata)
				accepted = true

				const runtime = new AgentRuntime(paths, child, metadata, config.expandPromptTemplates)
				child = undefined
				runtime.start()
				if (!background) {
					const completed = await runtime.waitForRun(runId, signal)
					const tasks = (await loadTaskList(ctx.cwd, parentSessionId)).details
					return buildAgentCreationToolResult(completed, false, retainedOutputSnapshot(paths, completed), tasks)
				}
				const waitMs = (params.waitMs as number | undefined) ?? config.waitMs
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
	const background = options.getConfig().capabilities.includes("backgroundAgents")
	pi.registerTool({
		name: "task_input",
		label: "Task Input",
		description: background
			? "Send a durable Follow-up or live Steer to an owned Lovely Agent task."
			: "Run a Follow-up on an idle owned task and wait for its terminal reply, or send a run-scoped live Steer. Busy tasks reject Follow-ups.",
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
		renderCall(args, theme) {
			const delivery = args.delivery ?? "followup"
			const content = args.content ?? ""
			const preview = content.length > 60 ? `${content.slice(0, 57)}...` : content
			return new Text(
				`${theme.fg("toolTitle", theme.bold("task_input"))}${args.id ? ` ${theme.fg("muted", args.id)}` : ""} ${theme.fg("dim", `${delivery}${preview ? ` ${JSON.stringify(preview)}` : ""}`)}`,
				0,
				0
			)
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if ("waitMs" in params) throw new Error("task_input does not accept waitMs")
			const requestedDelivery = params.delivery ?? "followup"
			const result = await sendTaskInput(ctx, options, params.id, params.content, requestedDelivery, signal)
			return {
				content: [
					{
						type: "text",
						text:
							result.effectiveDelivery === "steer"
								? `${result.id}: steer delivered (${result.state}; ${result.queuedFollowUps} Follow-ups queued)`
								: result.output
									? `${result.id}: followup ${result.latestOutcome}\n${result.output.text}`
									: `${result.id}: followup accepted (position ${result.queuePosition}; ${result.state}; ${result.queuedFollowUps} queued)`
					}
				],
				details: result
			}
		}
	})

	for (const action of ["stop", "discard"] as const) {
		pi.registerTool({
			name: `task_${action}`,
			label: action === "stop" ? "Task Stop" : "Task Discard",
			description:
				action === "stop"
					? "Stop active or queued work for an owned Lovely Agent task while preserving its session."
					: "Stop and permanently discard an owned Lovely Agent subtree, archiving its files. Unsupported metadata versions can also be archived.",
			promptSnippet: action === "stop" ? "Stop work for a durable task" : "Discard a durable task",
			promptGuidelines:
				action === "discard"
					? [
							"After consuming an agent's results, use task_discard if no Follow-up is expected. Keep reusable specialists; do not discard agents whose results are still needed."
						]
					: [],
			parameters: Type.Object(
				{ id: Type.String({ pattern: TASK_REFERENCE_PATTERN.source, description: "Task Reference" }) },
				{ additionalProperties: false }
			),
			renderCall(args, theme) {
				return new Text(`${theme.fg("toolTitle", theme.bold(`task_${action}`))}${args.id ? ` ${theme.fg("muted", args.id)}` : ""}`, 0, 0)
			},
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const details = await controlTaskLifecycle(ctx, params.id, action)
				return {
					content: [
						{
							type: "text",
							text:
								action === "discard"
									? `${details.id}: discarded (files archived at ${details.archiveDirectory})`
									: `${details.id}: stop complete (${details.state}; outcome ${details.latestOutcome ?? "none"}; ${details.queuedFollowUps} queued)`
						}
					],
					details
				}
			}
		})
	}
}

export async function sendTaskInput(
	ctx: ExtensionContext,
	options: AgentToolOptions,
	id: string,
	content: string,
	requestedDelivery: "followup" | "steer",
	signal?: AbortSignal
): Promise<TaskInputResult> {
	if (signal?.aborted) throw abortError(signal)
	validateInput(content, "content", MAX_AGENT_INPUT_BYTES)
	const lease = await acquireParentLease(ctx.cwd, ctx.sessionManager.getSessionId())
	const paths = taskStoragePaths(lease.paths, id)
	const loaded = await readTaskMetadata(paths)
	if (loaded.status === "missing") throw new Error(`Unknown Task Reference: ${id}`)
	if (loaded.status === "invalid") throw new Error(loaded.diagnostic.message)
	if (loaded.metadata.discardedAt !== null) throw new Error(`Task ${id} has been discarded`)
	let accepted: ResidentInputResult | undefined
	while (!accepted) {
		if (signal?.aborted) throw abortError(signal)
		const runtime = await controllableRuntime(ctx, paths, options)
		try {
			accepted = await runtime.input(content, requestedDelivery, {
				background: options.getConfig().capabilities.includes("backgroundAgents"),
				...(signal ? { signal } : {})
			})
		} catch (error) {
			if (!isRuntimeClosingError(error)) throw error
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	}
	const current = await readTaskMetadata(paths)
	if (current.status !== "ok") throw new Error(`Could not read accepted task ${id}`)
	return {
		id,
		requestedDelivery,
		effectiveDelivery: accepted.delivery,
		queuePosition: accepted.queuePosition,
		state: accepted.completed?.state ?? current.metadata.state,
		latestOutcome: accepted.completed?.latestOutcome ?? current.metadata.latestOutcome,
		queuedFollowUps: accepted.completed?.queuedFollowUps.length ?? current.metadata.queuedFollowUps.length,
		...(accepted.completed ? { output: retainedOutputSnapshot(paths, accepted.completed) } : {})
	}
}

export async function controlTaskLifecycle(ctx: ExtensionContext, id: string, action: "stop" | "discard") {
	const lease = await acquireParentLease(ctx.cwd, ctx.sessionManager.getSessionId())
	const paths = taskStoragePaths(lease.paths, id)
	if (action === "discard") {
		await discardTask(paths)
		const archived = archivedTaskStoragePaths(paths)
		return {
			id,
			action,
			state: "archived",
			latestOutcome: null,
			discarded: true,
			queuedFollowUps: 0,
			archiveDirectory: displayWorkspacePath(ctx.cwd, archived.taskDirectory)
		}
	}
	let loaded = await readTaskMetadata(paths)
	if (loaded.status === "missing") throw new Error(`Unknown Task Reference: ${id}`)
	if (loaded.status === "invalid") throw new Error(loaded.diagnostic.message)
	if (loaded.metadata.discardedAt !== null) throw new Error(`Task ${id} has been discarded`)
	await stopTask(paths)
	await stopOwnedTaskTree(ctx.cwd, loaded.metadata.childSessionId)
	loaded = await readTaskMetadata(paths)
	if (loaded.status !== "ok") throw new Error(`Could not read task ${id}`)
	const metadata = loaded.metadata
	return {
		id: metadata.taskRef,
		action,
		state: metadata.state,
		latestOutcome: metadata.latestOutcome,
		discarded: metadata.discardedAt !== null,
		queuedFollowUps: metadata.queuedFollowUps.length,
		archiveDirectory: undefined,
		paths: retainedPaths(paths)
	}
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
	readonly #completions = new Map<string, ReturnType<typeof deferred<TaskMetadata | undefined>>>()
	#unbindResident: (() => void) | undefined
	#unbindSuspended: (() => void) | undefined
	#unsubscribe: (() => void) | undefined
	#eventWrites: Promise<void> = Promise.resolve()
	#eventWriteFailed = false
	#recordingRunId: string | undefined
	#pendingProgress: ({ runId: string } & Partial<Pick<TaskMetadata, "latestReply" | "lastActivity">>) | undefined
	#lastHeartbeatAt = 0
	#progressWriteQueued = false
	#started = false
	#stopRequested = false
	#accepting = true
	#disposed = false
	#awaitingPrimaryInput = false
	#lastAssistantOutcome: NonNullable<TaskMetadata["latestOutcome"]> | undefined
	#providerLimitReached = false
	#recoveryWait: (ReturnType<typeof deferred<RecoveryMode>> & { mode: RecoveryMode | undefined }) | undefined
	#recoveryMode: Exclude<RecoveryMode, "stop"> | undefined

	constructor(paths: TaskStoragePaths, child: ChildSessionHandle, metadata: TaskMetadata, expandPromptTemplates: boolean) {
		this.#paths = paths
		this.#child = child
		this.#initialRunId = metadata.activeRun?.kind === "initial" ? metadata.activeRun.id : undefined
		this.#expandPromptTemplates = expandPromptTemplates
		this.#tuple = { provider: metadata.model.provider, model: metadata.model.id }
		if (metadata.activeRun && !metadata.activeRun.background) this.#completions.set(metadata.activeRun.id, deferred())
		this.#unbindResident = getAgentCoordinator().bindResident(paths.taskDirectory, this)
		this.#unsubscribe = child.session.subscribe(event => this.recordEvent(event))
	}

	start(): void {
		if (this.#started) return
		this.#started = true
		void this.run().catch(() => {})
	}

	/** Run-specific synchronous wait; cancellation owns the accepted run and its descendants. */
	async waitForRun(runId: string, signal?: AbortSignal): Promise<TaskMetadata> {
		const completion = this.#completions.get(runId)
		if (!completion) throw new Error(`Missing completion for run ${runId}`)
		return getAgentCoordinator().withLentPermit(async () => {
			const aborted = deferred<void>()
			const onAbort = () => aborted.resolve(undefined)
			signal?.addEventListener("abort", onAbort, { once: true })
			if (signal?.aborted) onAbort()
			try {
				const result = await Promise.race([completion.promise, aborted.promise.then(() => undefined)])
				if (signal?.aborted) {
					await this.stop()
					await stopOwnedTaskTree(this.#paths.workspace, this.#child.session.sessionId)
					throw abortError(signal)
				}
				if (!result) throw new Error(`Agent run ${runId} ended without a retained terminal result`)
				return result
			} finally {
				signal?.removeEventListener("abort", onAbort)
				this.#completions.delete(runId)
			}
		}, signal)
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
		this.wakeProviderRecovery("stop")
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
		this.#unbindSuspended?.()
		this.#unbindSuspended = undefined
		this.#child.dispose()
	}

	async input(content: string, delivery: "followup" | "steer", options: ResidentInputOptions = {}): Promise<ResidentInputResult> {
		if (!this.#accepting || this.#disposed) throw new RuntimeClosingError()
		let result: ResidentInputResult | undefined
		let acceptedRun: NonNullable<TaskMetadata["activeRun"]> | undefined
		try {
			await mutateTaskMetadata(this.#paths, async metadata => {
				if (options.signal?.aborted) throw abortError(options.signal)
				if (!this.#accepting || this.#disposed) throw new RuntimeClosingError()
				if (metadata.discardedAt !== null) throw new Error(`Task ${metadata.taskRef} has been discarded`)
				if (delivery === "steer" && metadata.state === "running" && metadata.activeRun && this.#child.session.isStreaming) {
					const pending = { content }
					this.#pendingSteers.push(pending)
					try {
						// prompt() can yield in input hooks and start a new run after streaming ends.
						if (this.#expandPromptTemplates) await this.#child.session.steer(content)
						else this.#child.session.agent.steer({ role: "user", content, timestamp: Date.now() })
					} catch (error) {
						const index = this.#pendingSteers.indexOf(pending)
						if (index >= 0) this.#pendingSteers.splice(index, 1)
						throw error
					}
					result = { delivery: "steer", queuePosition: null, queuedFollowUps: metadata.queuedFollowUps.length }
					return metadata
				}
				if (
					(!options.background && (metadata.activeRun || metadata.queuedFollowUps.length)) ||
					(metadata.activeRun && !metadata.activeRun.background)
				) {
					throw new Error(`Task ${metadata.taskRef} is busy; foreground Follow-ups require an idle task`)
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
					background: options.background ?? false,
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
					queuedFollowUps: [
						...metadata.queuedFollowUps,
						{ id: runId, sequence, acceptanceOrder, background: options.background ?? false, content, acceptedAt }
					],
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
		if (acceptedRun) {
			if (!acceptedRun.background) this.#completions.set(acceptedRun.id, deferred())
			// Inactive background reservations preserve acceptance order across promotion.
			if (acceptedRun.background) this.reserveRun(acceptedRun)
		}
		this.start()
		if (acceptedRun && !acceptedRun.background) result.completed = await this.waitForRun(acceptedRun.id, options.signal)
		return result
	}

	recover(): boolean {
		return this.wakeProviderRecovery("manual")
	}

	wakeProviderRecovery(mode: RecoveryMode): boolean {
		const wait = this.#recoveryWait
		if (!wait || wait.mode || this.#disposed || (this.#stopRequested && mode !== "stop")) return false
		wait.mode = mode
		this.#unbindSuspended?.()
		this.#unbindSuspended = undefined
		wait.resolve(mode)
		return true
	}

	private async run(): Promise<void> {
		try {
			while (!this.#stopRequested) {
				const activeRun = await this.nextRun()
				if (!activeRun) break
				if (await this.executeRun(activeRun)) {
					const wait = this.#recoveryWait
					if (!wait) throw new Error("Suspended run has no recovery wait")
					const mode = await wait.promise
					if (this.#recoveryWait === wait) this.#recoveryWait = undefined
					if (mode === "stop") break
					this.#recoveryMode = mode
				}
			}
		} finally {
			this.dispose()
			for (const completion of this.#completions.values()) completion.resolve(undefined)
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
				background: next.background ?? false,
				kind: "followup",
				state: "queued",
				input: next.content,
				acceptedAt: next.acceptedAt
			}
			return { ...metadata, state: "queued", activeRun: selected.run, queuedFollowUps: remaining, updatedAt: Date.now() }
		})
		return selected.run
	}

	private async executeRun(run: NonNullable<TaskMetadata["activeRun"]>): Promise<boolean> {
		this.#recordingRunId = run.id
		this.#lastHeartbeatAt = 0
		let outcome: NonNullable<TaskMetadata["latestOutcome"]> = "failed"
		const recovering = run.state === "suspended"
		this.#lastAssistantOutcome = undefined
		this.#providerLimitReached = false
		let settled = false
		let suspended = false
		try {
			await this.reserveRun(run).run(async () => {
				if (this.#stopRequested) return
				let promptCompleted = false
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
							lastActivity: { at: startedAt, action: "started" },
							updatedAt: startedAt
						}
					})
					if (!won) return
					this.#recoveryMode = undefined
					if (run.kind === "followup" && !recovering) {
						await appendHistoryLog(this.#paths, {
							type: "run-start",
							sequence: run.sequence,
							kind: "followup",
							timestamp: startedAt
						})
						await appendHistoryLog(this.#paths, {
							type: "input",
							delivery: "followup",
							timestamp: startedAt,
							content: run.input
						})
					}
					this.#awaitingPrimaryInput = true
					await this.#child.session.prompt(
						recovering ? "Continue." : run.input,
						childPromptOptions(recovering ? false : this.#expandPromptTemplates)
					)
					promptCompleted = true
					await this.#eventWrites
					if (this.#eventWriteFailed) throw new Error("Could not retain one or more child session events")
					outcome = this.#stopRequested ? "stopped" : (this.#lastAssistantOutcome ?? "failed")
				} catch {
					if (!promptCompleted) this.#providerLimitReached = false
					await this.#eventWrites
					outcome = this.#stopRequested ? "stopped" : "failed"
				}
				if (!this.#stopRequested && this.#providerLimitReached) {
					suspended = await this.suspend(run)
					if (suspended) return
				}
				const promoted = await this.settle(run, outcome, this.#stopRequested)
				settled = true
				if (promoted) this.reserveRun(promoted).activate()
			})
		} catch (error) {
			await this.#eventWrites
			outcome = this.#stopRequested ? "stopped" : "failed"
			if (!run.background && !this.#stopRequested) {
				await mutateTaskMetadata(this.#paths, metadata =>
					metadata.activeRun?.id === run.id
						? {
								...metadata,
								latestReply: { text: error instanceof Error ? error.message : String(error), streaming: false },
								updatedAt: Date.now()
							}
						: metadata
				)
			}
		}
		this.#child.session.clearQueue()
		this.#pendingSteers.length = 0
		this.#reservations.delete(run.id)
		if (!settled && !suspended) {
			const promoted = await this.settle(run, outcome, this.#stopRequested)
			if (promoted) this.reserveRun(promoted).activate()
		}
		return suspended
	}

	private async suspend(run: NonNullable<TaskMetadata["activeRun"]>): Promise<boolean> {
		// Provider evidence is tuple-global even if another task mutation wins.
		getAgentCoordinator().closeTuple(this.#tuple)
		if (!run.background) {
			await writeTaskProgress(this.#paths, run.id, {
				latestReply: { text: "Provider limit reached; foreground run failed and will not restart automatically.", streaming: false }
			})
			return false
		}
		const wait = Object.assign(deferred<RecoveryMode>(), { mode: undefined as RecoveryMode | undefined })
		const unbind = bindSuspendedRuntime(this.#tuple, this)
		this.#recoveryWait = wait
		this.#unbindSuspended = unbind
		let won = false
		let notification: TaskMetadata["notifications"][number] | undefined
		const timestamp = Date.now()
		await mutateTaskMetadata(this.#paths, async metadata => {
			const activeRun = metadata.activeRun
			if (!activeRun || activeRun.id !== run.id) return metadata
			won = true
			if (run.kind === "followup" || activeRun.detachedAt !== undefined) {
				notification = await prepareTaskNotification(this.#paths, metadata, activeRun, "suspension")
			}
			return {
				...metadata,
				state: "suspended",
				activeRun: { ...activeRun, state: "suspended" },
				...(notification ? { notifications: appendTaskNotification(metadata.notifications, notification) } : {}),
				updatedAt: timestamp
			}
		})
		if (won) {
			if (run.id === this.#initialRunId) this.#initialCompletion.resolve(undefined)
			if (notification) await deliverTaskNotifications(this.#paths).catch(() => {})
		} else {
			unbind()
			if (this.#recoveryWait === wait) this.#recoveryWait = undefined
			if (this.#unbindSuspended === unbind) this.#unbindSuspended = undefined
		}
		return won
	}

	private async detach(): Promise<void> {
		const detachedAt = Date.now()
		await mutateTaskMetadata(this.#paths, metadata => {
			const activeRun = metadata.activeRun
			if (!activeRun?.background || activeRun.id !== this.#initialRunId || activeRun.detachedAt !== undefined) return metadata
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
		let notification: TaskMetadata["notifications"][number] | undefined
		let completed: TaskMetadata | undefined
		const timestamp = Date.now()
		await mutateTaskMetadata(this.#paths, async metadata => {
			const activeRun = metadata.activeRun
			if (activeRun?.id !== run.id) return clearFollowUps ? { ...metadata, queuedFollowUps: [], updatedAt: timestamp } : metadata
			won = true
			completed = { ...metadata, state: "idle", latestOutcome: outcome, activeRun: null, queuedFollowUps: [], updatedAt: timestamp }
			if (
				activeRun.background &&
				(outcome === "succeeded" || outcome === "failed") &&
				(run.kind === "followup" || activeRun.detachedAt !== undefined)
			) {
				notification = await prepareTaskNotification(this.#paths, metadata, activeRun, "completion", outcome)
			}
			const [next, ...remaining] = clearFollowUps ? [] : metadata.queuedFollowUps
			if (next) {
				promoted.run = {
					id: next.id,
					sequence: next.sequence,
					...(next.acceptanceOrder ? { acceptanceOrder: next.acceptanceOrder } : {}),
					background: next.background ?? false,
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
					...(notification ? { notifications: appendTaskNotification(metadata.notifications, notification) } : {}),
					updatedAt: timestamp
				}
			}
			return {
				...metadata,
				state: "idle",
				latestOutcome: outcome,
				activeRun: null,
				...(clearFollowUps ? { queuedFollowUps: [] } : {}),
				...(notification ? { notifications: appendTaskNotification(metadata.notifications, notification) } : {}),
				updatedAt: timestamp
			}
		})
		if (won) await appendHistoryLog(this.#paths, { type: "run-end", sequence: run.sequence, outcome, timestamp })
		if (won && notification) await deliverTaskNotifications(this.#paths).catch(() => {})
		if (won) this.#completions.get(run.id)?.resolve(completed)
		if (run.id === this.#initialRunId) this.#initialCompletion.resolve(undefined)
		return promoted.run
	}

	private reserveRun(run: NonNullable<TaskMetadata["activeRun"]>): AgentReservation {
		const existing = this.#reservations.get(run.id)
		if (existing) return existing
		const tuple =
			run.state === "suspended" && this.#recoveryMode === "manual"
				? { provider: `${this.#tuple.provider}#manual#${this.#paths.taskRef}`, model: this.#tuple.model }
				: this.#tuple
		const reservation = getAgentCoordinator().reserve({
			tuple,
			signal: this.#scheduleAbort.signal,
			rejectOnClosedTuple: !run.background,
			...(run.acceptanceOrder ? { acceptanceOrder: run.acceptanceOrder } : {})
		})
		this.#reservations.set(run.id, reservation)
		return reservation
	}

	private recordEvent(event: AgentSessionEvent): void {
		const at = Date.now()
		const runId = this.#recordingRunId
		if (runId && event.type === "agent_start") {
			// before_agent_start hooks have finished; capture now, not when the queued write runs.
			const effectiveSystemPrompt = this.#child.session.systemPrompt
			this.queueEventWrite(() => writeTaskProgress(this.#paths, runId, { effectiveSystemPrompt }))
		}
		let action: string | undefined
		let latestReply: TaskMetadata["latestReply"] | undefined
		if (
			runId &&
			((event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") ||
				event.type === "tool_execution_update") &&
			at - this.#lastHeartbeatAt >= 1_000
		) {
			// Non-reply heartbeats are event-driven and capped at one durable write per second.
			this.#lastHeartbeatAt = at
			action = event.type === "tool_execution_update" ? `tool ${event.toolName.slice(0, 160)}` : "thinking"
		}
		if (runId && (event.type === "tool_execution_start" || event.type === "tool_execution_end")) {
			action = `tool ${event.toolName.slice(0, 160)}${event.type === "tool_execution_end" ? (event.isError ? " failed" : " complete") : ""}`
		}
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant" &&
			(event.type !== "message_update" || event.assistantMessageEvent.type === "text_delta")
		) {
			const text = event.message.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("")
			latestReply = { text, streaming: event.type !== "message_end" }
			action = latestReply.streaming ? "responding" : "reply complete"
		}
		if (runId && action) {
			this.#pendingProgress = {
				...this.#pendingProgress,
				runId,
				...(latestReply ? { latestReply } : {}),
				lastActivity: { at, action }
			}
			if (!this.#progressWriteQueued) {
				this.#progressWriteQueued = true
				this.queueEventWrite(async () => {
					try {
						// Coalesce replies and activity together so bursts cannot reorder their last action.
						while (this.#pendingProgress) {
							const { runId, ...progress } = this.#pendingProgress
							this.#pendingProgress = undefined
							await writeTaskProgress(this.#paths, runId, progress)
						}
					} finally {
						this.#progressWriteQueued = false
					}
				})
			}
		}
		if (event.type === "tool_execution_start") {
			this.#toolArguments.set(event.toolCallId, { name: event.toolName, arguments: renderUnknown(event.args) })
			return
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			this.#lastAssistantOutcome = event.message.stopReason === "error" || event.message.stopReason === "aborted" ? "failed" : "succeeded"
			this.#providerLimitReached = event.message.stopReason === "error" && isProviderLimitError(event.message.errorMessage)
			const content = event.message.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("")
			if (content) this.queueEventWrite(() => appendHistoryLog(this.#paths, { type: "assistant", content }))
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
					appendHistoryLog(this.#paths, {
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
				appendHistoryLog(this.#paths, {
					type: "tool",
					tool: started?.name ?? event.toolName,
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
	input(content: string, delivery: "followup" | "steer", options?: ResidentInputOptions): Promise<ResidentInputResult>
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
					...(output.queueReason
						? [`waiting: ${output.queueReason} (${output.capacity.active}/${output.capacity.limit} execution permits)`]
						: []),
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

function suspendedRuntimes(): Map<string, Set<SuspendedRuntime>> {
	const global = globalThis as typeof globalThis & { [SUSPENDED_RUNTIMES_SYMBOL]?: Map<string, Set<SuspendedRuntime>> }
	global[SUSPENDED_RUNTIMES_SYMBOL] ??= new Map()
	return global[SUSPENDED_RUNTIMES_SYMBOL]
}

function bindSuspendedRuntime(tuple: ModelTuple, runtime: SuspendedRuntime): () => void {
	const registry = suspendedRuntimes()
	const key = modelTupleKey(tuple)
	const runtimes = registry.get(key) ?? new Set()
	runtimes.add(runtime)
	registry.set(key, runtimes)
	return () => {
		runtimes.delete(runtime)
		if (runtimes.size === 0 && registry.get(key) === runtimes) registry.delete(key)
	}
}

function modelTupleKey(tuple: ModelTuple): string {
	return `${tuple.provider}\0${tuple.model}`
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
