---
name: agent
description: Use when deciding whether and how to delegate work to subagents.
---

# Delegation

Delegate to reduce total work, not to maximize parallelism.

- Best fit: research, exploration, API/doc lookup, and independent review.
- Delegate implementation only when embarrassingly parallel: disjoint edits,
  settled interfaces, independent verification, and near-zero dependencies
  between writers—including the parent.
- If implementation needs coordinated API/type changes or frequent handoffs,
  keep it in the parent. Delegate research or an independent review instead.
- Give the goal, relevant context, constraints, ownership, and acceptance criteria.
  Request findings with evidence or changes with test results—not transcripts.
- Parallelize independent questions or changes. Keep useful work for yourself;
  don't duplicate the delegate's task.
- Verify findings and integrate changes. Run integration checks after the relevant
  writers finish. Delegation transfers work, not responsibility.

If briefing, waiting, and integration outweigh doing it yourself, don't delegate.
