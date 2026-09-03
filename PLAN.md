# Lovely Agents design

## Product shape

Lovely Agents adds durable, in-process workers to Pi. Each worker is a normal Pi
SDK session with its own conversation, model context, tools, and extensions. No
child `pi` processes are spawned.

A typical interaction is:

1. The parent calls `agent_roster` to see which agent definitions are available.
2. The parent calls `agent` with a definition, label, and task prompt.
3. Lovely Agents creates a durable agent session and starts its first run.
4. The call waits briefly for a result. Long work detaches without restarting.
5. Detached results return through a notification.
6. The parent can later schedule another run with a Follow-up, or redirect a
   running agent with a Steer.
7. Separate task tools list, inspect, configure, stop, or discard the session.

The initial implementation covers agents. A background Bash producer will later
reuse the same task controls.

### Core identities

An **agent definition** is a Markdown file describing a reusable role. Its body
is the child's core system prompt.

An **agent session** is one durable Pi conversation created from a definition.
It has a stable Task Reference such as `a_k7m2p9x4` and belongs to exactly one
parent Pi session.

An **agent run** is one accepted period of work in that conversation. The first
prompt creates the first run; each Follow-up creates another. Run identifiers
and sequence numbers stay internal.

The **parent session** is the exact Pi session that created the agent session.
It may control direct children only. Descendant activity is summarized without
exposing descendant Task References.

## Defining agents

Definitions are discovered from:

- user: `~/.pi/agent/agents/*.md`
- project: the nearest ancestor `.pi/agents/*.md`, when Pi trusts that project

Project definitions override same-name user definitions. An invalid project
file still shadows the user file and reports an error; silently falling back
could execute the wrong role.

Example:

```md
---
name: reviewer
description: Review implementation correctness and risks
model: anthropic/claude-sonnet-4-5
thinking: high
tools: [read, grep, find, ls, bash]
exclude_agents_md: false
---

Review the requested change. Focus on correctness, regressions, and missing
verification. Return concrete findings with file paths.
```

`name` and `description` are required. Optional fields are `model`, `thinking`,
`tools`, and `exclude_agents_md`. Async and detach policy deliberately do not
belong in definitions; the description can tell the parent that a role is
usually long-running.

Validation is strict but isolated:

- names match `[a-z0-9][a-z0-9_-]{0,63}`
- descriptions are nonempty and at most 500 UTF-8 bytes
- the Markdown body is nonempty
- tools accept Pi's comma-string or YAML-list forms
- unknown keys, tools, models, thinking levels, and wrong value types are errors
- duplicate names within one scope invalidate that name
- one malformed file does not block unrelated definitions

Match Pi's reference filesystem behavior: inspect `.md` regular files and
symlinks. Broken or unreadable links become diagnostics. Project trust is the
trust boundary for linked project content.

Definitions are read only when `agent_roster` or `agent` is called. Both calls
scan fresh files, so a definition written earlier in the same parent turn is
immediately usable. There is no startup cache, per-turn polling, or watcher.

## Model-facing tools

Use one tool per operation. This costs more tool names than an action union, but
keeps schemas small and reduces malformed calls.

### Discover and create

`agent_roster` takes no arguments.

It returns:

- effective definitions sorted by name
- each definition's description, source, editable display path, and optional
  model/thinking/tools/context settings
- isolated invalid and shadowing diagnostics
- resolved model choices
- current and maximum delegation depth

The roster is never placed in the system prompt. Model-visible output is compact
YAML-like text and omits empty/default bookkeeping.
Generic tool guidance tells the model to call `agent_roster` before delegation
and after editing definitions.

`agent` creates a durable agent session and starts its first run:

```ts
{
  definition: string
  label: string
  prompt: string
  waitMs?: number
  model?: string
  thinking?: ThinkingLevel
  allowAgents?: boolean
}
```

`definition`, `label`, and `prompt` are required. Labels are display text, need
not be unique, and are limited to 1–80 UTF-8 bytes after trimming.

Creation returns the new task's stable identity, definition/label, state and
latest outcome, effective model/thinking, detachment state, bounded output,
retained paths, descendant summary, and a bounded inventory of existing direct
children. The inventory uses `task_list` ordering and whole-record truncation.

### Control existing tasks

