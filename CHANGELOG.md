# Changelog

## [Unreleased]

- Fix stale-context crashes on idle child disposal and background-color gaps in
  truncated agent calls. Sort UI rows by creation time; hide internal activity.
- Add opt-in capabilities with foreground-only defaults, synchronous Follow-ups,
  cancellation, and config-aware tool schemas/visibility. Context forks and
  Background Bash are marked unavailable until implemented.
- Style notifications as distinct messages with bold headers and bodies hidden
  until expanded.
- Notify the parent model after manual task discard, without waking an idle
  turn.
- Add configurable `fast`, `smart`, and `workhorse` model/thinking aliases,
  roster descriptions, and alias selection in calls and Definitions. Alias
  targets join available model choices automatically; existing agents stay fixed.
- Render agent calls on one line with label, width-aware prompt preview, and
  `-> task ID`, preserving the ID when truncating.
  Ctrl+O expands full input and the otherwise-hidden result; errors stay visible.
- Use full-width task picker rows and retain bounded prompt previews for new
  runs, exposed only in human task views.
- Add `/continue` to resume the current Pi session after errors or aborts.
- Add scoped configuration, strict Agent Definition discovery, and the
  `agent_roster` tool.
- Add versioned task metadata and private atomic workspace storage.
- Add exclusive parent-partition leases with stale-process recovery.
- Add private retained logs with bounded reads and long-polling.
- Add read-only `task_list` and `task_output` tools.
- Unify Definition, task, fixture, and configuration management under
  `/lovely-agents`.
- Add the process-global FIFO Agent coordinator, tuple gates, runtime bindings,
  and cooperative permit lending.
- Add persistent in-process Pi child-session construction with Definition-owned
  prompts, fixed model/tool policy, extensions, context, and depth gating.
- Add the durable `agent` creation tool with scheduled initial runs, retained
  event logs, bounded waiting, detachment, and cancellation.
- Add recursive parent-session shutdown and restart reconciliation for stale
  accepted work.
- Add durable Follow-up queues, live Steer delivery, scheduler reservations,
  and immutable cold-session reopening through `task_input`.
- Compact model-visible task output while retaining full structured details.
- Return latest-reply/status snapshots from `task_output`, including streaming
  updates. Replace transcript pagination and separate activity logs with
  `history.md`; notifications preview only the latest reply.
- Show queue reasons, shared execution capacity, and last observed activity in
  task inspection and the UI. Wake snapshot waits on activity and scheduler
  changes without polling or exposing reasoning/tool payloads.
- Add scrollable task input/history and system-prompt views. Capture Pi's
  composed system prompt for new runs while labeling missing captures explicitly.
- Archive discarded task subtrees, including unsupported metadata versions
  after ownership validation. Add a cleanup guideline for unneeded agents.
- Ignore the entire runtime storage tree, including its generated `.gitignore`.
