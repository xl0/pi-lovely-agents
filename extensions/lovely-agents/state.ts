import { randomBytes } from "node:crypto"
import { watch } from "node:fs"
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { type Static, Type } from "typebox"
import { Value } from "typebox/value"
import { publishTaskUpdate } from "./updates.js"

export const TASK_METADATA_VERSION = 2
export const TASK_REFERENCE_PATTERN = /^a_[0-9a-f]{8}$/
export const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
export const STORAGE_GITIGNORE = "*\n!.gitignore\n"
export const MAX_AGENT_INPUT_BYTES = 64 * 1024
export const MAX_AGENT_LABEL_BYTES = 80
export const MAX_QUEUED_FOLLOWUPS = 32
export const MAX_TASK_NOTIFICATIONS = 128
export const MAX_NOTIFICATION_CONTENT_BYTES = 8 * 1024
export const PARENT_LEASE_VERSION = 1
export const RETAINED_OUTPUT_MAX_LINES = 2_000
export const RETAINED_OUTPUT_MAX_BYTES = 50 * 1024
export const RETAINED_ACTIVITY_PREVIEW_BYTES = 2 * 1024
export const RETAINED_OUTPUT_MAX_WAIT_MS = 10 * 60 * 1_000

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const MAX_TASK_REFERENCE_ATTEMPTS = 100
const MAX_LEASE_ACQUIRE_ATTEMPTS = 10
const DEFINITION_NAME_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$"
const LEASE_STATE_SYMBOL = Symbol.for("@xl0/pi-lovely-agents/parent-leases/v1")
const TASK_QUEUE_STATE_SYMBOL = Symbol.for("@xl0/pi-lovely-agents/task-queues/v1")

const RunId = Type.String({ pattern: "^r_[0-9a-f]{16}$" })
const Timestamp = Type.Integer({ minimum: 0 })
const TaskState = Type.Union([
	Type.Literal("idle"),
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("suspended"),
	Type.Literal("interrupted")
])
const RunOutcome = Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("stopped"), Type.Literal("interrupted")])
const ThinkingLevel = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max")
])
const ActiveRun = Type.Object(
	{
		id: RunId,
		sequence: Type.Integer({ minimum: 1 }),
		acceptanceOrder: Type.Optional(Type.Integer({ minimum: 1 })),
		kind: Type.Union([Type.Literal("initial"), Type.Literal("followup")]),
		state: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("suspended")]),
		input: Type.String(),
		acceptedAt: Timestamp,
		startedAt: Type.Optional(Timestamp),
		detachedAt: Type.Optional(Timestamp)
	},
	{ additionalProperties: false }
)
const QueuedFollowUp = Type.Object(
	{
		id: RunId,
		sequence: Type.Integer({ minimum: 1 }),
		acceptanceOrder: Type.Optional(Type.Integer({ minimum: 1 })),
		content: Type.String(),
		acceptedAt: Timestamp
	},
	{ additionalProperties: false }
)
const Notification = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		type: Type.Union([Type.Literal("completion"), Type.Literal("suspension"), Type.Literal("interruption")]),
		runId: RunId,
		content: Type.String({ minLength: 1 }),
		createdAt: Timestamp,
		deliveredAt: Type.Optional(Timestamp)
	},
	{ additionalProperties: false }
)
const ParentLeaseFileSchema = Type.Object(
	{
		version: Type.Literal(PARENT_LEASE_VERSION),
		pid: Type.Integer({ minimum: 1 }),
		token: Type.String({ pattern: "^[0-9a-f]{32}$" }),
		createdAt: Timestamp
	},
	{ additionalProperties: false }
)

/** Durable current snapshot for one agent session. */
export const TaskMetadataSchema = Type.Object(
	{
		version: Type.Literal(TASK_METADATA_VERSION),
		kind: Type.Literal("agent"),
		taskRef: Type.String({ pattern: TASK_REFERENCE_PATTERN.source }),
		parentSessionId: Type.String({ pattern: SESSION_ID_PATTERN.source }),
		childSessionId: Type.String({ pattern: SESSION_ID_PATTERN.source }),
		definitionName: Type.String({ pattern: DEFINITION_NAME_PATTERN }),
		label: Type.String({ minLength: 1 }),
		model: Type.Object(
			{
				provider: Type.String({ minLength: 1 }),
				id: Type.String({ minLength: 1 })
			},
			{ additionalProperties: false }
		),
		thinking: ThinkingLevel,
		depth: Type.Integer({ minimum: 1 }),
		allowAgents: Type.Boolean(),
		sessionConfig: Type.Object(
			{
				systemPrompt: Type.String({ minLength: 1 }),
				tools: Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Null()]),
				excludeAgentsMd: Type.Boolean(),
				scopedModels: Type.Array(
					Type.Object(
						{
							provider: Type.String({ minLength: 1 }),
							id: Type.String({ minLength: 1 }),
							thinkingLevel: Type.Optional(ThinkingLevel)
						},
						{ additionalProperties: false }
					)
				)
			},
			{ additionalProperties: false }
		),
		state: TaskState,
		latestOutcome: Type.Union([RunOutcome, Type.Null()]),
		lastRunSequence: Type.Integer({ minimum: 0 }),
		activeRun: Type.Union([ActiveRun, Type.Null()]),
		queuedFollowUps: Type.Array(QueuedFollowUp, { maxItems: MAX_QUEUED_FOLLOWUPS }),
		notifications: Type.Array(Notification, { maxItems: MAX_TASK_NOTIFICATIONS }),
		discardedAt: Type.Union([Timestamp, Type.Null()]),
		createdAt: Timestamp,
		updatedAt: Timestamp
	},
	{ additionalProperties: false }
)

