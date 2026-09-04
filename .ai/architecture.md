# Architecture

The high-level shape of the system: package boundaries, how data flows, and the
rules that keep dependencies pointing one direction. Capture the *structure and
its rationale* — not API-level detail the code already documents.

## System shape

pnpm workspace, one package per concern, each created in the phase where it
first appears (ROADMAP §3 / D3 — see
[d3-monorepo-package-per-concern](decisions/d3-monorepo-package-per-concern.md)).
What exists today:

```
apps/hermes        wiring + boot + shutdown, no logic
packages/core      Result, ids, Clock, logger, TelemetryEvent union + recorder PORT,
                   withHttpRetry (the one retry/backoff/timeout mechanism)
packages/config    zod env schema, fail-fast, redaction
packages/store     pg pool, migration runner, repos, advisory lock
packages/channels  Channel port + telegram/ adapter
packages/llm       LlmProvider port + OpenAI-compatible adapter over fetch
packages/telemetry buffered recorder behind core's port + /stats rollup math
packages/agent     bounded turn loop + tool execution + ThreadRepo/ApprovalGate PORTS
packages/google-auth OAuth connect flow + token crypto + revoke + refresh coordinator + GoogleAccountRepo PORT
packages/google-sheets Sheets v4 fetch client + 3 tools + SheetRegistry/AccessToken/SheetWriteLog PORTS
```

Monorepo ≠ one deployable. The build must stay able to emit a lean per-app
image (`pnpm deploy --filter`), which is what makes "one agent per VM" possible
later — see [lean-docker-build](decisions/lean-docker-build.md).

## Dependency direction

Strictly downward; no package imports one above it.

```
                        apps/hermes
                             │  (imports all nine; the ONLY place they are wired together)
     ┌───────────┬───────────┼───────────┬───────────┬──────────┬─────────────┬───────────────┬───────┐
     ▼           ▼           ▼           ▼           ▼          ▼             ▼               ▼       ▼
  config       store     channels       llm      telemetry    agent     google-auth   google-sheets  core
     │           │       (only dep)  (only dep)  (only dep)  (core+llm)  (only dep)     (only dep)
     └───────────┴───────────┴───────────┴───────────┴──────────┴─────────────┴───────────────┴─────► core
```

The siblings on that row are siblings, not a chain: none of them may import
another. `store → google-auth` existed briefly (for the `GoogleAccount` row
shape) and was removed — see the `packages/google-auth` bullet below.

- `packages/core` depends on no other `@hermes/*` package. It is where ports
  live so lower packages can be depended on without depending on their
  implementations. Its one exception is `zod`: `Message` and its four role
  variants (`SystemMessage`/`UserMessage`/`AssistantMessage`/`ToolMessage`),
  and likewise `GoogleAccount`/`TokenEnvelope`, are schema-first
  (`04-google-auth` Phase 1), so `@hermes/store` can
  validate a stored `threads.messages` or `google_accounts` row against the
  exact same shape the rest of the codebase compiles against, instead of a
  hand-mirrored copy that could silently drift. `zod` is a leaf, third-party validation
  library already load-bearing in `packages/agent`/`packages/config`, not
  another `@hermes/*` package's implementation `core` would be coupling to —
  the zero-*internal*-dependency reasoning above is unaffected by it.
  `core` also now carries **behavior**, not just shapes and ports:
  `withHttpRetry` (`http-retry.ts`) is the single retry/backoff/per-attempt-
  timeout/signal-composition mechanism for all three HTTP callers — `llm`,
  `channels`, `google-sheets`. It stays a legitimate `core` citizen because it
  knows nothing protocol-specific: retry *classes* are caller-named, `classify`
  and any `Retry-After` parsing are caller-owned, and it never reads or writes
  request/response content, so redaction cannot leak through it. Editing it
  touches the LLM billing path and the Telegram poll loop at once — see
  [http-retry-helper-extraction](decisions/http-retry-helper-extraction.md).
- **`packages/channels` must not depend on `packages/store`.** It needs a
  persisted poll offset, but takes an injected `TelegramOffsetRepo` port
  (`{ getOffset, setOffset }`) instead of importing Postgres. `boot.ts` binds it
  to `@hermes/store`'s `getOffset`/`setOffset`. This keeps the channel adapter
  free of a database, testable with a two-method mock, and reusable by a future
  Slack/WhatsApp adapter with a different persistence story. Reversing this and
  importing `@hermes/store` from `channels` is the easiest boundary in the tree
  to break by accident.
