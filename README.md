# @xl0/pi-lovely-agents

Agent orchestration for [Pi](https://github.com/earendil-works/pi).

The durable execution runtime is under construction. Definition discovery,
configuration, and roster inspection are available.

## Commands

- `/continue` — continue the current Pi session after an error or aborted turn
- `/lovely-agents` — edit user/workspace settings

## Tools

- `agent_roster` — list effective Agent Definitions, model choices, diagnostics,
  and delegation depth

Definitions are Markdown files in `~/.pi/agent/agents/` or the nearest trusted
`.pi/agents/` ancestor. Project definitions override user definitions by name.

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
