# Architecture

The high-level shape of the system: package boundaries, how data flows, and the
rules that keep dependencies pointing one direction. Capture the *structure and
its rationale* — not API-level detail the code already documents.

## System shape

pnpm workspace, one package per concern, each created in the phase where it
first appears (ROADMAP §3 / D3 — see
[d3-monorepo-package-per-concern](decisions/d3-monorepo-package-per-concern.md)).
What exists today:

```
apps/hermes        wiring + boot + shutdown, no logic
packages/core      Result, ids, Clock, logger, TelemetryEvent union + recorder PORT
packages/config    zod env schema, fail-fast, redaction
packages/store     pg pool, migration runner, repos, advisory lock
packages/channels  Channel port + telegram/ adapter
packages/llm       LlmProvider port + OpenAI-compatible adapter over fetch
packages/telemetry buffered recorder behind core's port + /stats rollup math
```

Monorepo ≠ one deployable. The build must stay able to emit a lean per-app
image (`pnpm deploy --filter`), which is what makes "one agent per VM" possible
later — see [lean-docker-build](decisions/lean-docker-build.md).

## Dependency direction

Strictly downward; no package imports one above it.

```
                        apps/hermes
                             │  (imports all six; the ONLY place they are wired together)
     ┌───────────┬───────────┼───────────┬───────────┬──────────┐
     ▼           ▼           ▼           ▼           ▼          ▼
  config       store     channels       llm      telemetry     core
     │           │       (only dep)  (only dep)  (only dep)
     └───────────┴───────────┴───────────┴───────────┴──────────► core
```

- `packages/core` depends on nothing. It is where ports live so lower packages
  can be depended on without depending on their implementations.
- **`packages/channels` must not depend on `packages/store`.** It needs a
  persisted poll offset, but takes an injected `TelegramOffsetRepo` port
  (`{ getOffset, setOffset }`) instead of importing Postgres. `boot.ts` binds it
  to `@hermes/store`'s `getOffset`/`setOffset`. This keeps the channel adapter
  free of a database, testable with a two-method mock, and reusable by a future
  Slack/WhatsApp adapter with a different persistence story. Reversing this and
  importing `@hermes/store` from `channels` is the easiest boundary in the tree
  to break by accident.
- **`packages/llm` depends on `packages/core` only** — never `@hermes/config`
  or `@hermes/store`, both of which it has a standing temptation to import:
  - *config* — env shape is boot's concern.
    `apps/hermes/src/llm/build-provider-profiles.ts` is the one place allowed
    to import both `@hermes/config` and `@hermes/llm`, mapping flat env fields
    into the `ProviderProfile` the adapter needs.
  - *store* — the adapter both writes a usage row per call and reads this
    month's spend for the budget ceiling, but through two injected ports:
    `LlmUsageRepo` (`{ recordUsage }`) and `BudgetUsageRepo`
    (`{ sumCostSince }`), same shape as `channels`' `TelegramOffsetRepo`.
    `apps/hermes/src/llm/build-llm-provider.ts` binds both to `@hermes/store`
    against the one pool, and is the only place that also imports
    `@hermes/config` (for the cap). That binding is extracted out of `boot.ts`
    because `boot()` has no testable seam. `usageRepo` and `budget` are
    **required** adapter options — only `logger` still defaults to a no-op —
    so a construction site that forgets either fails to compile instead of
    silently disabling cost recording and the ceiling that reads from it.
  - The row's shape, `LlmUsageEntry`, lives in `@hermes/core` and is
    re-exported by both `llm` and `store`, so neither side can drift a field
    apart without a type error.
- **`packages/telemetry` depends on `packages/core` only at runtime** — never
  `@hermes/store` in shipped code, the same boundary `llm` holds and for the
  same reason. (`@hermes/store` is a devDependency solely for the DB
  integration test, which exercises the injected repo ports against a real
  database.) It
  takes two injected ports: `TelemetryEventRepo` (`{ insertEvents }`) for the
  write side and `StatsRepo`
  (`{ sumCostSince, getLlmCallStatsSince, getTopToolsSince }`) for `/stats`'
  read side. `apps/hermes/src/telemetry/build-telemetry-recorder.ts` and
  `build-stats-repo.ts` bind both to `@hermes/store` against the one pool.
- **`llm` and `telemetry` never import each other**, in either direction. The
  recorder *port* lives in `core`, so `llm`'s adapter emits through
  `opts.recorder?: TelemetryRecorder` and `apps/hermes` is the only place that
  passes the concrete handle in. `StatsRepo.sumCostSince` is re-declared in
  `telemetry` with the same shape as `llm`'s `BudgetUsageRepo.sumCostSince`
  rather than imported; `apps/hermes` wires the *same* `@hermes/store`
  `sumCostSince` into both, which is what makes the cost-source split hold in
  practice and not just in prose — see
  [telemetry-event-schema](decisions/telemetry-event-schema.md).