```ts
task_list({})
task_output({ id: TaskRef, offset?: number, limit?: number, waitMs?: number })
task_input({ id: TaskRef, content: string, delivery?: "followup" | "steer" })
task_stop({ id: TaskRef })
task_discard({ id: TaskRef })
```

List, output, input, stop, and discard will also accept future `b_` Background
Bash references. For Bash, `task_input` writes stdin and rejects `delivery`.

Validation and creation failures are tool errors. Once work is accepted, child
failures become durable run outcomes and return as structured task state rather
than failed tool calls.

### Listing

`task_list` exposes direct children only. Each row includes identity, kind,
label/definition, state and latest outcome, effective model/thinking,
timestamps, detachment, queued Follow-up count, output line count, retained
paths, and descendant summary.

Descendant summaries contain counts by state/outcome and at most three active
labels. They never expose descendant Task References.

Rows are grouped in this order:

1. `running`
2. `suspended`
3. `queued`
4. `interrupted`
5. `idle`

Within a group, the newest update comes first; Task Reference is the stable
tie-breaker. Every direct task and diagnostic is returned in one result with
the total task count. Discarded tasks are hidden. Corrupt records appear
separately as diagnostics rather than synthetic task rows.

Task reads acquire the exact parent's partition lease. Descendant summaries
read atomic snapshots from nested partitions without taking control of those
partitions; they are informational and may race nested updates. Semantic
session shutdown releases an acquired direct lease, while reload preserves it
through the process-global registry.

### Reading output

`task_output` reads `output.md` with the same conventions as Pi's `read` tool:
`offset` is a 1-indexed line number and `limit` is a maximum line count. Output
keeps complete lines from the head of the requested range and is capped at
2,000 lines or 50 KiB, whichever comes first.

The result includes the returned line range, total current lines, next offset,
current task state, queued Follow-up count, and paths to every retained log.
Truncated results use Pi's continuation messages:

```text
[Showing lines X-Y of Z. Use offset=N to continue.]
[Showing lines X-Y of Z (50KB limit). Use offset=N to continue.]
```

`waitMs` waits until output size or state changes and caps at ten minutes. A
caller can follow live output by passing the previous `nextOffset`. Idle or
terminal work returns immediately. Normal file tools can inspect retained files
directly.

## Runs and input

### Initial run

Creation waits for the first result by default:

- `waitMs` overrides the configured default
- the wait begins when work is accepted, including capacity queue time
- completion before the deadline returns only through the `agent` result
- reaching the deadline detaches the unchanged run; it does not abort or restart
- `waitMs: 0` detaches immediately

While the call remains synchronous, cancelling the parent tool call stops the
run. After detachment, parent-turn cancellation no longer owns it; only
`task_stop` or closing the parent session aborts it.

Timeout, cancellation, stop, and natural completion use serialized
first-writer-wins transitions.

### Follow-up versus Steer

A Follow-up means “do this after the work already accepted.” A Steer means
“incorporate this into what you are doing now.”

| Delivery | Valid states | Creates a run | Behavior |
| --- | --- | ---: | --- |
| `followup` | `idle`, `interrupted`, `queued`, `running`, `suspended` | yes | Starts an idle session or queues behind accepted work. |
| `steer` while running | `running` | no | Enters the active run through Pi's steering queue at its next safe boundary. |
| `steer` otherwise | every non-discarded state | yes | Falls back to a Follow-up because there is no active run to steer. |

`task_input` defaults to `followup`. Follow-ups always return asynchronously and
each produces its own completion notification. A session may hold at most 32
queued Follow-ups. Every task summary includes `queuedFollowUps`.
`task_input` also returns the effective delivery and, for a Follow-up, its queue
position.

Initial, Follow-up, and Steer text must be nonblank and at most 64 KiB. They do
not change model or thinking settings.

A Steer delivered to a running agent is run-scoped. It is logged only when Pi
delivers it. If stop or crash wins before delivery, the Steer may be lost; it is
not persisted as a mailbox or replayed after restart. State transitions and
input delivery are serialized, so a completion race deterministically converts
the input to a Follow-up.

### Stop and discard

`task_stop` is idempotent. It aborts active work, removes capacity waiters,
clears queued Follow-ups, preserves files, and leaves the session reusable with
latest outcome `stopped`.

