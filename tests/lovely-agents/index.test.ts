import { describe, expect, test } from "bun:test"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { latestReplyWasInterrupted, successfulTurnTuple } from "../../extensions/lovely-agents/index.js"

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

function branch(stopReason: string): SessionEntry[] {
	return [
		{ type: "message", message: { role: "assistant", stopReason } },
		{ type: "custom", customType: "later", data: {} }
	] as SessionEntry[]
}
