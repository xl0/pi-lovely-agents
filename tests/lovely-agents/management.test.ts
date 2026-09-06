import { describe, expect, test } from "bun:test"
import { readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import {
	clearFixtureTasks,
	openManagementUi,
	openTaskManagementUi,
	renderDefinition,
	seedFixtureEdgeCases,
	seedFixtureTasks,
	seedLiveFixtureTask
} from "../../extensions/lovely-agents/management.js"
import {
	appendHistoryLog,
	countRetainedOutputLines,
	ensureParentStorage,
	mutateTaskMetadata,
	readRetainedOutput,
	readTaskMetadata,
	releaseParentLeaseFor,
	reserveTaskStorage,
	taskStoragePaths
} from "../../extensions/lovely-agents/state.js"
import { loadTaskList } from "../../extensions/lovely-agents/tools.js"
import { withTempWorkspace } from "./test-helpers.js"

test("management Tasks hands off to the existing panel instead of opening another selector", async () => {
	let selectors = 0
	let focused = 0
	const ctx = {
		ui: {
			custom: async () => {
				selectors++
				if (selectors > 1) throw new Error("Duplicate selector")
				return "tasks"
			}
		}
	} as unknown as ExtensionContext
	await openManagementUi(ctx, {
		discoverDefinitions: () => ({ definitions: [], diagnostics: [], projectAgentsDir: undefined }),
		loadTasks: async () => ({ tasks: [], diagnostics: [], total: 0, capacity: { active: 0, limit: 4 } }),
		focusTasks: async () => {
			focused++
		},
		openConfig: async () => {},
		inputTask: async () => {},
		controlTask: async () => {}
	})
	expect(selectors).toBe(1)
	expect(focused).toBe(1)
})

describe("management fixtures", () => {
	test("cancelled foreground input does not show an acceptance notice", async () => {
		await withTempWorkspace(async workspace => {
			const [id] = await seedFixtureTasks(workspace.cwd, "parent")
			const notices: string[] = []
			let selected = false
			let inputs = 0
			await openTaskManagementUi(
				{
					cwd: workspace.cwd,
					sessionManager: { getSessionId: () => "parent" },
					ui: {
						custom: async () => {
							if (selected) return
							selected = true
							return "followup"
						},
						editor: async () => "More work",
						notify: (text: string) => notices.push(text)
					}
				} as unknown as ExtensionContext,
				{
					discoverDefinitions: () => ({ definitions: [], diagnostics: [], projectAgentsDir: undefined }),
					loadTasks: async () => (await loadTaskList(workspace.cwd, "parent")).details,
					focusTasks: async () => {},
					openConfig: async () => {},
					controlTask: async () => {},
					inputTask: async () => {
						inputs++
						return false
					}
				},
				`task:${id}`
			)
			expect(inputs).toBe(1)
			expect(notices).toEqual([])
			await releaseParentLeaseFor(workspace.cwd, "parent")
		})
	})

	test("task context shows retained inputs and prompts in a bounded, scrollable read-only view", async () => {
		await withTempWorkspace(async workspace => {
			const [id] = await seedFixtureTasks(workspace.cwd, "parent-session")
			if (!id) throw new Error("Missing fixture")
			const paths = taskStoragePaths(await ensureParentStorage(workspace.cwd, "parent-session"), id)
			await appendHistoryLog(paths, { type: "assistant", content: Array.from({ length: 80 }, (_, i) => `Line ${i} 界🙂`).join("\n") })
			await appendHistoryLog(paths, { type: "input", delivery: "steer", content: "Delivered steer", timestamp: Date.now() })
			await appendHistoryLog(paths, { type: "run-start", sequence: 2, kind: "followup", timestamp: Date.now() })
			await appendHistoryLog(paths, { type: "input", delivery: "followup", content: "Current Follow-up", timestamp: Date.now() })
			await mutateTaskMetadata(paths, metadata => {
				if (!metadata.activeRun) throw new Error("Missing fixture run")
				return {
					...metadata,
					lastRunSequence: 3,
					activeRun: { ...metadata.activeRun, id: "r_2222222222222222", sequence: 2, kind: "followup", input: "Current Follow-up" },
					queuedFollowUps: [{ id: "r_3333333333333333", sequence: 3, content: "Future Follow-up", acceptedAt: Date.now() }]
				}
			})
			let step = 0
			let renders = 0
			const terminal = { rows: 30 }
			const captured = "COMPOSED PROMPT\nIncludes tools, project context, and extension changes."
			await mutateTaskMetadata(paths, metadata => ({ ...metadata, effectiveSystemPrompt: captured }))
			const ctx = {
				cwd: workspace.cwd,
				sessionManager: { getSessionId: () => "parent-session" },
				ui: {
					custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
						const component = await factory(
							{
								terminal,
								requestRender: () => {
									renders++
								}
							} as never,
							{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
							{} as never,
							() => {}
						)
						const current = step++
						if (current % 2 === 0) {
							expect(component.render(100).join("\n")).toContain("Inputs / history")
							expect(component.render(100).join("\n")).toContain("System prompt")
							return current === 0 ? "history" : current < 4 ? "prompt" : null
						}
						const first = component.render(100).join("\n")
						if (current === 1) {
							expect(first).not.toContain("History: initial/Follow-up")
							expect(first).toContain("Current run 2")
							expect(first).toContain("Future Follow-up")
							expect(first).toContain("Exercise the Lovely Agents development UI.")
							component.handleInput?.("\x1b[6~") // PageDown
							expect(component.render(100).join("\n")).not.toBe(first)
							component.handleInput?.("\x1b[5~") // PageUp
							expect(component.render(100).join("\n")).toBe(first)
							component.handleInput?.("\x1b[F") // End
							expect(component.render(100).join("\n")).toContain("Delivered steer")
							expect(component.render(100).join("\n")).toContain("Current Follow-up")
							for (const width of [1, 12, 100]) {
								const lines = component.render(width)
								expect(lines.length).toBeLessThanOrEqual(18)
								expect(lines.every(line => visibleWidth(line) <= width)).toBe(true)
							}
							terminal.rows = 12
							expect(component.render(100).length).toBeLessThanOrEqual(7)
							terminal.rows = 30
							component.handleInput?.("\x1b[H") // Home
							expect(component.render(100).join("\n")).toBe(first)
						} else {
							expect(
								component
									.render(100)
									.slice(1, -1)
									.map(line => line.trimEnd())
									.join("\n")
							).toBe(captured)
						}
						return undefined
					}
				}
			} as unknown as ExtensionContext
			try {
				await openTaskManagementUi(
					ctx,
					{
						discoverDefinitions: () => {
							throw new Error("Must use the frozen prompt, not current Definitions")
						},
						loadTasks: async () => (await loadTaskList(workspace.cwd, "parent-session")).details,
						focusTasks: async () => {},
						openConfig: async () => {},
						inputTask: async () => {
							throw new Error("Read-only view sent input")
						},
						controlTask: async () => {
							throw new Error("Read-only view controlled task")
						}
					},
					`task:${id}`
				)
				expect(step).toBe(5)
				expect(renders).toBeGreaterThan(0)
			} finally {
				await clearFixtureTasks(workspace.cwd, "parent-session")
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})

	test("renders the Agent Definition body in its preview", () => {
		const preview = renderDefinition({
			name: "reviewer",
			description: "Review changes",
			systemPrompt: "Inspect the complete diff.\nReport concrete defects.",
			source: "project",
			filePath: "/workspace/.pi/agents/reviewer.md",
			displayPath: ".pi/agents/reviewer.md"
		})
		expect(preview).toContain("Body:\nInspect the complete diff.\nReport concrete defects.")
	})

	test("a missing capture reports separately instead of substituting prompt content", async () => {
		await withTempWorkspace(async workspace => {
			const [id] = await seedFixtureTasks(workspace.cwd, "parent-session")
			let menus = 0
			const notices: string[] = []
			const ctx = {
				cwd: workspace.cwd,
				sessionManager: { getSessionId: () => "parent-session" },
				ui: {
					custom: async () => (menus++ === 0 ? "prompt" : null),
					notify: (message: string) => notices.push(message)
				}
			} as unknown as ExtensionContext
			try {
				await openTaskManagementUi(
					ctx,
					{
						discoverDefinitions: () => ({ definitions: [], diagnostics: [], projectAgentsDir: undefined }),
						loadTasks: async () => (await loadTaskList(workspace.cwd, "parent-session")).details,
						focusTasks: async () => {},
						openConfig: async () => {},
						inputTask: async () => {},
						controlTask: async () => {}
					},
					`task:${id}`
				)
				expect(menus).toBe(2)
				expect(notices).toEqual(["No system prompt captured for this run."])
			} finally {
				await clearFixtureTasks(workspace.cwd, "parent-session")
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})

	test("seeds every visible state and removes only marked fixtures", async () => {
		await withTempWorkspace(async workspace => {
			const ids = await seedFixtureTasks(workspace.cwd, "parent-session")
			expect(ids).toHaveLength(7)
			expect(ids.every(id => /^a_[0-9a-f]{8}$/.test(id))).toBe(true)

			const parent = await ensureParentStorage(workspace.cwd, "parent-session")
			const loaded = await Promise.all(ids.map(id => readTaskMetadata(taskStoragePaths(parent, id))))
			const metadata = loaded.flatMap(result => (result.status === "ok" ? [result.metadata] : []))
			expect(metadata.map(task => task.state).sort()).toEqual(["idle", "idle", "idle", "interrupted", "queued", "running", "suspended"])
			expect(
				metadata
					.map(task => task.latestOutcome)
					.filter(Boolean)
					.sort()
			).toEqual(["failed", "interrupted", "stopped", "succeeded"])
			expect(metadata.every(task => task.definitionName === "lovely-fixture")).toBe(true)
			expect(await Promise.all(ids.map(id => countRetainedOutputLines(taskStoragePaths(parent, id))))).not.toContain(0)

			const foreignFixture = await reserveTaskStorage(parent, () => "a_ffffffff")
			await writeFile(join(foreignFixture.taskDirectory, ".fixture"), "another-parent")
			expect(await clearFixtureTasks(workspace.cwd, "parent-session")).toBe(7)
			expect((await stat(foreignFixture.taskDirectory)).isDirectory()).toBe(true)
			const first = ids[0]
			if (!first) throw new Error("Fixture task was not created")
			await expect(stat(taskStoragePaths(parent, first).taskDirectory)).rejects.toMatchObject({ code: "ENOENT" })
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("seeds nested, queued, discarded, corrupt, and large-output cases", async () => {
		await withTempWorkspace(async workspace => {
			const ids = await seedFixtureEdgeCases(workspace.cwd, "parent-session")
			expect(ids).toHaveLength(3)
			const [showcaseId, discardedId, corruptId] = ids
			if (!showcaseId || !discardedId || !corruptId) throw new Error("Edge-case fixtures were not created")
			const parent = await ensureParentStorage(workspace.cwd, "parent-session")
			const showcase = await readTaskMetadata(taskStoragePaths(parent, showcaseId))
			expect(showcase.status).toBe("ok")
			if (showcase.status !== "ok") throw new Error("Showcase fixture is invalid")
			expect(showcase.metadata.queuedFollowUps).toHaveLength(1)
			expect((await stat(taskStoragePaths(parent, showcaseId).history)).size).toBeGreaterThan(50_000)

			const descendantParent = await ensureParentStorage(workspace.cwd, showcase.metadata.childSessionId)
			const descendants = (await readdir(descendantParent.parentDirectory)).filter(name => /^a_[0-9a-f]{8}$/.test(name))
			expect(descendants).toHaveLength(1)
			const discarded = await readTaskMetadata(taskStoragePaths(parent, discardedId))
			expect(discarded.status).toBe("ok")
			if (discarded.status !== "ok") throw new Error("Discarded fixture is invalid")
			expect(discarded.metadata.discardedAt).not.toBeNull()
			expect((await readTaskMetadata(taskStoragePaths(parent, corruptId))).status).toBe("invalid")

			expect(await clearFixtureTasks(workspace.cwd, "parent-session")).toBe(4)
			expect((await readdir(descendantParent.parentDirectory)).filter(name => /^a_[0-9a-f]{8}$/.test(name))).toHaveLength(0)
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})

	test("live fixtures produce observable output growth", async () => {
		await withTempWorkspace(async workspace => {
			const id = await seedLiveFixtureTask(workspace.cwd, "parent-session")
			const parent = await ensureParentStorage(workspace.cwd, "parent-session")
			const paths = taskStoragePaths(parent, id)
			const update = await readRetainedOutput(paths, { waitMs: 2_000 })
			expect(update.timedOut).toBe(false)
			expect(update.text).toContain("Fixture update 1")
			let completion = update
			for (let attempt = 0; attempt < 6 && completion.state !== "idle"; attempt++) {
				completion = await readRetainedOutput(paths, { waitMs: 1_000 })
			}
			expect(completion.timedOut).toBe(false)
			expect(completion.state).toBe("idle")
			expect(await clearFixtureTasks(workspace.cwd, "parent-session")).toBe(1)
			await releaseParentLeaseFor(workspace.cwd, "parent-session")
		})
	})
})
