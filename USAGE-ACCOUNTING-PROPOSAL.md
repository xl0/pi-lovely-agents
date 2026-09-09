# Pi API proposal: external usage accounting

Status: proposed upstream Pi API; not implemented.

## Problem

Pi already counts `usage` returned by tools in its session totals. That works
for synchronous nested calls, but detached work finishes after its tool result
has returned. Custom completion messages are not counted.

Extensions need to report usage independently of tool completion, notifications,
result reads, and model turns. Do not fabricate tool results or modify an old
assistant message to add costs.

## API

```ts
import type { Usage } from "@earendil-works/pi-ai"

await pi.recordUsage({
  sessionId: originatingParentSessionId,
  id: "lovely-agents:<child-session-id>:<billing-entry-id>",
  usage
})
// Promise<{ recorded: boolean }>
```

`usage` uses Pi's existing token counts and cost structure. `id` is a caller-
namespaced, stable identifier for an immutable usage contribution—not a delivery
attempt. `recorded: false` means the identical contribution was already recorded.

Expose the same operation on SDK `AgentSession`, inherently bound to that
session. The extension API requires `sessionId` to guard asynchronous callbacks
against charging a newly switched session.

## Contract

- Append a dedicated usage entry to session storage. The accounting ID is
  separate from the session entry's normal tree ID.
- For persistent sessions, resolve only after durable storage, including when
  idle or before the first assistant response. In-memory sessions retain their
  normal nonpersistent semantics.
- Serialize admission and deduplicate by accounting ID across all retained
  session entries. Identical retries are no-ops; a different payload under the
  same ID is an explicit error. Validate usage values; no negative/nonfinite
  counts or costs.
- Reject a mismatched or unavailable parent session. Do not switch sessions,
  silently retarget the charge, or open another session.
- Include entries in footer cost, `/session`, and RPC/SDK usage totals, in an
  external/tool-usage bucket. Use supplied costs, not the parent's model prices.
- No model-visible message, transcript noise, or triggered turn. Refresh the
  normal usage display without requiring another model response.
- Compaction and tree navigation do not erase charges. Forks that copy entries
  also copy their accounting IDs, so inherited usage cannot be recorded twice.

## Lovely Agents integration

Persist pending contributions before reporting; mark them reported only after
the API resolves. On reopening the exact parent, resend pending contributions.
Pi's durable deduplication closes the commit/acknowledgement crash window.

Prefer source billing-entry IDs to cumulative session totals. This accounts for
usage from failed/interrupted runs and descendants that finish after their
owner's run ends. Forward nested contributions with their original IDs; do not
add both a child's inclusive total and its descendants separately.

Use this path for both foreground and background agents. Do not also return
the same usage on their tool results. Reading, discarding, or repeatedly
notifying about a task must not change how often its usage is counted.

## Acceptance checks

Report while idle; replay after reload/crash; reject a conflicting duplicate or
wrong session; count failed-run usage; preserve totals through compaction and
forking; count nested contributions once without touching model context.

No billing ledger, budgets, usage corrections, or workflow API in this proposal.
