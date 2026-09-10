# Code

## Role

Pi package for durable in-process agent orchestration. Definition discovery,
configuration, scheduled execution, retained inspection, Follow-up/Steer and
stop/discard controls, restart recovery, and the management UI are implemented.
Background Bash shares the durable task controls without creating a Pi session.

## Layout

- `extensions/lovely-agents/index.ts`: extension registration, management
  command, and `/continue`
- `extensions/lovely-agents/management.ts`: unified TUI and internal test fixtures
- `extensions/lovely-agents/task-panel.ts`: below-editor task status/navigation
- `extensions/lovely-agents/coordinator.ts`: process-global scheduling, tuple
  gates, and runtime bindings
- `extensions/lovely-agents/child-session.ts`: fixed child configuration,
  Definition-owned prompts, and persistent Pi SDK sessions
- `extensions/lovely-agents/agent.ts`: agent creation, execution, input, stop,
  and discard tools
- `extensions/lovely-agents/bash.ts`: managed shell processes, stdin, bounded
  output tails, process-group cleanup, and completion notification settlement
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
- `extensions/lovely-agents/storage.ts`: rebuildable active links and
  ownership-validated discard markers for unsupported metadata
- `scripts/prune-tasks.ts`: explicit, dry-run-first pruning of discarded tasks
- `tests/lovely-agents/`: extension tests and temp-workspace helpers
- `skills/agent/SKILL.md`: packaged delegation guidance; prefer research,
  exploration, and independent review. Delegate implementation only for disjoint,
  independently verifiable changes with near-zero dependencies between writers;
  keep coupled implementation in the parent
- `skills/agent-creator/SKILL.md`: self-contained definition format and authoring
  guidance, with roster validation without starting test agents
- `README.md`: human-facing setup, examples, task controls, settings, and limits;
  implementation contracts stay in `CODE.md` and `PLAN.md`
- `package.json`: package metadata, Pi discovery, and Bun tooling
- `scripts/release.ts`: interactive release driver
- `.github/workflows/publish.yml`: tag-triggered npm/GitHub release pipeline

The package is ESM. Pi discovers `./extensions` and `./skills` through the
package manifest; both directories are included in npm distributions.
Pi runtime packages stay peer dependencies. Lovely Config requires published
version `^0.1.3` for `multiEnum` and is bundled; no local link is needed.

`xl0-pi-lovely-agents.json` merges user then workspace values through Lovely
Config. `models` is a searchable multi-select built from authenticated Pi
models; an empty selection includes the current parent model. Optional `fast`,
`smart`, and `workhorse` aliases each select an authenticated model and thinking
level. Their targets join explicit choices automatically, without duplicate IDs.
Aliases default to disabled; unavailable targets warn and fail on selection,
never reroute. The roster describes enabled presets; the parent chooses freely.
Numeric runtime limits are also checked as integers because Lovely Config's ranged
number fields accept fractions.

`backgroundAgents` and `backgroundBash` are independent boolean switches, both
true by default. The former enables timed detachment and asynchronous
Follow-ups; the latter exposes `bash_bg`. Context forks are deferred until
the required Pi SDK changes land; no fork setting or tool is exposed.
Tool schemas refresh with config: no foreground `waitMs`, and `allowAgents`
requires remaining descendant depth. Creation tools follow parent permission,
depth, and active SDK tools; inspection/control tools remain for owned tasks
or diagnostics even without a producer. Event-driven visibility restores only
tools this extension hid, not tools excluded by a Definition/SDK allowlist.

Definitions are scanned on each roster call. The nearest trusted project
`.pi/agents` directory shadows user definitions by declared name, even when the
project definition is invalid. Same-scope duplicates invalidate that name.
Definition model names resolve against the full catalog or the three reserved
alias names. Aliases resolve at creation, not during Definition discovery.

