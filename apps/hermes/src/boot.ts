import {
  type InboundCallback,
  type InboundMessage,
  type TelegramClient,
  type TelegramPoller,
  createTelegramClient,
  createTelegramPoller,
  parseAllowlist,
} from "@hermes/channels";
import { ConfigError, type Env, loadConfig, toRedactedLog } from "@hermes/config";
import { type Logger, createLogger, systemClock } from "@hermes/core";
import {
  type ConnectFlow,
  type GoogleAccount,
  type GoogleAccountRepo,
  type PendingConnectionStore,
  type RefreshCoordinator,
  createConnectFlow,
  createGoogleRefreshAccessToken,
  createPendingConnectionStore,
  createRefreshCoordinator,
  decryptTokenEnvelope,
} from "@hermes/google-auth";
import { type CalendarToolDeps, createCalendarClient } from "@hermes/google-calendar";
import { type GmailToolDeps, createGmailClient } from "@hermes/google-gmail";
import {
  type SheetWriteLogPort,
  type SheetsToolDeps,
  createSheetsClient,
} from "@hermes/google-sheets";
import { UnpricedModelError, assertModelsPriced, resolveBudgetCapUsd } from "@hermes/llm";
import {
  INSTANCE_LOCK_KEY,
  type InstanceLock,
  type Pool,
  acquireInstanceLock,
  claim as claimDedupe,
  claimSheetWrite,
  complete as completeDedupe,
  completeSheetWrite,
  createPool,
  getDefaultMigrationsDir,
  getOffset,
  listAccountsExpiringBefore,
  markDisconnected,
  releaseSheetWrite,
  runMigrations,
  setOffset,
  updateRefreshedTokens,
  waitForDatabase,
} from "@hermes/store";
import type { TelemetryRecorderHandle } from "@hermes/telemetry";
import { buildAgent } from "./agent/build-agent";
import { buildAccessTokenPort } from "./google/build-access-token-port";
import { buildCalendarAccessTokenPort } from "./google/build-calendar-access-token-port";
import { buildGoogleOAuthClient } from "./google/build-google-oauth-client";
import {
  type OauthCallbackRoute,
  createOauthCallbackRoute,
} from "./google/build-oauth-callback-route";
import {
  REFRESH_SWEEP_INTERVAL_MS,
  type RefreshSweep,
  createRefreshSweep,
} from "./google/refresh-sweep";
import { createCompletionHandler } from "./handlers/complete";
import { createConnectHandler } from "./handlers/connect";
import { createDisconnectHandler } from "./handlers/disconnect";
import { createPingHandler } from "./handlers/ping";
import { createStartHandler } from "./handlers/start";
import { createStatsHandler } from "./handlers/stats";
import { createStatusHandler } from "./handlers/status";
import { withAllowlist } from "./handlers/with-allowlist";
import { withPrivateChat } from "./handlers/with-private-chat";
import { startHealthServer } from "./health";
import { buildLlmProvider } from "./llm/build-llm-provider";
import { buildProviderProfiles } from "./llm/build-provider-profiles";
import { buildGoogleAccountRepo } from "./store/build-google-account-repo";
import { buildSheetRegistryRepo } from "./store/build-sheet-registry-repo";
import { buildStatsRepo } from "./telemetry/build-stats-repo";
import { buildTelemetryRecorder } from "./telemetry/build-telemetry-recorder";

/**
 * Bounded wait for in-flight work to drain before moving on to lock release.
 * Kept well under HARD_EXIT_TIMEOUT_MS (3s of gap) so lock.release(),
 * pool.end() and the final log still have room to run before the hard-exit
 * fallback fires.
 */
const DRAIN_TIMEOUT_MS = 5_000;
/**
 * Guards against any shutdown step hanging past the container's stop grace
 * period (`stop_grace_period: 15s`, set explicitly in `docker-compose.yml`).
 * Set well under that ceiling (7s of margin) so the forced `process.exit(1)`
 * and its log line still land before Docker sends SIGKILL, while leaving
 * DRAIN_TIMEOUT_MS enough room above it for the post-drain steps (see
 * above).
 */
const HARD_EXIT_TIMEOUT_MS = 8_000;
/**
 * Bounds the shutdown-time telemetry flush (`telemetryRecorder.stop()`), run
 * after `channel.stop()`'s drain and before `lock.release()`/`pool.end()`.
 * Sized so a hung flush degrades to "lose the unflushed buffer" (the
 * at-most-once tradeoff `packages/telemetry` already accepts) rather than
 * starving the remaining shutdown steps of `HARD_EXIT_TIMEOUT_MS`'s budget —
 * `channel.stop()`'s own drain can already consume up to `DRAIN_TIMEOUT_MS`
 * (5s) of the 8s ceiling, so this gets a deliberately short 1s of its own.
 */
const TELEMETRY_FLUSH_TIMEOUT_MS = 1_000;
/**
 * Bounds the shutdown-time refresh-sweep stop (`sweep.stop()`), run after
 * `telemetryRecorder.stop()` and before `lock.release()`/`pool.end()`. A
 * hung `stop()` (awaiting an in-flight `runOnce()` mid-refresh) degrades to
 * "leave whatever accounts weren't reached this tick until the next boot's
 * immediate sweep pass" rather than starving the rest of shutdown — the same
 * tradeoff `TELEMETRY_FLUSH_TIMEOUT_MS` accepts. Sized the same 1s: with
 * `DRAIN_TIMEOUT_MS` (5s) + `TELEMETRY_FLUSH_TIMEOUT_MS` (1s) already able to
 * consume up to 6s of the 8s `HARD_EXIT_TIMEOUT_MS` ceiling, this leaves
 * `lock.release()`/`pool.end()`/the final log at least 1s of margin before
 * the hard-exit fallback fires.
 */
