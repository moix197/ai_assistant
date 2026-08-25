import { ConfigError, type Env, loadConfig, toRedactedLog } from "@hermes/config";
import { createLogger } from "@hermes/core";
import { createPool, getDefaultMigrationsDir, runMigrations, waitForDatabase } from "@hermes/store";
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

  startHealthServer(pool, config.PORT, {
    onListening: () => logger.info("health server listening", { port: config.PORT }),
    onError: (error) => {
      logger.error("health server error", { error: error.message });
      process.exit(1);
    },
  });
}
