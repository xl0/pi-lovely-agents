import { describe, expect, test } from "bun:test"
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent"
import { renderExpandableResult } from "../../extensions/lovely-agents/rendering.js"

initTheme("dark")

const theme = {
	fg: (_color: string, text: string) => text
} as unknown as Theme

function renderText(component: ReturnType<typeof renderExpandableResult>): string {
	return component
		.render(120)
		.map(line => line.trimEnd())
		.join("\n")
}

describe("expandable tool results", () => {
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
