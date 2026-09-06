---
name: agent-creator
description: Create or edit Lovely Agents definitions when the user wants a reusable agent role.
---

# Create an agent definition

- Call `agent_roster` first. Reuse or edit an existing role when it fits;
  don't silently overwrite or shadow one.
- Default to the project's active `.pi/agents/` directory (nearest ancestor).
  Create one if absent. Use `~/.pi/agent/agents/` for explicitly user-wide roles.
  Save as `<name>.md`.
- Start with YAML between `---` lines. These are the only allowed fields:
  - `name` (required): match `[a-z0-9][a-z0-9_-]{0,63}`; unique within its scope.
  - `description` (required): nonblank, at most 500 UTF-8 bytes.
  - `model`: `provider/model-id`, an unambiguous model ID, or a configured
    `fast`/`smart`/`workhorse` alias. Omitted → starting session's model.
  - `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
    Omitted → alias preset, otherwise starting session's level. Pi clamps
    unsupported levels.
  - `tools`: YAML list or comma-separated names, without duplicates. Omitted →
    normal tools/extensions; `[]` → no tools.
  - `exclude_agents_md`: boolean, default `false`. `true` omits discovered
    `AGENTS.md`/`CLAUDE.md` instructions.
- Make the description explain when to choose this agent. A nonempty Markdown
  body after the closing `---` is required. Keep it concise:
  purpose, boundaries, what to inspect or change, and expected results.
  Keep one-off assignments out of the reusable definition.
- Use known tool names and an explicit allowlist when restricting the role.
  Bash access is not read-only. Keep AGENTS/CLAUDE instructions enabled unless
  the user asks otherwise.
- Leave model/thinking inherited unless requested. If selecting them, verify
  the model or enabled alias rather than inventing an ID.
- Call `agent_roster` again and fix diagnostics for the edited definition.
  Report its path and role. Don't launch an agent merely to test the definition.
