# Code

## Role

Pi package for durable in-process agent orchestration. Definition discovery,
configuration, scheduled execution, retained inspection, Follow-up/Steer and
stop/discard controls, restart recovery, and the management UI are implemented.

## Layout

- `extensions/lovely-agents/index.ts`: extension registration, management
  command, and `/continue`
- `extensions/lovely-agents/management.ts`: unified TUI and development fixtures
- `extensions/lovely-agents/task-panel.ts`: below-editor task status/navigation
- `extensions/lovely-agents/coordinator.ts`: process-global scheduling, tuple
  gates, and runtime bindings
- `extensions/lovely-agents/child-session.ts`: fixed child configuration,
  Definition-owned prompts, and persistent Pi SDK sessions
- `extensions/lovely-agents/agent.ts`: agent creation, execution, input, stop,
  and discard tools
- `extensions/lovely-agents/lifecycle.ts`: graceful recursive shutdown and
  restart reconciliation
- `extensions/lovely-agents/notifications.ts`: bounded durable notification
  creation, routing, observation, and transcript reconciliation
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
models; an empty selection includes the current parent model. Optional `fast`,
`smart`, and `workhorse` aliases each select an authenticated model and thinking
level. Their targets join explicit choices automatically, without duplicate IDs.
Aliases default to disabled; unavailable targets warn and fail on selection,
never reroute. The roster describes enabled presets; the parent chooses freely.
Numeric
runtime limits are also checked as integers because Lovely Config's ranged
number fields accept fractions.

Definitions are scanned on each roster call. The nearest trusted project
`.pi/agents` directory shadows user definitions by declared name, even when the
project definition is invalid. Same-scope duplicates invalidate that name.
Definition model names resolve against the full catalog or the three reserved
alias names. Aliases resolve at creation, not during Definition discovery.

`agent_roster` returns effective definitions, diagnostics, and model choices as
compact YAML-like model output. Full structured details remain available to Pi.

Task state is stored under `.pi/lovely-agents/<parent-session-id>/<task-ref>/`.
Task directories are reserved atomically with collision-checked `a_` references.
Metadata is strictly validated against its path and v3 schema before use.
Writes are serialized per task and use a private same-directory temporary file,
file fsync, rename, and directory fsync. Malformed and unsupported snapshots
are never migrated implicitly. The generated `.gitignore` ignores all storage
contents, including itself.

Metadata v3 retains the immutable child-session recipe: Definition prompt,
explicit-vs-omitted tool policy, context exclusion, and scoped model identities.
It also retains scheduler acceptance order and the latest assistant reply.
Reply snapshots share the metadata mutation lane, so status and text are read
atomically. Promoting a new run clears the old reply; run-ID checks fence late
stream events. Reply and last-activity writes coalesce together so burst events
cannot reorder their final action. Optional `lastActivity` records observed work,
not bookkeeping timestamps: start, thinking, reply, or tool activity, without
reasoning/tool payloads. Thinking and tool-update heartbeats are event-driven,
capped at one per second. New runs reset activity as well as the reply. Earlier
metadata versions are rejected rather than cold-loaded with wider capabilities.
Optional `effectiveSystemPrompt` captures Pi's composed string at `agent_start`,
after `before_agent_start` hooks, and clears on a new run. It excludes
provider-payload rewrites and stays out of model-visible inspection results.
Optional `inputPreview` captures up to 512 UTF-8 bytes of normalized run input
on creation/promotion and survives settlement. Only human task-list loads
include it; ordinary tool results do not. Older completed runs are not backfilled.
Metadata and retained-log queues are process-global so surviving runtimes and
new extension instances remain serialized across reload.

Each open parent partition has a versioned PID/token `.lease`, published through
an atomic no-overwrite link. A package-symbol process-global registry reuses the
same lease across extension runtimes and serializes local acquisition. Live
owners cause an explicit conflict; only a valid lease whose PID is definitively
absent is reclaimed. Simultaneous stale reclamation is best-effort; fresh and
live-owner acquisition remains atomic. Release verifies the ownership token
before unlinking.

`history.md` retains runs as a flat tagged input/assistant event stream, with
compact tool argument/result summaries and outcomes. No reasoning or full tool
payloads are copied; Pi's `session.jsonl` remains the authoritative transcript.
There is no separate output or activity log. Retained paths are
workspace-relative when possible.

`task_list` scans only the exact parent-session partition under its lease,
hides tombstones, isolates corrupt direct records, and sorts by state then
recency. Direct rows include retained paths and bounded recursive descendant
summaries without descendant Task References. All direct rows and diagnostics
are returned at once. `task_output` rejects foreign/discarded tasks and returns
only the latest assistant reply from the current run, bounded to 2,000
lines/50 KiB with a full-history reference on truncation. Optional long-polling
waits for reply, activity, status, or scheduling changes, including equal-length
text replacements. Lists and snapshots expose process-wide held/max execution
permits and queued reasons: `provider-limit`, `capacity`, or transitional
`starting`. Counts reflect cooperative permits, not running-state counts;
no queue position or ETA is inferred.
It returns snapshots, not offsets or continuation pages. Streaming is separate
from run status; message completion is not run completion. Semantic shutdown
releases the parent lease; reload keeps it.

