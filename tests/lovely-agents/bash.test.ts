import { describe, expect, spyOn, test } from "bun:test"
import { type FileHandle, mkdir, readdir, readFile, rm, symlink, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import type { TSchema } from "typebox"
import { Value } from "typebox/value"
import { type BashCreationResult, type BashToolInput, registerBashTool } from "../../extensions/lovely-agents/bash.js"
import { type AgentsConfig, defaultAgentsConfig } from "../../extensions/lovely-agents/config.js"
import { getAgentCoordinator, getBashCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import { discardTask, reconcileParentTasks, stopOwnedTaskTree, stopTask } from "../../extensions/lovely-agents/lifecycle.js"
import {
	deliverTaskNotifications,
	notificationRouteKey,
	observeNotification,
	reconcileParentNotifications
} from "../../extensions/lovely-agents/notifications.js"
import * as taskState from "../../extensions/lovely-agents/state.js"
import {
	type BashTaskMetadata,
	parentStoragePaths,
	readOutputTail,
	readRetainedOutput,
	readTaskMetadata,
	releaseParentLeaseFor,
	type TaskStoragePaths,
	taskStoragePaths,
	writeTaskProgress
} from "../../extensions/lovely-agents/state.js"
import { buildTaskOutputToolResult, registerTaskTools } from "../../extensions/lovely-agents/tools.js"
import { type TempWorkspace, withTempWorkspace } from "./test-helpers.js"

const parentId = "bash-parent"
type CapturedTool = ToolDefinition<TSchema, BashCreationResult>
type MutableConfig = { -readonly [Key in keyof AgentsConfig]: AgentsConfig[Key] }

function capture(config: AgentsConfig): CapturedTool {
	let captured: CapturedTool | undefined
	registerBashTool(
		{
			registerTool(tool: CapturedTool) {
				expect(tool.name).toBe("bash_bg")
				captured = tool
			}
		} as unknown as ExtensionAPI,
		{ getConfig: () => config }
	)
	if (!captured) throw new Error("Tool was not registered")
	return captured
}

async function fixture(run: (workspace: TempWorkspace, tool: CapturedTool, config: MutableConfig) => Promise<void>): Promise<void> {
	await withTempWorkspace(async workspace => {
		const config: MutableConfig = { ...defaultAgentsConfig, backgroundBash: true, maxBashConcurrency: 2 }
		try {
			await run(workspace, capture(config), config)
		} finally {
			await stopOwnedTaskTree(workspace.cwd, parentId)
			await releaseParentLeaseFor(workspace.cwd, parentId)
			getBashCoordinator().setMaxConcurrency(4)
		}
	})
}

function execute(tool: CapturedTool, cwd: string, input: BashToolInput, signal?: AbortSignal) {
	return tool.execute("bash-call", input, signal, undefined, {
		cwd,
		sessionManager: { getSessionId: () => parentId }
	} as ExtensionContext)
}

function pathsFor(cwd: string, id: string): TaskStoragePaths {
	return taskStoragePaths(parentStoragePaths(cwd, parentId), id)
}

async function metadata(paths: TaskStoragePaths): Promise<BashTaskMetadata> {
	const loaded = await readTaskMetadata(paths)
	if (loaded.status !== "ok" || loaded.metadata.kind !== "bash") throw new Error(`Invalid Bash metadata: ${JSON.stringify(loaded)}`)
	return loaded.metadata
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for Bash task")
		await Bun.sleep(5)
	}
}

async function finished(paths: TaskStoragePaths): Promise<BashTaskMetadata> {
	await until(async () => (await metadata(paths)).state === "idle" && !getAgentCoordinator().getResident(paths.taskDirectory))
	return metadata(paths)
}

function runtime(paths: TaskStoragePaths) {
	const resident = getAgentCoordinator().getResident(paths.taskDirectory)
	if (!resident?.input) throw new Error("Missing Bash resident")
	return resident as typeof resident & {
		input: NonNullable<typeof resident.input>
		log: FileHandle
		flushProgress(streaming: boolean): Promise<void>
	}
}

describe("bash_bg real processes", () => {
	test("task_output waits through startup, unrelated capacity changes, and partial output until exit", async () => {
		await fixture(async (workspace, tool) => {
			let outputTool: ToolDefinition | undefined
			registerTaskTools({
				registerTool(tool: ToolDefinition) {
					if (tool.name === "task_output") outputTool = tool
				},
				on() {}
			} as unknown as ExtensionAPI)
			if (!outputTool) throw new Error("Missing task_output")
			const created = await execute(tool, workspace.cwd, {
				command: "read -r first; printf 'partial\\n'; read -r second; printf 'final\\n'",
				label: "Wait for exit"
			})
			const paths = pathsFor(workspace.cwd, created.details.id)
			const pending = outputTool.execute("output-call", { id: created.details.id, waitMs: 5_000 }, undefined, undefined, {
				cwd: workspace.cwd,
				sessionManager: { getSessionId: () => parentId }
			} as ExtensionContext)
			await until(async () => (await metadata(paths)).state === "running")
			await execute(tool, workspace.cwd, { command: "sleep 0.05", label: "Unrelated task", waitMs: 1_000 })
			expect(await Promise.race([pending, Bun.sleep(30).then(() => "waiting")])).toBe("waiting")
			await runtime(paths).input("first\n", "stdin")
			await until(async () => (await readOutputTail(paths.output)).text === "partial\n")
			expect(await Promise.race([pending, Bun.sleep(30).then(() => "waiting")])).toBe("waiting")
			await runtime(paths).input("second\n", "stdin", { eof: true })
			expect((await pending).details).toMatchObject({
				state: "idle",
				latestOutcome: "succeeded",
				exitCode: 0,
				timedOut: false,
				text: expect.stringContaining("partial\nfinal\n")
			})
		})
	})

	test("success retains both streams and one run, without a fabricated agent session or synchronous notice", async () => {
		await fixture(async (workspace, tool) => {
			const result = await execute(tool, workspace.cwd, {
				command: "printf 'hello\\n'; printf 'error stream\\n' >&2",
				label: " Shell ",
				waitMs: 2_000
			})
			expect(result.details).toMatchObject({
				label: "Shell",
				state: "idle",
				latestOutcome: "succeeded",
				exitCode: 0,
				signal: null,
				detached: false
			})
			expect(result.details.id).toMatch(/^b_[0-9a-f]{8}$/)
			const paths = pathsFor(workspace.cwd, result.details.id)
			const saved = await finished(paths)
			expect(saved).toMatchObject({ kind: "bash", lastRunSequence: 1, activeRun: null, queuedFollowUps: [], notifications: [] })
			expect(saved).not.toHaveProperty("model")
			expect(saved).not.toHaveProperty("childSessionId")
			expect(await readdir(paths.taskDirectory)).not.toContain("session.jsonl")
			expect((await readFile(paths.output, "utf8")).split("\n").sort()).toEqual(["", "error stream", "hello"])
			expect(result.details.output.text).toContain("hello\n")
			expect(result.details.output.text).toContain("error stream\n")
			expect(await readFile(paths.history, "utf8")).toContain("Bash exited with code 0")
		})
	})

	test("shell exit settles the task even when a leftover job holds the pipes open", async () => {
		await fixture(async (workspace, tool) => {
			const result = await execute(tool, workspace.cwd, { command: "sleep 30 & echo done", label: "leftover", waitMs: 5_000 })
			expect(result.details).toMatchObject({ state: "idle", latestOutcome: "succeeded", exitCode: 0, detached: false })
			expect(result.details.output.text).toContain("done\n")
		})
	})

	test("nonzero exit and missing Bash executable are retained failures, not tool errors", async () => {
		await fixture(async (workspace, tool) => {
			const failed = await execute(tool, workspace.cwd, { command: "printf 'bad' >&2; exit 7", label: "Failure", waitMs: 2_000 })
			expect(failed.details).toMatchObject({ latestOutcome: "failed", exitCode: 7, detached: false })
			expect(await readFile(pathsFor(workspace.cwd, failed.details.id).history, "utf8")).toContain("Bash exited with code 7")
			const terminated = await execute(tool, workspace.cwd, { command: "kill -TERM $$", label: "Signal", waitMs: 2_000 })
			expect(terminated.details).toMatchObject({ latestOutcome: "failed", exitCode: null, signal: "SIGTERM" })
			const pathVariable = "PATH"
			const originalPath = process.env[pathVariable]
			try {
				process.env[pathVariable] = workspace.cwd
				const missing = await execute(tool, workspace.cwd, { command: ":", label: "Missing executable", waitMs: 2_000 })
				expect(missing.details).toMatchObject({ latestOutcome: "failed", exitCode: null, signal: null, detached: false })
				expect(missing.details.output.text).toMatch(/ENOENT|not found/)
				expect((await metadata(pathsFor(workspace.cwd, missing.details.id))).notifications).toEqual([])
			} finally {
				if (originalPath === undefined) delete process.env[pathVariable]
				else process.env[pathVariable] = originalPath
			}
		})
	})

	test("inherits env and resolves cwd without interpreting or templating the command", async () => {
		await fixture(async (workspace, tool) => {
			await mkdir(join(workspace.cwd, "sub"))
			const command = "printf '%s\\n' \"$PWD\" \"$HOME\" '/skill:not-expanded' '{{literal}}'"
			const result = await execute(tool, workspace.cwd, { command, label: "Environment", cwd: "sub", waitMs: 2_000 })
			const paths = pathsFor(workspace.cwd, result.details.id)
			const { HOME } = process.env
			expect(await readFile(paths.output, "utf8")).toBe(`${join(workspace.cwd, "sub")}\n${HOME}\n/skill:not-expanded\n{{literal}}\n`)
			expect(await metadata(paths)).toMatchObject({ command, cwd: join(workspace.cwd, "sub") })
		})
	})

	test("disabled backgroundBash and invalid arguments create no task storage", async () => {
		await fixture(async (workspace, tool, config) => {
			config.backgroundBash = false
			await expect(execute(tool, workspace.cwd, { command: "touch should-not-exist", label: "Disabled" })).rejects.toThrow("backgroundBash")
			config.backgroundBash = true
			await expect(execute(tool, workspace.cwd, { command: ":", label: "Bad cwd", cwd: "absent" })).rejects.toThrow()
			await workspace.write("workspace/file", "not a directory")
			await expect(execute(tool, workspace.cwd, { command: ":", label: "Bad cwd", cwd: "file" })).rejects.toThrow("not a directory")
			expect(Value.Check(tool.parameters, { command: ":", label: "x", waitMs: 0 })).toBe(true)
			expect(Value.Check(tool.parameters, { command: ":", label: "x", waitMs: 0.1 })).toBe(false)
			expect(Value.Check(tool.parameters, { command: ":", label: "x", timeout: 1 })).toBe(false)
			expect(await readdir(workspace.cwd)).toEqual(["file"])
		})
	})

	test("split and large UTF-8 output keeps a bounded codepoint-safe tail and full disk output", async () => {
		await fixture(async (workspace, tool) => {
			const result = await execute(tool, workspace.cwd, {
				command: "printf '\\360\\237'; sleep 0.02; printf '\\230\\200\\n'; for ((i=0;i<12000;i++)); do printf '中文😀%s\\n' \"$i\"; done",
				label: "UTF8",
				waitMs: 4_000
			})
			const paths = pathsFor(workspace.cwd, result.details.id)
			const saved = await finished(paths)
			const full = await readFile(paths.output, "utf8")
			expect(full).toStartWith("😀\n")
			expect(full).toEndWith("中文😀11999\n")
			expect(full).not.toContain("\ufffd")
			expect(Buffer.byteLength(full)).toBeGreaterThan(100_000)
			expect(Buffer.byteLength(saved.latestReply?.text ?? "")).toBeLessThanOrEqual(50 * 1024)
			expect(saved.latestReply?.text.split("\n").length).toBeLessThanOrEqual(2_000)
			expect(saved.latestReply?.text).toEndWith("中文😀11999\n")
			expect(saved.latestReply?.text).not.toContain("\ufffd")
			expect(saved.latestReply?.truncated).toBe(true)
			expect(result.details.output.truncated).toBe(true)
			const output = buildTaskOutputToolResult(paths.taskRef, await readRetainedOutput(paths))
			expect(output.details.truncated).toBe(true)
			expect(output.details.paths.output).toEndWith(`${paths.taskRef}/output.log`)
			expect(output.content[0].text).toContain("Output truncated; showing tail.")
			expect(output.content[0].text).toContain(output.details.paths.output ?? "missing output path")
			expect((await readFile(paths.metadata)).length).toBeLessThan(60 * 1024)
			const longLine = await execute(tool, workspace.cwd, {
				command: "for ((i=0;i<30000;i++)); do printf '😀'; done",
				label: "Long line",
				waitMs: 4_000
			})
			const longTail = (await metadata(pathsFor(workspace.cwd, longLine.details.id))).latestReply?.text ?? ""
			expect(Buffer.byteLength(longTail)).toBeLessThanOrEqual(50 * 1024)
			expect(longTail).not.toContain("\ufffd")
		})
	})

	test("stdin is literal, backpressured, single-EOF, and never restarts a completed command", async () => {
		await fixture(async (workspace, tool) => {
			const result = await execute(tool, workspace.cwd, { command: "sleep 0.05; cat", label: "Stdin" })
			const paths = pathsFor(workspace.cwd, result.details.id)
			await until(async () => (await metadata(paths)).state === "running")
			const resident = runtime(paths)
			await expect(resident.input("ignored", "followup")).rejects.toThrow("stdin only")
			const content = `  /skill:literal\r\n${"😀".repeat(15000)}\r\n\n`
			expect(await resident.input(content, "stdin")).toEqual({ run: 1, delivery: "stdin", queuePosition: null, queuedFollowUps: 0 })
			await resident.input("", "stdin", { eof: true })
			await expect(resident.input("late", "stdin")).rejects.toThrow("unavailable")
			const saved = await finished(paths)
			expect(saved.latestOutcome).toBe("succeeded")
			expect(saved.lastRunSequence).toBe(1)
			expect(saved.notifications).toHaveLength(1)
			expect(await readFile(paths.output, "utf8")).toBe(content)
			const history = await readFile(paths.history, "utf8")
			expect(history.split(`<stdin>\n${content}`).length - 1).toBe(1)
			expect(history.split("<stdin>\n").length - 1).toBe(2)
			expect(history.split("<stdin EOF>\n").length - 1).toBe(1)
			expect(history.indexOf("<stdin EOF>")).toBeLessThan(history.indexOf("<outcome succeeded>"))
			expect(history).not.toContain("ignored")
			expect(history).not.toContain("late")
			await expect(resident.input("", "stdin", { eof: true })).rejects.toThrow("unavailable")
		})
	})

	test("truncation remains sticky when later output replaces the large tail with short lines", async () => {
		await fixture(async (workspace, tool) => {
			const result = await execute(tool, workspace.cwd, {
				command: "for ((i=0;i<20000;i++)); do printf '😀'; done; cat",
				label: "Sticky truncation"
			})
			const paths = pathsFor(workspace.cwd, result.details.id)
			await until(async () => (await readOutputTail(paths.output)).truncated)
			await runtime(paths).input("\n".repeat(2100), "stdin", { eof: true })
			const saved = await finished(paths)
			expect(saved.latestReply?.truncated).toBe(true)
			expect(Buffer.byteLength(saved.latestReply?.text ?? "")).toBeLessThan(3_000)
			expect((await readRetainedOutput(paths)).truncated).toBe(true)
			expect((await readFile(paths.output)).length).toBe(82_100)
		})
	})

	test("successful cancelled stdin is logged once, and settlement waits for the retained input lane", async () => {
		await fixture(async (workspace, tool) => {
			const result = await execute(tool, workspace.cwd, { command: "cat", label: "Input lane" })
			const paths = pathsFor(workspace.cwd, result.details.id)
			await until(async () => (await metadata(paths)).state === "running")
			const resident = runtime(paths)
			let delivered = false
			let release = () => {}
			const gate = new Promise<void>(resolve => {
				release = resolve
			})
			const original = taskState.appendHistoryLog
			const historySpy = spyOn(taskState, "appendHistoryLog").mockImplementation(async (target, entry) => {
				if (target.taskDirectory === paths.taskDirectory && entry.type === "stdin") {
					delivered = true
					await gate
				}
				return original(target, entry)
			})
			const abort = new AbortController()
			const content = "  /skill:literal\r\n  keep trailing spaces  \n\n"
			const pending = resident.input(content, "stdin", { eof: true, signal: abort.signal })
			void pending.catch(() => {})
			try {
				await until(() => delivered)
				abort.abort()
				await expect(pending).rejects.toThrow("cancelled")
				await Bun.sleep(30)
				expect((await metadata(paths)).activeRun).not.toBeNull()
				expect(getAgentCoordinator().getResident(paths.taskDirectory)).toBe(resident)
				release()
				await finished(paths)
				expect(await readFile(paths.output, "utf8")).toBe(content)
				const history = await readFile(paths.history, "utf8")
				expect(history.split("<stdin>\n").length - 1).toBe(1)
				expect(history.split("<stdin EOF>").length - 1).toBe(1)
				expect(history.indexOf("<stdin EOF>")).toBeLessThan(history.indexOf("<outcome succeeded>"))
				const stdinCalls = historySpy.mock.calls.filter(([, entry]) => entry.type === "stdin")
				expect(stdinCalls).toHaveLength(1)
				expect(stdinCalls[0]?.[1]).toMatchObject({ type: "stdin", content, eof: true })
			} finally {
				release()
				await resident.stop()
				historySpy.mockRestore()
			}
		})
	})

	test("stdin history I/O failure still retains failed metadata and kills the waiting process", async () => {
		await fixture(async (workspace, tool) => {
			const result = await execute(tool, workspace.cwd, { command: "cat", label: "History failure" })
			const paths = pathsFor(workspace.cwd, result.details.id)
			await until(async () => (await metadata(paths)).state === "running")
			const resident = runtime(paths)
			await unlink(paths.history)
			await mkdir(paths.history)
			await expect(resident.input("delivered but not logged", "stdin")).rejects.toThrow("not a regular file")
			const saved = await finished(paths)
			expect(saved.latestOutcome).toBe("failed")
			expect(saved.latestReply?.text).toContain("Retained log is not a regular file")
			expect(saved.notifications).toHaveLength(1)
			expect(resident.log.fd).toBe(-1)
			expect(getBashCoordinator().activeCount).toBe(0)
		})
	})

	test("fsync and close failures settle as failed while cleanup and metadata remain available", async () => {
		await fixture(async (workspace, tool) => {
			for (const operation of ["sync", "close"] as const) {
				const result = await execute(tool, workspace.cwd, { command: "cat", label: `${operation} failure` })
				const paths = pathsFor(workspace.cwd, result.details.id)
				await until(async () => (await metadata(paths)).state === "running")
				const resident = runtime(paths)
				const failure = spyOn(resident.log, operation).mockRejectedValueOnce(new Error(`${operation} I/O failed`))
				try {
					await resident.input("output\n", "stdin", { eof: true })
					const saved = await finished(paths)
					expect(saved.latestOutcome).toBe("failed")
					expect(saved.latestReply?.text).toContain(`${operation} I/O failed`)
					expect(saved.latestReply?.streaming).toBe(false)
					expect(saved.notifications).toHaveLength(1)
					expect(resident.log.fd).toBe(-1)
					expect(getBashCoordinator().activeCount).toBe(0)
				} finally {
					failure.mockRestore()
				}
			}
		})
	})

	test("a repeatedly failing close stays resident and reachable for explicit cleanup retry", async () => {
		await fixture(async (workspace, tool) => {
			const result = await execute(tool, workspace.cwd, { command: "cat", label: "Retry cleanup" })
			const paths = pathsFor(workspace.cwd, result.details.id)
			await until(async () => (await metadata(paths)).state === "running")
			const resident = runtime(paths)
			const close = spyOn(resident.log, "close").mockRejectedValue(new Error("output close failed"))
			try {
				await resident.input("done", "stdin", { eof: true })
				await until(async () => (await metadata(paths)).state === "idle" && getBashCoordinator().activeCount === 0)
				expect((await metadata(paths)).latestOutcome).toBe("failed")
				expect(getAgentCoordinator().getResident(paths.taskDirectory)).toBe(resident)
				expect(resident.log.fd).toBeGreaterThanOrEqual(0)
			} finally {
				close.mockRestore()
			}
			await expect(resident.stop()).rejects.toThrow("output close failed")
			expect(resident.log.fd).toBe(-1)
			expect(getAgentCoordinator().getResident(paths.taskDirectory)).toBeUndefined()
			await discardTask(paths)
			expect((await metadata(paths)).latestOutcome).toBe("failed")
		})
	})

	test("separate FIFO Bash permits ignore agent saturation; queued stdin and stop are explicit", async () => {
		await fixture(async (workspace, tool, config) => {
			config.maxBashConcurrency = 1
			const agents = getAgentCoordinator()
			const previousLimit = agents.maxConcurrency
			agents.setMaxConcurrency(1)
			const agentPermit = await agents.acquire({})
			try {
				const first = await execute(tool, workspace.cwd, { command: "cat", label: "First" })
				const firstPaths = pathsFor(workspace.cwd, first.details.id)
				await until(async () => (await metadata(firstPaths)).state === "running")
				const second = await execute(tool, workspace.cwd, { command: "printf second", label: "Second" })
				const third = await execute(tool, workspace.cwd, { command: "touch forbidden", label: "Stopped in queue" })
				const secondPaths = pathsFor(workspace.cwd, second.details.id)
				const thirdPaths = pathsFor(workspace.cwd, third.details.id)
				expect((await metadata(secondPaths)).state).toBe("queued")
				expect(getBashCoordinator().activeCount).toBe(1)
				await expect(runtime(secondPaths).input("queued", "stdin")).rejects.toThrow("queued")
				await stopTask(thirdPaths)
				expect((await finished(thirdPaths)).latestOutcome).toBe("stopped")
				await runtime(firstPaths).input("", "stdin", { eof: true })
				expect((await finished(secondPaths)).latestOutcome).toBe("succeeded")
				await finished(firstPaths)
				expect(await readdir(workspace.cwd)).not.toContain("forbidden")
				expect(agents.activeCount).toBe(1)
				expect(getBashCoordinator().activeCount).toBe(0)
			} finally {
				agentPermit.release()
				agents.setMaxConcurrency(previousLimit)
			}
		})
	})

	test("cancellation before detachment stops accepted work; after detachment it no longer owns work", async () => {
		await fixture(async (workspace, tool) => {
			const abort = new AbortController()
			const pending = execute(
				tool,
				workspace.cwd,
				{ command: "printf ready; sleep 30; touch forbidden", label: "Cancel", waitMs: 5_000 },
				abort.signal
			)
			void pending.catch(() => {})
			const parent = parentStoragePaths(workspace.cwd, parentId)
			let id = ""
			await until(async () => {
				const entries = await readdir(parent.parentDirectory).catch(() => [])
				id = entries.find(entry => entry.startsWith("b_")) ?? ""
				if (!id) return false
				return (await readOutputTail(pathsFor(workspace.cwd, id).output).catch(() => ({ text: "" }))).text.includes("ready")
			})
			abort.abort(new Error("Parent cancelled"))
			await expect(pending).rejects.toThrow("Parent cancelled")
			expect((await finished(pathsFor(workspace.cwd, id))).latestOutcome).toBe("stopped")
			expect((await metadata(pathsFor(workspace.cwd, id))).notifications).toEqual([])
			const detachedAbort = new AbortController()
			const detached = await execute(
				tool,
				workspace.cwd,
				{ command: "sleep 0.05; printf survived", label: "Detached" },
				detachedAbort.signal
			)
			detachedAbort.abort()
			const saved = await finished(pathsFor(workspace.cwd, detached.details.id))
			expect(saved.latestOutcome).toBe("succeeded")
			expect(saved.notifications).toHaveLength(1)
		})
	})

	test("timed detachment preserves the same command, and reload reuses the main resident", async () => {
		await fixture(async (workspace, tool, config) => {
			const result = await execute(tool, workspace.cwd, { command: "printf x >> starts; cat", label: "Reload", waitMs: 20 })
			expect(result.details.detached).toBe(true)
			const paths = pathsFor(workspace.cwd, result.details.id)
			const resident = runtime(paths)
			const run = (await metadata(paths)).activeRun
			capture(config)
			expect(getAgentCoordinator().getResident(paths.taskDirectory)).toBe(resident)
			expect((await reconcileParentTasks(workspace.cwd, parentId)).interrupted).toBe(0)
			await resident.input("finished", "stdin", { eof: true })
			const saved = await finished(paths)
			expect(saved.notifications[0]?.runId).toBe(run?.id)
			expect(await readFile(join(workspace.cwd, "starts"), "utf8")).toBe("x")
		})
	})

	test("fast completion versus detachment creates exactly the matching notification", async () => {
		await fixture(async (workspace, tool) => {
			for (const waitMs of [0, 1, 5, 50, 1000]) {
				const result = await execute(tool, workspace.cwd, { command: "printf done", label: "Race", waitMs })
				const saved = await finished(pathsFor(workspace.cwd, result.details.id))
				expect(saved.latestOutcome).toBe("succeeded")
				expect(saved.notifications).toHaveLength(result.details.detached ? 1 : 0)
				expect(saved.lastRunSequence).toBe(1)
			}
		})
	})

	test("aborted stdin cannot replay data, and stopping a backpressured write closes it before archival", async () => {
		await fixture(async (workspace, tool) => {
			const result = await execute(tool, workspace.cwd, { command: "sleep 30", label: "Backpressure" })
			const paths = pathsFor(workspace.cwd, result.details.id)
			await until(async () => (await metadata(paths)).state === "running")
			const resident = runtime(paths)
			await expect(resident.input("x".repeat(65537), "stdin")).rejects.toThrow("64 KiB")
			await expect(resident.input("cancelled", "stdin", { signal: AbortSignal.abort() })).rejects.toThrow()
			let writesFinished = false
			const writes = (async () => {
				for (let i = 0; i < 100; i++) await resident.input("x".repeat(65536), "stdin")
				writesFinished = true
			})()
			void writes.catch(() => {})
			await Bun.sleep(30)
			expect(writesFinished).toBe(false)
			await discardTask(paths)
			await expect(writes).rejects.toThrow()
			expect((await metadata(paths)).latestOutcome).toBe("stopped")
		})
	})

	test("synchronous OS-process exit kills live groups; startup interrupts rather than respawning", async () => {
		await fixture(async workspace => {
			const modulePath = new URL("../../extensions/lovely-agents/bash.ts", import.meta.url).href
			const script = `
				const { registerBashTool } = await import(${JSON.stringify(modulePath)});
				let tool;
				registerBashTool({ registerTool(value) { tool = value } }, {
					getConfig: () => ({ backgroundBash: true, maxBashConcurrency: 1 })
				});
				const result = await tool.execute("exit-test",
					{ command: "printf started; sleep 0.3; touch leaked", label: "Exit cleanup", waitMs: 30 },
					undefined, undefined, { cwd: ${JSON.stringify(workspace.cwd)}, sessionManager: { getSessionId: () => ${JSON.stringify(parentId)} } });
				console.log(result.details.id);
				process.exit(0);
			`
			const preloads = process.execArgv.flatMap((arg, index) => (arg === "--preload" ? process.execArgv.slice(index, index + 2) : []))
			const child = Bun.spawn([process.execPath, ...preloads, "-e", script], { stdout: "pipe", stderr: "pipe" })
			const output = await new Response(child.stdout).text()
			const errors = await new Response(child.stderr).text()
			expect(await child.exited, errors).toBe(0)
			const id = output.trim()
			expect(id).toMatch(/^b_[0-9a-f]{8}$/)
			await Bun.sleep(350)
			expect(await readdir(workspace.cwd)).not.toContain("leaked")
			const paths = pathsFor(workspace.cwd, id)
			expect((await reconcileParentTasks(workspace.cwd, parentId)).interrupted).toBe(1)
			const saved = await metadata(paths)
			expect(saved.latestOutcome).toBe("interrupted")
			expect(saved.activeRun).toBeNull()
			expect(saved.notifications).toHaveLength(1)
			expect(getAgentCoordinator().getResident(paths.taskDirectory)).toBeUndefined()
		})
	})

	test("stop kills shell grandchildren; the log stops growing and late progress is fenced", async () => {
		await fixture(async (workspace, tool) => {
			const result = await execute(tool, workspace.cwd, {
				command: "trap '' TERM; (trap '' TERM; while :; do printf 'still-running\\n'; sleep 0.01; done) & echo $! > grandchild; wait",
				label: "Process group"
			})
			const paths = pathsFor(workspace.cwd, result.details.id)
			await until(async () => (await readOutputTail(paths.output)).text.includes("still-running"))
			const runId = (await metadata(paths)).activeRun?.id
			if (!runId) throw new Error("Missing live run")
			const pid = Number(await readFile(join(workspace.cwd, "grandchild"), "utf8"))
			await Promise.all([discardTask(paths), discardTask(paths)])
			const before = await readFile(paths.output)
			await Bun.sleep(80)
			expect(await readFile(paths.output)).toEqual(before)
			expect((await metadata(paths)).latestOutcome).toBe("stopped")
			expect((await metadata(paths)).notifications).toEqual([])
			const reply = (await metadata(paths)).latestReply
			await writeTaskProgress(paths, runId, { latestReply: { text: "late", streaming: true } })
			expect((await metadata(paths)).latestReply).toEqual(reply)
			expect(await readFile(paths.output)).toEqual(before)
			await discardTask(paths)
			if (process.platform === "linux") {
				const processState = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
				expect(processState === "" || processState.includes(") Z ")).toBe(true)
			}
		})
	})

	test("an already-open output handle never follows a replacement symlink", async () => {
		await fixture(async (workspace, tool) => {
			const result = await execute(tool, workspace.cwd, { command: "cat", label: "Safe log" })
			const paths = pathsFor(workspace.cwd, result.details.id)
			await until(async () => (await metadata(paths)).state === "running")
			const target = await workspace.write("workspace/target", "untouched")
			await unlink(paths.output)
			await symlink(target, paths.output)
			await runtime(paths).input("must not overwrite target", "stdin", { eof: true })
			await finished(paths)
			expect(await readFile(target, "utf8")).toBe("untouched")
			await rm(paths.output)
		})
	})

	test("semantic parent close stops only that parent's Bash groups", async () => {
		await fixture(async (workspace, tool) => {
			const owned = await execute(tool, workspace.cwd, { command: "cat", label: "Owned" })
			const foreign = await tool.execute("foreign", { command: "cat", label: "Other parent" }, undefined, undefined, {
				cwd: workspace.cwd,
				sessionManager: { getSessionId: () => "other-parent" }
			} as ExtensionContext)
			const foreignPaths = taskStoragePaths(parentStoragePaths(workspace.cwd, "other-parent"), foreign.details.id)
			try {
				await until(async () => (await metadata(foreignPaths)).state === "running")
				await stopOwnedTaskTree(workspace.cwd, parentId)
				expect((await metadata(pathsFor(workspace.cwd, owned.details.id))).latestOutcome).toBe("stopped")
				expect((await metadata(foreignPaths)).state).toBe("running")
				await runtime(foreignPaths).input("still alive", "stdin", { eof: true })
				expect((await finished(foreignPaths)).latestOutcome).toBe("succeeded")
			} finally {
				await stopTask(foreignPaths)
				await releaseParentLeaseFor(workspace.cwd, "other-parent")
			}
		})
	})

	test("detached completion outbox delivers once and acknowledges only exact-parent observation", async () => {
		await fixture(async (workspace, tool) => {
			const coordinator = getAgentCoordinator()
			const notices: string[] = []
			const unbind = coordinator.bindNotificationRoute(notificationRouteKey(workspace.cwd, parentId), notice => {
				notices.push(notice.id)
			})
			try {
				const result = await execute(tool, workspace.cwd, { command: "sleep 0.05; printf done", label: "Notify" })
				const paths = pathsFor(workspace.cwd, result.details.id)
				const saved = await finished(paths)
				expect(saved.notifications).toHaveLength(1)
				expect(notices).toEqual([saved.notifications[0]?.id ?? "missing"])
				const notification = saved.notifications[0]
				if (!notification) throw new Error("Missing notification")
				expect(notification.content).not.toContain("Model:")
				expect(notification.content).toContain("output.log")
				expect(notification.deliveredAt).toBeUndefined()
				await deliverTaskNotifications(paths)
				await reconcileParentNotifications(workspace.cwd, parentId, [])
				expect(notices).toHaveLength(1)
				await expect(observeNotification(workspace.cwd, "other-parent", paths.taskRef, notification.id)).rejects.toThrow()
				expect((await metadata(paths)).notifications[0]?.deliveredAt).toBeUndefined()
				await observeNotification(workspace.cwd, parentId, paths.taskRef, notification.id)
				expect((await metadata(paths)).notifications[0]?.deliveredAt).toBeNumber()
				await deliverTaskNotifications(paths)
				await stopTask(paths)
				expect(notices).toHaveLength(1)
			} finally {
				unbind()
			}
		})
	})

	test("compact rendering reserves the b_ ID and preserves the surrounding background", async () => {
		await fixture(async (_workspace, tool) => {
			const theme = { fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` }
			const context = { state: { taskRef: "b_12345678" }, expanded: false }
			if (!tool.renderCall) throw new Error("Missing call renderer")
			const component = tool.renderCall(
				{ command: "echo 中文😀".repeat(100), label: "Long label".repeat(20) },
				theme as Parameters<NonNullable<CapturedTool["renderCall"]>>[1],
				context as Parameters<NonNullable<CapturedTool["renderCall"]>>[2]
			)
			for (const width of [1, 10, 20, 40, 80]) {
				const lines = component.render(width)
				expect(lines).toHaveLength(1)
				expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width)
				expect(lines[0]).not.toContain("\x1b[0m")
				if (width >= 20) expect(lines[0]).toContain("b_12345678")
			}
		})
	})
})
