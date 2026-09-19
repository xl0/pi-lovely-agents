import { AsyncLocalStorage } from "node:async_hooks"
import type { TaskMetadata } from "./state.js"
import { publishSchedulerUpdate } from "./updates.js"

export const AGENT_COORDINATOR_VERSION = 3
const AGENT_COORDINATOR_SYMBOL = Symbol.for("@xl0/pi-lovely-agents/coordinator")
const BASH_COORDINATOR_SYMBOL = Symbol.for("@xl0/pi-lovely-agents/bash-coordinator")

export type ModelTuple = Readonly<{ provider: string; model: string }>

export type AgentScheduleRequest = {
	tuple: ModelTuple
	acceptanceOrder?: number
	signal?: AbortSignal
	/** Foreground callers cannot leave work parked behind a provider gate. */
	rejectOnClosedTuple?: boolean
}

export type AgentPermit = {
	readonly held: boolean
	lend<T>(wait: () => Promise<T>, signal?: AbortSignal): Promise<T>
	release(): void
}

export type AgentReservation = {
	readonly acceptanceOrder: number
	activate(): void
	run<T>(work: () => Promise<T>): Promise<T>
	cancel(reason?: unknown): void
}

export type ResidentAgent = {
	stop(): void | Promise<void>
	dispose(): void | Promise<void>
	input?(content: string, delivery: "followup" | "steer" | "stdin", options?: ResidentInputOptions): Promise<ResidentInputResult>
	recover?(): boolean | Promise<boolean>
}

export type ResidentInputOptions = { background?: boolean; signal?: AbortSignal; eof?: boolean }

export type ResidentInputResult = {
	run: number
	delivery: "followup" | "steer" | "stdin"
	conversionReason?: string
	queuePosition: number | null
	queuedFollowUps: number
	completed?: TaskMetadata
}

export type ParentNotification = Readonly<{ id: string; taskRef: string; content: string }>
export type ParentNotificationRoute = (notification: ParentNotification) => void | Promise<void>
export type ManagedSessionContext = Readonly<{
	depth: number
	allowAgents: boolean
	/** Aborted before SDK disposal, which does not emit session_shutdown. */
	disposeSignal?: AbortSignal
}>

export type AgentCoordinator = {
	readonly version: typeof AGENT_COORDINATOR_VERSION
	readonly maxConcurrency: number
	readonly activeCount: number
	readonly queuedCount: number
	readonly residentCount: number
	nextAcceptanceOrder(): number
	setMaxConcurrency(limit: number): void
	closeTuple(tuple: ModelTuple): void
	openTuple(tuple: ModelTuple): void
	isTupleOpen(tuple: ModelTuple): boolean
	acquire(request: AgentScheduleRequest): Promise<AgentPermit>
	run<T>(request: AgentScheduleRequest, work: () => Promise<T>): Promise<T>
	reserve(request: AgentScheduleRequest): AgentReservation
	withLentPermit<T>(wait: () => Promise<T>, signal?: AbortSignal): Promise<T>
	bindResident(taskKey: string, resident: ResidentAgent): () => void
	getResident(taskKey: string): ResidentAgent | undefined
	bindNotificationRoute(parentKey: string, route: ParentNotificationRoute): () => void
	getNotificationRoute(parentKey: string): ParentNotificationRoute | undefined
	bindSessionContext(sessionId: string, context: ManagedSessionContext): () => void
	getSessionContext(sessionId: string): ManagedSessionContext | undefined
}

type Waiter = {
	tuple: string
	acceptanceOrder: number
	queueOrder: number
	bypassTupleGate: boolean
	eligible: boolean
	/** Slot granted by drain; an unconsumed grant must be returned on cancel. */
	granted?: boolean
	consumed?: boolean
	resolve: () => void
	reject: (error: unknown) => void
	signal?: AbortSignal
	onAbort?: () => void
	rejectOnClosedTuple: boolean
}

class ProcessAgentCoordinator implements AgentCoordinator {
	readonly version = AGENT_COORDINATOR_VERSION
	readonly #permits = new AsyncLocalStorage<Permit>()
	readonly #closedTuples = new Set<string>()
	readonly #waiters: Waiter[] = []
	readonly #residents = new Map<string, ResidentAgent>()
	readonly #notificationRoutes = new Map<string, ParentNotificationRoute>()
	readonly #sessionContexts = new Map<string, ManagedSessionContext>()
	#limit: number
	#active = 0
	#acceptanceOrder = 0
	#queueOrder = 0

	constructor(limit: number) {
		assertConcurrency(limit)
		this.#limit = limit
	}

	get maxConcurrency(): number {
		return this.#limit
	}

	get activeCount(): number {
		return this.#active
	}

	get queuedCount(): number {
		return this.#waiters.length
	}

	get residentCount(): number {
		return this.#residents.size
	}