Stop and completion share one serialized transition:

- if stop commits first, no redundant completion notification is sent
- if completion commits first, stop is a no-op and its notification remains

`task_discard` stops work and writes a durable hidden tombstone. It is
idempotent, has no undelete operation, and never removes files. A discarded task
rejects later model I/O except repeated discard; the discard result returns its
retained paths.

## Session state and residency

The current session state is one of:

| State | Meaning |
| --- | --- |
| `idle` | No run is accepted or executing. |
| `queued` | A run is waiting for local agent capacity. |
| `running` | A run owns capacity and is executing. |
| `suspended` | A run is waiting for provider/model quota recovery. |
| `interrupted` | Accepted work was lost across an unclean process boundary. |

The latest run outcome is independently `succeeded`, `failed`, `stopped`, or
`interrupted`. Success, failure, and stop return the session to `idle`.
Detachment is not a state.

Dispose an idle in-memory Pi AgentSession immediately. A later Follow-up
cold-loads `session.jsonl`, preserving Pi's session UUID and provider cache
affinity. Cold unloading is an implementation detail, not parent-session
closure, and does not stop detached descendants.

Graceful `quit`, `/new`, `/resume`, and `/fork` close the outgoing parent session
and recursively stop its owned tasks. `/reload` keeps the same parent session
and active work.

An unclean process exit cannot preserve execution. On reopen:

- stable idle sessions remain reusable
- stale `queued`, `running`, or `suspended` work becomes `interrupted`
- queued Follow-ups are cleared
- the latest run outcome becomes `interrupted`
- one interruption notification is reconciled
- a new explicit Follow-up is required to work again

Deleting or losing a parent session leaves its task partition orphaned forever.
Tasks are never adopted or garbage-collected automatically.

## Building a child session

### Model and thinking

Configured `models` are the explicit model choices returned by `agent_roster`
and accepted by `agent`. A searchable multi-select lists authenticated Pi
models. If none are selected, the only explicit choice is the current parent
model.

Omitting `model` inherits the current parent model. The effective thinking level
uses call override, then definition default, then the parent thinking level.

Pi clamps unsupported levels. Persist and return the effective model and level.
Missing authentication is a creation error. Model and thinking are fixed when
the agent session is created; later definition or config changes do not alter
that session. Starting another agent is the v1 way to switch models.

### Tools and delegation depth

If a definition omits `tools`, the child gets normal Pi built-ins and enabled
extension tools. An explicit list is a hard allowlist. This is the only default
capability restriction; write behavior is otherwise guided by the definition
prompt.

Root depth is `0`. Creation beyond configured `maxDepth` is rejected. A child
receives Lovely Agents creation tools only when its creation call explicitly
sets `allowAgents: true` and depth remains. The default is false. Definitions do
not carry numeric depth budgets.

Parents control direct children only. Nested work has no model-visible
hierarchical address. Direct child-to-child communication is deferred.

### System prompt and extensions

The parent system prompt is not inherited. Build the child prompt in this order:

1. definition body as the role's core prompt
2. Pi's generated active-tool list
3. Pi's dynamic/tool-specific guidelines and standard concise/path guidance
4. Pi append-system resources such as `APPEND_SYSTEM.md`
5. discovered skills
6. current working directory
7. discovered global/project instruction files

Replacement `SYSTEM.md` is ignored because it would displace the definition.
By default the child receives Pi's discovered AGENTS/CLAUDE instruction files.
`exclude_agents_md: true` removes those files while retaining append resources,
skills, cwd, extensions, and tool metadata.

Enabled extensions load normally in every child and get independent runtimes.
Their tools and hooks continue to work. Their `before_agent_start` hooks run
after Lovely Agents composes the prompt and may modify or replace it.

Child input is literal by default: initial prompts, Follow-ups, and Steers reach
the model exactly as supplied. The `expandPromptTemplates` setting can instead
opt them into Pi's skill-command, prompt-template, and extension-command
expansion.

## Configuration reference

Use `@xl0/pi-lovely-config` with the standard user/workspace precedence:

- user: `~/.pi/agent/xl0-pi-lovely-agents.json`
- workspace: `<ctx.cwd>/.pi/xl0-pi-lovely-agents.json`
- workspace values override user values

