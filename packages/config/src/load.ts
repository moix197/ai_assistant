import { type Env, SECRET_ENV_KEYS, envSchema } from "./schema";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parses and validates process.env, throwing a ConfigError naming the failing key. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const key = firstIssue?.path.join(".") || "unknown";
    throw new ConfigError(
      `Invalid environment variable "${key}": ${firstIssue?.message ?? "validation failed"}`,
    );
  }
  return parsed.data;
}

/** Masks fields flagged as secret so config can be logged safely at boot. */
export function toRedactedLog(env: Env): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...env };
  for (const key of SECRET_ENV_KEYS) {
    if (key in redacted) redacted[key] = "***REDACTED***";
  }
  return redacted;
}