	nextAcceptanceOrder(): number {
		return ++this.#acceptanceOrder
	}

	setMaxConcurrency(limit: number): void {
		assertConcurrency(limit)
		this.#limit = limit
		this.#drain()
	}

	closeTuple(tuple: ModelTuple): void {
		assertTuple(tuple)
		this.#closedTuples.add(tupleKey(tuple))
		for (const waiter of [...this.#waiters]) {
			if (waiter.tuple === tupleKey(tuple) && waiter.rejectOnClosedTuple) {
				this.cancel(waiter, new Error("Provider/model is suspended by a provider limit; foreground work cannot wait for recovery"))
			}
		}
		publishSchedulerUpdate()
	}

	openTuple(tuple: ModelTuple): void {
		assertTuple(tuple)
		this.#closedTuples.delete(tupleKey(tuple))
		this.#drain()
	}

	isTupleOpen(tuple: ModelTuple): boolean {
		assertTuple(tuple)
		return !this.#closedTuples.has(tupleKey(tuple))
	}

	async acquire(request: AgentScheduleRequest): Promise<AgentPermit> {
		await this.#waitForSlot(request, false)
		return new Permit(this, { provider: request.tuple.provider, model: request.tuple.model })
	}

	async run<T>(request: AgentScheduleRequest, work: () => Promise<T>): Promise<T> {
		const permit = await this.acquire(request)
		return this.#permits.run(permit as Permit, async () => {
			try {
				return await work()
			} finally {
				permit.release()
			}
		})
	}

	reserve(request: AgentScheduleRequest): AgentReservation {
		assertTuple(request.tuple)
		if (request.signal?.aborted) throw abortError(request.signal)
		const acceptanceOrder = request.acceptanceOrder ?? this.nextAcceptanceOrder()
		if (!Number.isSafeInteger(acceptanceOrder) || acceptanceOrder < 1) {
			throw new Error("acceptanceOrder must be a positive safe integer")
		}
		this.#acceptanceOrder = Math.max(this.#acceptanceOrder, acceptanceOrder)
		const queued = this.#enqueue(request, acceptanceOrder, false, false)
		return new Reservation(this, request.tuple, acceptanceOrder, queued.waiter, queued.promise)
	}

	async withLentPermit<T>(wait: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const permit = this.#permits.getStore()
		return permit ? permit.lend(wait, signal) : wait()
	}

	bindResident(taskKey: string, resident: ResidentAgent): () => void {
		assertRegistryKey(taskKey)
		this.#residents.set(taskKey, resident)
		return () => {
			if (this.#residents.get(taskKey) === resident) this.#residents.delete(taskKey)
		}
	}

	getResident(taskKey: string): ResidentAgent | undefined {
		assertRegistryKey(taskKey)
		return this.#residents.get(taskKey)
	}

	bindNotificationRoute(parentKey: string, route: ParentNotificationRoute): () => void {
		assertRegistryKey(parentKey)
		this.#notificationRoutes.set(parentKey, route)
		return () => {
			if (this.#notificationRoutes.get(parentKey) === route) this.#notificationRoutes.delete(parentKey)
		}
	}

	getNotificationRoute(parentKey: string): ParentNotificationRoute | undefined {
		assertRegistryKey(parentKey)
		return this.#notificationRoutes.get(parentKey)
	}

	bindSessionContext(sessionId: string, context: ManagedSessionContext): () => void {
		assertRegistryKey(sessionId)
		if (!Number.isSafeInteger(context.depth) || context.depth < 0)
			throw new Error("Managed session depth must be a nonnegative safe integer")
		const stored = { ...context }
		this.#sessionContexts.set(sessionId, stored)
		return () => {
			if (this.#sessionContexts.get(sessionId) === stored) this.#sessionContexts.delete(sessionId)
		}
	}

	getSessionContext(sessionId: string): ManagedSessionContext | undefined {
		assertRegistryKey(sessionId)
		return this.#sessionContexts.get(sessionId)
	}

	async reacquire(tuple: ModelTuple, signal?: AbortSignal): Promise<void> {
		await this.#waitForSlot({ tuple, ...(signal ? { signal } : {}) }, true)
	}

	releaseSlot(): void {
		if (this.#active <= 0) throw new Error("Agent coordinator released an unowned permit")
		this.#active--
		this.#drain()
	}

	async #waitForSlot(request: AgentScheduleRequest, bypassTupleGate: boolean): Promise<void> {
		assertTuple(request.tuple)
		if (request.signal?.aborted) throw abortError(request.signal)
		const acceptanceOrder = request.acceptanceOrder ?? this.nextAcceptanceOrder()
		if (!Number.isSafeInteger(acceptanceOrder) || acceptanceOrder < 1) {
			throw new Error("acceptanceOrder must be a positive safe integer")
		}
		this.#acceptanceOrder = Math.max(this.#acceptanceOrder, acceptanceOrder)

		await this.#enqueue(request, acceptanceOrder, bypassTupleGate, true).promise
	}

	#enqueue(
		request: AgentScheduleRequest,
		acceptanceOrder: number,
		bypassTupleGate: boolean,
		eligible: boolean
	): { waiter: Waiter; promise: Promise<void> } {
		if (request.rejectOnClosedTuple && !this.isTupleOpen(request.tuple)) {
			throw new Error("Provider/model is suspended by a provider limit; foreground work cannot wait for recovery")
		}
		let waiter!: Waiter
		const promise = new Promise<void>((resolve, reject) => {
			waiter = {
				tuple: tupleKey(request.tuple),
				acceptanceOrder,
				queueOrder: ++this.#queueOrder,
				bypassTupleGate,
				eligible,
				rejectOnClosedTuple: request.rejectOnClosedTuple ?? false,
				resolve,
				reject,
				...(request.signal ? { signal: request.signal } : {})
			}
			if (request.signal) {
				waiter.onAbort = () => {
					const index = this.#waiters.indexOf(waiter)
					if (index < 0) return
					this.#waiters.splice(index, 1)
					reject(abortError(request.signal as AbortSignal))
				}
				request.signal.addEventListener("abort", waiter.onAbort, { once: true })
			}
			const insertion = this.#waiters.findIndex(
				queued =>
					queued.acceptanceOrder > waiter.acceptanceOrder ||
					(queued.acceptanceOrder === waiter.acceptanceOrder && queued.queueOrder > waiter.queueOrder)
			)
			if (insertion < 0) this.#waiters.push(waiter)
			else this.#waiters.splice(insertion, 0, waiter)
			this.#drain()
		})
		return { waiter, promise }
	}

	activate(waiter: Waiter): void {
		if (!this.#waiters.includes(waiter)) return
		waiter.eligible = true
		this.#drain()
	}

	cancel(waiter: Waiter, reason?: unknown): void {
		const index = this.#waiters.indexOf(waiter)
		if (index < 0) {
			if (waiter.granted && !waiter.consumed) {
				waiter.consumed = true
				this.releaseSlot()
			}
			return
		}
		this.#waiters.splice(index, 1)
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort)
		waiter.reject(reason instanceof Error ? reason : new Error("Agent reservation cancelled"))
	}

	async runReservation<T>(tuple: ModelTuple, waiter: Waiter, ready: Promise<void>, work: () => Promise<T>): Promise<T> {
		this.activate(waiter)
		await ready
		if (waiter.consumed) throw new Error("Agent reservation cancelled")
		waiter.consumed = true
		const permit = new Permit(this, tuple)
		return this.#permits.run(permit, async () => {
			try {
				return await work()
			} finally {
				permit.release()
			}
		})
	}

	#drain(): void {
		while (this.#active < this.#limit) {
			const index = this.#waiters.findIndex(waiter => waiter.eligible && (waiter.bypassTupleGate || !this.#closedTuples.has(waiter.tuple)))
			if (index < 0) break
			const [waiter] = this.#waiters.splice(index, 1)
			if (!waiter) break
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort)
			this.#active++
			waiter.granted = true
			waiter.resolve()
		}
		publishSchedulerUpdate()
	}
}

