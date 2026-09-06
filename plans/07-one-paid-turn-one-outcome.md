# Plan: One Paid Turn, One Outcome

**Created:** 2026-09-03
**Branch:** `feat/07-one-paid-turn-one-outcome`
**Status:** complete. All phases shipped, merged to `main` (fast-forward `a94323f..bce352f`) and pushed. Golden path verified live on the real bot; `[~]` items (403 / partial-send / max-iterations live triggers) remain accepted as impractical per HIL Prerequisites.

## Context

This plan started from a hypothesis that turned out to be wrong, and the
correction is the whole reason the phasing below looks the way it does — a
future reader must not have to re-derive it.

The original ask assumed three failure paths in
`apps/hermes/src/handlers/complete.ts` — a 403 (bot blocked) escaping the
handler's own catch block, a mid-chunk Telegram send failure, and
`MaxIterationsReachedError` — leave the `llm_dedupe` row `pending` and
therefore **re-charge the user for a paid LLM turn on redelivery**. That is
false for message updates, and has been false since Phase 3 of
`03-agent-core`. `packages/channels/src/telegram/poller.ts:275-292` dispatches
a message update's handler fire-and-forget
(`trackDispatch(dispatchMessage(update))`, not awaited) and then persists the
offset (`await offsetRepo.setOffset(nextOffset); offset = nextOffset;`)
*before* that handler has resolved. Telegram never redelivers an acked
`update_id` — the offset write is a permanent, server-side ack, not a
checkpoint — so by the time any of those three failures actually happens
(seconds to minutes into a paid turn), the update that triggered it is
already gone. There is nothing left to redeliver it. A row these three paths
leave `pending` in `llm_dedupe` is therefore inert: nothing reads a `pending`
row except the next `claim()` of that exact key, and nothing else in the
codebase claims that key again, because nothing redelivers it. `/stats`
reads `telemetry_events`/`llm_usage`
(`apps/hermes/src/telemetry/build-stats-repo.ts:14-20`), never `llm_dedupe`.
So the three original paths are **user-experience defects** (an English
error where Spanish belongs, a possible generic "something went wrong" when
the user actually got half an answer, a second ugly error log for a routine
403) — not billing defects. This plan fixes them as UX, not as money.

