import { createTelegramClient, createTelegramPoller, parseAllowlist } from "@hermes/channels";
import { ConfigError, type Env, loadConfig, toRedactedLog } from "@hermes/config";
import { createLogger } from "@hermes/core";
import {
  INSTANCE_LOCK_KEY,
  acquireInstanceLock,
  createPool,
  getDefaultMigrationsDir,
  getOffset,
  runMigrations,
  setOffset,
  waitForDatabase,
} from "@hermes/store";
import { createEchoHandler } from "./handlers/echo";
import { startHealthServer } from "./health";

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

/** Thin entry point: load config -> build logger -> run migrations -> serve /health. */
export async function boot(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = createLogger({ level: config.LOG_LEVEL, fields: { service: "hermes" } });
  logger.info("booting", { config: toRedactedLog(config) });

  const pool = createPool(config.DATABASE_URL);
  await waitForDatabase(pool);
  await runMigrations(pool, getDefaultMigrationsDir());

  const telegramClient = createTelegramClient({ token: config.TELEGRAM_BOT_TOKEN });

  // Unconditional and idempotent: getUpdates long-polling and a webhook are
  // mutually exclusive on Telegram's side, so a webhook left over from a
  // previous deployment mode would otherwise silently starve the poller.
  await telegramClient.deleteWebhook();

  // Must happen before the poller starts, never after: Telegram allows one
  // getUpdates consumer per bot token, so a second instance racing this one
  // must fail fast here with a readable error instead of a mysterious 409
  // surfacing later from inside the poll loop.
  const instanceLock = await acquireInstanceLock(INSTANCE_LOCK_KEY, config.DATABASE_URL);
  if (!instanceLock.acquired) {
    await instanceLock.release();
    // No process.exit() here: stdout writes (e.g. Docker's piped stdout) are
    // async, and exiting immediately can drop this log line before it
    // flushes. Setting exitCode and closing the pool lets the event loop
    // drain naturally once the write completes, so the process still exits
    // non-zero without racing the log.
    logger.error("another Hermes instance is already running against this database");
    process.exitCode = 1;
    await pool.end();
    return;
  }

  // Started only after the lock is held: starting it earlier would let a
  // losing second instance briefly report healthy before it exits.
  startHealthServer(pool, config.PORT, {
    onListening: () => logger.info("health server listening", { port: config.PORT }),
    onError: (error) => {
      logger.error("health server error", { error: error.message });
      process.exit(1);
    },
  });

  const telegramChannel = createTelegramPoller({
    client: telegramClient,
    logger,
    offsetRepo: {
      getOffset: () => getOffset(pool),
      setOffset: (updateId: number) => setOffset(pool, updateId),
    },
  });
  const allowlist = parseAllowlist(config.TELEGRAM_ALLOWLIST);
  telegramChannel.subscribe(createEchoHandler(telegramChannel, allowlist, logger));
}