export type TaskMetadata = Static<typeof TaskMetadataSchema>
type ParentLeaseFile = Static<typeof ParentLeaseFileSchema>

/** Filesystem locations owned by one parent Pi session. */
export type ParentStoragePaths = {
	workspace: string
	root: string
	parentSessionId: string
	parentDirectory: string
	lease: string
}

/** Filesystem locations retained for one task. */
export type TaskStoragePaths = ParentStoragePaths & {
	taskRef: string
	taskDirectory: string
	metadata: string
	session: string
	output: string
	activity: string
}

/** Process-global ownership proof for one parent partition. */
export type ParentLease = Readonly<ParentLeaseFile & { paths: Readonly<ParentStoragePaths> }>

/** Stable model-visible paths for retained task artifacts. */
export type RetainedPaths = {
	output: string
	activity: string
	session: string
}

/** Structured events rendered into the readable output log. */
export type OutputLogEntry =
	| { type: "run-start"; sequence: number; kind: "initial" | "followup"; timestamp: number }
	| { type: "input"; delivery: "initial" | "followup" | "steer"; timestamp: number; content: string }
	| { type: "assistant"; content: string }
	| { type: "run-end"; sequence: number; outcome: Static<typeof RunOutcome>; timestamp: number; summary?: string }

/** One bounded tool record rendered into the activity index. */
export type ActivityLogEntry = {
	tool: string
	timestamp: number
	arguments: string
	result: string
	isError: boolean
	fullOutputPath?: string
}

export type RetainedOutputReadOptions = {
	offset?: number
	limit?: number
	waitMs?: number
	signal?: AbortSignal
}

export type RetainedOutputRead = {
	text: string
	startLine: number | null
	endLine: number | null
	totalLines: number
	returnedLines: number
	nextOffset: number
	truncated: boolean
	truncatedBy: "lines" | "bytes" | null
	timedOut: boolean
	state: Static<typeof TaskState>
	paths: RetainedPaths
}

export type MetadataDiagnostic = {
	code: "unreadable" | "invalid-json" | "unsupported-version" | "invalid-metadata"
	message: string
	path: string
}

export type MetadataLoadResult =
	| { status: "ok"; metadata: TaskMetadata }
	| { status: "missing" }
	| { status: "invalid"; diagnostic: MetadataDiagnostic }

type ParentLeaseLoadResult = { status: "ok"; lease: ParentLeaseFile } | { status: "missing" } | { status: "invalid"; message: string }

type ParentLeaseState = {
	version: typeof PARENT_LEASE_VERSION
	leases: Map<string, ParentLease>
	queues: Map<string, Promise<void>>
}

type TaskQueueState = {
	version: 1
	metadata: Map<string, Promise<void>>
	logs: Map<string, Promise<void>>
}

export class InvalidTaskMetadataError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "InvalidTaskMetadataError"
	}
}

export class ParentLeaseError extends Error {
	readonly code: string = "LOVELY_AGENTS_PARENT_LEASE"

	constructor(message: string) {
		super(message)
		this.name = "ParentLeaseError"
	}
}

export class ParentLeaseConflictError extends ParentLeaseError {
	override readonly code = "LOVELY_AGENTS_PARENT_LEASE_CONFLICT"
	readonly ownerPid: number

	constructor(path: string, ownerPid: number) {
		super(`Lovely Agents parent partition is owned by live process ${ownerPid}: ${path}`)
		this.name = "ParentLeaseConflictError"
		this.ownerPid = ownerPid
	}
}

export function parentStoragePaths(cwd: string, parentSessionId: string): ParentStoragePaths {
	assertSessionId(parentSessionId)
	const workspace = resolve(cwd)
	const root = join(workspace, ".pi", "lovely-agents")
	const parentDirectory = join(root, parentSessionId)
	return { workspace, root, parentSessionId, parentDirectory, lease: join(parentDirectory, ".lease") }
}

export function taskStoragePaths(parent: ParentStoragePaths, taskRef: string): TaskStoragePaths {
	assertTaskReference(taskRef)
	const taskDirectory = join(parent.parentDirectory, taskRef)
	return {
		...parent,
		taskRef,
		taskDirectory,
		metadata: join(taskDirectory, "metadata.json"),
		session: join(taskDirectory, "session.jsonl"),
		output: join(taskDirectory, "output.md"),
		activity: join(taskDirectory, "activity.md")
	}
}

