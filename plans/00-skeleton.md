# Plan: Skeleton & Telegram Channel (Roadmap Phases 0–1)

**Created:** 2026-08-25
**Branch:** `feat/00-skeleton-telegram`
**Status:** not started

## Context

Hermes's repo is git-initialized on `master` with no commits yet; `.ai/`,
`.claude/skills/`, `CLAUDE.md`, `plans/ROADMAP.md`, `.gitignore`, and
`.gitattributes` are already staged. This PRD implements Roadmap Phases 0 and
1 only: the pnpm monorepo skeleton,
Docker/Postgres, and the Telegram control channel. It stops at a deterministic,
crash-safe echo bot with no AI behind it. `packages/llm` and `packages/agent`
are explicitly out of scope — they are Phase 2's PRD (`plans/01-llm-port.md`
onward per ROADMAP §8).

Packages created here, per the roadmap's "create at its phase, never
merge-then-split" rule (§3): `apps/hermes`, `packages/core`, `packages/config`,
`packages/store`, `packages/channels`.

## Risk: medium

Low implementation complexity, but two correctness-critical properties live in
this PRD: Telegram's at-least-once `getUpdates` semantics (a bug here loses
messages silently, forever — Telegram never resends an acked update) and the
single-instance poller constraint (a bug here causes a mysterious, hard-to-diagnose
409 in production instead of a clear startup error).

## Dependencies & Risks

- **Repo has no commits yet.** `git worktree add` needs a base ref that
  resolves to a commit, so Phase 0 below commits the already-staged files
  as-is (no regeneration) before branching — see Phase 0.
- **External dependency: a Telegram bot token.** Phases 2–4 cannot be manually
  verified without one. See `## Prerequisites` below.
- **Order-sensitive: advisory lock before poller start, released last at shutdown.**
  The Postgres session advisory lock (Phase 3) is acquired on a dedicated
  `pg.Client` created outside the pool — never a pooled connection, since the
  pool could hand that connection to unrelated queries or recycle it, silently
  dropping the lock — *before* the long-poll loop starts, and held for the
  process lifetime. Phase 4's shutdown sequence must release it explicitly
  (`pg_advisory_unlock` + close) only after in-flight work has drained and
  before `pool.end()`; before Phase 4 lands, any exit still releases it
  implicitly (closing a connection frees its session-level locks), just not
  as part of an ordered drain.
- **Order-sensitive: offset persisted after handling, not before.** Getting this
  backwards is the single highest-impact bug this PRD can ship (ROADMAP §5,
  Phase 1) — a crash between "handler completed" and "offset persisted" replays
  that one update on restart, which is why every handler this PRD ships (just
  echo) must tolerate being invoked twice for the same update. Phase 3's tests
  assert the ordering explicitly, and one test (`poller-crash-replay.test.ts`)
  simulates the crash and asserts the replay actually happens, not just the
  end-state.
- **Order-sensitive shutdown: drain → release lock → close pool, in that order.**
  Closing the pg pool while a query is in flight crashes the request; releasing
  the advisory lock before draining lets a racing second instance grab it while
  this one is still mid-query. Phase 4 formalizes the full five-step sequence.
- **No dependency on `packages/llm` / `packages/agent`.** Nothing in this PRD
  imports or stubs them — they don't exist yet and aren't referenced.
- **Single points of failure accepted, not solved here:** the poller cannot be
  horizontally scaled (Telegram allows one `getUpdates` consumer per token).
  This is a known, accepted constraint (ROADMAP D4), not a bug to fix.

## Prerequisites (manual, before Phase 2)

**Mode:** hil

- [ ] Message `@BotFather` on Telegram, run `/newbot`, record the bot token.
- [ ] Set `TELEGRAM_BOT_TOKEN` in a local `.env` (never committed — confirm
      `.env` is in `.gitignore` from Phase 1).
- [ ] Leave `TELEGRAM_ALLOWLIST` **empty** for the first boot. Your numeric
      Telegram user id isn't known yet — Phase 2's verification steps are the
      intended way to discover it: message the bot once, read your id off the
      "rejected, unknown user" warn-level log line, then set
      `TELEGRAM_ALLOWLIST` and restart. This is why the roadmap treats rejection
      logging as the bootstrap path rather than a separate lookup tool.

---

### Phase 0: Create worktree

**This phase is always first. No exceptions** (plan-sequential format spec —
worktree creation is a plan phase, not something `/execute-prd` does on its
own behalf).

Git is already initialized (`master`, no commits) with `.ai/`,
`.claude/skills/`, `CLAUDE.md`, `plans/ROADMAP.md`, `.gitignore`, and
`.gitattributes` already staged. This phase commits that pre-existing staged
content as-is — it does not regenerate, edit, or re-stage any of it — because
`master` needs at least one commit before it's a valid worktree base ref.

**Steps:**

