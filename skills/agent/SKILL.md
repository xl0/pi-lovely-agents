---
name: agent
description: How to decide whether to delegate work to sub-agents
---

# Delegation

Delegate to reduce total work, not to maximize parallelism.

- Best fit: research, exploration, API/doc lookup, and independent review.
- Use a subagent to write temporary test scripts, exercise UI flows, or inspect
  screenshots and failures. Have it report what it checked and how to reproduce
  failures, without changing application code. Do not edit the code being tested
  while it works.
- Simply running existing tests or type checks does not need a subagent.
  Use a background shell instead.
- Delegate implementation only when embarrassingly parallel: disjoint edits,
  settled interfaces, independent verification, and near-zero dependencies
  between writers—including the parent.
- If implementation needs coordinated API/type changes or frequent handoffs,
  keep it in the parent. Delegate research or an independent review instead.
- Give the goal, relevant context, constraints, ownership, and acceptance criteria.
  Request findings with evidence or changes with test results—not transcripts.
- Verify findings and integrate changes. Run integration checks after the relevant
  writers finish. Delegation transfers work, not responsibility.

If in doubt, don't delegate.