# @xl0/pi-lovely-agents

Agent orchestration for [Pi](https://github.com/earendil-works/pi).

Durable agent creation/execution, Follow-up and Steer control, retained task
inspection, stop/discard, quota recovery, notifications, configuration, and the
management UI are available.

## Commands

- `/continue` — continue the current Pi session after an error or aborted turn
- `/lovely-agents` — inspect Definitions/tasks, create test fixtures, and edit
  user/workspace settings

## Tools

- `agent_roster` — list effective Agent Definitions, model choices, diagnostics,
  and delegation depth
- `agent` — create a durable Agent Session and start its initial run
- `task_list` — list every durable direct task owned by this Pi session
- `task_output({ id, waitMs? })` — latest assistant reply and run/streaming status;
  no inputs, older replies, or pagination
- `task_input` — queue a Follow-up or Steer a running agent
- `task_stop` / `task_discard` — stop work or permanently archive the owned subtree

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