- **`packages/llm` depends on `packages/core` only** — never `@hermes/config`
  or `@hermes/store`, both of which it has a standing temptation to import:
  - *config* — env shape is boot's concern.
    `apps/hermes/src/llm/build-provider-profiles.ts` is the one place allowed
    to import both `@hermes/config` and `@hermes/llm`, mapping flat env fields
    into the `ProviderProfile` the adapter needs.
  - *store* — the adapter both writes a usage row per call and reads this
    month's spend for the budget ceiling, but through two injected ports:
    `LlmUsageRepo` (`{ recordUsage }`) and `BudgetUsageRepo`
    (`{ sumCostSince }`), same shape as `channels`' `TelegramOffsetRepo`.
    `apps/hermes/src/llm/build-llm-provider.ts` binds both to `@hermes/store`
    against the one pool, and is the only place that also imports
    `@hermes/config` (for the cap). That binding is extracted out of `boot.ts`
    because `boot()` has no testable seam. `usageRepo` and `budget` are
    **required** adapter options — only `logger` still defaults to a no-op —
    so a construction site that forgets either fails to compile instead of
    silently disabling cost recording and the ceiling that reads from it.
  - The row's shape, `LlmUsageEntry`, lives in `@hermes/core` and is
    re-exported by both `llm` and `store`, so neither side can drift a field
    apart without a type error. `GoogleAccount` follows the same rule for
    `google_accounts` — see the `google-auth` bullet below.
- **`packages/telemetry` depends on `packages/core` only at runtime** — never
  `@hermes/store` in shipped code, the same boundary `llm` holds and for the
  same reason. (`@hermes/store` is a devDependency solely for the DB
  integration test, which exercises the injected repo ports against a real
  database.) It
  takes two injected ports: `TelemetryEventRepo` (`{ insertEvents }`) for the
  write side and `StatsRepo`
  (`{ sumCostSince, getLlmCallStatsSince, getTopToolsSince }`) for `/stats`'
  read side. `apps/hermes/src/telemetry/build-telemetry-recorder.ts` and
  `build-stats-repo.ts` bind both to `@hermes/store` against the one pool.
- **`llm` and `telemetry` never import each other**, in either direction. The
  recorder *port* lives in `core`, so `llm`'s adapter emits through
  `opts.recorder?: TelemetryRecorder` and `apps/hermes` is the only place that
  passes the concrete handle in. `StatsRepo.sumCostSince` is re-declared in
  `telemetry` with the same shape as `llm`'s `BudgetUsageRepo.sumCostSince`
  rather than imported; `apps/hermes` wires the *same* `@hermes/store`
  `sumCostSince` into both, which is what makes the cost-source split hold in
  practice and not just in prose — see
  [telemetry-event-schema](decisions/telemetry-event-schema.md).
- **`packages/agent` depends on `packages/core` and `packages/llm` only** —
  never `@hermes/store` and, the newer temptation, never `@hermes/channels`.
  Both are reached through injected ports declared inside `agent`:
  - `ThreadRepo` (`{ getOrCreateThread, appendMessages }`), bound in
    `apps/hermes/src/store/build-thread-repo.ts`.
  - `ApprovalGate` (`{ requestApproval }`), whose `ApprovalRequest` carries only
    `{ tool, args }` and whose context carries only `{ threadId, turnId }` — no
    chat id, no message id, nothing a second channel could not supply. The
    Telegram implementation lives in
    `apps/hermes/src/agent/telegram-approval-gate.ts`; see
    [approval-gate-design](decisions/approval-gate-design.md), including the
    `threadId → chatId` stopgap that boundary forces on `apps/hermes`.
  `apps/hermes/src/agent/build-agent.ts` is the one place allowed to construct
  the `AgentDefinition` and bind both ports, and the only place a tool
  definition lives — `packages/agent` never imports a feature package. That
  rule plus `AgentDefinition` itself *are* the whole of the reserved D4
  multi-agent seam; nothing else for it is built, and
  [agent-multi-agent-seam](decisions/agent-multi-agent-seam.md) says what that
  does and does not buy.
