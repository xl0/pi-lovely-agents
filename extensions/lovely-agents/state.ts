import { randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { type Static, Type } from "typebox"
import { Value } from "typebox/value"

export const TASK_METADATA_VERSION = 1
export const TASK_REFERENCE_PATTERN = /^a_[0-9a-f]{8}$/
export const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
export const STORAGE_GITIGNORE = "*\n!.gitignore\n"
export const MAX_AGENT_INPUT_BYTES = 64 * 1024
export const MAX_AGENT_LABEL_BYTES = 80

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const MAX_TASK_REFERENCE_ATTEMPTS = 100
const DEFINITION_NAME_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$"

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
		content: Type.String(),
		createdAt: Timestamp,
		deliveredAt: Type.Optional(Timestamp)
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
		state: TaskState,
		latestOutcome: Type.Union([RunOutcome, Type.Null()]),
		lastRunSequence: Type.Integer({ minimum: 0 }),
		activeRun: Type.Union([ActiveRun, Type.Null()]),
		queuedFollowUps: Type.Array(QueuedFollowUp, { maxItems: 32 }),
		notifications: Type.Array(Notification),
		discardedAt: Type.Union([Timestamp, Type.Null()]),
		createdAt: Timestamp,
		updatedAt: Timestamp
	},
	{ additionalProperties: false }
)

export type TaskMetadata = Static<typeof TaskMetadataSchema>

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

export type MetadataDiagnostic = {
	code: "unreadable" | "invalid-json" | "unsupported-version" | "invalid-metadata"
	message: string
	path: string
}

export type MetadataLoadResult =
	| { status: "ok"; metadata: TaskMetadata }
	| { status: "missing" }
	| { status: "invalid"; diagnostic: MetadataDiagnostic }

export class InvalidTaskMetadataError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "InvalidTaskMetadataError"
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

async function ensureStorageGitignore(root: string): Promise<void> {
	const path = join(root, ".gitignore")
	let handle: Awaited<ReturnType<typeof open>> | undefined
	let complete = false
	try {
		handle = await open(path, "wx", FILE_MODE)
		await handle.writeFile(STORAGE_GITIGNORE, "utf8")
		await handle.sync()
		complete = true
	} catch (error) {
		if (hasCode(error, "EEXIST")) return
		throw error
	} finally {
		await handle?.close()
		if (handle && !complete) await removeIfPresent(path)
	}
}

async function assertRegularDirectory(path: string): Promise<void> {
	const stats = await lstat(path)
	if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Lovely Agents storage path is not a regular directory: ${path}`)
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

const metadataMutationQueues = new Map<string, Promise<void>>()

function serializeMetadataMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const preceding = metadataMutationQueues.get(path) ?? Promise.resolve()
	const result = preceding.then(operation)
	const tail = result.then(
		() => undefined,
		() => undefined
	)
	metadataMutationQueues.set(path, tail)
	return result.finally(() => {
		if (metadataMutationQueues.get(path) === tail) metadataMutationQueues.delete(path)
	})
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
