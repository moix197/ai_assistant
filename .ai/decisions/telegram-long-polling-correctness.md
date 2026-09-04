# Telegram long-polling correctness: at-least-once, offset-after-handling, single instance

The highest-value entry in this knowledge base. Every rule below is
non-obvious, silently breakable, and expensive to rediscover — two of them fail
in ways that produce *no error at all*.

**Decision:**

1. The poll offset is persisted per update, never batched — and, for a
   `callback_query` update, **after** it is fully handled. 03-agent-core Phase 3
   carved message updates out of that rule: their offset advances immediately
   while the handler runs detached, because the approval gate deadlocks
   otherwise. The reasoning and the trade-off live in
   [poller-concurrent-message-dispatch](poller-concurrent-message-dispatch.md);
   the section below is why the rule existed and why callbacks still keep it.
2. Exactly one Hermes process may poll a given bot token, enforced at boot by a
   Postgres session advisory lock on a dedicated connection.
3. Handlers must be idempotent, because a redelivered update is replayed.

## Why offset-after-handling

Telegram's `getUpdates` is **at-least-once, not exactly-once**. Sending
`offset = update_id + 1` is an *ack*: it permanently deletes those updates
server-side. There is no redelivery, no dead-letter, no way to ask for them
again. (Unfetched updates are retained 24h, then dropped.)

So the two orderings fail asymmetrically:

- Persist **before** handling → a crash in between loses the message **forever
  and silently**. Nothing logs, nothing retries; the user's message simply never
  happened.
- Persist **after** handling → a crash in between replays exactly that one
  update on restart. Visible, bounded, recoverable.

Duplicates are recoverable; losses are not. That asymmetry is the whole
argument, and it still holds — `pollOnce` in
`packages/channels/src/telegram/poller.ts` awaits a `callback_query`'s handler
before `setOffset(update_id + 1)`, and a throwing callback handler aborts the
rest of the batch, since continuing would advance a later update's offset past
the one that just failed.

Message updates are the one place the project knowingly took the losing side of
that asymmetry, because keeping it made human tool approval impossible to
implement at all — see
[poller-concurrent-message-dispatch](poller-concurrent-message-dispatch.md) for
the deadlock, the options, and what a crash now costs.

**This ordering is not observable from unit tests alone.** Phase 2's mutation
testing established that while the offset lived in memory, moving the write
before `await handler(...)` was externally undetectable: the offset was
closure-private and only read by the next `getUpdates`, which is sequenced after
the await either way. Persistence is what turns it into a real crash window.
It is now guarded by two tests that must both survive any refactor —
`poller-offset-ordering.test.ts` (asserts `setOffset` resolves after the
callback handler) and `poller-crash-replay.test.ts` (proves the replay actually
happens). Crash-replay alone is **not** a sufficient guard: its instance-1
`setOffset` always rejects, so a reordered write would still pass it. Both now
exercise `callback_query` updates, since that is the only kind the guarantee
still covers; each file carries a second case pinning the message side's
deliberately different behavior.

## Why single-instance, and why an advisory lock

Telegram allows exactly **one** concurrent `getUpdates` consumer per bot token.
A second one gets a 409 — from inside a poll loop, minutes after boot, with no
indication of which process is at fault. That is the mystery failure this design
exists to eliminate, so the conflict is converted into a fast, readable boot
error instead.

- `INSTANCE_LOCK_KEY = 837_452_910` in
  `packages/store/src/advisory-lock.ts`. Arbitrary but **stable by convention**:
  changing the value lets an old and a new instance run concurrently without
  conflicting, defeating the entire mechanism.
- Acquired via `pg_try_advisory_lock` on a **dedicated `pg.Client` opened
  outside the shared pool**. Session-level advisory locks belong to the
  connection that took them; a pooled connection can be handed to unrelated
  queries or recycled, silently dropping the lock while the process believes it
  still holds it. Never take this lock from the pool.
- A crashed instance frees its lock automatically when its connection closes —
  a Postgres-side guarantee — so a dead process never permanently blocks a new
  one. `release()` exists for the ordered shutdown path, not for safety.
- Failure to acquire exits non-zero with *"another Hermes instance is already
  running against this database"*.

The 409 path is defended twice, because the lock only covers instances sharing
this database: `client.ts` retries a 409 a bounded 3 times, then throws a
readable fatal `TelegramApiError`; `poller.ts` stops its loop and calls
`onFatalError`; `boot.ts` logs and exits 1. An unbounded retry loop on 409 —
what the code originally shipped with — reintroduces exactly the silent
mystery-failure mode this decision removes.

## The at-least-once contract's first paid consumer

The gap this doc originally flagged as future work is closed for the one handler
that needed it. `apps/hermes/src/handlers/complete.ts` claims
`telegram:<updateId>` in `llm_dedupe` *before* calling the provider and marks it
completed *after* the reply is sent. Two cases, not equally covered:

