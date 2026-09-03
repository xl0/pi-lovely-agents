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
