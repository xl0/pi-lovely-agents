import { describe, expect, test } from "bun:test"
import { createAgentCoordinator, getAgentCoordinator, getBashCoordinator } from "../../extensions/lovely-agents/coordinator.js"

describe("process-global Agent coordinator", () => {
	test("Bash retains an independent FIFO pool unaffected by Agent capacity", async () => {
		const agents = getAgentCoordinator()
		const bash = getBashCoordinator()
		expect(getBashCoordinator()).toBe(bash)
		expect(bash).not.toBe(agents)
		const oldAgentLimit = agents.maxConcurrency
		const oldBashLimit = bash.maxConcurrency
		agents.setMaxConcurrency(1)
		bash.setMaxConcurrency(1)
		const agentPermit = await agents.acquire({})
		const bashPermit = await bash.acquire({})
		try {
			expect(agents.activeCount).toBe(1)
			expect(bash.activeCount).toBe(1)
			const order: number[] = []
			const second = bash.run({}, async () => {
				order.push(2)
			})
			const third = bash.run({}, async () => {
				order.push(3)
			})
			expect(bash.queuedCount).toBe(2)
			expect(agents.queuedCount).toBe(0)
			bashPermit.release()
			await Promise.all([second, third])
			expect(order).toEqual([2, 3])
			expect(agents.activeCount).toBe(1)
		} finally {
			agentPermit.release()
			bashPermit.release()
			agents.setMaxConcurrency(oldAgentLimit)
			bash.setMaxConcurrency(oldBashLimit)
		}
	})

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
		await coordinator.getNotificationRoute("parent")?.({ id: "notice", taskRef: "a_00000001", content: "done" })
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
		const first = await coordinator.acquire({})
		const started: number[] = []
		const secondPromise = coordinator.acquire({}).then(permit => {
			started.push(2)
			return permit
		})
		const thirdPromise = coordinator.acquire({}).then(permit => {
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

	test("drains after a concurrency reduction without aborting active work", async () => {
		const coordinator = createAgentCoordinator(2)
		const first = await coordinator.acquire({})
		const second = await coordinator.acquire({})
		coordinator.setMaxConcurrency(1)
		let thirdStarted = false
		const thirdPromise = coordinator.acquire({}).then(permit => {
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

	test("removes cancelled capacity waiters", async () => {
		const coordinator = createAgentCoordinator(1)
		const active = await coordinator.acquire({})
		const abort = new AbortController()
		const queued = coordinator.acquire({ signal: abort.signal })
		expect(coordinator.queuedCount).toBe(1)
		abort.abort(new Error("cancelled"))
		await expect(queued).rejects.toThrow("cancelled")
		expect(coordinator.queuedCount).toBe(0)
		active.release()
	})

	test("cancels a released permit's queued reacquisition", async () => {
		const coordinator = createAgentCoordinator(1)
		const permit = await coordinator.acquire({})
		const otherPromise = coordinator.acquire({})
		const lending = permit.lend(async () => "done")
		const other = await otherPromise
		expect(coordinator.queuedCount).toBe(1)
		permit.release()
		await expect(lending).rejects.toThrow("released while waiting to reacquire")
		expect(coordinator.queuedCount).toBe(0)
		other.release()
	})

	test("overlapping lends keep the slot free until the last wait ends", async () => {
		const coordinator = createAgentCoordinator(1)
		await coordinator.run({}, async () => {
			const results = await Promise.all([
				coordinator.withLentPermit(async () => "quick"),
				coordinator.withLentPermit(() => coordinator.run({}, async () => "child"))
			])
			expect(results).toEqual(["quick", "child"])
			expect(coordinator.activeCount).toBe(1)
		})
		expect(coordinator.activeCount).toBe(0)
	})

	test("lends all parent permits to avoid descendant deadlock", async () => {
		const coordinator = createAgentCoordinator(4)
		const allParentsReady = deferred<void>()
		let ready = 0
		const parents = Array.from({ length: 4 }, (_, index) =>
			coordinator.run({}, async () => {
				ready++
				if (ready === 4) allParentsReady.resolve(undefined)
				await allParentsReady.promise
				const child = coordinator.run({}, async () => index)
				return coordinator.withLentPermit(() => child)
			})
		)

		expect(await Promise.all(parents)).toEqual([0, 1, 2, 3])
		expect(coordinator.activeCount).toBe(0)
	})

	test("supports nested permit lending", async () => {
		const coordinator = createAgentCoordinator(1)
		const result = await coordinator.run({}, async () => {
			const child = coordinator.run({}, async () => {
				const grandchild = coordinator.run({}, async () => "done")
				return coordinator.withLentPermit(() => grandchild)
			})
			return coordinator.withLentPermit(() => child)
		})
		expect(result).toBe("done")
	})

	test("does not lend for immediately detached work", async () => {
		const coordinator = createAgentCoordinator(1)
		const parent = await coordinator.acquire({})
		let childStarted = false
		const child = coordinator.run({}, async () => {
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

		const parent = coordinator.run({}, async () => {
			const child = coordinator.run({}, async () => {
				childStarted.resolve(undefined)
				await finishChild.promise
			})
			await coordinator.withLentPermit(() => child)
			parentResumed = true
		})
		await childStarted.promise
		const other = coordinator.run({}, async () => {
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
