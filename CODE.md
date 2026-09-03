# Code

## Role

Pi package for durable agent orchestration. Configuration, Agent Definition
discovery, roster inspection, and the durable storage foundation are
implemented. In-process scheduling and execution are next.

## Layout

- `extensions/lovely-agents/index.ts`: extension registration, management
  command, and `/continue`
- `extensions/lovely-agents/management.ts`: unified TUI and development fixtures
- `extensions/lovely-agents/config.ts`: scoped config validation and searchable
  model selection
- `extensions/lovely-agents/definitions.ts`: fresh, trust-aware Definition
  discovery and strict validation
- `extensions/lovely-agents/tools.ts`: roster and read-only task tools
- `extensions/lovely-agents/state.ts`: versioned task metadata, private paths,
  serialized atomic snapshots, parent leases, and retained logs
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

Task state is stored under `.pi/lovely-agents/<parent-session-id>/<task-ref>/`.
Task directories are reserved atomically with collision-checked `a_` references.
Metadata is strictly validated against its path and v1 schema before use.
Writes are serialized per task and use a private same-directory temporary file,
file fsync, rename, and directory fsync. Malformed and unsupported snapshots
remain untouched.

Each open parent partition has a versioned PID/token `.lease`, published through
an atomic no-overwrite link. A package-symbol process-global registry reuses the
same lease across extension runtimes and serializes local acquisition. Live
owners cause an explicit conflict; only a valid lease whose PID is definitively
absent is reclaimed. Simultaneous stale reclamation is best-effort; fresh and
live-owner acquisition remains atomic. Release verifies the ownership token
before unlinking.

`output.md` retains run/input/assistant/outcome boundaries; `activity.md`
retains tool records with UTF-8-safe 2 KiB head/tail previews. Reads use
1-indexed line offsets, return whole lines under the 2,000-line/50 KiB caps,
and can long-poll active work until output size or task state changes. Retained
paths are workspace-relative when possible; `session.jsonl` remains owned by
Pi.

`task_list` scans only the exact parent-session partition under its lease,
hides tombstones, isolates corrupt direct records, and sorts by state then
recency. Direct rows include retained paths and bounded recursive descendant
summaries without descendant Task References. All direct rows and diagnostics
are returned at once. `task_output` rejects foreign/discarded tasks and exposes
retained line ranges with optional long-polling. Semantic session shutdown
releases the parent lease; reload keeps it.

`/lovely-agents` opens one selector for fresh Agent Definitions, durable tasks,
developer fixtures, and the scoped config editor. Fixture actions are always
visible for now. They seed states/outcomes plus queued, nested, discarded,
corrupt, large UTF-8, and live-transition cases. Cleanup removes only
owner-marked `.fixture` task directories across direct and nested partitions.
Definition previews include their complete system-prompt body. Definition/task
detail views never rebind Pi's active session. Live fixture timers use a
process-global registry so reload preserves them and semantic shutdown stops
them before releasing the parent lease.

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
