import { describe, expect, test } from "bun:test"
import { readdir, readFile, stat } from "node:fs/promises"
import {
	appendHistoryLog,
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
	writeLatestReply,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import { withTempWorkspace } from "./test-helpers.js"

const runId = "r_0123456789abcdef"

describe("retained history", () => {
	test("keeps inputs, replies, outcomes and compact UTF-8 tool summaries in one private file", async () => {
		await withTaskStorage("running", async paths => {
			await appendHistoryLog(paths, { type: "run-start", sequence: 1, kind: "initial", timestamp: 0 })
			await appendHistoryLog(paths, { type: "input", delivery: "initial", timestamp: 0, content: "Inspect the change" })
			await appendHistoryLog(paths, { type: "assistant", content: "Looks good." })
			await appendHistoryLog(paths, { type: "input", delivery: "steer", timestamp: 1, content: "Check tests too" })
			await appendHistoryLog(paths, {
				type: "tool",
				tool: "read",
				arguments: "🙂".repeat(1_000),
				result: "🙂".repeat(1_000),
				isError: false
			})
			await appendHistoryLog(paths, { type: "run-end", sequence: 1, outcome: "succeeded", timestamp: 2 })
			const history = await readFile(paths.history, "utf8")
			expect(history).toContain("<run 1 initial>\n<user>\nInspect the change\n<agent>\nLooks good.")
			expect(history).toContain("<steer>\nCheck tests too")
			expect(history).toContain("<tool read ok>")
			expect(history).toContain("<outcome succeeded>")
			expect(Buffer.byteLength(history)).toBeLessThan(700)
			expect(history).not.toContain("�")
			expect(retainedPaths(paths)).toEqual({
				history: ".pi/lovely-agents/parent-session/a_0123abcd/history.md",
				session: ".pi/lovely-agents/parent-session/a_0123abcd/session.jsonl"
			})
			expect((await readdir(paths.taskDirectory)).sort()).toEqual(["history.md", "metadata.json"])
			if (process.platform !== "win32") expect((await stat(paths.history)).mode & 0o077).toBe(0)
			expect((await readRetainedOutput(paths)).text).toBe("") // History is never parsed as the answer.
		})
	})
})

describe("latest reply snapshots", () => {
	test("replaces earlier replies without confusing message completion with run completion", async () => {
		await withTaskStorage("running", async paths => {
			await writeLatestReply(paths, runId, "Preamble", false)
			await writeLatestReply(paths, runId, "Final partial", true)
			expect(await readRetainedOutput(paths)).toMatchObject({
				text: "Final partial",
				streaming: true,
				state: "running",
				latestOutcome: null
			})
			await writeLatestReply(paths, runId, "Final answer", false)
			expect(await readRetainedOutput({ ...paths })).toMatchObject({ text: "Final answer", streaming: false, state: "running" })
			await mutateTaskMetadata(paths, metadata => ({ ...metadata, state: "idle", activeRun: null, latestOutcome: "succeeded" }))
			expect(await readRetainedOutput(paths)).toMatchObject({
				text: "Final answer",
				streaming: false,
				state: "idle",
				latestOutcome: "succeeded"
			})
		})
	})

	test("promotion clears stale answers and outcomes before execution; old run writes cannot leak through", async () => {
		await withTaskStorage("running", async paths => {
			await writeLatestReply(paths, runId, "Old answer", false)
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				state: "queued",
				latestOutcome: "succeeded",
				lastRunSequence: 2,
				activeRun: { id: "r_1111111111111111", sequence: 2, kind: "followup", state: "queued", input: "New request", acceptedAt: 2 }
			}))
			await writeLatestReply(paths, runId, "Late old answer", false)
			expect(await readRetainedOutput(paths)).toMatchObject({ text: "", state: "queued", latestOutcome: null })
			await mutateTaskMetadata(paths, metadata => ({ ...metadata, state: "idle", activeRun: null, latestOutcome: "stopped" }))
			expect(await readRetainedOutput(paths)).toMatchObject({ text: "", latestOutcome: "stopped" })
		})
	})

	test("caps snapshots, including a single oversized Unicode line, without pagination", async () => {
		await withTaskStorage("running", async paths => {
			await writeLatestReply(paths, runId, "🙂".repeat(20_000), true)
			const result = await readRetainedOutput(paths)
			expect(result.truncated).toBe(true)
			expect(result.text).not.toContain("�")
			expect(Buffer.byteLength(result.text.split("\n\n[Reply")[0] ?? "")).toBeLessThanOrEqual(RETAINED_OUTPUT_MAX_BYTES)
			expect(result.text).toContain("history.md")
			expect(result).not.toHaveProperty("nextOffset")
			await writeLatestReply(paths, runId, Array.from({ length: 2_001 }, (_, index) => `line ${index + 1}`).join("\n"), false)
			const lines = await readRetainedOutput(paths)
			expect(lines.text).toContain("line 2000\n")
			expect(lines.text).not.toContain("line 2001")
			expect(await countRetainedOutputLines(paths)).toBe(2_001)
		})
	})

	test("waits for equal-length replacements as well as streaming/status changes", async () => {
		await withTaskStorage("running", async paths => {
			await writeLatestReply(paths, runId, "one", true)
			const pending = readRetainedOutput(paths, { waitMs: 1_000 })
			await Bun.sleep(20)
			await writeLatestReply(paths, runId, "two", true)
			expect(await pending).toMatchObject({ text: "two", timedOut: false })
			const finalReply = readRetainedOutput(paths, { waitMs: 1_000 })
			await Bun.sleep(20)
			await writeLatestReply(paths, runId, "two", false)
			expect(await finalReply).toMatchObject({ text: "two", streaming: false, state: "running", timedOut: false })
			const completion = readRetainedOutput(paths, { waitMs: 1_000 })
			await Bun.sleep(20)
			await mutateTaskMetadata(paths, metadata => ({ ...metadata, state: "idle", latestOutcome: "succeeded", activeRun: null }))
			expect(await completion).toMatchObject({ text: "two", state: "idle", latestOutcome: "succeeded", timedOut: false })
		})
	})

	test("returns immediately for idle work, reports timeouts, and cancels waits", async () => {
		await withTaskStorage("idle", async paths => {
			const immediate = await Promise.race([readRetainedOutput(paths, { waitMs: 1_000 }), Bun.sleep(100).then(() => "too-slow")])
			expect(immediate).not.toBe("too-slow")
		})
		await withTaskStorage("running", async paths => {
			expect(await readRetainedOutput(paths, { waitMs: 25 })).toMatchObject({ timedOut: true, state: "running" })
			const controller = new AbortController()
			const pending = readRetainedOutput(paths, { waitMs: 1_000, signal: controller.signal })
			controller.abort(new Error("cancelled"))
			await expect(pending).rejects.toThrow("cancelled")
		})
	})

	test("discard during a wait rejects reads and later reply writes", async () => {
		await withTaskStorage("running", async paths => {
			const pending = readRetainedOutput(paths, { waitMs: 1_000 })
			const observed = pending.catch(error => error)
			await Bun.sleep(20)
			await mutateTaskMetadata(paths, metadata => ({ ...metadata, discardedAt: 2 }))
			expect(await observed).toMatchObject({ message: expect.stringContaining("discarded") })
			await writeLatestReply(paths, runId, "late", false)
			await expect(readRetainedOutput(paths)).rejects.toThrow("discarded")
			expect(JSON.parse(await readFile(paths.metadata, "utf8")).latestReply).toBeNull()
		})
	})
})

async function withTaskStorage(state: "idle" | "running", run: (paths: TaskStoragePaths) => Promise<void>): Promise<void> {
	await withTempWorkspace(async workspace => {
		const paths = await reserveTaskStorage(await ensureParentStorage(workspace.cwd, "parent-session"), () => "a_0123abcd")
		await initializeRetainedLogs(paths)
		const metadata: TaskMetadata = {
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
			latestReply: null,
			lastRunSequence: state === "running" ? 1 : 0,
			activeRun:
				state === "running"
					? { id: runId, sequence: 1, kind: "initial", state: "running", input: "Inspect", acceptedAt: 1, startedAt: 1 }
					: null,
			queuedFollowUps: [],
			notifications: [],
			discardedAt: null,
			createdAt: 1,
			updatedAt: 1
		}
		await writeTaskMetadata(paths, metadata)
		await run(paths)
	})
}
