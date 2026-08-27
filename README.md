# Hermes

A pnpm monorepo: a deterministic, restart-safe assistant. See `plans/ROADMAP.md`
and `plans/00-skeleton.md` for the current build plan.

## Layout

- `apps/hermes` — the process entry point (thin: config → logger → store →
  channels).
- `packages/core` — shared types (`Result`, ids, clock, logger, telemetry
  port).
- `packages/config` — env schema validation and redaction.
- `packages/store` — Postgres pool + migration runner.
- `packages/channels` — chat channel adapters (Telegram, long-polled).

## Setup

1. Copy `.env.example` to `.env` and fill in `TELEGRAM_BOT_TOKEN` — get one
   from [@BotFather](https://t.me/BotFather).
2. Leave `TELEGRAM_ALLOWLIST` empty on first boot (an empty allowlist rejects
   everyone, so nothing can act on the bot yet).
3. Start the full stack: `docker compose up -d`, then message the bot.
4. It replies with `"rejected: unknown user"` and logs a warn line with your
   numeric Telegram id in the `channelUserId` field —
   `docker compose logs hermes` to find it.
5. Set `TELEGRAM_ALLOWLIST` in `.env` to that id, then run
   `docker compose up -d hermes` to pick up the change — **not**
   `docker compose restart`, which does not re-read `.env`.

## Local development

1. Start Postgres only: `docker compose up -d postgres`
2. Install deps: `pnpm install`
3. Export `DATABASE_URL` (not committed — `.env` is gitignored) pointing at
   the compose Postgres, e.g. `postgres://hermes:hermes@localhost:5432/hermes`.
4. Run the app natively against compose-owned Postgres: `pnpm dev`

Source is not bind-mounted into the `hermes` container — hot-reload via bind
mount is slow/flaky on WSL2/Windows, so the dev loop runs natively on the host
against Docker-owned Postgres instead.

## Full container stack

`docker compose up --build` builds and runs both `postgres` and `hermes`.
Verify with:

```
curl -i localhost:3000/health
```

## Scripts

- `pnpm build` — build every package (`pnpm -r build`)
- `pnpm test` — run every package's tests (`pnpm -r test`)
- `pnpm test:live` — the §8 live tool-calling check in `@hermes/llm`. Excluded
  from `pnpm test`: it spends real money against live provider APIs and skips
  itself unless both `LLM_*` profiles are set.
- `pnpm lint` — Biome check across the repo
- `pnpm dev` — run `apps/hermes` natively with `tsx watch`

## CI

`.github/workflows/ci.yml` runs on every push and pull request against `main`:
`pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`, then `pnpm test:db`
against a `postgres:16` service container (`TEST_DATABASE_URL` points at a
`hermes_ci_test` database, so the `test:db` guard passes as written). The build
step is not optional — the suites resolve cross-package imports through each
package's `dist`.

`pnpm test:live` is deliberately **never** run in CI: it makes real billed
provider calls and has been seen failing on free-tier quota. Run it by hand
periodically — a live-provider regression is caught nowhere else.
`packages/llm/src/__tests__/live-lane-excluded.test.ts` proves the exclusion
still holds. See `.ai/decisions/ci-lane-policy.md`.
