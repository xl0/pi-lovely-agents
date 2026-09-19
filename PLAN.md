# Lovely Agents plan

What the product promises and what is left to do. How it is built lives in
`CODE.md`.

## Product shape

Lovely Agents adds durable, in-process workers to Pi. Each worker is a normal
Pi SDK session with its own conversation, model, tools, and extensions; no
child `pi` processes. Background Bash commands share the same task controls.

1. The parent calls `agent_roster` to see available definitions and models.
2. It calls `agent` with a definition, label, and prompt.
3. The call waits briefly; long work detaches without restarting.
4. Detached results come back as a notification.
5. The parent can queue a Follow-up, or Steer a running agent.
6. Task tools list, inspect, stop, or discard.

Policy: keep it simple. No workflow engine, no foreground mode, and no
backward compatibility beyond minimal safety checks.

**Terms.** An *agent definition* is a Markdown role file; its body is the
child's system prompt. An *agent session* is one durable conversation created
from it, with a stable Task Reference (`a_k7m2p9x4`) and exactly one *parent
session*. A *run* is one accepted period of work: the initial prompt, then one
per Follow-up, addressed by a 1-based index. Parents control direct children
only; descendants are visible as a count.

## Definitions

Discovered from `~/.pi/agent/agents/*.md` and the nearest ancestor
`.pi/agents/*.md` of a trusted project. Project-controlled inputs (definitions
and workspace config) need real trust: Pi's evaluated trust or a saved `/trust`
decision; an ancestor directory owned by another user is skipped.

```md
---
name: reviewer
description: Review implementation correctness and risks
model: anthropic/claude-sonnet-4-5   # or an alias; optional
thinking: high                        # optional
tools: [read, grep, find, ls, bash]   # optional hard allowlist
exclude_agents_md: false              # optional
---

Review the requested change. Return concrete findings with file paths.
```

- Project definitions override same-name user ones. An invalid project file
  still shadows the user file: silently falling back could run the wrong role.
- Validation is strict but isolated: unknown keys, tools, models, levels, and
  wrong types are errors; same-scope duplicates invalidate the name; one bad
  file never blocks the others.
- Files are read fresh on every `agent_roster` and `agent` call. A definition
  written earlier in the same turn is immediately usable. No cache or watcher.
- Async/detach policy does not belong in definitions.

## Tools

One tool per operation: small schemas, fewer malformed calls. Visibility and
schemas are static; limits are enforced when called. Children that may not
delegate never see `agent` or `agent_roster`.

```ts
agent_roster({})
agent({ definition, label, prompt, waitMs?, model?, thinking?, allowAgents? })
bash_bg({ command, label, cwd?, waitMs? })
task_list({})
task_output({ id, run?, lines?, waitMs? })
task_input({ id, content, delivery?: "followup" | "steer", eof? })
task_stop({ id })
task_discard({ id })
task_update({ progress })   // child-only, never notifies the parent
```

- Validation and creation failures are tool errors. Once work is accepted,
  child failures are task outcomes, not failed tool calls.
- The roster is never placed in the system prompt; guidance tells the model to
  call it before delegating and after editing definitions.
- `task_list` shows direct children only, hides discarded tasks, and reports
  corrupt or unsupported records as diagnostics, not rows. Capacity numbers
  are held permits; no queue position or ETA is inferred.
- `task_output` returns one run's latest reply (or a Bash tail): a snapshot
  capped at 2,000 lines/50 KiB, never pages, readable after discard. `waitMs`
  waits for that run to end; a timeout returns the snapshot without stopping
  anything, and a later Follow-up cannot extend or replace it.

### Runs and input

- `waitMs` overrides the configured default; the wait includes queue time.
  Reaching it detaches the unchanged run. `0` detaches immediately.
- While the call is still waiting, cancelling it stops the run and its
  descendants. After detachment only `task_stop` or closing the parent does.
- A synchronous result returns only through the tool, never also as a notice.

| Delivery | When | New run | Behavior |
| --- | --- | ---: | --- |
| `followup` | any live state | yes | Starts an idle session or queues behind accepted work (max 32). Acknowledged, not awaited. |
| `steer` | running and streaming | no | Enters the active run at Pi's next safe boundary. |
| `steer` | otherwise | yes | Becomes a Follow-up; the reply says why. |

A Steer is not a mailbox: if stop or a crash wins before delivery it is lost.
Input is nonblank, at most 64 KiB, and literal unless `expandPromptTemplates`.
For Bash, `task_input` writes literal stdin; `eof` closes it; nothing restarts.

`task_stop` is idempotent, clears queued Follow-ups, keeps files, and leaves
the session reusable. `task_discard` tombstones the subtree in place: no more
input, results still readable, files stay until pruned. Guidance: discard once
dependent work is integrated; keep reusable specialists (idle ones unload).

### States

| State | Meaning |
| --- | --- |
| `idle` | Nothing accepted or executing. |
| `queued` | Accepted; starting or waiting for capacity. |
| `running` | Executing. |
| `interrupted` | Accepted work was lost across an unclean process exit. |