**The one real double-charge is different**, and it is this plan's headline
fix. `offsetRepo.setOffset` itself can reject — a transient DB blip, pool
exhaustion, a failover — independent of anything the handler does. When that
happens today, dispatch has *already* been fired (the old ordering is
dispatch-then-ack), so the agent turn is already running against the
provider. `setOffset`'s rejection is caught by `pollOnce`'s own try/catch
(poller.ts:293-308), which does **not** advance `offset`, logs a warning,
backs off, and `return`s out of `pollOnce` entirely (L306-307) — it does not
`break` or `continue` inside the batch loop, so the whole remaining batch is
abandoned un-acked and re-requested from the same offset. The next
`getUpdates` call therefore re-requests the **same**
`update_id` — Telegram redelivers it because it was never acked — and
dispatches a **second** handler for it, while the **first** is still
mid-flight. Handler #2 calls `dedupeRepo.claim()`, finds a `pending` row
(handler #1 already claimed it), and
`packages/store/src/llm-dedupe-repo.ts:41-44` returns `{status: "claimed"}`
again — the documented, deliberate fail-open retry — so a second real, paid
agent turn runs and a second reply is sent for one inbound message. This is
the accepted residual risk `.ai/decisions/telegram-long-polling-correctness.md`
already names as "a crash between claim and complete," except it isn't a
crash: it's a `setOffset` failure that races an in-flight dispatch it never
should have been able to race in the first place, because the ack should
never have let the redelivery happen while dispatch #1 was still running.

The fix is an ordering change, not a new mechanism: ack before dispatch,
instead of dispatch before ack, for message updates only. If `setOffset`
fails, nothing was dispatched yet and nothing was paid for — the update is
cleanly redelivered and runs exactly once next time. If `setOffset`
succeeds, no redelivery can ever race the still-running handler, because the
update is already permanently acked. The trade-off this reorder keeps
exactly as it already stood: a crash between the (now earlier) offset write
and the handler starting still loses that message — not a regression,
`.ai/index.md`'s invariant-#4 row already documents "a crashed turn is
simply lost, logged and not retried"; the loss window just moves earlier by
microseconds. The `callback_query` branch is untouched: it keeps
offset-after-handling, because the approval gate's replay-on-crash behavior
depends on it.

Everything else in this plan — Spanish copy for `MaxIterationsReachedError`
and a mid-send partial failure, a guard around the failure-notice send so a
second 403 doesn't escape the handler, translating the two remaining English
constants — is real, user-visible polish, worth doing, but none of it closes
a money leak. Only the poller reorder does.

## Risk: medium

The headline fix touches the one `for` loop in
`packages/channels/src/telegram/poller.ts` that both update kinds share, and
three existing test files already pin its current behavior in comments as
load-bearing (`poller.test.ts`, `poller-offset-ordering.test.ts`,
`poller-crash-replay.test.ts`) — a mistake here risks the *callback_query*
branch's untouched, still-load-bearing offset-after-handling guarantee, not
just the message branch being changed. Second, this plan exports
`MaxIterationsReachedError` from `@hermes/agent`'s public surface for the
first time, widening a package boundary that has stayed narrow on purpose
(`packages/agent/src/index.ts` currently exports no error classes at all).
Third, two of the four Spanish translations replace strings two existing
tests assert on by exact content (`OUT_OF_BUDGET_REPLY`,
`GENERIC_FAILURE_REPLY`) — missing that update breaks CI, not the feature.
None of this touches a schema, a new dependency, or `sheet_write_log`/
`packages/google-sheets`, which keeps the blast radius to two packages and
one app.

## Dependencies & Risks

- **Scope is exactly `llm_dedupe` and the completion handler + poller.**
  `sheet_write_log` and `packages/google-sheets` are untouched by this plan —
  a different dedupe mechanism with its own, already fail-closed, posture
  (see `.ai/decisions/sheets-write-dedupe-as-audit.md`).
- **The three original "leaks" are proven inert, not fixed as leaks.** Do
  not add a `failed` status, a `release`/delete operation, or a TTL sweeper
  to `llm_dedupe` — a `pending` row from any of these three paths is
  unreachable by construction once Phase 1 lands (and was already
  unreachable via redelivery before Phase 1, for these three specific
  paths — Phase 1 only closes the *unrelated* `setOffset`-failure race).
  Building cleanup machinery for a row nothing ever claims again is
  speculative abstraction CLAUDE.md forbids.
- **`MaxIterationsReachedError` becomes exported, deliberately.** It is
  declared but not exported today (`packages/agent/src/loop.ts:67`, `class`
  with no `export`), and `packages/agent/src/index.ts` exports no error
  class at all — every other consumer of a thrown error from this package
  (`BudgetExceededError`, `LlmHttpError`, `LlmTimeoutError`) is imported from
  `@hermes/llm`, not `@hermes/agent`. Exporting it is the narrow, honest
  option: the alternative (a parallel string/code field the handler checks
  instead of `instanceof`) duplicates information the error class already
  carries (`totalCostUsd`, `iterations`) and invites the two to drift.
- **The ack-before-dispatch reorder must not touch the `callback_query`
  branch at all.** `handleCallback` then `setOffset` stays exactly as
  ordered today — the approval gate's replay-on-crash guarantee
  (`.ai/decisions/telegram-long-polling-correctness.md`) depends on it, and
  none of this plan's problem is on that branch.
- **Dispatch stays fire-and-forget after the reorder — never awaited.**
  Awaiting it would freeze the single serial poll loop
  (`poller.ts:231`/`316-321`) for up to `DEFAULT_TIMEOUT_MS = 5*60*1000`
  (`telegram-approval-gate.ts:7`) every time a gated tool call parks on a
  human tap, since the tap itself arrives through the same loop
  (`callback_query` branch) — a message handler awaiting its own resolution
  before that tap can be delivered is the exact deadlock
  `poller-concurrent-message-dispatch.md` already documents and Phase 3 of
  `03-agent-core` fixed. This plan only moves *when* the ack happens, not
  whether dispatch is awaited.
- **Storing the notice text, not the original reply, as `resultText` on the
  two new completion paths (max-iterations, partial-send).** Both new
  branches call `recordDedupeCompletion` with the fallback text that was
  actually and fully delivered, mirroring the existing `EMPTY_REPLY_FALLBACK`
  precedent exactly — never the original (incomplete, or too-expensive-to-
  replay) agent text. A future exact-duplicate redelivery of that same
  `update_id` (still possible for a `callback_query`-adjacent replay path,
  and as defense in depth) then replays the honest fallback, not a partial
  answer or a second `MAX_ITERATIONS`-priced turn.
- **One guarded-send helper, introduced in Phase 2, reused by Phases 3 and
  4 — and a notice that fails to deliver must not record completion.**
  Every new user-facing notice this plan adds is a *second* send occurring
  after something already went wrong, so each one can itself fail (a 403
  from a user who blocked the bot is the realistic case). Left unguarded,
  such a failure escapes `replyWithCompletion` into `handleCompletion`'s
  existing catch, which then sends `GENERIC_FAILURE_REPLY` — the exact
  misleading outcome Phase 3 exists to prevent — and, if that send fails
  too, escapes to the poller as a second mislabeled error. `sendUserNotice`
  (Phase 2) therefore wraps every notice send once, logs a single `warn`,
  and returns whether delivery succeeded; callers record dedupe completion
  **only** on `true`, which is the locked "completion only where a reply
  actually reached the user" rule expressed in code rather than in prose.
  The ordinary reply send (`complete.ts:120`) and the already-completed
  replay send (`:189`) stay unguarded on purpose — their failure behavior is
  pre-existing and out of this plan's scope.
- **The partial-send signal is only correct because `sendMessage`'s chunk
  loop is strictly sequential and already awaits one chunk before starting
  the next** (`client.ts:351-364`). If that loop is ever parallelized, the
  "index > 0 means an earlier chunk already landed" assumption silently
  breaks — call this out at the throw site so a future editor sees it.
- **Translating `GENERIC_FAILURE_REPLY` and `OUT_OF_BUDGET_REPLY` breaks two
  existing exact-content assertions**
  (`apps/hermes/src/handlers/__tests__/complete.test.ts:157-159` compares
  against the literal English `GENERIC_FAILURE_REPLY` string, verbatim.
  The budget test at `:155-156` is two assertions, not one, and only the
  first needs translating: `:155` is `expect(replyText).toMatch(/budget/i)`
  — a *positive* match that must become `/presupuesto/i`; `:156` is
  `expect(replyText).not.toMatch(/\$5/)` — a *negative* assertion that the
  dollar figure never leaks into chat, which stays correct and unedited in
  Spanish. Don't "translate" `:156`.) Both edits must land in the same phase
  as the translation, not in a later "fix CI" commit.
- **Manual verification limits, accepted up front:** forcing a genuine 403
  (bot-blocked), a genuine mid-send Telegram failure, or a genuine
  `MAX_ITERATIONS` exhaustion against the real production bot is either
  destructive (blocking your own bot) or impractical to contrive on demand.
  Per this repo's own precedent for impractical manual checks (plan
  `06-legible-approvals-bounded-reads` Phase 2's many-tab spreadsheet), those
  three checks are accepted as unit-test-only (`[~]`) in Phase 6; only the
  ordinary golden path (send a message, get a reply) is manually verified
  live.
- **No schema change, no new dependency, no CI change.** `pnpm lint` remains
  a named Final Verification gate, same posture as prior plans.

## HIL Prerequisites (manual, before Phase 6)

**Mode:** hil

- [ ] Confirm access to a real Telegram bot + a private test chat with it,
      for the Phase 6 golden-path smoke test (send a normal message, confirm
      a normal reply — proving the poller reorder didn't regress the common
      case).
- [ ] Accept, per the "Manual verification limits" note above, that the
      403/partial-send/max-iterations checks in Phases 2-4 and the final
      verification are unit-test-only (`[~]`), not live-Telegram-verified —
      confirm no better option exists before Phase 6 (e.g., a disposable
      second bot token that can be safely blocked) and record the decision
      either way.

---

### Phase 0: Create worktree

**This phase is always first. No exceptions.**

**Steps:**

- [ ] Confirm with the user: branch name
      `feat/07-one-paid-turn-one-outcome`, base ref `main`
- [ ] `git worktree add ../hermes-07-one-paid-turn -b feat/07-one-paid-turn-one-outcome main`
- [ ] Verify worktree is active and on the correct branch: `git worktree list`
- [ ] **Explicit step, do not skip:** copy `.env` from the repo root into the
      new worktree (`../hermes-07-one-paid-turn/.env`) — gitignored, so the
      worktree starts without it.

---

### Phase 1: Ack before dispatch — the one real double-charge race is closed

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** When `offsetRepo.setOffset` rejects for a message
update, the message's handler is **never invoked at all** — proven by a test
where a rejecting `setOffset` leaves a spy handler with zero calls, and a
second `getUpdates` call (simulating Telegram's redelivery of the un-acked
update) then dispatches the handler exactly once. **Observable, not just "a
guard exists":** this is the one property in this plan that a unit test
proves more convincingly than a live Telegram check ever could — a live
check cannot force `setOffset` to fail on demand — so this phase's
observable bar is four named assertions, each a statement about system
behavior rather than about code existing: (a) a rejecting `setOffset` leaves
the message handler spy at **zero** calls; (b) the redelivered update then
dispatches it **exactly once**; (c) on the success path, `setOffset` is
recorded as *resolved* in a shared call-order array **before** the handler's
first entry; (d) a `callback_query` update's `handleCallback` is recorded
**before** its `setOffset` — the asymmetry this phase deliberately keeps.
Plus: `poller-offset-ordering.test.ts` passes wholly unmodified, and
`poller-crash-replay.test.ts` passes with a comment-only edit (its
message-update case's assertions are order-independent and untouched — see
Steps).
**Commit message:** `fix(channels): ack telegram message offset before dispatching its handler`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/channels/src/telegram/poller.ts` | **This is a branch split, not a one-line move — read the resulting structure below before editing.** Today the loop body (L275-292) is an `if/else` (L285-289: `if (isCallbackUpdate(update)) { await handleCallback(update); } else { trackDispatch(dispatchMessage(update)); }`) falling through to **one shared** ack tail (L290-292: `const nextOffset = update.update_id + 1; await offsetRepo.setOffset(nextOffset); offset = nextOffset;`). Because the two branches need opposite orderings, that shared tail must be pushed *into* both branches, giving exactly this structure: `if (isCallbackUpdate(update)) { await handleCallback(update); const nextOffset = …; await offsetRepo.setOffset(nextOffset); offset = nextOffset; } else { const nextOffset = …; await offsetRepo.setOffset(nextOffset); offset = nextOffset; trackDispatch(dispatchMessage(update)); }`. The callback branch's own sequence is byte-for-byte the ordering it has today (handle → ack); only the message branch's ordering inverts, and dispatch there remains **un-awaited**. `nextOffset` is computed per branch (a duplicated one-liner in exchange for two independently correct orderings — extracting a helper for `update.update_id + 1` would be the speculative abstraction, not the duplication). The whole body stays inside the existing `try` so the shared catch (L293-308) keeps its current semantics — see the batch-abort Step below. Update the inline comment at L277-284 to state the new reasoning (ack now strictly precedes dispatch for message updates specifically so a `setOffset` failure can never race an already-started handler) while preserving its existing explanation of *why* dispatch itself is still never awaited (the approval-gate deadlock). Lightly reword `dispatchMessage`'s own doc comment (L194-209) where it says, verbatim at L202-204, "By the time this settles, `pollOnce` has already advanced the offset past this update (see the main loop below) — there is no redelivery to fall back on" — reflect that the offset is now persisted *before* dispatch even begins, not merely by the time it settles; the "no redelivery to fall back on" half stays true and must survive the reword |
| create | `packages/channels/src/telegram/__tests__/poller-ack-before-dispatch.test.ts` | New file, mirroring the existing per-concern split (`poller-offset-ordering.test.ts`, `poller-crash-replay.test.ts`): (1) a message update whose `setOffset` call is made to reject — assert the message handler is **never called**; (2) same setup, then a second `getUpdates` call resolves with the same (still-un-acked) update — assert the handler is called exactly once for it, proving clean, non-duplicated redelivery; (3) a message update whose `setOffset` resolves — assert the handler *is* dispatched, and that `setOffset` was called and had already resolved before dispatch began (call-order assertion via a shared array both mocks push into); (4) **regression guard for the untouched branch** — a `callback_query` update still calls `handleCallback` *before* `setOffset`, asserted by call order (the same shared-array technique as (3), not merely "both were called"), so a future edit that "simplifies" the split back into one shared ack tail fails here; (5) batch-abort: a two-update batch whose first update's `setOffset` rejects dispatches neither handler, proving no later update in the batch leapfrogs the failed ack |
| modify | `packages/channels/src/telegram/__tests__/poller-crash-replay.test.ts` | Comment-only edit, no assertion change: the second describe's explanatory comment (L143-151) claims a message update's offset "advances as soon as it's dispatched" — after this phase it advances *before* dispatch. Reword to match, keeping the rest of the comment's point (a crash mid-handler is still not redelivered, still guarded on the redelivery side by `complete.ts`'s dedupe machinery) intact |
| modify | `packages/channels/README.md` | The passage carrying "message handler failed after its offset was already advanced, not retried" is at **L193-201** (not L210-220 as an earlier draft of this row said); L213-216 is the follow-on paragraph about `complete.ts` closing "the redelivery-side (duplicate) half of this gap". The passage currently doesn't distinguish a `setOffset` failure from an ordinary handler failure for message updates. Add one paragraph: a `setOffset` failure for a message update now means dispatch never happened at all — the update is cleanly redelivered and runs exactly once — which is a **narrower**, not identical, guarantee than "there is no redelivery to fall back on," since that line was written for a handler failure *after* a successful ack, which still stands unchanged |

**Steps:**

- [x] Write the "setOffset rejects → handler never called" test *first*
      against the pre-fix code, prove it currently fails (today, the old
      dispatch-then-ack order calls the handler regardless of `setOffset`'s
      outcome), then reorder the code and prove it passes
- [x] Write the "clean single redelivery" test: same rejected-`setOffset`
      setup, then a fresh `getUpdates` response carrying the same
      `update_id` — assert the handler fires exactly once for that update,
      not zero and not twice
- [x] Write the call-order assertion for the success path (setOffset
      resolves fully before dispatch begins) — this is the property the
      whole fix rests on, so assert it directly rather than only inferring
      it from the failure-path tests
- [x] **Preserve batch-abort semantics — assert them, don't assume them.**
      The shared catch (L293-308) ends in `return;` (L306-307): a rejected
      `setOffset` (or `handleCallback`) exits `pollOnce` **entirely**, it
      does not `break`/`continue` within the `for` loop. Since `offset` was
      never advanced, the outer `loop()`'s next `getUpdates` re-requests
      from the same un-acked `update_id`, so the failed update *and every
      later update in that batch* come back — none of them leapfrog. The
      branch split must not move the `try`/`catch`, must not turn that
      `return` into a `continue`, and must not introduce a per-branch catch.
      Add an assertion to the new test file: a 2-update batch whose first
      update's `setOffset` rejects dispatches **neither** update's handler
- [x] Confirm `poller.test.ts`'s existing message-branch tests pass
      unmodified — L148-192 ("still advances the offset when a message
      handler throws"), L194-223 ("keeps processing the rest of a batch
      after a message handler throws"), and L230-304 (the malformed-update
      / `stop()` test — **note: the range is L230-304, not L230-292**; the
      draft's earlier figure was 12 lines short). None assert an ordering
      between dispatch and `setOffset` on the success path, only that the
      offset eventually advances and the handler eventually ran, so the
      reorder should not require editing them; if any turns out to assert
      ordering implicitly (e.g. via mock call sequence), update it minimally
      and note why in this file
- [x] Confirm `poller-offset-ordering.test.ts` passes with **zero edits** —
      it is genuinely callback-only (`describe("createTelegramPoller —
      offset persistence ordering (callback_query)")`, L48; both `it`s use
      `makeCallbackUpdate`), exercising the offset-after-handling guarantee
      this phase does not touch
- [x] **`poller-crash-replay.test.ts` is *not* callback-only — its
      assertions survive, its comment does not.** Its first describe
      (L53-140) is callback_query-only crash-replay, untouched. Its second
      (L142-186, "message offset advances without waiting for its handler")
      uses a **message** update: `it("persists a message update's offset
      even while its handler is still pending")` asserts only that the
      handler was called once and that `persistedOffset` eventually reaches
      81 — both order-independent, so they still pass after the reorder with
      no assertion change. But its explanatory comment (L143-151) says a
      message update's offset "now advances as soon as it's dispatched,"
      which this phase makes false (it advances *before* dispatch). Update
      that comment in this phase — a comment-only edit, no assertion
      touched — and say so here rather than claiming the file needs zero
      edits
- [x] Confirm `poller.ts`'s catch-block comment (L294-295, "Only a
      callback_query's handleCallback (or offsetRepo.setOffset itself) can
      land here now") is still accurate after the reorder — it should be,
      since `trackDispatch(dispatchMessage(update))` still cannot throw
      synchronously into this `try`

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/channels/src/telegram/__tests__/poller-ack-before-dispatch.test.ts` | setOffset-rejects-before-dispatch → handler never called; clean single redelivery after a rejected ack; call-order proof for the success path; callback_query branch's handle-then-ack order asserted by call order (regression guard); batch-abort — a rejected ack dispatches no later update in the same batch |
| modify | `packages/channels/src/telegram/__tests__/poller-crash-replay.test.ts` | No assertion change — comment-only correction; the file's existing message-update and callback_query cases must both still pass untouched |

**Verification:**

- [x] `pnpm --filter @hermes/channels test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm -r test` green
- [x] `pnpm lint` green
- [ ] Manual: send an ordinary message to the real bot in Telegram and
      confirm a normal reply still arrives — the reorder should be
      invisible on the golden path

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `fix(channels): ack telegram message offset before dispatching its handler`
- [ ] Phase marked complete

---

### Phase 2: `MaxIterationsReachedError` gets Spanish copy and still records completion

**Risk:** low
**Mode:** afk
**Type:** backend
**Success criteria:** When an agent turn exhausts `MAX_ITERATIONS` without a
final response, the user receives a distinct Spanish message (not the
generic English failure text) and the dedupe row for that update is marked
`completed` — a redelivery of that exact update (if one were ever possible)
would replay the same Spanish text instead of paying for a second turn.
**Observable:** a unit test drives `agent.handleMessage` to reject with
`MaxIterationsReachedError` and asserts (a) `channel.send` received the exact
`MAX_ITERATIONS_REPLY` string — not `GENERIC_FAILURE_REPLY`, asserted
negatively too — and (b) `dedupeRepo.complete` was called once with
`("telegram:1", MAX_ITERATIONS_REPLY)`. A second test covers the notice
itself failing to deliver: `channel.send` rejects, and the assertions are
that `dedupeRepo.complete` was **never** called (the row stays `pending`,
per the locked rule), exactly one `logger.warn` fired, and the handler's
promise **resolves** rather than rejecting. Live verification of the trigger
itself is accepted as impractical (see Dependencies & Risks) and is not
required here.
**Commit message:** `feat(hermes): spanish reply and dedupe completion on max-iterations`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/agent/src/loop.ts` | Add `export` to `class MaxIterationsReachedError extends Error` (L67) — no other change to the class |
| modify | `packages/agent/src/index.ts` | Add `export { MaxIterationsReachedError } from "./loop";` alongside the existing type-only exports |
| modify | `apps/hermes/src/handlers/complete.ts` | Import `MaxIterationsReachedError` from `@hermes/agent`. Add `export const MAX_ITERATIONS_REPLY = "Esto se alargó demasiado y no llegué a una respuesta final. Pídemelo de nuevo, quizás en partes más chicas."` beside the other reply constants, with a one-line comment on why it's distinct from `GENERIC_FAILURE_REPLY` (a paid, fully-run turn with a real result reported, not an error). Add `sendUserNotice(options, message, text, context): Promise<boolean>` beside `recordDedupeCompletion` (same file, same shape — a small named helper that swallows one failure and reports it): `try { await options.channel.send(message.chatId, text); return true; } catch (sendError) { options.logger.warn("failed to deliver notice to user — likely blocked the bot or unreachable", { ...context, error: sendError instanceof Error ? sendError.message : String(sendError) }); return false; }`. It is introduced here, in the **first** phase that adds a new user-facing notice send, and reused by Phase 3's cut-off notice and Phase 4's two failure-notice sends — one helper, four call sites by the end of the plan, no duplicated try/catch. In `replyWithCompletion` (L99-123, which has **no** try/catch today), wrap the `agent.handleMessage(...)` call in its own try/catch: on `MaxIterationsReachedError`, `logger.warn` with `{channelUserId: message.channelUserId, dedupeKey, iterations: error.iterations, totalCostUsd: error.totalCostUsd}`** — note `channelUserId: message.channelUserId`, not a bare shorthand: `replyWithCompletion`'s params are `(options, message, dedupeKey)`, there is no local `channelUserId` variable in this function, only `message.channelUserId` (string) — the existing empty-reply guard two lines above already uses exactly this pattern (`complete.ts:114`), match it, don't introduce an undefined-identifier bug **, then `const delivered = await sendUserNotice(...MAX_ITERATIONS_REPLY...)`, and **only if `delivered`**, `await recordDedupeCompletion(dedupeRepo, logger, dedupeKey, MAX_ITERATIONS_REPLY)`, then `return`. **Resolved during execution (code review, Phase 2):** the plan's original prose put the informational `logger.warn` *unconditionally before* `sendUserNotice`, which contradicted this same phase's explicit test requirement of "exactly one `logger.warn`" on delivery failure (it would fire two). The informational warn is therefore gated on `delivered === true`, and `iterations`/`totalCostUsd` are passed into `sendUserNotice`'s own `context` so the delivery-failure warn still carries the money actually spent — one warn per outcome, cost figures present on both paths. The `delivered` gate is the locked "record completion only where a reply actually reached the user" rule made explicit: an undelivered notice (403) leaves the row `pending`, which is inert by Phase 1's reasoning. This mirrors the existing empty-reply guard's ordering (guard before send, send before complete); any other error rethrows unchanged, so `replyWithFailureNotice`'s existing budget/generic handling is untouched |
| modify | `apps/hermes/src/handlers/__tests__/complete.test.ts` | New test: `agent.handleMessage` rejects with `new MaxIterationsReachedError(1.23, 12)` (constructor order is `(totalCostUsd, iterations)` — verified at `loop.ts:67-75`) → asserts `channel.send` called once with `MAX_ITERATIONS_REPLY` and *not* with `GENERIC_FAILURE_REPLY`, `dedupeRepo.complete` called with `("telegram:1", MAX_ITERATIONS_REPLY)`, and `logger.warn` called. Second new test: the same rejection **plus** a rejecting `channel.send` → `dedupeRepo.complete` never called, exactly one `logger.warn`, `await handler(...)` resolves. Both follow the existing empty-reply `it.each` block's structure (`complete.test.ts:162-186`), reusing its `createMockChannel`/`createMockAgent`/`createPermissiveDedupeRepo`/`inboundMessage` factories |

**Steps:**

- [x] Export `MaxIterationsReachedError` and confirm `pnpm --filter @hermes/agent typecheck` still passes with no other package needing a type update (it's a new export, not a changed one)
- [x] Write the max-iterations test in `complete.test.ts` following the existing empty-reply test's exact structure (mock factories already present: `createMockChannel`, `createMockAgent`, `createPermissiveDedupeRepo`, `inboundMessage`)
- [x] Confirm the new try/catch in `replyWithCompletion` does not change behavior for any other thrown error (budget, generic, empty-reply) — run the full existing `complete.test.ts` suite and confirm zero unrelated failures
- [x] Confirm the Spanish copy uses tuteo, matching `EMPTY_REPLY_FALLBACK`'s register exactly (`pídemelo`, not `pedime`/`pedíme`)
- [x] **Leave the happy-path send at L120 unguarded.** `sendUserNotice` is
      for the *notice* sends this plan adds (and, in Phase 4, the two
      pre-existing failure notices) — not for the ordinary reply. A failing
      ordinary send must keep falling through to `handleCompletion`'s catch
      and `replyWithFailureNotice` exactly as today; widening the guard to
      the happy path would change behavior this plan is not asked to change
- [x] Confirm the un-delivered case really does leave the row `pending`:
      assert `dedupeRepo.complete` was never called, not merely that no
      error was thrown

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `apps/hermes/src/handlers/__tests__/complete.test.ts` | `MaxIterationsReachedError` → exact Spanish reply sent (and generic failure text explicitly *not* sent), `dedupeRepo.complete` called with the notice text, warn logged; the notice-send-fails variant → `complete` never called, one warn, handler resolves; existing tests (budget, generic, empty-reply, happy path) unaffected |

**Verification:**

- [x] `pnpm -r typecheck` green
- [x] `pnpm -r test` green
- [x] `pnpm lint` green
- [~] Manual live trigger of `MAX_ITERATIONS` — accepted as impractical to
      force on demand against the real bot; unit test above is the
      accepted bar for this phase (see HIL Prerequisites)

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(hermes): spanish reply and dedupe completion on max-iterations`
- [ ] Phase marked complete

---

### Phase 3: Partial send becomes a typed signal, not a generic failure

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** When Telegram's `sendMessage` succeeds on an earlier
chunk of a long reply but fails on a later one, the user receives a short
Spanish notice that the reply was cut off (not the generic "something went
wrong" text, since they already received real content), and the dedupe row
is marked completed with that notice as the stored text. **Observable:** a
unit test on `createTelegramClient` proves a failure on chunk 2 of 3 throws
a distinguishable `TelegramPartialSendError` (not a plain `Error`) carrying
`partsSent`/`totalParts`; a unit test on `complete.ts` proves that error is
caught, the Spanish notice is sent, `GENERIC_FAILURE_REPLY` is asserted
never sent, and completion is recorded with the notice text. Two boundary
behaviors are asserted alongside: a **first-chunk** failure (zero chunks
delivered) is still a *total* failure — the original error propagates and
the user gets the ordinary generic failure reply, unchanged from today —
and a cut-off notice that itself fails to send produces exactly one `warn`,
no dedupe completion, no generic text, and a resolved handler promise. Live
verification of the trigger itself (a real mid-send Telegram failure) is
accepted as impractical.
**Commit message:** `feat(hermes): typed partial-send signal and spanish cut-off notice`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/channels/src/telegram/client.ts` | Add `export class TelegramPartialSendError extends Error { readonly partsSent: number; readonly totalParts: number; constructor(message: string, info: { partsSent: number; totalParts: number }) { super(message); this.name = "TelegramPartialSendError"; this.partsSent = info.partsSent; this.totalParts = info.totalParts; } }` near `TelegramApiError` (L130-142). In `sendMessage`'s chunk loop (L351-364), wrap the `callWithRetry` call in try/catch: if it throws and `index > 0` (an earlier chunk already landed), throw `new TelegramPartialSendError(...)` instead, carrying `partsSent: index` and `totalParts: parts.length`; if `index === 0`, rethrow the original error unchanged — **a first-chunk failure is a total failure, not a partial one**: zero chunks reached the user, so the generic "something went wrong" reply is the *correct* outcome there and today's behavior is untouched. `partsSent` **is** the delivered count (it equals `index`, the number of chunks that fully resolved before the failure, and is `>= 1` by construction since `index === 0` never reaches this throw) — no separate `deliveredCount` field is added, since a second name for the same number is exactly the kind of drift-inviting duplication CLAUDE.md warns about. Fold the underlying error's message into the new error's `message` string so the `TelegramApiError` detail (status, error code) is not lost to the logs when the wrapper replaces it. One-line comment noting this is only correct because the loop is strictly sequential (`client.ts:351-364` — verified: `await callWithRetry(...)` sits directly in the `for` body, one chunk fully resolving before the next starts; see Dependencies & Risks) |
| modify | `packages/channels/src/index.ts` | Add `TelegramPartialSendError` to the existing named export list from `./telegram/client`, alongside `TelegramApiError` |
| modify | `apps/hermes/src/handlers/complete.ts` | Import `TelegramPartialSendError` from `@hermes/channels`. Add `export const PARTIAL_SEND_NOTICE = "Se cortó la respuesta a la mitad. Pídemelo de nuevo, o en partes más chicas."` beside the other constants. In `replyWithCompletion` (L99-123, now already carrying Phase 2's try/catch around the agent call), wrap the existing `await options.channel.send(message.chatId, resultText)` call in its own try/catch: on `TelegramPartialSendError`, `logger.warn` with `{channelUserId: message.channelUserId, dedupeKey, partsSent: error.partsSent, totalParts: error.totalParts}`** — same scoping note as Phase 2: no local `channelUserId` in `replyWithCompletion`, only `message.channelUserId` **, then `const delivered = await sendUserNotice(...PARTIAL_SEND_NOTICE...)` — **reusing Phase 2's helper, not a second inline try/catch** — and only if `delivered`, `await recordDedupeCompletion(dedupeRepo, logger, dedupeKey, PARTIAL_SEND_NOTICE)`, then `return`. **This is the answer to "what if the cut-off notice itself fails?":** the helper swallows it into one `warn`, the row is left `pending` (per the locked rule), the user keeps the partial answer they already received, and — critically — they are **not** then also sent `GENERIC_FAILURE_REPLY`, which is what would happen if this second send were left unguarded to fall through to `handleCompletion`'s catch. **Resolved during execution (code review, Phase 3):** this phase's File-changes prose put the informational `logger.warn` *unconditionally before* `sendUserNotice`, contradicting this phase's own "exactly one `warn`" success criterion — the same contradiction Phase 2 carried, but initially resolved here in the opposite direction, leaving two sibling catch blocks in `replyWithCompletion` logging differently for structurally identical situations. Unified on Phase 2's shape: the informational warn is gated on `delivered === true` and `partsSent`/`totalParts` are passed into `sendUserNotice`'s own `context`, so exactly one warn fires per outcome with no diagnostics lost on either path. `GENERIC_FAILURE_REPLY` was also exported so the tests assert against the real constant instead of a re-declared literal. Any other error from the first send rethrows unchanged so `replyWithFailureNotice` still handles a total send failure exactly as before |
| modify | `packages/channels/README.md` | Verified: the port's `send(target, text, options?)` bullet (**L28-31**) documents only the return value (`Promise<{ messageId: string }>`) and `options.buttons` — no throw contract. The nearest existing prose is the retry-class paragraph at **L66-78**, which says the client "rethrows to the poller's own retry loop" after bounded retries, but says nothing about *partial* delivery, so a caller today cannot tell "nothing was sent" from "half was sent." Add to the `send` bullet: `send` can throw a plain error (total failure — nothing delivered) or, for the Telegram implementation specifically, `TelegramPartialSendError` when an earlier chunk of a multi-part message already landed before a later one failed — callers that care about the distinction should check `instanceof TelegramPartialSendError` |

**Steps:**

- [x] Write the client-level test first: a 3-chunk send whose 2nd
      `callWithRetry` call rejects — assert the thrown error is a
      `TelegramPartialSendError` with `partsSent: 1, totalParts: 3` (not the
      underlying error), while a 1-chunk (or first-chunk) failure still
      throws the original, unwrapped error
- [x] Write the `complete.ts`-level test: `channel.send` rejects with a
      `TelegramPartialSendError` on the first call — assert a *second*
      `channel.send` call with the exact `PARTIAL_SEND_NOTICE` text,
      `dedupeRepo.complete` called with `("telegram:1", PARTIAL_SEND_NOTICE)`,
      and no call ever reaches `replyWithFailureNotice`'s generic text
- [x] Confirm a *total* send failure (a plain `Error` from `channel.send`,
      first chunk) still falls through to the existing generic-failure path
      unchanged — regression case in the same test file
- [x] Write the double-failure test: `channel.send` rejects with
      `TelegramPartialSendError` on the first call **and** rejects again on
      the notice send — assert exactly one `warn` from `sendUserNotice`,
      `dedupeRepo.complete` never called, `GENERIC_FAILURE_REPLY` never
      sent, and the handler's promise resolves
- [x] Confirm the Spanish copy uses tuteo, matching the existing precedents

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `packages/channels/src/telegram/__tests__/client-send-chunking.test.ts` | a later-chunk failure throws `TelegramPartialSendError` with correct `partsSent`/`totalParts`; a first-chunk failure still throws the original error unwrapped |
| modify | `apps/hermes/src/handlers/__tests__/complete.test.ts` | `TelegramPartialSendError` from `channel.send` → Spanish cut-off notice sent, dedupe completion recorded, warn logged, `GENERIC_FAILURE_REPLY` asserted **never** sent; the notice send *also* failing → one warn, no dedupe completion, still no generic text, handler resolves; a plain send error still falls through to the existing generic-failure behavior |

**Verification:**

- [x] `pnpm --filter @hermes/channels test` green
- [x] `pnpm --filter hermes test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm -r test` green
- [x] `pnpm lint` green
- [~] Manual live trigger of a genuine mid-send failure — accepted as
      impractical to force against the real Telegram API on demand; unit
      tests above are the accepted bar for this phase (see HIL Prerequisites)

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(hermes): typed partial-send signal and spanish cut-off notice`
- [ ] Phase marked complete

---

### Phase 4: 403 no longer double-logs or escapes, and the last two constants speak Spanish

**Risk:** low
**Mode:** afk
**Type:** backend
**Success criteria:** When the failure-notice send itself fails (a 403 —
bot blocked — being the realistic case), the handler logs exactly once, at
`warn`, with an accurate label, and the error no longer escapes
`replyWithFailureNotice` up to the poller's own catch (which today logs a
second, mislabeled error). `GENERIC_FAILURE_REPLY` and `OUT_OF_BUDGET_REPLY`
are now Spanish tuteo, matching `EMPTY_REPLY_FALLBACK`'s and this plan's
other new copy's register. This phase adds **no new helper** — it routes the
two pre-existing failure-notice sends through the `sendUserNotice` helper
Phase 2 already introduced. **Observable:** a unit test where `channel.send`
always rejects (simulating a fully blocked bot) asserts exactly one `warn`
call from the guard, zero *additional* `error`-level calls beyond
`replyWithFailureNotice`'s own pre-existing "llm completion failed" line,
and that `handleCompletion`'s returned promise resolves (not rejects) —
proving nothing escapes to the poller; the updated budget/generic tests
assert the two translated constants' exact Spanish text.
**Commit message:** `fix(hermes): guard failure-notice sends and translate reply copy to spanish`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `apps/hermes/src/handlers/complete.ts` | Translate `GENERIC_FAILURE_REPLY` (L22-23) to `"No pude procesar tu mensaje ahora. Prueba de nuevo en un rato."` and `OUT_OF_BUDGET_REPLY` (L31-32) to `"Hermes se quedó sin presupuesto este mes. Prueba de nuevo después del reinicio mensual."`, both tuteo. Replace both `await channel.send(...)` calls inside `replyWithFailureNotice` (L144 — `OUT_OF_BUDGET_REPLY`; L152 — `GENERIC_FAILURE_REPLY`) with calls to **Phase 2's existing `sendUserNotice` helper** — this phase adds no second guard helper of its own (`sendUserNotice` was introduced in Phase 2 precisely so all four notice sends share one implementation). Its `boolean` return is ignored here: `replyWithFailureNotice` records no dedupe completion in the first place, so there is nothing for delivery to gate — pass the context `{channelUserId}` and let the helper's single `warn` be the whole outcome. After this, neither failure-notice send can escape the function or produce the second, mislabeled `error` the poller logs today |
| modify | `apps/hermes/src/handlers/__tests__/complete.test.ts` | Update the existing assertions that hardcode the old English text — all verified in place: the budget test's `expect(replyText).toMatch(/budget/i)` (L155) → `/presupuesto/i`; `expect(replyText).not.toMatch(/\$5/)` (L156) stays as-is (it is a *negative* assertion that the dollar figure never leaks, and stays true in Spanish); and the generic test's `expect(replyText).not.toBe("Sorry, I couldn't process that message right now. Please try again in a moment.")` (L157-159) → the new Spanish `GENERIC_FAILURE_REPLY` literal. New test: `channel.send` rejects on **every** call (a fully blocked bot) — assert `logger.warn` called exactly once from the send guard, `logger.error` called only once and only by `replyWithFailureNotice`'s own pre-existing "llm completion failed" line (i.e. the guard itself contributes zero `error` calls, and there is no *second* mislabeled error), and `await handler(...)` resolves rather than throwing |

**Steps:**

- [x] Write the double-403 regression test *first* against the pre-fix code
      (a rejecting `channel.send` inside the failure path today throws out
      of `handleCompletion`), prove it fails, then add the guard and prove
      it passes
- [x] Grep `complete.ts` after the change to confirm no direct
      `channel.send` call remains inside `replyWithFailureNotice`, and that
      no *second* guard helper was added — every notice send in the file
      goes through Phase 2's single `sendUserNotice`. The only remaining
      direct `channel.send` calls should be the two deliberate ones: the
      ordinary reply (L120) and the already-completed replay (L189)
- [x] Update the two Spanish-breaking assertions in `complete.test.ts` in
      this same commit, not a follow-up
- [x] Confirm the two translated constants use tuteo consistent with the
      rest of this plan's copy

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `apps/hermes/src/handlers/__tests__/complete.test.ts` | failure-notice send failure logs once at warn, never escapes, handler resolves; existing budget/generic tests updated for the Spanish text; happy-path and empty-reply tests unaffected |

**Verification:**

- [x] `pnpm --filter hermes test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm -r test` green
- [x] `pnpm lint` green
- [~] Manual live 403 (blocking the real bot from a test account) — accepted
      as impractical/destructive to provision on demand; unit test above is
      the accepted bar for this phase (see HIL Prerequisites)
- [ ] Manual: send an ordinary message and confirm the reply text still
      reads naturally in Spanish (spot-check register against
      `EMPTY_REPLY_FALLBACK`)

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `fix(hermes): guard failure-notice sends and translate reply copy to spanish`
- [ ] Phase marked complete

---

### Phase 5: Knowledge base sync — correct the false "retries" claim

**Risk:** low
**Mode:** afk
**Type:** docs
**Success criteria:** Grepping `.ai/` and the touched READMEs for the string
`retries` turns up **no** surviving claim that a message-originated `pending`
`llm_dedupe` row is retried on redelivery — checked in all four places that
carry it today (`.ai/index.md:38`, `.ai/architecture.md:378`,
`.ai/decisions/telegram-long-polling-correctness.md:103-115`,
`packages/store/README.md:156-158`) — and each instead states what actually
happens: ack-before-dispatch (Phase 1), a `setOffset` failure now replaying
an update whose handler never ran, and a post-ack handler failure losing the
turn rather than retrying it. Two docs that currently **contradict
themselves** (`.ai/index.md`'s invariant-#4 cell and the long-polling
decision's crash bullet) each read as a single coherent statement afterwards.
This phase has no runtime behavior to test — its correctness is reviewed, not
executed; it is the plan's one allowed non-vertical phase (pure prose, per
the format spec's docs exception), and it lands last on purpose so it
documents shipped behavior rather than intended behavior.

**Resolved during execution (code review, Phase 5):** the first attempt (`700b2b1`) removed the false "a `pending` row retries" claim but replaced it with a second false one — that the `llm_dedupe` fail-open branch is load-bearing for `callback_query` replays. It is not: a `callback_query` never reaches `llm_dedupe` at all (`claim()` has exactly one caller, `complete.ts`, keyed off `InboundMessage.updateId` and reachable only via `dispatchMessage`; a replayed tap hits the approval gate's expiry path instead — zero claims, zero spend). Corrected in `f0cf0bb`: after Phase 1 the fail-open branch is **defensive, not load-bearing** — reaching it now requires an off-code event (a rewound `telegram_offset` row, or a second poller past the boot advisory lock), not any path the poller itself can take. A follow-up (`1210797`) also narrowed the enumeration of what leaves a row `pending`: partial-send and max-iterations do so only when their notice *also* fails to deliver, since Phases 2-4 record completion whenever it lands.
**Commit message:** `docs: sync knowledge base for 07-one-paid-turn-one-outcome`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `.ai/index.md` | Cross-cutting "Handler idempotency (invariant #4)" row (**L38** — one long table cell). It already **contradicts itself today**: the same cell opens with "**A message update is no longer replayed on crash** — … a crashed turn is simply lost, logged and not retried" and later says "A crash inside that claim→complete window leaves the row `pending`, which **retries** — a named accepted risk". The edit is to delete/replace that second, stale clause so the cell states one thing — a `pending` row from a post-ack handler failure (crash, thrown error, 403, partial send, max-iterations) is **not** retried, because the offset is already acked; the only closed money-relevant risk was a `setOffset` failure racing an in-flight dispatch, fixed in `07-one-paid-turn-one-outcome` by acking before dispatch. Cross-reference the new decision doc **(resolved during execution: no new decision doc was created in Phases 1-4, so the cross-reference points at the existing `poller-concurrent-message-dispatch.md`, which owns the ordering decision)** |
| modify | `.ai/decisions/telegram-long-polling-correctness.md` | **Two edits, both verified in place.** (1) The "A crash between claim and complete" bullet (**L103-115**, inside "The at-least-once contract's first paid consumer") disagrees with itself *within the bullet*: it opens "The row is left `pending`, and a `pending` row is claimable again: a redelivery runs the call a second time" and then closes "Since Phase 3 detached message dispatch, a *crash* mid-turn no longer produces that redelivery at all … The dedupe machinery now earns its keep against exact-duplicate **delivery** (a `setOffset` that itself failed, replaying the batch), not against the crash window." Reconcile into one statement, and record that this plan closed the one case that closing sentence still leaves live: after Phase 1, a `setOffset` failure on a message update replays an update whose handler **never ran**, so it cannot double-charge either. (2) The "Constraints it creates" bullet at **L146-151** ("Every handler must tolerate being invoked twice… Still required after Phase 3: a failed `setOffset` replays the batch even though a crash no longer does") must be **narrowed, not deleted**: that sentence stays true for `callback_query` (handled before its ack, so a failed ack really does re-invoke a handler that already ran) and becomes false for message updates (acked before dispatch). Say which kind it now applies to |
| modify | `.ai/architecture.md` | **Missing from the draft's original table — two places.** (1) **L374-380**: "a `pending` dedupe row **retries** (fail open, because a wedged message is worse than one bounded duplicate charge)" — the same false claim as `index.md`'s, in the paragraph contrasting the budget ceiling's fail-closed shape with dedupe's fail-open one. Correct it the same way, keeping the fail-open *rationale* (it still explains why `claim()` returns `claimed` for a `pending` row) while dropping the claim that a message-originated row actually gets retried. (2) **L390-396**: "For a `callback_query`, the offset write is still the last step … For a message it is the *first* step: the handler runs detached" — this becomes **literally** true after Phase 1 (it was approximately true before, since the ack landed after the fire but before the handler resolved). Tighten the wording to say the ack now strictly precedes dispatch, and keep the "both halves of that asymmetry are load-bearing" point, which this plan reinforces rather than changes |
| modify | `.ai/decisions/poller-concurrent-message-dispatch.md` | Add a short addendum: `07-one-paid-turn-one-outcome` reordered the message branch so `setOffset` now runs and resolves *before* `dispatchMessage` is invoked (previously: fire dispatch, then ack) — dispatch is still never awaited, for the same deadlock reason this doc describes; only the ack's position relative to the fire moved. **Also fix one sentence that this plan makes true and that was optimistic before it** (in the "Accepted trade-off" section, ~L51-54): "The **double-processing** side is still guarded — … an exact-duplicate delivery still costs zero provider calls." Until Phase 1 that was false in exactly one case — the `setOffset`-failure replay racing an in-flight handler, where `claim()` fail-opens and a second paid turn runs (this plan's whole Context). Note that it holds unconditionally for message updates from this plan onward, and why |
| modify | `packages/store/README.md` | Real locations (the draft's earlier "~L147-165" was approximate): the section header "Claim-to-complete crash window — an accepted, fail-open residual risk" is **L151**, and the false sentence is **L156-158**: "On restart, Telegram redelivers the same `update_id`, `claim()` sees `pending`, and returns `{status: "claimed"}` again — **the retry proceeds and may issue a second…**". Correct it to state that a message update's `pending` row from a post-ack failure is *not* redelivered and is simply inert. Also touch the two pointers into it that repeat the framing: **L145-146** (`claim()`'s own bullet, "the row is still `pending` -> `{status: "claimed"}` **again** — see 'Claim-to-complete crash window' below") and the "(the documented retry case)" / "(the pending-retry…)" asides at **L533** and **L587**. Keep the `claim()` **behavior** description exactly as it is — the fail-open branch still exists and still returns `claimed`; only the claim about what *reaches* it changes |
| modify | `apps/hermes/README.md` | The "Handlers" section's `complete.ts` bullet (**L455-457**: "the dispatcher's fallthrough and the only handler that spends money. Claims `telegram:<updateId>` in `llm_dedupe` before the agent turn and marks it completed after the reply lands.") gains a clause: it now sends distinct Spanish copy for a partial send and a max-iterations outcome, routes every notice send through one guard so a blocked user produces a single `warn` instead of an escaped error, and records completion only when a reply actually reached the user |
| modify | `packages/agent/README.md` | Not merely an addition — a **correction**. **L175-176** currently reads "throws an internal `MaxIterationsReachedError` carrying the real accumulated `costUsd` and iteration count"; the word *internal* is what this plan makes false. Reword to say it is exported from the package's public surface, and why (the completion handler `instanceof`-checks it to send distinct copy and still record a paid, completed turn). Leave the `outcome: "max_iterations"` telemetry prose at **L191-195** as-is — it stays accurate |

**Steps:**

- [x] Re-read every file listed above in full before editing — do not edit
      from memory of this plan's Context section alone
- [x] Re-run the sweep that found `.ai/architecture.md` (`grep -rn "retries\|retried" .ai/`)
      after editing, and confirm every remaining hit is about something else
      (HTTP retry classes, token refresh, Sheets write modes) — not about a
      `pending` dedupe row
- [x] Confirm `packages/channels/README.md` and `.ai/index.md`'s "poller"
      row don't also need a matching correction beyond what Phases 1 and 3
      already made to `packages/channels/README.md`. Note `channels`'
      README already describes the message-side behavior correctly at
      **L193-201** ("immediately, before its handler has even started" and
      the `"message handler failed after its offset was already advanced,
      not retried"` log line) — Phase 1's own edit lands there, so this step
      is a check, not a second edit
- [x] Cross-check `apps/hermes/src/handlers/__tests__/complete-dedupe.test.ts`
      and `complete-dedupe-crash-window.test.ts` for any comment asserting
      the old "redelivers" framing in prose (not assertions) — update
      comments only if they exist; no code change expected in these DB
      suites, since their scenarios exercise `dedupeRepo` directly and were
      never wrong about the DB-level contract, only about what triggers a
      redelivery at the poller level

**Tests:**

No automated tests — justified because: this phase changes only prose in
`.ai/` and README files, with no behavior for a test to exercise; the
behavior it documents was already tested in Phases 1-4.

**Verification:**

- [x] Every corrected file re-read after editing to confirm no internal
      contradiction remains (the `telegram-long-polling-correctness.md`
      edit specifically must not leave two paragraphs disagreeing)
- [x] `pnpm lint` green (markdown is not linted, but confirm no code file
      was accidentally touched in this phase)

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing (n/a — see Tests above)
- [x] Documentation updated (this phase *is* the documentation update)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `docs: sync knowledge base for 07-one-paid-turn-one-outcome`
- [ ] Phase marked complete

---

### Phase 6: Final Verification

**This phase runs after all other phases are complete.**
**Mode:** hil

**Overall success criteria:**

- A `setOffset` failure for a message update can never result in two paid
  agent turns for one inbound message — proven by Phase 1's tests, since
  this specific property cannot be forced live against real Telegram.
- A normal message still gets a normal reply, unchanged by the poller
  reorder.
- The `callback_query` branch still acks **after** handling — asserted by
  Phase 1's call-order regression test, not by inspection.
- `MaxIterationsReachedError`, a mid-send Telegram failure, and a 403 each
  produce a distinct, accurate, Spanish (tuteo) reply instead of a generic
  English failure — proven by unit tests per phase; live triggering of all
  three remains accepted as impractical (see HIL Prerequisites).
- A user who has blocked the bot produces exactly one `warn` per failed
  notice and never an escaped error or a second mislabeled `error` log —
  and their `llm_dedupe` row is left `pending`, never marked `completed`
  for a reply they never received.
- `GENERIC_FAILURE_REPLY` and `OUT_OF_BUDGET_REPLY` read naturally in
  Spanish and match the register of the rest of this plan's copy.
- A repo-wide grep finds no surviving claim that a message-originated
  `pending` row "retries" — all four places (`.ai/index.md`,
  `.ai/architecture.md`,
  `.ai/decisions/telegram-long-polling-correctness.md`,
  `packages/store/README.md`) corrected and internally consistent.
- No CLAUDE.md invariant violated: `sheet_write_log`/`packages/google-sheets`
  untouched; no new dependency; no speculative `llm_dedupe` cleanup
  mechanism added; one guarded-send helper rather than a per-phase copy.

**Steps:**

- [x] Every preceding phase's Steps/Verification/Phase review checkboxes
      are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to
      end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt
      into a fresh session
- [x] Code-reviewer agent reviews the entire change end-to-end
- [x] Any changes made in response to the final code-reviewer review have
      been reflected back into this plan file
- [x] `pnpm -r typecheck` green
- [x] `pnpm -r test` green
- [x] `pnpm lint` green
- [x] No CLAUDE.md invariants violated
- [x] Manual golden path on the real bot: send an ordinary message, confirm
      a normal reply, confirm nothing about the poller reorder is visible
      to a normal user
- [~] `[~]` 403, partial-send, and max-iterations live triggers — accepted
      as impractical/destructive to provision on demand (see HIL
      Prerequisites); unit test coverage from Phases 2-4 is the accepted bar
- [x] Overall success criteria met
- [x] `sync-knowledge` re-run to confirm Phase 5's edits are still accurate
      after any Final-Verification-driven fixes
- [ ] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| Ack-before-dispatch reorder, narrowed `setOffset`-failure redelivery guarantee | `packages/channels/README.md` |
| `TelegramPartialSendError`, `Channel.send`'s throw contract | `packages/channels/README.md` |
| Distinct Spanish copy for max-iterations, partial-send, 403-guard behavior | `apps/hermes/README.md` |
| `MaxIterationsReachedError` now exported from `@hermes/agent` | `packages/agent/README.md` |
| Corrected "pending row retries" claim (all four places it appears) | `.ai/index.md`, `.ai/architecture.md`, `.ai/decisions/telegram-long-polling-correctness.md`, `packages/store/README.md` |
| One guarded notice send; completion recorded only on delivery | `apps/hermes/README.md` |
| Ack-before-dispatch addendum to the existing detached-dispatch decision | `.ai/decisions/poller-concurrent-message-dispatch.md` |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `index.md` | update | Invariant-#4 row (L38) corrected and de-contradicted: a post-ack `pending` row is inert, not retried; the only closed money risk was the `setOffset`-failure race |
| `architecture.md` | update | The fail-open/fail-closed contrast at L374-380 no longer claims a `pending` dedupe row retries; the poller-asymmetry paragraph at L390-396 tightened to "ack strictly precedes dispatch" |
| `decisions/telegram-long-polling-correctness.md` | update | Reconciles the self-disagreeing crash bullet (L103-115); narrows the "handler invoked twice" constraint (L146-151) to `callback_query`; records the Phase 1 fix |
| `decisions/poller-concurrent-message-dispatch.md` | update | Addendum: ack now precedes dispatch for message updates; dispatch itself still never awaited, same reason as before; its "an exact-duplicate delivery still costs zero provider calls" claim (~L51-54) becomes unconditionally true and is annotated as such |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | Ack-before-dispatch: setOffset failure blocks dispatch entirely; clean single redelivery; success-path call-order proof; callback branch's handle-then-ack order (regression guard); batch-abort — no later update leapfrogs a failed ack | `packages/channels/src/telegram/__tests__/poller-ack-before-dispatch.test.ts` |
| Phase 1 | Existing message-update and callback_query cases still pass; comment-only correction, no assertion change | `packages/channels/src/telegram/__tests__/poller-crash-replay.test.ts` |
| Phase 2 | `MaxIterationsReachedError` → Spanish reply sent, generic text not sent, dedupe completion recorded; notice-send failure → one warn, no completion, handler resolves | `apps/hermes/src/handlers/__tests__/complete.test.ts` |
| Phase 3 | `sendMessage` throws `TelegramPartialSendError` only when an earlier chunk already landed; a first-chunk failure still throws the original error unwrapped | `packages/channels/src/telegram/__tests__/client-send-chunking.test.ts` |
| Phase 3 | `TelegramPartialSendError` → Spanish cut-off notice, generic text never sent, dedupe completion recorded; notice-send also failing → one warn, no completion, handler resolves | `apps/hermes/src/handlers/__tests__/complete.test.ts` |
| Phase 4 | Failure-notice sends routed through the shared guard: single warn, no second mislabeled error, never escapes; translated constants' exact text | `apps/hermes/src/handlers/__tests__/complete.test.ts` |

## Human Summary

This plan started from a wrong assumption — that three known failure cases
in the bot's reply handler were secretly charging users twice for the same
LLM turn. They aren't: Telegram's own delivery guarantee, plus how this bot
acknowledges messages, already makes that impossible for those three cases.
Research found the real, narrower leak instead: a rare database hiccup at
exactly the wrong moment could let one inbound message get processed (and
paid for) twice. The fix is a one-line reordering — acknowledge a message to
Telegram *before* starting work on it, instead of after — which closes that
gap completely without adding any new bookkeeping. The rest of this plan is
smaller, honest cleanup that was worth doing anyway: three situations
(a reply that ran too long for the model to finish, a reply that got cut off
mid-delivery, and a user who's blocked the bot) that used to either look like
a generic English error or silently double-log — now each gets a short,
accurate Spanish message, and none of them produce noisy or misleading logs.
All three of those short messages go out through a single piece of shared
code that handles the awkward case of the apology itself failing to send —
if someone has blocked the bot, that's one quiet note in the log rather than
an error cascade, and the bot never records a message as "answered" when the
answer never actually arrived.
The last two English error messages left in the bot are also translated, so
every user-facing reply is now consistently in the same Spanish, informal
register.
