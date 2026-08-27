# Hermes

A pnpm monorepo: a deterministic, restart-safe assistant. See `plans/ROADMAP.md`
for the overall arc and `plans/02-telemetry.md` for the current build plan.

## Layout

- `apps/hermes` — the process entry point. Thin, in load-bearing order: config
  → models-priced check → logger → pool (waited + migrated) → webhook cleared
  → advisory lock → health server → poller, telemetry and handlers → shutdown
  registration. See `apps/hermes/README.md`.
- `packages/core` — shared types (`Result`, ids, clock, logger, backoff, the
  provider-neutral LLM types, and the telemetry event union + recorder port).
- `packages/config` — env schema validation and redaction.
- `packages/store` — Postgres pool + migration runner + repositories.
- `packages/channels` — chat channel adapters (Telegram, long-polled).
- `packages/llm` — `LlmProvider` port, the OpenAI-compatible adapter, pricing
  and the monthly spend ceiling.
- `packages/telemetry` — buffered telemetry recorder and `/stats` rollup math.

## Setup

1. Copy `.env.example` to `.env`. `TELEGRAM_BOT_TOKEN` (from
   [@BotFather](https://t.me/BotFather)) is not the only required value —
   boot also fails fast without `LLM_PRIMARY_BASE_URL`, `LLM_PRIMARY_API_KEY`
   and `LLM_PRIMARY_MODEL`, and under compose without
   `LLM_MONTHLY_BUDGET_USD` (compose passes an unset host var through as `""`,
   which the schema rejects rather than silently defaulting). A missing or
   invalid key is named in the boot error.
2. Leave `TELEGRAM_ALLOWLIST` empty on first boot (an empty allowlist rejects
   everyone, so nothing can act on the bot yet).
3. Start the full stack: `docker compose up -d`, then message the bot.
4. It sends **no reply at all** — an unknown sender is dropped silently, on
   purpose. It logs a warn line (`"rejected: unknown user"`) carrying your
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

- `pnpm typecheck` — typecheck every package (`pnpm -r typecheck`)
- `pnpm build` — typecheck then build every package (`pnpm -r typecheck && pnpm
  -r build`, in that order — a build over a broken type graph is not worth
  having)
- `pnpm test` — run every package's hermetic tests (`pnpm -r test`)
- `pnpm test:db` — the Postgres integration lane, run serially
  (`--workspace-concurrency=1`) because the suites share one database. Refuses
  to start without `TEST_DATABASE_URL`; see `packages/store/README.md`.
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