export function createTaskReference(): string {
	return `a_${randomBytes(4).toString("hex")}`
}

/** Creates and verifies the private root and exact parent partition. */
export async function ensureParentStorage(cwd: string, parentSessionId: string): Promise<ParentStoragePaths> {
	const paths = parentStoragePaths(cwd, parentSessionId)
	const configDirectory = dirname(paths.root)
	await mkdir(configDirectory, { recursive: true })
	await assertRegularDirectory(configDirectory)
	const [realWorkspace, realConfigDirectory] = await Promise.all([realpath(paths.workspace), realpath(configDirectory)])
	if (dirname(realConfigDirectory) !== realWorkspace) {
		throw new Error(`Lovely Agents config directory escapes the workspace: ${configDirectory}`)
	}

	try {
		await mkdir(paths.root, { mode: DIRECTORY_MODE })
	} catch (error) {
		if (!hasCode(error, "EEXIST")) throw error
	}
	await assertRegularDirectory(paths.root)
	const realRoot = await realpath(paths.root)
	if (dirname(realRoot) !== realConfigDirectory) throw new Error(`Lovely Agents storage escapes the workspace: ${paths.root}`)
	await chmod(paths.root, DIRECTORY_MODE)

	try {
		await mkdir(paths.parentDirectory, { mode: DIRECTORY_MODE })
	} catch (error) {
		if (!hasCode(error, "EEXIST")) throw error
	}
	await assertRegularDirectory(paths.parentDirectory)
	if (dirname(await realpath(paths.parentDirectory)) !== realRoot) {
		throw new Error(`Lovely Agents parent partition escapes its storage root: ${paths.parentDirectory}`)
	}
	await chmod(paths.parentDirectory, DIRECTORY_MODE)
	await ensureStorageGitignore(paths.root)
	return paths
}

/**
 * Acquires one durable parent-partition lease. Duplicate calls in this process
 * return the same lease, including across extension runtime reloads.
 */
export async function acquireParentLease(cwd: string, parentSessionId: string): Promise<ParentLease> {
	const paths = await ensureParentStorage(cwd, parentSessionId)
	const state = parentLeaseState()
	return serializeOperation(state.queues, paths.lease, async () => {
		const existing = state.leases.get(paths.lease)
		if (existing) {
			const loaded = await loadParentLease(paths.lease)
			if (loaded.status === "ok" && loaded.lease.pid === existing.pid && loaded.lease.token === existing.token) {
				return existing
			}
			state.leases.delete(paths.lease)
			throw new ParentLeaseError(`Process-global lease ownership no longer matches ${paths.lease}`)
		}

		const leaseFile: ParentLeaseFile = {
			version: PARENT_LEASE_VERSION,
			pid: process.pid,
			token: randomBytes(16).toString("hex"),
			createdAt: Date.now()
		}
		const candidate = `${paths.lease}.${process.pid}.${leaseFile.token}.tmp`
		await writePrivateFile(candidate, `${JSON.stringify(leaseFile)}\n`)
		try {
			for (let attempt = 0; attempt < MAX_LEASE_ACQUIRE_ATTEMPTS; attempt++) {
				try {
					await link(candidate, paths.lease)
					try {
						await syncDirectory(paths.parentDirectory)
					} catch (error) {
						await removeIfPresent(paths.lease)
						throw error
					}
					const lease = Object.freeze({ ...leaseFile, paths: Object.freeze({ ...paths }) })
					state.leases.set(paths.lease, lease)
					return lease
				} catch (error) {
					if (!hasCode(error, "EEXIST")) throw error
				}

				const loaded = await loadParentLease(paths.lease)
				if (loaded.status === "missing") continue
				if (loaded.status === "invalid") {
					throw new ParentLeaseError(`Cannot acquire invalid parent lease ${paths.lease}: ${loaded.message}`)
				}
				if (processIsAlive(loaded.lease.pid)) {
					throw new ParentLeaseConflictError(paths.lease, loaded.lease.pid)
				}

				const confirmed = await loadParentLease(paths.lease)
				if (confirmed.status !== "ok" || confirmed.lease.pid !== loaded.lease.pid || confirmed.lease.token !== loaded.lease.token) {
					continue
				}
				try {
					await unlink(paths.lease)
					await syncDirectory(paths.parentDirectory)
				} catch (error) {
					if (!hasCode(error, "ENOENT")) throw error
				}
			}
			throw new ParentLeaseError(`Unable to acquire changing parent lease: ${paths.lease}`)
		} finally {
			await removeIfPresent(candidate)
		}
	})
}

/** Releases only the matching process-global lease; repeated release is safe. */
export async function releaseParentLease(lease: ParentLease): Promise<void> {
	const state = parentLeaseState()
	await serializeOperation(state.queues, lease.paths.lease, async () => {
		if (state.leases.get(lease.paths.lease) !== lease) return

		const loaded = await loadParentLease(lease.paths.lease)
		if (loaded.status === "missing") {
			state.leases.delete(lease.paths.lease)
			return
		}
		if (loaded.status === "invalid" || loaded.lease.pid !== lease.pid || loaded.lease.token !== lease.token) {
			state.leases.delete(lease.paths.lease)
			throw new ParentLeaseError(`Refusing to release a parent lease no longer owned by this process: ${lease.paths.lease}`)
		}

		await unlink(lease.paths.lease)
		state.leases.delete(lease.paths.lease)
		await syncDirectory(lease.paths.parentDirectory)
	})
}