- **`packages/google-auth` depends on `packages/core` only** — never
  `@hermes/store`, and `@hermes/store` never on it. Persistence is the
  injected `GoogleAccountRepo` port (`{ getAccount, upsertAccount,
  deleteAccount }`), bound in
  `apps/hermes/src/store/build-google-account-repo.ts`, same shape as
  `agent`'s `ThreadRepo`. The *row* shape both sides need —
  `googleAccountSchema`/`GoogleAccount`, and the `tokenEnvelopeSchema` it
  embeds — lives in `@hermes/core` (`google-types.ts`) and is re-exported by
  both `google-auth` and `store`, the identical arrangement `LlmUsageEntry`
  uses. It briefly lived in `google-auth` with `store` importing it, which
  put a sibling edge in this row and re-exported another sibling's surface
  through `store`'s public API; moving the shape down to `core` is what
  removes it. Only the *port* (a consumer-defined interface) and the crypto
  that seals and opens an envelope stay in `google-auth`.
- **`packages/google-sheets` depends on `packages/core` only** — notably *not*
  on `google-auth`, its nearest sibling, and not on `agent`. Three
  consumer-declared ports carry everything it needs: `SheetRegistryPort`
  (bound in `apps/hermes/src/store/build-sheet-registry-repo.ts`),
  `AccessTokenPort` (bound in `apps/hermes/src/google/build-access-token-port.ts`
  over the one `RefreshCoordinator`), and `SheetWriteLogPort` (bound inline in
  `boot.ts`, the same shape `llm_dedupe`'s `dedupeRepo` uses — one caller does
  not earn its own binder file). Two consequences are easy to get wrong:
  - **The scope gate is not in this package.** `withRequiredScopes` lives in
    `apps/hermes` because `packages/agent` may not import `google-auth` or
    `store`, and `google-auth` may not import `store`'s account repo. Each tool
    here exports the *base*, ungated `ToolSpec`; `build-agent.ts` wraps it, the
    same split `whoami` uses. `TOOL_REQUIRED_SCOPES` in `google-auth` is the
    single declaration of what a tool needs — never hardcoded at the wiring
    site.
  - **It does not import `@hermes/agent` even for a type.** The tools return
    plain objects structurally compatible with `ToolSpec`; `apps/hermes` is
    where that match is actually type-checked. Adding a type-only import here
    would put an `agent → google-sheets` shaped edge back in this row.
  `SheetRegistryEntry` follows `GoogleAccount`'s arrangement — declared in
  `core`, re-exported by both `store` and `google-sheets` — applied up front
  this time rather than retrofitted after review.
- Type-level leakage counts too: `pg`'s `Pool` reaches `apps/hermes` only via a
  re-export from `@hermes/store`, so `pg` stays store's declared dependency and
  a missing dep is caught by `pnpm -r typecheck` (which runs before `build`).

## Data flow

`getUpdates` returns two kinds of update, and the loop treats them
asymmetrically — a message is dispatched **detached** (its offset advances at
once, several can be in flight), a `callback_query` is awaited inline. That
asymmetry is the approval gate's precondition, not an optimization; read
[poller-concurrent-message-dispatch](decisions/poller-concurrent-message-dispatch.md)
before touching either branch.

