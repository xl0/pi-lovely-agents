# Changelog

## [Unreleased]

### Breaking Changes

- Remove foreground mode and the `backgroundAgents` setting: agent calls wait up to `waitMs` and then detach, and Follow-ups are always accepted without waiting for their result.
- Remove provider-limit suspension, automatic recovery, and the `/continue` command: a run that hits a quota or rate limit fails like any other provider error and notifies the parent.
- Remove the `active/` task index and the discard support for unsupported metadata versions; such records remain a diagnostic until deleted by hand.
- Ignore project Agent Definitions and workspace settings unless Pi evaluated project trust or a `/trust` decision is saved; ignored resources are reported as warnings. Ancestor `.pi/agents` directories owned by another user are skipped.

### Changed

- Require a Pi release newer than 0.85.1; child prompts are now rendered by Pi, with the tool list and rules added as prompt sections.
- Replace the shipped `scripts/prune-tasks.ts` with **`/lovely-agents` → Prune discarded tasks**, which shows a dry run and asks before deleting.
- Write Bash output straight to `output.log` from the command, preserving the order of stdout and stderr, and read tails on demand instead of copying them into task metadata while it runs.
- Report a single descendant count per agent task instead of per-state summaries, and omit descendants from notifications.
- Use one task ordering everywhere: Agents before Bash, active states first, newest created first.
- Keep Lovely tools and their schemas static instead of hiding tools and parameters as settings change; disabled Bash and depth limits are rejected when called, and `waitMs` is ignored while background agents are disabled.

### Fixed

- Fix a scheduler deadlock when an agent waits on several tasks in parallel at full capacity.
- Return the execution permit of a promoted Follow-up when the task is stopped before it starts.
- Stop detached descendants when an `agent` call is cancelled before detachment.
- Deliver notifications to idle or suspended child agents without starting a turn outside the scheduler.
- Resend notifications dropped when the parent turn is aborted before they are delivered.
- Reclaim a stale session lease left by a crashed process whose PID this process reuses.
- Settle Bash tasks when the shell exits, killing leftover background jobs that keep its pipes open.
- Include tool-specific guidelines in child system prompts.
- Reject symlinked task directories before reading or mutating task metadata.
- Keep tasks controllable after the system clock steps backwards.
- Reopen a provider gate after successful tool-use turns, not only final replies.
- Limit streaming reply snapshots to two durable writes per second.
- Accept Bash stdin sent immediately after a task is reported running, instead of failing before the process is spawned.
- Stop timed `task_output` waits from failing when the directory watcher reports an already-renamed temporary metadata file.
- Keep unrelated staged changes out of the release commit.
- Show a persistent session-ownership warning and disable Lovely Agents initialization when another Pi process owns the session's tasks.

## [0.1.2] - 2026-09-10

### Breaking Changes

- Keep discarded task files at their original paths and return `taskDirectory` with `state: "discarded"` from `task_discard`.

### Added

- Retrieve retained results by run index with `task_output(run: N)`, including after discard, and identify runs in results and completion notices.
- Browse non-discarded tasks through an `active/` index and safely prune discarded tasks with the dry-run-first `scripts/prune-tasks.ts` command.
- Report child progress in task inspection and the panel with `task_update` without notifying the parent.
- Scroll live output with keyboard navigation, Bash tail-following, and visible exit codes or termination signals.
- Read shorter Bash output tails with `task_output(lines: N)`.

### Changed

- Group Agents and Bash separately and list active tasks first.
- Show the latest Bash output in UTF-8-safe completion previews.
- Clarify Steer acceptance and Follow-up conversion, and expose process-wide capacity and Bash queue reasons.
- Guide agents to delegate independent implementation work and keep coupled changes in the parent.

### Fixed

- Keep output waits attached to the selected run across Follow-ups.
- Deliver pending completion notifications for discarded tasks.
- Prevent another Pi process from claiming tasks whose cleanup failed.

## [0.1.1] - 2026-09-06

- Publish through GitHub Actions with npm provenance.

## [0.1.0] - 2026-09-06

- Reusable Markdown agent definitions with model, thinking, tool, and context settings.
- Persistent Pi agents with background or foreground execution, Follow-ups, and live Steers.
- Background Bash with separate concurrency limits, stdin/EOF, and retained output.
- Shared task listing, output inspection, cancellation, and archival.
- Interactive task management through `/lovely-agents` and the below-editor task panel.
- Completion notifications, live output, conversation history, and system-prompt inspection.
- Provider-limit suspension and recovery, plus `/continue` after errors or aborted turns.
- User/project configuration, model selection, and optional `fast`, `smart`, and `workhorse` aliases.
- Concurrency and delegation limits, session ownership, and restart reconciliation.
- Private, Git-ignored task storage with full logs preserved after archival.
- Packaged `agent` and `agent-creator` skills for delegation and role authoring.
