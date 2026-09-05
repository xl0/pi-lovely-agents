import { describe, expect, test } from "bun:test"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { latestReplyWasInterrupted, successfulTurnTuple } from "../../extensions/lovely-agents/index.js"
import { renderActiveTaskRows } from "../../extensions/lovely-agents/task-panel.js"

describe("/continue eligibility", () => {
	test("accepts only the latest errored or aborted assistant reply", () => {
		expect(latestReplyWasInterrupted([])).toBe(false)
		expect(latestReplyWasInterrupted(branch("stop"))).toBe(false)
		expect(latestReplyWasInterrupted(branch("length"))).toBe(false)
		expect(latestReplyWasInterrupted(branch("error"))).toBe(true)
		expect(latestReplyWasInterrupted(branch("aborted"))).toBe(true)
	})
})

describe("automatic tuple recovery", () => {
	test("uses only successful assistant turns with an exact model identity", () => {
		expect(successfulTurnTuple({ role: "assistant", stopReason: "stop", provider: "provider", model: "model" })).toEqual({
			provider: "provider",
			model: "model"
		})
		expect(successfulTurnTuple({ role: "assistant", stopReason: "error", provider: "provider", model: "model" })).toBeUndefined()
		expect(successfulTurnTuple({ role: "assistant", stopReason: "aborted", provider: "provider", model: "model" })).toBeUndefined()
		expect(successfulTurnTuple({ role: "assistant", stopReason: "length", provider: "provider", model: "model" })).toBeUndefined()
		expect(successfulTurnTuple({ role: "user", provider: "provider", model: "model" })).toBeUndefined()
		expect(successfulTurnTuple({ role: "assistant", stopReason: "stop" })).toBeUndefined()
	})
})

test("active task rows stay compact", () => {
	const rows = renderActiveTaskRows(
		Array.from({ length: 7 }, (_, index) => ({
			id: `a_0000000${index}`,
			label: `Task ${index}`,
			state: index % 2 ? "running" : "queued",
			queuedFollowUps: index
		}))
	)
	expect(rows).toHaveLength(6)
	expect(rows[0]).toBe("↳ a_00000000 queued Task 0")
	expect(rows[1]).toContain("(+1)")
	expect(rows.at(-1)).toBe("  … 2 more active")
})

function branch(stopReason: string): SessionEntry[] {
	return [
		{ type: "message", message: { role: "assistant", stopReason } },
		{ type: "custom", customType: "later", data: {} }
	] as SessionEntry[]
}
