import { describe, expect, test } from "bun:test"
import { createAgentCoordinator, getAgentCoordinator, type ModelTuple } from "../../extensions/lovely-agents/coordinator.js"

const alpha: ModelTuple = { provider: "provider", model: "alpha" }
const beta: ModelTuple = { provider: "provider", model: "beta" }

describe("process-global Agent coordinator", () => {
	test("reuses one versioned coordinator across extension runtimes", () => {
		const first = getAgentCoordinator()
		const second = getAgentCoordinator()
		expect(second).toBe(first)
		first.setMaxConcurrency(3)
		expect(second.maxConcurrency).toBe(3)
		first.setMaxConcurrency(4)
	})

	test("keeps reload-safe resident and notification bindings", async () => {
		const coordinator = createAgentCoordinator(1)
		const oldResident = { stop() {}, dispose() {} }
		const resident = { stop() {}, dispose() {} }
		const unbindOldResident = coordinator.bindResident("task", oldResident)
		const unbindResident = coordinator.bindResident("task", resident)
		unbindOldResident()
		expect(coordinator.getResident("task")).toBe(resident)
		expect(coordinator.residentCount).toBe(1)

		const oldRoute = async () => {}
		const delivered: string[] = []
		const route = async (notification: { id: string; content: string }) => {
			delivered.push(notification.content)
		}
		const unbindOldRoute = coordinator.bindNotificationRoute("parent", oldRoute)
		const unbindRoute = coordinator.bindNotificationRoute("parent", route)
		unbindOldRoute()
		await coordinator.getNotificationRoute("parent")?.({ id: "notice", content: "done" })
		expect(delivered).toEqual(["done"])
		const unbindContext = coordinator.bindSessionContext("session", { depth: 2, allowAgents: false })
		expect(coordinator.getSessionContext("session")).toEqual({ depth: 2, allowAgents: false })

		unbindResident()
		unbindRoute()
		unbindContext()
		expect(coordinator.getResident("task")).toBeUndefined()
		expect(coordinator.getNotificationRoute("parent")).toBeUndefined()
		expect(coordinator.getSessionContext("session")).toBeUndefined()
	})
})

