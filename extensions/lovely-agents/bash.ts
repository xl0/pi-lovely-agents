import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { type FileHandle, open, rm, stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { Readable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { type Static, Type } from "typebox"
import type { AgentsConfig } from "./config.js"
import {
	getAgentCoordinator,
	getBashCoordinator,
	type ResidentAgent,
	type ResidentInputOptions,
	type ResidentInputResult
} from "./coordinator.js"
import { appendTaskNotification, deliverTaskNotifications, prepareTaskNotification } from "./notifications.js"
import { renderExpandableResult } from "./rendering.js"
import {
	acquireParentLease,
	appendHistoryLog,
	type BashTaskMetadata,
	ensureParentStorage,
	initializeRetainedLogs,
	MAX_AGENT_INPUT_BYTES,
	MAX_AGENT_LABEL_BYTES,
	mutateTaskMetadata,
	RETAINED_OUTPUT_MAX_BYTES,
	RETAINED_OUTPUT_MAX_LINES,
	RETAINED_OUTPUT_MAX_WAIT_MS,
	readRetainedOutput,
	readTaskMetadata,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	type TaskStoragePaths,
	writeTaskMetadata,
	writeTaskProgress
} from "./state.js"

const BashParameters = Type.Object(
	{
		command: Type.String({ minLength: 1, description: "Literal bash -c command" }),
		label: Type.String({ minLength: 1, description: "Short task label" }),
		cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory, relative to the workspace or absolute" })),
		waitMs: Type.Optional(
			Type.Integer({ minimum: 0, maximum: RETAINED_OUTPUT_MAX_WAIT_MS, description: "Wait before detaching; default 0" })
		)
	},
	{ additionalProperties: false }
)

export type BashToolInput = Static<typeof BashParameters>
export type BashCreationResult = {
	id: string
	run: number
	label: string
	state: BashTaskMetadata["state"]
	latestOutcome: BashTaskMetadata["latestOutcome"]
	exitCode: number | null
	signal: string | null
	detached: boolean
	output: Awaited<ReturnType<typeof readRetainedOutput>>
}

export function registerBashTool(pi: ExtensionAPI, options: { getConfig: () => AgentsConfig }): void {
	pi.registerTool({
		name: "bash_bg",
		label: "Background Bash",
		description:
			"Run a literal Bash command as a durable b_ task. Defaults to immediate background execution; waitMs optionally waits without restarting. Output tail is capped at 2000 lines/50 KiB; full stdout/stderr stays in output.log.",
		promptSnippet: "Run a background Bash command with durable output and task controls",
		promptGuidelines: [
			"Use bash_bg for background shell work, not as a replacement for normal bash. Use task_list/task_output/task_stop/task_discard with its b_ ID.",
			"Detached bash_bg tasks automatically notify you on success or failure and wake an idle parent; do not poll for completion. Synchronous completion and explicit stops do not notify.",
			"Use task_input on a running bash_bg task for literal stdin, optionally eof:true to close stdin; agent Follow-up/Steer modes are not supported. Commands never restart automatically."
		],
		parameters: BashParameters,
		renderCall(args, theme, context) {
			return {
				render(width) {
					const header = `${theme.fg("toolTitle", theme.bold("bash_bg"))}${args.label ? ` ${theme.fg("dim", `label=${JSON.stringify(args.label)}`)}` : ""}`
					const suffix = context.state.taskRef ? `${theme.fg("muted", " -> ")}${theme.fg("accent", context.state.taskRef)}` : ""
					if (context.expanded) {
						return new Text(`${header}${suffix}\n${args.command ?? ""}`, 0, 0).render(width)
					}
					const available = Math.max(0, width - visibleWidth(suffix))
					const preview = `${header}${args.command ? ` ${theme.fg("muted", JSON.stringify(args.command.replace(/\s+/g, " ").trim()))}` : ""}`
					// Full resets from Pi's truncation must not erase the surrounding tool background.
					return [truncateToWidth(truncateToWidth(preview, available) + suffix, width).replaceAll("\x1b[0m", "\x1b[22;39m")]
				},
				invalidate() {}
			}
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result.details as Partial<BashCreationResult> | undefined
			if (typeof details?.id === "string") context.state.taskRef = details.id
			const output = new Container()
			if (expanded || context.isError) output.addChild(renderExpandableResult(result, true, theme))
			return output
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = options.getConfig()
			if (!config.backgroundBash) throw new Error("bash_bg requires backgroundBash to be enabled")
			signal?.throwIfAborted()
			if (process.platform === "win32") throw new Error("bash_bg requires POSIX process-group termination; Windows is unsupported")
			if (!params.command.trim() || params.command.includes("\0")) {
				throw new Error("command must be nonblank and contain no NUL bytes")
			}
			if (Buffer.byteLength(params.command) > MAX_AGENT_INPUT_BYTES) throw new Error("command must be at most 64 KiB")
			if (!params.label.trim() || Buffer.byteLength(params.label.trim()) > MAX_AGENT_LABEL_BYTES) {
				throw new Error("label must be nonblank and at most 80 UTF-8 bytes")
			}
			const waitMs = params.waitMs ?? 0
			if (params.cwd?.includes("\0")) throw new Error("cwd must contain no NUL bytes")
			const cwd = resolve(ctx.cwd, params.cwd ?? ".")
			if (!(await stat(cwd)).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`)
			signal?.throwIfAborted()
			const parentSessionId = ctx.sessionManager.getSessionId()
			const pool = getBashCoordinator(config.maxBashConcurrency)
			pool.setMaxConcurrency(config.maxBashConcurrency)
			await acquireParentLease(ctx.cwd, parentSessionId)
			const paths = await reserveTaskStorage(
				await ensureParentStorage(ctx.cwd, parentSessionId),
				() => `b_${randomBytes(4).toString("hex")}`
			)
			let accepted = false
			let log: FileHandle | undefined
			try {
				await initializeRetainedLogs(paths)
				// Never reopen the pathname while running: replacement symlinks cannot redirect output.
				log = await open(paths.output, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK)
				if (!(await log.stat()).isFile()) throw new Error("Bash output.log must be a regular file")
				signal?.throwIfAborted()
				const now = Date.now()
				const metadata: BashTaskMetadata = {
					version: TASK_METADATA_VERSION,
					kind: "bash",
					taskRef: paths.taskRef,
					parentSessionId,
					label: params.label.trim(),
					command: params.command,
					cwd,
					exitCode: null,
					signal: null,
					state: "queued",
					latestOutcome: null,
					latestReply: null,
					lastActivity: { at: now, action: "queued" },
					lastRunSequence: 1,
					activeRun: {
						id: `r_${randomBytes(8).toString("hex")}`,
						sequence: 1,
						acceptanceOrder: pool.nextAcceptanceOrder(),
						kind: "initial",
						state: "queued",
						input: params.command,
						acceptedAt: now
					},
					queuedFollowUps: [],
					notifications: [],
					discardedAt: null,
					createdAt: now,
					updatedAt: now
				}
				await appendHistoryLog(paths, { type: "run-start", sequence: 1, kind: "initial", timestamp: now })
				await appendHistoryLog(paths, { type: "input", delivery: "initial", content: params.command, timestamp: now })
				await writeTaskMetadata(paths, metadata)
				accepted = true
				const runtime = new BashRuntime(paths, metadata, log)
				log = undefined
				runtime.start()
				const wait = () => runtime.wait(waitMs, signal)
				const detached = waitMs === 0 ? await wait() : await getAgentCoordinator().withLentPermit(wait, signal)
				const loaded = await readTaskMetadata(paths)
				if (loaded.status !== "ok" || loaded.metadata.kind !== "bash") throw new Error(`Could not read accepted task ${paths.taskRef}`)
				const result: BashCreationResult = {
					id: paths.taskRef,
					run: 1,
					label: loaded.metadata.label,
					state: loaded.metadata.state,
					latestOutcome: loaded.metadata.latestOutcome,
					exitCode: loaded.metadata.exitCode,
					signal: loaded.metadata.signal,
					detached,
					output: await readRetainedOutput(paths)
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `${result.id} run=1 ${JSON.stringify(result.label)}: ${result.state}${result.latestOutcome ? ` / ${result.latestOutcome}` : ""}${detached ? " (detached)" : ""}${result.output.queueReason ? ` waiting=${result.output.queueReason}` : ""}\n${result.output.text}`
						}
					],
					details: result
				}
			} finally {
				await log?.close()
				if (!accepted) await rm(paths.taskDirectory, { recursive: true, force: true })
			}
		}
	})
}

/** One retained command, one process group, one terminal transition. Never cold-loaded. */
class BashRuntime implements ResidentAgent {
	readonly #abort = new AbortController()
	readonly #unbind: () => void
	readonly #run: NonNullable<BashTaskMetadata["activeRun"]>
	#done: Promise<void> | undefined
	#child: ChildProcessWithoutNullStreams | undefined
	#stopRequested = false
	#detached = false
	#stdinClosed = false
	#spawned = Promise.withResolvers<void>()
	#inputLane: Promise<unknown> = Promise.resolve()
	#outputLane: Promise<void> = Promise.resolve()
	#progressTimer: ReturnType<typeof setTimeout> | undefined
	#tail = ""
	#truncated = false
	#failure: string | undefined
	#lastProgress = 0
	#exitCode: number | null = null
	#signal: string | null = null

	constructor(
		readonly paths: TaskStoragePaths,
		readonly metadata: BashTaskMetadata,
		readonly log: FileHandle
	) {
		if (!metadata.activeRun) throw new Error("Bash runtime requires an accepted run")
		this.#run = metadata.activeRun
		this.#unbind = getAgentCoordinator().bindResident(paths.taskDirectory, this)
	}

	start(): void {
		this.#done ??= this.run().finally(() => {
			// Keep failed cleanup reachable through task_stop/discard until the FD closes.
			if (this.log.fd === -1) this.#unbind()
		})
		// Detached failures stay observable through stop/wait and retained metadata, not unhandled rejections.
		void this.#done.catch(() => {})
	}

	async wait(waitMs: number, signal?: AbortSignal): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined
		let onAbort = () => {}
		const aborted = new Promise<"aborted">(resolve => {
			onAbort = () => resolve("aborted")
			signal?.addEventListener("abort", onAbort, { once: true })
			if (signal?.aborted) onAbort()
		})
		try {
			const result =
				waitMs === 0
					? "timeout"
					: await Promise.race([
							this.#done?.then(() => "completed" as const),
							aborted,
							new Promise<"timeout">(resolve => {
								timer = setTimeout(() => resolve("timeout"), waitMs)
								timer.unref()
							})
						])
			if (signal?.aborted || result === "aborted") {
				await this.stop()
				signal?.throwIfAborted()
			}
			if (result === "timeout") {
				await mutateTaskMetadata(this.paths, metadata => {
					if (signal?.aborted || metadata.discardedAt !== null || metadata.activeRun?.id !== this.#run.id) return metadata
					this.#detached = true
					return { ...metadata, activeRun: { ...metadata.activeRun, detachedAt: Date.now() }, updatedAt: Date.now() }
				})
				if (!this.#detached && signal?.aborted) {
					await this.stop()
					signal.throwIfAborted()
				}
				// Settlement won the lane: return its synchronous result, not a phantom detachment.
				if (!this.#detached) await this.#done
			}
			return this.#detached
		} finally {
			if (timer) clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
		}
	}

	async stop(): Promise<void> {
		this.#stopRequested = true
		this.#stdinClosed = true
		this.#abort.abort(new Error("Bash task stopped"))
		this.kill()
		try {
			await this.#done
		} finally {
			if (!this.#child && this.log.fd !== -1) await this.log.close()
			if (this.log.fd === -1) this.#unbind()
		}
	}

	async dispose(): Promise<void> {
		await this.stop()
	}

	async input(content: string, delivery: "followup" | "steer" | "stdin", options: ResidentInputOptions = {}): Promise<ResidentInputResult> {
		if (delivery !== "stdin") throw new Error("Bash tasks accept stdin only, not Follow-up or Steer")
		if (Buffer.byteLength(content) > MAX_AGENT_INPUT_BYTES) throw new Error("stdin must be at most 64 KiB")
		const operation = this.#inputLane.then(async () => {
			options.signal?.throwIfAborted()
			const loaded = await readTaskMetadata(this.paths)
			if (loaded.status !== "ok" || loaded.metadata.discardedAt !== null || loaded.metadata.state !== "running") {
				const state = loaded.status !== "ok" ? "unreadable" : loaded.metadata.discardedAt !== null ? "discarded" : loaded.metadata.state
				throw new Error(`Bash stdin is unavailable: task is ${state}, not running`)
			}
			// Durable "running" precedes spawn; a caller that saw it must not race the child's creation.
			await this.#spawned.promise
			const child = this.#child
			if (
				this.#stopRequested ||
				this.#stdinClosed ||
				!child ||
				child.exitCode !== null ||
				child.signalCode !== null ||
				child.stdin.destroyed
			) {
				throw new Error("Bash stdin is unavailable: task is stopped, completed, or stdin is closed")
			}
			options.signal?.throwIfAborted()
			if (options.eof) this.#stdinClosed = true
			await new Promise<void>((resolve, reject) => {
				let settled = false
				const finish = (error?: Error | null) => {
					if (settled) return
					settled = true
					child.stdin.removeListener("close", onClose)
					child.stdin.removeListener("error", finish)
					error ? reject(error) : resolve()
				}
				const onClose = () => finish(new Error("Bash stdin closed during delivery"))
				child.stdin.once("close", onClose)
				child.stdin.once("error", finish)
				// Write callbacks honor backpressure; EOF is sent only after these literal bytes.
				if (options.eof) child.stdin.end(content, finish)
				else child.stdin.write(content, finish)
			})
			try {
				await appendHistoryLog(this.paths, { type: "stdin", content, timestamp: Date.now(), eof: options.eof === true })
			} catch (error) {
				this.fail(error)
				throw error
			}
			return { run: 1, delivery: "stdin" as const, queuePosition: null, queuedFollowUps: 0 }
		})
		this.#inputLane = operation.catch(() => {})
		if (!options.signal) return operation
		const signal = options.signal
		let onAbort = () => {}
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(new Error("Bash stdin delivery cancelled; bytes already written cannot be undone"))
			signal.addEventListener("abort", onAbort, { once: true })
			if (signal.aborted) onAbort()
		})
		try {
			// Cancellation ends the caller's wait, not an already-submitted write. Its lane
			// still records successful delivery and must drain before settlement/archival.
			return await Promise.race([operation, aborted])
		} finally {
			signal.removeEventListener("abort", onAbort)
		}
	}

	private kill(): void {
		if (this.#child?.pid) killGroup(this.#child.pid)
	}

	private fail(error: unknown): void {
		this.#failure ??= error instanceof Error ? error.message : String(error)
		try {
			this.kill()
		} catch (killError) {
			this.#failure += `; process-group cleanup failed: ${killError instanceof Error ? killError.message : String(killError)}`
		}
	}

	private async run(): Promise<void> {
		let permit: Awaited<ReturnType<ReturnType<typeof getBashCoordinator>["acquire"]>> | undefined
		try {
			try {
				permit = await getBashCoordinator().acquire({
					...(this.#run.acceptanceOrder ? { acceptanceOrder: this.#run.acceptanceOrder } : {}),
					signal: this.#abort.signal
				})
				let running = false
				await mutateTaskMetadata(this.paths, metadata => {
					if (this.#stopRequested || metadata.discardedAt !== null || metadata.activeRun?.id !== this.#run.id) return metadata
					running = true
					return {
						...metadata,
						state: "running",
						activeRun: { ...metadata.activeRun, state: "running", startedAt: Date.now() },
						lastActivity: { at: Date.now(), action: "started" },
						updatedAt: Date.now()
					}
				})
				if (running && !this.#stopRequested) await this.process()
			} catch (error) {
				if (error !== this.#abort.signal.reason) this.fail(error)
			}
			if (this.#progressTimer) clearTimeout(this.#progressTimer)
			try {
				await this.#outputLane
			} catch (error) {
				this.fail(error)
			}
			await this.#inputLane
			try {
				await this.log.sync()
			} catch (error) {
				this.fail(error)
			}
			try {
				await this.log.close()
			} catch (error) {
				this.fail(error)
			}
			await mutateTaskMetadata(this.paths, async metadata => {
				if (metadata.kind !== "bash" || metadata.discardedAt !== null || metadata.activeRun?.id !== this.#run.id) return metadata
				let outcome: NonNullable<BashTaskMetadata["latestOutcome"]> = this.#stopRequested
					? "stopped"
					: this.#failure || this.#exitCode !== 0
						? "failed"
						: "succeeded"
				let reason = this.#stopRequested
					? "Bash task stopped"
					: (this.#failure ?? (this.#signal ? `Bash terminated by ${this.#signal}` : `Bash exited with code ${this.#exitCode}`))
				// A broken retained log must not suppress a still-writable terminal snapshot.
				try {
					await appendHistoryLog(this.paths, { type: "run-end", sequence: 1, outcome, timestamp: Date.now(), summary: reason })
				} catch (error) {
					this.fail(error)
					outcome = this.#stopRequested ? "stopped" : "failed"
					reason = this.#failure ?? reason
				}
				if (this.#failure) this.appendOutput(`\n[Bash error: ${this.#failure}]`)
				const completed = {
					...metadata,
					exitCode: this.#exitCode,
					signal: this.#signal,
					latestReply: { text: this.#tail || (outcome === "failed" ? reason : ""), streaming: false, truncated: this.#truncated }
				}
				const notification =
					outcome !== "stopped" && metadata.activeRun.detachedAt !== undefined
						? await prepareTaskNotification(this.paths, completed, metadata.activeRun, "completion", outcome)
						: undefined
				return {
					...completed,
					state: "idle",
					latestOutcome: outcome,
					activeRun: null,
					notifications: notification ? appendTaskNotification(metadata.notifications, notification) : metadata.notifications,
					updatedAt: Date.now()
				}
			})
			// Routing failures leave the durable outbox pending for exact-parent reconciliation.
			await deliverTaskNotifications(this.paths).catch(() => {})
		} finally {
			this.#stdinClosed = true
			this.#spawned.resolve()
			try {
				// Retry cleanup only after a real close failure left this handle open.
				if (this.log.fd !== -1) await this.log.close()
			} finally {
				permit?.release()
			}
		}
	}

	private async process(): Promise<void> {
		const child = spawn("bash", ["-c", this.metadata.command], { cwd: this.metadata.cwd, detached: true, stdio: "pipe" })
		this.#child = child
		this.#spawned.resolve()
		const groups = liveGroups()
		if (child.pid) groups.add(child.pid)
		let spawnError: Error | undefined
		child.on("error", error => {
			spawnError = error
		})
		// EPIPE is an input error, not an uncaught process-wide exception.
		child.stdin.on("error", () => {
			this.#stdinClosed = true
		})
		// Jobs the shell left behind hold the pipes open; reap them so settlement isn't deferred to their exit.
		child.once("exit", () => {
			try {
				this.kill()
			} catch (error) {
				this.#failure ??= `process-group cleanup failed: ${error instanceof Error ? error.message : String(error)}`
			}
		})
		const closed = new Promise<void>(resolve => {
			child.once("close", (code, signal) => {
				this.#exitCode = spawnError ? null : (code ?? null)
				this.#signal = signal ?? null
				this.#stdinClosed = true
				resolve()
			})
		})
		try {
			const readers = await Promise.allSettled(
				[child.stdout, child.stderr].map(stream =>
					this.consume(stream).catch(error => {
						this.fail(error)
						throw error
					})
				)
			)
			await closed
			if (spawnError) {
				// Failed spawn can close pipes prematurely; retain its cause, not that symptom.
				this.#failure = spawnError.message
				throw spawnError
			}
			for (const result of readers) if (result.status === "rejected") throw result.reason
		} finally {
			// Also reap shell-launched jobs that redirected their pipes before the shell exited.
			this.kill()
			await closed
			if (child.pid) groups.delete(child.pid)
			this.#child = undefined
		}
	}

	private async consume(stream: Readable): Promise<void> {
		const decoder = new StringDecoder("utf8")
		for await (const chunk of stream) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			const text = decoder.write(bytes)
			// At most one pending chunk per pipe. Disk latency backpressures both producers.
			this.#outputLane = this.#outputLane.then(async () => {
				let offset = 0
				while (offset < bytes.length) {
					const { bytesWritten } = await this.log.write(bytes, offset, bytes.length - offset)
					if (!bytesWritten) throw new Error("Bash output.log write made no progress")
					offset += bytesWritten
				}
				this.appendOutput(text)
				if (Date.now() - this.#lastProgress >= 100) await this.flushProgress(true)
				else if (!this.#progressTimer) {
					this.#progressTimer = setTimeout(() => {
						this.#progressTimer = undefined
						this.#outputLane = this.#outputLane.then(() => this.flushProgress(true))
						void this.#outputLane.catch(error => this.fail(error))
					}, 100)
					this.#progressTimer.unref()
				}
			})
			await this.#outputLane
		}
		const remainder = decoder.end()
		if (remainder) {
			this.#outputLane = this.#outputLane.then(() => {
				this.appendOutput(remainder)
			})
			await this.#outputLane
		}
	}

	private async flushProgress(streaming: boolean): Promise<void> {
		this.#lastProgress = Date.now()
		await writeTaskProgress(this.paths, this.#run.id, {
			latestReply: { text: this.#tail, streaming, truncated: this.#truncated },
			lastActivity: { at: this.#lastProgress, action: "output" }
		})
	}

	private appendOutput(text: string): void {
		const combined = this.#tail + text
		this.#tail = outputTail(combined)
		this.#truncated ||= this.#tail.length !== combined.length
	}
}

function outputTail(text: string): string {
	const bytes = Buffer.from(text)
	let start = Math.max(0, bytes.length - RETAINED_OUTPUT_MAX_BYTES)
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
	return bytes.subarray(start).toString("utf8").split("\n").slice(-RETAINED_OUTPUT_MAX_LINES).join("\n")
}

const LIVE_GROUPS = Symbol.for("@xl0/pi-lovely-agents/bash-process-groups/v1")
function liveGroups(): Set<number> {
	const global = globalThis as typeof globalThis & { [LIVE_GROUPS]?: Set<number> }
	if (!global[LIVE_GROUPS]) {
		const groups = new Set<number>()
		global[LIVE_GROUPS] = groups
		// Synchronous exit cleanup only. SIGKILL/power loss and deliberate setsid escapes
		// cannot be contained without OS supervision; no retained PID is ever reused.
		process.once("exit", () => {
			for (const pid of groups) killGroup(pid)
		})
	}
	return global[LIVE_GROUPS]
}

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL")
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
	}
}
