# Telegram long-polling correctness: at-least-once, offset-after-handling, single instance

The highest-value entry in this knowledge base. Every rule below is
non-obvious, silently breakable, and expensive to rediscover — two of them fail
in ways that produce *no error at all*.

**Decision:**

1. The poll offset is persisted **after** an update is fully handled, per
   update, never before and never batched.
2. Exactly one Hermes process may poll a given bot token, enforced at boot by a
   Postgres session advisory lock on a dedicated connection.
3. Handlers must be idempotent, because a crash replays one update.

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
argument. `handleUpdate` in `packages/channels/src/telegram/poller.ts` therefore
ends with `setOffset(update_id + 1)`, and a throwing handler aborts the rest of
the batch — continuing would advance a later update's offset past the one that
just failed, re-creating the loss it was avoiding.

**This ordering is not observable from unit tests alone.** Phase 2's mutation
testing established that while the offset lived in memory, moving the write
before `await handler(...)` was externally undetectable: the offset was
closure-private and only read by the next `getUpdates`, which is sequenced after
the await either way. Persistence is what turns it into a real crash window.
It is now guarded by two tests that must both survive any refactor —
`poller-offset-ordering.test.ts` (asserts `setOffset` resolves after the
handler) and `poller-crash-replay.test.ts` (proves the replay actually happens).
Crash-replay alone is **not** a sufficient guard: its instance-1 `setOffset`
always rejects, so a reordered write would still pass it.

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

- **Every handler must tolerate being invoked twice for the same update.** Echo,
  `/ping` and `/start` are safe by inspection (a duplicate reply is visible and
  harmless). Any future handler with an external side effect — `log_trade`,
  `send_draft` — MUST carry its own idempotency key. This decision does not
  solve idempotency generally, only for reply-only handlers.
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
