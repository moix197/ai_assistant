import {
  type InboundMessage,
  type TelegramClient,
  type TelegramPoller,
  createTelegramClient,
  createTelegramPoller,
  parseAllowlist,
} from "@hermes/channels";
import { ConfigError, type Env, loadConfig, toRedactedLog } from "@hermes/config";
import { type Logger, createLogger } from "@hermes/core";
import {
  INSTANCE_LOCK_KEY,
  type Pool,
  acquireInstanceLock,
  claim as claimDedupe,
  complete as completeDedupe,
  createPool,
  getDefaultMigrationsDir,
  getOffset,
  runMigrations,
  setOffset,
  waitForDatabase,
} from "@hermes/store";
import { createCompletionHandler } from "./handlers/complete";
import { createPingHandler } from "./handlers/ping";
import { createStartHandler } from "./handlers/start";
import { withAllowlist } from "./handlers/with-allowlist";
import { withPrivateChat } from "./handlers/with-private-chat";
import { startHealthServer } from "./health";
import { buildLlmProvider } from "./llm/build-llm-provider";
import { buildProviderProfiles } from "./llm/build-provider-profiles";

/**
 * Bounded wait for in-flight work to drain before moving on to lock release.
 * Kept well under HARD_EXIT_TIMEOUT_MS (3s of gap) so lock.release(),
 * pool.end() and the final log still have room to run before the hard-exit
 * fallback fires.
 */
const DRAIN_TIMEOUT_MS = 5_000;
/**
 * Guards against any shutdown step hanging past the container's stop grace
 * period (10s by default). Set 2s under that ceiling so the forced
 * `process.exit(1)` and its log line still land before Docker sends SIGKILL,
 * while leaving DRAIN_TIMEOUT_MS enough room above it for the post-drain
 * steps (see above).
 */
const HARD_EXIT_TIMEOUT_MS = 8_000;

/**
 * Matches a command allowing Telegram's optional `@botusername` suffix
 * (sent in groups, and by some clients even in DMs) — not a full command
 * parser, just this one allowance. `text` must otherwise equal `command`
 * exactly; no argument parsing.
 */
export function matchesCommand(text: string, command: string): boolean {
  return text === command || text.startsWith(`${command}@`);
}

export interface DispatchCommandDeps {
  pingHandler: (message: InboundMessage) => Promise<void>;
  startHandler: (message: InboundMessage) => Promise<void>;
  completionHandler: (message: InboundMessage) => Promise<void>;
}

/**
 * Command dispatch, extracted to a factory (rather than left inline in
 * `boot()`) so it can be composed under `withAllowlist(withPrivateChat(...))`
 * in a test the same way `boot()` composes it for real — see
 * `__tests__/dispatch-allowlist-gates-llm.test.ts`. `/ping` and `/start`
 * short-circuit; anything else falls through to `completionHandler`, which
 * replaced `echoHandler` here — `echo.ts` stays in the tree as a documented
 * reference/fallback but is no longer wired.
 */
