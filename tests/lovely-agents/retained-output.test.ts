import { describe, expect, test } from "bun:test"
import { readFile, stat, writeFile } from "node:fs/promises"
import { getAgentCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import {
	appendHistoryLog,
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
	taskSchedulingStatus,
	writeTaskMetadata,
	writeTaskProgress
} from "../../extensions/lovely-agents/state.js"
import { withTempWorkspace } from "./test-helpers.js"

const runId = "r_0123456789abcdef"

function writeLatestReply(paths: TaskStoragePaths, id: string, text: string, streaming: boolean) {
	return writeTaskProgress(paths, id, { latestReply: { text, streaming } })
}

describe("task progress", () => {
	test("reports capacity without claiming an ETA", async () => {
		const coordinator = getAgentCoordinator()
		const limit = coordinator.maxConcurrency
		const queued = { kind: "agent" as const, state: "queued" as const }
		coordinator.setMaxConcurrency(1)
		const permit = await coordinator.acquire({})
		try {
			expect(taskSchedulingStatus(queued)).toEqual({ queueReason: "capacity", capacity: { active: 1, limit: 1 } })
			permit.release()
			expect(taskSchedulingStatus(queued)).toEqual({ queueReason: "starting", capacity: { active: 0, limit: 1 } })
			expect(taskSchedulingStatus({ ...queued, state: "running" }).queueReason).toBeNull()
		} finally {
			permit.release()
			coordinator.setMaxConcurrency(limit)
		}
	})

	test("activity does not wake empty snapshots, survives bookkeeping, and fences late runs", async () => {
		await withTaskStorage("running", async paths => {
			const pending = readRetainedOutput(paths, { waitMs: 1_000 })
			await Bun.sleep(20)
			const lastActivity = { at: Date.now(), action: "thinking" }
			await writeTaskProgress(paths, runId, { lastActivity })
			expect(await Promise.race([pending, Bun.sleep(30).then(() => "waiting")])).toBe("waiting")
			await mutateTaskMetadata(paths, metadata => ({ ...metadata, updatedAt: Date.now() }))
			await writeTaskProgress(paths, "r_1111111111111111", { lastActivity: { at: Date.now(), action: "late" } })
			expect((await readRetainedOutput(paths)).lastActivity).toEqual(lastActivity)
			await mutateTaskMetadata(paths, metadata => ({ ...metadata, state: "idle", activeRun: null }))
			expect(await pending).toMatchObject({ timedOut: false, state: "idle", text: "", lastActivity })
			await writeTaskProgress(paths, runId, { lastActivity: { at: Date.now(), action: "late" } })
			expect((await readRetainedOutput(paths)).lastActivity).toEqual(lastActivity)
		})
	})
})

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
			for (const text of ["Inspect the change", "Looks good.", "Check tests too", "succeeded"]) expect(history).toContain(text)
			expect(history).not.toContain("�")
			expect(retainedPaths(paths)).toEqual({
				history: ".pi/lovely-agents/parent-session/a_0123abcd/history.md",
				session: ".pi/lovely-agents/parent-session/a_0123abcd/session.jsonl"
			})
			if (process.platform !== "win32") expect((await stat(paths.history)).mode & 0o077).toBe(0)
			expect((await readRetainedOutput(paths)).text).toBe("") // History is never parsed as the answer.
		})
	})
})

