import { describe, expect, test } from "bun:test"
import { readFile, stat, writeFile } from "node:fs/promises"
import {
	appendActivityLog,
	appendOutputLog,
	countRetainedOutputLines,
	ensureParentStorage,
	initializeRetainedLogs,
	mutateTaskMetadata,
	RETAINED_OUTPUT_MAX_BYTES,
	readRetainedOutput,
	reserveTaskStorage,
	retainedPaths,
	TASK_METADATA_VERSION,
	type TaskMetadata,
	type TaskStoragePaths,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import { withTempWorkspace } from "./test-helpers.js"

describe("retained log writers", () => {
	test("writes documented output and bounded activity records privately", async () => {
		await withTaskStorage("idle", async paths => {
			await appendOutputLog(paths, {
				type: "run-start",
				sequence: 1,
				kind: "initial",
				timestamp: 0
			})
			await appendOutputLog(paths, { type: "input", delivery: "initial", timestamp: 0, content: "Inspect the change" })
			await appendOutputLog(paths, { type: "assistant", content: "Looks good." })
			await appendOutputLog(paths, { type: "input", delivery: "steer", timestamp: 1, content: "Check tests too" })
			await appendOutputLog(paths, {
				type: "run-end",
				sequence: 1,
				outcome: "succeeded",
				timestamp: 2,
				summary: "Completed review."
			})

			const oversized = "🙂".repeat(1_000)
			await appendActivityLog(paths, {
				tool: "read",
				timestamp: 1,
				arguments: oversized,
				result: oversized,
				isError: false,
				fullOutputPath: paths.session
			})

			const output = await readFile(paths.output, "utf8")
			expect(output).toContain("## Run 1 (initial)")
			expect(output).toContain("### Input")
			expect(output).toContain("Inspect the change")
			expect(output).toContain("### Assistant\n\nLooks good.")
			expect(output).toContain("### Steer")
			expect(output).toContain("Outcome: succeeded")

			const activity = await readFile(paths.activity, "utf8")
			expect(activity.match(/\[\.\.\. omitted 1952 UTF-8 bytes \.\.\.\]/g)).toHaveLength(2)
			expect(activity).not.toContain("�")
			expect(activity).toContain("Full output: .pi/lovely-agents/parent-session/a_0123abcd/session.jsonl")
			expect(retainedPaths(paths)).toEqual({
				output: ".pi/lovely-agents/parent-session/a_0123abcd/output.md",
				activity: ".pi/lovely-agents/parent-session/a_0123abcd/activity.md",
				session: ".pi/lovely-agents/parent-session/a_0123abcd/session.jsonl"
			})
			if (process.platform !== "win32") {
				expect((await stat(paths.output)).mode & 0o077).toBe(0)
				expect((await stat(paths.activity)).mode & 0o077).toBe(0)
			}
			await expect(stat(paths.session)).rejects.toMatchObject({ code: "ENOENT" })
		})
	})
})

describe("retained output reads", () => {
	test("caps line ranges and continues with 1-indexed offsets", async () => {
		await withTaskStorage("idle", async paths => {
			await writeFile(paths.output, `${Array.from({ length: 2_001 }, (_, index) => `line ${index + 1}`).join("\n")}\n`)
			const first = await readRetainedOutput(paths)
			expect(first.returnedLines).toBe(2_000)
			expect(first.totalLines).toBe(2_001)
			expect(await countRetainedOutputLines(paths)).toBe(2_001)
			expect(first.nextOffset).toBe(2_001)
			expect(first.truncatedBy).toBe("lines")
			expect(first.text).toEndWith("[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]")

			const limited = await readRetainedOutput(paths, { offset: 10, limit: 2 })
			expect(limited.text).toBe("line 10\nline 11\n\n[Showing lines 10-11 of 2001. Use offset=12 to continue.]")

			const continued = await readRetainedOutput(paths, { offset: first.nextOffset })
			expect(continued.text).toBe("line 2001")
			expect(continued.endLine).toBe(2_001)
			expect(continued.nextOffset).toBe(2_002)
			expect(continued.truncated).toBe(false)
		})
	})

	test("enforces the byte cap without splitting multi-byte characters", async () => {
		await withTaskStorage("idle", async paths => {
			await writeFile(paths.output, `${Array.from({ length: 100 }, () => "🙂".repeat(200)).join("\n")}\n`)
			const result = await readRetainedOutput(paths)
			const retainedContent = result.text.split("\n\n[Showing", 1)[0] ?? ""
			expect(result.truncatedBy).toBe("bytes")
			expect(result.returnedLines).toBe(63)
			expect(Buffer.byteLength(retainedContent)).toBeLessThanOrEqual(RETAINED_OUTPUT_MAX_BYTES)
			expect(retainedContent).not.toContain("�")
			expect(result.text).toContain("(50KB limit). Use offset=64 to continue.")
		})
	})

	test("long-polls until output grows", async () => {
		await withTaskStorage("running", async paths => {
			const pending = readRetainedOutput(paths, { waitMs: 1_000 })
			await Bun.sleep(20)
			await appendOutputLog(paths, { type: "assistant", content: "New output" })

			const result = await pending
			expect(result.timedOut).toBe(false)
			expect(result.returnedLines).toBeGreaterThan(0)
			expect(result.text).toContain("New output")
		})
	})

	test("long-polls until task state changes", async () => {
		await withTaskStorage("running", async paths => {
			const pending = readRetainedOutput(paths, { waitMs: 1_000 })
			await Bun.sleep(20)
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				state: "idle",
				latestOutcome: "succeeded",
				activeRun: null,
				updatedAt: metadata.updatedAt + 1
			}))

			const result = await pending
			expect(result.timedOut).toBe(false)
			expect(result.state).toBe("idle")
			expect(result.returnedLines).toBe(0)
		})
	})

	test("returns immediately for idle work and reports active timeouts", async () => {
		await withTaskStorage("idle", async paths => {
			const immediate = await Promise.race([readRetainedOutput(paths, { waitMs: 1_000 }), Bun.sleep(100).then(() => "too-slow" as const)])
			expect(immediate).not.toBe("too-slow")
		})

		await withTaskStorage("running", async paths => {
			const result = await readRetainedOutput(paths, { waitMs: 25 })
			expect(result.timedOut).toBe(true)
			expect(result.state).toBe("running")
		})
	})
})

