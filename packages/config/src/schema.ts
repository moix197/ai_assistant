import { z } from "zod";

export const envSchema = z.object({
  DATABASE_URL: z.string().url({ message: "DATABASE_URL must be a valid connection URL" }),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Exhaustive over `Env`'s keys: adding a var to `envSchema` without adding a
 * matching entry here is a compile error, forcing a deliberate secret/not-secret
 * decision (e.g. for `TELEGRAM_BOT_TOKEN` in Phase 2) instead of a silent leak.
 */
export const IS_SECRET_ENV_KEY: Record<keyof Env, boolean> = {
  DATABASE_URL: true,
  PORT: false,
  LOG_LEVEL: false,
};

/** Env keys whose values must never appear unmasked in a log line. */
export const SECRET_ENV_KEYS = (Object.keys(IS_SECRET_ENV_KEY) as Array<keyof Env>).filter(
  (key) => IS_SECRET_ENV_KEY[key],
);