`agent_roster` returns effective definitions, diagnostics, and model choices as
compact YAML-like model output. Full structured details remain available to Pi.
It also reports process-wide held/max agent and Bash permits, explicitly
distinguishing that shared capacity from exact-parent task listings.

Task state is stored under `.pi/lovely-agents/<parent-session-id>/<task-ref>/`.
Task directories are reserved atomically with collision-checked `a_`/`b_` references.
Canonical paths never move on discard. Each parent's `active/` directory contains
relative symlinks to non-discarded tasks, including idle specialists. Metadata,
not link presence, controls membership. Initial acceptance and discard update
the index; non-reload startup rebuilds it. Index failures warn rather than
turning committed acceptance into a creation error and deleting accepted work.
Metadata is strictly validated against its path and v3 schema before use.
Writes are serialized per task and use a private same-directory temporary file,
file fsync, rename, and directory fsync. Malformed and unsupported snapshots
are never migrated implicitly. The generated `.gitignore` ignores all storage
contents, including itself.

Metadata v3 is a discriminated union: `a_` agents retain their original schema;
`b_` Bash tasks carry command/cwd and exit code/signal, without invented model,
Definition, or child-session identities. Agent metadata retains the immutable
child-session recipe: Definition prompt,
explicit-vs-omitted tool policy, context exclusion, and scoped model identities.
It also retains scheduler acceptance order and the latest assistant reply.
Reply snapshots share the metadata mutation lane, so status and text are read
atomically. Promoting a new run clears the old reply; run-ID checks fence late
stream events. Settlement writes each agent's final reply and outcome to a
private `runs/<1-based-sequence>.json` before publishing terminal/promotion
metadata. These files retain full reply text, not system prompts or tool payloads;
reads remain bounded. Optional `lastSettledRun` distinguishes the settled reply
from `lastRunSequence`, which includes accepted but not yet executed Follow-ups.
Older completed runs are not reconstructed by parsing the human history;
ambiguous old settled snapshots report an unknown run rather than treating the
highest accepted Follow-up as the reply's identity.
Reply and last-activity writes coalesce together so burst events
cannot reorder their final action. Optional `lastActivity` records observed work,
not bookkeeping timestamps: start, thinking, reply, or tool activity, without
reasoning/tool payloads. Thinking and tool-update heartbeats are event-driven,
capped at one per second. New runs reset activity as well as the reply. Earlier
metadata versions are rejected rather than cold-loaded with wider capabilities.
Optional agent `progress` is a child-authored line (up to 240 characters),
separate from observed `lastActivity`. New runs clear it; settlement retains it
in the indexed run result. Other-run reads never inherit the current report.
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

Agent `history.md` retains runs as a flat tagged input/assistant event stream, with
compact tool argument/result summaries and outcomes. No reasoning or full tool
payloads are copied; Pi's `session.jsonl` remains the authoritative transcript.
Agents have no separate output or activity log; Bash retains `output.log`. Paths are
workspace-relative when possible.

