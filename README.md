# @xl0/pi-lovely-agents

Agent orchestration for [Pi](https://github.com/earendil-works/pi).

Durable agent creation/execution, Follow-up and Steer control, retained task
inspection, configuration, and the management UI are available. Stop/discard,
quota recovery, and notifications remain under construction.

## Commands

- `/continue` — continue the current Pi session after an error or aborted turn
- `/lovely-agents` — inspect Definitions/tasks, create test fixtures, and edit
  user/workspace settings

## Tools

- `agent_roster` — list effective Agent Definitions, model choices, diagnostics,
  and delegation depth
- `agent` — create a durable Agent Session and start its initial run
- `task_list` — list every durable direct task owned by this Pi session
- `task_output` — read or wait for retained task output
- `task_input` — queue a Follow-up or Steer a running agent

Definitions are Markdown files in `~/.pi/agent/agents/` or the nearest trusted
`.pi/agents/` ancestor. Project definitions override user definitions by name.
The management UI's always-visible developer section creates dummy durable
tasks, including state/outcome, nesting, corruption, large-output, and live
cases. Its cleanup action deletes only directories carrying its fixture marker.

Durable state lives under `<cwd>/.pi/lovely-agents/`, partitioned by the exact
parent Pi session. Quit and session replacement recursively stop owned work;
reload keeps it running. After an unclean restart, stale accepted work is
retained as `interrupted`.

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
