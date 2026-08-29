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
- `bin/sheets.ts` (built to `dist/sheets-cli.js`, exposed as the
  `hermes-sheets` bin) — the operator CLI for `sheet_registry`, reading
  `DATABASE_URL` directly from the environment the same self-contained way
  `bin/migrate.ts` does. See "Sheet registry" below.

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

The dedicated client carries an `'error'` listener, so a lock connection that
dies mid-run logs `"instance lock connection lost, exiting"` and exits `1`
instead of surfacing as an uncaught exception. Fail-closed on purpose:
Postgres frees a session-level lock the instant its connection drops, so
continuing to run would be exactly the two-instances state the lock exists to
prevent — single-flight token refresh depends on it (see
[google-token-refresh](../../.ai/decisions/google-token-refresh.md)).
`acquireInstanceLock`'s optional third argument overrides that handler and
exists only so a test can observe it without exiting the runner.

`acquireInstanceLock` returns `{ acquired, release }`. `release()` explicitly
calls `pg_advisory_unlock` then closes the dedicated client; `apps/hermes/src/boot.ts`'s
ordered shutdown sequence calls it as one step. Any process exit still frees
the lock implicitly regardless — Postgres releases session-level locks when
their connection closes, crash or not.

`src/migrations/` holds, in apply order, `001_telegram_offset.sql`,
`002_llm_usage.sql`, `003_llm_dedupe.sql`, `004_telemetry_events.sql`,
`005_telemetry_event_total_cost.sql`, `006_threads.sql`,
`007_google_accounts.sql`, `008_sheet_registry.sql`,
`009_sheet_write_log.sql`. A new migration is numbered one past whatever is
actually highest in the directory — re-list it rather than trusting an
assumed number.

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
  `name = 'tool.call'` rows by `tool_name`, most-called first. `[]` means "no
  tool calls in the window" now, not "no producer exists" — `packages/agent`'s
  tool loop (`finishToolCall` in `src/loop.ts`, 03-agent-core Phase 2) emits a
  `tool.call` event for every tool invocation alongside `runTurn`'s `turn`
  rows, so this needed no change here when that producer landed.

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
  a fresh thread starts with `messages: []`. `row.messages` is runtime-
  validated against `@hermes/core`'s `messagesArraySchema` before it becomes
  `Thread.messages` — see "Row validation" below; a hand-corrupted row (e.g.
  a manual `psql` edit that breaks the `Message` shape) throws instead of
  silently returning cast garbage that `packages/agent`'s `trimHistory`/
  `converse` would otherwise replay to the provider as if well-typed.
- `appendMessages(pool, threadId, newMessages)` — `UPDATE threads SET
  messages = messages || $2::jsonb, updated_at = now() WHERE id = $1`,
  appending rather than replacing so a concurrent read never sees a partial
  write.
- `packages/agent` depends on these through its own injected `ThreadRepo`
  port, never on `@hermes/store` directly — the same boundary rule
  `packages/llm` already follows for `LlmUsageRepo`/`BudgetUsageRepo`.
  `apps/hermes/src/store/build-thread-repo.ts` wires this module into that
  port.

## Google accounts

`src/migrations/007_google_accounts.sql` creates `google_accounts` (`channel
text not null, channel_user_id text not null, chat_id text not null,
google_email text not null, scopes text[] not null, token_envelope jsonb not
null, expires_at timestamptz not null, created_at timestamptz not null
default now(), updated_at timestamptz not null default now(), primary key
(channel, channel_user_id)`), plus an explicit index on `expires_at` for
Phase 4's `listAccountsExpiringBefore` sweep query. One row per connected
Google identity, keyed by `(channel, channel_user_id)` — the same identity
the Telegram allowlist already gates on. `chat_id` is captured at connect
time, not derived at alert time, so a background sweep with no active thread
in memory can still reach the right chat.

`token_envelope` is **opaque to this package** — a `{ v, iv, tag, ct }` blob
from `@hermes/google-auth`'s AES-256-GCM `sealToken`/`openToken`. This
package persists and reads it back byte-for-byte and never decrypts it;
`TOKEN_ENCRYPTION_KEY` never enters `packages/store`'s config surface.

- `getAccount(pool, channel, channelUserId)` — a plain `SELECT`, returning
  `undefined` when no row matches.