`task_list` scans only the exact parent-session partition under its lease,
hides tombstones, isolates corrupt direct records, and sorts by state then
recency. Direct rows include retained paths and bounded recursive descendant
summaries without descendant Task References. All direct rows and diagnostics
are returned at once. `task_output` rejects foreign tasks but permits read-only
inspection after discard. Optional `run` selects a 1-based run index; omission
selects the current run. It returns that run's latest/final assistant reply, bounded to 2,000
lines/50 KiB with a full-history reference on truncation. Optional timed reads
wait for the selected/observed run to end or suspend, ignoring partial output, activity,
and scheduling changes. Timeout returns the latest snapshot without stopping
work; a newer Follow-up cannot extend the wait or replace its result.
Queued selected Follow-ups can also be awaited. Bash has only run 1 and accepts
optional `lines` for the last N output lines, retaining status and the log path.
Idle, interrupted, and
suspended tasks return immediately. Lists and snapshots expose process-wide held/max execution
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
Input acknowledgements use one line with the accepted/targeted run index.
Steer says queued, not delivered; conversion to Follow-up includes the reason
captured at acceptance. Agent creation omits redundant task inventory. Full artifact
paths and exact metadata remain in tool `details`. Collapsed agent calls use one
row: Definition, `label=`, quoted `prompt=`, then `-> task ID`. Rendering reserves
the ID suffix before truncating the preview to the available terminal columns;
Pi's width helpers handle ANSI and Unicode. Shared render state supplies the ID
at paint time, after the result renderer runs.
Collapsed call truncation resets only foreground/bold styling, preserving the
surrounding tool background through the ellipsis and task ID.
Ctrl+O expands the full prompt and a separate Result section; successful
tool results are otherwise hidden, while tool errors stay visible.
This is display-only and does not change model-visible input/output.
Other long roster, list, and output tool results show a ten-line head/tail preview;
the configured `app.tools.expand` binding (Ctrl+O by default) reveals the full
fetched result. Notifications use a distinct message background and a bold,
single-line task/status header. Their entire body, even when short, stays hidden
until expanded via the same binding. Rendering does not change notification
payloads or delivery acknowledgement.

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

`getBashCoordinator()` reuses the semaphore implementation through a separate
process-global registry. Its fixed local scheduling tuple has no provider gate;
`maxBashConcurrency` defaults to 4 and never consumes agent permits.
Both task kinds bind residents to the main coordinator for common lifecycle
control. Lists expose both capacities; individual snapshots report their own.

`bash_bg` invokes POSIX `bash -c`, in the requested cwd with inherited environment.
Admission is durable before spawning. It defaults to immediate detachment;
optional `waitMs` lends a managed parent permit while waiting. Pre-detach
cancellation owns the command; later turn cancellation does not.
Stdout/stderr backpressure through a single open, no-follow `output.log` handle.
Per-stream UTF-8 decoders feed a tail bounded to 2,000 lines/50 KiB; coalesced
progress persists a sticky truncation flag. Full output is never recopied into
metadata. Stdin/EOF writes serialize, respect backpressure, and log successful
delivery without normalizing bytes. Cancelling a stdin wait cannot undo a
submitted write; settlement drains its logging lane.
Terminal settlement records exit status and detached notifications. Stop and
discard wait for process/pipes/log cleanup; actual I/O failures are retained
when metadata remains writable. Cleanup failures stay reachable for retry.
Live POSIX groups are killed on stop and normal process exit. SIGKILL/power
loss or intentional `setsid` escapes require OS supervision; restart never
signals a stored PID or replays a command.

Terminal quota, billing, budget, usage-limit, rate-limit/429, and
`ResourceExhausted` assistant errors suspend background runs and close their exact
provider/model tuple gate. Overload, 5xx, network, and timeout failures remain
ordinary failed runs. Closing a gate blocks queued and newly accepted work on
that tuple without aborting running siblings or delaying other tuples.
Successful turns reopen their exact tuple globally. Eligible `/continue` calls
also admit only suspended tasks in the caller's owned descendant tree, even
while their tuple gate remains closed. Recovery sends literal `Continue.` in
the existing logical run; another provider limit suspends it again.
Foreground runs fail rather than park behind a closed provider gate or restart
unattended. Each accepted run retains its background policy across config edits.

Detached initial runs and background Follow-ups persist bounded completion notifications;
detached suspensions persist status notifications, and startup reconciliation
persists interruption notifications. Exact parent routes inject them as custom
Steers and wake idle parents. Delivery is marked only after the parent's
`message_end` observes the deterministic task/run/type ID. Session startup
reconciles IDs in the transcript and resends only absent notices; semantic
parent shutdown clears process-local in-flight suppression. Synchronous initial
results and explicit stops do not notify.
Confirmed manual discards send a parent-context notice after discard succeeds.
It uses Pi's normal Steer delivery, without starting an idle turn or using the
discarded task's completion outbox.

