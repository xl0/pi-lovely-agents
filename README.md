# @xl0/pi-lovely-agents

Agent orchestration for [Pi](https://github.com/earendil-works/pi).

Durable agent creation/execution, Follow-up and Steer control, retained task
inspection, stop/discard, quota recovery, notifications, configuration, and the
management UI are available.

## Commands

- `/continue` — continue the current Pi session after an error or aborted turn
- `/lovely-agents` — inspect Definitions/tasks, create test fixtures, and edit
  user/workspace settings

## Model aliases

In **Configuration**, pick a model and thinking level for any of these presets:

| Alias | Intended use | Default thinking |
| --- | --- | --- |
| `fast` | Cheap, low-latency work | `low` |
| `smart` | Difficult reasoning and complex work | `high` |
| `workhorse` | Routine coding and research | `medium` |

Aliases start disabled. Their targets become available automatically; no need
to also select them under **Models**. The roster describes enabled aliases, but
the parent chooses freely—there is no automatic routing.

Use `model: "fast"` (or another alias) in an `agent` call or Definition.
An explicit `thinking` argument overrides the preset. An alias selected in the
call overrides the Definition's thinking; a Definition's own `thinking` overrides
its alias preset. Pi clamps unsupported levels. Explicit model IDs do not
inherit preset thinking, and omitted `model` keeps Definition/parent inheritance.

Config keys are `fastModel` / `fastThinking`, `smartModel` / `smartThinking`,
and `workhorseModel` / `workhorseThinking`. Set a model field to `disabled` to
hide that alias. Existing agents keep their resolved model and thinking after
alias edits; unavailable aliases fail explicitly rather than choosing a substitute.

## Tools

- `agent_roster` — list effective Agent Definitions, model choices, diagnostics,
  and delegation depth
- `agent` — create a durable Agent Session and start its initial run
- `task_list` — list every durable direct task owned by this Pi session
- `task_output({ id, waitMs? })` — latest assistant reply and run/streaming status;
  no inputs, older replies, or pagination
- `task_input` — run a Follow-up or Steer a running agent
- `task_stop` / `task_discard` — stop work or permanently archive the owned subtree

## Capabilities

**Configuration → Capabilities** defaults to none: all new runs stay in the
foreground. Creation waits for completion; Follow-ups require an idle task and
wait for their own result. Cancellation stops the work, including descendants.
Foreground provider-limit failures do not restart automatically. UI inputs
show a cancellable progress dialog.

Enable `backgroundAgents` for timed detachment (`agent.waitMs`) and queued,
asynchronous Follow-ups. Existing accepted runs keep their execution policy
when settings change.

`backgroundBash` is a reserved setting, explicitly marked unavailable until
implemented. Enabling it does not expose nonexistent tools.
Creation tools follow delegation permission/depth. Task controls remain visible
for existing owned work, even when creation is disabled; Definition allowlists
still apply. Tool schemas/descriptions update with the settings.

## Inspection

Agent tool calls fit the Definition, `label=`, quoted `prompt=` preview, and
`-> task ID` on one line. Ctrl+O expands the full prompt and result.
Tool errors stay visible without expansion.
Notifications have a distinct message background and bold header; Ctrl+O
reveals their body.

The below-editor task list uses full-width rows with prompt previews captured
for new runs. Previews remain after completion; older completed runs are not backfilled.
Rows stay in creation order, newest first; activity/status changes do not reorder
them. Thinking/responding labels are hidden from the list.

Task inspection reports last observed activity and shared held/max execution
permits. Queued work shows `capacity`, `provider-limit`, or transitional
`starting`; no ETA is inferred. Thinking and tool activity remain visible
without copying reasoning or tool payloads into snapshots. `waitMs` wakes on
reply, activity, status, or scheduling changes; it never stops the run.

In the task UI, **Inputs / history** shows current and queued inputs plus prior
runs and delivered Steers. **System prompt** shows only Pi's captured prompt.
Use arrows, PgUp/PgDn, or Home/End to scroll. Missing captures produce a separate
notification, not substitute content. Provider-level payload rewrites are not
captured.

Definitions are Markdown files in `~/.pi/agent/agents/` or the nearest trusted
`.pi/agents/` ancestor. Project definitions override user definitions by name.
The management UI's always-visible developer section creates dummy durable
tasks, including state/outcome, nesting, corruption, large-output, and live
cases. Its cleanup action deletes only directories carrying its fixture marker.

Durable state lives under `<cwd>/.pi/lovely-agents/`, partitioned by the exact
parent Pi session. Quit and session replacement recursively stop owned work;
reload keeps it running. After an unclean restart, stale accepted work is
retained as `interrupted`.

`history.md` keeps inputs, replies, run outcomes, and compact tool summaries.
Full tool payloads remain in Pi's `session.jsonl`; there is no `activity.md`.
The latest reply is stored atomically with status in v3 `metadata.json`. New
runs clear the old answer before execution. Output snapshots are capped at
2,000 lines/50 KiB; inspect history for full replies. Older metadata versions
are rejected for execution but can still be discarded into
`.pi/lovely-agents/archive/<parent>/<task>/`. Discard preserves the files,
excludes them from task discovery, and has no automatic expiry or undelete.
Discard agents after consuming their results unless a Follow-up is expected.

The generated storage `.gitignore` ignores everything, including itself.

## Install

```bash
pi install npm:@xl0/pi-lovely-agents
```

## Development

```bash
bun install
bun run check
pi -e .
```
