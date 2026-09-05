import { expect, test } from "bun:test"
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
