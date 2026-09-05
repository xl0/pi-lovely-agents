import { describe, expect, test } from "bun:test"
import { stripVTControlCharacters } from "node:util"
import { type ExtensionAPI, initTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import { type Component, visibleWidth } from "@earendil-works/pi-tui"
import { registerAgentTool } from "../../extensions/lovely-agents/agent.js"
import { defaultAgentsConfig } from "../../extensions/lovely-agents/config.js"
import { renderExpandableResult } from "../../extensions/lovely-agents/rendering.js"

initTheme("dark")

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text
} as unknown as Theme

function renderText(component: Component): string {
	return component
		.render(120)
		.map(line => line.trimEnd())
		.join("\n")
}

describe("expandable tool results", () => {
	test("agent rows show ID and one-line input by default, expanding input and result together", () => {
		let renderer: ToolDefinition["renderCall"]
		let resultRenderer: ToolDefinition["renderResult"]
		registerAgentTool(
			{
				registerTool(tool: ToolDefinition) {
					renderer = tool.renderCall
					resultRenderer = tool.renderResult
				}
			} as unknown as ExtensionAPI,
			{ getConfig: () => defaultAgentsConfig }
		)
		if (!renderer || !resultRenderer) throw new Error("Missing agent renderer")
		const renderCall = renderer
		const state = {}
		const call = (prompt: string | undefined, expanded = false) =>
			renderCall({ definition: "reviewer", label: "Review", ...(prompt !== undefined ? { prompt } : {}) }, theme, {
				expanded,
				state
			} as Parameters<typeof renderCall>[2])
		expect(renderText(call(undefined))).toBe('agent reviewer label="Review"')
		expect(renderText(call("Inspect main.ts.\nDo not edit files."))).toBe(
			'agent reviewer label="Review" prompt="Inspect main.ts. Do not edit files."'
		)
		expect(renderText(call("Partial prompt"))).toContain('prompt="Partial prompt"')
		expect(renderText(call('Say "hello".'))).toContain('prompt="Say \\"hello\\"."')
		const prompt = Array.from({ length: 15 }, (_, index) => `prompt line ${index + 1}`).join("\n")
		const collapsed = call(prompt).render(50)
		expect(collapsed).toHaveLength(1)
		expect(collapsed.every(line => visibleWidth(line) <= 50)).toBe(true)
		expect(collapsed.join("\n")).not.toContain("prompt line 15")
		expect(renderText(call(prompt, true))).toContain(prompt)
		const pendingCall = call("Inspect")
		const result = { content: [{ type: "text" as const, text: "state: running" }], details: { id: "a_12345678" } }
		const context = { state } as Parameters<typeof resultRenderer>[3]
		expect(resultRenderer(result, { expanded: false, isPartial: false }, theme, context).render(120)).toEqual([])
		expect(renderText(pendingCall)).toBe('agent reviewer label="Review" prompt="Inspect" -> a_12345678')
		const unicode = renderCall(
			{ definition: "reviewer", label: "审阅🙂", prompt: "界🙂e\u0301 ".repeat(100) },
			{ ...theme, fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m` } as Theme,
			{ state, expanded: false } as Parameters<typeof renderCall>[2]
		)
		for (const width of [0, 1, 3, 13, 14, 20, 50, 80, 120]) {
			const lines = unicode.render(width)
			expect(lines).toHaveLength(1)
			expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width)
			expect(lines[0]).not.toContain("�")
			if (width >= 14) expect(stripVTControlCharacters(lines[0] ?? "")).toEndWith(" -> a_12345678")
		}
		expect(stripVTControlCharacters(unicode.render(80).join(""))).toContain('..." -> a_12345678')
		expect(visibleWidth(unicode.render(120)[0] ?? "")).toBeGreaterThan(visibleWidth(unicode.render(80)[0] ?? ""))
		expect(renderText(resultRenderer(result, { expanded: true, isPartial: false }, theme, context))).toBe("── Result ──\nstate: running")
		expect(renderText(resultRenderer(result, { expanded: false, isPartial: false }, theme, { ...context, isError: true }))).toContain(
			"state: running"
		)
	})

	test("shows a head/tail preview until Ctrl+O expands it", () => {
		const text = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n")
		const result = { content: [{ type: "text", text }] }

		const collapsed = renderText(renderExpandableResult(result, false, theme))
		expect(collapsed).toContain("line 1")
		expect(collapsed).toContain("line 6")
		expect(collapsed).not.toContain("line 7")
		expect(collapsed).toContain("line 13")
		expect(collapsed).toContain("6 more lines")
		expect(collapsed).toContain("to expand")

		const expanded = renderText(renderExpandableResult(result, true, theme))
		expect(expanded).toContain("line 7")
		expect(expanded).not.toContain("more lines")
	})

	test("shows short results without an expansion hint", () => {
		const rendered = renderText(renderExpandableResult({ content: [{ type: "text", text: "one\ntwo" }] }, false, theme))
		expect(rendered).toContain("one\ntwo")
		expect(rendered).not.toContain("expand")
	})

	test("collapses only after the ten-line boundary", () => {
		const ten = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n")
		const eleven = `${ten}\nline 11`
		expect(renderText(renderExpandableResult({ content: [{ type: "text", text: ten }] }, false, theme))).not.toContain("to expand")
		expect(renderText(renderExpandableResult({ content: [{ type: "text", text: eleven }] }, false, theme))).toContain("to expand")
	})

	test("collapses a long single line without splitting Unicode", () => {
		const text = "🙂".repeat(1_300)
		const collapsed = renderText(renderExpandableResult({ content: [{ type: "text", text }] }, false, theme))
		expect(collapsed).toContain("200 more characters")
		expect(collapsed).not.toContain("�")
		expect(collapsed).toContain("to expand")
		expect(renderText(renderExpandableResult({ content: [{ type: "text", text }] }, true, theme))).not.toContain("more characters")
	})
})