describe("Agent scheduling", () => {
	test("starts eligible work in FIFO acceptance order", async () => {
		const coordinator = createAgentCoordinator(1)
		const first = await coordinator.acquire({ tuple: alpha })
		const started: number[] = []
		const secondPromise = coordinator.acquire({ tuple: alpha }).then(permit => {
			started.push(2)
			return permit
		})
		const thirdPromise = coordinator.acquire({ tuple: alpha }).then(permit => {
			started.push(3)
			return permit
		})
		expect(coordinator.queuedCount).toBe(2)

		first.release()
		const second = await secondPromise
		expect(started).toEqual([2])
		second.release()
		const third = await thirdPromise
		expect(started).toEqual([2, 3])
		third.release()
	})

	test("reserves acceptance order before work becomes eligible", async () => {
		const coordinator = createAgentCoordinator(1)
		const blocker = await coordinator.acquire({ tuple: alpha })
		const order: string[] = []
		const earlier = coordinator.reserve({ tuple: alpha, acceptanceOrder: coordinator.nextAcceptanceOrder() })
		const earlierRun = earlier.run(async () => {
			order.push("earlier")
		})
		const laterRun = coordinator.run({ tuple: alpha }, async () => {
			order.push("later")
		})
		blocker.release()
		await Promise.all([earlierRun, laterRun])
		expect(order).toEqual(["earlier", "later"])
	})

	test("does not let an inactive reservation block eligible work", async () => {
		const coordinator = createAgentCoordinator(1)
		const reserved = coordinator.reserve({ tuple: alpha })
		await coordinator.run({ tuple: alpha }, async () => {})
		expect(coordinator.activeCount).toBe(0)
		reserved.cancel()
		expect(coordinator.queuedCount).toBe(0)
	})

	test("drains after a concurrency reduction without aborting active work", async () => {
		const coordinator = createAgentCoordinator(2)
		const first = await coordinator.acquire({ tuple: alpha })
		const second = await coordinator.acquire({ tuple: alpha })
		coordinator.setMaxConcurrency(1)
		let thirdStarted = false
		const thirdPromise = coordinator.acquire({ tuple: alpha }).then(permit => {
			thirdStarted = true
			return permit
		})

		first.release()
		await tick()
		expect(thirdStarted).toBe(false)
		second.release()
		const third = await thirdPromise
		expect(thirdStarted).toBe(true)
		third.release()
	})

	test("skips closed model tuples while other tuples continue", async () => {
		const coordinator = createAgentCoordinator(1)
		coordinator.closeTuple(alpha)
		let alphaStarted = false
		const alphaPromise = coordinator.acquire({ tuple: alpha, acceptanceOrder: 1 }).then(permit => {
			alphaStarted = true
			return permit
		})
		const betaPermit = await coordinator.acquire({ tuple: beta, acceptanceOrder: 2 })
		expect(alphaStarted).toBe(false)
		betaPermit.release()
		expect(coordinator.activeCount).toBe(0)

		coordinator.openTuple(alpha)
		const alphaPermit = await alphaPromise
		expect(alphaStarted).toBe(true)
		alphaPermit.release()
	})

	test("closes a tuple for new work while running siblings drain", async () => {
		const coordinator = createAgentCoordinator(2)
		const first = await coordinator.acquire({ tuple: alpha })
		const sibling = await coordinator.acquire({ tuple: alpha })
		coordinator.closeTuple(alpha)

		let blockedStarted = false
		const blockedPromise = coordinator.acquire({ tuple: alpha }).then(permit => {
			blockedStarted = true
			return permit
		})
		first.release()
		await tick()
		expect(blockedStarted).toBe(false)
		expect(coordinator.activeCount).toBe(1)

		const independent = await coordinator.acquire({ tuple: beta })
		expect(coordinator.activeCount).toBe(2)
		independent.release()
		sibling.release()
		expect(coordinator.activeCount).toBe(0)

		coordinator.openTuple(alpha)
		const blocked = await blockedPromise
		expect(blockedStarted).toBe(true)
		blocked.release()
	})

	test("removes cancelled capacity waiters", async () => {
		const coordinator = createAgentCoordinator(1)
		const active = await coordinator.acquire({ tuple: alpha })
		const abort = new AbortController()
		const queued = coordinator.acquire({ tuple: alpha, signal: abort.signal })
		expect(coordinator.queuedCount).toBe(1)
		abort.abort(new Error("cancelled"))
		await expect(queued).rejects.toThrow("cancelled")
		expect(coordinator.queuedCount).toBe(0)
		active.release()
	})

	test("cancels a released permit's queued reacquisition", async () => {
		const coordinator = createAgentCoordinator(1)
		const permit = await coordinator.acquire({ tuple: alpha })
		const otherPromise = coordinator.acquire({ tuple: beta })
		const lending = permit.lend(async () => "done")
		const other = await otherPromise
		expect(coordinator.queuedCount).toBe(1)
		permit.release()
		await expect(lending).rejects.toThrow("released while waiting to reacquire")
		expect(coordinator.queuedCount).toBe(0)
		other.release()
	})

	test("lends all parent permits to avoid descendant deadlock", async () => {
		const coordinator = createAgentCoordinator(4)
		const allParentsReady = deferred<void>()
		let ready = 0
		const parents = Array.from({ length: 4 }, (_, index) =>
			coordinator.run({ tuple: alpha }, async () => {
				ready++
				if (ready === 4) allParentsReady.resolve(undefined)
				await allParentsReady.promise
				const child = coordinator.run({ tuple: beta }, async () => index)
				return coordinator.withLentPermit(() => child)
			})
		)

		expect(await Promise.all(parents)).toEqual([0, 1, 2, 3])
		expect(coordinator.activeCount).toBe(0)
	})

	test("supports nested permit lending", async () => {
		const coordinator = createAgentCoordinator(1)
		const result = await coordinator.run({ tuple: alpha }, async () => {
			const child = coordinator.run({ tuple: beta }, async () => {
				const grandchild = coordinator.run({ tuple: alpha }, async () => "done")
				return coordinator.withLentPermit(() => grandchild)
			})
			return coordinator.withLentPermit(() => child)
		})
		expect(result).toBe("done")
	})

	test("lets already-running parents reacquire through a closed tuple gate", async () => {
		const coordinator = createAgentCoordinator(1)
		const result = await coordinator.run({ tuple: alpha }, async () => {
			coordinator.closeTuple(alpha)
			const child = coordinator.run({ tuple: beta }, async () => "done")
			return coordinator.withLentPermit(() => child)
		})
		expect(result).toBe("done")
		expect(coordinator.activeCount).toBe(0)
	})

	test("does not lend for immediately detached work", async () => {
		const coordinator = createAgentCoordinator(1)
		const parent = await coordinator.acquire({ tuple: alpha })
		let childStarted = false
		const child = coordinator.run({ tuple: beta }, async () => {
			childStarted = true
		})
		await tick()
		expect(childStarted).toBe(false)
		parent.release()
		await child
		expect(childStarted).toBe(true)
	})

	test("queues permit reacquisition behind already waiting work", async () => {
		const coordinator = createAgentCoordinator(1)
		const childStarted = deferred<void>()
		const finishChild = deferred<void>()
		const otherStarted = deferred<void>()
		const finishOther = deferred<void>()
		let parentResumed = false

		const parent = coordinator.run({ tuple: alpha }, async () => {
			const child = coordinator.run({ tuple: beta }, async () => {
				childStarted.resolve(undefined)
				await finishChild.promise
			})
			await coordinator.withLentPermit(() => child)
			parentResumed = true
		})
		await childStarted.promise
		const other = coordinator.run({ tuple: beta }, async () => {
			otherStarted.resolve(undefined)
			await finishOther.promise
		})
		finishChild.resolve(undefined)
		await otherStarted.promise
		expect(parentResumed).toBe(false)
		finishOther.resolve(undefined)
		await Promise.all([parent, other])
		expect(parentResumed).toBe(true)
	})
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>(resolvePromise => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

async function tick(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}
