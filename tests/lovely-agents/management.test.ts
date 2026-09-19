import { describe, expect, test } from "bun:test"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { openManagementUi, openTaskManagementUi } from "../../extensions/lovely-agents/management.js"
import {
	acquireParentLease,
	appendHistoryLog,
	ensureParentStorage,
	initializeRetainedLogs,
	mutateTaskMetadata,
	releaseParentLeaseFor,
	reserveTaskStorage,
	TASK_METADATA_VERSION,
	type TaskMetadata,
	taskStoragePaths,
	writeTaskMetadata
} from "../../extensions/lovely-agents/state.js"
import { loadTaskList, type TaskListRow } from "../../extensions/lovely-agents/tools.js"
import { seedFixtureTasks, withTempWorkspace } from "./test-helpers.js"

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
		loadTasks: async () => ({
			tasks: [],
			diagnostics: [],
			total: 0,
			capacity: { active: 0, limit: 4 },
			bashCapacity: { active: 0, limit: 4 }
		}),
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
	test("Bash actions expose literal stdin and EOF, not agent controls or invented model fields", async () => {
		const task = {
			id: "b_12345678",
			kind: "bash",
			label: "Input pipe",
			state: "running",
			latestOutcome: null,
			command: "cat",
			cwd: "/workspace",
			exitCode: null,
			signal: null,
			queuedFollowUps: 0,
			outputLines: 0,
			lastActivity: null,
			queueReason: null,
			paths: { history: "history.md", output: "output.log" }
		} as TaskListRow
		const inputs: unknown[][] = []
		let step = 0
		const ctx = {
			ui: {
				editor: async () => " \n",
				confirm: async () => true,
				notify() {},
				custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
					const component = await factory(
						{ terminal: { rows: 40 }, requestRender() {} } as never,
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
						{} as never,
						() => {}
					)
					const text = component.render(120).join("\n")
					const current = step++
					if (current === 1) {
						expect(text).toContain("Command: cat")
						expect(text).toContain("Output: output.log")
						expect(text).not.toMatch(/Model:|Definition:|Session:|undefined/)
						return
					}
					expect(text).toContain("Write stdin")
					expect(text).toContain("Close stdin")
					expect(text).not.toMatch(/System prompt|Follow-up|Steer/)
					return current === 0 ? "details" : current === 2 ? "stdin" : current === 3 ? "eof" : undefined
				}
			}
		} as unknown as ExtensionContext
		await openTaskManagementUi(
			ctx,
			{
				discoverDefinitions: () => ({ definitions: [], diagnostics: [], projectAgentsDir: undefined }),
				loadTasks: async () => ({
					tasks: [task],
					diagnostics: [],
					total: 1,
					capacity: { active: 0, limit: 4 },
					bashCapacity: { active: 1, limit: 4 }
				}),
				focusTasks: async () => {},
				openConfig: async () => {},
				controlTask: async () => {},
				inputTask: async (...args) => {
					inputs.push(args)
				}
			},
			`task:${task.id}`
		)
		expect(inputs).toEqual([
			[task.id, " \n", "stdin"],
			[task.id, "", "stdin", true]
		])
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
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
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
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})

	test("agent live output starts at the top and uses bounded viewport navigation", async () => {
		await withTempWorkspace(async workspace => {
			const [id] = await seedFixtureTasks(workspace.cwd, "parent-session")
			if (!id) throw new Error("Missing fixture")
			const paths = taskStoragePaths(await ensureParentStorage(workspace.cwd, "parent-session"), id)
			await mutateTaskMetadata(paths, metadata => ({
				...metadata,
				progress: "Checking the fix",
				latestReply: { text: Array.from({ length: 40 }, (_, index) => `Agent line ${index}`).join("\n"), streaming: false }
			}))
			let step = 0
			let renders = 0
			const ctx = {
				cwd: workspace.cwd,
				sessionManager: { getSessionId: () => "parent-session" },
				ui: {
					custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
						const component = await factory(
							{ terminal: { rows: 12 }, requestRender: () => renders++ } as never,
							{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
							{} as never,
							() => {}
						)
						const current = step++
						if (current === 0) return "output"
						if (current > 1) return null
						const first = component.render(80).join("\n")
						expect(first).toContain("Agent line 0")
						expect(first).toContain('Progress: "Checking the fix"')
						expect(first).not.toContain("Exit code:")
						expect(first).not.toContain("Agent line 39")
						expect(first).toContain("1-")
						component.handleInput?.("\x1b[6~") // PageDown
						const paged = component.render(80).join("\n")
						expect(paged).not.toBe(first)
						component.handleInput?.("\x1b[F") // End
						expect(component.render(80).join("\n")).toContain("Agent line 39")
						component.handleInput?.("\x1b[H") // Home
						expect(component.render(80).join("\n")).toBe(first)
						for (const width of [1, 20, 80]) {
							const lines = component.render(width)
							expect(lines.length).toBeLessThanOrEqual(7)
							expect(lines.every(line => visibleWidth(line) <= width)).toBe(true)
						}
						return undefined
					}
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
				expect(step).toBe(3)
				expect(renders).toBeGreaterThan(0)
			} finally {
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})

	test.each([
		{ exitCode: 0, signal: null, latestOutcome: "succeeded" },
		{ exitCode: 7, signal: null, latestOutcome: "failed" },
		{ exitCode: null, signal: "SIGTERM", latestOutcome: "failed" }
	] as const)("bash live output follows navigation and shows termination %j", async termination => {
		await withTempWorkspace(async workspace => {
			await acquireParentLease(workspace.cwd, "parent-session")
			const paths = await reserveTaskStorage(await ensureParentStorage(workspace.cwd, "parent-session"), () => "b_1234abcd")
			await initializeRetainedLogs(paths)
			const now = Date.now()
			const metadata: TaskMetadata = {
				version: TASK_METADATA_VERSION,
				kind: "bash",
				taskRef: paths.taskRef,
				parentSessionId: "parent-session",
				label: "Long bash",
				command: "printf lines",
				cwd: workspace.cwd,
				exitCode: null,
				signal: null,
				state: "running",
				latestOutcome: null,
				latestReply: { text: Array.from({ length: 30 }, (_, index) => `Bash line ${index}`).join("\n"), streaming: false },
				lastRunSequence: 1,
				activeRun: {
					id: "r_1111111111111111",
					sequence: 1,
					kind: "initial",
					state: "running",
					input: "printf lines",
					acceptedAt: now,
					startedAt: now
				},
				queuedFollowUps: [],
				notifications: [],
				discardedAt: null,
				createdAt: now,
				updatedAt: now
			}
			await writeTaskMetadata(paths, metadata)
			let step = 0
			let renders = 0
			const ctx = {
				cwd: workspace.cwd,
				sessionManager: { getSessionId: () => "parent-session" },
				ui: {
					custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
						const component = await factory(
							{ terminal: { rows: 12 }, requestRender: () => renders++ } as never,
							{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
							{} as never,
							() => {}
						)
						const current = step++
						if (current === 0) return "output"
						if (current > 1) return null
						const bottom = component.render(80).join("\n")
						expect(bottom).toContain("Bash line 29")
						expect(bottom).toContain("follow")
						expect(bottom).toContain("Exit code: unknown · Signal: none")
						await mutateTaskMetadata(paths, current => ({
							...current,
							latestReply: { text: `${current.latestReply?.text ?? ""}\nBash line 30`, streaming: false }
						}))
						await Bun.sleep(20)
						expect(component.render(80).join("\n")).toContain("Bash line 30")
						component.handleInput?.("\x1b[5~") // PageUp disables follow
						const scrolled = component.render(80).join("\n")
						expect(scrolled).not.toContain("Bash line 30")
						await mutateTaskMetadata(paths, current => ({
							...current,
							latestReply: { text: `${current.latestReply?.text ?? ""}\nBash line 31`, streaming: false }
						}))
						await Bun.sleep(20)
						expect(component.render(80).join("\n")).not.toContain("Bash line 31")
						expect(component.render(80).join("\n")).not.toContain("Bash line 30")
						component.handleInput?.("\x1b[F") // End resumes follow
						expect(component.render(80).join("\n")).toContain("Bash line 31")
						await mutateTaskMetadata(paths, current => ({
							...current,
							...termination,
							state: "idle",
							activeRun: null
						}))
						await Bun.sleep(20)
						const status = `Exit code: ${termination.exitCode ?? "unknown"} · Signal: ${termination.signal ?? "none"}`
						expect(component.render(80).join("\n")).toContain(status)
						expect(component.render(80).join("\n")).toContain("Bash line 31")
						component.handleInput?.("\x1b[H") // Status remains visible away from the tail
						expect(component.render(80).join("\n")).toContain(status)
						for (const width of [1, 20, 80]) {
							const lines = component.render(width)
							expect(lines.length).toBeLessThanOrEqual(7)
							expect(lines.every(line => visibleWidth(line) <= width)).toBe(true)
						}
						return undefined
					}
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
					`task:${paths.taskRef}`
				)
				expect(step).toBe(3)
				expect(renders).toBeGreaterThan(1)
			} finally {
				await releaseParentLeaseFor(workspace.cwd, "parent-session")
			}
		})
	})
})