Outcomes are independently `succeeded`, `failed`, `stopped`, `interrupted`.
Detachment is not a state. Provider quota or rate limits are plain failures;
the parent is told and can Follow-up later.

Quit, `/new`, `/resume`, and `/fork` stop the parent's task tree; `/reload`
keeps it. After a crash, stale work becomes `interrupted`, queued Follow-ups
are dropped, one interruption notice is delivered, and nothing restarts on its
own. Orphaned partitions are never adopted or collected automatically. If
another live process owns the session, Lovely tools are hidden with a warning.

## Child sessions

- **Model:** call, then Definition, then parent. Explicit call thinking wins; a
  call-selected alias supplies thinking ahead of the Definition; explicit model
  IDs never inherit alias thinking. Fixed at creation: later config, alias, or
  definition edits never retarget a session. Missing auth is a creation error.
- **Tools:** omitted `tools` means normal built-ins and extensions; a list is a
  hard allowlist and the only default restriction. Delegation needs
  `allowAgents: true` on the creating call and remaining depth (root is 0).
- **Prompt:** the parent prompt is not inherited. Definition body, then Pi's
  tool list and guidelines, append resources, context files (unless
  `exclude_agents_md`), skills, and cwd. A replacement `SYSTEM.md` is ignored.
  Extensions load normally and their `before_agent_start` hooks run afterwards.

## Configuration

`xl0-pi-lovely-agents.json`: user scope, then workspace scope when trusted.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `backgroundBash` | `true` | Allow `bash_bg`; off makes the call fail. |
| `models` | `[]` | Extra model choices. Empty includes the parent. |
| `fast` / `smart` / `workhorse` `Model`, `Thinking` | `disabled` | Optional model + thinking presets. No automatic routing. |
| `maxConcurrency` | `4` | Agent runs executing in this process. |
| `maxBashConcurrency` | `4` | Independent Bash limit. |
| `maxDepth` | `2` | Maximum delegation depth. |
| `waitMs` | `30000` | Default initial wait. |
| `expandPromptTemplates` | `false` | Let Pi expand skill commands and templates in child input. |

Edits apply to future work; nothing mutates an active run. Lowering a limit
lets current runs drain. Unavailable saved models warn and are skipped, never
replaced by the parent.

## Notifications

One completion notice per detached initial run or Follow-up run that succeeds
or fails; one interruption notice per reconciled task; none for explicit stops.
It carries the Task Reference, run index, outcome, model or exit status, a
labelled 2 KiB preview (never echoed input), the exact `task_output` call, and
file paths. It is persisted before delivery, steered into the exact parent
(waking it if idle), and counted delivered only once seen in that parent's
transcript, so a crash can neither lose nor duplicate it.

## Human UI

`/lovely-agents` inspects definitions and tasks and edits config without ever
rebinding the TUI to a child session. The below-editor panel shows active
tasks and, on empty-editor Down, becomes the task navigator with actions:
live output, inputs/history, captured system prompt, Follow-up/Steer, stdin,
stop, discard. No slash-command mirror of the model tools.

## Deferred scope

- mailboxes, child-to-child communication, hierarchical addressing
- sandboxing, hard capability enforcement, worktree isolation
- automatic retention or garbage collection
- per-run deadlines, fanout/reducer tools, notification coalescing, batch APIs
- PTY/tmux support, peak-memory accounting
- switching the TUI into a child session (needs a Pi host API)
- `/continue` for errored parent turns, possibly as a separate extension

## TODO

- [x] Everything above: definitions and roster, durable storage and leases,
  in-process execution with permit lending, controls, notifications,
  Background Bash, management UI and panel, aliases, skills, README, releases
  through `0.1.2`.
- [x] Review fixes and simplification pass: removed quota suspension,
  `/continue`, foreground mode, dynamic tool filtering, the `active/` index,
  old-version support, rich descendant summaries, production fixtures;
  tightened project trust.

### [ ] Deferred simplifications

- Let the kernel write Bash output straight to `output.log`; read tails on
  demand instead of mirroring them into metadata.
- Drop agent `history.md` in favor of `session.jsonl`.
- Compose the child prompt through Pi's prompt `sections` once a Pi release
  ships that API.

### [ ] Release hygiene

- Verify OIDC staged publishing on the next tag; the first CI run skipped an
  already-published version. Publishing needs explicit approval.
- Decide on committing a lockfile for the publish job; `bun.lock` is ignored
  because local Pi packages are linked.
- The pruner cannot run from a Pi-managed install (peer `typebox` is omitted);
  either document checkout-only use permanently or stop shipping it.

### [ ] Cache-preserving context forks

Blocked on Pi SDK support; expose no setting or tool before then. Goal: an
independently owned child created from the parent's model, prompt, ordered
tools, and completed conversation prefix, cut before the spawning tool batch.
Public APIs cannot snapshot real tool bindings or the final provider request,
so a best-effort fork is not acceptable. Keep session/transport identities
independent; sharing `Agent.sessionId` shares provider WebSocket state.
