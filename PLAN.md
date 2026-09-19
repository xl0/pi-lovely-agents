# Lovely Agents design

## [x] Model availability

Published Lovely Config `0.1.4` provides advisory model-array and alias
validation: retain saved IDs, warn separately and skip unavailable entries
without losing available ones or implicitly selecting the parent when all
explicit entries are unavailable.
Runtime and dev dependencies are pinned exactly; `.npmrc` keeps future Bun/npm
additions exact while peer compatibility ranges stay separate.
Full `bun run check` passes (238 tests, typecheck and Biome) with Pi packages
locally linked from `../pi-mono`. A Bash stdin-history timing test failed once
and passed on the full rerun.

## [x] Conflicting-session warning

Acquire ownership before startup recovery or route registration. On conflict,
show one warning plus a persistent footer with the owner PID and `/resume` hint;
hide Lovely tools and skip notification observation and foreign-task cleanup.
Regression coverage verifies retained bytes, disabled controls, warning cleanup,
reload allowlists and independent sessions in the same workspace.
Full `bun run check` passes: 237 tests, typecheck and Biome.
Pi-level conversation locking remains outside this extension's scope.

## [x] Child-authored progress

Child-only `task_update({ progress })` reports up to 240 characters, bound to its
own run. Labels/state stay unchanged; no parent notifications. Inspection and
the panel show progress instead of the initial-input preview. Explicit tool
allowlists remain strict. New runs clear reports; indexed results retain them.
Regression coverage verifies availability, cancellation/disposal and stale-run
fencing, reset/retention, non-notification, and UI rendering.
236 tests, typecheck and Biome pass. Live two-run testing after reload
confirms successful progress calls, reset on Follow-up, per-run retention,
stable labels, and completion-only notifications.
An existing Bash startup-timing test failed once and passed on rerun.

## Field-feedback follow-up

Sources: the CAD build session's `SUBAGENTS-FEEDBACK.md` and
`../pi-lovely-ide/AGENT_FRAMEWORK_FEEDBACK.md` from a multi-agent review.
Make completed runs addressable, keep evidence paths stable, and reduce output
and coordination friction. Preserve ownership, durable acceptance, late-event
fencing, and notification reconciliation; avoid a workflow engine.

### [x] Guidance and output

Bash guidance explains automatic detached completion notices and their
synchronous/stop exceptions. Steer acknowledgements report queued acceptance
and explicit Follow-up conversion, with the targeted run index. Roster capacity
is labelled process-wide; creation reports queue reasons. Keep idle specialists
and evidence until dependent work is integrated.
The packaged delegation skill limits implementation delegation to embarrassingly
parallel changes, including independence from the parent's edits. Coupled work
stays in the parent; integration checks wait for relevant writers to finish.

Bash notices keep the last 2 KiB, UTF-8-safe with leading truncation.
`task_output(lines: N)` returns the last N Bash lines with status and the full-log
path. Shared live output supports wrapped keyboard scrolling; Bash follows
the tail until upward navigation, and End resumes following. Its fixed header
shows exit code and termination signal without reducing the output viewport.
The task UI groups Agents and Bash separately, active statuses first within each
group, then newest-created. Nonselectable group headings preserve task navigation.

### [x] Run-index retrieval

Use one public 1-based run index in results, acknowledgements and notices.
`task_output(id, run: N)` retrieves that run; omission reads current progress.
Timed waits pin the selected/observed run through subsequent promotions.
Final agent replies persist in per-run files before settlement publishes;
current progress still clears when the next run starts. Older completed runs
remain accessible through history, without a migration or Markdown parser.

### [x] Stable storage, notifications and explicit pruning

Discard stops and tombstones in place; files never move. A parent's `active/`
directory links to all non-discarded tasks, including idle ones. Membership is
metadata-owned and links are rebuildable. Unsupported metadata gets an
ownership-validated discard marker rather than being rewritten.

Results remain readable after discard, but input/restart stays prohibited.
Notices include labelled previews and exact run retrieval; delivery and
acknowledgement continue at stable paths. No result-consumption protocol.

