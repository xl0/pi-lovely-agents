import { AsyncLocalStorage } from "node:async_hooks"
import { publishSchedulerUpdate } from "./updates.js"

export const AGENT_COORDINATOR_VERSION = 5
const AGENT_COORDINATOR_SYMBOL = Symbol.for("@xl0/pi-lovely-agents/coordinator")
const BASH_COORDINATOR_SYMBOL = Symbol.for("@xl0/pi-lovely-agents/bash-coordinator")

export type AgentScheduleRequest = {
	acceptanceOrder?: number
	signal?: AbortSignal
}

export type AgentPermit = {
	readonly held: boolean
	lend<T>(wait: () => Promise<T>, signal?: AbortSignal): Promise<T>
	release(): void
}

export type ResidentAgent = {
	stop(): void | Promise<void>
	dispose(): void | Promise<void>
	input?(content: string, delivery: "followup" | "steer" | "stdin", options?: ResidentInputOptions): Promise<ResidentInputResult>
}

export type ResidentInputOptions = { signal?: AbortSignal; eof?: boolean }

export type ResidentInputResult = {
	run: number
	delivery: "followup" | "steer" | "stdin"
	conversionReason?: string
	queuePosition: number | null
	queuedFollowUps: number
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
	acquire(request: AgentScheduleRequest): Promise<AgentPermit>
	run<T>(request: AgentScheduleRequest, work: () => Promise<T>): Promise<T>
	withLentPermit<T>(wait: () => Promise<T>, signal?: AbortSignal): Promise<T>
	bindResident(taskKey: string, resident: ResidentAgent): () => void
	getResident(taskKey: string): ResidentAgent | undefined
	bindNotificationRoute(parentKey: string, route: ParentNotificationRoute): () => void
	getNotificationRoute(parentKey: string): ParentNotificationRoute | undefined
	bindSessionContext(sessionId: string, context: ManagedSessionContext): () => void
	getSessionContext(sessionId: string): ManagedSessionContext | undefined
}

type Waiter = {
	acceptanceOrder: number
	queueOrder: number
	resolve: () => void
	reject: (error: unknown) => void
	signal?: AbortSignal
	onAbort?: () => void
}

class ProcessAgentCoordinator implements AgentCoordinator {
	readonly version = AGENT_COORDINATOR_VERSION
	readonly #permits = new AsyncLocalStorage<Permit>()
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

	async acquire(request: AgentScheduleRequest): Promise<AgentPermit> {
		await this.#waitForSlot(request)
		return new Permit(this)
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

	async reacquire(signal?: AbortSignal): Promise<void> {
		await this.#waitForSlot(signal ? { signal } : {})
	}

	releaseSlot(): void {
		if (this.#active <= 0) throw new Error("Agent coordinator released an unowned permit")
		this.#active--
		this.#drain()
	}

	async #waitForSlot(request: AgentScheduleRequest): Promise<void> {
		if (request.signal?.aborted) throw abortError(request.signal)
		const acceptanceOrder = request.acceptanceOrder ?? this.nextAcceptanceOrder()
		if (!Number.isSafeInteger(acceptanceOrder) || acceptanceOrder < 1) {
			throw new Error("acceptanceOrder must be a positive safe integer")
		}
		this.#acceptanceOrder = Math.max(this.#acceptanceOrder, acceptanceOrder)

		await new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				acceptanceOrder,
				queueOrder: ++this.#queueOrder,
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
	}

	#drain(): void {
		while (this.#active < this.#limit) {
			const waiter = this.#waiters.shift()
			if (!waiter) break
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort)
			this.#active++
			waiter.resolve()
		}
		publishSchedulerUpdate()
	}
}

class Permit implements AgentPermit {
	readonly #coordinator: ProcessAgentCoordinator
	#state: "held" | "lent" | "released" = "held"
	#reacquireAbort: AbortController | undefined
	#reacquiring: Promise<void> | undefined
	#lends = 0

	constructor(coordinator: ProcessAgentCoordinator) {
		this.#coordinator = coordinator
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
			await this.#coordinator.reacquire(reacquireAbort.signal)
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
		typeof candidate.withLentPermit === "function" &&
		typeof candidate.setMaxConcurrency === "function" &&
		typeof candidate.bindResident === "function" &&
		typeof candidate.bindNotificationRoute === "function" &&
		typeof candidate.bindSessionContext === "function"
	)
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