/** Releases a registered lease by identity after a semantic parent close. */
export async function releaseParentLeaseFor(cwd: string, parentSessionId: string): Promise<boolean> {
	const path = parentStoragePaths(cwd, parentSessionId).lease
	const lease = parentLeaseState().leases.get(path)
	if (!lease) return false
	await releaseParentLease(lease)
	return true
}

/** Creates empty retained logs without touching Pi's authoritative session. */
export async function initializeRetainedLogs(paths: TaskStoragePaths): Promise<void> {
	await Promise.all([ensurePrivateLogFile(paths.output), ensurePrivateLogFile(paths.activity)])
	await syncDirectory(paths.taskDirectory)
}

export async function appendOutputLog(paths: TaskStoragePaths, entry: OutputLogEntry): Promise<void> {
	await appendRetainedLog(paths.output, renderOutputLogEntry(entry))
	publishTaskUpdate(paths.workspace, paths.parentSessionId)
}

export function appendActivityLog(paths: TaskStoragePaths, entry: ActivityLogEntry): Promise<void> {
	return appendRetainedLog(paths.activity, renderActivityLogEntry(paths, entry))
}

export function retainedPaths(paths: TaskStoragePaths): RetainedPaths {
	return {
		output: displayWorkspacePath(paths.workspace, paths.output),
		activity: displayWorkspacePath(paths.workspace, paths.activity),
		session: displayWorkspacePath(paths.workspace, paths.session)
	}
}

export async function countRetainedOutputLines(paths: TaskStoragePaths): Promise<number> {
	return splitCompleteLines(await readRetainedLog(paths.output)).length
}

/**
 * Reads complete lines from output.md. When positioned at the live end, waits
 * for output growth or a task-state transition.
 */
export async function readRetainedOutput(paths: TaskStoragePaths, options: RetainedOutputReadOptions = {}): Promise<RetainedOutputRead> {
	const offset = options.offset ?? 1
	const limit = options.limit ?? RETAINED_OUTPUT_MAX_LINES
	const waitMs = options.waitMs ?? 0
	assertPositiveInteger(offset, "offset")
	assertPositiveInteger(limit, "limit")
	if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > RETAINED_OUTPUT_MAX_WAIT_MS) {
		throw new Error(`waitMs must be an integer from 0 to ${RETAINED_OUTPUT_MAX_WAIT_MS}`)
	}

	let output = await readRetainedLog(paths.output)
	let metadata = await requireTaskMetadata(paths)
	let lines = splitCompleteLines(output)
	if (offset > lines.length + 1) throw new Error(`Offset ${offset} is beyond end of output (${lines.length} lines total)`)

	let timedOut = false
	if (waitMs > 0 && isActiveTaskState(metadata.state) && offset > lines.length) {
		const changed = await waitForRetainedChange(
			paths,
			{ outputBytes: Buffer.byteLength(output), state: metadata.state },
			waitMs,
			options.signal
		)
		timedOut = !changed
		output = await readRetainedLog(paths.output)
		metadata = await requireTaskMetadata(paths)
		lines = splitCompleteLines(output)
	}

	return buildRetainedOutputRead(paths, lines, metadata.state, offset, limit, timedOut)
}

/** Atomically reserves a fresh task directory; existing names are collisions. */
export async function reserveTaskStorage(
	parent: ParentStoragePaths,
	nextReference: () => string = createTaskReference
): Promise<TaskStoragePaths> {
	for (let attempt = 0; attempt < MAX_TASK_REFERENCE_ATTEMPTS; attempt++) {
		const paths = taskStoragePaths(parent, nextReference())
		try {
			await mkdir(paths.taskDirectory, { mode: DIRECTORY_MODE })
			return paths
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error
		}
	}
	throw new Error(`Unable to reserve a unique Task Reference after ${MAX_TASK_REFERENCE_ATTEMPTS} attempts`)
}

export async function readTaskMetadata(paths: TaskStoragePaths): Promise<MetadataLoadResult> {
	let source: string
	try {
		const stats = await lstat(paths.metadata)
		if (!stats.isFile() || stats.isSymbolicLink()) {
			return invalidMetadata(paths.metadata, "unreadable", "metadata.json is not a regular file")
		}
		source = await readFile(paths.metadata, "utf8")
	} catch (error) {
		if (hasCode(error, "ENOENT")) return { status: "missing" }
		return invalidMetadata(paths.metadata, "unreadable", errorMessage(error))
	}

	let value: unknown
	try {
		value = JSON.parse(source)
	} catch (error) {
		return invalidMetadata(paths.metadata, "invalid-json", errorMessage(error))
	}
	const version = isRecord(value) ? property(value, "version") : undefined
	if (typeof version === "number" && version !== TASK_METADATA_VERSION) {
		return invalidMetadata(paths.metadata, "unsupported-version", `Unsupported metadata version ${version}`)
	}
	const validated = validateTaskMetadata(value)
	if (!validated.ok) return invalidMetadata(paths.metadata, "invalid-metadata", validated.message)
	if (validated.value.taskRef !== paths.taskRef || validated.value.parentSessionId !== paths.parentSessionId) {
		return invalidMetadata(paths.metadata, "invalid-metadata", "Metadata identity does not match its parent/task path")
	}
	return { status: "ok", metadata: validated.value }
}

