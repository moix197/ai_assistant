# Message updates dispatch concurrently; only `callback_query` keeps offset-after-handling

**Decision:** `pollOnce` in `packages/channels/src/telegram/poller.ts` now treats
the two inbound kinds differently. A `callback_query` update is still awaited
inline and its offset persisted only after its handler resolves — the original
at-least-once contract, unchanged. A `message`/`edited_message` update is handed
to `dispatchMessage` **without the loop awaiting it**, and
`setOffset(update_id + 1)` runs immediately, while the handler is still running.
`stop()` drains those detached dispatches (`inFlightDispatches`) before it
resolves.

**Why:** Phase 3's approval gate made the old "await every handler" loop
**deadlock, deterministically** — not race, deadlock. A gated tool call parks
`runTurn` inside `ApprovalGate.requestApproval`, waiting on the human's
Approve/Deny tap. That tap arrives as a `callback_query`, which can only be
fetched by the *next* `getUpdates` call — which the loop cannot issue, because
it is still awaiting the message handler that is waiting for the tap. Every
gated tool call therefore hung for the gate's full 5-minute window and then
resolved as a denial. The dependency is circular, so no amount of tuning fixes
it: the loop had to stop being the thing that waits.

`callback_query` keeps the inline await because it has neither problem and one
real benefit: it never waits on a human (an `answerCallbackQuery` plus an
`editMessageText`), and its crash-replay is what makes a tap that arrived just
before a crash recoverable rather than silently lost.

**Rejected:**

- *Await every handler (the status quo)* — the deadlock above.
- *A second `getUpdates` consumer dedicated to `callback_query`* — impossible by
  protocol: Telegram allows exactly one `getUpdates` consumer per bot token, and
  a second one 409s. See
  [telegram-long-polling-correctness](telegram-long-polling-correctness.md).
- *Persist pending approvals so the offset can still advance after handling* —
  solves durability, not the deadlock. The loop is blocked while it waits
  regardless of whether the pending approval survives a restart; the problem is
  ordering, not persistence.
- *Resolve approvals out of band (webhook, sidecar process)* — needs public
  ingress, which the ROADMAP defers to Phase 7, and would split the poll stream
  the advisory lock exists to keep singular.
- *Detach `callback_query` too, for symmetry* — costs the one replay guarantee
  still worth having and buys nothing: callbacks never block.

**Accepted trade-off — a message update in flight when the process dies is not
redelivered.** Advancing the offset is a permanent server-side ack; there is no
dead-letter and no way to ask Telegram for it again. That is a deliberate
reversal of the "duplicates are recoverable, losses are not" asymmetry, for
message updates only, because the alternative was a feature that could not work
at all. Two things bound the damage:

- The **double-processing** side is still guarded — `apps/hermes/src/handlers/
  complete.ts`'s `llm_dedupe` claim keys on `telegram:<updateId>`, so an
  exact-duplicate delivery still costs zero provider calls. Nothing guards the
  **loss** side; there is nothing left to guard it with.
- `dispatchMessage` catches its own failures and logs them at `error`
  ("message handler failed after its offset was already advanced, not retried")
  rather than swallowing them. That log line is the only remaining evidence such
  an update existed.

**Constraints it creates:**

- **Message handlers now run concurrently.** Any reasoning that assumed a serial
  poller ("never more than one in-flight completion call") is void — the shared
  boot-lifetime `AbortController` is still correct (shutdown aborts all of them
  at once), but concurrency-sensitive assumptions elsewhere must be rechecked
  against this, starting with spend: N concurrent turns can each pass the budget
  ceiling before any of their `llm_usage` rows land, so the overshoot bound is
  now N calls, not one — see
  [monthly-budget-ceiling](monthly-budget-ceiling.md).
- **Two messages in the same chat can run two turns at once.**
  `appendMessages`' `messages || $2::jsonb` is atomic, so no append is lost, but
  the two turns' appends can interleave and each turn reads a history snapshot
  taken before the other's append. Per-chat turn serialization does not exist
  and was not built.
- **`dispatchMessage` must never rethrow.** `pollOnce`'s catch block now means
  "a callback handler or `setOffset` failed, do not advance, stop this batch" —
  a message-handler throw reaching it would abort the batch over an update whose
  offset already advanced.
- **`stop()` must keep draining `inFlightDispatches`**, or shutdown reports the
  channel drained while a paid turn is still running against a pool that is
  about to close.
- Pinned by `packages/channels/src/telegram/__tests__/poller.test.ts`'s
  "message dispatch concurrency (approval-gate deadlock fix)", "message handler
  failure (no redelivery under detached dispatch)" and "graceful shutdown drains
  in-flight message dispatch" suites, plus the callback-side halves of
  `poller-offset-ordering.test.ts` and `poller-crash-replay.test.ts`. All of
  those must survive any refactor of the loop together — the callback tests
  prove the guarantee that was *kept*, the message tests prove the one that was
  deliberately given up.