const SWEEP_STOP_TIMEOUT_MS = 1_000;

/**
 * Splits incoming text on the **first** whitespace only: the head becomes
 * `command`, everything after that one separator becomes `args` verbatim
 * (so `"/connect google extra text"` parses `args = "google extra text"` —
 * the handler decides what to do with the rest). A bare command with no
 * whitespace yields `args: ""`.
 */
export function splitCommand(text: string): { command: string; args: string } {
  const whitespaceIndex = text.search(/\s/);
  if (whitespaceIndex === -1) return { command: text, args: "" };
  return { command: text.slice(0, whitespaceIndex), args: text.slice(whitespaceIndex + 1) };
}

/**
 * Matches a command allowing Telegram's optional `@botusername` suffix
 * (sent in groups, and by some clients even in DMs) — not a full command
 * parser, just this one allowance. `text` (the head `splitCommand` produced)
 * must otherwise equal `command` exactly.
 */
export function matchesCommand(text: string, command: string): boolean {
  return text === command || text.startsWith(`${command}@`);
}

export interface DispatchCommandDeps {
  pingHandler: (message: InboundMessage, args: string) => Promise<void>;
  startHandler: (message: InboundMessage, args: string) => Promise<void>;
  statsHandler: (message: InboundMessage, args: string) => Promise<void>;
  connectHandler: (message: InboundMessage, args: string) => Promise<void>;
  statusHandler: (message: InboundMessage, args: string) => Promise<void>;
  disconnectHandler: (message: InboundMessage, args: string) => Promise<void>;
  completionHandler: (message: InboundMessage, args: string) => Promise<void>;
}

/**
 * Command dispatch, extracted to a factory (rather than left inline in
 * `boot()`) so it can be composed under `withAllowlist(withPrivateChat(...))`
 * in a test the same way `boot()` composes it for real — see
 * `__tests__/dispatch-allowlist-gates-llm.test.ts`. Text is split on the
 * first whitespace into `{ command, args }` (`splitCommand`) before any
 * matching happens — this closes a real paid-fallthrough hole: previously
 * `/connect google` matched nothing and fell through to the paid
 * `completionHandler`; now every command with an argument routes locally.
 * `/ping`, `/start`, `/stats`, `/connect`, `/status`, and `/disconnect`
 * short-circuit; anything else falls through to `completionHandler`, which
 * replaced `echoHandler` here — `echo.ts` stays in the tree as a documented
 * reference/fallback but is no longer wired. Each short-circuit is matched
 * **before** the fallthrough for the same reason: an unmatched command
 * falling through would otherwise trigger a real paid completion call (see
 * `__tests__/dispatch-stats-command.test.ts`,
 * `__tests__/dispatcher-argument-parsing.test.ts`).
 */
export function createDispatchCommand(
  deps: DispatchCommandDeps,
): (message: InboundMessage) => Promise<void> {
  return function dispatchCommand(message: InboundMessage): Promise<void> {
    const { command, args } = splitCommand(message.text);
    if (matchesCommand(command, "/ping")) return deps.pingHandler(message, args);
    if (matchesCommand(command, "/start")) return deps.startHandler(message, args);
    if (matchesCommand(command, "/stats")) return deps.statsHandler(message, args);
    if (matchesCommand(command, "/connect")) return deps.connectHandler(message, args);
    if (matchesCommand(command, "/status")) return deps.statusHandler(message, args);
    if (matchesCommand(command, "/disconnect")) return deps.disconnectHandler(message, args);
    return deps.completionHandler(message, args);
  };
}

function loadConfigOrExit(): Env {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Fails boot outright, before any DB or network I/O, when `LLM_PRIMARY_MODEL`
 * or a configured `LLM_FALLBACK_MODEL` has no `MODEL_PRICING` entry — the
 * primary defense against `resolveCostUsd`'s live-call throw (see
 * `.ai/decisions/llm-cost-accounting.md`). Same handling as `ConfigError`
 * above: a readable message, non-zero exit, no stack trace.
 */
