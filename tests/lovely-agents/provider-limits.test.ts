import { describe, expect, test } from "bun:test"
import { isProviderLimitError } from "../../extensions/lovely-agents/provider-limits.js"

describe("provider-limit classification", () => {
	test.each([
		"insufficient_quota",
		"Quota exceeded for this project",
		"Billing account is inactive",
		"Organization budget exhausted",
		"Monthly usage limit reached",
		"usage_limit_reached",
		"usage_not_included",
		"Enable available balance",
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"rate limit exceeded",
		"rate_limit_exceeded",
		"HTTP 429",
		"HTTP 429 after an upstream timeout",
		"Too many requests",
		"ResourceExhausted: request limit reached",
		"ResourceExhausted: upstream timeout",
		"RESOURCE_EXHAUSTED"
	])("includes %s", errorMessage => {
		expect(isProviderLimitError(errorMessage)).toBe(true)
	})

	test.each([
		"",
		"529 overloaded",
		"500 internal error",
		"502 bad gateway",
		"503 service unavailable",
		"504 gateway timeout",
		"524 upstream timed out",
		"network error",
		"connection refused",
		"fetch failed",
		"getaddrinfo ENOTFOUND api.example.com",
		"socket hang up",
		"websocket closed",
		"request timeout",
		"HTTP 503 rate limit proxy failure",
		"prompt exceeds the context window",
		"authentication failed"
	])("excludes %s", errorMessage => {
		expect(isProviderLimitError(errorMessage)).toBe(false)
	})

	test("excludes a missing message", () => {
		expect(isProviderLimitError(undefined)).toBe(false)
	})
})
