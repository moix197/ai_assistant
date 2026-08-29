# `ToolSpec.timeoutMs`: a per-tool override of the 10s handler bound

**Decision:** `ToolSpec` gains an optional `timeoutMs`; `loop.ts`'s
`invokeTool` races the handler against `spec.timeoutMs ??
TOOL_HANDLER_TIMEOUT_MS` (10s) instead of the constant. The three Sheets tools
set `30_000`. Every other tool leaves it unset and is unaffected.

**Why:**

- The 10s default was sized for local computation (`get_current_time`, `echo`).
  A real Sheets round trip — including the client's own bounded retries after a
  429 — legitimately exceeds it, and a timeout there surfaces to the user as a
  failure of a request that would have succeeded.
- **Declared at the tool, not at the wiring site.** The tool is the only thing
  that knows how long its own I/O takes; a timeout table in `build-agent.ts`
  would drift from the handlers it bounds.
- **Two independent, nested bounds.** `sheets-client.ts`'s
  `REQUEST_TIMEOUT_MS` (10s) bounds *one HTTP attempt*; `timeoutMs` bounds the
  *whole handler*, retries included. Collapsing them into one number would
  either forbid retries or leave a single attempt able to consume the whole
  budget.
- **ROADMAP invariant 9 (no unbounded work) still holds**: the bound stays
  explicit, finite and per-tool. The cost is UX, and it is real — a turn can now
  park up to 30s on one tool call instead of 10s.

**Rejected:**

- *Raise the global default to 30s* — makes every fast tool's failure mode three
  times slower to surface, to fix three tools.
- *No bound for network tools* — breaks invariant 9 outright.
- *One number covering both the HTTP attempt and the handler* — see above.

**Constraints it creates:**

- A tool that sets `timeoutMs` above ~5s should be gated or fast-failing;
  `channel.stop()`'s 5s drain will cut a slower one off at shutdown rather than
  wait for it.
- The value is a *ceiling on a race*, not a deadline propagated into the
  handler; a handler must still honor `ctx.signal` to actually stop working.