- Type-level leakage counts too: `pg`'s `Pool` reaches `apps/hermes` only via a
  re-export from `@hermes/store`, so `pg` stays store's declared dependency and
  a missing dep is caught by `pnpm -r typecheck` (which runs before `build`).

## Data flow

Inbound, one update at a time:

```
Telegram getUpdates (long poll, 30s)
   │
   ▼  packages/channels/src/telegram/client.ts   ← retry/backoff, token redaction
   ▼  .../poller.ts  normalizeTelegramUpdate     ← drops updates with no message.from
   │                                                (no user id ⇒ fail-open risk)
   ▼  InboundMessage (provider-neutral; carries updateId — the dedupe key's
   │                   only source, hence required, not optional)
   │
   ▼  apps/hermes  withAllowlist( withPrivateChat( dispatchCommand ) )
   │                    │              │
   │                    │              └─ non-private chat rejected even for an
   │                    │                 allowlisted sender: replying into a
   │                    │                 group broadcasts to everyone in it
   │                    └─ unknown sender rejected before anything else looks at it
   ▼  handler: /ping | /start | /stats | else → completionHandler   ← the fallthrough is
   │                                    │                    PAID from here on
   │                                    ▼  dedupe claim `telegram:<updateId>`
   │                                    │     →  packages/store  →  llm_dedupe
   │                                    │     already completed ⇒ resend the
   │                                    │     stored reply, zero provider calls
   │                                    ▼  packages/llm adapter
   │                                    ▼  budget check: SUM(cost_usd) since the
   │                                    │     1st of this month, UTC (injected
   │                                    │     Clock) → packages/store → llm_usage
   │                                    │     spend >= cap ⇒ BudgetExceededError
   │                                    │     BEFORE any fetch: zero provider
   │                                    │     calls, fixed reply, no new row,
   │                                    │     and no llm.call event either
   │                                    ▼  provider HTTP (retries live in here,
   │                                    │     i.e. inside the already-checked call)
   │                                    ▼  llm_usage row via injected LlmUsageRepo
   │                                    │     →  packages/store  →  llm_usage
   │                                    ▼  llm.call event via injected
   │                                    │     TelemetryRecorder — returns at once,
   │                                    │     the INSERT happens on a later flush
   │                                    │     →  packages/telemetry  →  telemetry_events
   │                                    ▼  result.text
   │                                 channel.send() → chunkText → sendMessage
   │                                    ▼  dedupe complete, storing the reply —
   │                                    │     AFTER the send, never before
   │
   ▼  offsetRepo.setOffset(update_id + 1)  →  packages/store  →  telegram_offset
       ^^ AFTER the handler resolves. Never before. See the polling decision doc.
```

`echo.ts` is still in the tree as a reference/fallback but is no longer wired:
`completionHandler` took its place as `dispatchCommand`'s fallthrough. The
allowlist gate stays outermost precisely because that fallthrough now spends
money — an unknown sender is rejected before it can reach `complete()`. The
usage row is written from the adapter's success path, so a failed call records
nothing and a retried one still records exactly once; see
[llm-cost-accounting](decisions/llm-cost-accounting.md). Up to `MAX_ITERATIONS`
calls to `complete()` per message now — Phase 2's tool-execution loop — all
routed through `packages/agent`'s `runTurn`, which loads the conversation
before the loop starts and appends the user and final assistant messages
after it. History lives in `threads`,
one row per `(channel, chat_id)`, written by `packages/store`'s
`thread-repo.ts` and reached only through an injected `ThreadRepo` port, so
`packages/agent` never imports `@hermes/store` and the dependency direction
holds. Persisting rather than holding history in process is what makes memory
survive a restart — the reason it is a table and not a `Map`.

The `llm.call` event that rides alongside that write is deliberately **not** the
same shape of guarantee, and the three differences are the whole point of
keeping them separate paths. It fires on provider *failure* as well as success
(`llm_usage` records nothing on a failure — no tokens were billed), it never
fires on a budget rejection (no call was attempted, so `/stats`' error rate
cannot conflate a policy stop with a call failure), and it is buffered and
at-most-once rather than written inside `complete()`'s await chain — a slow or
down Postgres degrades telemetry fidelity instead of delaying or failing a
user's reply. `llm_usage` is a ledger, `telemetry_events` is an instrument; see
[telemetry-event-schema](decisions/telemetry-event-schema.md).

Both gates on that path — the dedupe claim and the budget check — are only
worth anything *before* `complete()`; run either after the call and it records
the spend it existed to prevent. The two failure shapes are deliberately
opposite: a breached ceiling **blocks** (fail closed, the operator asked it to
stop), while a `pending` dedupe row **retries** (fail open, because a wedged
message is worse than one bounded duplicate charge) — see
[telegram-long-polling-correctness](decisions/telegram-long-polling-correctness.md).

`llm_usage` is therefore read and written on the same path: the ceiling's
read is what the previous calls' writes fed. That makes anything which
suppresses a write (an unpriced model, a dropped insert) also loosen the
ceiling — see [monthly-budget-ceiling](decisions/monthly-budget-ceiling.md)
for why the check sits before `fetch` and why it bounds spend to within one
call's cost of the cap rather than stopping exactly at it.