```
Telegram getUpdates (long poll, 30s)
   │
   ▼  packages/channels/src/telegram/client.ts   ← retry/backoff, token redaction
   │
   ├─ callback_query ─► normalizeTelegramCallback  ← drops one with no message/data
   │        ▼  InboundCallback  →  channel.subscribeCallback  →  apps/hermes
   │        │     telegram-approval-gate.handleCallback: resolve the pending
   │        │     approval, answerCallback, editMessage (buttons made inert).
   │        │     NOT behind withAllowlist/withPrivateChat — it answers a
   │        │     prompt this bot sent into an already-allowlisted chat.
   │        ▼  AWAITED inline, then setOffset. Crash-replay preserved.
   │
   ▼  message / edited_message  →  normalizeTelegramUpdate
   │                                              ← drops updates with no message.from
   │                                                (no user id ⇒ fail-open risk)
   ▼  InboundMessage (provider-neutral; carries updateId — the dedupe key's
   │                   only source, hence required, not optional)
   │  DETACHED here: setOffset(update_id + 1) runs now, not after the handler
   │
   ▼  apps/hermes  withAllowlist( withPrivateChat( dispatchCommand ) )
   │                    │              │
   │                    │              └─ non-private chat rejected even for an
   │                    │                 allowlisted sender: replying into a
   │                    │                 group broadcasts to everyone in it
   │                    └─ unknown sender rejected before anything else looks at it
   ▼  handler: /ping | /start | /stats | else → completionHandler   ← the fallthrough is
   │                                    │                    PAID from here on
   │                                    ▼  dedupe claim `telegram:<updateId>`
   │                                    │     →  packages/store  →  llm_dedupe
   │                                    │     already completed ⇒ resend the
   │                                    │     stored reply, zero provider calls
   │                                    ▼  agent.handleMessage → packages/agent
   │                                    │     runTurn: load thread, trim, then up
   │                                    │     to MAX_ITERATIONS model calls
   │                                    │     ├─ tool calls, run concurrently:
   │                                    │     │   ungated → invoke straight away
   │                                    │     │   requiresApproval → ApprovalGate
   │                                    │     │     → prompt with inline keyboard
   │                                    │     │     → PARKED until the tap comes
   │                                    │     │       back via the branch above
   │                                    │     │       (or 5min ⇒ denied, or abort)
   │                                    │     └─ each emits one tool.call event
   │                                    ▼  packages/llm adapter
   │                                    ▼  budget check: SUM(cost_usd) since the
   │                                    │     1st of this month, UTC (injected
   │                                    │     Clock) → packages/store → llm_usage
   │                                    │     spend >= cap ⇒ BudgetExceededError
   │                                    │     BEFORE any fetch: zero provider
   │                                    │     calls, fixed reply, no new row,
   │                                    │     and no llm.call event either
   │                                    ▼  provider HTTP (retries live in here,
   │                                    │     i.e. inside the already-checked call)
   │                                    ▼  llm_usage row via injected LlmUsageRepo
   │                                    │     →  packages/store  →  llm_usage
   │                                    ▼  llm.call event via injected
   │                                    │     TelemetryRecorder — returns at once,
   │                                    │     the INSERT happens on a later flush
   │                                    │     →  packages/telemetry  →  telemetry_events
   │                                    ▼  result.text
   │                                 channel.send() → chunkText → sendMessage
   │                                    ▼  dedupe complete, storing the reply —
   │                                    │     AFTER the send, never before
   │
   ▼  nothing left to ack: this update's offset advanced back at the DETACHED
       mark. A failure anywhere below it is terminal — logged, never retried.
```

`echo.ts` is still in the tree as a reference/fallback but is no longer wired:
`completionHandler` took its place as `dispatchCommand`'s fallthrough. The
allowlist gate stays outermost precisely because that fallthrough now spends
money — an unknown sender is rejected before it can reach `complete()`. The
usage row is written from the adapter's success path, so a failed call records
nothing and a retried one still records exactly once; see
[llm-cost-accounting](decisions/llm-cost-accounting.md). One message now costs
up to `MAX_ITERATIONS` (8) calls to `complete()`, all routed through
`packages/agent`'s `runTurn`, which loads the conversation before the loop
starts and appends the user and final assistant messages after it — why the
loop is bounded there, and why a failed tool call feeds back instead of ending
the turn, is [agent-loop-design](decisions/agent-loop-design.md). History lives in `threads`,
one row per `(channel, chat_id)`, written by `packages/store`'s
`thread-repo.ts` and reached only through an injected `ThreadRepo` port, so
`packages/agent` never imports `@hermes/store` and the dependency direction
holds. Persisting rather than holding history in process is what makes memory
survive a restart — the reason it is a table and not a `Map`. The `ApprovalGate`
port is injected the same way and for the same reason, and is the one step in
that loop that can park a turn for minutes; the approval prompt and the tap that
answers it travel the *outbound* and *callback* paths above, not this one. See
[approval-gate-design](decisions/approval-gate-design.md).

### Inside a Sheets tool call

The "tool calls, run concurrently" step above expands like this for the three
Sheets tools. What matters is *how many refusals happen before any network I/O*
— every one of them is deliberate, and each lives in a different package:

```
 tool call: sheets_read { sheet: "clients", range: "A1:D50" }
   │
   ▼  WRITE ONLY: packages/agent  prepareGatedCall — runs BEFORE the prompt
   │  │  (safeParse first, then ToolSpec.prepare, raced against timeoutMs;
   │  │   a throw/timeout/abort ⇒ {ok:false, reason:"prepare_failed"})
   │  │
   │  ├─ apps/hermes  withRequiredScopes wraps prepare too
   │  │    no account / missing scope ⇒ the same refusal the handler's wrap
   │  │    returns, one step earlier — NO prompt sent
   │  │
   │  ├─ packages/google-sheets  sheets_write's prepare
   │  │    resolveSheet unknown  ⇒ {ok:false, reason:"unknown_sheet", ...}
   │  │    entry.access !== "readwrite" ⇒ {ok:false, reason:"read_only_sheet"}
   │  │      both refuse fail-closed, BEFORE any human is asked
   │  │    otherwise ⇒ plan {sheetSlug, spreadsheetId,
   │  │                      effectiveValueInputOption}  →  ctx.plan
   │  │              + ApprovalSummary  →  the legible prompt
   │  │
   │  ▼  ApprovalGate.requestApproval (survivors only; skipped if none)
   │        denied / timed out / aborted ⇒ "user did not approve"
   │
   ▼  apps/hermes  withRequiredScopes(name, {googleAccountRepo, requiredScopes})
   │     no account, or granted scopes ⊉ TOOL_REQUIRED_SCOPES.get(name)
   │     ⇒ {ok:false, reason:"missing_scope", fix:"run /connect google sheets"}
   │        NO token fetched, NO API call, handler never entered  (invariant 7)
   │
   ▼  packages/google-sheets  the base ToolSpec's handler
   │  ├─ READ ONLY: resolveSheet(SheetRegistryPort, "clients")
   │  │    ← reads sheet_registry
   │  │    LIVE, every call, no cache: an operator edit lands on the next
   │  │    tool call, not the next restart
   │  │    unknown ⇒ {ok:false, reason:"unknown_sheet", available:[...]}
   │  │    WRITE: already resolved in prepare — read off ctx.plan, never again
   │  │
   │  ├─ WRITE ONLY: SheetWriteLogPort.claim(sha256(channel, userId, turnId,
   │  │    tool, canonical args))  →  packages/store  →  sheet_write_log
   │  │      alreadyComplete ⇒ return the STORED outcome, no API call
   │  │      alreadyPending  ⇒ return the ambiguous hedge, no API call
   │  │
   │  ├─ AccessTokenPort.getAccessToken(channel, channelUserId)
   │  │      →  google-auth's ONE RefreshCoordinator.getValidAccessToken
   │  │      →  refresh (single-flight) persists via UPDATE-only
   │  │         updateRefreshedTokens  →  packages/store  →  google_accounts
   │  │
   │  ├─ WRITE ONLY, mode "update": one getValues snapshot of the range about
   │  │    to be overwritten (still via the client's shared retry) — non-fatal,
   │  │    logged and skipped on failure  →  result.replaced
   │  │
   │  ▼  sheets-client.ts  →  withHttpRetry  →  Sheets v4 REST
   │        read:  retries freely (GET is idempotent)
   │        write: pre-send failure retries; post-send is per-mode —
   │               PUT retries once internally, :append never does
   │
   │     READ RESULTS ARE BOUNDED HERE, client-side, after the response:
   │     truncateBySize (500 cells / 4 000 chars, whole rows for sheets_read,
   │     whole tabs for sheets_inspect, whole rows for `replaced`) adds
   │     truncated/returned*/total*/note only when it actually cut something
   │
   ▼  WRITE ONLY: resolve the claim
        success / ambiguous ⇒ complete(outcome)      ← the durable audit
        definitive 4xx or exhausted 429 ⇒ release()  ← provably never landed
        anything else ⇒ leave it pending             ← when in doubt, hedge
```

The whole handler is bounded by `ToolSpec.timeoutMs` (30s for these three,
against the 10s default), and the same bound is what `prepare` races under;
the client's own `REQUEST_TIMEOUT_MS` (10s) bounds one HTTP attempt inside
either. The top block is `sheets_write`-only: reads are ungated, so they skip
straight to the scope gate. What moved there in
`06-legible-approvals-bounded-reads` is the *read-only refusal* — it used to
sit in the handler, after a human had already been asked to approve a write
that could not run; it is now a `prepare` refusal that never sends a prompt at
all, alongside the unknown-slug refusal that always short-circuited. See
[google-sheets-scope-and-registry](decisions/google-sheets-scope-and-registry.md),
[sheets-write-dedupe-as-audit](decisions/sheets-write-dedupe-as-audit.md),
[tool-prepare-hook](decisions/tool-prepare-hook.md),
[bounded-tool-results](decisions/bounded-tool-results.md) and
[per-tool-timeout](decisions/per-tool-timeout.md).

