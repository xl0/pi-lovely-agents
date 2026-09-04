import { keyHint, type Theme } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"

const COLLAPSED_LINES = 10
const COLLAPSED_HEAD_LINES = 6
const COLLAPSED_TAIL_LINES = 3
const COLLAPSED_CHARACTERS = 1_200
const PREVIEW_LINE_CHARACTERS = 240

type TextToolResult = {
	content: Array<{ type: string; text?: string }>
}

/** Renders short results whole and long results as a head/tail preview toggled by Ctrl+O. */
export function renderExpandableResult(result: TextToolResult, expanded: boolean, theme: Theme): Text {
	const output = result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("\n")
	if (!output) return new Text("", 0, 0)

	const lines = output.split("\n")
	const characterCount = Array.from(output).length
	if (expanded || (lines.length <= COLLAPSED_LINES && characterCount <= COLLAPSED_CHARACTERS)) {
		return new Text(lines.map(line => theme.fg("toolOutput", line)).join("\n"), 0, 0)
	}

	const preview =
		lines.length > COLLAPSED_LINES
			? [
					...lines.slice(0, COLLAPSED_HEAD_LINES).map(line => theme.fg("toolOutput", previewLine(line))),
					expansionHint(`${lines.length - COLLAPSED_HEAD_LINES - COLLAPSED_TAIL_LINES} more lines`, theme),
					...lines.slice(-COLLAPSED_TAIL_LINES).map(line => theme.fg("toolOutput", previewLine(line)))
				]
			: characterPreview(output, theme)
	return new Text(preview.join("\n"), 0, 0)
}

function characterPreview(output: string, theme: Theme): string[] {
	const characters = Array.from(output)
	const head = characters.slice(0, 800).join("")
	const tail = characters.slice(-300).join("")
	return [
		...head.split("\n").map(line => theme.fg("toolOutput", line)),
		expansionHint(`${characters.length - 1_100} more characters`, theme),
		...tail.split("\n").map(line => theme.fg("toolOutput", line))
	]
}

function previewLine(line: string): string {
	const characters = Array.from(line)
	return characters.length <= PREVIEW_LINE_CHARACTERS ? line : `${characters.slice(0, PREVIEW_LINE_CHARACTERS).join("")}...`
}

function expansionHint(omitted: string, theme: Theme): string {
	return `${theme.fg("muted", `... (${omitted}, `)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
}
