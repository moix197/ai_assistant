# Plan: Telemetry (Roadmap Phase 2b)

**Created:** 2026-08-27
**Branch:** `feat/02-telemetry`
**Status:** not started

## Context

Hermes today (`00-skeleton.md` + `01-llm-port.md`) is a restart-safe Telegram
bot that answers with a real LLM completion, records every call's cost into
`llm_usage`, and enforces a monthly budget ceiling before every provider call.
What it cannot do is answer "how much am I spending, on what, and is it
working" — there is no record of a call's latency, no error rate, no
cache-hit rate visible to the operator, and no distinct record of tool calls
or turns (because `packages/agent`, 2c, doesn't exist yet). ROADMAP D2 frames
this as a cost instrument, not a debugging nicety: "prefix caching cannot be
tuned and runaway loops cannot be caught without it." This PRD implements
Roadmap **Phase 2b only** — `packages/telemetry`: the recorder implementation
behind `core`'s existing (currently inert) `TelemetryRecorder` port, a wide
Postgres event table, cost/rate rollups computed in SQL, and a `/stats`
Telegram command — plus closing a real blind spot `01-llm-port` shipped
knowingly: an unpriced model resolving to silent `$0`.

**Explicitly out of scope, owned by later PRDs:**

- `packages/agent` (tool registry, the bounded agentic loop, approval gate,
  thread/turn persistence) — `plans/03-agent-core.md`, Phase 2c. This PRD
  defines `ToolCallEvent` and `TurnEvent` in `core`'s event union so 2c gets a
  typed contract to emit into, but ships **no producer** for either — only
  `LlmCallEvent` gets a real emitter here, from `packages/llm`'s adapter.
  `threadId`/`turnId` are nullable on every event for the same reason: they
  don't exist as real ids until 2c.
- Prometheus/Grafana/OTel containers (ROADMAP D2 explicitly rejects this now).
  The event schema is shaped so an OTel exporter can bolt on later; none is
  built here.
- A retention/pruning policy for `telemetry_events`. It grows unbounded from
  this PRD onward — recorded as an explicit open item, not solved here (see
  `.ai/decisions/telemetry-event-schema.md`).
- Branch protection requiring the new CI check to pass before merge — a
  GitHub repository setting, not a code change. Recorded as a human follow-up
  in Final Verification.

**Packages created here**, per the "create at its phase, never merge-then-split"
rule (ROADMAP §3 / D3): `packages/telemetry` only.

**Packages modified here:** `packages/core` (`TelemetryEvent` widened from a
free-form `{name, fields?}` shape to a typed discriminated union),
`packages/store` (new `telemetry_events` migration + repo + rollup queries),
`packages/llm` (optional injected `TelemetryRecorder` in the adapter; the
unpriced-model behavior reversal), `apps/hermes` (boot wiring, `/stats`
handler, shutdown now flushes telemetry before closing the pool), and the
repo root (new `.github/workflows/ci.yml` — this repo currently has none).

## Risk: high

Two things in this PRD can hurt a running system if done carelessly, both
already flagged by name in the research this plan is built from. First, the
telemetry write path sits directly on the paid completion path (`packages/llm`'s
adapter, the same file `01-llm-port` spent three phases hardening) — a
recorder that blocks, throws, or slows that path on a DB hiccup turns an
observability nicety into a new way to fail a user's message or blow the
30s per-request timeout. The port's `record(event): void` signature is
synchronous and non-blocking by design for exactly this reason, and this PRD
must preserve that at every call site: `record()` never becomes `await
record()`, and it never throws, including after `stop()` has been called.
Second, this PRD **reverses** a decision `01-llm-port` shipped deliberately:
`resolveCostUsd`'s unknown-model path moves from "warn and return `$0`" to
"throw `UnpricedModelError`," with a new boot-time validation step added
specifically to make that throw a rare backstop instead of a live-call
hazard. Reversing an already-shipped, already-tested decision on a paid path
warrants the same rigor `01-llm-port` applied to the ceiling itself, not a
quick edit — see Phase 4.

## Dependencies & Risks

- **The telemetry write path must never become a synchronous dependency of
  the completion path.** `packages/llm`'s adapter calls `recorder.record()`
  and continues immediately; `record()` itself does the buffering, and any
  actual Postgres write happens later, off a timer or a threshold, inside
  `packages/telemetry`, never inside `complete()`'s own await chain.
- **Accepted, named tradeoff: telemetry delivery is at-most-once, not
  exactly-once, and degrades in three specific, deliberately different ways
  — each answered here so none of them is left for the implementer to
  improvise:**
  - *A single flush fails* (Postgres hiccup): the batch is logged at `error`
    and discarded, never requeued or retried. The recorder does **not**
    enter a broken state — the next interval tick or threshold trigger
    attempts a fresh flush of whatever has accumulated since, so a transient
    outage self-heals once Postgres is reachable again; only the events that
    were in the failed batch are lost, not everything after it.
  - *The buffer fills faster than flushes can drain it* (a sustained burst,
    or a slow/degraded Postgres): once the buffer reaches `maxBufferSize`
    (a **count** of events, not a byte size — 500, an internal constant, not
    env-configurable), the newest incoming event is dropped and `logger.warn`
    fires. The buffer never grows past this bound. This is the intended
    backpressure valve, not a bug: a 2c agent loop that runs away and
    produces events faster than Postgres can absorb them degrades telemetry
    *fidelity* (some events missing), never blocks or slows the loop itself.
  - *The process is asked to shut down while events are still buffered*: see
    Phase 2's shutdown-ordering step — the final flush is time-boxed, not
    unbounded, so a hung Postgres write during shutdown cannot itself hang
    the process past the existing hard-exit ceiling.
  - This is deliberately the opposite failure mode from `llm_usage` and
    `llm_dedupe`, which are correctness-critical and DB-backed on the
    synchronous path — telemetry is a cost *instrument*, not a financial
    ledger, and paying for a stronger delivery guarantee (e.g. a WAL-backed
    outbox) here would reintroduce exactly the blocking-write risk above.
  - **Forward-looking note, not a task here:** `maxBufferSize` bounds the
    *count* of buffered events, not their total byte size. Every event this
    PRD produces (`llm.call`) has a small, fixed-shape `fields` payload, so
    this is not a live risk yet — but `packages/agent` (2c)'s `ToolCallEvent`
    will carry a tool's `result`, which could be large and unbounded in size.
    Whoever wires a `tool.call` producer should revisit whether a byte-size
    cap is also needed at that point; recorded here so it isn't rediscovered
    from scratch.
- **Cost-source split is an invariant, enforced by a type shape, not just a
  test.** `/stats`' spend/budget numbers must come from `llm_usage` via the
  existing `sumCostSince` — the *same* function `assertBudgetNotExceeded`
  reads — so `/stats` can never disagree with the ceiling it reports against.
  Calls, tokens, cache-hit rate, error rate, and top-tools come from
  `telemetry_events` instead. `getLlmCallStatsSince`'s return type
  (`{ calls, errorCalls, inputTokens, outputTokens, cacheHitTokens }`)
  **deliberately carries no cost/dollar field at all** — there is no value
  in that object a future edit could accidentally wire into the spend line,
  because the type doesn't have one. Phase 3's test still proves the
  invariant behaviorally (see Phase 3), but the type shape is the first line
  of defense. See `.ai/decisions/telemetry-event-schema.md`.
- **`/stats`' "error rate" has one, unambiguous definition: the share of
  `llm.call` events with `is_error = true`.** It does **not** include
  budget-ceiling rejections — those never produce an `llm.call` event at all
  (see Phase 2), because no provider call was attempted. This is stated once
  here and again in Phase 3's file description specifically so it cannot be
  relitigated or reinterpreted differently at execution time: a budget
  rejection is a *policy* stop, not a *call failure*, and the two must not be
  conflated in the one number `/stats` calls "error rate."
- **The unpriced-model reversal (Phase 4) changes what happens on a live call
  that reaches `resolveCostUsd` with an unrecognized model id.** Before this
  PRD: warn, cost `$0`, the user still gets their answer. After: throw
  `UnpricedModelError`, which propagates out of `complete()` and discards an
  already-paid-for answer, replaced by the completion handler's generic
  failure reply. This is only supposed to be reachable via a path that skips
  boot-time validation — the primary defense is refusing to boot at all with
  an unpriced model configured, covering **both** `LLM_PRIMARY_MODEL` and
  `LLM_FALLBACK_MODEL` when set (D5's manual-failover model is also a model
  Hermes can actually call, so it must be priced too) — but the backstop is
  real and its cost is real if ever triggered. `.ai/decisions/llm-cost-accounting.md`
  is amended to record this explicitly, not silently overwritten.
- **No CI today.** This repo has zero `.github/` directory, confirmed by
  direct listing. Every prior PRD's "tests pass" claims rest entirely on a
  human or an agent running the scripts locally. Phase 5 changes that, but
  until it lands and merges, nothing in Phases 1–4 is verified by anything
  other than local runs — same as every phase before it.
- **`pnpm test:live` is never invoked by CI, on purpose (decision, not an
  oversight).** It spends real (if small) money against live provider APIs
  and — per `01-llm-port` Phase 6's own execution notes — Gemini's free tier
  has already been observed hard-failing the live suite on quota (`7 of 10
  trials HTTP 429`). Running it on every push would make CI flaky on a
  dimension the project doesn't control. Recorded as an explicit decision
  (`.ai/decisions/ci-lane-policy.md`), with the residual risk named: a live
  regression (e.g. a wire-shape change from a provider) is not caught by CI
  and needs a periodic manual `pnpm test:live` run.
- **Shutdown ordering is already a documented, load-bearing, easy-to-break
  sequence** (`.ai/architecture.md#boot-and-shutdown-order`:
  `controller.abort()` → `channel.stop()` drain → `lock.release()` →
  `pool.end()`). Phase 2 inserts telemetry's flush-on-shutdown step into this
  sequence, **time-boxed** (see Phase 2's Steps — reuse `boot.ts`'s existing
  `withTimeout` helper rather than adding a second timeout mechanism), and
  must not reorder anything already there — the new step goes *after* the
  drain (so it can capture events from in-flight work) and *before*
  `pool.end()` (so the flush's own DB write has a live pool to write
  through), and it must not be allowed to consume so much of the
  `HARD_EXIT_TIMEOUT_MS` budget that `lock.release()`/`pool.end()` are
  starved — `channel.stop()`'s own drain can already take up to
  `DRAIN_TIMEOUT_MS` (5s) of the 8s hard-exit ceiling, so the telemetry flush
  gets a deliberately short budget of its own (Phase 2 specifies 1s).
- **Known, accepted trap this project has already been burned by twice
  (`01-llm-port` Phases 4 and 5): a fully tested mechanism that the real
  wiring never actually connects.** Both prior incidents shipped a green test
  suite for a mechanism (`usageRepo`, then `dedupeRepo`/the abort
  `AbortController`) that `boot.ts`'s real construction site never passed
  in, because the option was optional-with-a-silent-default at the time. The
  recorder here is *deliberately* kept optional at the adapter level (so
  `packages/llm` stays usable without telemetry, per decision below) — which
  reopens exactly that trap unless the *wiring site* (`build-llm-provider.ts`,
  `boot.ts`) is pinned by a test that fails if the wiring line is dropped,
  the same fix `01-llm-port` eventually applied. Phase 2's Steps call this out
  explicitly; it is not an oversight if a review flags it, it is the reason
  the test exists.
- **Migration numbering is not to be trusted as written.** This plan names
  the new migration `004_telemetry_events.sql` based on `001`–`003`
  existing today. Whoever executes Phase 1 must re-list
  `packages/store/src/migrations/` **at execution time** and confirm `003`
  is still the highest filename before creating `004` — if another change has
  landed a migration in the meantime, number one past whatever is actually
  there, not past what this document assumed.
- **Verified during planning, stated so the implementer doesn't have to
  re-derive it:** none of `packages/llm`'s existing adapter tests
  (`openai-compatible.test.ts`, `-usage.test.ts`, `-budget.test.ts`,
  `-abort.test.ts`) use an unpriced model id — they use `deepseek-v4-flash`
  or `gemini-3.6-flash`, both in `MODEL_PRICING` today. `apps/hermes`'s
  handler tests (`complete.test.ts`, `dispatch-allowlist-gates-llm.test.ts`,
  `complete-dedupe*.test.ts`) use a fake `LlmProvider` with `model:
  "some-model"`, which never reaches `resolveCostUsd` because those tests
  never construct a real adapter. Phase 4's throw change is not expected to
  break any existing test on this evidence — but Phase 4's Steps still
  require re-checking this at execution time (a grep, not an assumption),
  since the codebase will have moved between this plan being written and
  Phase 4 being executed.
- **No new dependencies.** `packages/telemetry` depends on `@hermes/core`
  only — same shape as `packages/llm` and `packages/channels`. Nothing here
  needs justifying in `.ai/decisions/` under the dependency policy because
  nothing new is added.

---

### Phase 0: Create worktree

**This phase is always first. No exceptions** (plan-sequential format spec —
worktree creation is a plan phase, not something `/execute-prd` does on its
own behalf). This is a structural requirement of every plan under this
format, distinct from — and not a use of — the "at most one thin
pure-infrastructure unit" exception the format allows inside the phase
sequence itself; that exception is used once, deliberately, by Phase 1 below
(see its Success criteria for the justification).

Follows the same sibling-worktree convention `01-llm-port` used.

**Steps:**

- [ ] Confirm with the user: branch name `feat/02-telemetry`, base ref `main`
- [ ] `git worktree add ../hermes-02-telemetry -b feat/02-telemetry main`
- [ ] Verify worktree is active and on the correct branch: `git worktree list`
- [ ] **Explicit step, do not skip:** copy `.env` from the repo root into the
      new worktree (`../hermes-02-telemetry/.env`) — gitignored, so the
      worktree starts without it. `01-llm-port`'s own Phase 0 flagged this as
      an easy step to forget; do it before attempting to boot anything.

---

### Phase 1: Buffered telemetry recorder writes to Postgres (unwired)

**Risk:** low
**Mode:** afk
**Type:** backend
**Success criteria:** `packages/telemetry` exists, builds, and a hand-fed
`llm.call` event pushed through `createBufferedTelemetryRecorder` round-trips
into a real `telemetry_events` row — proven by `pnpm test:db`, no live LLM
call or paid provider involved. `record()` is proven synchronous,
non-blocking, and non-throwing under every documented failure mode (buffer
overflow, flush failure, calling `record()` after `stop()`).

**This is this plan's one deliberate use of the "at most one thin
pure-infrastructure unit" exception** the plan-sequential format allows: by
itself, this phase changes nothing a Telegram user or QA can observe through
the bot — nothing calls the recorder yet. It is kept as its own phase rather
than folded into Phase 2 for two reasons. First, it is genuinely
independently observable and falsifiable without the paid path: a developer
can prove the whole recorder mechanism (buffering, overflow, flush timing,
drain-on-stop) works against a real database using nothing but a synthetic
event and `pnpm test:db` — matching the precedent `01-llm-port`'s own Phase 3
("usage accounting") set, which was also verified via direct DB inspection
rather than a new chat-visible behavior. Second, splitting it out lets code
review evaluate the recorder's correctness (a new package, a new table, a
new failure-mode surface) in isolation from the higher-risk change in
Phase 2 (the paid adapter path and the shutdown sequence), rather than
reviewing both at once. The alternative split — e.g. "just the core event
union" as its own phase — was rejected: that would have no observable proof
of its own at all (a type change nothing reads yet), which is exactly the
horizontal-layering shape this format forbids.
**Commit message:** `feat: telemetry event union, buffered Postgres recorder`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/core/src/telemetry.ts` | replace the free-form `TelemetryEvent { name, fields? }` with a typed discriminated union on `name`: `LlmCallEvent { name: "llm.call"; threadId: string \| null; turnId: string \| null; model: string; inputTokens: number; outputTokens: number; cacheHitTokens: number; durationMs: number; costUsd: number; error?: string }`, `ToolCallEvent { name: "tool.call"; threadId: string \| null; turnId: string \| null; tool: string; durationMs: number; approved: boolean; error?: string }`, `TurnEvent { name: "turn"; threadId: string \| null; turnId: string \| null; iterations: number; totalCostUsd: number; outcome: string; durationMs: number }`. `TelemetryEvent = LlmCallEvent \| ToolCallEvent \| TurnEvent`. `TelemetryRecorder.record(event: TelemetryEvent): void` unchanged in shape |
| modify | `packages/core/src/index.ts` | export the three new event types alongside `TelemetryEvent`/`TelemetryRecorder` |
| modify | `packages/core/README.md` | document the event union and that `threadId`/`turnId` are nullable until `packages/agent` (2c) assigns real ids |
| create | `packages/store/src/migrations/004_telemetry_events.sql` | `telemetry_events(id bigserial pk, created_at timestamptz not null default now(), name text not null, thread_id text, turn_id text, tool_name text, duration_ms int, cost_usd numeric(12,6), is_error boolean not null default false, fields jsonb not null default '{}'::jsonb)`; indexes on `(created_at)`, `(name, created_at)`, `(tool_name)`. **Filename number is provisional — see `Dependencies & Risks`; re-verify `003` is still the highest existing migration before creating this file** |
| create | `packages/store/src/telemetry-event-repo.ts` | `insertEvents(pool, events: TelemetryEvent[]): Promise<void>` — one multi-row `INSERT` per call (never one insert per event), mapping each event's discriminant to `tool_name`/`cost_usd`/`is_error` and packing the rest into `fields` jsonb (e.g. `llm.call`'s `model`/`inputTokens`/`outputTokens`/`cacheHitTokens`/`error` go in `fields`; `tool.call`'s `approved`/`error`; `turn`'s `iterations`/`outcome`). `isError` is derived as `event.error !== undefined` for `llm.call`/`tool.call`, always `false` for `turn`. No-op (does not query) on an empty array — a flush with nothing buffered must not round-trip to Postgres |
| modify | `packages/store/src/index.ts` | export `insertEvents` |
| modify | `packages/store/README.md` | document the `telemetry_events` table shape, the fixed-columns-vs-`fields`-jsonb split, and that this table has **no retention policy yet** — grows unbounded, explicit open item |
| create | `packages/telemetry/package.json`, `tsconfig.json` | new workspace package, templated on `packages/llm`'s: `type: module`, main/types → `dist`, `files: ["dist"]`, scripts `typecheck`/`build`/`test` matching the same shape, dependency on `@hermes/core` only |
| create | `packages/telemetry/src/event-repo-port.ts` | `TelemetryEventRepo { insertEvents(events: TelemetryEvent[]): Promise<void> }` — the injected port this package depends on, mirroring `packages/llm`'s `LlmUsageRepo`/`BudgetUsageRepo` pattern; `packages/telemetry` never imports `@hermes/store` directly (same boundary rule `packages/llm` follows) |
| create | `packages/telemetry/src/recorder.ts` | `createBufferedTelemetryRecorder(repo: TelemetryEventRepo, opts?: { flushIntervalMs?; flushThreshold?; maxBufferSize?; logger?: Logger }): TelemetryRecorderHandle` where `TelemetryRecorderHandle extends TelemetryRecorder { stop(): Promise<void> }`. See Steps below for the exact behavior of every edge case — overflow, flush failure, post-`stop()` calls, and burst handling — all of which must be implemented as specified, not left to the implementer's judgment |
| create | `packages/telemetry/src/index.ts` | public exports: `createBufferedTelemetryRecorder`, `TelemetryRecorderHandle`, `TelemetryEventRepo`, the re-exported `TelemetryEvent`/`TelemetryRecorder` types from `@hermes/core` |
| create | `packages/telemetry/README.md` | recorder contract: synchronous, non-blocking, never-throwing `record()`; bounded-buffer (count, not bytes) drop-on-overflow behavior; flush triggers (threshold + interval) and self-healing after a failed flush; at-most-once delivery, accepted; `stop()`/drain semantics, including the post-`stop()` `record()` case |
| modify | `tsconfig.base.json` | add `@hermes/telemetry` to `paths` |
| modify | `Dockerfile` | add `COPY packages/telemetry/package.json packages/telemetry/package.json` to the build stage's manifest copy list |

**Steps:**

- [x] **Re-list `packages/store/src/migrations/` first** and confirm `003` is
      still the highest-numbered file before creating `004_telemetry_events.sql`
      — do not trust this plan's assumed number if the directory has changed
      since this plan was written
- [x] Widen `TelemetryEvent` in `@hermes/core` — every other change in this
      phase depends on the union shape existing. Keep `TelemetryRecorder`
      itself unchanged (`record(event): void`, synchronous) — only the event
      shape changes, not the port's contract
- [x] Scaffold `packages/telemetry` per D3's package-creation rule (created
      here, never grown inside `llm` or `store` first). Declared dependency:
      `@hermes/core` only — confirm `package.json` does **not** list
      `@hermes/store`, mirroring the same boundary check `01-llm-port` Phase 1
      called "the single most concrete boundary decision in this phase"
- [x] Migration `004_telemetry_events.sql`, following `001`–`003`'s
      conventions exactly (own transaction, tracked in `schema_migrations`,
      applied by the existing `runMigrations` — no new migration mechanism)
- [x] `insertEvents`: one multi-row `INSERT`, not a loop of single-row
      inserts — a burst-flushed buffer of 50 events must not become 50 round
      trips. Guard the empty-array case explicitly (a periodic flush firing
      on an empty buffer is the common case, not the exception)
- [x] `createBufferedTelemetryRecorder`: `record()` must never `await`
      anything and must never throw, under any of the following, all of
      which need a passing test (see Tests below), not just an implementation:
      - **Normal operation:** push to the buffer, return. Reaching
        `flushThreshold` (default `50`) triggers a fire-and-forget flush
        (not awaited by `record()`); a `setInterval` (default `5000`ms)
        triggers a periodic flush independently of threshold
      - **Overflow:** at `maxBufferSize` (default `500`, an event **count**,
        not a byte size), the newest incoming event is dropped and
        `logger.warn` fires; the buffer never exceeds this bound
      - **A flush's `repo.insertEvents` call rejects:** log at `error`,
        discard that batch (no requeue, no retry), and leave the recorder
        able to flush normally on the *next* trigger — a sustained outage
        loses data for its duration and self-heals the moment Postgres
        answers again, it does not wedge the recorder into a permanently
        broken state
      - **`record()` is called after `stop()` has resolved:** the event is
        dropped (same code path as overflow, including the `logger.warn`),
        never buffered and never flushed — `stop()` must be a real terminal
        state, not a suggestion
- [x] `stop()`: clears the interval, then awaits **one** final flush of
      whatever remains — this is the shutdown-time drain Phase 2 depends on.
      `stop()` itself has no timeout internally; Phase 2's shutdown wiring is
      what time-boxes it (see Phase 2's Steps) — do not duplicate a timeout
      mechanism inside `packages/telemetry`, which has no concept of the
      process's overall shutdown budget
- [x] Register the two touchpoints the codebase-surface research flags:
      `tsconfig.base.json` paths, `Dockerfile` package-manifest COPY — miss
      either and typecheck or the container build breaks on a clean clone.
      No `docker-compose.yml` change needed — this phase introduces no new
      env vars
- [x] `packages/telemetry/README.md`, `packages/core/README.md`,
      `packages/store/README.md`: document as scoped in the file table above

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/telemetry/src/__tests__/recorder.test.ts` | `record()` returns synchronously without awaiting the repo; buffer reaching `flushThreshold` triggers a flush calling `repo.insertEvents` with the batched events; a periodic timer flush fires independently of threshold (fake timers); buffer never exceeds `maxBufferSize` under a burst larger than the bound, and the overflow is logged via the injected `logger`; a rejected `insertEvents` is logged at `error`, does not throw out of the flush, and does **not** wedge the recorder — a second flush after a first failure succeeds and only the second batch's events are asserted as inserted (the first batch's loss is asserted too, explicitly, not just "no crash"); `record()` called after `stop()` has resolved is dropped (logged, never appears in any subsequent `insertEvents` call) and does not throw; `stop()` drains whatever remains in one final flush and stops the interval |
| create (test:db) | `packages/store/src/__tests__/telemetry-event-repo.test.ts` | integration, gated on `TEST_DATABASE_URL`: migration applies cleanly; `insertEvents` with a mixed batch (`llm.call` success, `llm.call` with `error`, and one of each other event kind) writes the right number of rows in one round trip, with `tool_name`/`cost_usd`/`is_error` populated correctly per kind and the rest recoverable from `fields`; an empty array performs no query (assert via a query-count spy or row-count unchanged) |
| create (test:db) | `packages/telemetry/src/__tests__/recorder-integration.test.ts` | **the phase's headline proof, end to end against real Postgres:** a real `createBufferedTelemetryRecorder` wired to `@hermes/store`'s real `insertEvents` (via a thin in-test wiring, not `apps/hermes`'s not-yet-built `build-telemetry-recorder.ts`); `record()` a hand-built `llm.call` event, `await stop()` to force the drain, then query `telemetry_events` directly and assert the row exists with the right fields — this is the test the phase's Success criteria points at |

**Verification:**

- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green (catches a missing `tsconfig.base.json` path entry)
- [x] `pnpm test:db` green against the compose Postgres — migration, batch
      insert, and the end-to-end recorder round trip all proven for real
- [x] `docker compose build` succeeds (catches a missing `Dockerfile` COPY line)
- [x] Manually confirm nothing outside `packages/telemetry`'s own tests
      references `@hermes/telemetry` yet — `grep -r "@hermes/telemetry"
      apps/ packages/llm packages/store` (excluding `packages/telemetry`
      itself) returns nothing. This is the phase's own "still unwired" claim,
      checked rather than assumed

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase

**Post-review fixes** (commit `e90acb5`, on top of `32dadf1`): `durationMs` was
being measured *after* `recordCompletionUsage`'s `llm_usage` INSERT, so a slow
database inflated the PRD's headline latency metric; it is now taken the moment
`completeWithRetry` settles and the one value is reused by both emissions. Also:
`recorder.record()` is wrapped in a `safeRecord` try/catch so a third-party
recorder that throws can neither replace the original provider error nor fail an
already-paid successful completion; `apps/hermes/README.md`'s graceful-shutdown
section now documents the flush step and `TELEMETRY_FLUSH_TIMEOUT_MS`; the
duration assertion is now deterministically *positive* via fake timers.

**Deferred to Final Verification (Phase 6):** the four live Verification bullets
above (bot message → row; bad API key → `is_error = true`; budget rejection →
zero new rows; `docker compose stop hermes` → buffered event survives) need a
running bot and a real provider key, so they are hil by nature and are carried
into Phase 6 rather than being ticked here.

**Post-review fixes** (commit `0fa3688`, on top of `d507286`): the first
implementation's `flush()` was re-entrant and drained the buffer *before*
awaiting, so with the default `flushThreshold` (50) below `maxBufferSize`
(500) the bound could never be reached — a slow-Postgres burst produced
unbounded concurrent `insertEvents` calls instead of the documented
drop-on-overflow backpressure. Fixed with a single-flight guard: while a
flush is in flight neither `record()` nor the interval starts another, so
the buffer accumulates and `maxBufferSize` is the real valve; `stop()`
awaits the in-flight flush, then does its one final flush, and is
idempotent. Also: interval `unref()`'d, `dropEvent` → `logDroppedEvent`,
`004`'s `tool_name` index made partial (`WHERE tool_name IS NOT NULL`), and
two missing assertions added (overflow proven under the *default* config;
`insertEvents` proven to be exactly one query).
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: telemetry event union, buffered Postgres recorder`
- [x] Phase marked complete

---

### Phase 2: `llm.call` events wired into the real paid path, flushed on shutdown

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** Send a message to the bot (any configured provider —
free-tier Gemini per the project's dev convention). Within a few seconds, a
new row appears in `telemetry_events` with `name = 'llm.call'`, the correct
model, token counts, cost, and duration, `is_error = false`. Triggering a
provider failure (e.g. a bad API key) produces a row with `is_error = true`
and an error message in `fields`, with all numeric usage fields `0`. A
budget-ceiling rejection produces **no** `telemetry_events` row at all — see
`Dependencies & Risks`. Restarting the container (`docker compose stop`)
while an event is still buffered flushes it before the process exits, within
a bounded time budget that cannot itself hang the shutdown sequence. This is
the vertical slice every later phase in this PRD builds on — without it,
`/stats` (Phase 3) has nothing to read.
**Commit message:** `feat: wire llm.call events into the LLM adapter and shutdown flush`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/llm/src/adapter/openai-compatible.ts` | `OpenAiCompatibleAdapterOptions` gains an optional `recorder?: TelemetryRecorder`. `complete()` times the call (`Date.now()` before `completeWithRetry`, after the budget check) and: on success, after `recordCompletionUsage` (which now returns the `LlmUsageEntry` it built, reused here instead of recomputing — see the note below on why this is safe), calls `recorder?.record({ name: "llm.call", threadId: null, turnId: null, model: entry.model, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, cacheHitTokens: entry.cacheHitTokens, durationMs, costUsd: entry.costUsd })`; on any error thrown by `completeWithRetry`, calls `recorder?.record({ name: "llm.call", threadId: null, turnId: null, model: request.model, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, durationMs, costUsd: 0, error: <message> })` **before rethrowing the original error unchanged**. A budget-exceeded rejection (thrown by `assertBudgetNotExceeded`, before `completeWithRetry` is ever called) does **not** emit an event — no provider call was attempted, so there is nothing to attribute a duration or cost to; this is a deliberate scope line, not an omission, and is pinned by a test |
| modify | `packages/llm/src/adapter/openai-compatible.ts` (`recordCompletionUsage`) | return type changes from `Promise<void>` to `Promise<LlmUsageEntry>`, returning the `entry` it already builds — reused by the telemetry emission above instead of re-deriving cost/tokens a second time. **Confirmed safe:** `recordCompletionUsage` is a private, unexported function called only from within `complete()` in this same file — no external caller or test invokes it directly (every existing test in `openai-compatible-usage.test.ts` exercises it indirectly through `adapter.complete()`, which is unaffected by its return type), so this is a pure internal signature change with no ripple effect |
| modify | `packages/llm/README.md` | document telemetry emission: optional, fires on both success and provider-call failure, does not fire on a pre-flight budget rejection |
| create | `apps/hermes/src/telemetry/build-telemetry-recorder.ts` | `buildTelemetryRecorder(pool: Pool, logger: Logger): TelemetryRecorderHandle` — wires `@hermes/store`'s `insertEvents` into `createBufferedTelemetryRecorder`, matching `build-llm-provider.ts`'s shape and its reason for existing (`boot()` has no testable seam) |
| modify | `apps/hermes/src/llm/build-llm-provider.ts` | `buildLlmProvider` gains an optional `recorder?: TelemetryRecorderHandle` parameter, passed straight through to `createOpenAiCompatibleAdapter`'s `opts.recorder` |
| modify | `apps/hermes/src/boot.ts` | construct `telemetryRecorder = buildTelemetryRecorder(pool, logger)` after the pool is created; thread it through `MessageHandlerDeps` → `createMessageHandlers` → `buildLlmProvider(...)`; add `telemetryRecorder: { stop(): Promise<void> }` to `ShutdownDeps`, required (not optional — see the named trap in `Dependencies & Risks`); add a new module-level constant `TELEMETRY_FLUSH_TIMEOUT_MS = 1_000` alongside the existing `DRAIN_TIMEOUT_MS`/`HARD_EXIT_TIMEOUT_MS`, sized the same documented way (leaves margin under the 8s hard-exit ceiling even when `channel.stop()`'s drain consumes close to its own 5s budget); `shutdown()` calls `await withTimeout(deps.telemetryRecorder.stop(), TELEMETRY_FLUSH_TIMEOUT_MS)` — reusing the existing `withTimeout` helper already used for the channel drain, not a new timeout mechanism — **after** the `channel.stop()` drain and **before** `lock.release()`/`pool.end()`. Keep any new wiring inside the existing extracted helper functions (`createMessageHandlers`, `subscribeGatedDispatch`) rather than inlining it into `boot()` itself — `01-llm-port` Phase 6's own review already flagged `boot()` as being at the edge of the ~30-line guidance, and this phase adds to it |

**Steps:**

- [x] Wire the recorder into the adapter exactly where `recordCompletionUsage`
      already runs, reusing its returned `LlmUsageEntry` rather than
      recomputing cost/tokens a second time — two independent derivations of
      the same cost number is the kind of drift `01-llm-port`'s cost-accounting
      decision doc exists to prevent
- [x] **Do not emit an event for a budget-exceeded rejection.** This is a
      deliberate scope line (see `Dependencies & Risks`): no provider call
      was attempted, so there is no duration or cost to attribute, and
      `/stats`' error rate is defined as "share of `llm.call` events with
      `is_error = true`" specifically so a budget rejection — which produces
      no `llm.call` event — cannot be conflated with a provider failure.
      Pin this with a test asserting `recorder.record` is called **zero**
      times when `assertBudgetNotExceeded` throws
- [x] **Wire the recorder into the real construction sites and pin the
      wiring, not just the mechanism.** `01-llm-port` shipped two fully
      tested mechanisms (`usageRepo`, then `dedupeRepo`/`AbortController`)
      that `boot.ts`'s real adapter construction never actually received,
      because the option was optional-with-a-silent-default. The recorder
      here is deliberately optional at the adapter level (packages/llm must
      stay usable without telemetry) — so `build-llm-provider.ts` and
      `boot.ts` are the places that must not silently drop it. Add a test
      asserting `buildLlmProvider` passes a supplied `recorder` through to
      the adapter's options, so deleting that one wiring line in
      `build-llm-provider.ts` fails a test instead of merely losing a
      feature no one notices missing
- [x] **Shutdown, precisely:** `controller.abort()` still fires first,
      unchanged. Then `channel.stop()`'s drain (bounded `DRAIN_TIMEOUT_MS`).
      Then `withTimeout(telemetryRecorder.stop(), TELEMETRY_FLUSH_TIMEOUT_MS)`
      — bounded independently, so a hung flush degrades to "lose the
      unflushed buffer" rather than "hang shutdown," consistent with the
      at-most-once tradeoff already accepted in `Dependencies & Risks`. Then
      `lock.release()`. Then `pool.end()`. Add a test asserting this exact
      order, extending the existing shutdown-ordering test rather than
      writing a parallel one
- [x] Confirm `packages/llm`'s adapter still functions with no `recorder`
      supplied at all (every test that predates this phase must keep
      passing unmodified) — the option is additive, not a breaking change to
      the adapter's public contract

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/llm/src/adapter/__tests__/openai-compatible-telemetry.test.ts` | successful `complete()` calls `recorder.record()` exactly once with `name: "llm.call"`, `error` absent, and fields matching the recorded `LlmUsageEntry` plus a positive `durationMs`; a provider failure (`LlmHttpError`/`LlmTimeoutError`/`LlmMalformedResponseError`) calls `recorder.record()` exactly once with `error` set and all numeric usage fields `0`, then still rethrows the original error; a `BudgetExceededError` rejection calls `recorder.record()` **zero** times; omitting `recorder` entirely does not throw — the adapter works exactly as before this phase when telemetry isn't wired |
| modify | `apps/hermes/src/llm/__tests__/build-llm-provider.test.ts` | extend: a supplied `recorder` is passed through to the constructed adapter's options (the wiring-pin test called out in Steps) |
| create | `apps/hermes/src/telemetry/__tests__/build-telemetry-recorder.test.ts` | pure wiring test, no real DB: `buildTelemetryRecorder` returns a handle whose `record`/`stop` delegate to the injected repo, matching `build-llm-provider.test.ts`'s shape |
| modify | `apps/hermes/src/__tests__/shutdown-abort.test.ts` | extend: `telemetryRecorder.stop()` is called during shutdown, strictly after `channel.stop()` resolves and strictly before `lock.release()`/`pool.end()`; a `telemetryRecorder.stop()` that never resolves does not hang the overall `shutdown()` call past `TELEMETRY_FLUSH_TIMEOUT_MS` — `lock.release()`/`pool.end()` still run (fake timers or a controllable never-resolving promise, same style as the existing drain-timeout test) |

**Verification:**

- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [ ] Message the bot (any configured provider) → within a few seconds,
      `psql` into the app database shows a new `telemetry_events` row with
      `name = 'llm.call'`, `is_error = false`, correct `model` and non-zero
      `duration_ms`/token counts in `fields`
- [ ] Force a provider failure (e.g. temporarily point `LLM_PRIMARY_API_KEY`
      at a bad value, restart) → the resulting row has `is_error = true` and
      an `error` message in `fields`, with token/cost fields `0`
- [ ] Force a budget-ceiling rejection (set `LLM_MONTHLY_BUDGET_USD` below
      current spend, restart, message the bot) → the reply is the existing
      out-of-budget message and **no new** `telemetry_events` row appears —
      confirm via a row-count check immediately before and after
- [ ] `docker compose stop hermes` shortly after sending a message (before the
      periodic flush would otherwise fire) → the buffered event is still
      present in `telemetry_events` after the stop, proving the shutdown-time
      drain actually ran, and the container still exits within its normal
      grace period (not delayed by the flush)

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: wire llm.call events into the LLM adapter and shutdown flush`
- [x] Phase marked complete

---

### Phase 3: `/stats` renders real spend, call, and cache numbers

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** An allowlisted sender texts `/stats` and gets back a
plain-text reply with: spend today and this month vs. the configured cap
(with a percentage), calls today/month, total input/output tokens,
cache-hit rate, error rate, and a top-tools-this-month list — the last of
which explicitly reads "no tool calls recorded yet" rather than being blank
or omitted, since no producer exists until `packages/agent` (2c). The
spend/cap numbers match what `assertBudgetNotExceeded` would compute at the
same instant (same underlying `sumCostSince` call); the call/token/rate
numbers match a direct count against `telemetry_events`. **"Error rate"
means, precisely: the share of `llm.call` events with `is_error = true` —
budget-ceiling rejections are excluded by construction, since Phase 2
already established they never produce an `llm.call` event.** This is the
plan's second exit-criterion clause (ROADMAP §2b: "`/stats`: spend, top
tools, error rate, cache hit rate").
**Commit message:** `feat: /stats command with real spend, call, and cache-hit rollups`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/store/src/telemetry-stats-repo.ts` | `getLlmCallStatsSince(pool, sinceUtc): Promise<LlmCallStats>` — one aggregate query over `telemetry_events WHERE name = 'llm.call' AND created_at >= $1`, returning `{ calls, errorCalls, inputTokens, outputTokens, cacheHitTokens }` (token sums pulled from `fields->>'inputTokens'` etc., cast to numeric). **This type deliberately has no cost/dollar field** — see the cost-source-split invariant in `Dependencies & Risks`; do not add one, even one that seems convenient for a future feature, without a deliberate, separate decision. `getTopToolsSince(pool, sinceUtc, limit): Promise<Array<{ tool: string; count: number }>>` — `WHERE name = 'tool.call' AND created_at >= $1 GROUP BY tool_name ORDER BY count DESC LIMIT $2`, returning `[]` today (no `tool.call` rows exist until 2c) and populating correctly once they do, with no code change needed here when that lands |
| modify | `packages/store/src/index.ts` | export `getLlmCallStatsSince`, `getTopToolsSince`, and their result types |
| create | `packages/telemetry/src/stats-repo-port.ts` | `StatsRepo { sumCostSince(sinceUtc: Date): Promise<number>; getLlmCallStatsSince(sinceUtc: Date): Promise<LlmCallStats>; getTopToolsSince(sinceUtc: Date, limit: number): Promise<ToolCount[]> }` — `sumCostSince` is declared independently here with the exact shape `packages/llm`'s `BudgetUsageRepo` already declares (not imported from `llm`, mirroring how neither package imports the other); `apps/hermes` wires the **same** `@hermes/store` `sumCostSince` function into both ports, which is what makes the cost-source-split invariant hold in practice, not just in prose |
| create | `packages/telemetry/src/stats.ts` | `computeStats(repo: StatsRepo, clock: Clock, capUsd: number, now?: Date): Promise<Stats>` — computes UTC "today" and "this calendar month" windows off the injected `Clock` (reusing the same UTC-calendar-month convention `check-budget.ts` already established, not a second implementation of month-boundary math — see Steps for why this is duplicated rather than shared); calls all five repo methods (spend today, spend month, call stats today, call stats month, top tools month); derives `cacheHitRate = cacheHitTokens / (inputTokens + cacheHitTokens)` and `errorRate = errorCalls / calls`, both `0` (not `NaN`) when the denominator is `0`; `formatStatsMessage(stats: Stats): string` — plain text, no `parse_mode`, renders every section of the approximate layout below, with the top-tools section rendering literally "no tool calls recorded yet" when the list is empty rather than being omitted. Output is a small, fixed number of lines plus a bounded (`limit`-capped) tool list — nowhere near Telegram's 4096-char message limit, and `Channel.send` already runs every outgoing message through `chunkText` (confirmed: `packages/channels/src/telegram/client.ts` calls it inside `sendMessage`) regardless, so no special length handling belongs in this handler either way |
| create | `packages/telemetry/src/index.ts` (extend) | export `computeStats`, `formatStatsMessage`, `StatsRepo`, `Stats` |
| create | `apps/hermes/src/telemetry/build-stats-repo.ts` | `buildStatsRepo(pool: Pool): StatsRepo` — wires `@hermes/store`'s `sumCostSince`, `getLlmCallStatsSince`, `getTopToolsSince` into the port, matching `build-llm-provider.ts`'s shape |
| create | `apps/hermes/src/handlers/stats.ts` | `createStatsHandler(channel: Channel, statsRepo: StatsRepo, clock: Clock, capUsd: number): (message: InboundMessage) => Promise<void>` — thin: calls `computeStats` then `formatStatsMessage`, sends the result. No business logic beyond wiring, per CLAUDE.md's thin-entry-points rule — the actual math lives in `packages/telemetry/src/stats.ts` |
| modify | `apps/hermes/src/boot.ts` | `createMessageHandlers` builds `statsHandler = createStatsHandler(channel, buildStatsRepo(pool), systemClock, resolveBudgetCapUsd(config))`. **`capUsd` is never `undefined` here:** `resolveBudgetCapUsd(config)` reads `config.LLM_MONTHLY_BUDGET_USD`, which `envSchema` already defaults to `1_000_000` when the env var is absent (see `packages/config/src/schema.ts`) — `/stats` needs no extra guard for a missing cap, it inherits the same default-and-validate behavior the budget ceiling itself already relies on; `DispatchCommandDeps` gains `statsHandler`; `createDispatchCommand` matches `/stats` (via the existing `matchesCommand`) **before** the fallthrough to `completionHandler` — same precedent as `/ping`/`/start`, and load-bearing for the same reason: an unmatched `/stats` typo falling through would otherwise trigger a real paid completion call |
| modify | `apps/hermes/README.md` | document the `/stats` command and what each section means |

**Steps:**

- [x] `getLlmCallStatsSince`/`getTopToolsSince`: single aggregate query each,
      not N+1 or application-side aggregation — the whole point of a wide
      event table with `fields` jsonb is that Postgres does this math, not
      Node. Confirm `getTopToolsSince` returns `[]` (not an error, not `null`)
      against today's empty `tool.call` population — this is the concrete
      case the handler's "no tool calls recorded yet" branch exists for
- [x] `computeStats`'s UTC-month-boundary logic must reuse the same
      "midnight UTC on the first of the calendar month" definition
      `check-budget.ts`'s `startOfCurrentUtcMonth` already uses. Default:
      duplicate the (six-line) function rather than introduce a shared
      dependency between `packages/telemetry` and `packages/llm` — the two
      packages are deliberately independent of each other (see
      `Dependencies & Risks`), and a shared abstraction for six lines isn't
      earned yet. Flag this duplication explicitly to code review rather
      than letting it be found and questioned cold
- [x] **Division-by-zero guards, explicit and tested:** zero calls this month
      must render `0%` cache-hit rate and `0%` error rate, never `NaN` or a
      thrown error — a fresh deployment's first `/stats` call before any
      traffic is the concrete case this guards
- [x] **Prove the cost-source split can actually fail, not just that the two
      functions were called.** The regression test for this (see Tests
      below) must feed `sumCostSince` and `getLlmCallStatsSince` **deliberately
      mismatched** numbers from a fake `StatsRepo` — e.g. `sumCostSince`
      returns a distinctive figure like `$12.345678` while
      `getLlmCallStatsSince` reports zero calls — and assert the rendered
      spend line shows exactly `$12.345678`. A test that only asserts "both
      functions got called" proves nothing about which number ends up on
      which line; this one proves the spend line's value traces to
      `sumCostSince` and nothing else, because there is no other number in
      the fixture it could have come from
- [x] `formatStatsMessage`: plain text only, matching the rest of the bot's
      replies (`packages/channels`' Telegram sender sets no `parse_mode`
      anywhere — confirmed, do not introduce Markdown formatting here that
      would render as literal asterisks/underscores in chat). Approximate
      layout, exact wording is an implementation judgment call:
      ```
      Spend today: $X.XXXXXX
      Spend this month: $X.XXXXXX / $CAP.XX (NN%)
      Calls today: N
      Calls this month: N
      Tokens in/out (month): N / N
      Cache hit rate (month): NN%
      Error rate (month): NN%
      Top tools (month): <list, or "no tool calls recorded yet">
      ```
- [x] Dispatch wiring: `/stats` must be matched **before** the fallthrough to
      `completionHandler` in `createDispatchCommand` — verify this with a
      test in the same style as `01-llm-port`'s
      `dispatch-allowlist-gates-llm.test.ts`, since a routing mistake here
      turns every `/stats` call into a paid completion call answering "stats"
      as free text
- [x] `/stats` inherits the existing `withAllowlist`/`withPrivateChat`
      composition automatically (it's wired the same way `/ping`/`/start`
      are, inside the same `dispatchCommand`) — do not add a second gating
      mechanism, per the codebase-surface research's explicit note that
      access control already exists and should not be duplicated
- [x] Reuse `apps/hermes/src/handlers/__tests__/complete.test.ts`'s existing
      `createMockChannel`/`createMockLogger`-style helpers (or the file's own
      local equivalents) for the new handler test rather than writing fresh
      ones — same fixture shape, same project convention

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create (test:db) | `packages/store/src/__tests__/telemetry-stats-repo.test.ts` | integration, gated on `TEST_DATABASE_URL`: `getLlmCallStatsSince` correctly sums/counts across a mix of `llm.call` success and error rows and **excludes** `tool.call`/`turn` rows; rows outside the `sinceUtc` window are excluded; `getTopToolsSince` groups and orders `tool.call` rows by `tool_name`, returns `[]` when none exist |
| create | `packages/telemetry/src/__tests__/stats.test.ts` | `computeStats` combines a fake `StatsRepo`'s results into the correct `Stats` shape, including the UTC month-boundary window passed to each repo call; **cost-source-split regression, explicit** (see Steps): mismatched `sumCostSince`/`getLlmCallStatsSince` fakes prove the spend line traces to `sumCostSince` alone; cache-hit-rate and error-rate math against known numbers; both rates render `0` (not `NaN`) when calls/tokens are `0`; `formatStatsMessage` renders every section including the literal "no tool calls recorded yet" string when `topTools` is empty, and a real tool list when it isn't |
| create | `apps/hermes/src/telemetry/__tests__/build-stats-repo.test.ts` | pure wiring test, no real DB — mirrors `build-llm-provider.test.ts` |
| create | `apps/hermes/src/handlers/__tests__/stats.test.ts` | happy path: handler calls `computeStats`/`formatStatsMessage` (or the composed pipeline) and sends the formatted text via `channel.send` |
| create | `apps/hermes/src/__tests__/dispatch-stats-command.test.ts` | **routing regression, explicit:** builds the real composed dispatch chain with a call-counting fake `LlmProvider` behind `completionHandler`; feeds `/stats` through it; asserts the fake `statsHandler`/stats path is invoked and the fake provider's `complete()` is called **zero** times — the same shape as `01-llm-port`'s `dispatch-allowlist-gates-llm.test.ts`, applied to the new command instead of the allowlist |

**Verification:**

- [x] `pnpm -r test` green
- [x] `pnpm test:db` green — the two stats-repo aggregate queries proven
      against real rows
- [ ] Manual: with a nonzero `llm_usage`/`telemetry_events` history from
      Phase 2's verification, message `/stats` → reply renders every section,
      spend figures match a direct `psql` `SELECT SUM(cost_usd) ...` against
      `llm_usage` for the same window, and top-tools reads "no tool calls
      recorded yet"
- [ ] Manual: message `/stats` from a sender **not** on `TELEGRAM_ALLOWLIST`
      → no reply, consistent with every other command

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: /stats command with real spend, call, and cache-hit rollups`

**Post-review polish** (commit `74e4712`, on top of `60a46bd`; the review itself
came back green with no blocking findings): rates now render to one decimal, so
1 error in 500 calls reads `0.2%` rather than `0%`; the budget-percent line
reuses `computeRate` + `formatPercent` instead of an inline unguarded
`Math.round`; two test gaps closed (an unallowlisted sender's `/stats` gets no
reply; `getTopToolsSince`'s time window and top-N `LIMIT` are both pinned);
`.ai/architecture.md`'s dispatcher diagram now lists `/stats`; and
`packages/telemetry/README.md` records that `created_at` is *flush* time, not
event time, so an event near a day/month boundary can land in the adjacent
bucket by up to one flush interval.

**Deferred to Final Verification (Phase 6):** the two Manual bullets above
(`/stats` from an allowlisted sender renders and reconciles against a direct
`psql` sum; `/stats` from a non-allowlisted sender gets no reply) need a live
bot and a real Telegram client. The allowlist half is additionally pinned by an
automated dispatch test.
- [x] Phase marked complete

---

### Phase 4: Unpriced model fails closed at boot

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** Setting `LLM_PRIMARY_MODEL` (or `LLM_FALLBACK_MODEL`,
when set) to any string absent from `MODEL_PRICING` makes the process refuse
to boot with a readable error naming the offending model — no stack trace,
no silent `$0`-costed live call. A correctly configured model boots exactly
as before. This closes the blind spot `01-llm-port`'s
`llm-cost-accounting.md` recorded by name: "an unpriced model resolves to
`$0`... cheap under-pricing is the ceiling's blind spot."
**Commit message:** `fix: refuse to boot with an unpriced model, throw instead of $0 on drift`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/llm/src/errors.ts` | add `UnpricedModelError` — carries `model`, message names it plainly (`` `no MODEL_PRICING entry for "${model}"` ``) |
| modify | `packages/llm/src/pricing.ts` | `resolveCostUsd` now **throws** `UnpricedModelError(model)` on an unknown model id instead of logging a `warn` and returning `0` — the `logger` parameter becomes unused by this specific path (still used elsewhere if any other warn-worthy case exists; if not, drop the parameter and update call sites, noting the removal explicitly to the reviewer rather than leaving a dead parameter); add `assertModelsPriced(models: readonly string[]): void` — throws `UnpricedModelError` naming the **first** unpriced model found, given a list of configured model ids |
| modify | `packages/llm/src/index.ts` | export `UnpricedModelError`, `assertModelsPriced` |
| modify | `apps/hermes/src/boot.ts` | immediately after `loadConfigOrExit()` (before pool/DB setup — this check needs no database and should fail as fast as possible), call `buildProviderProfiles(config)` and `assertModelsPriced([profiles.primary.model, profiles.fallback?.model].filter((m): m is string => m !== undefined))` — **covers both `LLM_PRIMARY_MODEL` and `LLM_FALLBACK_MODEL`** (when the latter is configured), since D5's manual-failover model is a model Hermes can genuinely call and must be priced too, not just the one currently active; on `UnpricedModelError`, same handling as `ConfigError` in `loadConfigOrExit` (`console.error(error.message); process.exit(1)`) — readable message, non-zero exit, no stack trace. `createMessageHandlers` keeps its own existing `buildProviderProfiles(config)` call (a second, cheap, pure re-derivation) rather than threading the already-computed profiles through several function signatures — a deliberate minimal-change trade-off, noted here rather than silently duplicated |
| modify | `.ai/decisions/llm-cost-accounting.md` | amend the "An unknown model id warns and costs `0`; it never throws" bullet and the "Throwing on an unknown model... trade a bookkeeping problem for a user-visible outage" line in Rejected — both reverse. Record *why* the reversal is now safe: boot-time `assertModelsPriced` makes reaching `resolveCostUsd`'s throw path a rare backstop (an id arriving by a route boot validation didn't cover) instead of the routine live-call risk it would have been without boot validation |
| modify | `.ai/decisions/monthly-budget-ceiling.md` | amend the "Constraints it creates" bullet: "an unpriced model resolves to `$0`" is no longer a blind spot for the ceiling — an unpriced model now either fails boot outright or throws mid-call (discarding that one call's answer, never silently recording `$0` for it). Note the ceiling's remaining blind spot is narrower now: a **mispriced-but-recognized** model (a stale number in `MODEL_PRICING` for an id that still resolves) still under- or over-reports, which boot validation cannot catch |

**Steps:**

- [x] **Re-check for tests/fixtures that rely on the old `$0`-and-warn
      behavior or use an unpriced model id, at execution time — do not trust
      this plan's own audit as still current.** This plan's authoring pass
      found no such dependency: every `packages/llm` adapter test uses
      `deepseek-v4-flash` or `gemini-3.6-flash` (both priced), and every
      `apps/hermes` handler test uses a fake `LlmProvider` with `model:
      "some-model"` that never reaches `resolveCostUsd` (those tests never
      construct a real adapter). Re-run
      `grep -rn "some-retired-model\|resolveCostUsd" packages/ apps/` before
      making the change, since the codebase will have moved since this audit
- [x] `UnpricedModelError`: same shallow shape as the package's other typed
      errors (`LlmHttpError`, `BudgetExceededError`) — a `name`, a message,
      and the one carried field (`model`) callers might want programmatically
- [x] `assertModelsPriced`: pure, synchronous, no I/O — fully unit-testable
      in `packages/llm` without any boot seam. This is deliberate: `01-llm-port`
      Phase 3's own execution notes record that `boot()` "offered no testable
      seam," so this phase puts all the real logic somewhere that does have
      one, and keeps `boot.ts`'s own addition to a single, obviously-correct
      call — no new `boot.ts`-level test is added for this reason, matching
      that precedent rather than fighting it
- [x] Call `assertModelsPriced` as early as possible in `boot()` — before
      `createMigratedPool`, before any network or DB I/O — so a misconfigured
      model fails in well under a second, not after a DB connection attempt
      that might itself be slow or hanging
- [x] Pass **both** `profiles.primary.model` and (when present)
      `profiles.fallback?.model` to `assertModelsPriced` in the same call —
      confirm the test for this exercises the fallback-only-unpriced case
      specifically (primary priced, fallback not), not just an unpriced
      primary, since that's the easier case to get right by accident and the
      one most likely to be silently skipped
- [x] Confirm `resolveCostUsd`'s new throw path is still exercised **inside**
      `recordCompletionUsage`'s scope in the adapter, i.e. it still propagates
      out of `complete()` and is caught by the completion handler's existing
      generic-failure branch (not a new branch) — the reply becomes the
      generic "couldn't process that message" text, same as any other
      provider error, not a special-cased message. This is the accepted,
      named cost of the belt-and-braces guard (see `Dependencies & Risks`)
- [x] Both `.ai/decisions/` amendments are edits to the **existing** files —
      do not create new decision docs for this phase, the update belongs
      exactly where the original claim lives, per `.ai/`'s decision-oriented,
      no-restating-code convention

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `packages/llm/src/__tests__/pricing.test.ts` | replace the existing "unknown model → cost `0` + a `warn`" case with "unknown model → throws `UnpricedModelError` naming the model"; add `assertModelsPriced` cases: all-known models resolves without throwing; one unknown model among several throws `UnpricedModelError` naming that specific one; **the fallback-only-unpriced case specifically** (primary priced, fallback not) throws naming the fallback's model, not silently passing because the primary was fine; an empty list resolves without throwing (no configured fallback is valid) |
| modify | `packages/llm/src/adapter/__tests__/openai-compatible-usage.test.ts` (or a new sibling) | a successful response using a model absent from `MODEL_PRICING` causes `complete()` to reject with `UnpricedModelError` rather than resolving with a `$0`-costed usage row — pins the reversal at the adapter boundary, not just in `pricing.test.ts` |

**Verification:**

- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [ ] Manual: set `LLM_PRIMARY_MODEL` to a garbage string (e.g.
      `not-a-real-model`), restart the container →
      `docker compose logs hermes` shows a readable error naming
      `not-a-real-model`, the container exits non-zero, no stack trace. This
      is the plan's third acceptance signal
- [ ] Manual: set `LLM_FALLBACK_MODEL` (with the other two fallback keys
      also set) to a garbage string while `LLM_PRIMARY_MODEL` stays valid,
      restart → boot **still** refuses, naming the fallback's model — proves
      the fallback path is actually checked, not just the primary
- [ ] Manual: restore both to real, priced models, restart → boots and
      answers exactly as before this phase
- [x] `.ai/decisions/llm-cost-accounting.md` and
      `.ai/decisions/monthly-budget-ceiling.md` read correctly against the
      new behavior — no stale "never throws" or "resolves to `$0`" language
      left uncorrected anywhere in either file

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `fix: refuse to boot with an unpriced model, throw instead of $0 on drift`
- [x] Phase marked complete

**Stale-audit correction, found during implementation:** this phase's own
"re-check for tests/fixtures that rely on the old `$0`-and-warn behavior" step
turned up three call sites the plan's written audit had missed —
`openai-compatible.test.ts`, `build-llm-provider.test.ts` and
`cache-hit-tokens.live.test.ts` all used unpriced model ids (or passed the now
dropped `logger` argument) for reasons unrelated to pricing behavior. All three
were fixed as fixtures; code review separately confirmed none of the edits
weakened an assertion — `build-llm-provider.test.ts` in particular re-pins
real-logger injection through the insert-failure path at equal strength.

**Post-review fixes** (commit `1d794d1`, on top of `1aca675`; the review came
back green with no blocking findings): the substantive one is that an
`UnpricedModelError` thrown during post-completion usage accounting emitted *no*
`llm.call` event, so pricing drift — the very thing this phase adds a throw to
catch — would have been invisible in `/stats`. `recordCompletionUsage` now sits
inside the same try/catch as `completeWithRetry`, and the error emission reports
zeroed tokens when the HTTP call never returned or the real billed tokens when
the call succeeded and only accounting failed; still exactly one event per
`complete()`, still zero on a budget rejection, and no pre-existing Phase 2 test
needed changing. Also: `assertModelsPriced` now uses the same truthy lookup as
`resolveCostUsd`, so boot validation and runtime resolution cannot disagree; a
stale `pricing.ts` comment and an over-claiming line in
`.ai/decisions/monthly-budget-ceiling.md` were corrected.

**Deferred to Final Verification (Phase 6):** the three Manual bullets above
(garbage `LLM_PRIMARY_MODEL` → boot refuses; garbage `LLM_FALLBACK_MODEL` → boot
still refuses and names the fallback; both restored → boots and answers) need a
running container.

---

### Phase 5: CI, with the live lane's exclusion made provable

**Risk:** low
**Mode:** afk
**Type:** config
**Success criteria:** Every push and PR against `main` runs typecheck, lint,
the unit test lane, and the DB integration lane against a real,
health-checked Postgres service container, and reports pass/fail on GitHub.
`pnpm test:live` never runs in CI — and a new automated test proves the
unit-test lane's exclusion glob actually has files to exclude and actually
excludes all of them, rather than the claim resting on a human reading
`package.json` (the exact gap `01-llm-port` Phase 6 flagged as unverifiable
by inspection alone).
**Commit message:** `ci: add GitHub Actions workflow, prove the live test lane is excluded`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `.github/workflows/ci.yml` | on `push`/`pull_request` to `main`: checkout, setup Node 22 + pnpm (via `packageManager` in root `package.json`), `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit lane), `pnpm test:db` against a `postgres:16` service container with a healthcheck and `TEST_DATABASE_URL` pointed at it (service `POSTGRES_DB` set directly to a `_test`-suffixed name so `assertNotTheAppDatabase`'s guard passes without extra setup steps). A comment above the job explicitly states `pnpm test:live` is never invoked here, why (real billed API calls; see `.ai/decisions/ci-lane-policy.md`), and where to run it manually instead |
| create | `packages/llm/src/__tests__/live-lane-excluded.test.ts` | non-live (runs in the default `pnpm test` lane): (1) recursively lists `packages/llm/src` for files matching `*.live.test.ts` and asserts the list is **non-empty** — the guard below must have something real to guard, an empty live-file set would make the second assertion vacuously true; (2) reads `packages/llm/package.json`'s own `test` script string, extracts the `--exclude` glob it actually passes to vitest (not a hardcoded copy of it), converts that glob to a matcher, and asserts every file found in (1) matches it; (3) recursively lists `packages/llm/src` for **all** `*.test.ts` files, removes every file the extracted glob matches, and asserts the remaining set contains **zero** files ending in `.live.test.ts`. Together, (2) and (3) fail if the exclude flag is ever narrowed, mistyped, or dropped from `package.json` — the test is driven off the live configuration value, not a duplicate assumption of what it should be |
| create | `.ai/decisions/ci-lane-policy.md` | records why `test:live` is excluded from CI (cost + observed Gemini free-tier quota flakiness, `01-llm-port` Phase 6), what runs instead (`test`, `test:db`, both hermetic), and the accepted residual risk (a live-provider regression is caught only by a periodic manual `pnpm test:live` run, not automatically) |

**Steps:**

- [ ] Service container Postgres: set `POSTGRES_DB` directly to something
      ending in `_test` (e.g. `hermes_ci_test`) so `db-env.ts`'s
      `assertNotTheAppDatabase` guard — which refuses a database name not
      ending in `_test` — passes without any extra CI-only carve-out in that
      guard. Do not weaken or special-case the guard for CI; make CI satisfy
      the guard as written, the same one every local `test:db` run already
      has to satisfy
- [ ] Confirm `TEST_DATABASE_URL` in the workflow does not collide with
      `DATABASE_URL` — simplest: don't set `DATABASE_URL` in the CI job at
      all, since nothing in `pnpm test`/`pnpm test:db` boots the real app
      (`loadConfig()` is never called by the test suites)
- [ ] `--frozen-lockfile` on install — a CI run must fail loudly on a
      lockfile drift, not silently resolve a different dependency tree than
      what's committed
- [ ] The live-lane-exclusion test reads its glob from `package.json` at test
      run time (`readFileSync` + `JSON.parse`, no new dependency — a small
      hand-rolled glob-to-regex conversion is enough for the one pattern in
      use, `**/*.live.test.ts`; do not add a glob library for this one
      pattern, consistent with the project's build-our-own-first default)
- [ ] Run the new test locally against the current, correct
      `package.json` first to confirm it passes, then deliberately break the
      exclude flag locally (delete it) and confirm the test **fails** —
      this is the "provable, not assumed" bar from the requester's own
      framing; do this by hand once during implementation, it does not need
      to be a permanent meta-test
- [ ] `.ai/decisions/ci-lane-policy.md`: state the decision plainly, including
      the specific observed flakiness (`7 of 10` Gemini trials hitting
      `HTTP 429` in `01-llm-port` Phase 6) as the concrete evidence, not a
      hypothetical

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/llm/src/__tests__/live-lane-excluded.test.ts` | see File changes — the exclusion-provability test itself, part of the `test` (unit) lane |

No additional test file for the workflow YAML itself — a GitHub Actions
workflow has no local test harness; its correctness is verified by a real
run (see Verification below). The testable logic behind it (the exclude
glob) already has its own test above, in the `test` lane.

**Verification:**

- [ ] `pnpm -r test` green, including the new exclusion test
- [ ] Push the branch / open a PR against `main` → the GitHub Actions run
      shows all four steps (typecheck, lint, test, test:db) green, visible in
      the PR's checks tab
- [ ] Confirm in the Actions log that `test:live` does not appear anywhere in
      the run
- [ ] Manually break the exclude glob in `packages/llm/package.json` (per the
      Steps bullet above), confirm the new test fails locally, then revert —
      do not leave the broken state committed

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `ci: add GitHub Actions workflow, prove the live test lane is excluded`
- [ ] Phase marked complete

---

### Phase 6: Final Verification

**Mode:** hil

**Type:** mixed

**Overall success criteria:**

- Texting the bot produces a real LLM reply, and a matching `llm.call` row
  appears in `telemetry_events` shortly after, with correct model/tokens/cost
  and `is_error = false`.
- `/stats` renders real numbers: spend today/month matches `llm_usage` via
  `sumCostSince` (the same source the budget ceiling itself reads), calls and
  token totals match `telemetry_events`, error rate reflects only `llm.call`
  failures (never budget rejections), and top tools reads "no tool calls
  recorded yet" (no producer exists until 2c).
- Setting an unpriced `LLM_PRIMARY_MODEL` or `LLM_FALLBACK_MODEL` makes the
  process refuse to boot, naming the model, with no stack trace.
- A PR against `main` shows CI green (typecheck, lint, `test`, `test:db`),
  and the live-lane-exclusion test is part of that green run.
- No CLAUDE.md invariant is violated: thin entry points (`stats.ts` handler
  has no business logic beyond wiring), no dead code, small functions (~30
  lines — specifically re-check `boot.ts`, which `01-llm-port` Phase 6
  already flagged as being at the edge of this guidance before this PRD
  added to it), comments explain *why* not *what*.
- `packages/telemetry` depends on `@hermes/core` only — never `@hermes/store`
  directly — **and** `@hermes/core` does not import `@hermes/telemetry` (the
  dependency direction is the whole point of the port living in `core`;
  confirm it wasn't accidentally reversed anywhere).
- The telemetry write path never blocked or failed a completion call during
  any of the manual verification above — confirm by inspecting logs for the
  message sends in Phase 2's verification: no delay attributable to the
  recorder, no telemetry-related error in the reply path.
- The shutdown sequence's telemetry-flush timeout is real, not decorative:
  Phase 2's `shutdown-abort.test.ts` extension (a never-resolving
  `telemetryRecorder.stop()`) still passes, proving `lock.release()`/
  `pool.end()` are never starved by a hung flush.

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block, scoped to end-to-end review of Phases 1–5 together
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review reflected back into this plan file
- [ ] All tests pass: `pnpm test` (default, hermetic), `pnpm test:db`
      (gated on `TEST_DATABASE_URL`) — `pnpm test:live` is intentionally not
      part of this plan's exit bar (see `.ai/decisions/ci-lane-policy.md`);
      confirm it is unaffected by this PRD's changes (nothing here modifies
      `packages/llm`'s live suite), but do not require it green as a
      condition of merging this PRD
- [ ] No CLAUDE.md invariants violated
- [ ] Feature tested manually: golden path (real LLM reply → `telemetry_events`
      row → `/stats` reflects it), plus edge cases (provider failure →
      `is_error = true` row; budget rejection → no event; unpriced model →
      boot refusal for both primary and fallback; `/stats` from a
      non-allowlisted sender → no reply; shutdown mid-buffer → flush proven,
      bounded)
- [ ] Overall success criteria met
- [ ] `sync-knowledge` run to close out `.ai/` per the Knowledge Base Impact table below
- [ ] **Human follow-up, out of scope as a code change:** enable GitHub branch
      protection on `main` requiring the new `ci` check to pass before merge.
      This is a repository settings action, not something this PRD can
      perform — recorded here per decision, not forgotten
- [ ] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| `TelemetryEvent` union (`LlmCallEvent`/`ToolCallEvent`/`TurnEvent`), nullable `threadId`/`turnId` | `packages/core/README.md` |
| Buffered recorder contract: synchronous `record()`, bounded buffer (count, not bytes), drop-on-overflow, flush triggers and self-healing after a failed flush, post-`stop()` behavior, `stop()`/drain semantics, at-most-once delivery | `packages/telemetry/README.md` |
| `/stats` layout, cost-source split (spend from `llm_usage`, everything else from `telemetry_events`), the precise "error rate excludes budget rejections" definition, empty-section placeholders | `apps/hermes/README.md` |
| `telemetry_events` table shape, fixed-columns-vs-`fields` split, no retention policy (open item) | `packages/store/README.md` |
| `llm.call` emission point in the adapter, optional `recorder`, budget-rejection exclusion | `packages/llm/README.md` |
| `UnpricedModelError`, boot-time `assertModelsPriced` covering both primary and fallback, the reversed unknown-model behavior | `packages/llm/README.md` |
| Boot wiring order for the telemetry recorder; shutdown now flushes telemetry (time-boxed) before `lock.release()`/`pool.end()` | `apps/hermes/README.md` |
| New `.github/workflows/ci.yml`; what it runs and what it deliberately excludes | root `README.md` (or a short note if none exists covering CI today — add one) |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `index.md` | update | new `packages/telemetry` row (recorder implementation, the only package that writes `telemetry_events`); note `core`'s `TelemetryEvent` widened from a free-form shape to a typed union; note the telemetry cross-cutting row is no longer "port only, nothing calls it" |
| `architecture.md` | update | dependency diagram gains `telemetry → core`; boundary note that `telemetry` never imports `store` (mirrors `llm`); data flow: the completion path now also emits a buffered, non-blocking `llm.call` event alongside the existing `llm_usage` write, excluded on a budget rejection; boot/shutdown order gains the time-boxed telemetry-flush step, with its exact position (after drain, before `lock.release()`/`pool.end()`) and its own timeout budget |
| `decisions/telemetry-event-schema.md` | create | the event union shape, the `telemetry_events` wide-table-plus-jsonb-tail shape, the cost-source-split invariant (spend from `llm_usage`, rates/counts from `telemetry_events`) and why it's enforced by both a type shape and a test, the precise "error rate" definition, and the unbounded-growth-with-no-retention-policy open item |
| `decisions/llm-cost-accounting.md` | update | the unknown-model behavior reversal (warn+`$0` → throw), and why boot-time validation covering both primary and fallback makes the throw path safe now when it wasn't before |
| `decisions/monthly-budget-ceiling.md` | update | the ceiling's blind spot narrows from "any unpriced model" to "a mispriced-but-recognized model" |
| `decisions/ci-lane-policy.md` | create | why `test:live` is excluded from CI, the concrete Gemini-quota evidence behind that decision, and the accepted residual risk |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | buffered recorder: sync `record()`, threshold + interval flush, overflow bound, flush-failure self-healing, post-`stop()` drop, drain on `stop()` | `packages/telemetry/src/__tests__/recorder.test.ts` |
| Phase 1 | `telemetry_events` migration + batch insert round-trip (DB) | `packages/store/src/__tests__/telemetry-event-repo.test.ts` |
| Phase 1 | **headline proof: real recorder + real Postgres, hand-fed event round-trips (DB)** | `packages/telemetry/src/__tests__/recorder-integration.test.ts` |
| Phase 2 | adapter emits `llm.call` on success and failure, not on budget rejection, works with no recorder | `packages/llm/src/adapter/__tests__/openai-compatible-telemetry.test.ts` |
| Phase 2 | `buildLlmProvider` passes a supplied `recorder` through (wiring pin) | `apps/hermes/src/llm/__tests__/build-llm-provider.test.ts` |
| Phase 2 | `buildTelemetryRecorder` wiring | `apps/hermes/src/telemetry/__tests__/build-telemetry-recorder.test.ts` |
| Phase 2 | shutdown flushes telemetry between drain and `lock.release()`/`pool.end()`, time-boxed | `apps/hermes/src/__tests__/shutdown-abort.test.ts` |
| Phase 3 | `getLlmCallStatsSince`/`getTopToolsSince` aggregate queries (DB) | `packages/store/src/__tests__/telemetry-stats-repo.test.ts` |
| Phase 3 | `computeStats` math incl. zero-division guards and the **cost-source-split regression (mismatched fakes)**; `formatStatsMessage` layout incl. empty-tools placeholder | `packages/telemetry/src/__tests__/stats.test.ts` |
| Phase 3 | `buildStatsRepo` wiring | `apps/hermes/src/telemetry/__tests__/build-stats-repo.test.ts` |
| Phase 3 | `/stats` handler happy path | `apps/hermes/src/handlers/__tests__/stats.test.ts` |
| Phase 3 | **`/stats` routed before the paid fallthrough (routing regression)** | `apps/hermes/src/__tests__/dispatch-stats-command.test.ts` |
| Phase 4 | `resolveCostUsd` throws on unknown model; `assertModelsPriced` naming behavior incl. fallback-only-unpriced | `packages/llm/src/__tests__/pricing.test.ts` |
| Phase 4 | adapter rejects with `UnpricedModelError` instead of a `$0`-costed success | `packages/llm/src/adapter/__tests__/openai-compatible-usage.test.ts` |
| Phase 5 | **live test lane's exclude glob actually excludes every `*.live.test.ts` file (provable, not assumed)** | `packages/llm/src/__tests__/live-lane-excluded.test.ts` |

## Human Summary

This plan gives Hermes the thing `01-llm-port` deliberately left out: a way to
see what it's actually doing and spending, without pulling in Prometheus or
Grafana. It starts, on its own, by turning the `TelemetryRecorder` port that's
sat unused in `core` since Phase 0 into a real, working recorder — a small,
bounded in-memory buffer that Postgres-backs itself on a timer, proven
end-to-end against a real database before it is ever wired to anything that
costs money. Only once that mechanism is proven does the plan wire it into
the one paid call site that exists so far — `packages/llm`'s adapter — built
specifically so a slow database write can never become a reason a Telegram
reply is late or missing, and so a hung flush during shutdown degrades to
"lose the unflushed buffer" rather than "hang the process." Tool-call and
turn events are typed and ready for `packages/agent` (2c) to fill in later,
but nothing produces them yet, and `/stats` says so plainly rather than
pretending. `/stats` itself is careful about where its numbers come from:
spend and budget figures are read from the exact same `llm_usage` query the
budget ceiling already enforces against — enforced not just by a test but by
a type that has nowhere else for a dollar figure to come from — while calls,
tokens, and cache-hit rate come from the new event table instead, and "error
rate" is defined once, precisely, as call failures only, never budget
rejections. Along the way, this plan closes a real gap `01-llm-port` shipped
on purpose and wrote down as future work: a model id that drifts out of the
pricing table used to cost silently `$0` forever; now it either refuses to
boot at all, naming the model — checking every model Hermes could actually
call, not just the one currently active — or, if it somehow arrives past
that check, throws instead of lying about the cost. Finally, because every
prior PRD's test claims have rested entirely on someone running scripts
locally, this plan adds the repo's first CI pipeline, deliberately leaving
out the one lane that spends real money and has already been seen flaking on
a free-tier quota — and proves that exclusion actually holds with a test,
rather than asking the next reader to trust a `package.json` line they
didn't write.
