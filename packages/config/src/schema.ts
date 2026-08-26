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

/**
 * Optional string that normalizes an empty string to `undefined`. Compose's
 * `${VAR:-}` passthrough (see docker-compose.yml) sets an unset host var to
 * `""` in the container rather than omitting it — without this, that would
 * read as "present but empty" instead of "absent", breaking the all-or-none
 * check below for a primary-only boot running under `docker compose up`.
 */
const optionalLlmString = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value));

/** The three `LLM_FALLBACK_*` keys, grouped for the all-or-none presence check below. */
const LLM_FALLBACK_KEYS = [
  "LLM_FALLBACK_BASE_URL",
  "LLM_FALLBACK_API_KEY",
  "LLM_FALLBACK_MODEL",
] as const;

/**
 * Enforces the fallback provider profile's all-or-none rule: either none of
 * the three `LLM_FALLBACK_*` keys are set (primary-only boot — a valid,
 * supported configuration) or all three are. A partial fallback config
 * fails boot naming each missing key, rather than silently constructing a
 * half-populated profile — same precedent as `telegramAllowlistSchema`
 * above.
 */
function checkFallbackAllOrNone(
  value: { [K in (typeof LLM_FALLBACK_KEYS)[number]]?: string },
  ctx: z.RefinementCtx,
): void {
  const presentCount = LLM_FALLBACK_KEYS.filter((key) => value[key] !== undefined).length;
  if (presentCount === 0 || presentCount === LLM_FALLBACK_KEYS.length) return;

  for (const key of LLM_FALLBACK_KEYS) {
    if (value[key] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required: LLM_FALLBACK_* keys must all be set or all be absent (partial fallback profile)`,
      });
    }
  }
}

/**
 * Defaults to a de-facto-unlimited cap (rather than failing boot) when the
 * key is entirely absent — same precedent as `PORT`/`LOG_LEVEL` above.
 * Every real deployment sets an explicit value (see `.env.example`); this
 * default exists only so a caller that doesn't touch the budget feature
 * (e.g. an older test fixture) isn't forced to supply one. Compose's
 * `${VAR:-}` passthrough (see docker-compose.yml) still sets an unset host
 * var to `""` in the container rather than omitting it, which `z.coerce
 * .number()` reads as `0` — that fails `.positive()` loudly instead of
 * silently falling through to the default, so a real deployment that leaves
 * this genuinely unset still fails boot naming the key.
 */
const DEFAULT_LLM_MONTHLY_BUDGET_USD = 1_000_000;

export const envSchema = z
  .object({
    DATABASE_URL: z.string().url({ message: "DATABASE_URL must be a valid connection URL" }),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    TELEGRAM_BOT_TOKEN: z.string().min(1, { message: "TELEGRAM_BOT_TOKEN is required" }),
    TELEGRAM_ALLOWLIST: telegramAllowlistSchema,
    LLM_PRIMARY_BASE_URL: z.string().url({ message: "LLM_PRIMARY_BASE_URL must be a valid URL" }),
    LLM_PRIMARY_API_KEY: z.string().min(1, { message: "LLM_PRIMARY_API_KEY is required" }),
    LLM_PRIMARY_MODEL: z.string().min(1, { message: "LLM_PRIMARY_MODEL is required" }),
    LLM_FALLBACK_BASE_URL: optionalLlmString,
    LLM_FALLBACK_API_KEY: optionalLlmString,
    LLM_FALLBACK_MODEL: optionalLlmString,
    LLM_MONTHLY_BUDGET_USD: z.coerce
      .number()
      .positive({ message: "LLM_MONTHLY_BUDGET_USD must be a positive number" })
      .default(DEFAULT_LLM_MONTHLY_BUDGET_USD),
  })
  .superRefine(checkFallbackAllOrNone);

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
  LLM_PRIMARY_BASE_URL: false,
  LLM_PRIMARY_API_KEY: true,
  LLM_PRIMARY_MODEL: false,
  LLM_FALLBACK_BASE_URL: false,
  LLM_FALLBACK_API_KEY: true,
  LLM_FALLBACK_MODEL: false,
  LLM_MONTHLY_BUDGET_USD: false,
};

/** Env keys whose values must never appear unmasked in a log line. */
export const SECRET_ENV_KEYS = (Object.keys(IS_SECRET_ENV_KEY) as Array<keyof Env>).filter(
  (key) => IS_SECRET_ENV_KEY[key],
);
