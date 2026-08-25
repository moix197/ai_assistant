# apps/hermes

The process entry point. `src/index.ts` only calls `boot()` — no logic lives
in the entry point itself.

## Boot sequence

1. `loadConfig()` — exits `1` with a message naming the bad var on failure
   (`@hermes/config`'s `ConfigError`).
2. Build the JSON-line logger at the configured `LOG_LEVEL` and log the
   **redacted** config once (`toRedactedLog`) — never the raw config.
3. `createPool()` + `waitForDatabase()` — retries a trivial query before
   proceeding, since compose's healthcheck only gates container start, not
   connection readiness.
4. `runMigrations()` against `@hermes/store`'s bundled migrations directory.
5. `startHealthServer()` — a `node:http` server; `GET /health` runs
   `SELECT 1` against the pool and returns
   `{ "status": "ok" | "error", "db": "connected" | "disconnected" }`
   (`200` when connected, `503` otherwise).

Telegram channel wiring, graceful shutdown, and `/ping`/`/start` are later
phases (see `plans/00-skeleton.md`).
