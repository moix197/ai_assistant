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
packages/core      Result, ids, Clock, logger, telemetry recorder PORT
packages/config    zod env schema, fail-fast, redaction
packages/store     pg pool, migration runner, repos, advisory lock
packages/channels  Channel port + telegram/ adapter
packages/llm       LlmProvider port + OpenAI-compatible adapter over fetch
```

Monorepo ≠ one deployable. The build must stay able to emit a lean per-app
image (`pnpm deploy --filter`), which is what makes "one agent per VM" possible
later — see [lean-docker-build](decisions/lean-docker-build.md).

## Dependency direction

Strictly downward; no package imports one above it.

```
                apps/hermes
                     │  (imports all five; the ONLY place they are wired together)
     ┌───────────┬───┴───────┬──────────────┬──────────────┐
     ▼           ▼           ▼              ▼              ▼
  config       store     channels          llm            core
     │           │       (only dep)     (only dep)
     └───────────┴──────────────┴──────────────┴───────────► core
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
- **Nothing imports an implementation of `telemetry`.** The recorder port sits
  in `core`; `apps/hermes` will inject the implementation at boot (Phase 2).
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
   ▼  InboundMessage (provider-neutral)
   │
   ▼  apps/hermes  withAllowlist( withPrivateChat( dispatchCommand ) )
   │                    │              │
   │                    │              └─ non-private chat rejected even for an
   │                    │                 allowlisted sender: replying into a
   │                    │                 group broadcasts to everyone in it
   │                    └─ unknown sender rejected before anything else looks at it
   ▼  handler: /ping | /start | else → completionHandler   ← the fallthrough is
   │                                    │                    PAID from here on
   │                                    ▼  packages/llm adapter
   │                                    ▼  budget check: SUM(cost_usd) since the
   │                                    │     1st of this month, UTC (injected
   │                                    │     Clock) → packages/store → llm_usage
   │                                    │     spend >= cap ⇒ BudgetExceededError
   │                                    │     BEFORE any fetch: zero provider
   │                                    │     calls, fixed reply, no new row
   │                                    ▼  provider HTTP (retries live in here,
   │                                    │     i.e. inside the already-checked call)
   │                                    ▼  llm_usage row via injected LlmUsageRepo
   │                                    │     →  packages/store  →  llm_usage
   │                                    ▼  result.text
   │                                 channel.send() → chunkText → sendMessage
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
[llm-cost-accounting](decisions/llm-cost-accounting.md). One `complete()` per
message: no tool loop, no history persistence yet — that's `packages/agent`.

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

**Boot** (`apps/hermes/src/boot.ts`): config → logger → pool → `waitForDatabase`
→ migrations → `deleteWebhook()` → **advisory lock** → health server → poller.

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

**Shutdown** (SIGTERM/SIGINT, registered once): `channel.stop()` (bounded 5s) →
`lock.release()` → `pool.end()` → `process.exit(0)`, with an 8s hard-exit timer.

- Release before the drain finishes and a restart-racing instance can acquire
  the lock while this one is still querying. Close the pool before the drain
  finishes and an in-flight query crashes. Hence this exact order.
- 5s / 8s are sized against Docker's **10s default stop grace period** — revisit
  both if that grace period ever changes.
- The hard-exit timer is deliberately *not* cleared in a `finally`: a rejected
  shutdown (`release()`/`pool.end()` throwing because the DB is already down) is
  the exact case the guard exists for, so it must survive the failure path.
