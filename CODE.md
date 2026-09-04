# Code

## Role

Pi package for durable in-process agent orchestration. Definition discovery,
configuration, scheduled execution, retained inspection, Follow-up/Steer and
stop/discard controls, restart recovery, and the management UI are implemented.

## Layout

- `extensions/lovely-agents/index.ts`: extension registration, management
  command, and `/continue`
- `extensions/lovely-agents/management.ts`: unified TUI and development fixtures
- `extensions/lovely-agents/coordinator.ts`: process-global scheduling, tuple
  gates, and runtime bindings
- `extensions/lovely-agents/child-session.ts`: fixed child configuration,
  Definition-owned prompts, and persistent Pi SDK sessions
- `extensions/lovely-agents/agent.ts`: agent creation, execution, input, stop,
  and discard tools
- `extensions/lovely-agents/lifecycle.ts`: graceful recursive shutdown and
  restart reconciliation
- `extensions/lovely-agents/config.ts`: scoped config validation and searchable
  model selection
- `extensions/lovely-agents/definitions.ts`: fresh, trust-aware Definition
  discovery and strict validation
- `extensions/lovely-agents/tools.ts`: roster and task inspection tools
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
Metadata is strictly validated against its path and v2 schema before use.
Writes are serialized per task and use a private same-directory temporary file,
file fsync, rename, and directory fsync. Malformed and unsupported snapshots
remain untouched.

Metadata v2 retains the immutable child-session recipe: Definition prompt,
explicit-vs-omitted tool policy, context exclusion, and scoped model identities.
It also retains scheduler acceptance order for active and queued runs. Earlier
metadata versions are rejected rather than cold-loaded with wider capabilities.
Metadata and retained-log queues are process-global so surviving runtimes and
new extension instances remain serialized across reload.

Each open parent partition has a versioned PID/token `.lease`, published through
an atomic no-overwrite link. A package-symbol process-global registry reuses the
same lease across extension runtimes and serializes local acquisition. Live
owners cause an explicit conflict; only a valid lease whose PID is definitively
absent is reclaimed. Simultaneous stale reclamation is best-effort; fresh and
live-owner acquisition remains atomic. Release verifies the ownership token
before unlinking.

`output.md` retains runs as a flat tagged user/agent event stream without
timestamps or per-line indentation; `activity.md` retains tool records with
bounded single-line argument headers and UTF-8-safe 2 KiB head/tail previews.
Reads use
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

Model-visible task rendering avoids repeating structured details. Lists group
tasks by state, combine model/thinking, show only relative creation/update
times, omit empty descendant summaries, and expose one task directory. Output
reads render the selected event range and source file. Input acknowledgements
use one line, and agent creation omits redundant task inventory. Full artifact
paths and exact metadata remain in tool `details`. Potentially long Lovely
Agent, roster, list, and output tool results show a ten-line head/tail preview;
the configured `app.tools.expand` binding (Ctrl+O by default) reveals the full
fetched result.

One versioned coordinator is shared through a package-owned `globalThis`
symbol. Its acceptance-ordered semaphore skips closed provider/model tuples,
drains config reductions, and tracks resident runtimes and parent notification
routes with replacement-safe unbind callbacks. Managed runs carry permits in
async-local context. Synchronous descendant waits and blocking `task_output`
can lend that permit, then queue FIFO reacquisition before the caller resumes;
reacquisition bypasses tuple gates because the caller was already running.
Inactive reservations hold Follow-up acceptance order without consuming
capacity; atomic promotion activates the next reservation before the current
permit is released.

Child sessions use Pi's SDK in-process and own the task's retained
`session.jsonl`. Selection follows call, Definition, then parent precedence.
Explicit Definition tools are hard allowlists; omitted tools preserve normal
built-ins and extensions. Delegation is removed unless both `allowAgents` and
remaining depth permit it. A hidden first extension composes the Definition
body with active tool metadata, Pi guidelines, append resources, optional
AGENTS/CLAUDE context, skills, and cwd before ordinary extension hooks.
Session-scoped depth is registered before extension startup and removed on
disposal.

`agent` validates Definition, depth, model, label, and prompt before reserving
storage. Durable acceptance records queued metadata plus run/input log
boundaries before global scheduling. The resident runtime moves queued work to
running, writes assistant/tool events serially, and commits one terminal
outcome across completion/stop races. Synchronous waits lend managed parent
permits; zero or expired waits only stamp detachment and never restart work.
Accepted child failures are task outcomes, not failed tool calls. Idle child
runtimes dispose while their private Pi session file remains cold-loadable.

`task_input` defaults to durable Follow-up. Active work retains up to 32 ordered
Follow-ups; settlement atomically promotes the queue head, and each run gets a
separate Pi prompt/outcome in the same session. Running Steers use Pi's queue
with the configured literal/template behavior. The runtime records Steers only
after their user message is observed, so stop/crash can drop undelivered input.
Non-running Steers deterministically become Follow-ups under the task mutation
lane. Idle/interrupted tasks cold-load from the retained immutable recipe and
expected Pi UUID, without rescanning mutable Definitions.

`task_stop` aborts resident execution or cancels retained queued/suspended work,
clears Follow-ups, recursively stops descendants, and preserves the task's
session for later input. Completion and stop settle the active run by matching
its durable ID, so the first transition wins. `task_discard` performs the same
stop before writing a permanent tombstone. Discarded files remain retained,
while listing and later model I/O hide or reject the task; repeated discard is
idempotent.

On quit/new/resume/fork, the outgoing runtime recursively stops resident and
retained descendants before releasing exact-parent leases. Reload skips this
path, preserving process-global residents. Non-reload startup scans only the
exact parent partition: stale active states become `interrupted`, queued
Follow-ups clear, and one deterministic interruption notification is retained.
Stable idle/interrupted records and malformed/orphaned files are never deleted.

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