/** Replaces metadata through a same-directory, fsynced temporary file. */
export function writeTaskMetadata(paths: TaskStoragePaths, metadata: TaskMetadata): Promise<void> {
	return serializeMetadataMutation(paths.metadata, async () => {
		assertMetadataForPath(paths, metadata)
		await atomicWriteMetadata(paths.metadata, metadata)
		publishTaskUpdate(paths.workspace, paths.parentSessionId)
	})
}

/** Reads, transforms, validates, and durably writes one task under a per-task queue. */
export function mutateTaskMetadata(
	paths: TaskStoragePaths,
	mutate: (metadata: TaskMetadata) => TaskMetadata | Promise<TaskMetadata>
): Promise<TaskMetadata> {
	return serializeMetadataMutation(paths.metadata, async () => {
		const loaded = await readTaskMetadata(paths)
		if (loaded.status !== "ok") throw new InvalidTaskMetadataError(metadataLoadError(loaded, paths.metadata))
		const updated = await mutate(structuredClone(loaded.metadata))
		assertMetadataForPath(paths, updated)
		await atomicWriteMetadata(paths.metadata, updated)
		publishTaskUpdate(paths.workspace, paths.parentSessionId)
		return updated
	})
}

export function assertTaskMetadata(value: unknown): asserts value is TaskMetadata {
	const validated = validateTaskMetadata(value)
	if (!validated.ok) throw new InvalidTaskMetadataError(validated.message)
}

function validateTaskMetadata(value: unknown): { ok: true; value: TaskMetadata } | { ok: false; message: string } {
	if (!Value.Check(TaskMetadataSchema, value)) {
		const error = Value.Errors(TaskMetadataSchema, value)[0]
		return { ok: false, message: error ? `${error.instancePath || "/"} ${error.message}` : "Invalid task metadata" }
	}
	const semanticError = taskMetadataSemanticError(value)
	return semanticError ? { ok: false, message: semanticError } : { ok: true, value }
}

function taskMetadataSemanticError(value: TaskMetadata): string | undefined {
	if (!value.label.trim()) return "/label must be nonblank"
	if (Buffer.byteLength(value.label, "utf8") > MAX_AGENT_LABEL_BYTES) {
		return `/label must be at most ${MAX_AGENT_LABEL_BYTES} UTF-8 bytes`
	}
	if (value.updatedAt < value.createdAt) return "/updatedAt must not precede /createdAt"
	if (value.discardedAt !== null && value.discardedAt < value.createdAt) return "/discardedAt must not precede /createdAt"
	if ((value.activeRun === null) !== (value.state === "idle" || value.state === "interrupted")) {
		return "/activeRun must exist exactly while state is queued, running, or suspended"
	}
	if (value.activeRun) {
		if (value.activeRun.state !== value.state) return "/activeRun/state must match /state"
		if (value.activeRun.sequence > value.lastRunSequence) return "/activeRun/sequence exceeds /lastRunSequence"
		if (value.activeRun.state !== "queued" && value.activeRun.startedAt === undefined) {
			return "/activeRun/startedAt is required after leaving queued state"
		}
		const inputError = inputValidationError(value.activeRun.input, "/activeRun/input")
		if (inputError) return inputError
	}
	let priorSequence = value.activeRun?.sequence ?? 0
	for (let index = 0; index < value.queuedFollowUps.length; index++) {
		const followUp = value.queuedFollowUps[index]
		if (!followUp) continue
		if (followUp.sequence <= priorSequence) return `/queuedFollowUps/${index}/sequence must be strictly increasing`
		if (followUp.sequence > value.lastRunSequence) return `/queuedFollowUps/${index}/sequence exceeds /lastRunSequence`
		const contentError = inputValidationError(followUp.content, `/queuedFollowUps/${index}/content`)
		if (contentError) return contentError
		priorSequence = followUp.sequence
	}
	for (let index = 0; index < value.notifications.length; index++) {
		if (Buffer.byteLength(value.notifications[index]?.content ?? "", "utf8") > MAX_NOTIFICATION_CONTENT_BYTES) {
			return `/notifications/${index}/content must be at most ${MAX_NOTIFICATION_CONTENT_BYTES} UTF-8 bytes`
		}
	}
	return undefined
}

