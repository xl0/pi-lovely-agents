# Code

## Role

Pi package for durable agent orchestration. Configuration, Agent Definition
discovery, and roster inspection are implemented; durable task execution is
next.

## Layout

- `extensions/lovely-agents/index.ts`: extension registration, config UI, and
  `/continue`
- `extensions/lovely-agents/config.ts`: scoped config validation and searchable
  model selection
- `extensions/lovely-agents/definitions.ts`: fresh, trust-aware Definition
  discovery and strict validation
- `extensions/lovely-agents/tools.ts`: `agent_roster` registration and rendering
- `tests/lovely-agents/`: extension tests and temp-workspace helpers
- `package.json`: package metadata, Pi discovery, and Bun tooling
- `scripts/release.ts`: interactive release driver
- `.github/workflows/publish.yml`: tag-triggered npm/GitHub release pipeline

The package is ESM. Pi discovers `./extensions` through the package manifest.
Pi runtime packages stay peer dependencies. Development uses `bun link` for
Lovely Config's unreleased `multiEnum`; publish that dependency before release.

`xl0-pi-lovely-agents.json` merges user then workspace values through Lovely
Config. `models` is a searchable multi-select built from authenticated Pi
models; an empty selection exposes only the current parent model. Numeric
runtime limits are also checked as integers because Lovely Config's ranged
number fields accept fractions.

Definitions are scanned on each roster call. The nearest trusted project
`.pi/agents` directory shadows user definitions by declared name, even when the
project definition is invalid. Same-scope duplicates invalidate that name.
Definition model names resolve exactly against the full catalog.

`agent_roster` returns effective definitions, diagnostics, and model choices as
compact YAML-like model output. Full structured details remain available to Pi.

`/continue` sends a hidden empty custom message with Follow-up delivery and
`triggerTurn: true` when the parent is idle. This resumes Pi's normal prompt
path without adding visible prompt text. It refuses to queue duplicate work
while the parent is already running and does nothing unless the latest
assistant reply ended with `error` or `aborted`.

## Tooling and release

TypeScript is strict and checks `extensions/` and `tests/`; Bun runs the test
suite; Biome handles formatting and linting. `bun run check` runs all three.

The unreleased package starts at `0.0.0`; the first minor release becomes
`0.1.0`. `bun run release` verifies and bumps locally, then pushes a `v*` tag.
CI verifies the tag, stages the package on npm with OIDC provenance, and creates
a GitHub Release. The local release driver asks for 2FA to approve the staged
npm version.
