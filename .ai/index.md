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
| `@hermes/store` | Postgres pool, migration runner, repositories (`telegram_offset`, `llm_usage`), single-instance advisory lock. | `packages/store` | [telegram-long-polling-correctness](decisions/telegram-long-polling-correctness.md), [llm-cost-accounting](decisions/llm-cost-accounting.md) |
| `@hermes/channels` | `Channel` port + Telegram adapter (client, long-poll loop, allowlist, chunking, backoff). Knows nothing about Postgres. | `packages/channels` | [telegram-long-polling-correctness](decisions/telegram-long-polling-correctness.md) |
| `@hermes/llm` | `LlmProvider` port + one OpenAI-compatible adapter over `fetch` (retries, backoff, timeout, typed errors), the per-model pricing table and cost resolution, and the monthly spend ceiling checked before every call. The only package that talks HTTP to a model provider. | `packages/llm` | [d5-deepseek-primary-gemini-fallback](decisions/d5-deepseek-primary-gemini-fallback.md), [llm-cost-accounting](decisions/llm-cost-accounting.md), [monthly-budget-ceiling](decisions/monthly-budget-ceiling.md), [architecture](architecture.md#dependency-direction) |

Roadmap packages not yet created — `telemetry`, `agent`, `google-*`,
`scheduler`, `ingress` — are deliberately absent until their phase, not an
oversight. See
[d3-monorepo-package-per-concern](decisions/d3-monorepo-package-per-concern.md).

## Cross-cutting

| Concern | Where it's handled | Notes |
| ------- | ------------------ | ----- |
| Secret redaction | `packages/config` (`IS_SECRET_ENV_KEY`, `toRedactedLog`); `packages/channels/src/telegram/client.ts` (`redact`) | Two mechanisms, because Telegram puts the bot token in the URL *path* — no header-based scheme masks it, so every error string is redacted before leaving the client. `IS_SECRET_ENV_KEY` is exhaustive over `Env`: a new env var fails to compile until its secret-ness is declared. |
| Inbound authorization | `apps/hermes/src/handlers/with-allowlist.ts`, `with-private-chat.ts`, composed once in `boot.ts` | Gates are wrappers around the dispatcher, never per-handler checks — a new handler cannot forget one. Empty `TELEGRAM_ALLOWLIST` rejects everyone (fail closed); rejections log the numeric id at warn, which is the intended bootstrap path for discovering your own id. |
| Single-instance enforcement | `INSTANCE_LOCK_KEY` (`837_452_910`) + `acquireInstanceLock` in `packages/store/src/advisory-lock.ts` | Dedicated `pg.Client` outside the pool. See [telegram-long-polling-correctness](decisions/telegram-long-polling-correctness.md). |
| Handler idempotency | A contract, not code | The offset persists *after* handling, so a crash replays exactly one update. Echo is safe by inspection. **The completion handler is not**: it calls a paid API and carries no dedupe key yet, so a crash-and-redeliver can bill twice — invariant #4 is knowingly violated until `plans/01-llm-port.md` Phase 5 lands the key. Accepted for development traffic only; see that plan's `Dependencies & Risks`. |
| LLM cost accounting | `packages/llm/src/pricing.ts` + adapter success path; row written via injected `LlmUsageRepo`, wired in `apps/hermes/src/llm/build-llm-provider.ts` | Provider `total_tokens` is authoritative; `input_tokens` stores the cache-**miss** portion only; unknown model → `warn` + `$0`, never a throw. All of it in [llm-cost-accounting](decisions/llm-cost-accounting.md) — read before touching pricing or the usage row. |
| Cache-stable prompt ordering (invariant #6) | `buildRequestBody` in `packages/llm/src/adapter/openai-compatible.ts` | Every request is ordered `tools` → `system` → `messages`, volatile content (timestamps, ids) last. `JSON.stringify` preserves key insertion order, so that order *is* the wire prefix — one moving byte near the front invalidates the provider's prefix cache. Measured live on DeepSeek across an identical 3190-token prefix: cold `cacheHitTokens 0` at $0.001427, warm `cacheHitTokens 3072` at $0.000144 — ~10x. Proof: `packages/llm/src/__tests__/live/cache-hit-tokens.live.test.ts` (`pnpm test:live`, real money). It seeds its prefix per run on purpose: a constant prefix stays warm in the provider's cache, so the cold→warm transition becomes unobservable and the test passes proving nothing. |
| Spend ceiling | `packages/llm/src/budget/` (`resolveBudgetCapUsd`, `assertBudgetNotExceeded`), called first in the adapter's `complete()`; cap from `LLM_MONTHLY_BUDGET_USD`, wired in `apps/hermes/src/llm/build-llm-provider.ts` | The project's only automated defense against a runaway bill (ROADMAP §7). Checked **before** `fetch`, so a breach costs zero provider calls; `>=` blocks at the exact cap; window is the current UTC calendar month off an injected `Clock`. `usageRepo`/`budget` are required adapter options so it can't be bypassed by omission. Bounds spend to within one call's cost of the cap, not an exact stop — [monthly-budget-ceiling](decisions/monthly-budget-ceiling.md). |
| Telemetry | Port only, in `@hermes/core` | Nothing imports an implementation and nothing calls the port yet. `apps/hermes` injects the impl in Phase 2; importing `telemetry` directly would cycle through half the tree. |