class Reservation implements AgentReservation {
	readonly acceptanceOrder: number
	readonly #coordinator: ProcessAgentCoordinator
	readonly #tuple: ModelTuple
	readonly #waiter: Waiter
	readonly #ready: Promise<void>
	#used = false

	constructor(coordinator: ProcessAgentCoordinator, tuple: ModelTuple, acceptanceOrder: number, waiter: Waiter, ready: Promise<void>) {
		this.#coordinator = coordinator
		this.#tuple = { ...tuple }
		this.acceptanceOrder = acceptanceOrder
		this.#waiter = waiter
		this.#ready = ready
		void this.#ready.catch(() => {})
	}

	activate(): void {
		this.#coordinator.activate(this.#waiter)
	}

	async run<T>(work: () => Promise<T>): Promise<T> {
		if (this.#used) throw new Error("Agent reservation has already been used")
		this.#used = true
		return this.#coordinator.runReservation(this.#tuple, this.#waiter, this.#ready, work)
	}

	cancel(reason?: unknown): void {
		this.#coordinator.cancel(this.#waiter, reason)
	}
}

class Permit implements AgentPermit {
	readonly #coordinator: ProcessAgentCoordinator
	readonly #tuple: ModelTuple
	#state: "held" | "lent" | "released" = "held"
	#reacquireAbort: AbortController | undefined
	#reacquiring: Promise<void> | undefined
	#lends = 0

	constructor(coordinator: ProcessAgentCoordinator, tuple: ModelTuple) {
		this.#coordinator = coordinator
		this.#tuple = tuple
	}

