import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { AgentsConfig, AgentsConfigWarning, ModelChoice } from "./config.js"
import { resolveConfiguredModels } from "./config.js"
import { type AgentDefinition, discoverAgentDefinitions } from "./definitions.js"

export type RosterDefinition = {
	name: string
	description: string
	source: "user" | "project"
	path: string
	model?: string
	thinking?: string
	tools?: string[]
	exclude_agents_md?: boolean
}

export type RosterDiagnostic = {
	type: "error" | "warning"
	code: string
	message: string
	path?: string
	name?: string
	pattern?: string
	source?: string
}

export type RosterModel = {
	id: string
}

export type AgentRosterResult = {
	definitions: RosterDefinition[]
	diagnostics: RosterDiagnostic[]
	models: RosterModel[]
	depth: { current: number; maximum: number }
}

export function registerRosterTool(
	pi: ExtensionAPI,
	options: {
		getConfig: () => AgentsConfig
		getConfigWarnings: () => readonly AgentsConfigWarning[]
		getDepth?: () => number
		getAgentDir?: () => string
	}
): void {
	pi.registerTool({
		name: "agent_roster",
		label: "Agent Roster",
		description: "List available Lovely Agent definitions, configured model choices, validation diagnostics, and delegation depth.",
		promptSnippet: "List available Lovely Agent definitions and model choices",
		promptGuidelines: ["Call agent_roster before delegating work and after editing Agent Definition files."],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const config = options.getConfig()
			const resolvedModels = await resolveConfiguredModels(config, ctx)
			const discovered = discoverAgentDefinitions({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				toolNames: pi.getAllTools().map(tool => tool.name),
				models: ctx.modelRegistry.getAll(),
				...(options.getAgentDir ? { agentDir: options.getAgentDir() } : {})
			})
			return buildRosterToolResult({
				definitions: discovered.definitions,
				diagnostics: [
					...discovered.diagnostics,
					...options.getConfigWarnings().map(warning => ({
						type: "warning" as const,
						code: warning.key ? "invalid-config-value" : "invalid-config-file",
						message: warning.message,
						path: warning.path,
						source: warning.scope,
						...(warning.key ? { name: warning.key } : {})
					})),
					...resolvedModels.diagnostics.map(diagnostic => ({
						...diagnostic,
						source: "models"
					}))
				],
				models: resolvedModels.models,
				currentDepth: options.getDepth?.() ?? 0,
				maximumDepth: config.maxDepth
			})
		}
	})
}

export function buildRosterToolResult(options: {
	definitions: readonly AgentDefinition[]
	diagnostics: readonly RosterDiagnostic[]
	models: readonly ModelChoice[]
	currentDepth: number
	maximumDepth: number
}): {
	content: [{ type: "text"; text: string }]
	details: AgentRosterResult
} {
	const result: AgentRosterResult = {
		definitions: options.definitions.map(definition => ({
			name: definition.name,
			description: definition.description,
			source: definition.source,
			path: definition.displayPath,
			...(definition.model ? { model: definition.model } : {}),
			...(definition.thinking ? { thinking: definition.thinking } : {}),
			...(definition.tools ? { tools: definition.tools } : {}),
			...(definition.excludeAgentsMd !== undefined ? { exclude_agents_md: definition.excludeAgentsMd } : {})
		})),
		diagnostics: [...options.diagnostics],
		models: options.models.map(choice => ({
			id: `${choice.model.provider}/${choice.model.id}`
		})),
		depth: { current: options.currentDepth, maximum: options.maximumDepth }
	}
	const lines: string[] = []
	if (result.definitions.length === 0) {
		lines.push("definitions: []")
	} else {
		lines.push("definitions:")
		for (const definition of result.definitions) {
			lines.push(`  - name: ${yamlScalar(definition.name)}`)
			lines.push(`    description: ${yamlScalar(definition.description)}`)
			lines.push(`    path: ${yamlScalar(definition.path)}`)
			if (definition.model) lines.push(`    model: ${yamlScalar(definition.model)}`)
			if (definition.thinking) lines.push(`    thinking: ${definition.thinking}`)
			if (definition.tools) lines.push(`    tools: [${definition.tools.map(yamlScalar).join(", ")}]`)
			if (definition.exclude_agents_md) lines.push("    exclude_agents_md: true")
		}
	}

	if (result.diagnostics.length > 0) {
		lines.push("diagnostics:")
		for (const diagnostic of result.diagnostics) {
			lines.push(`  - type: ${diagnostic.type}`)
			lines.push(`    code: ${yamlScalar(diagnostic.code)}`)
			lines.push(`    message: ${yamlScalar(diagnostic.message)}`)
			if (diagnostic.source) lines.push(`    source: ${yamlScalar(diagnostic.source)}`)
			if (diagnostic.path) lines.push(`    path: ${yamlScalar(diagnostic.path)}`)
			if (diagnostic.name) lines.push(`    name: ${yamlScalar(diagnostic.name)}`)
			if (diagnostic.pattern) lines.push(`    pattern: ${yamlScalar(diagnostic.pattern)}`)
		}
	}

	lines.push(result.models.length === 0 ? "models: []" : "models:")
	for (const model of result.models) {
		lines.push(`  - ${yamlScalar(model.id)}`)
	}
	lines.push(`depth: ${result.depth.current}/${result.depth.maximum}`)

	return { content: [{ type: "text", text: lines.join("\n") }], details: result }
}

function yamlScalar(value: string): string {
	return /^[A-Za-z0-9_@+./:-]+$/.test(value) && !/^(?:null|true|false|yes|no|on|off|[-+]?(?:\d+\.?\d*|\.\d+))$/i.test(value)
		? value
		: JSON.stringify(value)
}
