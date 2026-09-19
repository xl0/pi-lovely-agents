import { expect, test } from "bun:test"
import { createAgentCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import { bindTaskUpdateRoute, publishTaskUpdate } from "../../extensions/lovely-agents/updates.js"

test("task update routes are exact, shared, and identity-safe", async () => {
	const updates: string[] = []
	const old = () => {
		updates.push("old")
	}
	const current = () => {
		updates.push("current")
	}
	const unbindOld = bindTaskUpdateRoute("/workspace", "parent", old)
	const unbindCurrent = bindTaskUpdateRoute("/workspace", "parent", current)
	const unbindOther = bindTaskUpdateRoute("/workspace", "other", () => {
		updates.push("other")
	})

	unbindOld()
	publishTaskUpdate("/workspace", "parent")
	await Promise.resolve()
	expect(updates).toEqual(["current"])

	unbindCurrent()
	unbindOther()
})

test("scheduler changes refresh all parents, and a broken UI cannot break scheduling", async () => {
	const updates: string[] = []
	const unbind = [
		bindTaskUpdateRoute("/one", "parent", () => {
			updates.push("one")
		}),
		bindTaskUpdateRoute("/two", "parent", () => {
			updates.push("two")
		}),
		bindTaskUpdateRoute("/broken", "parent", () => {
			throw new Error("UI failed")
		})
	]
	const coordinator = createAgentCoordinator(1)
	try {
		const permit = await coordinator.acquire({})
		expect(updates).toEqual(["one", "two"])
		updates.length = 0
		permit.release()
		coordinator.setMaxConcurrency(2)
		await Bun.sleep(0)
		expect(updates).toEqual(["one", "two", "one", "two"])
	} finally {
		for (const dispose of unbind) dispose()
	}
})