The `llm.call` event that rides alongside that write is deliberately **not** the
same shape of guarantee, and the three differences are the whole point of
keeping them separate paths. It fires on provider *failure* as well as success
(`llm_usage` records nothing on a failure — no tokens were billed), it never
fires on a budget rejection (no call was attempted, so `/stats`' error rate
cannot conflate a policy stop with a call failure), and it is buffered and
at-most-once rather than written inside `complete()`'s await chain — a slow or
down Postgres degrades telemetry fidelity instead of delaying or failing a
user's reply. `llm_usage` is a ledger, `telemetry_events` is an instrument; see
[telemetry-event-schema](decisions/telemetry-event-schema.md).

Both gates on that path — the dedupe claim and the budget check — are only
worth anything *before* `complete()`; run either after the call and it records
the spend it existed to prevent. The two failure shapes are deliberately
opposite: a breached ceiling **blocks** (fail closed, the operator asked it to
stop), while a `pending` dedupe row stays **claimable** (fail open, because a
wedged message is worse than one bounded duplicate charge). That fail-open
branch is not a retry for a message update: its offset is acked before its
handler is dispatched, so nothing redelivers the update and nothing reaches
the branch — a `pending` row left by a failed message turn is inert and that
turn is lost, not retried. The branch earns its keep for `callback_query`,
which is handled before its offset is written and therefore really can be
replayed after a partial turn — see
[telegram-long-polling-correctness](decisions/telegram-long-polling-correctness.md).

`llm_usage` is therefore read and written on the same path: the ceiling's
read is what the previous calls' writes fed. That makes anything which
suppresses a write (an unpriced model, a dropped insert) also loosen the
ceiling — see [monthly-budget-ceiling](decisions/monthly-budget-ceiling.md)
for why the check sits before `fetch` and why it bounds spend to within one
call's cost of the cap rather than stopping exactly at it.

For a `callback_query`, the offset write is still the last step of handling the
update, and a throwing callback handler aborts the rest of the batch so no later
update's offset can leapfrog the one that failed. For a message it is strictly
the *first* step: since `07-one-paid-turn-one-outcome`, `setOffset` is awaited
to completion **before** `dispatchMessage` is invoked, so a failed ack replays
an update whose handler never ran, and a successful ack means no redelivery can
race the still-running handler. The handler itself is still never awaited; it
runs detached and its failures are logged, never retried, and never allowed to
stop the batch. Both halves of that asymmetry are
load-bearing — see
[poller-concurrent-message-dispatch](decisions/poller-concurrent-message-dispatch.md).

## Boot and shutdown order

Both orders are load-bearing; each step is a precondition for the next.

**Boot** (`apps/hermes/src/boot.ts`): config → `assertModelsPriced` → logger →
pool → `waitForDatabase` → migrations → `deleteWebhook()` → **advisory lock** →
health server → poller → telemetry recorder + handlers → shutdown registration.

- `assertModelsPriced` runs on `LLM_PRIMARY_MODEL` and (when set)
  `LLM_FALLBACK_MODEL` immediately after config loads, before any DB or network
  I/O — the cheapest step is also the one that must fail first. It is the
  primary defense that keeps `resolveCostUsd`'s `UnpricedModelError` a rare
  backstop rather than a live-call hazard; see
  [llm-cost-accounting](decisions/llm-cost-accounting.md).
- The telemetry recorder is built *after* the pool (it writes through it) and
  handed to two places at once: the handler wiring, which passes it into the LLM
  adapter, and `registerShutdown`, where it is a **required** dep. Required, not
  optional-with-a-default, because this project has twice shipped a fully tested
  mechanism that the real construction site silently never received.
- Two Google capabilities are built **once** in boot and injected, rather than
  reconstructed per consumer: the single `RefreshCoordinator` (its single-flight
  map is per-instance state — two instances can refresh one account
  concurrently) and `decryptRefreshToken(account)`, a narrow closure over the
  crypto key handed to `/disconnect` so no handler ever receives raw key
  material and `GoogleAccountRepo` can keep never decrypting. The
  `OAuth2Client` underneath is stateless-per-call and is deliberately still
  constructed per builder — the distinction is state, not tidiness. See
  [google-token-refresh](decisions/google-token-refresh.md).
