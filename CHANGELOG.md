# Changelog

## [Unreleased]

### Fixed

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
