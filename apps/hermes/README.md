# apps/hermes

The process entry point. `src/index.ts` only calls `boot()` — no logic lives
in the entry point itself.

## Boot sequence

1. `loadConfig()` — exits `1` with a message naming the bad var on failure
   (`@hermes/config`'s `ConfigError`).
2. `assertModelsPricedOrExit()` — runs `@hermes/llm`'s `assertModelsPriced`
   over `LLM_PRIMARY_MODEL` and, when set, `LLM_FALLBACK_MODEL`, exiting `1`
   naming the offending id. Deliberately before the logger and before any DB
   or network I/O: it is pure, synchronous and free, and a model id that has
   drifted out of `MODEL_PRICING` must fail here rather than at
   `resolveCostUsd`, which would discard an already-paid-for reply. A
   configured fallback is checked too — D5's manual-failover model is a model
   Hermes can actually call.
3. Build the JSON-line logger at the configured `LOG_LEVEL` and log the
   **redacted** config once (`toRedactedLog`) — never the raw config.
4. `createPool()` + `waitForDatabase()` — retries a trivial query before
   proceeding, since compose's healthcheck only gates container start, not
   connection readiness.
5. `runMigrations()` against `@hermes/store`'s bundled migrations directory.
6. Build the Telegram client and call `deleteWebhook()` unconditionally
   (`getUpdates` long-polling and a webhook are mutually exclusive on
   Telegram's side).
7. `acquireInstanceLock()` — a Postgres advisory lock enforcing the
   single-`getUpdates`-consumer constraint. A losing instance logs a readable
   error, releases the lock handle, sets `process.exitCode = 1`, and closes
   the pool without calling `process.exit()` (see `packages/store/README.md`).
   The poller's `onFatalError` callback (e.g. a persistent 409 conflict)
   follows the same pattern via `exitAfterFatalPollerError` — see Graceful
   shutdown below.
8. `startHealthServer()` — a `node:http` server; `GET /health` runs
   `SELECT 1` against the pool and returns
   `{ "status": "ok" | "error", "db": "connected" | "disconnected" }`
   (`200` when connected, `503` otherwise). Started only once the lock is
   held.
9. Build the Telegram adapter (`createTelegramClient` + `createTelegramPoller`)
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
10. `buildTelemetryRecorder(pool, logger)` — built after the pool because it
    writes through it, and handed to exactly two places: the handler wiring
    (which passes it into the LLM adapter as `opts.recorder`, so `llm.call`
    events are emitted from the real paid path) and `registerShutdown()`,
    where it is a **required** dep so the flush step cannot be dropped
    silently.
11. `registerShutdown()` — registers the SIGTERM/SIGINT handler (see below).

## Wiring modules

`boot()` has no testable seam, so each construction site that needs one is
extracted into its own small module and unit-tested there:

- `src/llm/build-provider-profiles.ts` — maps `Env`'s flat `LLM_*` fields into
  `ProviderProfile`. The one place allowed to import both `@hermes/config` and
  `@hermes/llm`.
- `src/llm/build-llm-provider.ts` — constructs the adapter, binding
  `@hermes/store`'s `recordUsage`/`sumCostSince` to the `LlmUsageRepo` and
  `BudgetUsageRepo` ports and passing the telemetry recorder through.
- `src/telemetry/build-telemetry-recorder.ts` — binds `@hermes/store`'s
  `insertEvents` to `@hermes/telemetry`'s `TelemetryEventRepo` port.
- `src/telemetry/build-stats-repo.ts` — binds `sumCostSince`,
  `getLlmCallStatsSince` and `getTopToolsSince` to the `StatsRepo` port. The
  same `sumCostSince` function goes into both this port and the budget one,
  which is what makes the cost-source split hold in practice.

## Handlers

- `complete.ts` — the dispatcher's fallthrough and the only handler that
  spends money. Claims `telegram:<updateId>` in `llm_dedupe` before the
  provider call and marks it completed after the reply lands.
- `echo.ts` — echoes back the message text. **No longer wired**; kept in the
  tree as a documented reference/fallback after `complete.ts` took its place
  as the fallthrough.
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

1. `controller.abort()` — the boot-lifetime `AbortController`, fired first and
   before anything is awaited. Its signal is threaded into the poller's
   in-flight `getUpdates` call (see
   `packages/channels/src/telegram/{client,poller}.ts`), so the drain below
   resolves as soon as the abort lands on an idle bot instead of always
   burning its full bound. `controller` is a required `ShutdownDeps` field,
   not optional.
2. `channel.stop()` — flips the poller's `stopping` flag so no new
   `getUpdates` call starts, then awaits the in-flight handler. Bounded to
   ~5s (`DRAIN_TIMEOUT_MS`) regardless of the abort, so a genuinely stuck
   drain still can't block the rest of shutdown indefinitely.
3. `telemetryRecorder.stop()` — flushes any buffered `llm.call` events.
   Bounded independently to ~1s (`TELEMETRY_FLUSH_TIMEOUT_MS`) so a hung
   flush degrades to "lose the unflushed buffer" instead of stalling the
   rest of shutdown. Runs after the drain (so it can capture events from the
   in-flight work that just finished) and before the pool closes (so its own
   write still has a live pool to go through).
4. The advisory lock's `release()` — only once no more DB work from this
   instance is possible, so a restart-racing second instance can't acquire
   the lock while this one is still draining.
5. `pool.end()`.
6. `process.exit(0)`, after a tick (`setImmediate`) to let the final log line
   flush before the async stdout write is truncated.

A hard-exit fallback timer (`HARD_EXIT_TIMEOUT_MS`, ~8s) forces
`process.exit(1)` if any step hangs past it — comfortably under
`docker-compose.yml`'s explicit `stop_grace_period: 15s` for this service,
so a stuck shutdown gets killed by the app's own fallback before Docker
sends `SIGKILL`. (`stop_grace_period` must stay above `HARD_EXIT_TIMEOUT_MS`,
which must stay above `DRAIN_TIMEOUT_MS + TELEMETRY_FLUSH_TIMEOUT_MS` with
room left for `release()`/`pool.end()` — don't change one without the others.) The sequence is exported as `shutdown()` from `boot.ts` for unit
testing: `src/__tests__/shutdown-order.test.ts` pins the step order,
`src/__tests__/shutdown-abort.test.ts` pins the abort-first step and the
telemetry flush's own time box.

The poller's `onFatalError` callback (a persistent 409 conflict — another
instance already holds the `getUpdates` stream) is a separate, unbounded exit
path: `exitAfterFatalPollerError` logs the error, sets `process.exitCode = 1`
and awaits `pool.end()`, without calling `process.exit()` directly, for the
same log-flush reason as the advisory-lock path above.