The standalone pruner defaults to dry-run and requires `--apply` to delete
explicitly discarded trees. Leases, metadata, pending notices, and descendant
safety control eligibility—not absence from `active/`. Stale non-discarded
tasks stay until their parent is reopened; abandoned sessions need no automatic
cleanup. Old archive directories are left untouched.

### [x] Final verification

236 tests pass, including promotion/retrieval, queued run waits, UTF-8 tails,
scrolling/grouped navigation, live exit status (unknown, 0, 7, SIGTERM),
post-discard notices, pruning guards, and failed cleanup lease retention.
Typecheck, Biome and npm pack dry-run pass. Biome uses an explicit allowlist
for source, tests, scripts and root JSON configs, excluding editor/runtime files.
Restart Pi before trying the branch so process-resident runtimes use the new code.
Live smoke testing after reload also passed: three indexed agent runs, Steer
conversion, post-discard reads/input rejection, stable active links, Bash
UTF-8 tails/failure notices, notification acknowledgement, and prune lease refusal.
Live UI appearance is confirmed by the user; navigation/grouping component
tests pass.

External review Definition/skill changes remain separate from this branch:
distinguish role
instructions from repository rules, start with fewer correctness-focused angles,
preserve documented safety invariants, and accept empty findings freely.
Peak-memory accounting, batch APIs, dependency graphs, and PTY/tmux support
remain deferred.

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

Agents and Background Bash share task controls. Bash tasks are shell processes,
not Pi SDK sessions.

### Core identities

An **agent definition** is a Markdown file describing a reusable role. Its body
is the child's core system prompt.

An **agent session** is one durable Pi conversation created from a definition.
It has a stable Task Reference such as `a_k7m2p9x4` and belongs to exactly one
parent Pi session.

An **agent run** is one accepted period of work in that conversation. The first
prompt creates the first run; each Follow-up creates another. A 1-based sequence
addresses each run publicly; opaque run IDs remain internal fencing identities.

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
retained paths, and descendant summary. Model-visible text stays focused on the
new task; existing direct children remain available through `task_list`.

### Control existing tasks

```ts
task_list({})
task_output({ id: TaskRef, run?: number, lines?: number, waitMs?: number })
task_input({ id: TaskRef, content: string, delivery?: "followup" | "steer" })
task_stop({ id: TaskRef })
task_discard({ id: TaskRef })
```

List, output, input, stop, and discard accept `b_` Background Bash references.
For Bash, `task_input` writes literal stdin, rejects `delivery`, and supports
`eof: true` to close stdin. Completed commands cannot restart.

Validation and creation failures are tool errors. Once work is accepted, child
failures become durable run outcomes and return as structured task state rather
than failed tool calls.

### Listing

`task_list` exposes direct children only. Each row includes identity, kind,
label/definition, state and latest outcome, effective model/thinking,
timestamps, detachment, queued Follow-up count, output line count, retained
paths, last observed activity, queue reason, and descendant summary.
Lists and output snapshots also report held/max process-wide execution permits.
Queued reasons distinguish an exact provider/model gate (`provider-limit`),
local saturation (`capacity`), and the transition into execution (`starting`).
Permit counts are not running-state counts because child waits can lend permits.
No queue position or ETA is inferred.

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

`task_output` returns only the latest assistant reply from the selected run,
partial while streaming. It excludes inputs, tool logs, and earlier replies.
Starting a new run clears the prior answer, including while queued. Run
status/outcome is independent of assistant-message completion.
For Bash, it returns a bounded stdout/stderr tail, exit code/signal, sticky
truncation status, and a path to the complete `output.log`. Optional `lines`
limits the last N Bash lines. Optional `run` selects a 1-based index; omission
selects the current snapshot. Completed results remain readable after discard.

Snapshots are capped at 2,000 lines/50 KiB with UTF-8-safe truncation and a
reference to `history.md` for full replies. There are no offsets or pages.
Structured details include status, outcome, streaming, queued Follow-ups,
truncation, and retained history/session paths.