| Setting | Default | Meaning |
| --- | ---: | --- |
| `models` | `[]` | Models the parent may explicitly select for a child. The searchable multi-select lists authenticated Pi models; empty exposes only the current parent model. |
| `maxConcurrency` | `4` | Maximum number of agent runs executing in this OS process. |
| `maxDepth` | `2` | Maximum delegation depth. |
| `waitMs` | `30000` | Default wait for an initial result. Zero detaches immediately. |
| `expandPromptTemplates` | `false` | Send child input literally when false. When true, Pi interprets skill commands, prompt templates, and extension commands before delivery. |

Editor changes affect future work immediately. Lowering concurrency lets current
runs drain. Model choices affect only newly created sessions; depth and wait
affect future creation calls; input expansion affects future delivered input.
No config edit mutates an active run. External file edits take effect after
`/reload`.

## Scheduling and quota

### Local scheduling

One process-global FIFO semaphore enforces `maxConcurrency`. All parent and
child extension runtimes share it. Local saturation queues work instead of
failing. Future Background Bash uses a separate semaphore.

Permits are cooperative: a managed agent holds one only while its own run can
advance. When it synchronously waits for a newly accepted descendant, it first
queues that descendant, lends its permit, and reacquires a permit before
returning the tool result to its own model loop. A blocking `task_output` wait
does the same. An immediately detached creation does not lend a permit because
the caller does not wait.

This avoids the nested deadlock where every active parent holds a permit while
waiting for children that cannot start. FIFO ordering still applies to both new
runs and parents waiting to reacquire. The Agent semaphore does not attempt to
bound unrelated tool processes; Background Bash has its own capacity policy.

### Provider limits

Quota Suspension is scoped to the exact provider/model tuple. It applies only
to explicit provider-limit failures:

- quota, billing, budget, or usage-limit errors
- terminal rate-limit, HTTP 429, or too-many-requests errors
- terminal `ResourceExhausted`

Exhausted overload, generic 5xx, network, and timeout failures become ordinary
failed runs after Pi's retry policy. They do not close a tuple gate.

When a provider limit is detected:

- the failed run becomes `suspended`
- queued and newly accepted work on that tuple cannot start
- already-running siblings drain rather than being aborted
- a sibling suspends only if it independently reaches a provider-limit error
- other tuples continue

A synchronous `agent` call returns as soon as its run suspends; waiting for the
remaining deadline cannot help. Detached suspension produces a
bounded status notification so the task cannot remain silently stuck.

A successful parent turn on the same tuple proves recovery and globally requeues
suspended runs for that tuple in original acceptance order. When the latest
parent reply ended with `error` or `aborted`, `/continue` wakes all suspended
descendants owned by that parent, regardless of tuple. It then injects a hidden,
empty custom message with `triggerTurn: true` and Follow-up delivery. This enters
Pi's normal retry, compaction, and queue handling without adding visible
`Continue.` text to the parent transcript or model request. After a successful
parent reply, `/continue` is a silent no-op. Do not call `Agent.continue()`
directly.

An abort during tool execution never automatically re-executes that tool. Pi
settles and persists its error or success result first; continuation retains
that result and lets the model decide whether to issue another call. Blind
replay could duplicate partially completed, non-idempotent effects.

A resumed child receives an internal literal `Continue.` prompt but remains in
the same logical run. Another limit failure suspends it again. Suspended work
does not survive process restart; stale suspension becomes `interrupted`.

## Persistence and output

Use `ctx.cwd` as the workspace root, matching Pi project settings, trust, and
Lovely Config.

```text
<ctx.cwd>/.pi/lovely-agents/
  .gitignore
  <parent-session-uuid>/
    .lease
    <task-ref>/
      metadata.json
      session.jsonl
      output.md
      activity.md
```

On first use, create this file without overwriting an existing one:

```gitignore
*
!.gitignore
```

Create runtime directories and files owner-only (`0700`/`0600`) where the
platform supports it. Definition files retain their existing permissions.

Parent partitioning is the ownership/listing index; there is no central index.
Descendant summaries follow child Pi session UUIDs into their own parent
partitions.

