# @hermes/config

Typed, validated process env, loaded once at boot.

- `envSchema` — a zod schema for `DATABASE_URL`, `PORT` (default `3000`),
  `LOG_LEVEL` (default `"info"`), `TELEGRAM_BOT_TOKEN` (required), and
  `TELEGRAM_ALLOWLIST` (comma-separated numeric Telegram user ids, default
  `""` meaning "reject everyone"; a non-numeric or empty entry — e.g. from a
  trailing comma — fails boot, naming which entry in the list was bad).
- `loadConfig(env = process.env)` — parses and validates; throws a typed
  `ConfigError` naming the exact failing key on the first validation issue.
  Callers (`apps/hermes/src/boot.ts`) are responsible for catching
  `ConfigError` and calling `process.exit(1)` — this package only validates,
  it does not own process lifecycle.
- `toRedactedLog(env)` — returns a copy of the parsed config with every key in
  `SECRET_ENV_KEYS` (`DATABASE_URL`, which embeds a password, and
  `TELEGRAM_BOT_TOKEN`) replaced with `"***REDACTED***"`. Use this, never the
  raw config, when logging.

## Google OAuth vars

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `TOKEN_ENCRYPTION_KEY` are one
**all-or-none group**, the same `checkFallbackAllOrNone`-style idiom the LLM
fallback profile above uses: set all three and Google features (`/connect
google`, `whoami`) work; set none and they're cleanly absent, boot still
succeeds; set a partial set and boot fails, naming the missing key(s).

- `GOOGLE_CLIENT_ID` — the OAuth2 client id from the Google Cloud console
  (Web application type). Not secret.
- `GOOGLE_CLIENT_SECRET` — the matching client secret. Secret.
- `TOKEN_ENCRYPTION_KEY` — a base64-encoded 32-byte key, validated to decode
  to exactly 32 bytes (AES-256's key size) — a malformed key fails boot with
  a named error instead of failing silently at the first token write, weeks
  later. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
  Secret.

`OAUTH_REDIRECT_BASE_URL` (default `http://localhost:3000`) is validated
**independently** of the group above — it has a default and is meaningful
even before any Google var is set. It must match the redirect URI registered
in the Google Cloud console, with `/oauth/callback` appended.

## Redaction rule

Any env var added to this schema that carries a credential or token must be
added to `SECRET_ENV_KEYS` in the same change.
