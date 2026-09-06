---
name: agent
description: Use when deciding whether and how to delegate work to subagents.
---

# Delegation

Delegate to reduce total work, not to maximize parallelism.

- Best fit: research, exploration, API/doc lookup, and independent review.
- Coding fits when isolated: bounded files, stable interfaces, independently
  testable output. Unless it's a clear win, prefer to do the coding yourself.
- Keep architecture, shared types, and integration with the parent. Splitting
  coupled code often costs more coordination and review than it saves.
- Give the goal, relevant context, constraints, ownership, and acceptance criteria.
  Request findings with evidence or changes with test results—not transcripts.
- Parallelize independent questions or modules. Keep useful work for yourself;
  don't duplicate the delegate's task.
- Verify findings and integrate changes. Delegation transfers work, not responsibility.

If briefing, waiting, and integration outweigh doing it yourself, don't delegate.