`waitMs` waits for the observed run to end or suspend, capped at ten minutes.
Partial output, thinking/tool activity, and capacity changes do not end the wait.
Timeout returns the latest snapshot without stopping work. Idle, interrupted,
and suspended tasks return immediately; omitting `waitMs` always reads immediately.
A newer Follow-up cannot extend the wait or replace the selected run's result.
Normal file tools can inspect `history.md` directly.

Last activity records observed start, thinking, reply, or tool events, not
bookkeeping writes. Thinking/tool-update heartbeats are capped at one per
second and contain no reasoning or tool payloads. Reply and activity updates
coalesce together; a new run clears the previous run's activity.

## Runs and input

### Capabilities

`backgroundAgents` and `backgroundBash` are independent on/off switches, both
on by default. `backgroundAgents` enables
detachment and asynchronous Follow-ups. Without it, creation waits for a terminal
result, Follow-ups require an idle task and wait for their own result, and
cancellation stops foreground work. Foreground provider-limit failures settle
without unattended recovery. Accepted runs retain their execution policy across
config edits.

`backgroundBash` exposes `bash_bg`; normal Pi `bash` stays unchanged.
Context forks have no setting or tool
until the required Pi SDK changes land.
Creation tools follow depth and delegation permission; task controls remain
available when there is an enabled producer or owned work/diagnostics.
Original SDK/Definition tool allowlists are never bypassed.
Tool schemas/descriptions refresh on configuration changes: `waitMs` appears
only with background agents; nested-delegation options require remaining depth.

### Initial run

With `backgroundAgents`, creation waits briefly for the first result:

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

`task_input` defaults to `followup`. Background Follow-ups return asynchronously and
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

`task_discard` stops and tombstones the owned subtree in place, returning its
stable task directory. It is idempotent and never deletes files. Unsupported
versions use an ownership-validated marker without rewriting their metadata.
Later input/restart is rejected, but results remain readable. The active browsing
links are removed; canonical files stay until explicit pruning.

Prompt policy: discard tasks after dependent work is integrated and no Follow-up
is expected; retain reusable specialists. Idle sessions already unload, so no
automatic idle deletion or retention timer is needed.

## Session state and residency

The current session state is one of:

| State | Meaning |
| --- | --- |
| `idle` | No run is accepted or executing. |
| `queued` | Accepted work is starting, capacity-blocked, or tuple-gated. |
| `running` | A run is executing, with cooperative permit lending during child waits. |
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
models. If none are selected, the parent model is included. Enabled alias
targets are always added, without requiring duplicate selection in `models`.

`fast`, `smart`, and `workhorse` are optional user-selected model + thinking
presets. The roster explains their intended uses; selection remains the parent's
decision, with no automatic routing. Both calls and Definitions may use aliases.
Unavailable or disabled aliases fail explicitly when requested.

Omitting `model` uses the Definition model, then the parent. Explicit call
thinking wins over everything. A call-selected alias supplies thinking ahead
of the Definition default; a Definition's own thinking overrides its alias
preset. Otherwise thinking inherits from the parent. Explicit model IDs do not
pick up thinking from aliases pointing at the same model.

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
| `backgroundAgents` | `true` | Allow detached agents and asynchronous Follow-ups. Otherwise agents stay foreground. |
| `backgroundBash` | `true` | Expose `bash_bg` and its stdin/EOF controls. |
| `models` | `[]` | Additional model IDs. Empty includes the parent; enabled alias targets are always included. |
| `fastModel` / `fastThinking` | `disabled` / `low` | Cheap, low-latency preset for straightforward work. |
| `smartModel` / `smartThinking` | `disabled` / `high` | Most capable preset for difficult reasoning and complex work. |
| `workhorseModel` / `workhorseThinking` | `disabled` / `medium` | Balanced preset for routine coding and research. |
| `maxConcurrency` | `4` | Maximum number of agent runs executing in this OS process. |
| `maxBashConcurrency` | `4` | Independent maximum of background Bash processes. |
| `maxDepth` | `2` | Maximum delegation depth. |
| `waitMs` | `30000` | Default wait for an initial result. Zero detaches immediately. |
| `expandPromptTemplates` | `false` | Send child input literally when false. When true, Pi interprets skill commands, prompt templates, and extension commands before delivery. |