Notification previews come from the run's latest reply, not transcript tails:
inputs and older replies never enter the preview. History/session paths link
to the full records. Previews are explicitly labelled and include the public
run index and exact `task_output` invocation. Bash previews keep the last 2 KiB,
UTF-8-safe with leading truncation; agents keep the first 2 KiB. Existing
completion notices still deliver and acknowledge after discard because paths
remain stable. Reading a result does not acknowledge notification delivery.

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
That extension also registers child-only `task_update({ progress })`. Explicit
tool allowlists must include it; discovery recognizes this child-only name.
The child handle's prompt method binds an immutable run ID through async-local
storage, so delayed callbacks cannot adopt a later run. Updates validate the
child identity, active run, lifecycle and abort/disposal signals inside the
metadata mutation lane. They normalize whitespace, reject control characters,
and neither change labels/state nor enqueue parent notifications.
Session-scoped depth is registered before extension startup and removed on
disposal. A managed lifetime signal aborts before SDK disposal, which does not
emit `session_shutdown`. It removes task/notification subscriptions and fences
pending visibility refreshes before extension contexts become invalid, without
stopping detached descendants during idle unload.

`agent` validates Definition, depth, model, label, and prompt before reserving
storage. Durable acceptance records queued metadata plus run/input log
boundaries before global scheduling. The resident runtime moves queued work to
running, writes assistant/tool events serially, and commits one terminal
outcome across completion/stop races. Synchronous waits lend managed parent
permits. Foreground calls wait for their own terminal metadata; cancellation
stops accepted work and descendants. With background execution enabled, zero
or expired waits only stamp detachment and never restart work.
Run-specific completion snapshots cannot be replaced by a later Follow-up.
Accepted child failures are task outcomes, not failed tool calls. Idle child
runtimes dispose while their private Pi session file remains cold-loadable.

`task_input` defaults to durable Follow-up. Foreground Follow-ups require an
idle task and wait for their own result; busy tasks reject them explicitly.
Background work retains up to 32 ordered
Follow-ups; settlement atomically promotes the queue head, and each run gets a
separate Pi prompt/outcome in the same session. Running Steers use Pi's queue
with the configured literal/template behavior. The runtime records Steers only
after their user message is observed, so stop/crash can drop undelivered input.
Non-running Steers deterministically become Follow-ups under the task mutation
lane. Idle/interrupted tasks cold-load from the retained immutable recipe and
expected Pi UUID, without rescanning mutable Definitions.
Bash input instead requires a running resident and omitted `delivery`; optional
`eof` closes stdin. Agent `delivery` and Bash `eof` fields follow enabled
producers or retained owned kinds. Bash tasks never cold-open or accept
Follow-ups. Task-tree recursion follows child session IDs only for agents.

`task_stop` aborts resident execution or cancels retained queued/suspended work,
clears Follow-ups, recursively stops descendants, and preserves the task's
session for later input. Completion and stop settle the active run by matching
its durable ID, so the first transition wins. `task_discard` stops and tombstones
the owned subtree in place and removes its active links. Unsupported versions
are decoded only for validated ownership; a private `.discarded.json` marker
preserves their unknown metadata unchanged. Malformed identities and unsafe
paths fail explicitly. Concurrent discards share one operation; repeats succeed.
Listing hides discarded tasks; input and restart remain prohibited while results
stay readable. Guidance delays discard until dependent work is integrated.
Old `archive/` contents remain untouched; no migration or automatic deletion.

The standalone Bun pruner defaults to dry-run; `--apply` permanently removes
eligible discarded trees, descendants first. It conservatively acquires all
existing/referenced parent partitions and refuses live ownership conflicts.
Unsettled work, pending notifications, unknown schemas, malformed/symlinked
artifacts, ambiguous ownership, and retained descendants block removal.
Absent links and stale execution state never authorize deletion. This is an
offline maintenance script, not a model tool or automatic orphan collector.

