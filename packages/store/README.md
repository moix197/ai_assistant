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
calls `pg_advisory_unlock` then closes the dedicated client; Phase 4 wires it
into an ordered shutdown sequence. Until then, any process exit still frees
the lock implicitly — Postgres releases session-level locks when their
connection closes, crash or not.

At this phase, `src/migrations/` holds `001_telegram_offset.sql` — the first
real migration.

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
`pnpm --filter @hermes/store test`.

`src/__tests__/telegram-offset-repo.test.ts` and
`src/__tests__/advisory-lock.test.ts` are integration-only, gated the same
way: get/set round-tripping for the offset repo, and lock
acquire/contend/crash-release/re-acquire semantics for the advisory lock.
