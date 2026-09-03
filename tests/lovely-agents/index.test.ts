import { describe, expect, test } from "bun:test"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { latestReplyWasInterrupted } from "../../extensions/lovely-agents/index.js"

describe("/continue eligibility", () => {
	test("accepts only the latest errored or aborted assistant reply", () => {
		expect(latestReplyWasInterrupted([])).toBe(false)
		expect(latestReplyWasInterrupted(branch("stop"))).toBe(false)
		expect(latestReplyWasInterrupted(branch("length"))).toBe(false)
		expect(latestReplyWasInterrupted(branch("error"))).toBe(true)
		expect(latestReplyWasInterrupted(branch("aborted"))).toBe(true)
	})
})

function branch(stopReason: string): SessionEntry[] {
	return [
		{ type: "message", message: { role: "assistant", stopReason } },
		{ type: "custom", customType: "later", data: {} }
	] as SessionEntry[]
}