Editor changes affect future work immediately. Lowering concurrency lets current
runs drain. Model choices affect only newly created sessions; depth and wait
affect future creation calls; input expansion affects future delivered input.
No config edit mutates an active run. External file edits take effect after
`/reload`.
Alias model fields are searchable authenticated-model selectors; thinking
fields appear when their alias is enabled. Existing tasks retain concrete model
identities and effective thinking even after an alias changes or is disabled.

## Scheduling and quota

### Local scheduling

One process-global FIFO semaphore enforces `maxConcurrency`. All parent and
child extension runtimes share it. Local saturation queues work instead of
failing. Background Bash uses a separate semaphore.

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

- background runs become `suspended`; foreground runs fail without unattended recovery
- queued and newly accepted work on that tuple cannot start
- already-running siblings drain rather than being aborted
- a sibling suspends only if it independently reaches a provider-limit error
- other tuples continue

With background execution enabled, an `agent` call returns as soon as its run
suspends; waiting for the remaining deadline cannot help. Detached suspension produces a
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
    active/
      <task-ref> -> ../<task-ref>  # non-discarded tasks, including idle ones
    <task-ref>/
      metadata.json
      session.jsonl        # agents only
      output.log           # Bash only
      history.md
      runs/<index>.json     # settled agent replies, stable across promotion
      .discarded.json       # only for discarded unsupported metadata
