# Knowledge Index

The map agents read first. One row per module/package: its single responsibility,
where it lives, and links to any decision or pattern doc. Keep rows terse —
this is a lookup table, not documentation. Retire rows that no longer point
anywhere real.

## Modules

| Module / package | Responsibility (one line) | Path | Decisions / patterns |
| ---------------- | ------------------------- | ---- | -------------------- |
| `hermes` (app) | Thin entrypoint: wiring, boot order, handler composition, ordered shutdown. No business logic. | `apps/hermes` | [architecture](architecture.md#boot-and-shutdown-order), [lean-docker-build](decisions/lean-docker-build.md) |
| `@hermes/core` | Shared primitives, zero deps: `Result`, ids, `Clock`, JSON-line logger, telemetry recorder **port** (no impl). | `packages/core` | [architecture](architecture.md#dependency-direction) |
| `@hermes/config` | Zod env schema, fail-fast `loadConfig()`, secret redaction for log lines. | `packages/config` | — |
| `@hermes/store` | Postgres pool, migration runner, repositories, single-instance advisory lock. | `packages/store` | [telegram-long-polling-correctness](decisions/telegram-long-polling-correctness.md) |
| `@hermes/channels` | `Channel` port + Telegram adapter (client, long-poll loop, allowlist, chunking, backoff). Knows nothing about Postgres. | `packages/channels` | [telegram-long-polling-correctness](decisions/telegram-long-polling-correctness.md) |

Roadmap packages not yet created — `telemetry`, `llm`, `agent`, `google-*`,
`scheduler`, `ingress` — are deliberately absent until their phase, not an
oversight. See
[d3-monorepo-package-per-concern](decisions/d3-monorepo-package-per-concern.md).

## Cross-cutting

| Concern | Where it's handled | Notes |
| ------- | ------------------ | ----- |
| Secret redaction | `packages/config` (`IS_SECRET_ENV_KEY`, `toRedactedLog`); `packages/channels/src/telegram/client.ts` (`redact`) | Two mechanisms, because Telegram puts the bot token in the URL *path* — no header-based scheme masks it, so every error string is redacted before leaving the client. `IS_SECRET_ENV_KEY` is exhaustive over `Env`: a new env var fails to compile until its secret-ness is declared. |
| Inbound authorization | `apps/hermes/src/handlers/with-allowlist.ts`, `with-private-chat.ts`, composed once in `boot.ts` | Gates are wrappers around the dispatcher, never per-handler checks — a new handler cannot forget one. Empty `TELEGRAM_ALLOWLIST` rejects everyone (fail closed); rejections log the numeric id at warn, which is the intended bootstrap path for discovering your own id. |
| Single-instance enforcement | `INSTANCE_LOCK_KEY` (`837_452_910`) + `acquireInstanceLock` in `packages/store/src/advisory-lock.ts` | Dedicated `pg.Client` outside the pool. See [telegram-long-polling-correctness](decisions/telegram-long-polling-correctness.md). |
| Handler idempotency | A contract, not code | The offset persists *after* handling, so a crash replays exactly one update. Echo is safe by inspection; any future handler with an external side effect must carry its own dedupe key (ROADMAP invariant #4). |
| Telemetry | Port only, in `@hermes/core` | Nothing imports an implementation and nothing calls the port yet. `apps/hermes` injects the impl in Phase 2; importing `telemetry` directly would cycle through half the tree. |
