import { describe, expect, test } from "bun:test"
import { readdir, readFile, readlink, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { getAgentCoordinator } from "../../extensions/lovely-agents/coordinator.js"
import { discardTask, reconcileParentTasks, recoverOwnedTaskTree, stopOwnedTaskTree } from "../../extensions/lovely-agents/lifecycle.js"
import {
	acquireParentLease,
	ensureParentStorage,
	initializeRetainedLogs,
	mutateTaskMetadata,
	readTaskMetadata,
	releaseParentLeaseFor,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	type TaskMetadata,
	type TaskStoragePaths,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import { withTempWorkspace } from "./test-helpers.js"

describe("task lifecycle recovery", () => {
	test("failed stop/discard retains borrowed tree leases until retry succeeds", async () => {
		for (const action of ["stop", "discard"] as const) {
			await withTempWorkspace(async workspace => {
				const owner = await createTask(workspace.cwd, "parent", "a_00000001", "child", "running")
				const failing = await createTask(workspace.cwd, "child", "a_00000002", "grandchild", "running")
				const sibling = await createTask(workspace.cwd, "child", "b_00000003", "", "running")
				const leaf = await createTask(workspace.cwd, "grandchild", "b_00000004", "", "running")
				const ids = ["parent", "child", "grandchild"]
				const leases = await Promise.all(ids.map(id => acquireParentLease(workspace.cwd, id)))
				const originals = await Promise.all(leases.map(lease => readFile(lease.paths.lease, "utf8")))
				const unbind = getAgentCoordinator().bindResident(failing.taskDirectory, {
					stop() {
						throw new Error("cleanup failed")
					},
					dispose() {}
				})
				const run = () => (action === "stop" ? stopOwnedTaskTree(workspace.cwd, "parent") : discardTask(owner))
				try {
					await expect(run()).rejects.toThrow()
					expect(getAgentCoordinator().getResident(failing.taskDirectory)).toBeDefined()
					expect(await Promise.all(leases.map(lease => readFile(lease.paths.lease, "utf8")))).toEqual(originals)
					if (action === "stop") {
						for (const paths of [sibling, leaf]) {
							expect(await readTaskMetadata(paths)).toMatchObject({ metadata: { state: "idle", latestOutcome: "stopped" } })
						}
					}
					const probe = Bun.spawn(
						[
							"bun",
							"-e",
							`
						import { acquireParentLease, releaseParentLease } from ${JSON.stringify(join(import.meta.dir, "../../extensions/lovely-agents/state.ts"))};
						for (const id of ["child", "grandchild"]) {
							try {
								const lease = await acquireParentLease(${JSON.stringify(workspace.cwd)}, id);
								await releaseParentLease(lease);
								throw new Error("Unexpectedly acquired live partition " + id);
							} catch (error) {
								if (error.code !== "LOVELY_AGENTS_PARENT_LEASE_CONFLICT") throw error;
								console.log(id + ": conflict");
							}
						}
					`
						],
						{ stdout: "pipe", stderr: "pipe" }
					)
					expect(await probe.exited).toBe(0)
					expect(await new Response(probe.stdout).text()).toBe("child: conflict\ngrandchild: conflict\n")
					unbind()
					await run()
					for (const lease of leases) {
						if (action === "discard" && lease.paths.parentSessionId === "parent") {
							expect(JSON.parse(await readFile(lease.paths.lease, "utf8")).token).toBe(lease.token)
						} else {
							await expect(stat(lease.paths.lease)).rejects.toMatchObject({ code: "ENOENT" })
						}
					}
				} finally {
					unbind()
					for (const id of ids) await releaseParentLeaseFor(workspace.cwd, id)
				}
			})
		}
	})

	test("interrupts stale Bash once without reviving processes, and skips resident Bash across reload", async () => {
		await withTempWorkspace(async workspace => {
			const stale = await createTask(workspace.cwd, "parent", "b_00000001", "", "running")
			const live = await createTask(workspace.cwd, "parent", "b_00000002", "", "running")
			const stable = await createTask(workspace.cwd, "parent", "b_00000003", "", "idle")
			const unbind = getAgentCoordinator().bindResident(live.taskDirectory, {
				stop() {
					throw new Error("Reconciliation must not stop residents")
				},
				dispose() {},
				recover() {
					throw new Error("Bash cannot recover")
				}
			})
			try {
				expect(await reconcileParentTasks(workspace.cwd, "parent")).toEqual({ interrupted: 1, diagnostics: [] })
				expect(await readTaskMetadata(stale)).toMatchObject({
					metadata: {
						kind: "bash",
						state: "interrupted",
						latestOutcome: "interrupted",
						activeRun: null,
						exitCode: null,
						signal: null,
						notifications: [{ type: "interruption" }]
					}
				})
				expect(await readTaskMetadata(live)).toMatchObject({ metadata: { state: "running" } })
				expect(await readTaskMetadata(stable)).toMatchObject({ metadata: { state: "idle", notifications: [] } })
				expect(await reconcileParentTasks(workspace.cwd, "parent")).toEqual({ interrupted: 0, diagnostics: [] })
				expect(await recoverOwnedTaskTree(workspace.cwd, "parent")).toEqual({ resumed: 0, diagnostics: [] })
				expect((await readdir(stale.root)).sort()).toEqual([".gitignore", "parent"])
			} finally {
				unbind()
				await releaseParentLeaseFor(workspace.cwd, "parent")
			}
		})
	})

	test("stops mixed descendants and discards in place, retaining Bash output without session files", async () => {
		await withTempWorkspace(async workspace => {
			const agent = await createTask(workspace.cwd, "parent", "a_00000001", "child", "running")
			const bash = await createTask(workspace.cwd, "child", "b_00000001", "", "running")
			const foreign = await createTask(workspace.cwd, "foreign", "b_00000002", "", "running")
			await writeFile(bash.output, "retained output")
			let stops = 0
			const unbind = getAgentCoordinator().bindResident(bash.taskDirectory, {
				async stop() {
					stops++
					await mutateTaskMetadata(bash, metadata => ({
						...metadata,
						state: "idle",
						activeRun: null,
						latestOutcome: "stopped",
						updatedAt: Date.now()
					}))
				},
				dispose() {}
			})
			try {
				await stopOwnedTaskTree(workspace.cwd, "parent")
				expect(stops).toBe(1)
				expect(await readTaskMetadata(bash)).toMatchObject({ metadata: { state: "idle", latestOutcome: "stopped" } })
				expect(await readTaskMetadata(foreign)).toMatchObject({ metadata: { state: "running" } })
			} finally {
				unbind()
			}
			await discardTask(agent)
			await discardTask(agent)
			expect(await readFile(bash.output, "utf8")).toBe("retained output")
			expect((await readdir(bash.taskDirectory)).sort()).toEqual(["history.md", "metadata.json", "output.log"])
			for (const paths of [agent, bash]) {
				expect(await readTaskMetadata(paths)).toMatchObject({ status: "ok", metadata: { discardedAt: expect.any(Number) } })
				await expect(readlink(join(paths.parentDirectory, "active", paths.taskRef))).rejects.toMatchObject({ code: "ENOENT" })
			}
			expect(await reconcileParentTasks(workspace.cwd, "parent")).toEqual({ interrupted: 0, diagnostics: [] })
			await releaseParentLeaseFor(workspace.cwd, "parent")
		})
	})

	test("interrupts foreground or unspecified-policy work without notices or recovery", async () => {
		await withTempWorkspace(async workspace => {
			const paths = await createTask(workspace.cwd, "parent", "a_70000005", "child", "suspended")
			await mutateTaskMetadata(paths, metadata => {
				if (!metadata.activeRun) throw new Error("Missing run")
				const { background: _background, ...activeRun } = metadata.activeRun
				return { ...metadata, activeRun }
			})
			let recovered = false
			const unbind = getAgentCoordinator().bindResident(paths.taskDirectory, {
				stop() {},
				dispose() {},
				recover() {
					recovered = true
					return true
				}
			})
			expect(await recoverOwnedTaskTree(workspace.cwd, "parent")).toEqual({ resumed: 0, diagnostics: [] })
			expect(recovered).toBe(false)
			unbind()
			expect(await reconcileParentTasks(workspace.cwd, "parent")).toEqual({ interrupted: 1, diagnostics: [] })
			const loaded = await readTaskMetadata(paths)
			expect(loaded.status === "ok" ? loaded.metadata : null).toMatchObject({ state: "interrupted", notifications: [] })
			await releaseParentLeaseFor(workspace.cwd, "parent")
		})
	})

	test("marks stale accepted work interrupted and records one notification", async () => {
		await withTempWorkspace(async workspace => {
			const paths = await createTask(workspace.cwd, "parent", "a_11111111", "child", "running")
			const result = await reconcileParentTasks(workspace.cwd, "parent")
			expect(result).toEqual({ interrupted: 1, diagnostics: [] })
			const loaded = await readTaskMetadata(paths)
			expect(loaded.status === "ok" ? loaded.metadata : null).toMatchObject({
				state: "interrupted",
				latestOutcome: "interrupted",
				activeRun: null,
				queuedFollowUps: [],
				notifications: [{ id: "a_11111111:r_1111111111111111:interruption", type: "interruption" }]
			})
			expect(await readFile(paths.history, "utf8")).toContain("interrupted")
			expect(await reconcileParentTasks(workspace.cwd, "parent")).toEqual({ interrupted: 0, diagnostics: [] })
			const repeated = await readTaskMetadata(paths)
			expect(repeated.status === "ok" ? repeated.metadata.notifications : []).toHaveLength(1)
			await releaseParentLeaseFor(workspace.cwd, "parent")
		})
	})

	test("recursively stops retained work and clears queued follow-ups", async () => {
		await withTempWorkspace(async workspace => {
			const direct = await createTask(workspace.cwd, "parent", "a_22222222", "child", "running")
			const nested = await createTask(workspace.cwd, "child", "a_33333333", "grandchild", "suspended")
			await stopOwnedTaskTree(workspace.cwd, "parent")
			for (const paths of [direct, nested]) {
				const loaded = await readTaskMetadata(paths)
				expect(loaded.status === "ok" ? loaded.metadata : null).toMatchObject({
					state: "idle",
					latestOutcome: "stopped",
					activeRun: null,
					queuedFollowUps: []
				})
			}
			expect(await releaseParentLeaseFor(workspace.cwd, "parent")).toBe(false)
			expect(await releaseParentLeaseFor(workspace.cwd, "child")).toBe(false)
		})
	})

	test("reconciles queued, running, and suspended state while preserving stable records", async () => {
		await withTempWorkspace(async workspace => {
			const fixtures = [
				["a_50000001", "queued"],
				["a_50000002", "running"],
				["a_50000003", "suspended"],
				["a_50000004", "idle"],
				["a_50000005", "interrupted"]
			] as const
			const paths = await Promise.all(
				fixtures.map(([id, state], index) => createTask(workspace.cwd, "parent", id, `child-${index}`, state))
			)
			expect((await reconcileParentTasks(workspace.cwd, "parent")).interrupted).toBe(3)
			const states = await Promise.all(
				paths.map(async path => {
					const loaded = await readTaskMetadata(path)
					return loaded.status === "ok" ? loaded.metadata.state : null
				})
			)
			expect(states).toEqual(["interrupted", "interrupted", "interrupted", "idle", "interrupted"])
			await releaseParentLeaseFor(workspace.cwd, "parent")
		})
	})

	test("does not interrupt a process-resident run", async () => {
		await withTempWorkspace(async workspace => {
			const paths = await createTask(workspace.cwd, "parent", "a_44444444", "child", "queued")
			const unbind = getAgentCoordinator().bindResident(paths.taskDirectory, {
				stop: async () => {},
				dispose: () => {}
			})
			try {
				expect(await reconcileParentTasks(workspace.cwd, "parent")).toEqual({ interrupted: 0, diagnostics: [] })
				const loaded = await readTaskMetadata(paths)
				expect(loaded.status === "ok" ? loaded.metadata.state : null).toBe("queued")
			} finally {
				unbind()
				await releaseParentLeaseFor(workspace.cwd, "parent")
			}
		})
	})

	test("recovers only resident suspended work in the owned tree", async () => {
		await withTempWorkspace(async workspace => {
			const direct = await createTask(workspace.cwd, "parent", "a_70000001", "child", "suspended")
			const nested = await createTask(workspace.cwd, "child", "a_70000002", "grandchild", "suspended")
			const unrelated = await createTask(workspace.cwd, "other", "a_70000003", "other-child", "suspended")
			const recovered: string[] = []
			const unbind = [direct, nested, unrelated].map(paths =>
				getAgentCoordinator().bindResident(paths.taskDirectory, {
					stop() {},
					dispose() {},
					recover() {
						recovered.push(paths.taskRef)
						return true
					}
				})
			)
			try {
				expect(await recoverOwnedTaskTree(workspace.cwd, "parent")).toEqual({ resumed: 2, diagnostics: [] })
				expect(recovered).toEqual(["a_70000001", "a_70000002"])
			} finally {
				for (const remove of unbind) remove()
			}
		})
	})

	test("reports suspended work without a resident runtime", async () => {
		await withTempWorkspace(async workspace => {
			await createTask(workspace.cwd, "parent", "a_70000004", "child", "suspended")
			const result = await recoverOwnedTaskTree(workspace.cwd, "parent")
			expect(result.resumed).toBe(0)
			expect(result.diagnostics).toHaveLength(1)
			expect(result.diagnostics[0]).toContain("suspended task has no recoverable resident")
		})
	})

	test("reports malformed direct records without deleting orphaned files", async () => {
		await withTempWorkspace(async workspace => {
			const paths = await reserveTaskStorage(await ensureParentStorage(workspace.cwd, "parent"), () => "a_66666666")
			await initializeRetainedLogs(paths)
			await writeFile(paths.metadata, "{}\n", "utf8")
			const result = await reconcileParentTasks(workspace.cwd, "parent")
			expect(result.interrupted).toBe(0)
			expect(result.diagnostics).toHaveLength(1)
			expect((await stat(paths.taskDirectory)).isDirectory()).toBe(true)
			await releaseParentLeaseFor(workspace.cwd, "parent")
		})
	})
})

async function createTask(
	cwd: string,
	parentSessionId: string,
	id: string,
	childSessionId: string,
	state: TaskMetadata["state"]
): Promise<TaskStoragePaths> {
	const paths = await reserveTaskStorage(await ensureParentStorage(cwd, parentSessionId), () => id)
	await initializeRetainedLogs(paths)
	await writeTaskMetadata(paths, {
		version: TASK_METADATA_VERSION,
		...(id.startsWith("b_")
			? { kind: "bash" as const, command: "sleep 60", cwd, exitCode: null, signal: null }
			: {
					kind: "agent" as const,
					childSessionId,
					definitionName: "reviewer",
					model: { provider: "provider", id: "model" },
					thinking: "medium" as const,
					allowAgents: false,
					sessionConfig: {
						systemPrompt: "Review work.",
						tools: null,
						excludeAgentsMd: false,
						scopedModels: [{ provider: "provider", id: "model" }]
					},
					depth: 1
				}),
		taskRef: id,
		parentSessionId,
		label: id,
		createdAt: 1,
		updatedAt: 1,
		state,
		latestOutcome: state === "interrupted" ? "interrupted" : null,
		activeRun:
			state === "idle" || state === "interrupted"
				? null
				: {
						id: "r_1111111111111111",
						sequence: 1,
						kind: "initial",
						background: true,
						state,
						input: "work",
						acceptedAt: 1,
						...(state === "queued" ? {} : { startedAt: 2 })
					},
		lastRunSequence: id.startsWith("b_") ? 1 : 2,
		latestReply: null,
		queuedFollowUps: id.startsWith("b_") ? [] : [{ id: "r_2222222222222222", sequence: 2, content: "later", acceptedAt: 2 }],
		notifications: [],
		discardedAt: null
	} satisfies TaskMetadata)
	return paths
}
