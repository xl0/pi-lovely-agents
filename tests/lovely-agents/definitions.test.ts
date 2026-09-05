import { describe, expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import type { ScopedModel } from "@earendil-works/pi-coding-agent"
import { discoverAgentDefinitions, findNearestProjectAgentsDir } from "../../extensions/lovely-agents/definitions.js"
import { definitionSource, withTempWorkspace } from "./test-helpers.js"

const models = [model("anthropic", "sonnet"), model("openai", "gpt"), model("other", "gpt")]
const tools = ["read", "bash", "agent_roster"]

describe("Agent Definition discovery", () => {
	test("accepts model aliases without resolving them to mutable model IDs", async () => {
		await withTempWorkspace(async workspace => {
			for (const alias of ["fast", "smart", "workhorse"]) {
				await workspace.write(
					`agent/agents/${alias}.md`,
					`---\nname: ${alias}\ndescription: Alias test\nmodel: ${alias}\n---\nInspect work.`
				)
			}
			const result = discover(workspace)
			expect(result.diagnostics).toEqual([])
			expect(result.definitions.map(definition => definition.model)).toEqual(["fast", "smart", "workhorse"])
		})
	})

	test("parses every supported field and both tool forms", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write(
				"agent/agents/reviewer.md",
				"---\nname: reviewer\ndescription: Reviews code\nmodel: sonnet\nthinking: high\ntools: read, bash\nexclude_agents_md: true\n---\nReview carefully.\n"
			)
			await workspace.write(
				"agent/agents/scout.md",
				"---\nname: scout\ndescription: Finds code\ntools: [read, agent_roster]\nexclude_agents_md: false\n---\nFind relevant files.\n"
			)
			await workspace.write("agent/agents/unicode.md", definitionSource("unicode", "💥".repeat(125)))

			const result = discover(workspace)
			expect(result.diagnostics).toEqual([])
			expect(result.definitions.map(definition => definition.name)).toEqual(["reviewer", "scout", "unicode"])
			expect(result.definitions[0]).toMatchObject({
				model: "anthropic/sonnet",
				thinking: "high",
				tools: ["read", "bash"],
				excludeAgentsMd: true,
				systemPrompt: "Review carefully.",
				source: "user"
			})
			expect(result.definitions[0]?.displayPath).toBe("~/agent/agents/reviewer.md")
		})
	})

	test("isolates strict validation failures", async () => {
		await withTempWorkspace(async workspace => {
			const files: Record<string, string> = {
				"bad-name.md": "---\nname: Bad Name\ndescription: okay\n---\nBody\n",
				"bad-description.md": `---\nname: bad-description\ndescription: ${"💥".repeat(126)}\n---\nBody\n`,
				"empty-body.md": "---\nname: empty-body\ndescription: okay\n---\n",
				"unknown-key.md": "---\nname: unknown-key\ndescription: okay\nfuture: true\n---\nBody\n",
				"bad-model.md": "---\nname: bad-model\ndescription: okay\nmodel: missing\n---\nBody\n",
				"ambiguous-model.md": "---\nname: ambiguous-model\ndescription: okay\nmodel: gpt\n---\nBody\n",
				"bad-thinking.md": "---\nname: bad-thinking\ndescription: okay\nthinking: enormous\n---\nBody\n",
				"bad-tools.md": "---\nname: bad-tools\ndescription: okay\ntools: [read, missing]\n---\nBody\n",
				"bad-exclude.md": "---\nname: bad-exclude\ndescription: okay\nexclude_agents_md: yes\n---\nBody\n",
				"bad-frontmatter.md": "---\n- list\n---\nBody\n"
			}
			for (const [name, source] of Object.entries(files)) await workspace.write(`agent/agents/${name}`, source)

			const result = discover(workspace)
			expect(result.definitions).toEqual([])
			expect(new Set(result.diagnostics.map(diagnostic => diagnostic.code))).toEqual(
				new Set([
					"invalid-name",
					"invalid-description",
					"empty-body",
					"unknown-key",
					"invalid-model",
					"invalid-thinking",
					"invalid-tools",
					"invalid-exclude-agents-md",
					"invalid-frontmatter"
				])
			)
		})
	})

	test("invalidates same-scope duplicates", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/a.md", definitionSource("dupe"))
			await workspace.write("agent/agents/b.md", definitionSource("dupe"))
			const result = discover(workspace)
			expect(result.definitions).toEqual([])
			expect(result.diagnostics.filter(diagnostic => diagnostic.code === "duplicate-name")).toHaveLength(2)
		})
	})

	test("an invalid project declaration still shadows a user definition", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/reviewer.md", definitionSource("reviewer"))
			await workspace.write(
				"workspace/.pi/agents/reviewer.md",
				"---\nname: reviewer\ndescription: project reviewer\ninvalid: true\n---\nProject prompt.\n"
			)

			const trusted = discover(workspace)
			expect(trusted.definitions).toEqual([])
			expect(trusted.diagnostics.map(diagnostic => diagnostic.code)).toContain("shadowed")
			expect(trusted.diagnostics.map(diagnostic => diagnostic.code)).toContain("unknown-key")

			const untrusted = discover(workspace, false)
			expect(untrusted.definitions.map(definition => definition.name)).toEqual(["reviewer"])
			expect(untrusted.diagnostics).toEqual([])
		})
	})

	test("uses the nearest ancestor, follows file links, and reports broken links", async () => {
		await withTempWorkspace(async workspace => {
			const nested = join(workspace.cwd, "packages/app")
			await mkdir(nested, { recursive: true })
			const target = await workspace.write("shared/scout.md", definitionSource("scout"))
			await mkdir(join(workspace.cwd, ".pi/agents"), { recursive: true })
			await symlink(target, join(workspace.cwd, ".pi/agents/scout.md"))
			await symlink(join(workspace.root, "missing.md"), join(workspace.cwd, ".pi/agents/missing.md"))
			await workspace.write(".pi/agents/outer.md", definitionSource("outer"))

			expect(findNearestProjectAgentsDir(nested)).toBe(join(workspace.cwd, ".pi/agents"))
			const result = discover({ ...workspace, cwd: nested })
			expect(result.definitions.map(definition => definition.name)).toEqual(["scout"])
			expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["unreadable-link"])
			expect(result.definitions[0]?.displayPath).toBe("../../.pi/agents/scout.md")
		})
	})

	test("orders definitions and diagnostics deterministically", async () => {
		await withTempWorkspace(async workspace => {
			await workspace.write("agent/agents/z.md", definitionSource("zeta"))
			await workspace.write("agent/agents/a.md", definitionSource("alpha"))
			await workspace.write("agent/agents/c.md", "bad")
			await workspace.write("agent/agents/b.md", "bad")
			const result = discover(workspace)
			expect(result.definitions.map(definition => definition.name)).toEqual(["alpha", "zeta"])
			expect(result.diagnostics.map(diagnostic => diagnostic.path)).toEqual([
				"~/agent/agents/b.md",
				"~/agent/agents/b.md",
				"~/agent/agents/c.md",
				"~/agent/agents/c.md"
			])
		})
	})
})

function discover(workspace: { cwd: string; agentDir: string; root: string }, projectTrusted = true) {
	return discoverAgentDefinitions({
		cwd: workspace.cwd,
		projectTrusted,
		toolNames: tools,
		models,
		agentDir: workspace.agentDir,
		homeDir: workspace.root
	})
}

function model(provider: string, id: string): ScopedModel["model"] {
	return { provider, id, name: id } as ScopedModel["model"]
}
