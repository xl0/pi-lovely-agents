import { keyHint, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent"
import { Box, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui"

const COLLAPSED_LINES = 10
const COLLAPSED_HEAD_LINES = 6
const COLLAPSED_TAIL_LINES = 3
const PREVIEW_LINE_CHARACTERS = 240

type TextToolResult = {
	content: Array<{ type: string; text?: string }>
}

/** Notifications have a distinct message shell; only the header is visible when collapsed. */
export const renderAgentNotification: MessageRenderer = (message, { expanded, outputPad }, theme) => {
	const content =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter(part => part.type === "text")
					.map(part => part.text)
					.join("\n")
	const lines = content.split("\n")
	const summary = (/^\[Lovely (Agent|Bash) /.test(lines[0] ?? "") ? lines[1] : lines[0]) || "Notification"
	return {
		render(width) {
			const box = new Box(outputPad, 0, text => theme.bg("customMessageBg", text))
			box.addChild({
				render: available => [
					truncateToWidth(
						theme.fg("customMessageLabel", theme.bold(`${expanded ? "▾" : "▸"} Lovely Agents · ${summary}`)),
						available
					).replaceAll("\x1b[0m", "\x1b[22;39m")
				],
				invalidate() {}
			})
			if (expanded && content) {
				box.addChild(new Spacer(1))
				box.addChild(new Text(theme.fg("customMessageText", content), 0, 0))
			}
			return box.render(width).map(line => truncateToWidth(line, width))
		},
		invalidate() {}
	}
}

/** Renders short results whole and long results as a head/tail preview toggled by Ctrl+O. */
export function renderExpandableResult(result: TextToolResult, expanded: boolean, theme: Theme, outputPad = 0): Text {
	const output = result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("\n")
	if (!output) return new Text("", outputPad, 0)

	const lines = output.split("\n")
	if (expanded) return new Text(lines.map(line => theme.fg("toolOutput", line)).join("\n"), outputPad, 0)

	// Collapsed: cap every line, and fold the middle of long results.
	const folded = lines.length > COLLAPSED_LINES
	const shown = folded ? [...lines.slice(0, COLLAPSED_HEAD_LINES), ...lines.slice(-COLLAPSED_TAIL_LINES)] : lines
	const preview = shown.map(line => theme.fg("toolOutput", previewLine(line)))
	const omitted = folded
		? `${lines.length - shown.length} more lines`
		: shown.some(line => previewLine(line) !== line)
			? "long lines cut"
			: undefined
	if (omitted) preview.splice(folded ? COLLAPSED_HEAD_LINES : preview.length, 0, expansionHint(omitted, theme))
	return new Text(preview.join("\n"), outputPad, 0)
}

function previewLine(line: string): string {
	const characters = Array.from(line)
	return characters.length <= PREVIEW_LINE_CHARACTERS ? line : `${characters.slice(0, PREVIEW_LINE_CHARACTERS).join("")}...`
}

function expansionHint(omitted: string, theme: Theme): string {
	return `${theme.fg("muted", `... (${omitted}, `)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
}