- **Exact-duplicate delivery of an already-completed update** — closed
  deterministically. `llm_dedupe.dedupe_key` is a primary key, so uniqueness is a
  Postgres guarantee, not an application check-then-insert race; the replay
  resends the stored reply and makes zero provider calls.
- **A failure between claim and complete** — no longer a double-charge for a
  message update, and never fully closed as exactly-once. The row is left
  `pending`, and `claim()` fail-**opens** on a `pending` row: it returns
  `{status: "claimed"}` again rather than wedging that message permanently — no
  reply, no way to retry — on a message the user is waiting on by construction.
  **What differs is whether anything ever reaches that branch.** For a *message*
  update nothing does: `03-agent-core` Phase 3 detached message dispatch and
  `07-one-paid-turn-one-outcome` moved the ack strictly ahead of it, so by the
  time a crash, a thrown handler, a 403, a partial send or a max-iterations stop
  leaves the row `pending`, the `update_id` is permanently acked, Telegram will
  not redeliver it, and nothing else claims that key — the row is inert and the
  turn is lost, logged and not retried. The one case that *did* reach the branch
  — a `setOffset` that itself failed, replaying a batch whose message handlers
  had already been dispatched, so the replay's `claim()` found handler #1's
  `pending` row and fail-opened into a second paid turn — is closed by that same
  reorder: a failed ack now replays an update whose handler never ran, making the
  replay the first paid turn rather than a second one. The fail-open branch stays
  load-bearing for `callback_query`, which is handled *before* its offset is
  written and therefore really can be replayed after a partial turn; the cost of
  that side is bounded and one-shot, one duplicate completion. The dedupe
  machinery's remaining paid-path job is the deterministic case above:
  exact-duplicate **delivery** of an already-completed update.

Ordering is what makes both work: recording completion *before* the send would
mark a turn done that the user never received, converting a rare double charge
into a silently dropped answer.

**Closing the crash window is a non-task, not a backlog item.** It needs
`llm_dedupe` to tell "in flight" from "crashed mid-flight" — an `attempt` counter
or a finer status, plus a rule for reclaiming a stale `pending` row — buying
exactly-once *completion detection* at the price of the fail-closed mode above.
Don't build it without a real incident.

**Rejected:**

- *Webhooks instead of long polling* — needs public ingress, which the roadmap
  defers to Phase 7. `deleteWebhook()` runs unconditionally at every boot
  instead: a webhook and `getUpdates` are mutually exclusive server-side, so a
  leftover one would silently starve the poller.
- *`telegraf` / `grammy`* — reasonable libraries, but polling, chunking and
  retry are precisely the behaviors this project needs to control, and the two
  endpoints in use don't justify the dependency. (Escape hatch: if the polling
  edge cases bite, `grammy` is the fallback.)
- *Horizontally scaling the poller* — impossible by protocol, not by
  implementation. Under ROADMAP D4 each agent gets its own bot token instead.
- *Batching offset writes for fewer round-trips* — widens the crash window from
  one update to the whole batch, to save a trivial UPDATE.

**Constraints it creates:**

- **Every `callback_query` handler must tolerate being invoked twice for the
  same update.** A callback is handled *before* its offset is written, so a
  failed `setOffset` re-invokes a handler that already ran. **This no longer
  applies to message updates** (`07-one-paid-turn-one-outcome`): a message is
  acked before it is dispatched, so a failed ack replays an update whose handler
  never started, and a successful ack rules out redelivery entirely — a message
  handler is invoked at most once. Echo, `/ping` and `/start` are safe by
  inspection either way (a duplicate reply is visible and harmless). Any handler
  with an external side effect MUST carry its own idempotency key. This decision
  does not solve idempotency generally, only for reply-only handlers.
- **A message handler must also tolerate never being invoked again.** Its
  update's offset is already acked when it starts, so a failure or a crash is
  terminal for that update — nothing retries it. See
  [poller-concurrent-message-dispatch](poller-concurrent-message-dispatch.md).
- **`InboundMessage` carries `updateId`** so a paid handler can derive one.
  Required, not optional: an absent id would collapse every such message to the
  same key and short-circuit unrelated messages with someone else's stored reply.
- `telegram_offset` is a **singleton row** (`id smallint PRIMARY KEY DEFAULT 1`,
  `CHECK (id = 1)`, seeded to 0 by the migration). One token, one poll stream —
  there is no per-chat concept to key on, and the seed row means there is no
  "not yet initialized" state to handle in the repo.
- The advisory lock must be released **after** the drain and **before**
  `pool.end()` — see `architecture.md` for why each neighbour in that sequence
  matters.
- The client-side abort timeout must exceed the poll `timeout`
  (`timeout * 1000 + 10_000`). Setting it at or below the poll timeout aborts
  connections Telegram is legitimately holding open, producing a reconnect
  storm that looks like network flakiness.
- Retries reuse the same request body, so a retried `getUpdates` automatically
  reuses the same offset. Mutating the offset inside the retry path would ack
  updates that were never delivered.