`metadata.json` is a versioned current snapshot containing identity, ownership,
state/outcome, fixed model settings, run state, queued Follow-ups, tombstone,
and notifications. Per-task mutations are serialized. A durable mutation is
acknowledged only after temp write, fsync, and atomic rename.

One PID lease protects each open parent partition. Reload and same-process
rebind reuse it. A second live OS process opening the same parent session gets an
explicit Lovely Agents read/control failure instead of risking corruption. A
stale crash lease is reclaimed.

Startup scans only the exact parent partition. Malformed or newer unsupported
metadata is left untouched and reported by path.

### Retained logs

`session.jsonl` is Pi's authoritative, unabridged transcript.

`output.md` contains run boundaries/outcomes, delivered initial/Follow-up/Steer
inputs, and assistant text. It excludes reasoning and tool activity.

`activity.md` indexes tool calls. Each argument and result keeps at most a 2 KiB
head/tail preview, exact omission counts, and any tool-provided full-output
path.

Model-visible paths are relative to `ctx.cwd` when inside the workspace. User
definition paths use readable home-relative display. Files remain after stop,
discard, orphaning, or metadata corruption.

## Notifications

A synchronous initial completion returns only through `agent`; it is not also
sent as a notification.

Detached initial runs and Follow-ups produce one completion notification when
they succeed or fail. Explicit stop does not notify because the tool result or
management UI already reports it. Quota Suspension may produce one nonterminal
status notification.

A completion notification includes:

- Task Reference and label
- state and latest outcome
- effective model and thinking level
- up to 2 KiB of final output tail
- retained output/activity/session paths
- compact descendant summary

Notification state is persisted before delivery. A live parent receives a
custom Pi Steer, allowing its current work to reach a safe boundary. An idle
parent is awakened. If the exact parent session is unavailable, the notification
remains pending until that session is reopened.

Every notification has a deterministic task/run/type ID. It is marked delivered
only when the parent session's `message_end` observes that ID. Reconciliation
scans the parent transcript: an existing ID is marked delivered; an absent ID is
resent. This closes the send/crash window without duplicating model context.

## Human commands

- `/continue`: after an errored or aborted parent reply, wake owned suspended
  descendants and resume through a hidden empty custom message; successful
  replies are a silent no-op
- `/lovely-agents`: inspect Agent Definitions and direct tasks, create/remove
  development fixtures, and edit scoped config. As task controls become
  available, this same UI gains live output, Follow-up/Steer, stop, and discard.

The management command keeps the main Pi session active; it never rebinds the
TUI to a child session file. Compact status, below-editor active rows,
empty-editor Down, and live task controls arrive after execution exists.

There is no parallel slash-command syntax for every model tool.

## Deferred scope

- Background Bash producer
- parent-context forks
- passive mailboxes and direct child-to-child communication
- model-visible hierarchical addressing
- built-in sandboxing and hard capability enforcement
- worktree isolation
- automatic retention or garbage collection
- native TUI switching into an idle child session
- switching the main TUI into a running child, which needs a new Pi host API

## Implementation plan

Work in order. A section is complete only when its focused tests, typecheck, and
targeted Biome check pass. Keep `CODE.md` synchronized with implemented state.
Do not mix the unrelated `.vscode/settings.json` formatting issue into these
changes.

Expected module split, adjusted only when a file stays too small to justify
itself:

```text
extensions/lovely-agents/
  index.ts          extension registration and lifecycle wiring
  config.ts         Lovely Config schema and model resolution
  definitions.ts    Agent Definition discovery and validation
  state.ts          metadata, storage, leases, retained output
  coordinator.ts    process-global scheduling and runtime registry
  agents.ts         child session creation and run lifecycle
  tools.ts          model-facing tool definitions
  ui.ts             commands, status, widget, and inspector
```

Tests live under `tests/lovely-agents/`. Prefer pure helpers and temporary
directories over mocks; introduce a session/provider seam only where an
in-process Pi integration cannot be tested directly.

### [x] 0. Design contract

The preceding sections are the implementation contract. Definitions, durable
session/run identity, tool schemas, parent ownership, fixed model selection,
cooperative concurrency, persistence, quota recovery, notification delivery,
and v1 TUI scope are settled.

### [x] 1. Bootstrap, configuration, and roster