```

On first use, create this file without overwriting an existing one:

```gitignore
*
```

The generated ignore file ignores itself too; no runtime storage is committed.

Create runtime directories and files owner-only (`0700`/`0600`) where the
platform supports it. Definition files retain their existing permissions.

Parent partitioning is the ownership/listing index; there is no central index.
Descendant summaries follow child Pi session UUIDs into their own parent
partitions.

`metadata.json` is a versioned current snapshot containing identity, ownership,
state/outcome, latest reply/streaming, optional last activity, fixed model
settings, run state, queued Follow-ups, tombstone, and notifications.
An optional effective system-prompt snapshot captures Pi's composed string
after `before_agent_start` hooks. It resets on a new run, excludes later provider
payload rewrites, and is available only in the human task inspector, not tool
results. Missing snapshots are reported rather than reconstructed.
Per-task mutations are serialized. A durable mutation is
acknowledged only after temp write, fsync, and atomic rename.

Version 3 retains the immutable Definition prompt/tool/context recipe, fixed
scoped model identities, scheduler acceptance order, and the latest reply.
Earlier versions are rejected for execution but support ownership-validated
discard in place. Their retained files are not rewritten.

One PID lease protects each open parent partition. Reload and same-process
rebind reuse it. A second live OS process opening the same parent session gets an
explicit Lovely Agents read/control failure instead of risking corruption. A
stale crash lease is reclaimed.

Startup scans only the exact parent partition. Malformed or newer unsupported
metadata is left untouched and reported by path.

### Retained logs

`session.jsonl` is Pi's authoritative, unabridged transcript.

`history.md` contains run boundaries/outcomes, delivered initial/Follow-up/Steer
inputs, assistant replies, and compact tool summaries. Tool arguments/results
use bounded single-line UTF-8 previews. Reasoning and full tool payloads remain
only in Pi's session file. There is no separate activity log.

Model-visible paths are relative to `ctx.cwd` when inside the workspace. User
definition paths use readable home-relative display. Files remain after stop,
discard, orphaning, or metadata corruption.

## Notifications

A synchronous completion returns only through its calling tool, not also as a
notification.

Detached initial runs and background Follow-ups produce one completion notification when
they succeed or fail. Explicit stop does not notify because the tool result or
management UI already reports it. Quota Suspension may produce one nonterminal
status notification.

A completion notification includes:

- Task Reference, run index, label, and an exact `task_output` retrieval operation
- state and latest outcome
- effective model/thinking for agents, command/exit status for Bash
- labelled preview: first 2 KiB of the agent reply, last 2 KiB of Bash output;
  never echoed inputs or earlier replies
- retained history/session paths
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
- `/lovely-agents`: inspect Agent Definitions and direct tasks, edit scoped
  config, and use live output, Follow-up/Steer, stop, and discard.

The management command keeps the main Pi session active; it never rebinds the
TUI to a child session file. Compact status, below-editor active rows,
empty-editor Down, and live task controls arrive after execution exists.

There is no parallel slash-command syntax for every model tool.

## Deferred scope

- passive mailboxes and direct child-to-child communication
- model-visible hierarchical addressing
- built-in sandboxing and hard capability enforcement
- worktree isolation
- automatic retention or garbage collection
- per-run deadlines, fanout/reducer tools, and notification coalescing
- native TUI switching into an idle child session
- switching the main TUI into a running child, which needs a new Pi host API

## Implementation plan

### [x] Background Bash

`bash_bg` creates an exact-parent `b_` task, without replacing normal Bash.
Independent boolean switches gate background agents and Bash; Bash permits are
separate from agent execution and provider gates. Task controls and stdin/EOF
schemas remain available for retained work after disabling creation.

Typed Bash metadata stores command/cwd/exit status, bounded live tails with
sticky truncation, and full `output.log` plus command/stdin/outcome history.
No fabricated model/session recipe. POSIX process groups, pre-detach cancellation,
serialized backpressured stdin, cleanup-before-discard, and reload-safe
residents are covered by real-process tests. Restart never signals a stored PID
or replays a command. SIGKILL/power loss and deliberate process-group escapes
need OS supervision. Windows is explicitly unsupported.

Work in order. A section is complete only when its focused tests, typecheck, and
targeted Biome check pass. Keep `CODE.md` synchronized with implemented state.

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
in-process Pi integration cannot be tested directly. Protect concrete failure
modes and known regressions, not incidental wording or dependency internals.
Prefer existing behavioral coverage over additional tests of the same contract.

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

Added strict versioned metadata, safe parent/task paths, atomically reserved Task
References, owner-only storage, non-destructive `.gitignore` creation, and
serialized fsynced snapshot replacement. Invalid and unsupported snapshots are
reported without modification.

#### [x] 2.2 Parent partition lease

Added an atomic versioned PID/token lease with process-global reuse, serialized
same-process acquisition, explicit live-owner conflicts, stale-PID recovery,
ownership-checked release, and conservative handling of malformed leases.
Simultaneous stale takeover is deliberately best-effort.

#### [x] 2.3 Retained output

Private `history.md` records inputs/replies, outcomes, and compact UTF-8-safe
tool summaries. The latest reply is a coalesced atomic metadata snapshot,
read with size caps and optional run-completion waiting, without pagination.
Pi remains the sole writer of authoritative `session.jsonl`.

#### [x] 2.4 `task_list` and `task_output`

Added leased read-only tools over durable metadata. `task_list` provides stable
state/recency ordering, the complete direct-task set, tombstone filtering,
isolated diagnostics, output counts, retained paths, and recursive descendant
summaries without nested references. `task_output` enforces direct ownership
and exposes bounded latest-reply snapshots with run/streaming status.

#### [x] 2.5 Interactive management UI

Expanded `/lovely-agents` into one interactive entry point for fresh Agent
Definition discovery, durable direct-task inspection, and the scoped config
editor. Fixture creation/cleanup helpers remain internal for tests; the command
has no developer menu. Cleanup removes only marked fixture directories,
including nested fixture partitions.

### [x] 3. In-process Agent execution

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

#### [x] 3.3 `agent` and initial run lifecycle

Registered `agent` with fresh Definition/model validation before filesystem
acceptance. Accepted work durably records metadata and run/input boundaries,
queues through the global coordinator, streams assistant/tool events into
retained logs, and settles completion/stop races once.

Waiting starts at durable acceptance. Immediate and timed detachment leave the
same run executing; pre-detach cancellation stops it while later parent aborts
do not. Results include bounded output and direct-task inventory. Idle runtimes
dispose, and the persistent Pi UUID reopens from the retained `session.jsonl`.

Tests cover synchronous success/failure, queue-time and immediate detachment,
cancellation, post-detach completion, retained assistant/tool output, private
session creation, and cache-stable reopening.

#### [x] 3.4 Parent lifecycle and restart reconciliation

Graceful quit/new/resume/fork recursively stops resident and retained
descendants, clears queued Follow-ups, waits for resident disposal, and releases
every owned partition lease. Reload skips cleanup so process-global residents
and leases remain bound to the replacement runtime.

Non-reload startup reconciles the exact parent partition. Stable idle and
already-interrupted tasks remain reusable; stale queued/running/suspended work
becomes interrupted with one deterministic notification record. Malformed and
orphaned storage remains untouched and is reported nonfatally.

### [x] 4. Agent controls

#### [x] 4.1 Follow-up and Steer

`task_input` durably accepts up to 32 queued Follow-ups with stable sequence and
global acceptance order. The resident runtime atomically settles each run and
promotes the oldest Follow-up, reserves scheduler position before eligibility,
and executes each as a separate prompt in the same Pi session.

A Steer enters Pi's live steering queue only while the matching session is
running. Completion, queued, suspended, idle, and interrupted races fall back
to a Follow-up under the process-global task lane. Only observed Steer
deliveries enter retained history; stop drops pending deliveries.

Cold Follow-ups reopen the same Pi UUID from an immutable session recipe,
independent of later Definition/config edits. Tests cover all source states,
queue limits/positions, concurrent acceptance, sequential success/failure,
literal and duplicate Steers, delivery omission, completion races, fixed cold
configuration, and queued counts.

#### [x] 4.2 Stop and discard

Added idempotent `task_stop` and `task_discard`: first-writer-wins settlement,
Follow-up clearing, recursive descendant stop, permanent retained tombstones,
and hidden post-discard task rows; result reads remain allowed, input does not. Task lists group by state with
relative times; retained history uses flat tags and compact tool summaries. Long
tool results use bounded head/tail previews with full Ctrl+O expansion.

### [x] 5. Quota recovery and notifications

#### [x] 5.1 Provider-limit classification and tuple gates

Terminal quota/rate/billing/`ResourceExhausted` failures now suspend their
logical run after Pi retry handling and close the exact provider/model gate.
Overload, 5xx, network, and timeout failures remain ordinary failures. Closed
tuples retain queued acceptance order while running siblings drain and other
tuples continue. Provider matrices, runtime suspension/new-work blocking,
sibling draining, independent tuples, and restart reconciliation are tested.

#### [x] 5.2 Recovery triggers

Successful turns reopen their exact tuple globally. Eligible `/continue` calls
first admit suspended tasks in the exact owned descendant tree without opening
unrelated tuple work, then inject the hidden parent marker. Recovery preserves
the logical run and acceptance order, sends internal literal `Continue.`, and
can suspend repeatedly. Successful-parent no-op, tuple/bypass scheduling,
ownership recursion, and repeated recovery are tested.

#### [x] 5.3 Durable notification delivery

Completion, suspension, and interruption notices are bounded and persisted
before exact-parent delivery as custom Steers. Deterministic task/run/type IDs
are marked delivered only when the parent observes the custom message.
Process-local in-flight suppression avoids live duplicates; startup transcript
reconciliation marks observed IDs and resends only absent notices. Payloads
include bounded latest-reply previews, retained paths, and descendant summaries while
excluding synchronous results and explicit stops.

### [ ] 6. Live controls and release readiness

#### [x] 6.1 Live task controls and status

Compact active counts, below-editor rows, event-driven live output,
Follow-up/Steer entry, stop/discard, and empty-editor Down task access without
rebinding the main Pi session. The below-editor panel doubles as the task
navigator: Down focuses all tasks, arrows scroll, Enter opens actions, and
Esc/Up at the top returns to editing. Typing passes through unchanged.
The management menu focuses the same panel; selection survives live reordering.
Durable metadata/output writes publish through a
process-global update bus; shared capacity/gate changes refresh all parents.
Queue reasons, permit counts, and last-action ages appear in inspection tools
and the task UI. Timed tool reads wait for run completion or suspension instead
of waking on partial output, activity, or scheduler changes.
Task actions expose current/queued inputs and full history, plus the captured
Pi system prompt alone. Missing captures notify separately; no fallback body or
explanatory text is mixed into the prompt. Static text views support wrapped
scrolling, page navigation, and Home/End; context views refresh when reopened.
No polling is used. Print/JSON behavior remains
noninteractive and plain. Agent calls fit Definition, label, quoted prompt
preview, and `-> task ID` on one line, reserving suffix width before truncation.
Ctrl+O expands full input and the otherwise-hidden
Result section; tool errors remain visible. Notifications use a distinct message
background, a bold task/status header, and an otherwise-hidden body. Ctrl+O
expands them; the installed Pi custom-message renderer lacks click toggles.
Focused task rows use full terminal width for label, status/model, and prompt.
Bounded prompt previews are captured for new runs and retained after completion;
human-only list loading keeps them out of task-tool results.
Panel rows group Agents then Bash, active statuses first within each group,
then newest-created with stable ID ties. Group headings are nonselectable;
thinking/responding labels remain omitted.
Call truncation preserves the surrounding tool background.
Managed child disposal removes subscriptions and fences pending refreshes before
SDK context invalidation, without treating idle unload as semantic shutdown.
Confirmed
manual discard sends a parent-context notice after success; it does not start
an idle turn.

#### [x] Capability gates

Independent execution settings, foreground lifecycle/cancellation/provider-limit
handling, and dynamically filtered tools. Preserve controls for retained work
and accepted-run policy across config edits. Focused/full suites cover execution
and UI gating. Coordinator v3 requires a process restart.

#### [x] Model aliases

Optional `fast`, `smart`, and `workhorse` model/thinking presets are editable per
scope, explained in the roster, and resolved for calls and Definitions.
Targets join model choices automatically; explicit thinking overrides presets.
Unavailable aliases fail rather than reroute. Existing sessions retain concrete
identities across alias edits and cold Follow-ups.

#### [x] 6.2 Documentation and package verification

README covers human setup and usage, all definition fields, task controls,
settings, and storage/privacy limits. The packaged `agent-creator` skill guides
definition authoring and validation.

Registry-only installation with Lovely Config `0.1.3` and Pi `0.85.1` passes
`bun run check`, without local links or test shims. Bun and npm pack dry runs
include both skills and the bundled published dependency, without tests,
runtime storage, or editor settings.

#### [x] 6.3 First release

`0.1.0` is published on npm; its public integrity matches the verified tarball.
Master and `v0.1.0` are pushed, and CI created the GitHub Release.

#### [ ] 6.4 Future CI publishing

Stage-only trust is configured for `xl0/pi-lovely-agents`, `publish.yml`, and
environment `npm`. Verify it with the `0.1.1` release; the first tag's CI run
skipped the already-published version and did not exercise OIDC.
Publishing/pushing needs explicit approval.

#### [ ] Intermittent Bash test failure

Investigate `ENOENT` opening a temporary metadata file in the output-wait test.
One clean run failed; five isolated reruns and the full suite passed. Cause
unconfirmed; do not hide it with automatic retries.

### [ ] 7. Cache-preserving context forks

Deferred until the required changes land in Pi. Do not expose a fork setting or
tool before SDK support is available and integrated.

Create an independently owned child from the parent's model/thinking, effective
prompt, ordered tools, and completed conversation prefix. Cut before the entire
spawning assistant tool batch; never replay pending calls. No Definition prompt
replacement or alias-driven model switch.

Keep child session/transport identities independent. Reuse only observed,
supported provider cache-routing hints; sharing Agent.sessionId also shares
provider WebSocket state and breaks cleanup ownership.

SDK investigation is complete. Public APIs can copy durable entries and Pi's
prompt string, and recreate tools with matching observable schemas. They cannot
snapshot actual parent tool bindings/extension state or the final transformed
provider request. Wait for SDK support rather than implementing best-effort
forks. Cold-open must retain the chosen recipe without
silently substituting tools or models.