function inputValidationError(value: string, path: string): string | undefined {
	if (!value.trim()) return `${path} must be nonblank`
	if (Buffer.byteLength(value, "utf8") > MAX_AGENT_INPUT_BYTES) return `${path} must be at most ${MAX_AGENT_INPUT_BYTES} UTF-8 bytes`
	return undefined
}

function assertMetadataForPath(paths: TaskStoragePaths, metadata: unknown): asserts metadata is TaskMetadata {
	assertTaskMetadata(metadata)
	if (metadata.taskRef !== paths.taskRef || metadata.parentSessionId !== paths.parentSessionId) {
		throw new InvalidTaskMetadataError("Metadata identity does not match its parent/task path")
	}
}

function renderOutputLogEntry(entry: OutputLogEntry): string {
	switch (entry.type) {
		case "run-start":
			return `<run ${entry.sequence} ${entry.kind}>\n`
		case "input":
			return taggedBlockEntry(entry.delivery === "steer" ? "steer" : "user", entry.content)
		case "assistant":
			return taggedBlockEntry("agent", entry.content)
		case "run-end":
			return `<outcome ${entry.outcome}>\n${entry.summary ? taggedBlockEntry("summary", entry.summary) : ""}\n`
	}
}

function taggedBlockEntry(tag: string, content: string): string {
	const normalized = content.replace(/\r\n?/g, "\n").replace(/\n+$/, "")
	return `<${tag}>\n${normalized}\n`
}

function renderActivityLogEntry(paths: TaskStoragePaths, entry: ActivityLogEntry): string {
	const fullOutput = entry.fullOutputPath
		? `\nFull output: ${isAbsolute(entry.fullOutputPath) ? displayWorkspacePath(paths.workspace, entry.fullOutputPath) : entry.fullOutputPath}\n`
		: ""
	const headerArguments = activityHeaderArguments(entry.arguments)
	return `## ${entry.tool}${headerArguments ? ` ${headerArguments}` : ""}\n\nTime: ${formatTimestamp(entry.timestamp)}\nStatus: ${entry.isError ? "error" : "ok"}\n\n### Arguments\n\n${previewActivityText(entry.arguments)}\n\n### Result\n\n${previewActivityText(entry.result)}\n${fullOutput}\n---\n`
}

function activityHeaderArguments(content: string): string {
	const singleLine = content.replace(/\s+/g, " ").trim()
	const bytes = Buffer.from(singleLine)
	if (bytes.length <= 160) return singleLine
	let end = 157
	while (end > 0 && isUtf8Continuation(bytes[end])) end--
	return `${bytes.subarray(0, end).toString("utf8")}...`
}

function previewActivityText(content: string): string {
	const bytes = Buffer.from(content)
	if (bytes.length <= RETAINED_ACTIVITY_PREVIEW_BYTES) return content

	const headBudget = Math.floor(RETAINED_ACTIVITY_PREVIEW_BYTES / 2)
	const tailBudget = RETAINED_ACTIVITY_PREVIEW_BYTES - headBudget
	let headEnd = headBudget
	while (headEnd > 0 && isUtf8Continuation(bytes[headEnd])) headEnd--
	let tailStart = bytes.length - tailBudget
	while (tailStart < bytes.length && isUtf8Continuation(bytes[tailStart])) tailStart++

	const head = bytes.subarray(0, headEnd).toString("utf8")
	const tail = bytes.subarray(tailStart).toString("utf8")
	const omitted = bytes.length - headEnd - (bytes.length - tailStart)
	return `${head}\n\n[... omitted ${omitted} UTF-8 bytes ...]\n\n${tail}`
}

function buildRetainedOutputRead(
	paths: TaskStoragePaths,
	lines: string[],
	state: Static<typeof TaskState>,
	offset: number,
	requestedLimit: number,
	timedOut: boolean
): RetainedOutputRead {
	const lineLimit = Math.min(requestedLimit, RETAINED_OUTPUT_MAX_LINES)
	const selected: string[] = []
	let selectedBytes = 0
	let index = offset - 1
	let truncatedBy: RetainedOutputRead["truncatedBy"] = null
	while (index < lines.length && selected.length < lineLimit) {
		const line = lines[index]
		if (line === undefined) break
		const bytes = Buffer.byteLength(line) + (selected.length > 0 ? 1 : 0)
		if (selectedBytes + bytes > RETAINED_OUTPUT_MAX_BYTES) {
			truncatedBy = "bytes"
			break
		}
		selected.push(line)
		selectedBytes += bytes
		index++
	}
	if (index < lines.length && truncatedBy === null) truncatedBy = "lines"

	const startLine = selected.length > 0 ? offset : null
	const endLine = selected.length > 0 ? offset + selected.length - 1 : null
	const nextOffset = endLine === null ? offset : endLine + 1
	let text = selected.join("\n")
	if (truncatedBy !== null && selected.length === 0) {
		text = `[Line ${offset} exceeds 50KB. Inspect ${retainedPaths(paths).output} directly.]`
	} else if (truncatedBy !== null) {
		const byteNote = truncatedBy === "bytes" ? " (50KB limit)" : ""
		text += `\n\n[Showing lines ${offset}-${endLine} of ${lines.length}${byteNote}. Use offset=${nextOffset} to continue.]`
	}

	return {
		text,
		startLine,
		endLine,
		totalLines: lines.length,
		returnedLines: selected.length,
		nextOffset,
		truncated: truncatedBy !== null,
		truncatedBy,
		timedOut,
		state,
		paths: retainedPaths(paths)
	}
}

