import type { ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent"
import { type ConfigFromSchema, defineScopedConfig, field, type ScopedConfig } from "@xl0/pi-lovely-config"

const NO_MODELS = "(no authenticated models)"
type ModelConfigContext = Pick<ExtensionContext, "model" | "modelRegistry">

function createConfigSchema(ctx?: ModelConfigContext) {
	const availableModels = ctx?.modelRegistry.getAvailable() ?? []
	const modelIds = [...new Set(availableModels.map(model => `${model.provider}/${model.id}`))]
	const modelValues = (modelIds.length > 0 ? modelIds : [NO_MODELS]) as [string, ...string[]]
	return {
		models: field.multiEnum(modelValues, [], {
			label: "Models",
			description: "Models available for explicit agent selection. Empty allows only the current parent model.",
			valueDescriptions: Object.fromEntries(availableModels.map(model => [`${model.provider}/${model.id}`, model.name || model.id]))
		}),
		maxConcurrency: field.number(4, {
			label: "Max concurrency",
			description: "Maximum agent runs executing in this process.",
			min: 1,
			step: 1
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
			step: 1000
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
		for (const key of ["maxConcurrency", "maxDepth", "waitMs"] as const) {
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
	return resolveModelChoices({
		selections: config.models,
		availableModels: ctx.modelRegistry.getAvailable(),
		parentModel: ctx.model
	})
}
