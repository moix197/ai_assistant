# @hermes/store

Postgres pool and migration runner. Raw `pg`, no ORM.

- `createPool(databaseUrl)` — a `pg.Pool`.
- `waitForDatabase(pool, { retries, delayMs })` — retries `SELECT 1` before
  boot proceeds; compose's `depends_on: condition: service_healthy` only
  gates container start order, not connection readiness.
- `runMigrations(pool, migrationsDir)` — creates a `schema_migrations`
  tracking table if missing, applies every `NNN_*.sql` file in
  `migrationsDir` not already recorded, in filename order, each inside its
  own transaction. A failing migration rolls back and is **not** recorded as
  applied; no later migration runs. Re-running is a no-op once everything is
  applied.
- `getDefaultMigrationsDir()` — resolves `<this package>/src/migrations`
  regardless of whether the calling code is running from source (`tsx`) or
  from the built `dist/` bundle.
- `bin/migrate.ts` (built to `dist/migrate-cli.js`, exposed as the
  `hermes-migrate` bin) — a standalone CLI that calls the exact same
  `runMigrations` function as `apps/hermes`'s boot path, reading
  `DATABASE_URL` directly from the environment.

## Telegram offset persistence

`src/migrations/001_telegram_offset.sql` creates `telegram_offset`, a
**singleton row** (`id smallint primary key default 1, update_id bigint not
null default 0, check (id = 1)`), seeded with `update_id = 0` by the
migration itself. It's a singleton, not a per-chat table, because there is
only ever one bot token and one `getUpdates` poll stream — nothing to key a
per-chat row on.

- `getOffset(pool)` — reads the persisted `update_id`. Always finds a row;
  the migration guarantees it exists.
- `setOffset(pool, updateId)` — overwrites it.

`packages/channels/src/telegram/poller.ts` is the only caller: it loads the
offset once at start and persists the next value only *after* an update has
been fully handled — never before, and never batched. See
`packages/channels/README.md` for why that ordering is load-bearing.

## Single-instance advisory lock

`src/advisory-lock.ts` exports `INSTANCE_LOCK_KEY` (a fixed, arbitrary
constant) and `acquireInstanceLock(lockKey, databaseUrl)`. Telegram allows
exactly one `getUpdates` consumer per bot token, so Hermes enforces
single-instance-per-database via a Postgres session-level advisory lock,
taken on a **dedicated `pg.Client` opened outside the shared pool** — a
pooled connection could be recycled or handed to unrelated queries, silently
dropping the lock. `apps/hermes/src/boot.ts` calls this before starting the
poller and exits `1` with a readable message
(`"another Hermes instance is already running against this database"`) if
the lock is already held, instead of Telegram's ambiguous 409.

`acquireInstanceLock` returns `{ acquired, release }`. `release()` explicitly
calls `pg_advisory_unlock` then closes the dedicated client; `apps/hermes/src/boot.ts`'s
ordered shutdown sequence calls it as one step. Any process exit still frees
the lock implicitly regardless — Postgres releases session-level locks when
their connection closes, crash or not.

`src/migrations/` holds, in apply order, `001_telegram_offset.sql`,
`002_llm_usage.sql`, `003_llm_dedupe.sql`, `004_telemetry_events.sql`,
`005_telemetry_event_total_cost.sql`, `006_threads.sql`. A new migration is
numbered one past whatever is actually highest in the directory — re-list it
rather than trusting an assumed number.

## LLM usage accounting

`src/migrations/002_llm_usage.sql` creates `llm_usage` (`id bigserial pk,
created_at timestamptz not null default now(), provider text not null, model
text not null, input_tokens int not null, output_tokens int not null,
cache_hit_tokens int not null, cost_usd numeric(12,6) not null`), plus an
index on `created_at` for the `sumCostSince` access pattern below. One row
per completed LLM call.