The offset write is the last step of handling an update, and a handler throwing
aborts the rest of the batch so no later update's offset can leapfrog the one
that failed.

## Boot and shutdown order

Both orders are load-bearing; each step is a precondition for the next.

**Boot** (`apps/hermes/src/boot.ts`): config → `assertModelsPriced` → logger →
pool → `waitForDatabase` → migrations → `deleteWebhook()` → **advisory lock** →
health server → poller → telemetry recorder + handlers → shutdown registration.

- `assertModelsPriced` runs on `LLM_PRIMARY_MODEL` and (when set)
  `LLM_FALLBACK_MODEL` immediately after config loads, before any DB or network
  I/O — the cheapest step is also the one that must fail first. It is the
  primary defense that keeps `resolveCostUsd`'s `UnpricedModelError` a rare
  backstop rather than a live-call hazard; see
  [llm-cost-accounting](decisions/llm-cost-accounting.md).
- The telemetry recorder is built *after* the pool (it writes through it) and
  handed to two places at once: the handler wiring, which passes it into the LLM
  adapter, and `registerShutdown`, where it is a **required** dep. Required, not
  optional-with-a-default, because this project has twice shipped a fully tested
  mechanism that the real construction site silently never received.
- `deleteWebhook` is unconditional and idempotent: a webhook and `getUpdates`
  are mutually exclusive on Telegram's side, so a leftover webhook from another
  deployment mode would silently starve the poller.
- The lock is taken **before** the health server starts, so an instance that
  loses the race never briefly reports healthy.
- Losing the lock sets `process.exitCode = 1` and awaits `pool.end()` rather
  than calling `process.exit(1)` — `process.exit` truncates async stdout piped
  to Docker and can drop the very error line the operator needs. The same
  pattern guards the fatal-poller-error path.
- **Known gap:** migrations run *before* the lock is taken, so two simultaneous
  cold boots race to a duplicate-table error instead of the readable
  single-instance message. Accepted, not fixed.

**Shutdown** (SIGTERM/SIGINT, registered once): `controller.abort()` →
`channel.stop()` (bounded 5s) → `telemetryRecorder.stop()` (bounded 1s) →
`lock.release()` → `pool.end()` → `process.exit(0)`, with an 8s hard-exit timer.

- Release before the drain finishes and a restart-racing instance can acquire
  the lock while this one is still querying. Close the pool before the drain
  finishes and an in-flight query crashes. Hence this exact order.
- The telemetry flush sits *after* the drain so it captures events from work
  that was still in flight, and *before* `pool.end()` so its own `INSERT` has a
  live pool to write through. Those two constraints leave it exactly one slot.
- It gets its own deliberately small budget (`TELEMETRY_FLUSH_TIMEOUT_MS`, 1s)
  via the same `withTimeout` helper the drain uses, not a second timeout
  mechanism. `packages/telemetry`'s own `stop()` has no internal timeout — it
  has no concept of the process's shutdown budget, so bounding it is the call
  site's job. 5s of drain + 1s of flush still leaves room under the 8s
  hard-exit ceiling for `lock.release()`/`pool.end()`; a hung flush degrades to
  "lose the unflushed buffer," never to "hang shutdown," which is the
  at-most-once tradeoff telemetry already accepts everywhere else.
- `controller.abort()`'s signal is threaded into the poller's in-flight
  `getUpdates` call (`packages/channels/src/telegram/{client,poller}.ts`), so
  `channel.stop()`'s drain resolves as soon as abort fires on an idle bot
  instead of always burning the full 5s bound.
- 5s / 1s / 8s are sized against `docker-compose.yml`'s explicit
  `stop_grace_period: 15s` for the `hermes` service — revisit all four
  together if any one of them changes.
- The hard-exit timer is deliberately *not* cleared in a `finally`: a rejected
  shutdown (`release()`/`pool.end()` throwing because the DB is already down) is
  the exact case the guard exists for, so it must survive the failure path.

## Verifying a change against the running bot

Two traps make a manual check silently prove nothing. Both were hit during
01-llm-port Phase 4.

- **`.env` is per-directory and gitignored.** A worktree gets its own `.env`
  that does not track the repo root's, and `docker compose` interpolates the
  one in the directory it runs from. Editing the wrong copy changes nothing
  the bot reads, with no warning either way.
- **`docker compose restart` re-reads neither `.env` nor rebuilt code.** The
  `hermes` service is `build: .`, so a restart replays the existing image with
  its already-resolved environment. `docker compose up -d --build` is the only
  command that makes a manual verification of new behavior meaningful — a
  container built before the feature existed will happily reproduce the old
  behavior and read as a failed change.

Verifying spend behavior additionally means querying `llm_usage` in the *app*
database, which is the same table the DB test lane must never touch — see
[test-database-isolation](decisions/test-database-isolation.md).
