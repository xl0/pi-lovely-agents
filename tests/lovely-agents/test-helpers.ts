import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
	acquireParentLease,
	appendHistoryLog,
	ensureParentStorage,
	initializeRetainedLogs,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	type TaskMetadata,
	type TaskStoragePaths,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"

export type TempWorkspace = {
	root: string
	cwd: string
	agentDir: string
	write(path: string, content: string): Promise<string>
}

export async function withTempWorkspace<T>(run: (workspace: TempWorkspace) => Promise<T> | T): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "lovely-agents-"))
	const cwd = join(root, "workspace")
	const agentDir = join(root, "agent")
	await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })])
	try {
		return await run({
			root,
			cwd,
			agentDir,
			async write(path, content) {
				const target = join(root, path)
				await mkdir(dirname(target), { recursive: true })
				await writeFile(target, content, "utf8")
				return target
			}
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

export function definitionSource(name: string, description = `Description for ${name}`, extra = ""): string {
	return `---\nname: ${name}\ndescription: ${description}${extra}\n---\n\nSystem prompt for ${name}.\n`
}

/** One retained agent task per state/outcome, for UI and lifecycle tests. */
export async function seedFixtureTasks(cwd: string, parentSessionId: string): Promise<string[]> {
	await acquireParentLease(cwd, parentSessionId)
	const fixtures: Array<{ label: string; state: TaskMetadata["state"]; outcome: TaskMetadata["latestOutcome"] }> = [
		{ label: "Running", state: "running", outcome: null },
		{ label: "Queued", state: "queued", outcome: null },
		{ label: "Interrupted", state: "interrupted", outcome: "interrupted" },
		{ label: "Succeeded", state: "idle", outcome: "succeeded" },
		{ label: "Failed", state: "idle", outcome: "failed" },
		{ label: "Stopped", state: "idle", outcome: "stopped" }
	]
	const ids: string[] = []
	for (const fixture of fixtures) {
		const paths = await createFixtureTask(cwd, parentSessionId, `[fixture] ${fixture.label}`, fixture.state, fixture.outcome)
		ids.push(paths.taskRef)
	}
	return ids
}

export async function createFixtureTask(
	cwd: string,
	parentSessionId: string,
	label: string,
	state: TaskMetadata["state"],
	latestOutcome: TaskMetadata["latestOutcome"]
): Promise<TaskStoragePaths> {
	const paths = await reserveTaskStorage(await ensureParentStorage(cwd, parentSessionId))
	await initializeRetainedLogs(paths)
	const now = Date.now()
	const active = state === "queued" || state === "running"
	const metadata: TaskMetadata = {
		version: TASK_METADATA_VERSION,
		kind: "agent",
		taskRef: paths.taskRef,
		parentSessionId,
		childSessionId: `fixture-${randomBytes(8).toString("hex")}`,
		definitionName: "lovely-fixture",
		label,
		model: { provider: "fixture", id: "dummy" },
		thinking: "off",
		depth: 1,
		allowAgents: false,
		sessionConfig: {
			systemPrompt: "Development fixture agent.",
			tools: null,
			excludeAgentsMd: false,
			scopedModels: [{ provider: "fixture", id: "dummy" }]
		},
		state,
		latestOutcome,
		latestReply: { text: `${state} fixture output.`, streaming: false },
		lastRunSequence: 1,
		activeRun: active
			? {
					id: `r_${randomBytes(8).toString("hex")}`,
					sequence: 1,
					kind: "initial",
					state,
					input: "Exercise the Lovely Agents development UI.",
					acceptedAt: now,
					...(state === "queued" ? {} : { startedAt: now }),
					detachedAt: now
				}
			: null,
		queuedFollowUps: [],
		notifications: [],
		discardedAt: null,
		createdAt: now,
		updatedAt: now
	}
	await writeTaskMetadata(paths, metadata)
	await appendHistoryLog(paths, { type: "run-start", sequence: 1, kind: "initial" })
	await appendHistoryLog(paths, {
		type: "user",
		content: "Exercise the Lovely Agents development UI."
	})
	await appendHistoryLog(paths, { type: "assistant", content: `${state} fixture output.` })
	if (!active) await appendHistoryLog(paths, { type: "run-end", sequence: 1, outcome: latestOutcome ?? "succeeded" })
	await appendHistoryLog(paths, {
		type: "tool",
		tool: "fixture",
		arguments: JSON.stringify({ state }),
		result: "Fixture task created",
		isError: false
	})
	return paths
}