export function createDispatchCommand(
  deps: DispatchCommandDeps,
): (message: InboundMessage) => Promise<void> {
  return function dispatchCommand(message: InboundMessage): Promise<void> {
    if (matchesCommand(message.text, "/ping")) return deps.pingHandler(message);
    if (matchesCommand(message.text, "/start")) return deps.startHandler(message);
    return deps.completionHandler(message);
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
}

/**
 * The ordered, load-bearing shutdown sequence: (0) abort the boot-lifetime
 * `AbortController`, so any in-flight LLM completion call's `fetch` rejects
 * promptly instead of running out its timeout; (1) `channel.stop()` flips
 * the poller's stopping flag so no new `getUpdates` call starts, then awaits
 * the in-flight handler — bounded here so a stuck drain doesn't block the
 * rest of shutdown forever; (2) release the advisory lock, only once no more
 * DB work from this instance is possible, so a restart-racing instance can't
 * acquire it mid-drain; (3) close the pool; (4) `process.exit(0)`. Each step
 * is a precondition for the next: releasing the lock before the drain
 * finishes would let a second instance start while we're still querying;
 * closing the pool before the drain finishes would crash an in-flight query.
 */
export async function shutdown(deps: ShutdownDeps): Promise<void> {
  const drainTimeoutMs = deps.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  deps.controller.abort();
  await withTimeout(deps.channel.stop(), drainTimeoutMs);
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

/** `/health` on the configured port, with boot-logger reporting for both outcomes. */
function serveHealth(pool: Pool, port: number, logger: Logger): void {
  startHealthServer(pool, port, {
    onListening: () => logger.info("health server listening", { port }),
    onError: (error) => {
      logger.error("health server error", { error: error.message });
      process.exit(1);
    },
  });
}

/** The poller bound to its Postgres-backed offset store and the fatal-error exit path. */
function createTelegramChannel(client: TelegramClient, pool: Pool, logger: Logger): TelegramPoller {
  return createTelegramPoller({
    client,
    logger,
    offsetRepo: {
      getOffset: () => getOffset(pool),
      setOffset: (updateId: number) => setOffset(pool, updateId),
    },
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
}

/**
 * The three handlers `dispatchCommand` routes between, each wired to real
 * infrastructure. echoHandler stays available (createEchoHandler,
 * "./handlers/echo") as a documented reference/fallback but is no longer
 * wired — completionHandler is dispatchCommand's fallthrough now.
 */
function createMessageHandlers(deps: MessageHandlerDeps): DispatchCommandDeps {
  const { channel, pool, config, logger, signal } = deps;
  const providerProfiles = buildProviderProfiles(config);
  const llmProvider = buildLlmProvider(pool, providerProfiles.primary, logger, config, signal);

  return {
    pingHandler: createPingHandler(channel, pool),
    startHandler: createStartHandler(channel, pool),
    completionHandler: createCompletionHandler({
      channel,
      llmProvider,
      model: providerProfiles.primary.model,
      logger,
      dedupeRepo: {
        claim: (dedupeKey: string) => claimDedupe(pool, dedupeKey),
        complete: (dedupeKey: string, resultText: string) =>
          completeDedupe(pool, dedupeKey, resultText),
      },
    }),
  };
}

/**
 * Every handler (ping/start/completion) must pass both gates — composed once
 * here rather than duplicated per handler, so neither check can be forgotten
 * by a future handler. Allowlist runs outermost so an unknown sender is
 * rejected before the private-chat check even looks at them — and, since
 * completionHandler is the fallthrough, before it ever reaches
 * `llmProvider.complete()`, so an unknown sender never costs anything.
 */
function subscribeGatedDispatch(deps: MessageHandlerDeps): void {
  const { channel, config, logger } = deps;
  const dispatchCommand = createDispatchCommand(createMessageHandlers(deps));
  const allowlist = parseAllowlist(config.TELEGRAM_ALLOWLIST);
  channel.subscribe(withAllowlist(withPrivateChat(dispatchCommand, logger), allowlist, logger));
}

/**
 * Thin entry point, in load-bearing order (see
 * `.ai/architecture.md#boot-and-shutdown-order`): config -> logger -> pool
 * (waited + migrated) -> webhook cleared -> advisory lock -> health server ->
 * poller -> handlers -> shutdown registration. The lock is taken before the
 * health server starts and before the poller exists, so an instance that
 * loses the race never briefly reports healthy and never races Telegram's
 * one-getUpdates-consumer-per-token rule.
 */
export async function boot(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = createLogger({ level: config.LOG_LEVEL, fields: { service: "hermes" } });
  logger.info("booting", { config: toRedactedLog(config) });

  const pool = await createMigratedPool(config.DATABASE_URL);
  const telegramClient = await createPollingTelegramClient(config.TELEGRAM_BOT_TOKEN);

  const instanceLock = await acquireInstanceLock(INSTANCE_LOCK_KEY, config.DATABASE_URL);
  if (!instanceLock.acquired) {
    await instanceLock.release();
    await exitAfterLostInstanceLock(pool, logger);
    return;
  }

  serveHealth(pool, config.PORT, logger);
  const telegramChannel = createTelegramChannel(telegramClient, pool, logger);

  // Boot-lifetime, not per-request: the poller is serial (never more than
  // one in-flight completion call), so one shared controller is sufficient.
  // Aborted as the first step of shutdown() (see above), before the drain
  // wait on channel.stop().
  const shutdownController = new AbortController();

  subscribeGatedDispatch({
    channel: telegramChannel,
    pool,
    config,
    logger,
    signal: shutdownController.signal,
  });

  registerShutdown({
    channel: telegramChannel,
    lock: instanceLock,
    pool,
    logger,
    controller: shutdownController,
  });
}
