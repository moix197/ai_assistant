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
5. Build the Telegram client and call `deleteWebhook()` unconditionally
   (`getUpdates` long-polling and a webhook are mutually exclusive on
   Telegram's side).
6. `acquireInstanceLock()` — a Postgres advisory lock enforcing the
   single-`getUpdates`-consumer constraint. A losing instance logs a readable
   error, sets `process.exitCode = 1`, and closes the pool without calling
   `process.exit()` (see `packages/store/README.md`). The poller's
   `onFatalError` callback (e.g. a persistent 409 conflict) follows the same
   pattern via `exitAfterFatalPollerError` — see Graceful shutdown below.
7. `startHealthServer()` — a `node:http` server; `GET /health` runs
   `SELECT 1` against the pool and returns
   `{ "status": "ok" | "error", "db": "connected" | "disconnected" }`
   (`200` when connected, `503` otherwise). Started only once the lock is
   held.
8. Build the Telegram adapter (`createTelegramClient` + `createTelegramPoller`)
   with its offset persisted via `@hermes/store`'s `getOffset`/`setOffset`,
   and subscribe it to a command dispatcher wrapped in `withAllowlist`
   (`src/handlers/with-allowlist.ts`) around `withPrivateChat`
   (`src/handlers/with-private-chat.ts`) — the single allowlist and
   non-private-chat gates for every handler, composed once rather than
   duplicated per handler. The dispatcher (`src/boot.ts`) routes `/ping`,
   `/start`, and `/stats` to their handlers — `/stats` matched before the
   fallthrough, same as the other two, so an unmatched command can never
   trigger a paid completion call — and everything else to the completion
   handler (`src/handlers/complete.ts`).
9. `registerShutdown()` — registers the SIGTERM/SIGINT handler (see below).

## Handlers

- `echo.ts` — echoes back the message text.
- `ping.ts` — `/ping` replies with process uptime and DB status, reusing
  `health.ts`'s `checkDbConnectivity` rather than duplicating the check.
- `start.ts` — `/start` confirms allowlist membership (implicit — reaching
  the handler already proves it) and DB connectivity, via the same check.
- `stats.ts` — `/stats` replies with spend today/this month vs. the
  configured cap, calls, total input/output tokens, cache-hit rate, error
  rate, and a top-tools-this-month list (`"no tool calls recorded yet"` until
  `packages/agent`, 2c, produces `tool.call` events). Thin wiring only: the
  math is `@hermes/telemetry`'s `computeStats`, the rendering its
  `formatStatsMessage`. Spend/cap figures come from `@hermes/store`'s
  `sumCostSince` against `llm_usage` — the same function the budget ceiling
  reads — while calls/tokens/rates/top-tools come from `telemetry_events`
  instead, so `/stats` can never disagree with the ceiling it reports
  against. "Error rate" means precisely the share of `llm.call` events with
  `is_error = true`; a budget-ceiling rejection never produces an `llm.call`
  event, so it is excluded by construction, not by a filter.
- `with-allowlist.ts` — `withAllowlist(handler, allowlist, logger)`, composed
  once in `boot.ts` around the dispatcher rather than inlined in each
  handler.
- `with-private-chat.ts` — `withPrivateChat(handler, logger)`, composed once
  in `boot.ts` inside `withAllowlist`, rejects any non-private chat — even
  from an allowlisted sender — before it reaches the dispatcher, since a
  group reply would broadcast to everyone in it.

## Graceful shutdown

`boot.ts` registers a single SIGTERM/SIGINT handler that runs, in this exact
order:

1. `channel.stop()` — flips the poller's `stopping` flag so no new
   `getUpdates` call starts, then awaits the in-flight handler. The
   boot-lifetime abort signal is threaded into the in-flight `getUpdates`
   call (see `packages/channels/src/telegram/{client,poller}.ts`), so on an
   idle bot this resolves promptly once the signal aborts instead of running
   out the full window. Bounded to ~5s (`DRAIN_TIMEOUT_MS`) regardless, so a
   genuinely stuck drain still can't block the rest of shutdown
   indefinitely.
2. `telemetryRecorder.stop()` — flushes any buffered `llm.call` events.
   Bounded independently to ~1s (`TELEMETRY_FLUSH_TIMEOUT_MS`) so a hung
   flush degrades to "lose the unflushed buffer" instead of stalling the
   rest of shutdown. Runs after the drain (so it can capture events from the
   in-flight work that just finished) and before the pool closes (so its own
   write still has a live pool to go through).
3. The advisory lock's `release()` — only once no more DB work from this
   instance is possible, so a restart-racing second instance can't acquire
   the lock while this one is still draining.
4. `pool.end()`.
5. `process.exit(0)`, after a tick (`setImmediate`) to let the final log line
   flush before the async stdout write is truncated.

A hard-exit fallback timer (`HARD_EXIT_TIMEOUT_MS`, ~8s) forces
`process.exit(1)` if any step hangs past it — comfortably under
`docker-compose.yml`'s explicit `stop_grace_period: 15s` for this service,
so a stuck shutdown gets killed by the app's own fallback before Docker
sends `SIGKILL`. (`stop_grace_period` must stay above `HARD_EXIT_TIMEOUT_MS`,
which must stay above `DRAIN_TIMEOUT_MS` — don't lower one without the
others.) The sequence is exported as `shutdown()` from `boot.ts` for unit
testing (see `src/__tests__/shutdown-order.test.ts`).

The poller's `onFatalError` callback (a persistent 409 conflict — another
instance already holds the `getUpdates` stream) is a separate, unbounded exit
path: `exitAfterFatalPollerError` logs the error, sets `process.exitCode = 1`
and awaits `pool.end()`, without calling `process.exit()` directly, for the
same log-flush reason as the advisory-lock path above.