async function requireTaskMetadata(paths: TaskStoragePaths): Promise<TaskMetadata> {
	const loaded = await readTaskMetadata(paths)
	if (loaded.status !== "ok") throw new InvalidTaskMetadataError(metadataLoadError(loaded, paths.metadata))
	return loaded.metadata
}

async function waitForRetainedChange(
	paths: TaskStoragePaths,
	baseline: { outputBytes: number; state: Static<typeof TaskState> },
	waitMs: number,
	signal?: AbortSignal
): Promise<boolean> {
	if (signal?.aborted) throw abortReason(signal)
	return new Promise<boolean>((resolvePromise, rejectPromise) => {
		let settled = false
		let checking = false
		let checkPending = false
		const watcher = watch(paths.taskDirectory, { persistent: false }, () => {
			requestCheck()
		})
		const timer = setTimeout(() => finish(false), waitMs)
		const onAbort = () => fail(abortReason(signal))
		const cleanup = () => {
			clearTimeout(timer)
			watcher.close()
			signal?.removeEventListener("abort", onAbort)
		}
		const finish = (changed: boolean) => {
			if (settled) return
			settled = true
			cleanup()
			resolvePromise(changed)
		}
		const fail = (error: unknown) => {
			if (settled) return
			settled = true
			cleanup()
			rejectPromise(error)
		}
		const requestCheck = () => {
			if (checking) {
				checkPending = true
				return
			}
			void check()
		}
		const check = async () => {
			if (settled) return
			checking = true
			try {
				const current = await retainedObservation(paths)
				if (current.outputBytes !== baseline.outputBytes || current.state !== baseline.state) finish(true)
			} catch (error) {
				fail(error)
			} finally {
				checking = false
				if (checkPending) {
					checkPending = false
					requestCheck()
				}
			}
		}

		watcher.once("error", fail)
		signal?.addEventListener("abort", onAbort, { once: true })
		requestCheck()
	})
}

async function retainedObservation(paths: TaskStoragePaths): Promise<{ outputBytes: number; state: Static<typeof TaskState> }> {
	let outputBytes = 0
	try {
		const stats = await lstat(paths.output)
		if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Retained log is not a regular file: ${paths.output}`)
		outputBytes = stats.size
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error
	}
	return { outputBytes, state: (await requireTaskMetadata(paths)).state }
}

function isActiveTaskState(state: Static<typeof TaskState>): boolean {
	return state === "queued" || state === "running" || state === "suspended"
}

function splitCompleteLines(content: string): string[] {
	if (!content) return []
	const lines = content.split("\n")
	if (content.endsWith("\n")) lines.pop()
	return lines
}

export function displayWorkspacePath(workspace: string, path: string): string {
	const display = relative(workspace, path)
	if (display === "" || display === ".." || display.startsWith(`..${sep}`) || isAbsolute(display)) return path
	return display.split(sep).join("/")
}

function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toISOString()
}

function isUtf8Continuation(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function abortReason(signal?: AbortSignal): unknown {
	return signal?.reason ?? new Error("Operation aborted")
}

async function ensureStorageGitignore(root: string): Promise<void> {
	const path = join(root, ".gitignore")
	try {
		await writePrivateFile(path, STORAGE_GITIGNORE)
	} catch (error) {
		if (hasCode(error, "EEXIST")) return
		throw error
	}
}

async function assertRegularDirectory(path: string): Promise<void> {
	const stats = await lstat(path)
	if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Lovely Agents storage path is not a regular directory: ${path}`)
}

async function ensurePrivateLogFile(path: string): Promise<void> {
	try {
		await writePrivateFile(path, "")
		return
	} catch (error) {
		if (!hasCode(error, "EEXIST")) throw error
	}
	const stats = await lstat(path)
	if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Retained log is not a regular file: ${path}`)
	await chmod(path, FILE_MODE)
}

async function readRetainedLog(path: string): Promise<string> {
	try {
		const stats = await lstat(path)
		if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Retained log is not a regular file: ${path}`)
		return await readFile(path, "utf8")
	} catch (error) {
		if (hasCode(error, "ENOENT")) return ""
		throw error
	}
}

function appendRetainedLog(path: string, content: string): Promise<void> {
	return serializeOperation(taskQueueState().logs, path, async () => {
		await ensurePrivateLogFile(path)
		const handle = await open(path, "a", FILE_MODE)
		try {
			await handle.writeFile(content, "utf8")
			await handle.sync()
		} finally {
			await handle.close()
		}
	})
}