describe("latest reply snapshots", () => {
	test("persists Bash tail truncation through progress and settlement without reformatting the bounded tail", async () => {
		await withTaskStorage(
			"running",
			async paths => {
				const tail = "remaining 🙂 output\n"
				// While running, the tail comes from output.log; settlement stores it once in metadata.
				await writeFile(paths.output, tail)
				const running = await readRetainedOutput(paths)
				expect(running).toMatchObject({ truncated: false, streaming: true, totalLines: 1 })
				expect(running.text).toBe(`${tail}\n\n[Full output: ${running.paths.output}]`)
				await mutateTaskMetadata(paths, metadata => ({
					...metadata,
					state: "idle",
					activeRun: null,
					latestOutcome: "succeeded",
					latestReply: { text: tail, streaming: false, truncated: true }
				}))
				expect(await readRetainedOutput(paths)).toMatchObject({ truncated: true, streaming: false })
				for (const latestReply of [
					{ text: tail, streaming: false },
					{ text: tail, streaming: false, truncated: false }
				]) {
					await mutateTaskMetadata(paths, metadata => ({ ...metadata, latestReply }))
					const output = await readRetainedOutput(paths)
					expect(output.truncated).toBe(false)
					expect(output.text).toBe(`${tail}\n\n[Full output: ${output.paths.output}]`)
				}
				await expect(
					mutateTaskMetadata(
						paths,
						metadata =>
							({
								...metadata,
								latestReply: { text: tail, streaming: false, truncated: "true" }
							}) as unknown as TaskMetadata
					)
				).rejects.toThrow()
			},
			"bash"
		)
		await withTaskStorage("running", async paths => {
			await expect(
				writeTaskProgress(paths, runId, {
					latestReply: { text: "Agent v3 stays strict", streaming: true, truncated: true }
				})
			).rejects.toThrow()
		})
	})

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
			await writeTaskProgress(paths, runId, { effectiveSystemPrompt: "Old composed prompt" })
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				state: "queued",
				latestOutcome: "succeeded",
				lastRunSequence: 2,
				activeRun: { id: "r_1111111111111111", sequence: 2, kind: "followup", state: "queued", input: "New request", acceptedAt: 2 }
			}))
			await writeLatestReply(paths, runId, "Late old answer", false)
			await writeTaskProgress(paths, runId, { effectiveSystemPrompt: "Late old prompt" })
			expect(JSON.parse(await readFile(paths.metadata, "utf8"))).not.toHaveProperty("effectiveSystemPrompt")
			expect(await readRetainedOutput(paths)).toMatchObject({ text: "", state: "queued", latestOutcome: null })
			expect(await readRetainedOutput(paths, { run: 1 })).toMatchObject({
				run: 1,
				text: "Old answer",
				state: "idle",
				latestOutcome: "succeeded"
			})
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				state: "idle",
				activeRun: null,
				latestOutcome: "stopped",
				progress: "Later run"
			}))
			expect(await readRetainedOutput(paths)).toMatchObject({ run: 2, text: "", latestOutcome: "stopped" })
			expect(await readRetainedOutput(paths, { run: 1 })).toMatchObject({ run: 1, text: "Old answer", latestOutcome: "succeeded" })
			expect(await readRetainedOutput(paths, { run: 1 })).not.toHaveProperty("progress")
			await expect(readRetainedOutput(paths, { run: 3 })).rejects.toThrow("No retained result")
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
			expect(lines.totalLines).toBe(2_001)
		})
	})

	test("waits for run completion despite partial replies and assistant-message completion", async () => {
		await withTaskStorage("running", async paths => {
			await writeLatestReply(paths, runId, "one", true)
			const pending = readRetainedOutput(paths, { waitMs: 1_000 })
			await Bun.sleep(20)
			await writeLatestReply(paths, runId, "two", true)
			expect(await Promise.race([pending, Bun.sleep(30).then(() => "waiting")])).toBe("waiting")
			await writeLatestReply(paths, runId, "two", false)
			expect(await Promise.race([pending, Bun.sleep(30).then(() => "waiting")])).toBe("waiting")
			await mutateTaskMetadata(paths, metadata => ({ ...metadata, state: "idle", latestOutcome: "succeeded", activeRun: null }))
			expect(await pending).toMatchObject({ text: "two", state: "idle", latestOutcome: "succeeded", timedOut: false })
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

	test("returns the latest partial snapshot on timeout despite ongoing activity", async () => {
		await withTaskStorage("running", async paths => {
			const pending = readRetainedOutput(paths, { waitMs: 100 })
			await Bun.sleep(20)
			await writeTaskProgress(paths, runId, {
				lastActivity: { at: Date.now(), action: "thinking" },
				latestReply: { text: "partial", streaming: true }
			})
			expect(await pending).toMatchObject({ state: "running", text: "partial", streaming: true, timedOut: true })
		})
	})

	test("does not chase a newer Follow-up when the observed run has ended", async () => {
		await withTaskStorage("running", async paths => {
			await writeLatestReply(paths, runId, "Run A's answer", false)
			const pending = readRetainedOutput(paths, { waitMs: 1_000 })
			await Bun.sleep(20)
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				state: "queued",
				latestOutcome: "succeeded",
				lastRunSequence: 2,
				activeRun: { id: "r_1111111111111111", sequence: 2, kind: "followup", state: "queued", input: "Next", acceptedAt: 2 }
			}))
			expect(await pending).toMatchObject({ run: 1, text: "Run A's answer", state: "idle", latestOutcome: "succeeded", timedOut: false })
			expect(await readRetainedOutput(paths)).toMatchObject({ run: 2, text: "", state: "queued", latestOutcome: null })
		})
	})

	test("discard preserves run reads but fences later reply writes", async () => {
		await withTaskStorage("running", async paths => {
			await writeLatestReply(paths, runId, "Retained answer", false)
			const pending = readRetainedOutput(paths, { waitMs: 1_000 })
			await Bun.sleep(20)
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				state: "idle",
				activeRun: null,
				latestOutcome: "stopped",
				discardedAt: 2
			}))
			expect(await pending).toMatchObject({ run: 1, text: "Retained answer", latestOutcome: "stopped" })
			await writeLatestReply(paths, runId, "late", false)
			expect(await readRetainedOutput(paths, { run: 1 })).toMatchObject({ text: "Retained answer" })
			expect(JSON.parse(await readFile(paths.metadata, "utf8")).latestReply.text).toBe("Retained answer")
		})
	})

	test("short Bash reads keep the newest lines, UTF-8, status and the full log path", async () => {
		await withTaskStorage(
			"running",
			async paths => {
				await writeFile(paths.output, "old\nmiddle\nfinal 🙂\n")
				const short = await readRetainedOutput(paths, { lines: 1 })
				expect(short).toMatchObject({ run: 1, truncated: true, streaming: true, state: "running" })
				expect(short.text).toStartWith("final 🙂")
				expect(short.text).not.toContain("middle")
				expect(short.text).toContain("output.log")
				await writeFile(paths.output, `${"🙂".repeat(20_000)}END`)
				const longLine = await readRetainedOutput(paths, { lines: 1 })
				expect(longLine.text).toContain("END")
				expect(longLine.text).not.toContain("�")
			},
			"bash"
		)
		await withTaskStorage("running", async paths => {
			await expect(readRetainedOutput(paths, { lines: 2 })).rejects.toThrow("Bash")
		})
	})
})

async function withTaskStorage(
	state: "idle" | "running",
	run: (paths: TaskStoragePaths) => Promise<void>,
	kind: TaskMetadata["kind"] = "agent"
): Promise<void> {
	await withTempWorkspace(async workspace => {
		const paths = await reserveTaskStorage(
			await ensureParentStorage(workspace.cwd, "parent-session"),
			() => `${kind === "bash" ? "b" : "a"}_0123abcd`
		)
		await initializeRetainedLogs(paths)
		const metadata: TaskMetadata = {
			version: TASK_METADATA_VERSION,
			...(kind === "bash"
				? {
						kind,
						command: "printf output",
						cwd: workspace.cwd,
						exitCode: null,
						signal: null
					}
				: {
						kind,
						childSessionId: "child-session",
						definitionName: "reviewer",
						model: { provider: "anthropic", id: "sonnet" },
						thinking: "high" as const,
						depth: 1,
						allowAgents: false,
						sessionConfig: {
							systemPrompt: "Review work.",
							tools: null,
							excludeAgentsMd: false,
							scopedModels: [{ provider: "anthropic", id: "sonnet" }]
						}
					}),
			taskRef: paths.taskRef,
			parentSessionId: paths.parentSessionId,
			label: "Review change",
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