async function withTaskStorage(state: "idle" | "running", run: (paths: TaskStoragePaths) => Promise<void>): Promise<void> {
	await withTempWorkspace(async workspace => {
		const parent = await ensureParentStorage(workspace.cwd, "parent-session")
		const paths = await reserveTaskStorage(parent, () => "a_0123abcd")
		await initializeRetainedLogs(paths)
		await writeTaskMetadata(paths, metadata(paths, state))
		await run(paths)
	})
}

function metadata(paths: TaskStoragePaths, state: "idle" | "running"): TaskMetadata {
	return {
		version: TASK_METADATA_VERSION,
		kind: "agent",
		taskRef: paths.taskRef,
		parentSessionId: paths.parentSessionId,
		childSessionId: "child-session",
		definitionName: "reviewer",
		label: "Review change",
		model: { provider: "anthropic", id: "sonnet" },
		thinking: "high",
		depth: 1,
		allowAgents: false,
		sessionConfig: {
			systemPrompt: "Review work.",
			tools: null,
			excludeAgentsMd: false,
			scopedModels: [{ provider: "anthropic", id: "sonnet" }]
		},
		state,
		latestOutcome: null,
		lastRunSequence: state === "running" ? 1 : 0,
		activeRun:
			state === "running"
				? {
						id: "r_0123456789abcdef",
						sequence: 1,
						kind: "initial",
						state: "running",
						input: "Inspect",
						acceptedAt: 1,
						startedAt: 1
					}
				: null,
		queuedFollowUps: [],
		notifications: [],
		discardedAt: null,
		createdAt: 1,
		updatedAt: 1
	}
}