Model-visible task rendering avoids repeating structured details. Lists group
tasks by state, combine model/thinking, show only relative creation/update
times, omit empty descendant summaries, and expose one task directory. Output
reads render the latest reply, run status/outcome, and streaming flag.
Input acknowledgements
use one line, and agent creation omits redundant task inventory. Full artifact
paths and exact metadata remain in tool `details`. Collapsed agent calls use one
row: Definition, `label=`, quoted `prompt=`, then `-> task ID`. Rendering reserves
the ID suffix before truncating the preview to the available terminal columns;
Pi's width helpers handle ANSI and Unicode. Shared render state supplies the ID
at paint time, after the result renderer runs.
Ctrl+O expands the full prompt and a separate Result section; successful
tool results are otherwise hidden, while tool errors stay visible.
This is display-only and does not change model-visible input/output.
Other long roster, list, and output tool results show a ten-line head/tail preview;
the configured `app.tools.expand` binding (Ctrl+O by default) reveals the full
fetched result. Durable notifications use the same collapsed rendering and
expansion binding.

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
Coordinator implementation changes require a process restart; reload retains
the existing coordinator object.

Terminal quota, billing, budget, usage-limit, rate-limit/429, and
`ResourceExhausted` assistant errors suspend the active run and close its exact
provider/model tuple gate. Overload, 5xx, network, and timeout failures remain
ordinary failed runs. Closing a gate blocks queued and newly accepted work on
that tuple without aborting running siblings or delaying other tuples.
Successful turns reopen their exact tuple globally. Eligible `/continue` calls
also admit only suspended tasks in the caller's owned descendant tree, even
while their tuple gate remains closed. Recovery sends literal `Continue.` in
the existing logical run; another provider limit suspends it again.

Detached initial runs and Follow-ups persist bounded completion notifications;
detached suspensions persist status notifications, and startup reconciliation
persists interruption notifications. Exact parent routes inject them as custom
Steers and wake idle parents. Delivery is marked only after the parent's
`message_end` observes the deterministic task/run/type ID. Session startup
reconciles IDs in the transcript and resends only absent notices; semantic
parent shutdown clears process-local in-flight suppression. Synchronous initial
results and explicit stops do not notify.

Notification previews come from the run's latest reply, not transcript tails:
inputs and older replies never enter the preview. History/session paths link
to the full records.

Child sessions use Pi's SDK in-process and own the task's retained
`session.jsonl`. Selection follows call, Definition, then parent precedence.
An alias selected by the call supplies its thinking preset ahead of Definition
thinking; explicit call thinking always wins. A Definition's own thinking
overrides its alias preset. Explicit model IDs do not inherit alias thinking.
Only concrete model identities and Pi-clamped thinking persist, so alias edits
never retarget existing sessions or their Follow-ups.
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
its durable ID, so the first transition wins. `task_discard` stops and archives
the owned subtree under `.pi/lovely-agents/archive/<parent>/<task>/`, moving each
whole task directory after descendant cleanup. Supported metadata is first
tombstoned to fence concurrent input. Unsupported versions are decoded only for
validated ownership identities; their metadata and logs move unchanged.
Malformed identities, unsafe paths, and archive collisions fail explicitly.
Concurrent discards share one operation; repeats succeed and archived IDs are
never reused. Listing excludes the archive; later model I/O rejects it.
The discard tool guideline asks agents to discard consumed, unneeded tasks
while keeping specialists likely to receive Follow-ups. No automatic deletion.

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
detail views never rebind Pi's active session. Task actions include on-demand
Inputs / history (current/queued inputs plus the unparsed retained history) and
System prompt (only the captured Pi prompt, without explanatory text or a
duplicated Definition body). Missing captures produce a separate notification,
never substituted content or reconstruction from today's context files.
Static text views wrap and scroll with arrows, PgUp/PgDn, and Home/End.
Task views also provide event-driven live output, Follow-up/Steer entry, stop,
and discard. Active counts appear in
the footer and up to five active rows appear below the editor. Down on an empty
editor focuses that same panel, exposing all direct tasks and diagnostics in a
five-row scrolling list. `/lovely-agents` → Tasks hands off to the panel rather
than opening another selector. Task rows use the full available width for labels,
model/status, and prompt previews, avoiding SelectList's fixed primary column.
Selection follows task identity across updates.
Enter opens actions; Esc or Up past the first row returns to the editor, and
other input passes through unchanged. Action/output views hide the panel until
they close. The editor wrapper preserves and restores the prior factory.
Process-global update routes refresh these surfaces on durable metadata/output
writes and shared capacity/gate changes without polling. Last-action ages are
computed when rendered; panel disposal fences in-flight refreshes. Snapshot
waits subscribe to scheduler updates as well as filesystem changes.
Live fixture timers use a process-global registry so
reload preserves them and semantic shutdown stops them before releasing the
parent lease.

`/continue` first requeues owned suspended descendants, then sends a hidden
empty custom message with Follow-up delivery and `triggerTurn: true` when the
parent is idle. This resumes Pi's normal prompt path without adding visible
prompt text. It refuses to queue duplicate work while the parent is already
running and does nothing unless the latest assistant reply ended with `error`
or `aborted`.

## Tooling and release

TypeScript is strict and checks `extensions/` and `tests/`; Bun runs the test
suite; Biome handles formatting and linting. `bun run check` runs all three.

The unreleased package starts at `0.0.0`; the first minor release becomes
`0.1.0`. `bun run release` verifies and bumps locally, then pushes a `v*` tag.
CI verifies the tag, stages the package on npm with OIDC provenance, and creates
a GitHub Release. The local release driver asks for 2FA to approve the staged
npm version.