- `deleteWebhook` is unconditional and idempotent: a webhook and `getUpdates`
  are mutually exclusive on Telegram's side, so a leftover webhook from another
  deployment mode would silently starve the poller.
- The lock is taken **before** the health server starts, so an instance that
  loses the race never briefly reports healthy.
- Losing the lock sets `process.exitCode = 1` and awaits `pool.end()` rather
  than calling `process.exit(1)` — `process.exit` truncates async stdout piped
  to Docker and can drop the very error line the operator needs. The same
  pattern guards the fatal-poller-error path.
- **Known gap:** migrations run *before* the lock is taken, so two simultaneous
  cold boots race to a duplicate-table error instead of the readable
  single-instance message. Accepted, not fixed.

**Shutdown** (SIGTERM/SIGINT, registered once): `controller.abort()` →
`channel.stop()` (bounded 5s) → `telemetryRecorder.stop()` (bounded 1s) →
`lock.release()` → `pool.end()` → `process.exit(0)`, with an 8s hard-exit timer.

- Release before the drain finishes and a restart-racing instance can acquire
  the lock while this one is still querying. Close the pool before the drain
  finishes and an in-flight query crashes. Hence this exact order.
- The telemetry flush sits *after* the drain so it captures events from work
  that was still in flight, and *before* `pool.end()` so its own `INSERT` has a
  live pool to write through. Those two constraints leave it exactly one slot.
- It gets its own deliberately small budget (`TELEMETRY_FLUSH_TIMEOUT_MS`, 1s)
  via the same `withTimeout` helper the drain uses, not a second timeout
  mechanism. `packages/telemetry`'s own `stop()` has no internal timeout — it
  has no concept of the process's shutdown budget, so bounding it is the call
  site's job. 5s of drain + 1s of flush still leaves room under the 8s
  hard-exit ceiling for `lock.release()`/`pool.end()`; a hung flush degrades to
  "lose the unflushed buffer," never to "hang shutdown," which is the
  at-most-once tradeoff telemetry already accepts everywhere else.
- `controller.abort()`'s signal is threaded into the poller's in-flight
  `getUpdates` call (`packages/channels/src/telegram/{client,poller}.ts`), so
  `channel.stop()`'s drain resolves as soon as abort fires on an idle bot
  instead of always burning the full 5s bound. The same abort is what resolves
  any approval a turn is parked on — as `"denied"`, immediately, with no further
  Telegram calls — so `channel.stop()` never waits out the gate's 5-minute
  window.
- `channel.stop()` now drains more than the in-flight poll iteration: message
  dispatches detached from it are tracked and awaited too, or shutdown would
  report the channel drained while a paid turn was still running against a pool
  about to close. That drain shares the one 5s bound, so a turn slower than that
  is cut off, not waited for.
- 5s / 1s / 8s are sized against `docker-compose.yml`'s explicit
  `stop_grace_period: 15s` for the `hermes` service — revisit all four
  together if any one of them changes.
- The hard-exit timer is deliberately *not* cleared in a `finally`: a rejected
  shutdown (`release()`/`pool.end()` throwing because the DB is already down) is
  the exact case the guard exists for, so it must survive the failure path.

## Verifying a change against the running bot

Two traps make a manual check silently prove nothing. Both were hit during
01-llm-port Phase 4.

- **`.env` is per-directory and gitignored.** A worktree gets its own `.env`
  that does not track the repo root's, and `docker compose` interpolates the
  one in the directory it runs from. Editing the wrong copy changes nothing
  the bot reads, with no warning either way.
- **`docker compose restart` re-reads neither `.env` nor rebuilt code.** The
  `hermes` service is `build: .`, so a restart replays the existing image with
  its already-resolved environment. `docker compose up -d --build` is the only
  command that makes a manual verification of new behavior meaningful — a
  container built before the feature existed will happily reproduce the old
  behavior and read as a failed change.

Verifying spend behavior additionally means querying `llm_usage` in the *app*
database, which is the same table the DB test lane must never touch — see
[test-database-isolation](decisions/test-database-isolation.md).
