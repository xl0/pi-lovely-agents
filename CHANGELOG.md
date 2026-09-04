# Changelog

## [Unreleased]

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
