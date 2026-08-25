import { z } from "zod";

/**
 * Comma-separated numeric Telegram user ids. Rejects any non-numeric entry
 * (including a trailing-comma-induced empty entry) at boot, naming the bad
 * entry, rather than silently dropping it — fail closed. Empty is valid and
 * means "reject everyone" (see `parseAllowlist`/`isAllowed` in
 * `@hermes/channels`).
 */
const telegramAllowlistSchema = z
  .string()
  .default("")
  .superRefine((value, ctx) => {
    const trimmed = value.trim();
    if (trimmed === "") return;
    const rawEntries = trimmed.split(",");
    for (const [index, rawEntry] of rawEntries.entries()) {
      const entry = rawEntry.trim();
      if (!/^\d+$/.test(entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `TELEGRAM_ALLOWLIST entry ${index + 1} of ${rawEntries.length} ("${rawEntry}") is not a valid numeric Telegram user id`,
        });
      }
    }
  });

export const envSchema = z.object({
  DATABASE_URL: z.string().url({ message: "DATABASE_URL must be a valid connection URL" }),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TELEGRAM_BOT_TOKEN: z.string().min(1, { message: "TELEGRAM_BOT_TOKEN is required" }),
  TELEGRAM_ALLOWLIST: telegramAllowlistSchema,
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
  TELEGRAM_BOT_TOKEN: true,
  TELEGRAM_ALLOWLIST: false,
};

/** Env keys whose values must never appear unmasked in a log line. */
export const SECRET_ENV_KEYS = (Object.keys(IS_SECRET_ENV_KEY) as Array<keyof Env>).filter(
  (key) => IS_SECRET_ENV_KEY[key],
);