On quit/new/resume/fork, the outgoing runtime recursively stops resident and
retained descendants before releasing exact-parent leases. Reload skips this
path, preserving process-global residents. Non-reload startup scans only the
exact parent partition: stale active states become `interrupted`, queued
Follow-ups clear, and one deterministic interruption notification is retained.
Stable idle/interrupted records and malformed/orphaned files are never deleted.
Failed tree cleanup retains acquired/borrowed partition leases for retry;
shutdown releases its collected leases only after the whole tree stops.
Discard likewise releases a descendant partition only after cleanup succeeds.

`/lovely-agents` opens one selector for fresh Agent Definitions, durable tasks,
and the scoped config editor. Fixture helpers remain for tests, not in the
command menu. They seed states/outcomes plus queued, nested, discarded,
corrupt, large UTF-8, and live-transition cases. Their cleanup removes only
owner-marked `.fixture` task directories across direct and nested partitions.
Definition previews include their complete system-prompt body. Definition/task
detail views never rebind Pi's active session. Task actions include on-demand
Inputs / history (current/queued inputs plus the unparsed retained history) and
System prompt (only the captured Pi prompt, without explanatory text or a
duplicated Definition body). Missing captures produce a separate notification,
never substituted content or reconstruction from today's context files.
Static text views wrap and scroll with arrows, PgUp/PgDn, and Home/End.
Task views also provide event-driven live output, Follow-up/Steer entry, stop,
and discard. Shared live output uses a bounded wrapped viewport with arrows,
PgUp/PgDn, Home/End, and a position indicator. Bash starts at the bottom and
follows updates there; upward navigation pauses following, End resumes it.
The fixed Bash header shows exit code/signal without reducing the output viewport.
Agent output starts at the top. Navigation covers the retained snapshot only.
Foreground UI inputs use an Esc-cancellable loader, kept open until
owned work has stopped. Cancelled inputs do not show an acceptance notice.
Bash actions expose stdin/EOF and retained command/output details, not agent
prompt or model controls.
Active counts appear in
the footer and up to five active rows appear below the editor. Down on an empty
editor focuses that same panel, exposing all direct tasks and diagnostics in a
five-row scrolling list. `/lovely-agents` → Tasks hands off to the panel rather
than opening another selector. Task rows use the full available width for labels,
model/status, and prompt previews, avoiding SelectList's fixed primary column.
Child progress replaces the input preview when present; it also appears in
task details, live output, and model-facing `task_list`/`task_output`.
UI rows group Agents then Bash with nonselectable group headings. Within each
group, running/suspended/queued precede interrupted/idle; creation time is newest
first within a status, with task ID breaking ties. Selection follows task identity
across updates. The window shows up to five task rows plus group headings;
capacity stays in the footer and inspection.
Enter opens actions; Esc or Up past the first row returns to the editor, and
other input passes through unchanged. Action/output views hide the panel until
they close. The editor wrapper preserves and restores the prior factory.
Process-global update routes refresh these surfaces on durable metadata/output
writes and shared capacity/gate changes without polling. Panels omit internal
thinking/responding activity; inspection tools retain detailed progress and
timestamps. Panel disposal fences in-flight refreshes. Timed output reads watch
the task directory for durable run transitions; UI update routes remain separate.
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
Biome explicitly includes `extensions/`, `tests/`, `scripts/`, and the root
package, TypeScript and Biome JSON configs; editor/runtime files stay out of scope.
Tests prioritize lifecycle/ownership safety and reported regressions. Avoid
duplicating dependency tests, UI descriptor checks, and exact presentation text.

The initial `0.1.0` release uses manual npm publishing, before configuring
trusted publishing for CI. Later, `bun run release` verifies
and bumps locally, then pushes a `v*` tag. CI verifies the tag, stages the package
on npm with OIDC provenance, and creates a GitHub Release. The local release
driver asks for 2FA to approve the staged npm version.
