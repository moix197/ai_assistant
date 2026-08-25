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

At this phase, `src/migrations/` is empty (kept in git via `.gitkeep`); the
first real migration (`001_telegram_offset.sql`) lands in Phase 3.

## Testing

`src/__tests__/migrate.test.ts` covers `sortMigrationFilenames` as a pure
unit test (always runs). The integration suite in the same file — tracking
table auto-creation, apply-once, no-op re-run, and abort-without-recording on
a failing migration — is gated on `TEST_DATABASE_URL` and is **skipped**
unless that env var is set. To run it locally: point `TEST_DATABASE_URL` at
the compose Postgres (e.g. `postgres://hermes:hermes@localhost:5432/hermes`)
and run `pnpm --filter @hermes/store test`.