Added the hidden guarded `/continue`, Bun test baseline, Lovely Config user /
workspace settings and searchable multi-model selector, strict fresh-call
Definition discovery, and `agent_roster`. Discovery honors trust,
nearest-project precedence, invalid shadowing, symlinks, and isolated
diagnostics.

### [x] 2. Durable task foundation and management

#### [x] 2.1 State schema and private storage

Added strict v1 metadata, safe parent/task paths, atomically reserved Task
References, owner-only storage, non-destructive `.gitignore` creation, and
serialized fsynced snapshot replacement. Invalid and unsupported snapshots are
reported without modification.

#### [x] 2.2 Parent partition lease

Added an atomic versioned PID/token lease with process-global reuse, serialized
same-process acquisition, explicit live-owner conflicts, stale-PID recovery,
ownership-checked release, and conservative handling of malformed leases.
Simultaneous stale takeover is deliberately best-effort.

#### [x] 2.3 Retained output

Added private `output.md` and `activity.md` writers with stable run/tool
boundaries and bounded UTF-8-safe activity previews. Added line counting,
workspace-relative retained paths, 1-indexed whole-line reads under the
2,000-line/50 KiB caps, continuation markers, and active-task long-polling.
Pi remains the sole writer of authoritative `session.jsonl`.

#### [x] 2.4 `task_list` and `task_output`

Added leased read-only tools over durable metadata. `task_list` provides stable
state/recency ordering, the complete direct-task set, tombstone filtering,
isolated diagnostics, output counts, retained paths, and recursive descendant
summaries without nested references. `task_output` enforces direct ownership
and exposes bounded retained ranges with continuation and long-poll metadata.

#### [x] 2.5 Interactive management UI

Expanded `/lovely-agents` into one interactive entry point for fresh Agent
Definition discovery, durable direct-task inspection, developer fixtures, and
the existing scoped config editor. The always-visible developer menu can seed
all states/outcomes, queued Follow-ups, descendants, tombstones, corrupt
metadata, large UTF-8 output, and a short live transition. Cleanup explicitly
removes only marked fixture directories, including nested fixture partitions.

### [ ] 3. In-process Agent execution

#### [x] 3.1 Process-global coordinator

Added one versioned process-global coordinator with reload-safe resident and
notification bindings, exact provider/model gates, and an acceptance-ordered
FIFO Agent semaphore. Config changes resize it without aborting active work.
Managed async context supports cooperative permit lending for nested waits and
blocking `task_output`; reacquisition is FIFO and bypasses gates for work that
was already running.

Deterministic tests cover saturation, reductions, tuple isolation, cancellation,
four-parent/four-child and nested deadlocks, immediate detach, and
reacquisition order.

#### [x] 3.2 Child session construction

Added persistent in-process Pi SDK child construction at the retained
`session.jsonl` path. Model/thinking resolution follows call, Definition, then
parent precedence; effective settings and scoped model choices stay fixed.
Explicit Definition tools remain a hard allowlist, omitted tools retain normal
built-ins/extensions, and `agent` is removed unless depth and `allowAgents`
permit delegation.

A hidden first extension composes the Definition-owned prompt from Pi's active
tool metadata, guidelines, append resources, context, skills, and cwd before
normal extension hooks. `SYSTEM.md` is ignored, `exclude_agents_md` is honored,
project trust is inherited, and prompt expansion policy is explicit.

Tests inspect selection failures, depth/tool policy, prompt composition,
persistent paths, context inclusion/exclusion, extension loading/startup,
managed depth, model/thinking, and scoped choices.

#### [ ] 3.3 `agent` and initial run lifecycle

Register `agent`, validate all input before acceptance, durably create metadata
and logs, then enqueue the first run. Implement wait-from-acceptance semantics,
`waitMs: 0`, detachment without restart, synchronous cancellation ownership,
structured accepted failures, and first-writer-wins completion/stop races.

Stream session events into retained logs. Dispose idle child runtimes and
cold-load the same `session.jsonl` later without changing its Pi UUID.

Done when integration tests cover success/failure before timeout, queue-time
detachment, immediate detach, cancellation before/after detach, log contents,
cache-stable cold loading, and rich creation results.

#### [ ] 3.4 Parent lifecycle and restart reconciliation

