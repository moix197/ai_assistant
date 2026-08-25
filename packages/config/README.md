# @hermes/config

Typed, validated process env, loaded once at boot.

- `envSchema` — a zod schema for `DATABASE_URL`, `PORT` (default `3000`),
  `LOG_LEVEL` (default `"info"`). Telegram vars are added in Phase 2.
- `loadConfig(env = process.env)` — parses and validates; throws a typed
  `ConfigError` naming the exact failing key on the first validation issue.
  Callers (`apps/hermes/src/boot.ts`) are responsible for catching
  `ConfigError` and calling `process.exit(1)` — this package only validates,
  it does not own process lifecycle.
- `toRedactedLog(env)` — returns a copy of the parsed config with every key in
  `SECRET_ENV_KEYS` (currently just `DATABASE_URL`, which embeds a password)
  replaced with `"***REDACTED***"`. Use this, never the raw config, when
  logging.

## Redaction rule

Any env var added to this schema that carries a credential or token must be
added to `SECRET_ENV_KEYS` in the same change.