- [ ] Confirm with the user: branch name `feat/00-skeleton-telegram`, base ref `master`
- [ ] Review currently-staged files (`git status`) to confirm they match the
      expected set above; do not add or modify any of them
- [ ] `git commit` the staged files as the initial commit on `master`
- [ ] `git worktree add ../hermes-00-skeleton -b feat/00-skeleton-telegram master`
- [ ] Verify worktree is active and on the correct branch: `git worktree list`

---

### Phase 1: Monorepo scaffold, Postgres, migrations, config, health

**Risk:** low
**Mode:** afk
**Type:** backend
**Success criteria:** An operator runs `docker compose up`, Postgres becomes
healthy, `hermes` boots without a crash loop, and `curl localhost:3000/health`
returns `200` with a JSON body reporting DB connectivity. This is the one
allowed pure-infrastructure phase before the first feature slice (per
plan-sequential's exception clause) — there is no user-facing feature to slice
thinner than "the process boots and can prove it's alive," and every later
phase depends on config/logger/store/migrations existing first.
**Commit message:** `feat: scaffold monorepo, Postgres, migrations, config, health endpoint`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, `biome.json` | workspace wiring + lint/format config (`.gitignore`/`.gitattributes` already exist from Phase 0 — not touched here) |
| create | `docker-compose.yml`, `Dockerfile` | postgres + hermes services; 3-stage lean build (deps/build → `pnpm deploy --filter hermes --prod` → runtime) |
| create | `packages/core/**` (`package.json`, `tsconfig.json`, `src/result.ts`, `src/ids.ts`, `src/clock.ts`, `src/logger.ts` (port + JSON-line impl), `src/telemetry.ts` (recorder port only, no impl), `src/index.ts`) | shared types, Result/error types, ids, clock, logger port + hand-rolled implementation, telemetry recorder **port** (stub interface; implementation is Phase 2 per ROADMAP §3) |
| create | `packages/config/**` (`src/schema.ts`, `src/load.ts`, `src/index.ts`) | zod env schema, `parse(process.env)` at boot, exit(1) on failure naming the exact var; redacted-log helper that masks secret fields |
| create | `packages/store/**` (`src/pool.ts`, `src/migrate.ts`, `src/migrations/` (empty at this phase), `bin/migrate.ts`, `src/index.ts`) | pg pool, migration runner (creates `schema_migrations` tracking table itself, applies `NNN_*.sql` files in filename order, one transaction each, abort on first failure), standalone CLI entry sharing the same runner function as the boot path |
| create | `apps/hermes/**` (`src/index.ts`, `src/boot.ts`, `src/health.ts`) | thin entrypoint: load config → build logger → run migrations → start `node:http` `/health` server. No business logic in `index.ts` — it only wires. |

**Steps:**

- [x] Root workspace config (`pnpm-workspace.yaml` listing `apps/*`, `packages/*`; strict `tsconfig.base.json`; tsup + vitest + **Biome** devDeps at the root — one dependency covering both lint and format, replacing an eslint+prettier+plugins stack; settled choice, fits "minimize the dependency footprint" better given TS strict already catches most real defects)
- [x] `biome.json`: enable the recommended lint rule set + formatter, scoped to `apps/*/src` and `packages/*/src`
- [x] `packages/core`: `Result<T, E>` type, `newId()`, `Clock` interface + real impl, JSON-line logger (`{ ts, level, msg, ...fields }`, ~30 lines, no deps), `TelemetryRecorder` port interface with no implementation. This is a deliberate exception to "no speculative abstractions": ROADMAP's boundary rule ("nothing imports `telemetry` directly; packages depend on the recorder *port* in `core`") requires the port to exist before Phase 2 wires an implementation through it, or the port gets retrofitted through half the tree later. Zero runtime footprint — it's a type-only export, nothing calls it yet
- [x] `packages/config`: zod schema covering `DATABASE_URL`, `PORT`, `LOG_LEVEL` (Telegram vars added in Phase 2); `loadConfig()` throws a typed error naming the failing key; a `toRedactedLog()` helper masking anything schema-flagged as secret
- [x] `packages/store`: `createPool(databaseUrl)`, `runMigrations(pool, migrationsDir)` (ensures tracking table, reads `*.sql` sorted by filename, skips already-applied ids, wraps each in a transaction), `bin/migrate.ts` CLI calling the same function
- [x] `apps/hermes/src/boot.ts`: `loadConfig()` → build logger (log the **redacted** config once) → `createPool()` → `runMigrations()` → start health server. Export a `boot()` function; `index.ts` just calls it — keeps the entry point thin per CLAUDE.md
- [x] `apps/hermes/src/health.ts`: `node:http` server, `/health` runs `SELECT 1` against the pool, returns `{ status: "ok" | "error", db: "connected" | "disconnected" }`
- [x] `Dockerfile`: stage 1 `node:22-alpine` + pnpm, `--frozen-lockfile` install, `pnpm -r build`; stage 2 `pnpm deploy --filter hermes --prod out/`; stage 3 minimal runtime, `COPY --from=deploy out/ .`, `CMD ["node", "dist/index.js"]` (exec form — required for SIGTERM to reach Node, needed by Phase 4)
- [x] `docker-compose.yml`: `postgres` (named volume, healthcheck `pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB`, interval 10s/timeout 5s/retries 5/start_period 30s) + `hermes` (`depends_on: postgres: condition: service_healthy`, `replicas: 1`); note in a comment that `depends_on` only gates container *start*, so `createPool`/health still needs its own retry-on-connect
- [x] Root `package.json` scripts: `build` (`pnpm -r build`), `test` (`pnpm -r test`), `lint` (`biome check .`), `dev` (`tsx watch apps/hermes/src/index.ts`) — dev loop runs natively against compose-owned Postgres, no bind-mounted source in compose (documented decision: hot-reload via bind mount is slow/flaky on WSL2/Windows)
- [x] Root `README.md`: how to run (`docker compose up -d postgres`, `pnpm install`, `pnpm dev`; or full `docker compose up --build`)
- [x] Per-package `README.md` stubs (see Documentation table)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/core/src/__tests__/logger.test.ts` | JSON-line shape, level filtering, field merging |
| create | `packages/core/src/__tests__/result.test.ts` | `Result` ok/err construction and narrowing |
| create | `packages/config/src/__tests__/schema.test.ts` | valid env parses; each required var missing/malformed fails with a message naming that var; redaction helper masks secret fields |
| create | `packages/store/src/__tests__/migrate.test.ts` | pure ordering logic (filenames sorted correctly) as a unit test; an integration test (skipped unless `TEST_DATABASE_URL` is set, documented in `packages/store/README.md`) verifying: tracking table auto-created, migrations applied once, re-run is a no-op, a failing migration aborts and does not record itself as applied |

**Verification:**

- [x] `pnpm install && pnpm -r build && pnpm -r test` — all green
- [x] `docker compose up -d` → `docker compose ps` shows `postgres` healthy and `hermes` running (not restarting)
- [x] `curl -i localhost:3000/health` → `200` with `{"status":"ok","db":"connected"}`
- [x] `docker compose restart hermes` → still healthy (migration runner is idempotent — no error on an empty or already-applied migration set)
- [x] `docker compose logs hermes` shows the boot log line with a **redacted** config, never a raw secret

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: scaffold monorepo, Postgres, migrations, config, health endpoint`
- [x] Phase marked complete

**Phase 1 — implementation notes (deviations from the written steps):**

- Base ref was `main`, not `master` (Phase 0's premise was stale — the repo
  already had commits). Worktree: `../hermes-00-skeleton`.
- Root package renamed `hermes-monorepo`: the written `pnpm deploy --filter
  hermes` matched two projects (`ERR_PNPM_CANNOT_DEPLOY_MANY`) because the root
  was also named `hermes`. Final form: `pnpm deploy --filter ./apps/hermes
  --prod --legacy /out` (`--legacy` required on pnpm >= 10 for non-injected
  workspaces).
- Added a real `typecheck` script per package; root `build` is
  `pnpm -r typecheck && pnpm -r build`. Without it, `apps/hermes` imported `pg`
  undeclared and nothing caught it (tsup strips types). `health.ts` now uses a
  `Pool` type re-exported from `@hermes/store`, keeping `pg` as store's concern.
- `docker-compose.yml` publishes `5432:5432` — the README's dev loop
  (`pnpm dev` against compose-owned Postgres) could not connect otherwise.
- `tsconfig.base.json` keeps `baseUrl`/`paths` (`@hermes/* -> src`). Dropping it
  would catch a removed workspace dep, but breaks typecheck on a clean clone:
  with `dist/` absent, `pnpm -r typecheck` fails `TS2307` for all three
  workspace packages, and typecheck runs before build. Frozen-lockfile install
  in Docker is the backstop.
- `IS_SECRET_ENV_KEY: Record<keyof Env, boolean>` in `packages/config` — adding
  an env var (Phase 2's `TELEGRAM_BOT_TOKEN`) is now a compile error until its
  secret-ness is declared.
- `waitForDatabase` retry in `store/src/pool.ts`, closing the `depends_on` gap
  this phase's own compose comment flags.
- Dockerfile runtime stage runs as `USER node`, not root.
- Commits: `3328ef3` (scaffold), `c541110` (review fixes), `d78de4c` (nits).

---

### Phase 2: Telegram echo with allowlist

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** You text the bot and get a deterministic echo back. A
message from a Telegram user id not on the allowlist is dropped before it
reaches any handler, and the rejection is logged at warn with the sender's
numeric id — this doubles as how you discover your own id (see Prerequisites).
**Commit message:** `feat: telegram channel port and adapter with allowlist echo`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/channels/package.json`, `src/channel.ts` | `Channel` port: `subscribe(handler)`, `send(target, text)`, capability flags (`markdown`, `files`, `buttons`, `maxMessageLength`) |
| create | `packages/channels/src/telegram/client.ts` | raw-`fetch` wrapper: `getUpdates`, `sendMessage` — no telegraf/grammy, per dependency policy; the token lives in the URL path (Telegram's own scheme), so every log/error path redacts it |
| create | `packages/channels/src/telegram/poller.ts` | long-poll loop (`timeout=30s`, `limit=100`, `allowed_updates=["message","edited_message"]`); in-memory offset only at this phase — persistence is Phase 3 |
| create | `packages/channels/src/telegram/allowlist.ts` | pure function: numeric id → allowed boolean, parsed from config |
| create | `packages/channels/src/index.ts` | package public exports |
| modify | `packages/config/src/schema.ts` | add `TELEGRAM_BOT_TOKEN` (secret), `TELEGRAM_ALLOWLIST` (comma-separated numeric ids, may be empty; zod refinement rejects any non-numeric entry at boot rather than silently dropping it — fail closed, per invariant #7) |
| modify | `apps/hermes/src/boot.ts` | after health server starts, build the Telegram adapter and start the poller with an echo handler wired inline in `boot.ts` at ~5 lines (business logic — normalize, allowlist check, echo — lives in `channels`/a small handler module, not in `boot.ts`) |
| create | `apps/hermes/src/handlers/echo.ts` | the actual echo handler: allowlist check → echo text back, or log-and-drop; `edited_message` → log-only no-op |

**Steps:**

- [x] `Channel` port in `packages/channels/src/channel.ts`, provider-neutral (`InboundMessage { channelUserId, chatId, text, chatType: "private" | "group" | "other", kind: "message" | "edited_message" }`)
- [x] Telegram HTTP client: `getUpdates({ offset, timeout, limit, allowedUpdates })` and `sendMessage({ chatId, text })` over `fetch`; **client-side AbortController timeout = poll `timeout` + 10s** (avoids false aborts / reconnect storms — this is the single most important correctness detail in the client beyond the offset rule). Every log line and thrown error redacts the bot token out of the request URL (`https://api.telegram.org/bot<REDACTED>/<method>`) — Telegram embeds the token in the URL path, not a header, so this doesn't happen automatically like it would with an `Authorization` header
- [x] Normalization guard: an update with no `message.from` (channel posts, some anonymous-admin group messages) is logged at debug and dropped before the allowlist check — it has no user id to check against, so silently proceeding would be a fail-open bug. Same for `chat.type !== "private"`: Hermes is a single-user assistant (ROADMAP §1 non-goal: no multi-user), so a group/channel context is deliberately rejected+logged, not handled, even from an allowlisted sender — replying into a group broadcasts to everyone in it
- [x] Poller: loop `getUpdates` → for each update in order: normalize (including the guards above) → allowlist check → dispatch to handler → advance in-memory offset. No persistence, no advisory lock, no structured backoff yet (Phase 3/4) — on a transient fetch error, log and retry after a fixed short delay
- [x] Allowlist: `parseAllowlist(csv): Set<number>`; `isAllowed(id, set)`; both pure, unit-testable without network
- [x] Echo handler: allowed → `send(chatId, text)`; not allowed → `logger.warn("rejected: unknown user", { channelUserId })`; `edited_message` → `logger.info("edited message ignored", { channelUserId })`, no reply
- [x] `apps/hermes/src/boot.ts`: wire `TelegramAdapter` + echo handler after the health server is listening
- [x] `packages/channels/README.md`: document the `Channel` port contract, the token-redaction rule, the private-chat-only guard, and why chunking/backoff are explicitly not in this phase (see Phase 4)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/channels/src/telegram/__tests__/allowlist.test.ts` | parse + membership, including empty allowlist rejects everyone |
| create | `packages/channels/src/telegram/__tests__/client.test.ts` | request shape for `getUpdates`/`sendMessage` against a mocked `fetch`; confirms the AbortController timeout is set longer than the poll `timeout` param; confirms a simulated fetch failure never surfaces the raw token in the thrown error or a logged line |
| create | `packages/config/src/__tests__/schema.test.ts` (extend) | malformed `TELEGRAM_ALLOWLIST` entry (non-numeric, trailing comma, etc.) fails boot with a message naming the bad entry |
| create | `apps/hermes/src/handlers/__tests__/echo.test.ts` | allowed → echoes; disallowed → no send, warn logged with the id; `edited_message` → no send, info logged; missing `from` → dropped, no crash; non-private `chatType` from an allowlisted id → dropped, logged, no reply |

**Verification:**

- [x] `pnpm -r test` green
- [ ] With `TELEGRAM_ALLOWLIST` empty: message the bot from your Telegram account → no reply, `docker compose logs hermes` shows `rejected: unknown user` with your numeric id
- [ ] Set `TELEGRAM_ALLOWLIST=<your id>`, `docker compose restart hermes`, message again → bot echoes the text verbatim
- [ ] Edit a previously sent message → no new reply appears; log shows `edited message ignored`
- [ ] Add the bot to a Telegram group containing your allowlisted account and message it there → no reply; log shows the non-private-chat rejection
- [ ] `docker compose logs hermes | grep -i <your-token-prefix>` → no match, anywhere, including in a forced network-error scenario

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: telegram channel port and adapter with allowlist echo`
- [ ] Phase marked complete

**Phase 2 — implementation notes:**

- Allowlist placement: this phase's Success criteria says rejection happens
  "before it reaches any handler", but the File-changes table, Steps and Tests
  all place the check inside `echo.ts`. Implemented per the latter three. Code
  review adjudicated this as an internally-inconsistent spec rather than a
  defect: the genuine fail-open case (no `message.from`) *is* guarded in the
  poller, and no fall-through exists while `echo` is the only handler. The
  `withAllowlist(handler)` wrapper is required at Phase 4 — see that phase.
- The offset ordering fix (advance only after the handler resolves) is real but
  **not provable at this phase** — see the note in Phase 3's Steps.
- Poller failure path delays `RETRY_DELAY_MS` before returning, so a
  permanently-failing update (e.g. `sendMessage` 403 "bot was blocked") cannot
  hot-loop `getUpdates`. A failed handler abandons the rest of the batch; those
  updates are redelivered, which is why the offset must not advance past them.
- The real 3s delay pushed two poller tests onto 4000ms `vi.waitFor` timeouts.
  Accepted here under minimal-change; Phase 4 must inject `retryDelayMs`.
- Verification steps 2-6 are UNRUN — they need a live bot token (see
  Prerequisites). Only `pnpm -r test` is ticked.
- Commits: `38c3d22` (feature), `f420852` (offset ordering + error survival),
  `0529778` (retry delay + test hardening), `ace7398` (test rename).

---

### Phase 3: Restart safety — offset persistence, advisory lock, deleteWebhook

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** Kill the container mid-conversation and restart it —
no message is permanently lost (at most one is replayed and re-echoed, which
is visible and acceptable, not silent data loss). A second instance pointed at
the same token/database fails fast at boot with a readable error instead of a
mysterious 409.
**Commit message:** `feat: persist telegram offset, single-instance advisory lock, deleteWebhook at boot`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/store/src/migrations/001_telegram_offset.sql` | `telegram_offset(id smallint primary key default 1, update_id bigint not null default 0, check (id = 1))` — singleton row pattern |
| create | `packages/store/src/telegram-offset-repo.ts` | `getOffset(pool)`, `setOffset(pool, updateId)` |
| create | `packages/store/src/advisory-lock.ts` | `acquireInstanceLock(lockKey, databaseUrl)` — opens its own dedicated `pg.Client` (never from the shared pool) and calls `pg_try_advisory_lock`; returns `{ acquired, release }`, where `release()` explicitly calls `pg_advisory_unlock` then closes that one client |
| modify | `packages/channels/src/telegram/poller.ts` | load initial offset from the repo; persist `update_id + 1` **after** each individual update is fully handled, not batched, not before |
| modify | `packages/channels/src/telegram/client.ts` | add `deleteWebhook()` |
| modify | `apps/hermes/src/boot.ts` | boot order: config → logger → pool → migrations → `deleteWebhook()` (unconditional) → `acquireInstanceLock()` (exit(1) with a clear message if held) → start poller |

**Steps:**

- [ ] `poller-crash-replay.test.ts` (Tests table below) is the **sole** guard for
      the happy-path ack-after-process ordering. Established by mutation testing
      in the Phase 2 review: with the offset in memory, reordering `offset = …`
      to before `await handler(…)` is externally unobservable — `offset` is
      closure-private and only read by the next `getUpdates`, which is sequenced
      after the await either way. Phase 2's unit tests catch the reorder only on
      the failure path. Once the offset is persisted here, the gap between
      "offset written" and "handler completed" becomes a real crash window, and
      this test is what proves it.

- [ ] Migration `001_telegram_offset.sql`; note in `packages/store/README.md` why this is a singleton row, not a per-chat table (one bot, one poll stream)
- [ ] `telegram-offset-repo.ts`: two functions, raw `pg` queries against the pool, no ORM
- [ ] `advisory-lock.ts`: a fixed numeric lock key (documented constant). Acquired via `pg_try_advisory_lock(key)` on a **dedicated `pg.Client` opened outside the pool** — session-level advisory locks are tied to the connection that took them, so if this ever ran on a pooled connection, the pool could hand that connection to unrelated queries or recycle it, silently dropping the lock. Boot exits with `"another Hermes instance is already running against this database"` on failure — never a bare 409. Expose `release()` explicitly (`pg_advisory_unlock` + close); Phase 4 wires it into shutdown. Until Phase 4 lands, the lock is still released correctly on any exit path — closing a connection releases its session-level locks as a Postgres-side guarantee — just implicitly rather than via an explicit call
- [ ] Poller change: **the offset write happens inside the per-update processing step, after `send`/handler completion, before moving to the next update in the batch** — this is the load-bearing ordering; add an explicit code comment stating *why* (Telegram permanently deletes acked updates; persisting early loses them on crash)
- [ ] Document the idempotency contract this creates: a crash between "handler completed" and "offset persisted" replays exactly the one in-flight update on restart. The echo handler is safe under replay by inspection (send-and-reply has no side effect beyond a duplicate, user-visible message) — there is no dedupe key here. Flag explicitly in `packages/channels/README.md` that any **future** handler with an external side effect (Phase 4+ of the roadmap, e.g. `log_trade`) MUST add its own idempotency key per invariant #4 — this phase does not solve that generally, only for echo
- [ ] `deleteWebhook()`: call unconditionally at every boot, before the poller starts, regardless of whether a webhook was ever set (cheap, idempotent)
- [ ] `boot.ts`: reorder per the File changes table; a lock failure must exit(1) before any poller work starts

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/store/src/__tests__/telegram-offset-repo.test.ts` | integration (gated on `TEST_DATABASE_URL`): get returns 0 initially, set persists, get reflects it |
| create | `packages/store/src/__tests__/advisory-lock.test.ts` | integration: first acquire succeeds; second concurrent acquire on the same key fails while the first is held; failing to call `release()` and instead just closing the client still frees the lock (simulates a crash); after `release()`, a new acquire on the same key succeeds |
| create | `packages/channels/src/telegram/__tests__/poller-offset-ordering.test.ts` | with a mocked client and repo, asserts `setOffset` is called **after** the handler resolves for update N, and that a handler throwing prevents the offset advancing past N |
| create | `packages/channels/src/telegram/__tests__/poller-crash-replay.test.ts` | concrete crash-replay simulation: handler for update N completes, then `setOffset` is made to throw once (simulating a crash before persistence); a fresh poller instance built against the same (unchanged) persisted offset receives update N again from a mocked `getUpdates`; asserts the handler is invoked a second time for the same update (the replay is real and observable, not just asserted in prose) and that offset advances correctly once persistence succeeds |

**Verification:**

- [ ] `pnpm -r test` green (including the gated integration tests, run with `TEST_DATABASE_URL` pointed at the compose Postgres)
- [ ] Send a message to the bot, then `docker compose kill hermes` before the echo arrives; `docker compose up -d hermes`; confirm the echo eventually arrives (a duplicate echo is acceptable and expected — document why in the PR description)
- [ ] Send a message, wait for the echo, restart the container; confirm no unrelated old message is replayed (offset only rewinds to the one in-flight update, never further)
- [ ] Manually run a second `hermes` process against the same `DATABASE_URL`/token (e.g. `docker compose run --rm hermes`) → it exits non-zero with the advisory-lock error, not a crash loop
- [ ] Inspect Telegram's `getWebhookInfo` (via a one-off curl) after boot → confirms no webhook is set

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: persist telegram offset, single-instance advisory lock, deleteWebhook at boot`
- [ ] Phase marked complete

---

### Phase 4: Robustness — chunking, backoff, /start + /ping, graceful drain

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** `/start` and `/ping` work over Telegram; a manufactured
6000-character reply splits into multiple in-order messages instead of being
rejected by Telegram's 4096-char cap; a `SIGTERM` drains in-flight work and
exits cleanly within the container's stop grace period instead of being
hard-killed.
**Commit message:** `feat: message chunking, backoff/retry policy, /start and /ping, graceful shutdown`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/channels/src/telegram/chunk.ts` | plain-text boundary chunker: splits at the last whitespace before 4096 chars, hard-cuts only if no whitespace exists in range |
| create | `packages/channels/src/telegram/backoff.ts` | exponential backoff with jitter, capped; `retry_after` header always wins when present |
| modify | `packages/channels/src/telegram/client.ts` | `sendMessage` chunks before sending, sends parts in order; `getUpdates`/`sendMessage` route errors through the backoff policy (429 → `retry_after`; 409 → a few bounded retries then fatal; 5xx/timeout → backoff, retry the same offset) |
| create | `apps/hermes/src/handlers/ping.ts`, `apps/hermes/src/handlers/start.ts` | `/ping` → uptime + DB status (reuses the Phase 1 health check); `/start` → confirms allowlist membership + connectivity |
| modify | `apps/hermes/src/boot.ts` | register SIGTERM/SIGINT handler once, in this exact order: stop accepting new poll iterations → wait for in-flight handling (bounded ~8s) → release the advisory-lock connection (Phase 3's `release()`) → `pool.end()` → `process.exit(0)`; hard-exit fallback timer |

**Steps:**

_Carried forward from the Phase 2 code review (both required here, not earlier —
each needs a second caller to exist before it stops being a speculative
abstraction):_

- [ ] `withAllowlist(handler)` wrapper composed in `boot.ts`, replacing the
      per-handler allowlist check currently inlined in `echo.ts`. Phase 2's
      Success criteria says rejection happens "before it reaches any handler",
      but its File-changes table, Steps and Tests all place the check inside
      `echo.ts`; that was accepted as an internally-inconsistent spec with no
      fall-through, because `echo` was the only handler. `/start` and `/ping`
      make it three handlers each re-implementing the same check — the
      duplication CLAUDE.md forbids, and a fail-open risk the moment one of
      them forgets.
- [ ] Inject the poller's retry delay (`retryDelayMs`) rather than using the
      module constant, BEFORE structured backoff lands. Phase 2's real 3s
      delay already forced two poller tests onto 4000ms `vi.waitFor` timeouts;
      backoff multiplies that into a slow, flaky suite.

- [ ] `chunk.ts`: pure function `chunkText(text, maxLen = 4096): string[]`; explicitly **not** markdown-entity-aware — justified because nothing in this PRD formats output (echo/`/start`/`/ping` are plain text; no `parse_mode` is used anywhere yet). Entity-safe splitting only matters once Markdown-formatted output exists, which arrives with the agent/LLM layer in Phase 2 — deferring it now avoids building machinery with no caller
- [ ] `backoff.ts`: `nextDelay(attempt, retryAfterHeader?)`; unit-testable without a clock dependency by injecting attempt count directly
- [ ] Wire chunking into `sendMessage` so any future long output (starting with `/ping`'s text) is safe by construction, not by caller discipline
- [ ] `/ping`, `/start` handlers: small, single-purpose, call the Phase 1 DB-check function — no duplicated health logic
- [ ] Shutdown handler in `boot.ts`, formalizing the full ordered sequence: (1) flip a `stopping` flag read by the poller's loop condition so no new `getUpdates` call starts; (2) await the in-flight handler, bounded by a timeout; (3) call the advisory-lock `release()` from Phase 3 — only now, once no more DB work from this instance is possible, so the lock is held for the full lifetime of any in-flight query and a restart-racing second instance can't acquire it while we're still draining; (4) `pool.end()`; (5) `process.exit(0)`. A hard-exit fallback timer guards against any step hanging past the container's stop grace period. Each step is a precondition for the next — get the order wrong and either a query crashes (pool closed too early) or the lock outlives its purpose (never released)
- [ ] Confirm `Dockerfile`'s `CMD` stays exec-form (already true from Phase 1) so SIGTERM actually reaches the Node process

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/channels/src/telegram/__tests__/chunk.test.ts` | text under limit → 1 part; text over limit splits on whitespace; no-whitespace-in-range hard-cuts; parts rejoin to the original text |
| create | `packages/channels/src/telegram/__tests__/backoff.test.ts` | exponential growth, cap respected, `retry_after` overrides computed delay |
| create | `packages/channels/src/telegram/__tests__/client-send-chunking.test.ts` | mocked `fetch`: a 6000-char `send()` results in 2+ `sendMessage` calls in order |
| create | `apps/hermes/src/handlers/__tests__/ping.test.ts`, `start.test.ts` | correct reply content given DB up/down |
| create | `apps/hermes/src/__tests__/shutdown-order.test.ts` | with mocked poller/lock/pool, asserts the five shutdown steps fire in the exact order above — in particular that `release()` is called before `pool.end()`, and both after the in-flight handler resolves |

**Verification:**

- [ ] `pnpm -r test` green
- [ ] Message `/ping` → reply includes uptime and DB status; `/start` → confirms allowlisted + connected
- [ ] Chunking verified via the unit test above (a live 6000-char *inbound* message is impossible — Telegram itself caps inbound text at 4096 — so this is intentionally a unit-test-only verification, noted in the plan per the no-manual-only-verification-when-testable-logic-exists rule)
- [ ] `docker compose stop hermes` (sends SIGTERM, default 10s grace period) while a message is mid-handling → logs show clean drain and exit 0 before the grace period expires; `docker compose logs` shows no forced SIGKILL

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: message chunking, backoff/retry policy, /start and /ping, graceful shutdown`
- [ ] Phase marked complete

---

### Phase 5: Final Verification

**Mode:** hil
**Type:** mixed

**Overall success criteria:**

- `docker compose up` from a clean checkout brings up a healthy Postgres and a
  healthy `hermes`, migrations applied.
- Texting the bot echoes deterministically; a non-allowlisted sender is
  rejected and logged with their id (the bootstrap path used in Phase 2).
- Killing `hermes` mid-conversation and restarting loses nothing (at most one
  visible duplicate).
- A second concurrent instance fails fast with a readable advisory-lock error.
- `/start` and `/ping` work; a `SIGTERM` drains cleanly inside the stop grace
  period.
- No CLAUDE.md invariant is violated: thin entry points, no dead code, small
  functions, comments explain *why* not *what*.

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block, scoped to end-to-end review of Phases 1–4 together
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review reflected back into this plan file
- [ ] All tests pass (`pnpm -r test`, including gated integration tests against a real Postgres)
- [ ] No CLAUDE.md invariants violated
- [ ] Feature tested manually: golden path (echo, `/start`, `/ping`) + edge cases (unknown sender, crash-restart, dual-instance, SIGTERM drain, oversized outbound message)
- [ ] Overall success criteria met
- [ ] `sync-knowledge` run to close out `.ai/` per the Knowledge Base Impact table below
- [ ] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| Monorepo layout, dev loop, docker usage | root `README.md` |
| `Result`/logger/clock/telemetry-port contracts | `packages/core/README.md` |
| Env schema, redaction rule | `packages/config/README.md` |
| Migration runner usage (boot + CLI), advisory lock constant, offset-repo contract | `packages/store/README.md` |
| `Channel` port contract, Telegram adapter behavior (offset ordering, chunking, backoff, deferred entity-safe markdown) | `packages/channels/README.md` |
| Boot sequence and shutdown order | `apps/hermes/README.md` |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `index.md` | create/update | rows for `apps/hermes`, `packages/core`, `packages/config`, `packages/store`, `packages/channels` — one-line responsibility + path |
| `architecture.md` | create/update | package layout and boundary rules from ROADMAP §3 as they now exist in code; data flow: Telegram → `channels` → handler → `store`; dependency-direction diagram |
| `decisions/d3-monorepo-package-per-concern.md` | create | ROADMAP D3 — why packages are created at their phase, never merge-then-split, illustrated by this PRD's exact package set |
| `decisions/telegram-long-polling-correctness.md` | create | the at-least-once semantics, why offset is persisted after handling not before, why the poller is single-instance, and the advisory-lock mitigation — non-obvious and expensive to rediscover |
| `decisions/lean-docker-build.md` | create | the 3-stage `pnpm deploy --filter` build and why it's already shaped for future one-agent-per-VM images (ROADMAP D4) at zero extra cost now |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | JSON-line logger | `packages/core/src/__tests__/logger.test.ts` |
| Phase 1 | `Result` type | `packages/core/src/__tests__/result.test.ts` |
| Phase 1 | env schema validation + redaction | `packages/config/src/__tests__/schema.test.ts` |
| Phase 1 | migration ordering + apply/skip/abort | `packages/store/src/__tests__/migrate.test.ts` |
| Phase 2 | allowlist parse/membership | `packages/channels/src/telegram/__tests__/allowlist.test.ts` |
| Phase 2 | Telegram client request shape + timeout margin + token redaction on error | `packages/channels/src/telegram/__tests__/client.test.ts` |
| Phase 2 | malformed `TELEGRAM_ALLOWLIST` entry fails boot | `packages/config/src/__tests__/schema.test.ts` |
| Phase 2 | echo handler allow/deny/edited-noop/missing-from/non-private-chat | `apps/hermes/src/handlers/__tests__/echo.test.ts` |
| Phase 3 | offset repo get/set | `packages/store/src/__tests__/telegram-offset-repo.test.ts` |
| Phase 3 | advisory lock acquire/contend/implicit-release-on-close/explicit-release | `packages/store/src/__tests__/advisory-lock.test.ts` |
| Phase 3 | offset persisted only after handler completion | `packages/channels/src/telegram/__tests__/poller-offset-ordering.test.ts` |
| Phase 3 | crash-before-persist replays the same update | `packages/channels/src/telegram/__tests__/poller-crash-replay.test.ts` |
| Phase 4 | plain-text chunking | `packages/channels/src/telegram/__tests__/chunk.test.ts` |
| Phase 4 | backoff/jitter/`retry_after` | `packages/channels/src/telegram/__tests__/backoff.test.ts` |
| Phase 4 | multi-part send ordering | `packages/channels/src/telegram/__tests__/client-send-chunking.test.ts` |
| Phase 4 | `/ping`, `/start` replies | `apps/hermes/src/handlers/__tests__/ping.test.ts`, `start.test.ts` |
| Phase 4 | shutdown step ordering (drain → release lock → close pool) | `apps/hermes/src/__tests__/shutdown-order.test.ts` |

## Human Summary

This plan builds the empty shell Hermes runs in: a pnpm monorepo, Postgres in
Docker, a migration runner, typed config, a JSON logger, and a health endpoint
(Phase 1 — the one infrastructure-only phase this format allows, justified
because nothing else can be built or verified without it). Then it adds the
Telegram channel in three deliberately ordered slices: a working echo bot
gated by an allowlist (Phase 2, which doubles as how you discover your own
Telegram id), then the correctness-critical part — surviving a crash without
losing a message and refusing to run two copies against the same bot token
(Phase 3) — then the robustness polish of long-message splitting, retry/backoff,
two utility commands, and a clean shutdown (Phase 4). No AI is involved
anywhere in this PRD; the bot only ever echoes what you send it. The end
result is a deployable, restart-safe, single-instance Telegram bot that the
next PRD (the LLM port) plugs a brain into.
