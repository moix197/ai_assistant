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
- `pnpm lint` — Biome check across the repo
- `pnpm dev` — run `apps/hermes` natively with `tsx watch`