	get held(): boolean {
		return this.#state === "held"
	}

	/** Overlapping lends share one released slot; the last to finish reacquires it. */
	async lend<T>(wait: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.#state === "released") return wait()
		if (this.#state === "held") {
			this.#state = "lent"
			this.#coordinator.releaseSlot()
		}
		this.#lends++

		let succeeded = false
		let result: T | undefined
		let failure: unknown
		try {
			result = await wait()
			succeeded = true
		} catch (error) {
			failure = error
		}
		this.#lends--

		while (this.currentState() === "lent" && this.#lends === 0) {
			this.#reacquiring ??= this.reacquire(signal).finally(() => {
				this.#reacquiring = undefined
			})
			await this.#reacquiring
		}
		if (!succeeded) throw failure
		return result as T
	}

	private async reacquire(signal?: AbortSignal): Promise<void> {
		const reacquireAbort = new AbortController()
		const forwardAbort = () => reacquireAbort.abort(signal?.reason)
		if (signal?.aborted) forwardAbort()
		else signal?.addEventListener("abort", forwardAbort, { once: true })
		this.#reacquireAbort = reacquireAbort
		try {
			await this.#coordinator.reacquire(this.#tuple, reacquireAbort.signal)
			if (this.currentState() === "released") {
				this.#coordinator.releaseSlot()
				throw abortError(reacquireAbort.signal)
			}
			// A wait that began during reacquisition still needs the slot lent.
			if (this.#lends > 0) this.#coordinator.releaseSlot()
			else this.#state = "held"
		} catch (error) {
			this.#state = "released"
			throw error
		} finally {
			signal?.removeEventListener("abort", forwardAbort)
			this.#reacquireAbort = undefined
		}
	}

	release(): void {
		if (this.#state === "released") return
		if (this.#state === "held") this.#coordinator.releaseSlot()
		this.#state = "released"
		this.#reacquireAbort?.abort(new Error("Agent permit released while waiting to reacquire"))
	}

	private currentState(): "held" | "lent" | "released" {
		return this.#state
	}
}

export function createAgentCoordinator(maxConcurrency: number): AgentCoordinator {
	return new ProcessAgentCoordinator(maxConcurrency)
}

export function getAgentCoordinator(maxConcurrency = 4): AgentCoordinator {
	const globals = globalThis as unknown as Record<symbol, unknown>
	const existing = globals[AGENT_COORDINATOR_SYMBOL]
	if (existing !== undefined) {
		if (!isAgentCoordinator(existing)) throw new Error("Incompatible process-global Lovely Agents coordinator")
		return existing
	}
	const coordinator = createAgentCoordinator(maxConcurrency)
	globals[AGENT_COORDINATOR_SYMBOL] = coordinator
	return coordinator
}

/** Independent process permits; Bash residents still bind in the main coordinator. */
export function getBashCoordinator(maxConcurrency = 4): AgentCoordinator {
	const globals = globalThis as unknown as Record<symbol, unknown>
	const existing = globals[BASH_COORDINATOR_SYMBOL]
	if (existing !== undefined) {
		if (!isAgentCoordinator(existing)) throw new Error("Incompatible process-global Lovely Bash coordinator")
		return existing
	}
	const coordinator = createAgentCoordinator(maxConcurrency)
	globals[BASH_COORDINATOR_SYMBOL] = coordinator
	return coordinator
}

function isAgentCoordinator(value: unknown): value is AgentCoordinator {
	if (typeof value !== "object" || value === null) return false
	const candidate = value as Partial<AgentCoordinator>
	return (
		candidate.version === AGENT_COORDINATOR_VERSION &&
		typeof candidate.acquire === "function" &&
		typeof candidate.reserve === "function" &&
		typeof candidate.withLentPermit === "function" &&
		typeof candidate.setMaxConcurrency === "function" &&
		typeof candidate.bindResident === "function" &&
		typeof candidate.bindNotificationRoute === "function" &&
		typeof candidate.bindSessionContext === "function"
	)
}

function tupleKey(tuple: ModelTuple): string {
	return `${tuple.provider}\0${tuple.model}`
}

function assertTuple(tuple: ModelTuple): void {
	if (!tuple.provider || !tuple.model || tuple.provider.includes("\0") || tuple.model.includes("\0")) {
		throw new Error("Model tuple provider and model must be nonempty and contain no NUL bytes")
	}
}

function assertConcurrency(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("maxConcurrency must be a positive safe integer")
}

function assertRegistryKey(key: string): void {
	if (!key) throw new Error("Coordinator registry keys must be nonempty")
}

function abortError(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason
	const error = new Error(signal.reason === undefined ? "Agent scheduling aborted" : String(signal.reason))
	error.name = "AbortError"
	return error
}