function assertModelsPricedOrExit(config: Env): void {
  const profiles = buildProviderProfiles(config);
  try {
    assertModelsPriced(
      [profiles.primary.model, profiles.fallback?.model].filter(
        (model): model is string => model !== undefined,
      ),
    );
  } catch (error) {
    if (error instanceof UnpricedModelError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Same async-stdout-flush hazard as the instance-lock branch in `boot()`:
 * `process.exit()` can truncate this log line before Docker's piped stdout
 * finishes writing it. Setting `exitCode` and closing the pool lets the
 * event loop drain naturally so the process still exits non-zero without
 * racing the log.
 */
export async function exitAfterFatalPollerError(
  pool: { end(): Promise<void> },
  logger: Logger,
  error: Error,
): Promise<void> {
  logger.error("fatal telegram poller error, exiting", { error: error.message });
  process.exitCode = 1;
  await pool.end();
}

/**
 * Losing the single-instance race is an expected outcome, and exits the same
 * non-`process.exit()` way `exitAfterFatalPollerError` does, for the same
 * reason: stdout writes (e.g. Docker's piped stdout) are async, and exiting
 * immediately can drop this log line before it flushes. Setting `exitCode`
 * and closing the pool lets the event loop drain naturally once the write
 * completes, so the process still exits non-zero without racing the log.
 */
async function exitAfterLostInstanceLock(
  pool: { end(): Promise<void> },
  logger: Logger,
): Promise<void> {
  logger.error("another Hermes instance is already running against this database");
  process.exitCode = 1;
  await pool.end();
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return Promise.race([promise, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

export interface ShutdownDeps {
  channel: { stop(): Promise<void> };
  lock: { release(): Promise<void> };
  pool: { end(): Promise<void> };
  logger: Logger;
  drainTimeoutMs?: number;
  /**
   * The boot-lifetime `AbortController` (Phase 5) whose signal is threaded
   * into the LLM adapter. Required, not optional: an optional-with-no-op
   * default would let `boot()`'s real registration silently drop this wire
   * with nothing catching it — the same Phase-4 trap (a mechanism built and
   * tested but never actually connected) this project has already been
   * burned by once. Aborting it here, before `channel.stop()`'s drain wait,
   * is what makes an in-flight completion call's `fetch` reject promptly
   * instead of running out its full per-request timeout during shutdown.
   */
  controller: { abort(): void };
  /**
   * The telemetry recorder handle (Phase 2b), flushed after `channel.stop()`'s
   * drain and before `lock.release()`/`pool.end()`. Required, not optional,
   * for the same reason `controller` above is: an optional-with-a-silent-skip
   * default would let `boot()`'s real registration drop this wire with
   * nothing catching it — the exact "fully tested mechanism, never actually
   * connected" trap `01-llm-port` was burned by twice (see
   * `plans/02-telemetry.md`).
   */
  telemetryRecorder: { stop(): Promise<void> };
  telemetryFlushTimeoutMs?: number;
  /**
   * The refresh sweep (Phase 4). Required, not optional, for the same reason
   * `controller`/`telemetryRecorder` above are: an optional-with-a-silent-skip
   * default would let `boot()`'s real registration drop this wire with
   * nothing catching it. When Google's env group is unset, `boot()` passes a
   * trivial `{ stop: async () => {} }` — the sweep itself never started, so
   * there is nothing to stop, not a special case to thread through here.
   */
  sweep: { stop(): Promise<void> };
  sweepStopTimeoutMs?: number;
}

/**
 * The ordered, load-bearing shutdown sequence: (0) abort the boot-lifetime
 * `AbortController`, so any in-flight LLM completion call's `fetch` rejects
 * promptly instead of running out its timeout; (1) `channel.stop()` flips
 * the poller's stopping flag so no new `getUpdates` call starts, then awaits
 * the in-flight handler — bounded here so a stuck drain doesn't block the
 * rest of shutdown forever; (2) flush telemetry (`telemetryRecorder.stop()`),
 * bounded independently so a hung flush degrades to "lose the unflushed
 * buffer" instead of stalling the rest of shutdown — run after the drain (so
 * it can capture events from the in-flight work that just finished) and
 * before the pool closes (so its own write has a live pool to go through);
 * (3) stop the refresh sweep (`sweep.stop()`, Phase 4), bounded the same way,
 * so an in-flight refresh tick doesn't block shutdown — must still run
 * before the lock/pool close below, since a tick in progress is still
 * issuing DB queries; (4) release the advisory lock, only once no more DB
 * work from this instance is possible, so a restart-racing instance can't
 * acquire it mid-drain; (5) close the pool; (6) `process.exit(0)`. Each step
 * is a precondition for the next: releasing the lock before the drain or the
 * sweep stop finishes would let a second instance start while we're still
 * querying; closing the pool before any of them finishes would crash an
 * in-flight query.
 */
export async function shutdown(deps: ShutdownDeps): Promise<void> {
  const drainTimeoutMs = deps.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  const telemetryFlushTimeoutMs = deps.telemetryFlushTimeoutMs ?? TELEMETRY_FLUSH_TIMEOUT_MS;
  const sweepStopTimeoutMs = deps.sweepStopTimeoutMs ?? SWEEP_STOP_TIMEOUT_MS;
  deps.controller.abort();
  await withTimeout(deps.channel.stop(), drainTimeoutMs);
  await withTimeout(deps.telemetryRecorder.stop(), telemetryFlushTimeoutMs);
  await withTimeout(deps.sweep.stop(), sweepStopTimeoutMs);
  await deps.lock.release();
  await deps.pool.end();
  deps.logger.info("shutdown complete");
  // Gives the (possibly async, e.g. piped-to-Docker) stdout write above a
  // chance to flush before process.exit(0) below truncates it.
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.exit(0);
}

/**
 * Registers the SIGTERM/SIGINT handler once. A hard-exit fallback timer
 * guards against any shutdown step hanging past the container's stop grace
 * period instead of being hard-killed.
 */
export function registerShutdown(deps: ShutdownDeps): void {
  let shuttingDown = false;

  function handleSignal(signal: NodeJS.Signals): void {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info("received shutdown signal, draining", { signal });

    const hardExitTimer = setTimeout(() => {
      deps.logger.error("shutdown exceeded grace period, forcing exit");
      process.exit(1);
    }, HARD_EXIT_TIMEOUT_MS);
    hardExitTimer.unref();

    // No .finally() here: clearing the timer unconditionally would also
    // clear it on a REJECTED shutdown (e.g. lock.release()/pool.end()
    // throwing because the DB is already down) — the exact case this guard
    // exists for. A failed shutdown must still exit promptly and audibly.
    void shutdown(deps).catch((error) => {
      deps.logger.error("shutdown failed, forcing exit", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
  }

  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
}

/**
 * The pool plus the two steps that must complete before anything else queries
 * it: the readiness wait and the schema migrations.
 */
async function createMigratedPool(databaseUrl: string): Promise<Pool> {
  const pool = createPool(databaseUrl);
  await waitForDatabase(pool);
  await runMigrations(pool, getDefaultMigrationsDir());
  return pool;
}

/**
 * `deleteWebhook` is unconditional and idempotent: getUpdates long-polling and
 * a webhook are mutually exclusive on Telegram's side, so a webhook left over
 * from a previous deployment mode would otherwise silently starve the poller.
 */
async function createPollingTelegramClient(token: string): Promise<TelegramClient> {
  const client = createTelegramClient({ token });
  await client.deleteWebhook();
  return client;
}

/**
 * `/health` and `/oauth/callback` on the configured port, with boot-logger
 * reporting for both outcomes. `oauthCallbackRoute.handleRequest` is passed
 * in unbound — it 503s until `wireRuntimeAndShutdown` calls `.bind()` once
 * the Telegram channel and `connectFlow` exist (see Dependencies & Risks:
 * the health server is constructed before the channel in `boot()`'s
 * documented order, and this plan does not reorder that for one route).
 */
function serveHealth(
  pool: Pool,
  port: number,
  logger: Logger,
  oauthCallbackRoute: OauthCallbackRoute,
): void {
  startHealthServer(
    pool,
    port,
    {
      onListening: () => logger.info("health server listening", { port }),
      onError: (error) => {
        logger.error("health server error", { error: error.message });
        process.exit(1);
      },
    },
    oauthCallbackRoute.handleRequest,
  );
}

/**
 * The poller bound to its Postgres-backed offset store and the fatal-error
 * exit path. `signal` is the boot-lifetime shutdown signal, threaded into
 * every `getUpdates` call so shutdown's `channel.stop()` drain resolves as
 * soon as `controller.abort()` fires instead of running out `DRAIN_TIMEOUT_MS`
 * on an idle bot (see `packages/channels/src/telegram/{client,poller}.ts`).
 */
function createTelegramChannel(
  client: TelegramClient,
  pool: Pool,
  logger: Logger,
  signal: AbortSignal,
): TelegramPoller {
  return createTelegramPoller({
    client,
    logger,
    offsetRepo: {
      getOffset: () => getOffset(pool),
      setOffset: (updateId: number) => setOffset(pool, updateId),
    },
    signal,
    // A fatal poller error (e.g. a persistent 409 conflict) must surface
    // loudly and exit non-zero, not disappear into a silently-looping
    // retry. Fire-and-forget: `onFatalError` is a sync callback, and
    // `exitAfterFatalPollerError` itself has nothing left for a caller to
    // await.
    onFatalError: (error) => {
      void exitAfterFatalPollerError(pool, logger, error);
    },
  });
}

export interface MessageHandlerDeps {
  channel: TelegramPoller;
  pool: Pool;
  config: Env;
  logger: Logger;
  /** The boot-lifetime abort signal, threaded through to the LLM adapter. */
  signal: AbortSignal;
  /** Threaded through to the LLM adapter so every completion call emits an `llm.call` event. */
  telemetryRecorder: TelemetryRecorderHandle;
  /**
   * `undefined` when the Google OAuth env group is unset — Google features
   * are cleanly absent, and `/connect google` replies accordingly instead of
   * throwing. The *same* instance `wireRuntimeAndShutdown` binds to the
   * OAuth callback route — its `pendingStore` map must be shared, or a state
   * minted here would never resolve there.
   */
  connectFlow: ConnectFlow | undefined;
  /**
   * The one process-lifetime `RefreshCoordinator` (Phase 4 code review fix)
   * — shared with the boot-owned refresh sweep (`buildRefreshSweep`) rather
   * than each constructing its own. `RefreshCoordinator`'s single-flight map
   * (`packages/google-auth/src/refresh.ts`) is per-instance state; two
   * separately-constructed coordinators for the same account could refresh
   * concurrently and both write tokens, contradicting settled decision 18's
   * single-seam invariant. `undefined` when Google's all-or-none env group
   * is unset — the same "cleanly absent, not a boot failure" contract every
   * other Google-gated dependency here follows.
   */
  refreshCoordinator: RefreshCoordinator | undefined;
  /**
   * Decrypts a connected account's stored token envelope down to its
   * refresh token — the narrow capability `/disconnect`'s handler needs to
   * revoke the grant at Google before deleting the local row, injected
   * instead of the raw `cryptoKey` so every other handler here doesn't also
   * gain visibility into key material it has no reason to touch. `undefined`
   * when Google's all-or-none env group is unset — the same "cleanly
   * absent, not a boot failure" contract `connectFlow`/`refreshCoordinator`
   * above follow.
   */
  decryptRefreshToken: ((account: GoogleAccount) => string) | undefined;
}

/**
 * The seven handlers `dispatchCommand` routes between, each wired to real
 * infrastructure. echoHandler stays available (createEchoHandler,
 * "./handlers/echo") as a documented reference/fallback but is no longer
 * wired — completionHandler is dispatchCommand's fallthrough now.
 *
 * `createMessageHandlers`'s return also carries the approval gate's callback
 * resolver — see `subscribeGatedDispatch` for why both are wired together.
 */
interface MessageHandlerWiring {
  handlers: DispatchCommandDeps;
  handleApprovalCallback: (callback: InboundCallback) => Promise<void>;
}

function createMessageHandlers(deps: MessageHandlerDeps): MessageHandlerWiring {
  const {
    channel,
    pool,
    config,
    logger,
    signal,
    telemetryRecorder,
    connectFlow,
    refreshCoordinator,
    decryptRefreshToken,
  } = deps;
  const providerProfiles = buildProviderProfiles(config);
  const llmProvider = buildLlmProvider(
    pool,
    providerProfiles.primary,
    logger,
    config,
    signal,
    telemetryRecorder,
  );
  const sheetsDeps = buildSheetsDeps(pool, buildGoogleAccountRepo(pool), refreshCoordinator);
  const calendarDeps = buildCalendarDeps(pool, buildGoogleAccountRepo(pool), refreshCoordinator);
  const gmailDeps = buildGmailDeps(pool, buildGoogleAccountRepo(pool), refreshCoordinator);
  const { agent, handleApprovalCallback } = buildAgent(
    pool,
    llmProvider,
    providerProfiles.primary.model,
    telemetryRecorder,
    signal,
    channel,
    sheetsDeps,
    buildSheetWriteLogRepo(pool),
    calendarDeps,
    gmailDeps,
    logger,
  );

  return {
    handlers: {
      pingHandler: createPingHandler(channel, pool),
      startHandler: createStartHandler(channel, pool),
      statsHandler: createStatsHandler(
        channel,
        buildStatsRepo(pool),
        systemClock,
        resolveBudgetCapUsd(config),
      ),
      connectHandler: createConnectHandler(channel, connectFlow),
      statusHandler: createStatusHandler(channel, buildGoogleAccountRepo(pool)),
      disconnectHandler: createDisconnectHandler(channel, buildGoogleAccountRepo(pool), {
        decryptRefreshToken,
        logger,
        signal,
      }),
      completionHandler: createCompletionHandler({
        channel,
        agent,
        logger,
        dedupeRepo: {
          claim: (dedupeKey: string) => claimDedupe(pool, dedupeKey),
          complete: (dedupeKey: string, resultText: string) =>
            completeDedupe(pool, dedupeKey, resultText),
        },
      }),
    },
    handleApprovalCallback,
  };
}

/**
 * Every handler (ping/start/completion) must pass both gates — composed once
 * here rather than duplicated per handler, so neither check can be forgotten
 * by a future handler. Allowlist runs outermost so an unknown sender is
 * rejected before the private-chat check even looks at them — and, since
 * completionHandler is the fallthrough, before it ever reaches
 * `llmProvider.complete()`, so an unknown sender never costs anything.
 *
 * The approval gate's callback resolver is wired here too, alongside the
 * message dispatch above: `channel.subscribeCallback` registers the single
 * handler for every inbound button tap, routing it straight to
 * `handleApprovalCallback` — deliberately **not** gated behind
 * `withAllowlist`/`withPrivateChat` the way message dispatch is, since a
 * callback answers a prompt this bot itself already sent into an allowlisted
 * chat; there is no unauthenticated inbound surface here to gate.
 */
function subscribeGatedDispatch(deps: MessageHandlerDeps): void {
  const { channel, config, logger } = deps;
  const { handlers, handleApprovalCallback } = createMessageHandlers(deps);
  const dispatchCommand = createDispatchCommand(handlers);
  const allowlist = parseAllowlist(config.TELEGRAM_ALLOWLIST);
  channel.subscribe(withAllowlist(withPrivateChat(dispatchCommand, logger), allowlist, logger));
  channel.subscribeCallback(handleApprovalCallback);
}

/**
 * Acquires the single-instance advisory lock, or performs the losing-the-race
 * exit dance (release the not-acquired lock, log, close the pool) and returns
 * `undefined` so `boot()` can return early. Extracted so `boot()`'s body
 * reads as one call per load-bearing step.
 */
async function acquireInstanceLockOrExit(
  pool: Pool,
  databaseUrl: string,
  logger: Logger,
): Promise<InstanceLock | undefined> {
  const instanceLock = await acquireInstanceLock(INSTANCE_LOCK_KEY, databaseUrl);
  if (!instanceLock.acquired) {
    await instanceLock.release();
    await exitAfterLostInstanceLock(pool, logger);
    return undefined;
  }
  return instanceLock;
}

/**
 * Builds the connect flow shared by the `/connect` command handler and the
 * OAuth callback route — the **same** instance, since `pendingStore` is an
 * in-memory map: a state minted by one instance would never resolve against
 * another's. The store is returned alongside the flow because the callback
 * route needs it directly for Google's denial redirect, which has no code to
 * put through `completeConnect`. `undefined` when the Google all-or-none env
 * group (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`TOKEN_ENCRYPTION_KEY`) is
 * unset — Google features are then cleanly absent, not a boot failure.
 */
function buildConnectFlow(
  pool: Pool,
  config: Env,
): { connectFlow: ConnectFlow; pendingStore: PendingConnectionStore } | undefined {
  const googleOAuth = buildGoogleOAuthClient(config);
  if (!googleOAuth) return undefined;

  const pendingStore = createPendingConnectionStore(systemClock);
  const connectFlow = createConnectFlow({
    oauthClient: googleOAuth.oauthClient,
    repo: buildGoogleAccountRepo(pool),
    cryptoKey: googleOAuth.cryptoKey,
    pendingStore,
    clock: systemClock,
  });
  return { connectFlow, pendingStore };
}

/**
 * Builds the ONE `RefreshCoordinator` for the process's lifetime — shared by
 * both the boot-owned refresh sweep (`buildRefreshSweep`) and the Sheets
 * tools' `AccessTokenPort` (`buildSheetsDeps`), per `wireRuntimeAndShutdown`
 * below. `RefreshCoordinator`'s single-flight map
 * (`packages/google-auth/src/refresh.ts`) is per-instance state: two
 * separately-constructed coordinators refreshing the same account
 * concurrently could both hit Google's token endpoint and both write tokens
 * back, contradicting settled decision 18's "single seam, no second refresh
 * path" invariant — an earlier version of this file constructed one
 * coordinator per caller on exactly that (incorrect) "stateless, nothing to
 * share" reasoning; this is the fix. `undefined` when Google's all-or-none
 * env group is unset — the same "cleanly absent, not a boot failure"
 * contract `buildConnectFlow` follows. Constructs its own `OAuth2Client` via
 * `buildGoogleOAuthClient` rather than sharing `buildConnectFlow`'s
 * instance: unlike the coordinator's single-flight map, the `OAuth2Client`
 * itself is a stateless-per-call construction, so there is no correctness
 * reason for it to be shared too.
 */
function buildGoogleRefreshCoordinator(config: Env): RefreshCoordinator | undefined {
  const googleOAuth = buildGoogleOAuthClient(config);
  if (!googleOAuth) return undefined;

  return createRefreshCoordinator({
    refreshAccessToken: createGoogleRefreshAccessToken(googleOAuth.oauthClient),
    cryptoKey: googleOAuth.cryptoKey,
  });
}

/**
 * Builds the decrypt-refresh-token capability `MessageHandlerDeps.
 * decryptRefreshToken` carries — the narrow seam `/disconnect`'s handler
 * needs to revoke the grant at Google before deleting the local row,
 * instead of threading the raw `cryptoKey` through every handler. Constructs
 * its own `OAuth2Client`/`cryptoKey` via `buildGoogleOAuthClient`, the same
 * stateless-per-call reasoning `buildGoogleRefreshCoordinator`'s own doc
 * comment gives for not sharing `buildConnectFlow`'s instance — there is no
 * correctness reason to share this one either. `undefined` when Google's
 * all-or-none env group is unset, the same "cleanly absent, not a boot
 * failure" contract those two follow.
 */
function buildDecryptRefreshToken(config: Env): ((account: GoogleAccount) => string) | undefined {
  const googleOAuth = buildGoogleOAuthClient(config);
  if (!googleOAuth) return undefined;

  return function decryptRefreshToken(account: GoogleAccount): string {
    return decryptTokenEnvelope(account, googleOAuth.cryptoKey).refreshToken;
  };
}

/**
 * Builds the boot-owned refresh sweep (Phase 4) over the shared
 * `RefreshCoordinator` `wireRuntimeAndShutdown` passes in, or `undefined`
 * when `coordinator` is `undefined` (Google's all-or-none env group unset)
 * — the same "cleanly absent, not a boot failure" contract `buildConnectFlow`
 * follows.
 */
export function buildRefreshSweep(
  pool: Pool,
  channel: Pick<TelegramPoller, "send">,
  logger: Logger,
  coordinator: RefreshCoordinator | undefined,
): RefreshSweep | undefined {
  if (!coordinator) return undefined;

  return createRefreshSweep({
    repo: {
      listAccountsExpiringBefore: (cutoff) => listAccountsExpiringBefore(pool, cutoff),
      updateRefreshedTokens: (account) => updateRefreshedTokens(pool, account),
      markDisconnected: (channelName, channelUserId) =>
        markDisconnected(pool, channelName, channelUserId),
    },
    coordinator,
    channel,
    clock: systemClock,
    logger,
  });
}

/**
 * Builds the Sheets tools' three real-infra dependencies (`05-google-sheets`
 * Phase 4): the registry port, the `AccessTokenPort` bound to the refresh
 * seam, and the Sheets HTTP client. Binds `AccessTokenPort` to the same
 * shared `RefreshCoordinator` `wireRuntimeAndShutdown` passes into
 * `buildRefreshSweep` — see that coordinator's own doc comment for why a
 * second, separately-constructed instance is a correctness bug, not a
 * harmless duplication. When `coordinator` is `undefined` (Google's
 * all-or-none env group unset), `accessTokenPort` falls back to a throwing
 * stub rather than `undefined` — the Sheets tools are still wired
 * unconditionally (matching `whoami`'s own unconditional construction),
 * since `withRequiredScopes` always gates every call on a connected account
 * first, and no account can exist without this same env group (there is no
 * other way to complete `/connect google`), so the stub is never actually
 * reached.
 */
export function buildSheetsDeps(
  pool: Pool,
  googleAccountRepo: GoogleAccountRepo,
  coordinator: RefreshCoordinator | undefined,
): SheetsToolDeps {
  const accessTokenPort = coordinator
    ? buildAccessTokenPort({ pool, googleAccountRepo, refreshCoordinator: coordinator })
    : {
        getAccessToken: async (): Promise<string> => {
          throw new Error(
            "Google Sheets is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/TOKEN_ENCRYPTION_KEY unset)",
          );
        },
      };

  return {
    sheetRegistry: buildSheetRegistryRepo(pool),
    accessTokenPort,
    sheetsClient: createSheetsClient(),
  };
}

/**
 * Builds `list_events`' (Phase 2) real-infra dependencies: the
 * `AccessTokenPort` bound to the refresh seam, and the Calendar HTTP client.
 * Mirrors `buildSheetsDeps` exactly, including the unconfigured-Google
 * fallback (a throwing stub rather than `undefined`) — see that function's
 * own doc comment for why the stub is never actually reached: every gated
 * Calendar tool is wired unconditionally, and `withRequiredScopes` always
 * gates the call on a connected account first, which cannot exist without
 * this same env group.
 */
export function buildCalendarDeps(
  pool: Pool,
  googleAccountRepo: GoogleAccountRepo,
  coordinator: RefreshCoordinator | undefined,
): CalendarToolDeps {
  const accessTokenPort = coordinator
    ? buildCalendarAccessTokenPort({ pool, googleAccountRepo, refreshCoordinator: coordinator })
    : {
        getAccessToken: async (): Promise<string> => {
          throw new Error(
            "Google Calendar is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/TOKEN_ENCRYPTION_KEY unset)",
          );
        },
      };

  return {
    accessTokenPort,
    calendarClient: createCalendarClient(),
  };
}

/**
 * Builds `gmail_list_unread`'s (`09-gmail-read-then-send` Phase 1) real-infra
 * dependencies: the `AccessTokenPort` bound to the refresh seam, and the
 * Gmail HTTP client. Direct twin of `buildSheetsDeps` — including the
 * unconfigured-Google fallback (a throwing stub rather than `undefined`; see
 * that function's own doc comment for why the stub is never actually
 * reached) — and, unlike Calendar, reuses `buildAccessTokenPort` directly
 * rather than a package-specific binder: `@hermes/google-gmail`'s own
 * `AccessTokenPort` is structurally identical to `@hermes/google-sheets`'.
 */
export function buildGmailDeps(
  pool: Pool,
  googleAccountRepo: GoogleAccountRepo,
  coordinator: RefreshCoordinator | undefined,
): GmailToolDeps {
  const accessTokenPort = coordinator
    ? buildAccessTokenPort({ pool, googleAccountRepo, refreshCoordinator: coordinator })
    : {
        getAccessToken: async (): Promise<string> => {
          throw new Error(
            "Gmail is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/TOKEN_ENCRYPTION_KEY unset)",
          );
        },
      };

  return {
    accessTokenPort,
    gmailClient: createGmailClient(),
  };
}

/**
 * Wires `@hermes/google-sheets`'s injected `SheetWriteLogPort` to
 * `@hermes/store`'s real `claimSheetWrite`/`completeSheetWrite`/
 * `releaseSheetWrite` functions — the same inline-object-over-`pool` shape
 * `createMessageHandlers` already uses for `llm_dedupe`'s `dedupeRepo`
 * below, not a new binder file: this port has exactly one caller
 * (`sheetsWriteTool`), the same reasoning that kept `dedupeRepo` inline
 * rather than its own `apps/hermes/src/store/build-*.ts` file.
 */
function buildSheetWriteLogRepo(pool: Pool): SheetWriteLogPort {
  return {
    claim: (dedupeKey, input) => claimSheetWrite(pool, dedupeKey, input),
    complete: (dedupeKey, outcome) => completeSheetWrite(pool, dedupeKey, outcome),
    release: (dedupeKey) => releaseSheetWrite(pool, dedupeKey),
  };
}

/**
 * Builds the telemetry recorder and subscribes the gated message-handler
 * dispatch to the channel, in that order. Split out of the boot-wiring
 * orchestrator below so each of its steps reads independently; returns the
 * telemetry recorder so the caller can thread it into `registerShutdown`.
 */
function buildTelemetryRecorderAndSubscribeHandlers(
  channel: TelegramPoller,
  pool: Pool,
  config: Env,
  logger: Logger,
  signal: AbortSignal,
  connectFlow: ConnectFlow | undefined,
  refreshCoordinator: RefreshCoordinator | undefined,
  decryptRefreshToken: ((account: GoogleAccount) => string) | undefined,
): TelemetryRecorderHandle {
  const telemetryRecorder = buildTelemetryRecorder(pool, logger);

  subscribeGatedDispatch({
    channel,
    pool,
    config,
    logger,
    signal,
    telemetryRecorder,
    connectFlow,
    refreshCoordinator,
    decryptRefreshToken,
  });

  return telemetryRecorder;
}

/**
 * Wires the boot-lifetime abort controller, the Telegram channel, the
 * telemetry recorder plus gated message-handler subscription (delegated to
 * `buildTelemetryRecorderAndSubscribeHandlers`), and shutdown registration —
 * the steps that only run once the instance lock is held and the health
 * server is serving. Order preserved exactly as it was inline in `boot()`:
 * controller -> channel -> telemetry recorder -> dispatch subscription ->
 * shutdown registration. `connectFlow`/`oauthCallbackRoute.bind()` are
 * constructed and wired here, once `telegramChannel` exists — see
 * `serveHealth`'s doc comment for why the route itself is constructed
 * earlier, in `boot()`, before the channel exists.
 */
function wireRuntimeAndShutdown(
  telegramClient: TelegramClient,
  pool: Pool,
  config: Env,
  logger: Logger,
  instanceLock: InstanceLock,
  oauthCallbackRoute: OauthCallbackRoute,
): void {
  // Boot-lifetime, not per-request: message updates dispatch concurrently
  // (detached, not awaited by the poll loop — see
  // .ai/decisions/poller-concurrent-message-dispatch.md), so there can be
  // several in-flight completion calls at once. One shared controller is
  // still sufficient because shutdown must abort all of them together, not
  // just whichever one is "current". Aborted as the first step of
  // shutdown() (see above), before the drain wait on channel.stop() —
  // created before the channel below so its signal can be threaded into the
  // poller's getUpdates calls from the start.
  const shutdownController = new AbortController();

  const telegramChannel = createTelegramChannel(
    telegramClient,
    pool,
    logger,
    shutdownController.signal,
  );

  // Built once, shared by buildRefreshSweep and buildSheetsDeps' Sheets
  // AccessTokenPort below — see buildGoogleRefreshCoordinator's doc comment.
  const refreshCoordinator = buildGoogleRefreshCoordinator(config);

  // The narrow decrypt capability /disconnect's handler needs — see
  // buildDecryptRefreshToken's doc comment for why this isn't just the raw
  // cryptoKey threaded through MessageHandlerDeps.
  const decryptRefreshToken = buildDecryptRefreshToken(config);

  const google = buildConnectFlow(pool, config);
  if (google) {
    oauthCallbackRoute.bind({
      connectFlow: google.connectFlow,
      notify: async (chatId, text) => {
        await telegramChannel.send(chatId, text);
      },
      pendingStore: google.pendingStore,
    });
  }

  const telemetryRecorder = buildTelemetryRecorderAndSubscribeHandlers(
    telegramChannel,
    pool,
    config,
    logger,
    shutdownController.signal,
    google?.connectFlow,
    refreshCoordinator,
    decryptRefreshToken,
  );

  // Constructed and started here, strictly after acquireInstanceLockOrExit
  // (boot()'s call order, below) — the sweep's in-process single-flight map
  // is only correct because the advisory lock guarantees exactly one Hermes
  // process per database (Dependencies & Risks). runOnce() fires immediately
  // inside start(), which is what makes "survives a restart" true without
  // waiting out a full REFRESH_SWEEP_INTERVAL_MS.
  const refreshSweep = buildRefreshSweep(pool, telegramChannel, logger, refreshCoordinator);
  refreshSweep?.start(REFRESH_SWEEP_INTERVAL_MS, shutdownController.signal);

  registerShutdown({
    channel: telegramChannel,
    lock: instanceLock,
    pool,
    logger,
    controller: shutdownController,
    telemetryRecorder,
    sweep: refreshSweep ?? { stop: async () => {} },
  });
}

/**
 * Thin entry point, in load-bearing order (see
 * `.ai/architecture.md#boot-and-shutdown-order`): config -> models-priced
 * check -> logger -> pool (waited + migrated) -> webhook cleared -> advisory
 * lock -> health server -> poller -> handlers -> shutdown registration. The
 * models-priced check runs before any DB or network I/O so a misconfigured
 * `LLM_PRIMARY_MODEL`/`LLM_FALLBACK_MODEL` fails fast rather than after a
 * slow or hanging connection attempt. The lock is taken before the health
 * server starts and before the poller exists, so an instance that loses the
 * race never briefly reports healthy and never races Telegram's
 * one-getUpdates-consumer-per-token rule.
 */
export async function boot(): Promise<void> {
  const config = loadConfigOrExit();
  assertModelsPricedOrExit(config);
  const logger = createLogger({ level: config.LOG_LEVEL, fields: { service: "hermes" } });
  logger.info("booting", { config: toRedactedLog(config) });

  const pool = await createMigratedPool(config.DATABASE_URL);
  const telegramClient = await createPollingTelegramClient(config.TELEGRAM_BOT_TOKEN);

  const instanceLock = await acquireInstanceLockOrExit(pool, config.DATABASE_URL, logger);
  if (!instanceLock) return;

  // Constructed before serveHealth so its (unbound) handleRequest can be
  // wired into the health server's router immediately — see serveHealth's
  // doc comment.
  const oauthCallbackRoute = createOauthCallbackRoute({ logger });
  serveHealth(pool, config.PORT, logger, oauthCallbackRoute);

  wireRuntimeAndShutdown(telegramClient, pool, config, logger, instanceLock, oauthCallbackRoute);
}
