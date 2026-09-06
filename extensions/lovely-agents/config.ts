import type { ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent"
import { type ConfigFromSchema, defineScopedConfig, field, type ScopedConfig } from "@xl0/pi-lovely-config"

const NO_MODELS = "(no authenticated models)"
const DISABLED_MODEL = "disabled"
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export const MODEL_ALIASES = {
	fast: "Cheap, low-latency model for straightforward tasks.",
	smart: "Most capable model for difficult reasoning and complex work.",
	workhorse: "Balanced cost and capability for routine coding and research."
} as const
export type ModelAliasName = keyof typeof MODEL_ALIASES
/** A user-selected preset, resolved to an authenticated model before creation. */
export type ModelAliasChoice = {
	name: ModelAliasName
	model: ScopedModel["model"]
	thinkingLevel: NonNullable<ScopedModel["thinkingLevel"]>
}
type ModelConfigContext = Pick<ExtensionContext, "model" | "modelRegistry">

function createConfigSchema(ctx?: ModelConfigContext) {
	const availableModels = ctx?.modelRegistry.getAvailable() ?? []
	const modelIds = [...new Set(availableModels.map(model => `${model.provider}/${model.id}`))]
	const modelValues = (modelIds.length > 0 ? modelIds : [NO_MODELS]) as [string, ...string[]]
	const valueDescriptions = Object.fromEntries(availableModels.map(model => [`${model.provider}/${model.id}`, model.name || model.id]))
	const aliasModel = (name: ModelAliasName) =>
		field.enum([DISABLED_MODEL, ...modelIds] as [string, ...string[]], DISABLED_MODEL, {
			label: `${name} model`,
			description: MODEL_ALIASES[name],
			search: true,
			valueDescriptions: { [DISABLED_MODEL]: "Do not expose this alias", ...valueDescriptions }
		})
	const aliasThinking = (name: ModelAliasName, level: ModelAliasChoice["thinkingLevel"]) =>
		field.enum(THINKING_LEVELS, level, {
			label: `${name} thinking`,
			description: "Preset effort; an explicit thinking argument overrides it.",
			depth: 1,
			visibleWhen: ctx => ctx.get(`${name}Model`) !== DISABLED_MODEL
		})
	return {
		backgroundAgents: field.boolean(true, {
			label: "Background agents",
			description: "Allow detached agents and asynchronous Follow-ups. Off keeps agents in the foreground."
		}),
		backgroundBash: field.boolean(true, {
			label: "Background Bash",
			description: "Run Bash commands as managed background tasks."
		}),
		models: field.multiEnum(modelValues, [], {
			label: "Models",
			description: "Additional model IDs available for agent selection. Empty includes the parent. Alias targets are always included.",
			valueDescriptions
		}),
		fastModel: aliasModel("fast"),
		fastThinking: aliasThinking("fast", "low"),
		smartModel: aliasModel("smart"),
		smartThinking: aliasThinking("smart", "high"),
		workhorseModel: aliasModel("workhorse"),
		workhorseThinking: aliasThinking("workhorse", "medium"),
		maxConcurrency: field.number(4, {
			label: "Max concurrency",
			description: "Maximum agent runs executing in this process.",
			min: 1,
			step: 1
		}),
		maxBashConcurrency: field.number(4, {
			label: "Bash concurrency",
			description: "Maximum background Bash processes, separate from agent permits.",
			min: 1,
			step: 1,
			visibleWhen: ctx => ctx.get("backgroundBash") === true
		}),
		maxDepth: field.number(2, {
			label: "Max depth",
			description: "Maximum agent delegation depth. The root session is depth 0.",
			min: 0,
			step: 1
		}),
		waitMs: field.number(30_000, {
			label: "Initial wait (ms)",
			description: "How long agent creation waits before detaching.",
			min: 0,
			step: 1000,
			visibleWhen: ctx => ctx.get("backgroundAgents") === true
		}),
		expandPromptTemplates: field.boolean(false, {
			label: "Expand prompt templates",
			description: "Interpret child skill commands, prompt templates, and extension commands."
		})
	} as const
}

const configSchema = createConfigSchema()
type RawAgentsConfig = ConfigFromSchema<typeof configSchema>
type ConfigScope = "user" | "workspace"

export type AgentsConfig = RawAgentsConfig

export type AgentsConfigWarning = {
	scope: ConfigScope
	path: string
	key?: string
	message: string
}

export type ModelChoice = ScopedModel

export type ModelChoiceDiagnostic = {
	type: "warning"
	code: "no-match"
	message: string
	pattern: string
}

export const defaultAgentsConfig: AgentsConfig = {
	...createAgentsConfigSpec().defaults
}

export function createAgentsConfigSpec(ctx?: ModelConfigContext): ScopedConfig<RawAgentsConfig> {
	return defineScopedConfig({
		fileName: "xl0-pi-lovely-agents.json",
		schema: createConfigSchema(ctx)
	}) as ScopedConfig<RawAgentsConfig>
}

export function resolveAgentsConfig(config: ScopedConfig<RawAgentsConfig>): {
	value: AgentsConfig
	warnings: AgentsConfigWarning[]
} {
	const scoped = {
		user: { ...config.scoped.user },
		workspace: { ...config.scoped.workspace }
	}
	const warnings: AgentsConfigWarning[] = [...config.warnings]

	for (const scope of config.scopes) {
		for (const key of ["maxConcurrency", "maxBashConcurrency", "maxDepth", "waitMs"] as const) {
			const value = scoped[scope][key]
			if (typeof value !== "number" || Number.isInteger(value)) continue
			delete scoped[scope][key]
			warnings.push({
				scope,
				path: config.path(scope),
				key,
				message: `/${key} must be an integer; value is ignored while resolving`
			})
		}
	}

	return { value: config.resolve(scoped), warnings }
}

export function loadAgentsConfig(
	cwd: string,
	ctx?: ModelConfigContext
): {
	value: AgentsConfig
	warnings: AgentsConfigWarning[]
} {
	return resolveAgentsConfig(createAgentsConfigSpec(ctx).load(cwd))
}

export function resolveModelChoices(options: {
	selections: readonly string[]
	availableModels: readonly ScopedModel["model"][]
	parentModel: ScopedModel["model"] | undefined
}): { models: ModelChoice[]; diagnostics: ModelChoiceDiagnostic[] } {
	if (options.selections.length === 0) {
		return options.parentModel
			? { models: [{ model: options.parentModel }], diagnostics: [] }
			: {
					models: [],
					diagnostics: [{ type: "warning", code: "no-match", message: "No current parent model is available", pattern: "" }]
				}
	}

	const models: ModelChoice[] = []
	const diagnostics: ModelChoiceDiagnostic[] = []
	for (const selection of options.selections) {
		const model = options.availableModels.find(model => `${model.provider}/${model.id}` === selection)
		if (model) models.push({ model })
		else {
			diagnostics.push({
				type: "warning",
				code: "no-match",
				message: `Configured model "${selection}" is not available`,
				pattern: selection
			})
		}
	}
	return { models, diagnostics }
}

export function resolveConfiguredModels(config: AgentsConfig, ctx: ExtensionContext) {
	const availableModels = ctx.modelRegistry.getAvailable()
	const resolved = resolveModelChoices({
		selections: config.models,
		availableModels,
		parentModel: ctx.model
	})
	const aliases: ModelAliasChoice[] = []
	for (const name of Object.keys(MODEL_ALIASES) as ModelAliasName[]) {
		const target = config[`${name}Model`]
		if (target === DISABLED_MODEL) continue
		const model = availableModels.find(model => `${model.provider}/${model.id}` === target)
		if (!model) {
			resolved.diagnostics.push({
				type: "warning",
				code: "no-match",
				pattern: target,
				message: `Model alias "${name}" targets unavailable model "${target}"`
			})
			continue
		}
		aliases.push({ name, model, thinkingLevel: config[`${name}Thinking`] })
		if (!resolved.models.some(choice => choice.model.provider === model.provider && choice.model.id === model.id)) {
			resolved.models.push({ model })
		}
	}
	return { ...resolved, aliases }
}