async function loadParentLease(path: string): Promise<ParentLeaseLoadResult> {
	let source: string
	try {
		const stats = await lstat(path)
		if (!stats.isFile() || stats.isSymbolicLink()) return { status: "invalid", message: "lease is not a regular file" }
		source = await readFile(path, "utf8")
	} catch (error) {
		if (hasCode(error, "ENOENT")) return { status: "missing" }
		return { status: "invalid", message: errorMessage(error) }
	}

	let value: unknown
	try {
		value = JSON.parse(source)
	} catch (error) {
		return { status: "invalid", message: errorMessage(error) }
	}
	if (!Value.Check(ParentLeaseFileSchema, value)) {
		const error = Value.Errors(ParentLeaseFileSchema, value)[0]
		return { status: "invalid", message: error ? `${error.instancePath || "/"} ${error.message}` : "invalid lease data" }
	}
	return { status: "ok", lease: value }
}

async function writePrivateFile(path: string, content: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined
	let complete = false
	try {
		handle = await open(path, "wx", FILE_MODE)
		await handle.writeFile(content, "utf8")
		await handle.sync()
		complete = true
	} finally {
		await handle?.close()
		if (handle && !complete) await removeIfPresent(path)
	}
}

async function atomicWriteMetadata(path: string, metadata: TaskMetadata): Promise<void> {
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`)
	let handle: Awaited<ReturnType<typeof open>> | undefined
	let renamed = false
	try {
		handle = await open(temporary, "wx", FILE_MODE)
		await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8")
		await handle.sync()
		await handle.close()
		handle = undefined
		await rename(temporary, path)
		renamed = true
		await syncDirectory(dirname(path))
	} finally {
		await handle?.close()
		if (!renamed) await removeIfPresent(temporary)
	}
}

async function syncDirectory(path: string): Promise<void> {
	if (process.platform === "win32") return
	const handle = await open(path, "r")
	try {
		await handle.sync()
	} catch (error) {
		if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP")) throw error
	} finally {
		await handle.close()
	}
}

function serializeMetadataMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
	return serializeOperation(taskQueueState().metadata, path, operation)
}

function serializeOperation<T>(queues: Map<string, Promise<void>>, path: string, operation: () => Promise<T>): Promise<T> {
	const preceding = queues.get(path) ?? Promise.resolve()
	const result = preceding.then(operation)
	const tail = result.then(
		() => undefined,
		() => undefined
	)
	queues.set(path, tail)
	return result.finally(() => {
		if (queues.get(path) === tail) queues.delete(path)
	})
}

function parentLeaseState(): ParentLeaseState {
	const globals = globalThis as unknown as { [key: symbol]: unknown }
	const existing = globals[LEASE_STATE_SYMBOL]
	if (existing !== undefined) {
		if (!isParentLeaseState(existing)) throw new ParentLeaseError("Incompatible process-global Lovely Agents lease state")
		return existing
	}
	const state: ParentLeaseState = {
		version: PARENT_LEASE_VERSION,
		leases: new Map(),
		queues: new Map()
	}
	globals[LEASE_STATE_SYMBOL] = state
	return state
}

function taskQueueState(): TaskQueueState {
	const globals = globalThis as unknown as { [key: symbol]: unknown }
	const existing = globals[TASK_QUEUE_STATE_SYMBOL]
	if (existing !== undefined) {
		const candidate = existing as Partial<TaskQueueState>
		if (candidate.version !== 1 || !(candidate.metadata instanceof Map) || !(candidate.logs instanceof Map)) {
			throw new Error("Incompatible process-global Lovely Agents task queue state")
		}
		return candidate as TaskQueueState
	}
	const created: TaskQueueState = { version: 1, metadata: new Map(), logs: new Map() }
	globals[TASK_QUEUE_STATE_SYMBOL] = created
	return created
}

function isParentLeaseState(value: unknown): value is ParentLeaseState {
	return (
		isRecord(value) &&
		property(value, "version") === PARENT_LEASE_VERSION &&
		property(value, "leases") instanceof Map &&
		property(value, "queues") instanceof Map
	)
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		if (hasCode(error, "ESRCH")) return false
		if (hasCode(error, "EPERM")) return true
		throw error
	}
}

function invalidMetadata(path: string, code: MetadataDiagnostic["code"], message: string): MetadataLoadResult {
	return { status: "invalid", diagnostic: { code, message, path } }
}

function metadataLoadError(result: Exclude<MetadataLoadResult, { status: "ok" }>, path: string): string {
	return result.status === "missing" ? `Missing metadata: ${path}` : `${result.diagnostic.message}: ${result.diagnostic.path}`
}

function assertSessionId(value: string): void {
	if (!SESSION_ID_PATTERN.test(value)) throw new Error(`Invalid parent session ID: ${value}`)
}

function assertTaskReference(value: string): void {
	if (!TASK_REFERENCE_PATTERN.test(value)) throw new Error(`Invalid Task Reference: ${value}`)
}

async function removeIfPresent(path: string): Promise<void> {
	try {
		await unlink(path)
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error
	}
}

function hasCode(error: unknown, code: string): boolean {
	return isRecord(error) && property(error, "code") === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function property(record: Record<string, unknown>, key: string): unknown {
	return record[key]
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
