# Lovely Agents

Give [Pi](https://github.com/earendil-works/pi) a second pair of eyes—or let it
run a build while you keep working.

Lovely Agents lets Pi delegate jobs to other agents, run Bash commands in the
background, and bring back results when they're ready. You can inspect the work,
redirect it, ask follow-up questions, or stop it.

Agents have their own conversations, but **share your checkout**. They're useful
for research, reviews, and separate pieces of work—not several agents editing
the same file. The included `agent` skill gives Pi guidance on when delegation
is worth the overhead.

## Install

```bash
pi install npm:@xl0/pi-lovely-agents
```

See [Development](#development) to run a local checkout.

## Create your first agent

An agent definition is a Markdown file that describes a job. Ask Pi to create
one with the included skill:

```text
/skill:agent-creator Create a read-only reviewer for this project.
```

Or create `.pi/agents/reviewer.md` yourself:

```markdown
---
name: reviewer
description: Review changes for bugs and missing edge cases
# model: smart   # Optional: configure this alias before uncommenting
thinking: high
tools: [read, grep, find, ls]
exclude_agents_md: false
---

Review the requested changes. Focus on concrete defects, not style preferences.
Explain each finding with a file location and why it matters.
```

Then ask Pi:

> Ask reviewer to check the current changes. While it works, help me update the docs.

Pi starts the reviewer. For a short job, it may return the result directly;
longer work continues in the background and sends a notification when done.

Put definitions in `~/.pi/agent/agents/` to use them across projects. A trusted
project's definition takes precedence over a user definition with the same name.

### Definition fields

The YAML between the `---` lines accepts these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | The name you use to request this agent. 1–64 lowercase letters, digits, `_`, or `-`; start with a letter or digit. |
| `description` | Yes | A short explanation of when to use it. Nonblank, at most 500 UTF-8 bytes. |
| `model` | No | A `provider/model-id`, an unambiguous model ID, or a configured `fast`, `smart`, or `workhorse` alias. Omit to use the starting Pi session's model. |
| `thinking` | No | Effort level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Omit to use the model alias's preset, or otherwise the starting session's level. Pi adjusts unsupported levels. |
| `tools` | No | Allowed tool names, as a YAML list or comma-separated string. Omit for normal tools and extensions; `[]` allows no tools. |
| `exclude_agents_md` | No | Set `true` to leave out discovered `AGENTS.md` and `CLAUDE.md` instructions. Defaults to `false`. |

The Markdown below the closing `---` is also required: it tells the agent how
to do its job and what to report. Keep reusable instructions here; give the
specific assignment when you ask Pi to start it.

Unknown fields, tool names, and models are rejected. Names must be unique
within each scope. You can request a different model or thinking level when
starting an agent; these fields are defaults, not locks.

The example restricts its reviewer to reading tools. Without a `tools` list,
agents get the normal tools and extensions; a role description is not a sandbox.

## Watch and guide the work

Open **`/lovely-agents` → Tasks**, or press **Down with an empty editor** to focus
the task list below it.

- **Arrow keys** select a task; **Enter** opens its actions.
- **Live output** shows what it has produced so far.
- **Inputs / history** shows earlier requests and results.
- **Follow-up** adds another request after the agent's current work.
- **Steer** redirects work already in progress.
- **Stop** cancels the work but keeps its files. An agent can take a new request later.
- **Discard** stops and archives it, removing it from the list. It does not delete the files.
- **Esc** returns to the editor.

You can also ask Pi directly:

> Ask the reviewer to check the cancellation path too.

> Stop the build and show me its output.

Tool calls and notifications are compact by default. **Ctrl+O** expands their
full contents.

## Background Bash

Ask Pi to run a long command in the background:

> Run `bun run build` in the background and tell me when it finishes.

The command appears alongside agent tasks. You can inspect its output or stop
it from the same menu. Normal, short Bash commands still work as before.

For a command that needs input, **Write stdin** sends exactly what you type;
include a newline if the command expects one. **Close stdin** sends EOF: “there
will be no more input.” This lets commands such as `cat` finish reading. It
doesn't kill the process, and you cannot reopen its input afterward.

A finished Bash command cannot be restarted as the same task—start a new one.
Background Bash currently supports Linux and macOS, not Windows.

## Settings and models

Open **`/lovely-agents` → Configuration**. Settings can apply to all projects or
just this workspace; workspace settings win.

**Background agents** and **Background Bash** are both on by default. Turn off
Background agents if you want Pi to wait for agents to finish instead of leaving
work running. Turning either switch off does not stop tasks already accepted.

Agent work and Bash jobs have separate concurrency limits, both initially 4.
Extra work queues until a slot is free. Pi initially waits up to 30 seconds for
an agent result before leaving it in the background.

Under **Models**, choose additional models Pi may use for agents. You can also
configure these optional shortcuts:

| Alias | Suggested use |
| --- | --- |
| `fast` | Quick research and straightforward tasks |
| `smart` | Difficult reasoning and complex reviews |
| `workhorse` | Everyday coding and research |

Each shortcut has a model and thinking level. They start disabled until you pick
a model; choosing one also makes that model available without a separate Models
selection. Pi decides when to use each shortcut. Changing settings doesn't
switch the model of an existing agent.

## Results, limits, and interruptions

Long results aren't lost. Pi's output-reading tool returns at most **2,000 lines
or 50 KiB** at a time, with a truncation notice and a file path when capped.
These are snapshots, not pages to assemble by repeatedly reading. Full agent
replies are in `history.md`; full Bash output is in `output.log`.

If Pi asks to wait for a result, the wait ends when the run finishes, pauses on
a provider limit, or reaches the requested timeout. A timeout returns the
latest output—it does not stop the task.

Tasks belong to the Pi conversation that started them. **`/reload` keeps work
running; quitting or switching conversations stops it.** After a crash, lost
work is marked interrupted rather than silently restarted. Agent conversations
can receive a new request; Bash commands must be started again.

Background agents pause on provider quota or rate limits. A successful request
using the affected model can resume them. If your main conversation ended with
an error or was aborted, **`/continue`** resumes it and eligible paused agents.

Task files live in `.pi/lovely-agents/` under your working directory and are
ignored by Git. They include conversation history and command output, so treat
them as potentially sensitive. Discarded tasks move to its `archive/` directory;
there is no automatic deletion.

## Development

```bash
bun install
pi -e .
```

Run checks with `bun run check`.

See [CODE.md](CODE.md) for implementation details and [PLAN.md](PLAN.md) for the
design and remaining work.