`cache_hit_tokens` is its own column, **never folded into `input_tokens`**:
`input_tokens` holds only the "miss" portion of the prompt (tokens *not*
served from the provider's prefix cache), so the two columns are additive —
`input_tokens + cache_hit_tokens` recovers the provider's raw prompt token
count. Keeping them separate is what lets `@hermes/llm`'s `resolveCostUsd`
(see `packages/llm/README.md`) price cache hits at their own, steeply
discounted rate instead of the full input rate, and what makes a `psql`
inspection of the table immediately show whether a given call actually hit
the cache.

- `recordUsage(pool, entry)` — inserts one row. `entry` is
  `{ provider, model, inputTokens, outputTokens, cacheHitTokens, costUsd }`.
  Called from `@hermes/llm`'s OpenAI-compatible adapter, on its success path
  only, via the `LlmUsageRepo` port (`packages/llm/src/usage/usage-repo-port.ts`)
  — `apps/hermes/src/llm/build-llm-provider.ts` wires this function into that port so `llm`
  never depends on `@hermes/store` directly.
- `sumCostSince(pool, sinceUtc)` — sums `cost_usd` for every row recorded at
  or after `sinceUtc`. It has **two** callers, deliberately: the budget
  ceiling (through `@hermes/llm`'s `BudgetUsageRepo`) and `/stats`' spend
  lines (through `@hermes/telemetry`'s `StatsRepo`), both bound in
  `apps/hermes`. One function feeding both is what stops `/stats` from ever
  disagreeing with the ceiling it reports against — `/stats` never derives
  spend from `telemetry_events`. See
  `.ai/decisions/telemetry-event-schema.md`.

`cost_usd` is `numeric(12,6)`, so a call costing less than $0.0000005 rounds
to zero and one costing $0.0000015 rounds to $0.000002. This bounds the
budget ceiling's accuracy, so it is worth stating rather than discovering: a
single call would have to be about one token to floor away entirely — real
completions land near $0.0001 — and because the rounding goes to nearest
rather than down, errors cancel across rows instead of drifting one way. At
half a microdollar per row, ten thousand calls sit within a cent of truth,
against a ceiling denominated in dollars. Widening the column would trade a
migration for precision nothing currently needs; revisit it if per-token or
sub-cent accounting ever becomes the point.

## LLM dedupe

`src/migrations/003_llm_dedupe.sql` creates `llm_dedupe` (`dedupe_key text
primary key, status text not null default 'pending', result_text text,
created_at timestamptz not null default now(), completed_at timestamptz`).
One row per dedupe key the completion handler has claimed
(`apps/hermes/src/handlers/complete.ts`), keyed on `telegram:<update_id>` —
see `packages/channels/README.md`'s `InboundMessage.updateId`.

- `claim(pool, dedupeKey)` — `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING`. The primary key on `dedupe_key` is what makes the uniqueness a
  Postgres guarantee, not an application check-then-insert race: two
  concurrent claims for the same key can only ever have one INSERT winner.
  Three possible results:
  - the INSERT wins -> `{status: "claimed"}` (first call for this key)
  - the row is `completed` -> `{status: "completed", resultText}`, the
    stored reply from the original call — the handler replies with this
    directly and never calls the provider again
  - the row is still `pending` -> `{status: "claimed"}` **again** — see
    "Claim-to-complete crash window" below
- `complete(pool, dedupeKey, resultText)` — marks the row `completed` and
  stores `resultText`, called by the handler strictly *after* the reply is
  sent, never before.

### Claim-to-complete crash window — an accepted, fail-open residual risk

There is a real window between `claim()` returning `{status: "claimed"}` and
the later `complete()` call landing: a crash anywhere in that window
(mid-provider-call, mid-reply-send, or between reply-send and the
`complete()` write) leaves the row `pending`. On restart, Telegram redelivers
the same `update_id`, `claim()` sees `pending`, and returns
`{status: "claimed"}` again — **the retry proceeds and may issue a second
real paid call.**

This is deliberately **fail-open (retry), not fail-closed (permanently
block)**: a chat assistant that permanently wedges a user's message because
of a bounded, rare crash-timing race is a worse outcome than a bounded, rare,
low-dollar double-charge (single-shot completion, capped by
`MAX_TOKENS_PER_TURN` and the monthly budget ceiling either way) — a dropped
message has no recovery path from the user's side, while a duplicate reply
is at worst annoying and self-evidently visible.

This is **narrower and fundamentally different** from the exact-duplicate-
delivery case (an identical `update_id` redelivered *after* `complete()` has
already landed), which the `UNIQUE`/primary-key constraint on `dedupe_key`
closes **deterministically** — that case can never produce a second provider
call, proved by `apps/hermes/src/handlers/__tests__/complete-dedupe.test.ts`.
The crash-window case is proved *not to permanently block* (not proved to
fully prevent a duplicate call) by
`apps/hermes/src/handlers/__tests__/complete-dedupe-crash-window.test.ts`.

What would close this gap later, as a forward-looking non-task, not built
here: a finer-grained schema — e.g. an `attempt` counter or a richer status
enum (`pending` -> `provider_called` -> `completed`) — letting a resumed
process distinguish "claimed but the provider was never called" from "the
provider call was actually issued and may have succeeded" before deciding to
retry, enabling true exactly-once completion detection instead of today's
at-most-one-retry-on-crash behavior. This mirrors how `telegram_offset`'s
at-least-once contract (above) is documented as an accepted gap rather than
hidden.

## Telemetry events

`src/migrations/004_telemetry_events.sql` creates `telemetry_events`
(`id bigserial pk, created_at timestamptz not null default now(), name text
not null, thread_id text, turn_id text, tool_name text, duration_ms int,
cost_usd numeric(12,6), is_error boolean not null default false, fields
jsonb not null default '{}'::jsonb`), with indexes on `(created_at)`,
`(name, created_at)`, and a **partial** index on `(tool_name) WHERE tool_name
IS NOT NULL` — `tool_name` is null on every non-`tool.call` row, so a full
index would be mostly nulls. One row per `@hermes/core` `TelemetryEvent`
(`llm.call` / `tool.call` / `turn`).

The columns every rollup query filters or aggregates on directly —
`name`, `thread_id`, `turn_id`, `tool_name`, `duration_ms`, `cost_usd`,
`is_error` — are real columns; everything event-specific (e.g. `llm.call`'s
`model`/`inputTokens`/`outputTokens`/`cacheHitTokens`) lives in `fields`
jsonb instead. This is the wide-table shape the schema is named for: it lets
Postgres do the rollup math as a plain aggregate query, not an
application-side scan of a blob column.

- `insertEvents(pool, events)` — one multi-row `INSERT` per call, never a
  loop of single-row inserts. No-op (issues no query) on an empty array —
  the common case for a periodic flush firing on an empty buffer, not the
  exception. Called from `packages/telemetry`'s buffered recorder via the
  `TelemetryEventRepo` port, the same injection shape `LlmUsageRepo` and
  `BudgetUsageRepo` use.
- `getLlmCallStatsSince(pool, sinceUtc)` → `LlmCallStats`
  (`{ calls, errorCalls, inputTokens, outputTokens, cacheHitTokens }`) — one
  aggregate over `name = 'llm.call'` rows, token sums pulled out of `fields`
  and cast to numeric. It deliberately carries **no cost or dollar field**;
  see `sumCostSince` above and the decision doc.
- `getTopToolsSince(pool, sinceUtc, limit)` → `TopToolCount[]` — groups
  `name = 'tool.call'` rows by `tool_name`, most-called first. Returns `[]`
  (not an error, not `null`) today, since no producer exists until
  `packages/agent` (2c); it needs no change here when one lands.

`src/migrations/005_telemetry_event_total_cost.sql` adds `total_cost_usd
numeric(12,6)` (03-agent-core Phase 1, settled decision 1). A `turn` row
writes its total there and leaves `cost_usd` NULL; `llm.call`/`tool.call`
rows are unaffected and leave `total_cost_usd` NULL. This is the fix for the
double-count `02-telemetry` deferred: `cost_usd` now means exactly one thing
everywhere in this table — the cost of a single `llm.call` — so a plain
`SUM(cost_usd)` across all event kinds can never double-count a turn's calls
against the turn's own total.

**No retention or pruning policy exists for this table.** It grows
unbounded from this migration onward — an explicit, accepted open item, not
solved here. See `.ai/decisions/telemetry-event-schema.md`.

## Threads

`src/migrations/006_threads.sql` creates `threads` (`id uuid pk default
gen_random_uuid(), channel text not null, chat_id text not null, messages
jsonb not null default '[]'::jsonb, created_at timestamptz not null default
now(), updated_at timestamptz not null default now(), unique (channel,
chat_id)`), plus an explicitly named index on `(channel, chat_id)` — the
unique constraint already covers the lookup, but naming it matches
`telemetry_events`' explicit-index convention. One row per `(channel,
chat_id)`: the full, untrimmed conversation history a chat has with the bot,
restart-safe. `packages/agent`'s chars/4 trim (03-agent-core) only ever
affects what is sent to the model on a given call, never what is stored here.
No size cap or archival policy yet — the same unbounded-growth posture as
`telemetry_events` above, an explicit open item.

- `getOrCreateThread(pool, channel, chatId)` — `INSERT ... ON CONFLICT
  (channel, chat_id) DO NOTHING RETURNING *`, then a `SELECT` on conflict —
  the same shape `llm-dedupe-repo.ts`'s `claim` uses, the only existing
  upsert idiom in this package. Returns `{ id, channel, chatId, messages }`;
  a fresh thread starts with `messages: []`.
- `appendMessages(pool, threadId, newMessages)` — `UPDATE threads SET
  messages = messages || $2::jsonb, updated_at = now() WHERE id = $1`,
  appending rather than replacing so a concurrent read never sees a partial
  write.
- `packages/agent` depends on these through its own injected `ThreadRepo`
  port, never on `@hermes/store` directly — the same boundary rule
  `packages/llm` already follows for `LlmUsageRepo`/`BudgetUsageRepo`.
  `apps/hermes/src/store/build-thread-repo.ts` wires this module into that
  port.

## Testing

`src/__tests__/migrate.test.ts` covers `sortMigrationFilenames` as a pure
unit test (always runs). The integration suite in the same file — tracking
table auto-creation, apply-once, no-op re-run, and abort-without-recording on
a failing migration — is gated on `TEST_DATABASE_URL` and is **skipped**
unless that env var is set. To run it locally: point `TEST_DATABASE_URL` at a
dedicated scratch Postgres database — never the app's shared compose DB,
since these tests seed and mutate real tables (e.g.
`postgres://hermes:hermes@127.0.0.1:5432/hermes_test`, using `127.0.0.1`
rather than `localhost` to avoid it resolving to `::1` and yielding
ECONNRESET against the dockerized Postgres) and run
`pnpm test:db` from the repo root.

`pnpm test:db` is the lane that actually proves these tests ran. The `skipIf`
gate above makes a credential-free run indistinguishable from a passing one, so
`test:db` refuses to start when `TEST_DATABASE_URL` is unset rather than exiting
green on zero assertions, and it runs the files serially — they share one
database, and concurrent `runMigrations`/`DELETE` across files is not safe.
`src/__tests__/db-env.ts` resolves the URL, falling back to the repo-root `.env`
when the shell did not export it; it mirrors
`packages/llm/src/__tests__/live/setup.ts` because there is no `vitest.config.ts`
anywhere to load `.env` for us. With that `.env` in place a plain `pnpm test`
runs these tests too; without it they skip, and the default lane still needs no
credentials.

`src/__tests__/telegram-offset-repo.test.ts` and
`src/__tests__/advisory-lock.test.ts` are integration-only, gated the same
way: get/set round-tripping for the offset repo, and lock
acquire/contend/crash-release/re-acquire semantics for the advisory lock.

`src/__tests__/llm-usage-repo.test.ts` is integration-only, gated the same
way: the migration applies cleanly, a recorded row round-trips with
`cache_hit_tokens` distinct from `input_tokens`, and `sumCostSince` sums
correctly across multiple rows and excludes rows recorded before the given
time.

`src/__tests__/llm-dedupe-repo.test.ts` is integration-only, gated the same
way: a first `claim` returns `claimed`; a second `claim` on the same
still-`pending` key also returns `claimed` (the documented retry case);
after `complete()`, a further `claim` returns `completed` with the stored
`resultText`; and a raw duplicate `INSERT` on the same `dedupe_key`
(bypassing `claim`'s `ON CONFLICT`) is rejected by the primary-key constraint
itself, proving the uniqueness is DB-enforced, not application-only.

`src/__tests__/telemetry-event-repo.test.ts` is integration-only, gated the
same way: the migration applies cleanly; `insertEvents` with a mixed batch
(`llm.call` success, `llm.call` with `error`, and one of each other event
kind) writes the right number of rows in one round trip, with
`tool_name`/`cost_usd`/`is_error` populated correctly per kind and the rest
recoverable from `fields`; an empty array performs no query.

`src/__tests__/telemetry-stats-repo.test.ts` is integration-only, gated the
same way: `getLlmCallStatsSince` sums and counts across a mix of success and
error `llm.call` rows and **excludes** `tool.call`/`turn` rows and rows
outside the window; `getTopToolsSince` groups and orders by `tool_name`,
honors its `limit`, and returns `[]` when no `tool.call` rows exist.

`src/__tests__/llm-usage-repo-month-boundary.test.ts` is integration-only,
gated the same way: it pins `sumCostSince`'s UTC calendar-month window against
rows placed either side of the boundary — the arithmetic the budget ceiling
and `/stats` both depend on.

`src/__tests__/thread-repo.test.ts` is integration-only, gated the same way:
`getOrCreateThread` is idempotent for the same `(channel, chatId)` (a second
call returns the same row, never a duplicate) and different `chatId`s under
the same channel get distinct threads; a fresh thread starts with `messages:
[]`; `appendMessages` appends across two calls without clobbering earlier
entries and bumps `updated_at`.

The guard and URL resolution in `src/__tests__/db-env.ts` are published to
other packages through this package's `./testing` subpath export, so
`apps/hermes`' and `@hermes/telemetry`'s DB suites reuse the one guard instead
of re-resolving `TEST_DATABASE_URL` privately — a suite that re-resolves it
opts out of both safety checks.