- `upsertAccount(pool, account)` — `INSERT ... ON CONFLICT (channel,
  channel_user_id) DO UPDATE`. **The first `DO UPDATE` in this package**, a
  deliberate exception to the `DO NOTHING`-only precedent `thread-repo.ts`/
  `llm-dedupe-repo.ts` set: reconnecting the same identity must overwrite the
  old token, chat id, scopes, and expiry — not silently keep the stale row.
- `updateRefreshedTokens(pool, account)` — UPDATE-only, deliberately *not* an
  upsert: the refresh sweep's write. It sets `token_envelope`/`expires_at`/
  `updated_at` and nothing else, so a `/disconnect` that landed while the
  refresh HTTP call was in flight is not undone by re-creating the row, and a
  `/connect` that landed mid-tick keeps its freshly granted `scopes`/`chat_id`
  instead of the sweep's stale snapshot's. A missing row is a no-op.
- `deleteAccount(pool, channel, channelUserId)` — removes the row (Phase 3's
  `/disconnect`, and Phase 4's disconnect-on-refresh-failure path).
- `packages/google-auth`'s `GoogleAccountRepo` port is what `packages/agent`
  and future Google-backed tools depend on, never `@hermes/store` directly —
  `apps/hermes/src/store/build-google-account-repo.ts` binds these three
  functions to that port.

Row reads go through the same `parseValidatedJson` helper `thread-repo.ts`
uses, validated against `@hermes/core`'s schema-first `googleAccountSchema`
— one generic helper, two schema-first types both declared in `@hermes/core`
and re-exported here, no second hand-mirrored copy in this package. The row
shape lives in `core` rather than in `@hermes/google-auth` for the same
reason `LlmUsageEntry` does: this package and `google-auth` are siblings, so
neither may import the other.

## Sheet registry

`src/migrations/008_sheet_registry.sql` creates `sheet_registry` (`slug text
primary key, spreadsheet_id text not null, description text not null default
'', access text not null default 'read' check (access in ('read',
'readwrite')), value_input_option text not null default 'USER_ENTERED' check
(value_input_option in ('RAW', 'USER_ENTERED')), created_at timestamptz not
null default now(), updated_at timestamptz not null default now()`). One row
per operator-registered spreadsheet, keyed by `slug` alone — unlike
`google_accounts`, this is operator-level configuration shared across every
connected identity in this single-tenant deployment, not per-user data. See
`.ai/patterns/db-backed-tool-config.md` for the general shape this table is
the first instance of.

- `getSheetRegistryEntryBySlug(pool, slug)` — a plain `SELECT`, returning
  `undefined` when no row matches.
- `listSheetRegistryEntries(pool)` — all rows, ordered by `slug`; `[]` on an
  empty table.
- `upsertSheetRegistryEntry(pool, entry)` — `INSERT ... ON CONFLICT (slug) DO
  UPDATE`. **The second `DO UPDATE` exception in this package** (after
  `upsertAccount`): re-registering a slug must overwrite every field, not
  silently keep stale config. `entry.description`/`access`/`valueInputOption`
  are optional; when omitted, the generated SQL passes the literal `DEFAULT`
  keyword for that column instead of a bound parameter, so the migration's own
  `DEFAULT` is what resolves the value — not a JS-side fallback that could
  drift out of sync with the schema. This holds on both a fresh insert and a
  re-registration: omitting a field on a re-registration resets it to the
  migration default, it does not preserve the prior value.
- `removeSheetRegistryEntry(pool, slug)` — deletes the row; a missing slug is
  a no-op, the same idempotent-removal posture `/disconnect` uses.

Row reads validate against `@hermes/core`'s schema-first `sheetRegistryEntrySchema`
through the same `parseValidatedJson` helper described below.
`SheetRegistryEntry`'s shape lives in `@hermes/core`, not here and not in the
not-yet-existing `@hermes/google-sheets`, for the same reason `GoogleAccount`
does — this package and `google-sheets` are siblings and must never import
each other.

### `hermes-sheets` CLI

`bin/sheets.ts`'s argument parsing lives in `src/sheets-cli.ts`
(`parseArgs`), unit-tested independent of both the CLI entry point and the
database; `bin/sheets.ts` itself is a thin wrapper that parses, then calls
straight into the repo functions above against a short-lived `Pool`, closed
on exit. An invalid `--access`/`--value-input-option` value is rejected by
`parseArgs` with a `CliUsageError` before any query runs — never passed
through to the table's `CHECK` constraint.

```
hermes-sheets add <slug> <spreadsheetId> [--desc <text>] [--access read|readwrite] [--value-input-option RAW|USER_ENTERED]
hermes-sheets list
hermes-sheets remove <slug>
```

Local dev, against the compose stack's published Postgres port:

```
DATABASE_URL=postgres://hermes:hermes@localhost:5432/hermes \
  pnpm --filter @hermes/store exec hermes-sheets add clients <spreadsheetId> --desc "Client roster" --access readwrite
```

Production, inside the running container (reuses its already-set
`DATABASE_URL`) — invoke the bin **directly**, not via `node`:

```
docker compose exec hermes node_modules/.bin/hermes-sheets add clients <spreadsheetId> --desc "Client roster" --access readwrite
```

`node_modules/.bin/hermes-sheets` is a shell wrapper script on Linux, not
JavaScript — `node node_modules/.bin/hermes-sheets ...` fails with
`SyntaxError: missing ) after argument list`, confirmed live in the built
production image. Its own shebang line handles execution directly. Running
the built entry point through `node` explicitly also works, if ever needed:
`node node_modules/@hermes/store/dist/sheets-cli.js list`.

**Windows note:** `pnpm install` does not link `hermes-migrate`/`hermes-sheets`
into `node_modules/.bin` on Windows (`ENOENT ... migrate-cli.js.EXE`) — a
pre-existing pnpm-on-Windows quirk affecting both bins, not something Phase 3
introduced or fixed. Local dev on Windows invokes the built entry point
directly instead: `node packages/store/dist/sheets-cli.js add ...`.

Nothing reads this table yet — Phase 3 only makes the registry exist and be
operable. A future phase's tools read it live, at call-time, never a
boot-time snapshot.

## Sheet write log

`src/migrations/009_sheet_write_log.sql` creates `sheet_write_log`
(`dedupe_key text primary key, channel text not null, channel_user_id text
not null, turn_id text not null, tool text not null, canonical_args jsonb not
null, status text not null check (status in ('pending', 'complete')), outcome
jsonb, created_at timestamptz not null default now(), completed_at
timestamptz`). One row per dedupe key `sheets_write` (`@hermes/google-sheets`,
Phase 5) has claimed — the durable write audit invariant 3 needs:
`telemetry_events` is buffered and at-most-once (see that table's own section
above), so it cannot be the audit of record for a mutation; claim-before-call
plus a stored outcome can.

`dedupe_key` is a hash of `(channel, channelUserId, turnId, tool, canonical
args JSON)` — computed by `@hermes/google-sheets`'s `canonical-args.ts`, never
by this package. `turnId` is part of the key **on purpose**: it's a retry
guard against the *model* calling `sheets_write` twice with identical args in
one turn, not a permanent "this exact row can only ever be written once"
block — a later, genuinely repeated user request (a different `turnId`) is
allowed to proceed and write again.

- `claimSheetWrite(pool, dedupeKey, { channel, channelUserId, turnId, tool,
  canonicalArgs })` (exported as `claim` from `sheet-write-log-repo.ts`,
  aliased at the `index.ts` boundary since `llm-dedupe-repo.ts` already
  exports a `claim` of its own) — `INSERT ... ON CONFLICT (dedupe_key) DO
  NOTHING RETURNING`, the same shape `llm-dedupe-repo.ts`'s `claim` uses.
  Three outcomes: the INSERT wins -> `"claimed"` (first call for this key);
  the row is `complete` -> `{alreadyComplete: true, outcome}`, the stored
  result of the original call, so the tool never calls the Sheets API again;
  the row is still `pending` -> `{alreadyPending: true}`. Unlike `llm_dedupe`,
  this is **not** fail-open: a pending row for `sheet_write_log` means some
  other call — possibly this exact write, still genuinely in flight, possibly
  a prior attempt that crashed after the write landed but before
  `completeSheetWrite` recorded it (the "Claim-to-complete crash window"
  above) — already started this exact write, and a same-turn retry cannot
  tell which. Returning `"claimed"` here would let the caller call the Sheets
  API a second time, which can double an `append`; `sheets-write.ts` surfaces
  `alreadyPending` as the same ambiguous "may or may not have landed" outcome
  it uses for a post-send-ambiguous client failure, without writing again.
- `completeSheetWrite(pool, dedupeKey, outcome)` (exported as `complete`,
  aliased the same way) — marks the row `complete` and stores `outcome`,
  retrievable by a later duplicate claim within the same turn.

This table is also this plan's durable write audit: every claimed
`sheets_write` call leaves a `psql`-inspectable row recording exactly what
was asked (`canonical_args`) and what happened (`outcome`), whether or not
the write itself ever completes.

## Row validation

`src/validate-row.ts` exports `parseValidatedJson(schema, value, context)` —
a small **generic** helper (accepts anything shaped like a zod schema's
`safeParse`, via the local `ValidatableSchema<T>` interface, so this package
doesn't need `zod` as a dependency just to name the parameter type) that
validates an already-JSON-parsed jsonb value and throws a descriptive error
naming `context` (e.g. `"threads.messages"`) on failure, rather than casting.
The thrown message truncates the schema's own error text to 500 characters —
the same posture `packages/agent`'s `tool.call` telemetry already applies to
its `error` field — so a malformed row's full content doesn't leak into logs
indiscriminately, while the table/column name stays fully readable. Fails
closed, per ROADMAP invariant 7: an invalid row is a thrown error, never a
silently-returned best-effort value.

`thread-repo.ts`'s `toThread` validates `row.messages` against `@hermes/core`'s
`messagesArraySchema`; `google-account-repo.ts`'s `toGoogleAccount` validates
the whole mapped row against `@hermes/core`'s `googleAccountSchema`;
`sheet-registry-repo.ts`'s `toSheetRegistryEntry` validates the whole mapped
row against `@hermes/core`'s `sheetRegistryEntrySchema`. The helper is
deliberately schema-agnostic — it takes any matching schema — so all three
reuse the one implementation unmodified, each against its own schema-first
type.

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
`src/__tests__/advisory-lock-connection-error.test.ts` needs no database — it
mocks `pg` so it can emit the `'error'` event a dropped lock connection
raises, which no integration test can provoke deterministically.

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
entries and bumps `updated_at`; a row hand-corrupted with a raw SQL `UPDATE`
that breaks the `Message` shape (e.g. an unknown `role`) makes
`getOrCreateThread`'s read throw a descriptive error instead of returning
silently-cast garbage.

`src/__tests__/google-account-repo.test.ts` is integration-only, gated the
same way: `upsertAccount` called twice for the same `(channel,
channel_user_id)` overwrites the row rather than duplicating it (the one
`DO UPDATE` exception); `getAccount` round-trips `token_envelope` byte-for-
byte as opaque JSON; `deleteAccount` removes the row.

`src/__tests__/sheet-registry-repo.test.ts` is integration-only, gated the
same way: `upsertSheetRegistryEntry` called twice for the same `slug`
overwrites every field, not just `updated_at`; a minimal upsert with no
`access`/`valueInputOption`/`description` supplied round-trips the
migration's own defaults (`'read'`/`'USER_ENTERED'`/`''`), proving the DB
default itself rather than any caller-side fallback; re-registering a slug
with fields omitted resets them to those defaults rather than preserving the
prior values; `getSheetRegistryEntryBySlug` round-trips; `listSheetRegistryEntries`
returns `[]` on an empty table and every row otherwise;
`removeSheetRegistryEntry` deletes and is idempotent on a slug that was never
registered.

`src/__tests__/sheet-write-log-repo.test.ts` is integration-only, gated the
same way: `claim` on a fresh key returns `"claimed"`; a repeat `claim` on the
same key before `complete()` also returns `"claimed"` (the pending-retry
case); after `complete()`, a further `claim` returns `{alreadyComplete: true,
outcome}` with the stored outcome.

`src/__tests__/sheets-cli.test.ts` is a plain unit-test file (no database,
always runs): `parseArgs` for `add`/`list`/`remove`, including the
no-optional-flags case (asserting the parsed fields are `undefined`, not a
JS-side default) and rejection of an invalid `--access`/`--value-input-option`
value with a `CliUsageError` before any query could run.

The guard and URL resolution in `src/__tests__/db-env.ts` are published to
other packages through this package's `./testing` subpath export, so
`apps/hermes`' and `@hermes/telemetry`'s DB suites reuse the one guard instead
of re-resolving `TEST_DATABASE_URL` privately — a suite that re-resolves it
opts out of both safety checks.