Recursively stop owned work on graceful quit/new/resume/fork, but preserve it
across reload. On startup, keep reusable idle tasks and convert stale
queued/running/suspended work to interrupted while clearing Follow-ups.

Done when lifecycle tests cover every shutdown reason, recursive descendants,
reload rebinding, crash fixtures, orphan retention, and one reconciled
interruption notification record.

### [ ] 4. Agent controls

#### [ ] 4.1 Follow-up and Steer

Implement durable Follow-up acceptance, 32-entry queue limits, queue positions,
and sequential runs in one Agent Session. Implement running Steer through Pi's
queue; under the task lock, fall back to Follow-up whenever no run remains
active. Persist only delivered Steers in logs.

Done when tests cover every source state, running/completion races, effective
delivery, queued count in all task results, dropped undelivered Steers, and cold
Follow-ups.

#### [ ] 4.2 Stop and discard

Implement idempotent `task_stop` and `task_discard`. Stop aborts/removes active
or queued work, clears Follow-ups, preserves the reusable session, and resolves
completion races once. Discard stops first, durably tombstones, hides from
listing, rejects later I/O, and retains files.

Done when tests cover queued/running/suspended/idle calls, repeated calls,
stop/completion ordering, descendant behavior, queue clearing, tombstone
visibility, and retained paths.

### [ ] 5. Quota recovery and notifications

#### [ ] 5.1 Provider-limit classification and tuple gates

Classify terminal quota/rate/billing/`ResourceExhausted` failures after Pi retry
handling while excluding overload, 5xx, network, and timeout failures. Suspend
the failed run, close its exact provider/model gate, preserve acceptance order,
and let already-running siblings drain.

Done when provider-fixture tests cover every included/excluded error family,
independent tuples, queued/new work, sibling draining, repeated suspension, and
restart-to-interrupted conversion.

#### [ ] 5.2 Recovery triggers

Observe successful parent turns and reopen the matching tuple globally. Extend
an eligible `/continue` to requeue all suspended owned descendants before
injecting its hidden parent marker. Keep it a silent no-op after a successful
parent reply. Resume each child within the same logical run through an internal
literal `Continue.` prompt.

Done when tests cover tuple-specific automatic recovery, cross-tuple manual
recovery after a parent error/abort, successful-parent no-op, acceptance
ordering, ownership/depth boundaries, and repeated quota failure.

#### [ ] 5.3 Durable notification delivery

Persist bounded completion, suspension, and interruption notifications before
delivery. Route live delivery as a custom parent Steer; retain it while the
exact parent is unavailable. Use deterministic task/run/type IDs and mark
delivered only when parent `message_end` observes the ID.

Reconcile IDs against the parent transcript after restart, resending only
absent notifications. Never duplicate synchronous initial results or explicit
stop outcomes.

Done when crash-window tests cover persist-before-send, send-before-observe,
observe-before-mark, parent offline/reopen, transcript deduplication, payload
bounds, and descendant summaries.

### [ ] 6. Live controls and release readiness

#### [ ] 6.1 Live task controls and status

Extend the unified `/lovely-agents` UI after task controls exist. Show compact
active counts with `setStatus` and active rows in a below-editor widget. Support
live output, Follow-up/Steer entry, stop, discard, and queue state without
rebinding the main Pi session. Down on an empty editor opens the task view.

Keep print/JSON behavior noninteractive and plain. Share rendering state through
the coordinator so child events request parent TUI updates without polling.

Done when manual TUI checks cover narrow/wide terminals, no-task/running/idle
views, live updates, keyboard help, empty-editor Down behavior, cancellation,
and reload cleanup.

#### [ ] 6.2 Documentation and package verification

Update README examples, Agent Definition format, tool reference, storage/privacy
notes, lifecycle semantics, and deferred Background Bash scope. Update
CHANGELOG and `CODE.md` to actual implementation state.

Run:

```sh
bun test
bun run typecheck
bun run biome:check
bun pm pack --dry-run
npm pack --dry-run
```

Full Biome remains contingent on the unrelated `.vscode/settings.json` being
formatted or excluded; targeted project checks must pass regardless. Verify the
packed archive contains runtime dependencies and only intended package files.
Publish the Lovely Config release containing `multiEnum` before package
verification; development uses `bun link`.
