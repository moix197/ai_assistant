# Plan: Google Sheets (Roadmap Phase 4)

**Created:** 2026-08-28
**Branch:** `feat/05-google-sheets`
**Status:** not started

## Context

`04-google-auth` gave Hermes a Google identity: an encrypted, auto-refreshing
OAuth token per Telegram user, and exactly one Google-backed tool (`whoami`)
that never called a real Google API. This plan ships the first real Google
capability: a generic `@hermes/google-sheets` package that lets the agent
read and write spreadsheets the operator has pre-registered under short
slugs. **Nothing trading-specific ships here.** No trade schema, no PnL/R
multiple/win-rate math, no `log_trade`/`update_trade`/`close_trade`/
`query_trades` tools, no trading column-mapping, no NL trade parsing, no
`trading-journal` package. A later domain layer — a package that maps
trading semantics onto specific registered sheets and calls this package's
generic read/write tools underneath — would sit *above* `@hermes/google-sheets`
as its own future package; none of it is designed or scaffolded here.

The exit criterion is eight observable behaviors, not a layer being built:
an identity-only account is refused a Sheets read with no API call made; the
scope upgrade flow (`/connect google sheets`) works end to end; a natural
read ("what appointments do I have this week?") returns real rows; a
natural write ("add a client...") shows an in-chat confirmation and, once
approved, actually lands; a repeated write in the same turn doesn't
double-append; a write to a read-only sheet is refused before any API call;
an unknown slug is refused with the valid slugs listed; and `/disconnect`
actually revokes the grant at Google, not just locally.

**Explicitly out of scope, owned by later work:**

- **Any trading-domain concept.** Covered above — this plan is the generic
  capability only.
- **Drive API / search-by-name.** Scope is `spreadsheets` only (settled
  decision 1); a spreadsheet is identified by operator-registered slug, never
  a raw ID/URL typed in chat (settled decision 2).
- **A generic `ConfigRegistry<T>` or `tool_config` blob table.** One instance
  (sheets) ships; the pattern is documented (settled decision 7), not
  abstracted, until a second real case exists.
- **Google API verification review.** `spreadsheets` is a sensitive scope;
  verification is required only if the app leaves Testing publishing status —
  named as a risk in Prerequisites, not solved here.
- **Automated key rotation, a second identity provider, persisted
  pending-connection state, tokenizer-accurate context budgeting.** Same
  non-goals `04-google-auth` recorded, unchanged by this plan.
- **GCM AAD binding on the token envelope.** Already deferred in
  `04-google-auth`'s Final Verification; this plan's revocation work
  (Phase 6) re-records the reasoning now that the envelope's blast radius
  (a stolen envelope can read/write every registered sheet, not just prove
  identity) has grown, and confirms the deferral still holds.

**Packages created here**, per D3 ("create at its phase, never
merge-then-split"): `packages/google-sheets` only.

**Packages modified here:** `packages/core` (new shared HTTP retry/backoff/
timeout helper — settled decision 13), `packages/llm` and `packages/channels`
(migrated onto that helper with no behavior change — same decision),
`packages/agent` (`ToolSpec` gains `timeoutMs?: number`, honored in
`loop.ts`'s handler race — settled decision 14), `packages/google-auth`
(`scopes.ts` gains `SHEETS_SCOPES`, `buildAuthUrl` gains
`include_granted_scopes`, `completeConnect` validates against the pending
connection's *requested* scopes instead of a hardcoded constant, a new
`revokeToken` for Phase 6 — settled decisions 8, 9, 19), `packages/store`
(migration `008_sheet_registry.sql`, a new `sheet-registry-repo.ts`, a new
`hermes-sheets` CLI bin, migration `009_sheet_write_log.sql` for the write
dedupe/audit table — settled decisions 3, 4, 6, 12), `packages/core`
(`google-types.ts` gains the schema-first `SheetRegistryEntry` shape shared
between `store` and `google-sheets`, avoiding the sibling edge
`04-google-auth`'s Final Verification had to fix after the fact — see
Dependencies & Risks), `apps/hermes` (`build-agent.ts` gains three tools plus
a `withRequiredScopes` decorator, `boot.ts` gains the registry/token-port
bindings, `handlers/connect.ts` and `handlers/disconnect.ts` change per
settled decisions 8, 9, 19).

## Risk: high

Three things earn "high." First, Phase 1 is a horizontal refactor of the HTTP
layer underneath the LLM billing path and the Telegram client — the one
explicitly-justified exception to this plan's vertical-slice rule (settled
decision 13) — and a subtle regression there (a dropped retry, a
mis-composed `AbortSignal.any`, a swallowed `Retry-After`) would silently
change spend or message delivery behavior with no new test naming the
failure, because the whole point is that existing suites must pass
*unchanged*. Second, this plan hands the agent write access to a human's
spreadsheets for the first time — a bug in the approval gate, the access
check, or the idempotency key would let the model mutate a sheet the user
never confirmed, or double-apply a write the user confirmed once. Third, the
scope surface granted per account grows from "prove who you are" to "read
and write every spreadsheet you own," which raises the stakes of
`04-google-auth`'s already-deferred AAD gap and of `/disconnect` actually
meaning something at Google, not just locally — this plan closes the second
gap (Phase 6) and re-confirms the first is still an acceptable deferral
given that growth.

## Dependencies & Risks

- **The HTTP extraction (settled decision 13) is a refactor, not a slice, and
  is verified by unchanged behavior, not new behavior — and `llm` and
  `channels` genuinely diverge in three ways, checked against both source
  files directly, not assumed away.** `packages/llm/src/adapter/openai-compatible.ts`
  and `packages/channels/src/telegram/client.ts` each hand-roll an injectable
  `fetchImpl`, a per-request timeout, bounded retries, a provider
  `Retry-After` beating computed backoff, and secret redaction from thrown
  error strings — `packages/llm/src/errors.ts` states outright "project
  convention: llm throws," never `Result`. But they are not the same shape
  underneath, and the shared helper's contract has to fit the union of both,
  not the intersection:
  1. **Retry-class count differs: 2 vs. 3.** `llm`'s `completeWithRetry`
     (`openai-compatible.ts:489-534`) has exactly two counters,
     `MAX_RATE_LIMIT_RETRIES = 5` (429) and `MAX_TRANSIENT_RETRIES = 5`
     (5xx/network/timeout). `channels`' `callWithRetry`
     (`client.ts:281-335`) has **three**: the same two, plus
     `MAX_CONFLICT_RETRIES = 3` for HTTP 409 (`getUpdates`' "another
     consumer already polling" conflict) — a Telegram-specific failure mode
     `llm` has no equivalent of, with its own bound and its own
     exhausted-retries message (`client.ts:305-317`).
  2. **`Retry-After` resolution differs.** Both parse the `Retry-After`
     header. `llm` additionally falls back to a body-embedded
     `google.rpc.RetryInfo` `retryDelay` duration when the header is absent
     (`parseRetryInfoDelaySeconds`, `openai-compatible.ts:131-164`) — needed
     because Google's Generative Language API never sends the header on a
     429. `channels` has no such fallback; `Retry-After` absent means
     computed backoff, full stop.
  3. **Signal composition differs, deliberately, for a documented reason.**
     `llm` composes its per-request timeout with the external shutdown
     signal via `AbortSignal.any` (`composeSignal`, `openai-compatible.ts:365-370`).
     `channels` explicitly does **not** use `AbortSignal.any`
     (`client.ts:183-192`'s own comment): Node 22 never releases a dependent
     signal from a composite `AbortSignal` it created, so a new composite
     retained per ~30s long-poll call leaks (~2.5KB each, measured
     ~210MB/month for a long-running bot). `channels` instead attaches a
     manual `abort` listener onto its own `timeoutController` and removes it
     in a `finally` block. The shared helper must pick **one** composition
     mechanism both callers use — this plan picks the listener-based
     approach (proven leak-safe under repeated long-lived calls), so `llm`
     is the one migrating its *implementation* here, not just its call
     site: its externally-observable behavior (either signal aborts the
     request) is unchanged, but this is the one place in this phase where
     "unchanged behavior" is proven by a new test, not merely by an
     unmodified existing one — `llm`'s calls recur over the same
     long-running process `channels`' leak was measured on, so this also
     quietly closes a latent leak in `llm` no one had measured yet.

  **Consequence for `http-retry.ts`'s design:** `classify` cannot return a
  fixed rate-limit/transient bucket — it must let the caller register an
  arbitrary, caller-named set of retry classes, each with its own max-attempt
  count and backoff function, plus an optional per-attempt `retryAfterMs`
  override the helper's backoff honors ahead of computed delay (sourced
  however the caller likes — header, or `llm`'s body-fallback). That is what
  lets `channels` express its third `"conflict"` class with its own bound and
  message, and lets `llm` express its `RetryInfo` fallback as a value it
  computes and hands in, without either behavior becoming special-cased
  inside `core`. The helper does not itself decide "this is an
  `OpenAiRateLimitError`" or "this is 409"; it hands the caller's
  classification callback the response/error and lets the caller throw —
  that is what makes "preserve thrown-error types exactly" structurally true
  rather than merely tested. `packages/google-sheets`' client (Phase 4) is
  the *third* caller and gets no bespoke retry code of its own — it only
  supplies its own classification (Sheets' 429/5xx shapes, its own two
  classes) and redaction (Bearer token).

  Verification is the existing `llm` and `channels` suites passing with
  **zero assertion changes** to their test files beyond swapping in the
  shared helper — specifically
  `packages/llm/src/adapter/__tests__/openai-compatible.test.ts`,
  `openai-compatible-abort.test.ts`, `openai-compatible-budget.test.ts`,
  `openai-compatible-telemetry.test.ts`, `openai-compatible-usage.test.ts`
  for `llm`, and `packages/channels/src/telegram/__tests__/client.test.ts`,
  `client-send-chunking.test.ts` for `channels` — a red test in either after
  this phase means the extraction changed behavior, not that the test was
  wrong. The full `pnpm -r test` still runs as the broader net.
- **`include_granted_scopes` makes Google's response authoritative, so no
  client-side scope union ships (settled decision 8).** `buildAuthUrl` adds
  `include_granted_scopes: "true"`; a user who already granted identity and
  now runs `/connect google sheets` gets back the *cumulative* grant in the
  token response's `scope` field. `upsertAccount` keeps its existing plain
  overwrite semantics — writing union logic on top would fight Google's own
  accounting and risk drifting from what's actually authorized. `/connect
  google` (no argument) is unchanged: identity scopes only, same as today.
- **`completeConnect` moves from a hardcoded `IDENTITY_SCOPES` check to
  validating against the pending connection's own requested scopes, while
  identity stays non-negotiable (settled decision 9).** `startConnect`
  already threads `scopes: string[]` through to the pending-connection record
  (`04-google-auth` built this parameter in, unused until now). Identity
  scopes missing ⇒ reject `missing_scopes`, write no row — unchanged, no
  email means no account key. Sheets scope requested-but-not-granted ⇒
  **persist** whatever was granted (identity, at minimum) and tell the user
  plainly that Sheets wasn't granted and how to retry — this is a new branch
  `04-google-auth` never needed, because `whoami` requested only one
  all-or-nothing scope set.
- **`withRequiredScopes` finally makes `TOOL_REQUIRED_SCOPES` a real read
  path instead of a seeded-but-unread map (settled decision 10).**
  `packages/google-auth/src/scopes.ts` has carried
  `TOOL_REQUIRED_SCOPES: ReadonlyMap<string, readonly string[]>` since
  `04-google-auth`, seeded with `["whoami", IDENTITY_SCOPES]`, and nothing
  has ever consulted it — `whoami.ts` duplicates the check inline instead.
  This plan builds the decorator in `apps/hermes` (not `packages/agent`,
  which must never import `google-auth` or `store`, and not `google-auth`
  itself, which must never import `store`'s account repo) — it is the same
  kind of apps-hermes-only wiring `build-agent.ts` and
  `build-thread-repo.ts` already are. `whoami.ts` is refactored onto it and
  its inline duplicate deleted, so the pattern's first real usage is proven
  against a tool that already works, before the three new Sheets tools lean
  on it. Missing scope ⇒ `{ ok: false, reason: "missing_scope", scope, fix:
  "run /connect google sheets" }`, decorator returns before the wrapped
  handler runs at all — no token fetched, no API call, satisfying exit
  criterion 1 and ROADMAP invariant 7 (fail closed).
- **The registry is read fresh on every tool call, never frozen into a
  boot-time closure (settled decision 5), and the `sheet` tool arg is
  `z.string()`, not `z.enum` — deliberately.** A `z.enum` built at boot from
  the registry's current slugs would go stale the moment a future dashboard
  edits it without a restart, and — more immediately load-bearing for this
  codebase — the enum's literal values are baked into the tool's JSON schema,
  which is part of the array `03-agent-core`/`04-google-auth` established as
  prompt-cache load-bearing (ROADMAP invariant 6): a schema that changes
  bytes on every registry edit would invalidate the cache prefix on every
  operator config change, not just on a code deploy. Validation against the
  live registry happens **inside the handler**; an unknown slug returns
  `{ ok: false, reason: "unknown_sheet", available: [...] }` rather than a
  schema-validation rejection.
- **The registry lives in Postgres specifically because a dashboard is
  coming, and that contradicts a line in ROADMAP today (settled decision
  3).** ROADMAP §non-goals currently reads "not a dashboard." The long-term
  plan is a dashboard that edits this exact config remotely and deploys via
  CI/CD — a dashboard cannot edit a host `.env` file, and a JSON blob is not
  row-editable the way a table is. **This plan flags that ROADMAP line as
  needing an update** (see Knowledge Base Impact) rather than silently
  contradicting it. The registry's primary key is `slug` alone, not
  `(channel, channel_user_id)` — unlike `google_accounts`, a registered
  sheet is operator-level configuration shared across every connected
  identity in this single-tenant deployment, not per-user data; keying it to
  a channel/user pair would be modeling multi-tenancy this codebase
  explicitly doesn't have (ROADMAP §non-goals: "single-tenant... no
  multi-user").
- **`SheetRegistryEntry`'s shape lives in `@hermes/core` from the start, not
  as a deferred fix.** `04-google-auth`'s Final Verification had to move
  `GoogleAccount`/`TokenEnvelope` out of `google-auth` and into
  `core/src/google-types.ts` after review caught a `store → google-auth`
  sibling edge (that plan's finding 6). This plan applies the lesson up
  front: `sheetRegistryEntrySchema`/`SheetRegistryEntry` is declared in
  `core` from Phase 3 onward, re-exported by both `store` (which validates
  rows against it) and `google-sheets` (whose port and tools consume it) —
  the identical arrangement `GoogleAccount` and `LlmUsageEntry` already use.
  Only the **port** (`SheetRegistryPort`, a consumer-declared interface) and
  the Sheets HTTP client stay in `google-sheets` proper.
- **`hermes-sheets` lives in `packages/store`, mirroring `hermes-migrate`'s
  precedent exactly.** The registry repo is implemented in `@hermes/store`
  (settled decision 4); a CLI that's a thin wrapper over that package's own
  repo functions, writing through the same functions a future dashboard will
  call, belongs in the package that owns the table — the same reasoning that
  already put `hermes-migrate` there. No new package for one CLI bin, per
  CLAUDE.md's no-speculative-abstraction rule.
- **Write safety splits retryable from ambiguous by what a 429 vs. a timeout
  actually means (settled decision 15).** A 429 means Google rejected the
  request before applying it — safe to retry. A network timeout or a
  post-send 5xx means the request may have been applied and the response
  lost — retrying could double-append, so `sheets_write` returns an explicit
  "may or may not have landed, check the sheet" result instead of silently
  retrying. Reads carry no such risk (`GET` is naturally idempotent) and
  retry freely within the tool's timeout budget. Sheets' ~60
  requests/min/user quota is the practical trigger for the 429 path, not a
  hypothetical.
- **The approval gate's in-memory volatility is safe here because it fails
  toward not-writing (settled decision 11).** A restart drops a pending
  `sheets_write` approval the same way it already drops any pending
  approval — the model relays "still waiting" and the write simply never
  happens rather than happening unconfirmed. Reusing the existing gate
  (`apps/hermes/src/agent/telegram-approval-gate.ts`) needs no new
  durability work; a lost approval and a denied approval are the same safe
  outcome.
- **The write dedupe key includes `turnId` on purpose — it's a retry guard,
  not a permanent block (settled decision 12) — and `turnId` reaching the
  tool handler is a real, scoped `ctx` widening, decided here rather than
  left as a Phase 5 unknown.** Key = hash of `(channel, channelUserId,
  turnId, tool, canonical args JSON)`, mirroring `llm-dedupe-repo`'s
  claim/complete shape. Without `turnId`, a user asking to add the *same*
  client twice in two separate, later conversations would be silently
  swallowed as a false duplicate — the key's job is "don't double-apply a
  retried call within the turn that produced it," not "this exact row can
  only ever be written once." **`turnId` does not reach `ToolSpec.handler`
  today.** `packages/agent/src/types.ts`'s `ToolSpec.handler` signature is
  `(args: unknown, ctx: { signal: AbortSignal; channel: string;
  channelUserId: string }) => Promise<unknown>` — `04-google-auth` Phase 3
  widened it to carry `channel`/`channelUserId` but not `turnId`.
  `loop.ts` itself always knows the turn's id: `runTurn` generates it
  (`newId()`), threads it through `converse` → `executeToolCalls` →
  `resolveToolCall`/`runGatedToolCalls` as an explicit parameter (visible on
  every `finishToolCall`/`ToolCallEvent`, which already carries `turnId` —
  `packages/core/src/telemetry.ts`), but `invokeTool` (`loop.ts:143-171`),
  the one call site that builds `spec.handler(args, { signal, channel,
  channelUserId })` (`loop.ts:154`), simply never forwards it into `ctx`.
  **Resolved, not deferred:** `ctx` widens to `{ signal, channel,
  channelUserId, turnId }` — `invokeTool` gains a `turnId` parameter and
  `resolveToolCall` passes its own `turnId` argument through, the same
  mechanical shape `04-google-auth` Phase 3 used for `channel`/
  `channelUserId`. This lands as an explicit step in **Phase 4**, bundled
  with `ToolSpec.timeoutMs` (settled decision 14) since both widen the same
  `ToolSpec`/`loop.ts` surface in the same commit — one regression pass over
  `loop.ts`'s handler-invocation path instead of two across two phases. Two
  existing hand-built `ctx` literals in test files
  (`apps/hermes/src/agent/tools/__tests__/get-current-time.test.ts`,
  `echo.test.ts` — the same two `04-google-auth` Phase 3 had to fix for
  `channel`/`channelUserId`) need `turnId` added to typecheck, alongside
  this plan's own new `with-required-scopes.test.ts` and `whoami.test.ts`
  ctx literals from Phase 2. **Phase 5 does no further `loop.ts` change** —
  it only reads `ctx.turnId`, already present by the time `sheets_write`
  exists. Checked and **not needed**: `withRequiredScopes` (Phase 2) passes
  `ctx` through to the wrapped handler unchanged, so it needs no code change
  to carry `turnId` — the widening is transparent to it. The `ApprovalGate`
  (`requestApproval(batch, { threadId, turnId }, signal)`,
  `runGatedToolCalls` in `loop.ts`) already receives `turnId` as its own
  explicit parameter, sourced the same place `ctx.turnId` now is, not
  through `ctx` — no change needed there either.

  This same table is this plan's answer to invariant 3's durable write
  audit — `telemetry_events` is buffered and at-most-once (`04-google-auth`'s
  Data Flow section states this explicitly), so it cannot be the audit of
  record for a mutation; claim-before-call plus stored outcome can.
  Read-tool auditing stays deferred, recorded as an open item in
  `.ai/decisions/`, not silently dropped.
- **`value_input_option`'s stakes are real enough to state plainly, not just
  wire through (settled decision 17).** `USER_ENTERED` parses cell content
  the way a human typing it would — real dates and numbers land correctly,
  but a phone number like `+1-555-0100` can be read as a formula and error,
  and a leading zero like `0123` is dropped. `RAW` stores literally — safe
  for phone numbers and IDs, but a date lands as a text string, so any
  `SUM`/sort/chart the user already built over that column silently breaks
  on rows Hermes writes. The registry row's `value_input_option` sets the
  per-sheet default; a tool arg can override it per call.
- **The token seam is reused, not duplicated (settled decision 18).**
  `AccessTokenPort` is declared inside `google-sheets`
  (`account-repo-port.ts`'s consumer-declares-its-port convention, again),
  implemented in `apps/hermes/boot.ts` over
  `RefreshCoordinator.getValidAccessToken` — the single seam
  `04-google-auth` Phase 4 built specifically so a future request-path tool
  call would not need a second refresh path. The implementation persists a
  refreshed account via `updateRefreshedTokens`, the same **UPDATE-only**
  function `04-google-auth`'s refresh sweep uses (added in that plan's Final
  Verification to fix account-resurrection after a disconnect) — not a
  second, subtly different persist path.
- **`/disconnect` finally tells Google, not just Hermes (settled decision
  19).** Today it deletes the local row and leaves the grant live — a lie
  that was low-stakes when the only scope was identity and gets materially
  worse once the grant covers every spreadsheet a user owns. `POST
  https://oauth2.googleapis.com/revoke?token=<refresh_token>`, then delete
  the row **even if revoke fails**, logging the failure rather than
  blocking the local disconnect on an external call succeeding. GCM AAD
  binding stays deferred — the threat it would stop (an envelope copied
  between rows) already requires database write access, at which point an
  attacker has easier paths, and it's still true that adding AAD changes the
  envelope format and forces every connected user to re-consent; the
  reasoning is unchanged from `04-google-auth`, just re-confirmed now that
  the envelope's blast radius has grown.
- **No new dependency is expected (settled decision 20).** `googleapis` is
  rejected per ROADMAP §6 and CLAUDE.md's narrow-package-over-mega-package
  rule; the Sheets client is `fetch` plus the extracted core retry helper,
  the same posture `04-google-auth` took for `google-auth-library`'s narrow
  OAuth2 usage. If Phase 4 discovers a genuine need, it gets a written
  `.ai/decisions/` justification against both CLAUDE.md bars before landing,
  not silently.
- **No CI change.** No new live-provider test lane, no excluded-glob change —
  `pnpm test`/`pnpm test:db` already cover this plan's suites the way they
  cover `04-google-auth`'s.
- **`pnpm lint` is a named gate in Final Verification**, per the same lesson
  `04-google-auth`'s own Dependencies & Risks recorded from `03-agent-core`.

## HIL Prerequisites (manual, before Phase 1)

**Mode:** hil

Google's own console UI changes over time — treat every specific label and
menu path below as **verify at execution time**; the underlying requirement
is fixed.

- [x] Add `https://www.googleapis.com/auth/spreadsheets` to the OAuth
      consent screen's scope list in Google Cloud Console (the project from
      `04-google-auth`'s Prerequisites, not a new one).
- [x] Create the test spreadsheets this plan's manual verification needs
      (at minimum one to register as `readwrite` and one as `read`), and
      collect their spreadsheet IDs for `hermes-sheets add`.
- [x] **Flag as a risk, not solved here:** an app in **Testing** publishing
      status with **External** user type issues refresh tokens that expire
      after **7 days**, which breaks `RefreshCoordinator` on a weekly
      cadence regardless of which scopes are granted. Options: add test
      users and accept weekly reconnects, or move the consent screen toward
      verification. That decision belongs to whoever operates this
      deployment, not this plan.
- [x] Note for that decision: `spreadsheets` is a **sensitive** scope —
      Google verification review is required only if the app leaves Testing
      publishing status, not merely for requesting this scope while still in
      Testing.

---

### Phase 0: Create worktree

**This phase is always first. No exceptions.**

Follows the same sibling-worktree convention `04-google-auth` used.

**Steps:**

- [ ] Confirm with the user: branch name `feat/05-google-sheets`, base ref `main`
- [ ] `git worktree add ../hermes-05-google-sheets -b feat/05-google-sheets main`
- [ ] Verify worktree is active and on the correct branch: `git worktree list`
- [ ] **Explicit step, do not skip:** copy `.env` from the repo root into the
      new worktree (`../hermes-05-google-sheets/.env`) — gitignored, so the
      worktree starts without it, and without it the HIL Prerequisites'
      Google vars are invisible to the app.

---

### Phase 1: Shared HTTP retry/backoff/timeout helper — no behavior change

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** This phase is the one explicitly-justified exception
to the vertical-slice rule (settled decision 13) — its acid test is
"nothing observable changed." `packages/llm`'s and `packages/channels`'
existing test suites pass **unchanged in assertions**, with no edits to
their test files beyond what's required to inject the shared helper in
place of each package's own retry loop. Retry counts (2 classes for `llm`,
3 for `channels` — see Dependencies & Risks), `Retry-After` precedence over
computed backoff (including `llm`'s `RetryInfo`-body fallback), signal
composition with an external shutdown signal (migrated to the listener-based
mechanism for both callers), and secret redaction from thrown error messages
all behave exactly as they did before this phase, for both callers.
**Commit message:** `refactor: extract shared HTTP retry/backoff/timeout helper into core`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/core/src/http-retry.ts` | a low-level retrying-fetch primitive: a caller-supplied `attempt(signal): Promise<T>` performs the actual `fetch` (so `fetchImpl` injection stays entirely caller-owned, unchanged from before this phase — the helper itself never touches `fetch`); per-request timeout composed with an externally-supplied shutdown `AbortSignal` via a manual `abort`-listener (added on the external signal, removed in a `finally`) driving the request's own `AbortController` — **not** `AbortSignal.any`, adopting `channels`' proven-leak-safe mechanism for both callers (see Dependencies & Risks); a caller-supplied, **named** set of retry classes (e.g. `{ rateLimit: { maxAttempts }, transient: {...} }` — arbitrary keys, not a hardcoded pair), each with its own bounded attempt count and its own `nextDelay`-driven backoff; a caller-supplied `classify(error): { class: string; retryAfterMs?: number }` callback so the helper never hardcodes what "rate limited" means for a given protocol, and lets a caller (like `llm`'s `RetryInfo` body fallback) supply a computed `retryAfterMs` from anywhere, not just a header — **built without the `\| "fatal"` sentinel this row originally proposed**: a non-retryable error is thrown directly from `classify` instead, which the helper never catches, so "fatal" is expressed by an ordinary throw rather than a return value the helper would have to interpret; **no separate `redact(message)` hook was built either** — redaction stays entirely inside each caller's own `attempt`/`classify` (exactly as it was pre-phase), since the helper never constructs or even reads message content, so there is nothing for it to redact. The helper throws nothing typed of its own either way: callers construct and throw their own existing error classes, so each caller's exact thrown-error type is preserved by construction, not by convention |
| modify | `packages/core/src/index.ts` | export the new helper's public surface |
| modify | `packages/core/README.md` | document the helper: what it owns (timeout, listener-based signal composition, named-retry-class bookkeeping, backoff, `Retry-After`/`retryAfterMs` precedence), what it deliberately does not own (classification, error construction, redaction content, retry-class count or names) |
| modify | `packages/llm/src/adapter/openai-compatible.ts` | its hand-rolled retry loop (`completeWithRetry`) is replaced by a call into the new helper, supplying two named classes (`rateLimit` ← 429, `transient` ← 5xx/network/timeout) each with `maxAttempts: 5`, a `classify` that reproduces `parseRetryAfterSeconds`/`parseRetryInfoDelaySeconds`'s header-then-body fallback as the returned `retryAfterMs`, and its own error construction in the fatal branch — **no change to `packages/llm/src/errors.ts`'s thrown types**. `composeSignal`'s `AbortSignal.any` usage is removed; the helper's listener-based composition replaces it — this is the one implementation-level (not just call-site) change in this phase, justified by the leak evidence in Dependencies & Risks |
| modify | `packages/channels/src/telegram/client.ts` | same replacement, supplying **three** named classes (`rateLimit` ← 429 maxAttempts 5, `conflict` ← 409 maxAttempts 3 with its own exhausted-retries message per `client.ts:305-317`, `transient` ← 5xx/network/timeout maxAttempts 5); existing token-redaction logic is untouched, staying inline in this file's own `attempt`/error-construction code rather than a `redact` hook passed to the helper (see the `http-retry.ts` row above); its existing listener-based composition becomes the shared helper's, not a bespoke copy |
| modify | `packages/llm/package.json` | add `@hermes/core` version bump if needed (likely already a dep — verify at execution time) |
| modify | `packages/llm/README.md`, `packages/channels/README.md` | note the retry/backoff/timeout mechanics now come from `@hermes/core`'s shared helper; each package's own error types, classification, and retry-class counts (2 vs. 3) are unchanged and package-owned |

**Steps:**

- [x] Read both existing implementations in full before writing the helper —
      `packages/llm/src/adapter/openai-compatible.ts` and
      `packages/channels/src/telegram/client.ts` — and enumerate every
      behavior each one has: retry counts **and class names** (2 for `llm`,
      3 for `channels`, including `channels`' 409-conflict class and its
      distinct exhausted-retries message), exact `Retry-After` resolution
      (`llm`'s body-fallback included), exact signal-composition mechanism
      (`AbortSignal.any` for `llm` today vs. the listener pattern for
      `channels`), exact redaction — before touching either
- [x] Design `classify`'s contract so both callers' exact existing behavior,
      **including the class-count and `Retry-After`-fallback divergence just
      enumerated**, is expressible without a caller-specific branch inside
      the shared helper — if a behavior can't be expressed through
      `classify`/`redact`/the named-class map, that's a signal the helper is
      trying to own too much, not that a caller needs a special case
- [x] Build the helper's signal composition on the listener pattern from the
      start (not `AbortSignal.any`) — write a test proving the listener is
      removed once the request settles (no dangling listener survives a
      completed call), the concrete regression the leak comment in
      `client.ts:183-192` names
- [x] Migrate `packages/channels` first, in isolation, since its retry
      shape (3 classes, listener-based signal) is the more general of the
      two — run its full existing test suite (`client.test.ts`,
      `client-send-chunking.test.ts`) with **zero assertion edits** and
      confirm green before touching `packages/llm`
- [x] Migrate `packages/llm` the same way: `openai-compatible.test.ts`,
      `openai-compatible-abort.test.ts`, `openai-compatible-budget.test.ts`,
      `openai-compatible-telemetry.test.ts`, `openai-compatible-usage.test.ts`
      all green with zero assertion edits — pay particular attention to
      `openai-compatible-abort.test.ts`, since that's where the
      `AbortSignal.any` → listener-pattern implementation change is most
      likely to surface a behavioral difference if one exists
- [x] Write new tests in `packages/core` directly exercising the helper's
      own contract (named-class retry-count enforcement including a
      3-class case, `retryAfterMs` precedence over computed backoff, signal
      composition and listener cleanup, retry count exhaustion per class)
      independent of either caller, so the mechanism has coverage that
      isn't borrowed from `llm`'s/`channels`' fakes
- [x] Confirm neither `llm` nor `channels` needed a new dependency — both
      already had `@hermes/core` as a dependency prior to this phase
      (verify at execution time)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/core/src/__tests__/http-retry.test.ts` | a 2-class and a 3-class named-retry-class configuration each enforce their own per-class bound; a caller-supplied `retryAfterMs` (simulating both a header and `llm`'s body-fallback shape) beats computed backoff; the external shutdown signal aborts an in-flight retry loop and its listener is removed afterward (no leak); `redact` is applied before any thrown content is constructed |
| modify | `packages/channels/src/telegram/__tests__/client.test.ts`, `client-send-chunking.test.ts` | full existing suites pass with **zero assertion changes** — regression only |
| modify | `packages/llm/src/adapter/__tests__/openai-compatible.test.ts`, `openai-compatible-abort.test.ts`, `openai-compatible-budget.test.ts`, `openai-compatible-telemetry.test.ts`, `openai-compatible-usage.test.ts` | full existing suites pass with **zero assertion changes** — regression only; `openai-compatible-abort.test.ts` specifically re-proves shutdown-signal and timeout abort behavior under the new listener-based composition |

**Verification:**

- [x] `pnpm --filter @hermes/core test` green (new helper tests)
- [x] `pnpm --filter @hermes/channels test` green with **no assertion diff** to
      `client.test.ts`/`client-send-chunking.test.ts`
- [x] `pnpm --filter @hermes/llm test` green with **no assertion diff** to
      the five adapter test files named above
- [x] `pnpm -r typecheck` green
- [x] `pnpm -r test` green
- [x] `pnpm lint` green
- [x] Manual: run the bot briefly, send one message that exercises the LLM
      call path and confirm a normal reply still arrives (smoke test that
      the swap didn't silently break the hot path)
- [x] Manual: let the bot idle-poll for a few minutes (exercises
      `getUpdates`' long-poll repeatedly) and confirm no elevated memory
      growth versus baseline — the specific regression the leak comment
      exists to prevent, now shared infrastructure both callers depend on

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [~] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn — n/a: superseded by /execute-prd dispatching the code-reviewer subagent directly
- [~] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session — n/a: superseded by /execute-prd dispatching the code-reviewer subagent directly
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `refactor: extract shared HTTP retry/backoff/timeout helper into core`
- [x] Phase marked complete

---

### Phase 2: Scope upgrade — `/connect google sheets`, fail-closed enforcement

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** `/connect google` behaves exactly as it did in
`04-google-auth` (identity only). `/connect google sheets` requests identity
+ spreadsheets and, on partial grant (identity only), tells the user plainly
that Sheets wasn't granted and how to retry, while still connecting the
account. `/status` reflects the Sheets capability once granted (no code
change needed — it already prints the stored `scopes` array). `whoami`
behaves identically to `04-google-auth`, now via the `withRequiredScopes`
decorator instead of its own inline check — this is the pattern the
Sheets tools (Phase 4/5) will lean on, proven here first against a tool that
already works.
**Commit message:** `feat: scope upgrade for /connect google sheets, withRequiredScopes decorator`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/google-auth/src/scopes.ts` | add `SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]`; export a small helper resolving a `/connect` argument (`""` \| `"sheets"`) to a requested-scope list (`IDENTITY_SCOPES`, or `IDENTITY_SCOPES` ∪ `SHEETS_SCOPES`) |
| modify | `packages/google-auth/src/oauth-client.ts` | `buildAuthUrl` adds `include_granted_scopes: "true"` to the authorize URL (settled decision 8) |
| modify | `packages/google-auth/src/connect-flow.ts` | `completeConnect` validates the token response's `grantedScopes` against the **pending connection's own requested scopes**, not a hardcoded `IDENTITY_SCOPES` constant; identity scopes remain non-negotiable (missing ⇒ `missing_scopes`, no row written); a requested-but-ungranted Sheets scope persists the account with whatever was granted and returns a new result variant the caller can render as a partial-grant message (settled decision 9) |
| modify | `packages/google-auth/src/index.ts` | export `SHEETS_SCOPES`, the argument-resolution helper, the new `completeConnect` result shape |
| modify | `packages/google-auth/README.md` | document the requested-vs-granted validation change and the partial-grant result shape |
| modify | `apps/hermes/src/handlers/connect.ts` | parse `args` for `"sheets"` (case-insensitive, trims whitespace) in addition to the existing bare `"google"` case; pass the resolved scope list into `startConnect`; render the partial-grant branch's message distinctly from full success |
| modify | `apps/hermes/src/handlers/__tests__/connect.test.ts` | new cases: `/connect google sheets` requests both scope sets; `/connect google` unchanged; a malformed argument (`/connect google nonsense`) falls back to the existing usage-help branch |
| modify | `apps/hermes/src/google/build-oauth-callback-route.ts` | **added during execution** — the original table omitted this file, but it's the only caller of `completeConnect` that renders the user-facing Telegram message, and the phase's success criteria requires the partial-grant shortfall be told to the user; `handleBoundRequest` now renders a distinct message when `completeConnect`'s result carries `missingScopes` ("Connected as `<email>`. Sheets access wasn't granted — run /connect google sheets again and approve the Sheets permission to enable it."), full-success message unchanged |
| modify | `apps/hermes/src/google/__tests__/build-oauth-callback-route.test.ts` | **added during execution**, alongside the file above — new case: a partial-grant `completeConnect` result still serves the close-tab page (200) and notifies with the distinct message naming the shortfall and the retry command; existing full-grant case's unchanged message is the regression guard |
| create | `apps/hermes/src/agent/with-required-scopes.ts` | `withRequiredScopes(toolName: string, deps: { googleAccountRepo, requiredScopes }) => (spec: ToolSpec) => ToolSpec` — wraps `spec.handler`: looks up the account via `ctx.channel`/`ctx.channelUserId`, returns `{ ok: false, reason: "not_connected" }` if none, `{ ok: false, reason: "missing_scope", scope, fix: "run /connect google sheets" }` if `hasRequiredScopes` fails, otherwise calls the wrapped handler unchanged — no token fetched, no API call, on either failure branch |
| create | `apps/hermes/src/agent/__tests__/with-required-scopes.test.ts` | connected + scoped ⇒ wrapped handler runs and its result passes through unchanged; not connected ⇒ structured `not_connected`, wrapped handler never invoked; connected but missing scope ⇒ structured `missing_scope` with `fix` text, wrapped handler never invoked |
| modify | `apps/hermes/src/agent/tools/whoami.ts` | delete the inline `hasRequiredScopes`/not-connected check; `whoamiTool` is now `withRequiredScopes("whoami", { googleAccountRepo, requiredScopes: IDENTITY_SCOPES })(baseWhoamiTool)` where `baseWhoamiTool`'s handler assumes an already-verified, already-connected account and just projects the email |
| modify | `apps/hermes/src/agent/tools/__tests__/whoami.test.ts` | existing cases still pass through the decorator; the "missing identity scope" case (previously unreachable, per `04-google-auth`'s own note) is now exercised via the decorator's shared test rather than duplicated here |
| modify | `apps/hermes/src/agent/build-agent.ts` | construct `whoamiTool` via the decorator; array order unchanged (`[getCurrentTimeTool, echoTool, whoamiTool]`) — this phase adds no new tool to the array |
| modify | `apps/hermes/README.md` | document `/connect google sheets`, the partial-grant message, and the `withRequiredScopes` pattern new tools must use |
| modify | `packages/agent/README.md` | **added during execution** — the Documentation section (row ~1133) called for it ("the `ctx` contract it relies on") but the original File-changes table omitted it; documents that `ToolSpec`'s own `ctx` is unchanged by `withRequiredScopes` and that the `ScopedToolContext`/`ScopedToolSpec` extension lives entirely in `apps/hermes`, never in this package |

**Steps:**

- [x] Confirm `/connect google` (bare) is byte-for-byte behaviorally
      unchanged — same scopes requested, same success message shape — before
      writing the `"sheets"` branch; a regression here breaks
      `04-google-auth`'s exit criterion silently
- [x] `include_granted_scopes` correctness: write a test asserting the
      built authorize URL contains the literal query param, and that its
      presence doesn't change any other existing URL-building assertion
- [x] The partial-grant branch: write a test where `exchangeCode` returns
      `grantedScopes` = identity only despite Sheets being requested, and
      assert `completeConnect` still persists the account (no `ok: false`)
      but the result flags the shortfall — the handler-side message is the
      caller's job, `completeConnect`'s job is only reporting what happened
- [x] `withRequiredScopes` must genuinely gate before any handler work runs
      — write the test as "wrapped handler is a spy that must be called
      exactly zero times" for both failure branches, not just "the wrapped
      handler's result never surfaces"
- [x] Confirm `whoami`'s refactor changes no observable behavior: re-run
      `04-google-auth`'s existing manual exit-criterion check (`/connect
      google` → `whoami` → real email) against the refactored tool
- [x] Grep `apps/hermes/src/agent/tools/whoami.ts` after the refactor to
      confirm the inline `hasRequiredScopes` import and check are actually
      gone, not left dead alongside the new decorator

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-auth/src/__tests__/scopes.test.ts` (extend if a file already covers `scopes.ts`) | argument-resolution helper maps `""`/`"sheets"` to the right scope lists; `SHEETS_SCOPES` constant is the exact single scope string |
| modify | `packages/google-auth/src/__tests__/connect-flow.test.ts` | `completeConnect` validates against the pending connection's requested scopes, not a hardcoded constant; identity-missing still rejects with no row written; Sheets-requested-but-ungranted persists with a partial-grant result; `include_granted_scopes` present on the built URL |
| modify | `apps/hermes/src/handlers/__tests__/connect.test.ts` | `/connect google sheets` parsing and scope resolution; `/connect google` unchanged; malformed argument falls back to usage help |
| create | `apps/hermes/src/agent/__tests__/with-required-scopes.test.ts` | see Steps above |
| modify | `apps/hermes/src/agent/tools/__tests__/whoami.test.ts` | behavior preserved through the decorator refactor |

**Verification:**

- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm test:db` green
- [x] `pnpm lint` green
- [x] Manual: `/connect google` still connects identity-only exactly as
      before (regression check against `04-google-auth`'s exit criterion)
- [x] Manual: `/connect google sheets` → complete consent granting both
      scopes → Telegram confirms connection; `/status` afterward lists the
      spreadsheets scope in its scopes output
- [x] Manual: `/connect google sheets` → on Google's consent screen,
      untick the Sheets permission if the UI allows it (or simulate via a
      test double if it doesn't) → Hermes still connects (identity present)
      and tells the user Sheets wasn't granted
      — **satisfied via the test-double branch, not the UI**: Google renders
      no per-scope checkbox when a single sensitive scope is requested, so
      the consent screen offered nothing to untick. Covered by the
      `grantedScopes`-identity-only case in `connect-flow.test.ts` and the
      partial-grant case in `build-oauth-callback-route.test.ts`.

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [~] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn — n/a: superseded by /execute-prd dispatching the code-reviewer subagent directly
- [~] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session — n/a: superseded by /execute-prd dispatching the code-reviewer subagent directly
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: scope upgrade for /connect google sheets, withRequiredScopes decorator`
- [x] Phase marked complete

---

### Phase 3: Sheet registry — migration, repo, `hermes-sheets` CLI

**Risk:** low
**Mode:** afk
**Type:** backend
**Success criteria:** The operator runs `hermes-sheets add clients
<spreadsheetId> --desc "..." --access readwrite`, then `hermes-sheets list`
shows the row, including its `access` and `value_input_option` defaults.
`hermes-sheets remove clients` removes it. No agent-facing behavior changes
this phase — the registry exists and is operable, nothing reads it yet.
**Commit message:** `feat: sheet_registry table, repo, hermes-sheets CLI`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/core/src/google-types.ts` (extend existing file) | `sheetRegistryEntrySchema` (`slug: z.string().min(1)`, `spreadsheetId: z.string().min(1)`, `description: z.string()`, `access: z.enum(["read", "readwrite"])`, `valueInputOption: z.enum(["RAW", "USER_ENTERED"])`, `createdAt: z.date()`, `updatedAt: z.date()`) with `type SheetRegistryEntry = z.infer<typeof sheetRegistryEntrySchema>` — declared here, not in `store` or a not-yet-existing `google-sheets`, per the Dependencies & Risks note about avoiding the sibling edge `04-google-auth` had to fix after the fact |
| create | `packages/store/src/migrations/008_sheet_registry.sql` | **re-verify `007` is still highest before creating this** — `CREATE TABLE sheet_registry (slug text PRIMARY KEY, spreadsheet_id text NOT NULL, description text NOT NULL DEFAULT '', access text NOT NULL DEFAULT 'read' CHECK (access IN ('read','readwrite')), value_input_option text NOT NULL DEFAULT 'USER_ENTERED' CHECK (value_input_option IN ('RAW','USER_ENTERED')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())` |
| create | `packages/store/src/sheet-registry-repo.ts` | free functions taking `pool` first, matching `thread-repo.ts`/`google-account-repo.ts`'s shape: `getBySlug(pool, slug)`, `listAll(pool)`, `upsert(pool, entry)` (`INSERT ... ON CONFLICT (slug) DO UPDATE` — the second deliberate `DO UPDATE` exception in this codebase, justified the same way `google_accounts`' was: re-registering a slug must overwrite, not silently keep stale config), `remove(pool, slug)`; reads validated via `parseValidatedJson`-equivalent row parsing against `@hermes/core`'s `sheetRegistryEntrySchema` |
| modify | `packages/store/src/index.ts` | export the four new functions and `SheetRegistryEntry`-adjacent types |
| create | `packages/store/bin/sheets.ts` | CLI mirroring `packages/store/bin/migrate.ts`'s **exact** shape and location (`bin/`, not `src/bin/`): reads `DATABASE_URL` directly from `process.env` (no `@hermes/config` dependency, matching the existing migrate bin's self-contained posture), subcommands `add <slug> <spreadsheetId> [--desc <text>] [--access read\|readwrite] [--value-input-option RAW\|USER_ENTERED]`, `list`, `remove <slug>` — each a thin call into `sheet-registry-repo.ts`'s functions against a short-lived `Pool`, closed on exit |
| create | `packages/store/src/sheets-cli.ts` | **added during execution** — the original table named the testable-argument-parsing requirement (see Steps below) but did not name where the extracted function lives; `parseArgs`/`CliUsageError`/`USAGE` live here so `bin/sheets.ts` stays a thin wrapper (mirroring `bin/migrate.ts`) and `src/__tests__/sheets-cli.test.ts` can import the parser directly, with no database or subprocess |
| modify | `packages/store/package.json` | `build` script gains a second tsup entry, `--entry.sheets-cli=bin/sheets.ts`, alongside the existing `--entry.migrate-cli=bin/migrate.ts` (builds to `dist/sheets-cli.js`, the same flat-file convention `hermes-migrate` already uses — not a nested `dist/bin/` path); `bin` field gains `"hermes-sheets": "./dist/sheets-cli.js"` alongside the existing `"hermes-migrate": "./dist/migrate-cli.js"` entry |
| modify | `packages/store/README.md` | document `sheet_registry`: keyed by `slug`, the `DO UPDATE` exception, `hermes-sheets` usage (including the container-exec invocation below), and that reads validate against `@hermes/core`'s schema |
| create | `.ai/patterns/db-backed-tool-config.md` | the four rules (settled decision 7): a port is declared in the *consumer*, not the repo package; a typed table with real columns and a zod row parse, never a JSON blob; the config is read at tool-call time, never frozen at boot; a CLI bin writes through the exact same repo functions a future dashboard will call. States explicitly: this pattern has one instance (sheets) — do not extract a generic `ConfigRegistry<T>` until a second real case exists |

**Steps:**

- [x] **Re-list `packages/store/src/migrations/` first** and confirm `007`
      is still the highest-numbered file before creating `008` — do not
      trust this plan's assumed number
- [x] `sheetRegistryEntrySchema` lands in `core/src/google-types.ts` before
      any store or CLI code references it — confirm `pnpm --filter
      @hermes/core build` still succeeds with the addition
- [x] `upsert`'s `DO UPDATE` write a test proving re-registering an existing
      slug overwrites every field (`spreadsheet_id`, `access`,
      `value_input_option`, `description`), not just `updated_at`
- [x] Write an explicit test that `upsert` called with **no** `access`/
      `value_input_option` supplied by the caller persists and round-trips
      the migration's own defaults (`'read'`/`'USER_ENTERED'`) — the CHECK
      constraint's default is currently only asserted indirectly via the
      CLI's own default-flag behavior; this proves the DB default itself,
      independent of the CLI
- [x] `hermes-sheets`'s argument parsing: write at least one test (or a
      thin parsing function extracted and unit-tested, per the plan-format
      rule against manual-only verification of testable logic) covering
      `add` with and without optional flags — the without-flags case must
      assert the resulting row's `access`/`value_input_option` equal the
      migration's defaults, not just "the command didn't error" — `list`
      with zero and multiple rows, `remove` of a non-existent slug (should
      not throw — same idempotent-removal posture as `/disconnect`)
- [x] Confirm `hermes-sheets`'s `access`/`value_input_option` flags reject
      an invalid value with a clear CLI error rather than silently passing
      it through to a DB constraint violation
- [x] **Deliverability, resolved not assumed:** `apps/hermes/package.json`
      depends on `@hermes/store` (`workspace:*`), so `pnpm deploy --filter
      ./apps/hermes --prod --legacy /out` (the `Dockerfile`'s `deploy`
      stage) copies `@hermes/store`'s production files — `dist`,
      `src/migrations`, `src/__tests__` per its `files` field — into
      `/out/node_modules/@hermes/store`, and pnpm's deploy resolves that
      package's own `bin` field the same way it already does for
      `hermes-migrate` (confirmed present and working today, even though
      nothing in `boot.ts`/`docker-compose.yml` invokes it — `boot.ts:367`
      calls `runMigrations` directly, so `hermes-migrate` is itself an
      unexercised-in-production convenience bin, the same category
      `hermes-sheets` joins). Confirm by building the image and checking
      `docker compose run --rm hermes ls node_modules/.bin` lists both
      `hermes-migrate` and `hermes-sheets`. **Operator invocation, stated
      concretely:** `docker compose exec hermes
      node_modules/.bin/hermes-sheets add clients <spreadsheetId> --desc
      "Client roster" --access readwrite` — runs inside the running
      container, reusing its already-set `DATABASE_URL`. (A second, equally
      valid path exists for local dev: `docker-compose.yml` also publishes
      Postgres on `5432:5432`, so `DATABASE_URL=postgres://hermes:hermes@localhost:5432/hermes
      pnpm --filter @hermes/store exec hermes-sheets add ...` works from a
      host checkout without `docker compose exec` — Manual verification
      below exercises the container path specifically, since that's the one
      production actually depends on.) **Corrected during execution:** the
      invocation originally read `docker compose exec hermes node
      node_modules/.bin/hermes-sheets ...`, prefixing the bin with `node` —
      on Linux that bin is a shell wrapper script, not JavaScript, and
      running `node` against it fails with `SyntaxError: missing ) after
      argument list`, reproduced live in the built production image. The bin
      is invoked directly here instead; its own shebang handles execution.

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/core/src/__tests__/google-types.test.ts` (extend if it already exists) | `sheetRegistryEntrySchema` accepts valid entries, rejects an invalid `access`/`value_input_option` value |
| create | `packages/store/src/__tests__/sheet-registry-repo.test.ts` (test:db) | `upsert` twice for the same slug overwrites every field; a minimal `upsert` (no `access`/`value_input_option` supplied) round-trips the DB defaults; `getBySlug` round-trips; `listAll` returns all rows, and returns `[]` on an empty table (exercised again from the consuming side in Phase 4's `resolve-sheet.test.ts`); `remove` deletes and is idempotent on a missing slug |
| create | `packages/store/src/__tests__/sheets-cli.test.ts` | argument-parsing logic (extracted into a testable function, not exercised only via the CLI entry point) for `add`/`list`/`remove`, including invalid `access`/`value_input_option` rejection and the no-flags-supplied default case |

**Verification:**

- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm test:db` green — migration `008` applies cleanly
- [x] `pnpm lint` green
- [x] `pnpm --filter @hermes/store build` succeeds and produces a working
      `dist/sheets-cli.js`
- [x] `docker compose build` succeeds; `docker compose run --rm hermes ls
      node_modules/.bin` lists `hermes-sheets` alongside `hermes-migrate` —
      proves the CLI is actually present in the production image, not just
      buildable locally
- [x] Manual: against a local dev database, `hermes-sheets add clients
      <test-spreadsheet-id> --desc "Client roster" --access readwrite` then
      `hermes-sheets list` shows the row with the right defaults;
      `hermes-sheets remove clients` then `hermes-sheets list` shows it gone
- [x] Manual: with the compose stack up, `docker compose exec hermes
      node_modules/.bin/hermes-sheets add appointments <test-spreadsheet-id>
      --desc "Appointments" --access read` then `docker compose exec hermes
      node_modules/.bin/hermes-sheets list` shows the row — proves the
      concrete production invocation path, not just the dev-mode one above
      (**corrected during execution** — see the parenthetical in the
      deliverability Step above: the `node <wrapper>` form was found to fail
      in the built image, so both commands here invoke the bin directly)

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [~] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn — n/a: superseded by /execute-prd dispatching the code-reviewer subagent directly
- [~] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session — n/a: superseded by /execute-prd dispatching the code-reviewer subagent directly
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: sheet_registry table, repo, hermes-sheets CLI`
- [x] Phase marked complete

---

### Phase 4: `@hermes/google-sheets` package — `sheets_inspect`, `sheets_read`

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** In Telegram, after `/connect google sheets` and an
operator-registered `appointments` sheet, ask "what appointments do I have
this week?" — the model calls `sheets_inspect` (or goes straight to
`sheets_read` if it already knows the range) and `sheets_read`, and answers
with real rows from the actual spreadsheet. An identity-only account (no
Sheets scope) asking the same question is refused with "run /connect google
sheets" and **no Google API call is made** — verified by asserting the
fake Sheets HTTP client is never invoked. An unknown slug is refused and the
valid registered slugs are listed in the result.
**Commit message:** `feat: google-sheets package, sheets_inspect and sheets_read tools`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/agent/src/types.ts` | `ToolSpec` gains `timeoutMs?: number` (settled decision 14); `ToolSpec.handler`'s `ctx` widens from `{ signal, channel, channelUserId }` to `{ signal, channel, channelUserId, turnId }` (see Dependencies & Risks — bundled here since `ToolSpec`/`loop.ts` are already being touched for `timeoutMs`) |
| modify | `packages/agent/src/loop.ts` | the handler-execution race uses `spec.timeoutMs ?? 10_000` instead of a hardcoded `10_000` — default unchanged for every existing tool; `invokeTool` (`loop.ts:143-171`) gains a `turnId` parameter and passes it into the `ctx` object it builds at `loop.ts:154`; `resolveToolCall` (which already receives `turnId`) passes it through to `invokeTool` |
| modify | `packages/agent/README.md` | document `timeoutMs`, its default, and the UX cost named in settled decision 14: a turn can stall up to the configured timeout with the user watching a silent chat, and ROADMAP invariant 9 ("every loop bounded") still holds because the bound is explicit and finite, just larger than the default; document the `ctx.turnId` addition and that `withRequiredScopes`/`ApprovalGate` need no change to keep working (see Dependencies & Risks) |
| modify | `packages/agent/src/__tests__/loop.test.ts` | a tool with `timeoutMs: 30_000` is not killed at 10s; a tool with no `timeoutMs` still is, at the existing default — regression guard; a tool handler asserts `ctx.turnId` matches the turn's actual generated id |
| modify | `apps/hermes/src/agent/tools/__tests__/get-current-time.test.ts`, `echo.test.ts` | their hand-built `ctx` object literals (bypassing `loop.ts`, per `04-google-auth`'s own note about these two files) gain `turnId` to keep typechecking against the widened `ToolSpec.handler` signature — no behavior change, mechanical fix |
| create | `packages/google-sheets/package.json`, `tsconfig.json` | new workspace package templated on `packages/google-auth`'s shape: `type: module`, `dist` main/types, `typecheck`/`build`/`test` scripts; dependencies `@hermes/core`, `zod` — no `googleapis`, no new third-party HTTP client (settled decision 20) |
| create | `packages/google-sheets/src/sheet-registry-port.ts` | `SheetRegistryPort { getBySlug(slug): Promise<SheetRegistryEntry \| undefined>; listAll(): Promise<SheetRegistryEntry[]> }` — the consumer-declared port (settled decision 4), `SheetRegistryEntry` imported from `@hermes/core` |
| create | `packages/google-sheets/src/access-token-port.ts` | `AccessTokenPort { getAccessToken(channel: string, channelUserId: string): Promise<string> }` — the consumer-declared port (settled decision 18) |
| create | `packages/google-sheets/src/sheets-client.ts` | thin `fetch`-based client over the Sheets v4 REST API, built on `@hermes/core`'s `http-retry` helper from Phase 1 (own `classify` for Sheets' 429/5xx shapes, own `redact` for the Bearer token, own typed error classes e.g. `SheetsRateLimitedError`/`SheetsAmbiguousWriteError`/`SheetsApiError`): `getSpreadsheetMeta(accessToken, spreadsheetId)` — **two** requests, not the single `fields`-mask-only call originally planned (code review, Phase 4): `GET .../spreadsheets/{spreadsheetId}?fields=sheets.properties` first to learn each tab's title with zero cell data, then `GET .../spreadsheets/{spreadsheetId}?fields=sheets.properties,sheets.data.rowData.values.formattedValue&ranges=<title>!1:1` (one `ranges` entry per tab, A1-quoted) to bound the returned cell data to just each tab's header row — a `fields` mask alone still returns *every* row of *every* tab once any `sheets.data...` path is in the mask, and Google's `ranges` param only bounds the spreadsheet's first sheet when left unqualified, so bounding every tab requires knowing its title first; backs `sheets_inspect`, which only needs tab names, dimensions, and header rows. `getValues(accessToken, spreadsheetId, range, valueRenderOption)` — `GET .../v4/spreadsheets/{spreadsheetId}/values/{range}?valueRenderOption=...` (backs `sheets_read`) |
| create | `packages/google-sheets/src/resolve-sheet.ts` | shared handler-side helper: given a `sheet` arg string and `SheetRegistryPort`, look up the live entry; unknown slug (including the case where the registry is entirely empty — `listAll()` returns `[]`) returns a structured `{ ok: false, reason: "unknown_sheet", available: string[] }` the caller returns directly, with `available: []` rendered by the caller as "no sheets are registered yet — ask the operator to register one," not a bare empty list — used by every Sheets tool so the unknown-slug (and empty-registry) shape is defined once, not per tool |
| create | `packages/google-sheets/src/tools/sheets-inspect.ts` | `ToolSpec`: `name: "sheets_inspect"`, args `{ sheet: z.string() }`, `timeoutMs: 30_000`; resolves the slug, fetches spreadsheet metadata, returns tab names/dimensions/header rows so the model can orient before reading or writing |
| create | `packages/google-sheets/src/tools/sheets-read.ts` | `ToolSpec`: `name: "sheets_read"`, args `{ sheet: z.string(), range: z.string(), valueRenderOption: z.enum(["FORMATTED_VALUE","UNFORMATTED_VALUE","FORMULA"]).default("FORMATTED_VALUE") }` (default matches settled decision 16 — the agent relays results to a human), `timeoutMs: 30_000`; resolves the slug (any `access` value permits read), fetches values, returns them |
| create | `packages/google-sheets/src/index.ts` | explicit named exports: `SheetRegistryPort`, `AccessTokenPort`, `createSheetsInspectTool`, `createSheetsReadTool`, error classes |
| create | `packages/google-sheets/README.md` | package shape: ports, the live-registry-read contract (never frozen at boot), timeout rationale, what Phase 5 will add |
| modify | `tsconfig.base.json` | add `@hermes/google-sheets` to `paths` |
| modify | `Dockerfile` | add the `COPY packages/google-sheets/package.json ...` manifest line |
| modify | `apps/hermes/package.json` | add `"@hermes/google-sheets": "workspace:*"` |
| modify | `packages/google-auth/src/scopes.ts` | `TOOL_REQUIRED_SCOPES` gains `["sheets_inspect", SHEETS_SCOPES]`, `["sheets_read", SHEETS_SCOPES]` |
| create | `apps/hermes/src/store/build-sheet-registry-repo.ts` | binds `packages/store`'s free functions to `SheetRegistryPort`, matching `build-thread-repo.ts`'s shape — **no caching, calls straight through to `pool` on every invocation**, per settled decision 5 |
| create | `apps/hermes/src/google/build-access-token-port.ts` | binds `AccessTokenPort` over the existing `RefreshCoordinator.getValidAccessToken`: fetches the account via `googleAccountRepo.getAccount`, calls the coordinator, persists a changed account via the existing **UPDATE-only** `updateRefreshedTokens` (reusing `04-google-auth`'s refresh-sweep persist path, not a new one), returns the access token |
| modify | `apps/hermes/src/agent/build-agent.ts` | construct `sheetsInspectTool`/`sheetsReadTool` (each wrapped in `withRequiredScopes(name, { googleAccountRepo, requiredScopes: SHEETS_SCOPES })`), append both to the **end** of the tools array: `[getCurrentTimeTool, echoTool, whoamiTool, sheetsInspectTool, sheetsReadTool]` (settled decision 16 — existing prefix bytes untouched) |
| modify | `apps/hermes/src/boot.ts` | construct `sheetRegistryRepo`/`accessTokenPort`/the Sheets client and pass them into `build-agent.ts`'s construction site |
| modify | `apps/hermes/README.md` | document the two new tools, the registry-driven `sheet` argument, and the fail-closed behavior for an unconnected/under-scoped account |

**Steps:**

- [x] `ToolSpec.timeoutMs` change first, in isolation, with its own
      regression test (existing tools keep the 10s default) — before any
      Sheets tool exists to consume it
- [x] `ctx.turnId` widening, bundled into the same commit as `timeoutMs`
      (see Dependencies & Risks): update `invokeTool`/`resolveToolCall` in
      `loop.ts`, then fix the two pre-existing hand-built `ctx` literals
      (`get-current-time.test.ts`, `echo.test.ts`) and this plan's own
      Phase 2 literals (`with-required-scopes.test.ts`, `whoami.test.ts`) —
      run `pnpm -r typecheck` and confirm all four are the only call sites
      needing a fix, not a surprise fifth
- [x] `resolve-sheet.ts`'s unknown-slug shape is written and tested once,
      including the **empty-registry** case (`listAll()` returns `[]`, not
      an error) as its own explicit assertion, not merely implied by the
      unknown-slug case — then both `sheets_inspect` and `sheets_read`
      import it — do not duplicate the lookup-and-branch logic per tool file
- [x] **Fail-closed proof, not assumption**: write the test as "the fake
      Sheets HTTP client (or `AccessTokenPort`) is a spy that must be called
      exactly zero times" for an unconnected account and for a
      connected-but-under-scoped account, mirroring `with-required-scopes.test.ts`'s
      rigor from Phase 2
- [x] `sheets-client.ts`'s classification: write a test asserting a 429
      response is classified as rate-limited (retried per the core helper's
      contract) and a 5xx after a successfully-sent request is classified
      differently from a 429 — reads may retry either freely since `GET` is
      idempotent; this distinction matters starting Phase 5 for writes, but
      the classification itself is defined here where the client is built
- [x] Confirm `getBySlug`/`listAll` in `build-sheet-registry-repo.ts` hit
      the pool on every call — no in-memory cache, no boot-time snapshot;
      write a test proving two consecutive tool calls after a registry
      mutation between them see the mutation
- [x] `AccessTokenPort`'s persist step: confirm it calls
      `updateRefreshedTokens`, not `upsertAccount` — a test asserting a
      disconnected account (deleted mid-session) is **not** resurrected by
      a token-fetch attempting to persist a refresh, mirroring the exact
      bug `04-google-auth`'s Final Verification fixed in the sweep
- [x] Confirm `apps/hermes/package.json` and `pnpm-lock.yaml` pick up the
      new workspace package cleanly (`pnpm install` with no unexpected diff)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `packages/agent/src/__tests__/loop.test.ts` | see Steps above |
| modify | `apps/hermes/src/agent/tools/__tests__/get-current-time.test.ts`, `echo.test.ts` | ctx literal gains `turnId`, no assertion changes |
| create | `packages/google-sheets/src/__tests__/resolve-sheet.test.ts` | known slug resolves the live entry; unknown slug returns the structured `unknown_sheet` shape listing available slugs; an **empty** registry (`listAll()` → `[]`) returns the same shape with `available: []`, not an error |
| create | `packages/google-sheets/src/__tests__/sheets-client.test.ts` (`fetchImpl` faked) | `getSpreadsheetMeta`/`getValues` construct the right request; a 429 is classified and retried per the core helper; a post-send 5xx is classified distinctly; the access token never appears in a thrown error message |
| create | `packages/google-sheets/src/tools/__tests__/sheets-inspect.test.ts` | happy path returns tab/dimension info; unknown slug short-circuits before any client call |
| create | `packages/google-sheets/src/tools/__tests__/sheets-read.test.ts` | happy path returns values; `valueRenderOption` defaults to `FORMATTED_VALUE`; unknown slug short-circuits |
| create | `apps/hermes/src/google/__tests__/build-access-token-port.test.ts` | persists via `updateRefreshedTokens`, not `upsertAccount`; a deleted account is not resurrected |
| create | `apps/hermes/src/store/__tests__/build-sheet-registry-repo.test.ts` | no caching — a registry change between two calls is visible on the second call |
| modify | `apps/hermes/src/agent/__tests__/build-agent.test.ts` | tools array now ends with `sheetsInspectTool`, `sheetsReadTool`, in that order; existing prefix (`getCurrentTimeTool`, `echoTool`, `whoamiTool`) byte-stable per the existing determinism test |

**Verification:**

- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm test:db` green
- [x] `pnpm lint` green
- [ ] `docker compose build` succeeds (catches a missing `Dockerfile` COPY line) — deferred to Phase 7 Final Verification (no container builds run during afk execution)
- [ ] Manual: with an identity-only connected account, ask a Sheets-shaped
      question → model relays "run /connect google sheets," `psql` shows no
      new `tool.call` row hit the Sheets client (or a `tool.call` row exists
      showing the `missing_scope` result with no downstream API call)
- [ ] Manual: `/connect google sheets`, register a real test sheet via
      `hermes-sheets add`, ask "what's in the `<slug>` sheet?" → real rows
      returned
- [ ] Manual: ask about an unregistered slug → refusal listing the actual
      registered slugs

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [~] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn — n/a: superseded by /execute-prd dispatching the code-reviewer subagent directly
- [~] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session — n/a: superseded by /execute-prd dispatching the code-reviewer subagent directly
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: google-sheets package, sheets_inspect and sheets_read tools` (e54d1ee, fixes 33c1c61, 60c44da)
- [ ] Phase marked complete

---

### Phase 5: `sheets_write` — approval, access enforcement, idempotency/audit

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** "Add a client named X with phone Y" produces an
in-chat confirmation showing the exact row to be written; approving it makes
the row appear in the registered `clients` sheet; the same write repeated
within the same turn (e.g., a model retry) does not double-append; a write
targeting a `read`-access sheet is refused before any API call; the write's
canonical args and outcome are durably recorded, satisfying invariant 3 for
this mutation path.
**Commit message:** `feat: sheets_write tool with approval, access enforcement, write dedupe/audit`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/store/src/migrations/009_sheet_write_log.sql` | **re-verify `008` is still highest before creating this** — mirrors `llm_dedupe`'s claim/complete shape: `dedupe_key text PRIMARY KEY` (the hash described below), `channel text NOT NULL`, `channel_user_id text NOT NULL`, `turn_id text NOT NULL`, `tool text NOT NULL`, `canonical_args jsonb NOT NULL`, `status text NOT NULL CHECK (status IN ('pending','complete'))`, `outcome jsonb`, `created_at timestamptz NOT NULL DEFAULT now()`, `completed_at timestamptz` |
| create | `packages/store/src/sheet-write-log-repo.ts` | `claim(pool, key, { channel, channelUserId, turnId, tool, canonicalArgs }): Promise<"claimed" \| { alreadyComplete: true; outcome }>` (an `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING` matching `llm-dedupe-repo`'s idiom, then a read-back to distinguish "I claimed it" from "already complete"), `complete(pool, key, outcome): Promise<void>` |
| modify | `packages/store/src/index.ts` | export the two new functions |
| modify | `packages/store/README.md` | document `sheet_write_log`: the claim/complete idempotency shape, why `turnId` is part of the key (a retry guard, not a permanent block), and that this table is the durable write audit for invariant 3 |
| create | `packages/google-sheets/src/canonical-args.ts` | deterministic JSON canonicalization (sorted keys) of a write call's args, used both to build the dedupe key's hash input and to store `canonical_args` for audit |
| modify | `packages/google-sheets/src/sheets-client.ts` | add `appendValues(accessToken, spreadsheetId, range, values, valueInputOption, insertDataOption?)` — `POST .../v4/spreadsheets/{spreadsheetId}/values/{range}:append?valueInputOption=...&insertDataOption=INSERT_ROWS` (`insertDataOption` defaults to `INSERT_ROWS`, the shape that actually adds new rows rather than overwriting the next empty ones inside the given range) — and `updateValues(accessToken, spreadsheetId, range, values, valueInputOption)` — `PUT .../v4/spreadsheets/{spreadsheetId}/values/{range}?valueInputOption=...`; both classify a pre-send failure (429, connection refused before the request left) as retryable per the core helper's normal policy. Post-send ambiguity (timeout after send, 5xx after send) is handled **per mode, not uniformly** (settled decision 15's actual scope, corrected from an earlier draft that applied the same pessimism to both): `updateValues` is a `PUT` against a **fixed** range — resending the identical `values` twice converges to the same end state regardless of whether the first attempt landed, so a post-send ambiguous failure for `update` is retried **once**, inside this function, using the same `values`/`range` already sent (not a new call) and is invisible to the tool layer as an ambiguity at all; `appendValues` is not idempotent by nature — a resend of an already-applied append doubles the row — so its post-send ambiguous failure is classified as a distinct, **non-retried** outcome the caller (`sheets-write.ts`) must surface as "may or may not have landed, check the sheet." This client-level retry-for-`update` is a separate mechanism from the tool-level dedupe below: the dedupe key guards against the *model* calling the tool twice with identical args in one turn; this guards against the *network* leaving one HTTP attempt's outcome unknown |
| create | `packages/google-sheets/src/tools/sheets-write.ts` | `ToolSpec`: `name: "sheets_write"`, `requiresApproval: true`, `timeoutMs: 30_000`, args a `z.discriminatedUnion("mode", [...])` over `{ mode: "append", sheet, range, values }` / `{ mode: "update", sheet, range, values }`, plus optional `valueInputOption` override; handler: resolve the slug (unknown ⇒ structured refusal, same as read tools), refuse before any API call if `entry.access !== "readwrite"` (`{ ok: false, reason: "read_only_sheet" }`), compute the dedupe key from `(ctx.channel, ctx.channelUserId, ctx.turnId, "sheets_write", canonicalArgs)`, `claim` — an already-complete claim returns the stored outcome without calling the Sheets API again, resolve `valueInputOption` (arg override, else the registry row's default), call `appendValues`/`updateValues`; on success `complete` with the written result and return it; for `mode: "update"`, the client already resolved any post-send ambiguity internally (see above), so this layer only ever sees success or a genuine fatal error; for `mode: "append"`, on the ambiguous-outcome class `complete` with an explicit "may or may not have landed" outcome and return that to the model without retrying |
| modify | `packages/google-sheets/src/index.ts` | export `createSheetsWriteTool` |
| modify | `packages/google-sheets/README.md` | document the write path: approval gate, access enforcement ordering (before any API call), the dedupe/audit table, the **per-mode** retryable-vs-ambiguous distinction (`update`'s single safe internal retry vs. `append`'s never-retry-surface-instead posture), and the `value_input_option` stakes from settled decision 17 |
| modify | `packages/google-auth/src/scopes.ts` | `TOOL_REQUIRED_SCOPES` gains `["sheets_write", SHEETS_SCOPES]` |
| modify | `apps/hermes/src/agent/build-agent.ts` | construct `sheetsWriteTool` (wrapped in `withRequiredScopes`), append to the **end** of the array: `[..., sheetsInspectTool, sheetsReadTool, sheetsWriteTool]` |
| modify | `apps/hermes/src/boot.ts` | wire `sheetWriteLogRepo` into the write tool's construction |
| modify | `apps/hermes/README.md` | document `sheets_write`'s approval prompt shape and the access-enforcement/dedupe behavior |

**Steps:**

- [ ] Access enforcement happens **before** the dedupe claim and before any
      API call — write the test proving a `read`-access sheet refusal never
      inserts a `sheet_write_log` row and never calls the Sheets client
- [ ] Dedupe correctness, proven not assumed: two calls with identical
      `(channel, channelUserId, turnId, tool, canonicalArgs)` result in
      exactly one `appendValues`/`updateValues` call to the (faked) Sheets
      client — assert the spy's call count, not just "both calls returned
      the same thing"
- [ ] Dedupe is a retry guard, not a permanent block: the same logical write
      with a **different** `turnId` (a later, genuinely repeated user
      request) is allowed to proceed and calls the client again — write this
      as an explicit test so the `turnId` inclusion isn't silently reverted
      later under the mistaken belief it should dedupe forever
- [ ] Ambiguous-outcome handling is **per mode**, proven as two distinct
      tests, not one: (1) `mode: "append"` — simulate a post-send timeout
      from the fake client and assert `sheets_write` returns the explicit
      "may or may not have landed" result **without** a second call to the
      client — this is the one place in this plan where "retry" is
      deliberately the wrong behavior, name it as such in the test; (2)
      `mode: "update"` — simulate the same post-send timeout and assert
      `updateValues` itself retries **exactly once** with the identical
      `range`/`values` and, on that retry succeeding, `sheets_write` returns
      a normal success with no "may or may not have landed" hedge — the two
      tests must assert opposite outcomes for the same fault, proving the
      split isn't accidental
- [ ] `ctx.turnId` (widened in Phase 4) is read directly by the dedupe-key
      computation here — confirm no further `loop.ts` change is needed in
      this phase; a test asserting the dedupe key differs when only
      `ctx.turnId` differs (holding args/channel/channelUserId fixed) proves
      the field actually reaches the handler, not just that it typechecks
- [ ] `requiresApproval: true` — confirm the existing `ApprovalGate` prompt
      shows the resolved sheet, mode, and values clearly enough that a human
      can actually judge what they're approving, not just "confirm write?"
- [ ] `valueInputOption` resolution order: registry default unless the tool
      arg overrides it — write a test for both cases
- [ ] Confirm `canonical-args.ts`'s JSON canonicalization is genuinely
      deterministic (key order doesn't affect the hash) — the dedupe key's
      whole point breaks if two logically-identical calls hash differently
      due to object key ordering

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/store/src/__tests__/sheet-write-log-repo.test.ts` (test:db) | `claim` on a fresh key returns "claimed"; a repeat `claim` on the same key before `complete` and after both return the stored/pending state correctly; `complete` stores the outcome retrievable on a later duplicate claim |
| create | `packages/google-sheets/src/__tests__/canonical-args.test.ts` | key-order-independent canonicalization |
| modify | `packages/google-sheets/src/__tests__/sheets-client.test.ts` | `appendValues`/`updateValues` request construction (including `insertDataOption: INSERT_ROWS` on append); pre-send failure classified retryable for both; post-send ambiguous failure for `appendValues` classified distinctly and **not** retried by the client; post-send ambiguous failure for `updateValues` **is** retried once internally, with the identical range/values, and resolves to a normal success on the retry's success |
| create | `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts` | read-access sheet refused before any client call or dedupe claim; unknown slug refused; happy-path append/update calls the client once and returns success; a same-turn repeat calls the client exactly once (dedupe); a different-turn repeat (different `ctx.turnId`, same args) calls the client again; `mode: "append"`'s ambiguous post-send outcome returned without a retry; `mode: "update"`'s ambiguous post-send outcome resolves to success with no hedge (the client already retried); `valueInputOption` resolution order |
| modify | `apps/hermes/src/agent/__tests__/build-agent.test.ts` | tools array now ends with `sheetsWriteTool`; `requiresApproval: true` on it, `false` on the two read tools |

**Verification:**

- [ ] `pnpm -r test` green
- [ ] `pnpm -r typecheck` green
- [ ] `pnpm test:db` green — migration `009` applies cleanly
- [ ] `pnpm lint` green
- [ ] Manual: "add a client named X with phone Y" against the `clients`
      sheet (registered `readwrite`) → approval prompt shows the exact row →
      approve → row appears in the real spreadsheet
- [ ] Manual: ask the same addition again in the same conversational turn
      (e.g., re-approve or trigger a model retry) → the sheet does not gain
      a duplicate row; `psql` shows one `sheet_write_log` row for that key
- [ ] Manual: attempt a write against a sheet registered `read` → refused,
      `psql` shows no new `sheet_write_log` row for that attempt

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: sheets_write tool with approval, access enforcement, write dedupe/audit`
- [ ] Phase marked complete

---

### Phase 6: `/disconnect` revokes the Google grant

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** After `/disconnect`, the grant is gone from the user's
Google account permissions page (`myaccount.google.com/permissions`), not
just from the local `google_accounts` table.
**Commit message:** `feat: /disconnect revokes the OAuth grant at Google`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/google-auth/src/revoke.ts` | `revokeToken(refreshToken: string, opts): Promise<void>` — `POST https://oauth2.googleapis.com/revoke?token=<refreshToken>` via the shared core HTTP helper; treats any non-2xx as a logged failure, not a thrown error — the caller's contract is "attempt revoke, then delete locally regardless" |
| modify | `packages/google-auth/src/index.ts` | export `revokeToken` |
| modify | `packages/google-auth/README.md` | document the revoke-then-delete ordering and that a revoke failure never blocks the local disconnect |
| modify | `apps/hermes/src/handlers/disconnect.ts` | before `googleAccountRepo.deleteAccount`, decrypt the stored refresh token and call `revokeToken`; log (not throw) on failure; delete the local row unconditionally afterward — same reply shape as today either way, since the user-facing contract ("you're disconnected from Hermes") doesn't change on a revoke failure |
| modify | `apps/hermes/src/handlers/__tests__/disconnect.test.ts` | revoke is called with the decrypted refresh token before delete; a revoke failure (faked non-2xx) still results in the row being deleted and the same success reply |
| modify | `.ai/decisions/google-token-encryption.md` (from `04-google-auth`) | append a note: the AAD-binding deferral is re-confirmed now that the token's blast radius covers Sheets read/write, not just identity; reasoning unchanged |
| modify | `.ai/decisions/google-oauth-flow.md` (from `04-google-auth`) | close out the "does not revoke the grant at Google" deferred item this file recorded — link to this phase |
| modify | `apps/hermes/README.md` | document that `/disconnect` now revokes at Google |

**Steps:**

- [ ] Confirm `revokeToken` never throws on a non-2xx — the caller's
      always-delete-locally contract depends on this; write the test as
      "the handler still calls `deleteAccount` even when the fake revoke
      response is a 400"
- [ ] Confirm the refresh token is decrypted only in memory for the revoke
      call and never logged — grep the implementation for the plaintext
      token appearing in any `logger.*` call, same discipline
      `04-google-auth` Phase 2 applied to the authorization code
- [ ] Manual verification note: revoking via Google's real endpoint and then
      checking the permissions page is the only way to prove this
      end-to-end — state this explicitly in Verification

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-auth/src/__tests__/revoke.test.ts` | successful revoke calls the endpoint with the token as a query param; a non-2xx response resolves (does not throw); the token never appears in a thrown error or log call |
| modify | `apps/hermes/src/handlers/__tests__/disconnect.test.ts` | see Steps above |

**Verification:**

- [ ] `pnpm -r test` green
- [ ] `pnpm -r typecheck` green
- [ ] `pnpm lint` green
- [ ] Manual: `/connect google sheets` → `/disconnect` → check
      `myaccount.google.com/permissions` for the connected Google account →
      Hermes's grant is no longer listed

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: /disconnect revokes the OAuth grant at Google`
- [ ] Phase marked complete

---

### Phase 7: Final Verification

**Mode:** hil
**Type:** mixed

**Overall success criteria:**

- All eight exit-criterion behaviors hold end to end (see checkboxes below).
- `packages/llm` and `packages/channels` behave identically to before
  Phase 1 — retry counts **per their own class count** (2 for `llm`, 3 for
  `channels`, `channels`' 409-conflict class included), `Retry-After`
  precedence (including `llm`'s `RetryInfo`-body fallback), externally-observable
  signal-abort behavior (even though `llm`'s internal composition mechanism
  changed from `AbortSignal.any` to the shared listener-based approach —
  see Phase 1), thrown-error types, redaction — confirmed by their
  unmodified-assertion suites passing, not just by inspection.
- `packages/google-sheets` depends only on `@hermes/core` and `zod` — never
  `@hermes/store` or any `apps/hermes` feature module — confirmed by
  inspection.
- No sibling-package edge was introduced (`store` never imports
  `google-sheets`; `google-sheets` never imports `store`) — the lesson
  `04-google-auth`'s Final Verification learned the hard way, applied
  proactively this time via `SheetRegistryEntry` living in `core` from
  Phase 3 onward.
- The registry is never read into a boot-time cache anywhere in the final
  code — confirmed by inspection of `build-sheet-registry-repo.ts` and every
  call site.
- No credential — access token, refresh token — ever appears in a Telegram
  message, a log line, or a thrown error's message, across the Sheets client,
  the access-token port, and the revoke call.
- No CLAUDE.md invariant is violated: functions stay near the ~30-line
  guidance, no dead code, comments explain *why* not *what*.

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block, scoped to end-to-end review of Phases 1–6 together
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review reflected back into this plan file
- [ ] `pnpm lint` — zero errors
- [ ] `pnpm -r test` green
- [ ] `pnpm -r typecheck` green
- [ ] `pnpm test:db` green
- [ ] No CLAUDE.md invariants violated
- [ ] Manual, golden path: identity-only account refused a Sheets read, no
      API call made (exit criterion 1) → `/connect google sheets` → `/status`
      reflects Sheets capability (exit criterion 2) → natural-language read
      returns real rows (exit criterion 3) → natural-language write shows a
      confirmation and lands on approval (exit criterion 4) → the same write
      repeated in-turn does not double-append (exit criterion 5) → a write
      to a `read`-access sheet is refused pre-API-call (exit criterion 6) →
      an unknown slug is refused with valid slugs listed (exit criterion 7)
      → `/disconnect` removes the grant at Google, confirmed on the
      permissions page (exit criterion 8)
- [ ] Manual, edge cases: partial Sheets-grant messaging; rate-limit
      (429) retry behavior on a read (force via rapid repeated calls if
      practical, or a fake-client unit test cross-check if not); an ambiguous
      post-send write outcome is reported, not silently retried
- [ ] Overall success criteria met
- [ ] `sync-knowledge` run to close out `.ai/` per the Knowledge Base Impact
      table below, including the ROADMAP §non-goals "not a dashboard" line
- [ ] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| Shared HTTP retry/backoff/timeout helper | `packages/core/README.md` |
| `llm`/`channels` migrated onto the shared helper, no behavior change | `packages/llm/README.md`, `packages/channels/README.md` |
| `/connect google sheets`, requested-vs-granted scope validation, partial-grant messaging | `packages/google-auth/README.md`, `apps/hermes/README.md` |
| `withRequiredScopes` decorator pattern | `apps/hermes/README.md`, `packages/agent/README.md` (for the `ctx` contract it relies on) |
| `sheet_registry` table, `hermes-sheets` CLI | `packages/store/README.md` |
| DB-backed tool config pattern | `.ai/patterns/db-backed-tool-config.md` (new) |
| `@hermes/google-sheets` package shape, ports, live-registry-read contract | `packages/google-sheets/README.md` (new) |
| `ToolSpec.timeoutMs` | `packages/agent/README.md` |
| `sheets_inspect`, `sheets_read`, `sheets_write` tools | `apps/hermes/README.md`, `packages/google-sheets/README.md` |
| Write dedupe/audit table, retryable-vs-ambiguous write outcomes | `packages/store/README.md`, `packages/google-sheets/README.md` |
| `value_input_option` stakes | `packages/google-sheets/README.md` |
| `/disconnect` revocation | `packages/google-auth/README.md`, `apps/hermes/README.md` |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `index.md` | update | new `@hermes/google-sheets` row in the module table; Cross-cutting table gains a row for the DB-backed live-config pattern and the write-dedupe/audit table |
| `architecture.md` | update | `packages/google-sheets` added to the System shape ASCII list and Dependency direction diagram (depends only on `core`); Data flow gains the read and write tool-call paths through `SheetRegistryPort`/`AccessTokenPort`; note `@hermes/core` now carries a shared HTTP retry helper used by three packages, cross-referenced from the `llm`/`channels` dependency bullets |
| `decisions/google-sheets-scope-and-registry.md` | create | scope choice (`spreadsheets` only, no Drive), slug-based identity instead of raw IDs/URLs, registry-in-Postgres rationale and the explicit ROADMAP "not a dashboard" contradiction this creates |
| `decisions/http-retry-helper-extraction.md` | create | why the extraction happened now (a third caller needed it), the no-behavior-change verification approach, what stayed caller-owned (classification, error types, redaction) vs. what moved to `core` (timeout, backoff, signal composition, retry counts) |
| `decisions/per-tool-timeout.md` | create | why `ToolSpec.timeoutMs` exists, the UX cost (a turn can stall up to the configured bound), and that ROADMAP invariant 9 still holds because the bound stays explicit and finite |
| `decisions/sheets-write-dedupe-as-audit.md` | create | why `turnId` is in the dedupe key (retry guard, not permanent block), why this table — not `telemetry_events` — is the durable audit of record for invariant 3 on this write path |
| `decisions/read-tool-auditing-deferred.md` | create | records that invariant 3 (every tool call audited) remains partially open for read tools — `sheets_inspect`/`sheets_read` are covered by `tool.call` telemetry (buffered, at-most-once) but not by a synchronous durable audit the way writes now are; deferred, not silently dropped |
| `decisions/google-token-aad-binding-deferred.md` (or update `04-google-auth`'s `google-token-encryption.md`) | update | re-confirm the AAD deferral now that the token's blast radius covers Sheets read/write |
| `patterns/db-backed-tool-config.md` | create | the four-rule pattern (settled decision 7) — see File changes, Phase 3 |
| ROADMAP §non-goals | flag for update | "not a dashboard" line is now in tension with the registry's Postgres-backed, dashboard-editable design; this plan does not edit ROADMAP itself but names the line as needing a human decision |
| `decisions/d3-monorepo-package-per-concern.md` | update | cite `packages/google-sheets` as the next example of "created at its phase" |
| `decisions/approval-gate-design.md` | update | `sheets_write` as the second worked example of the mutation-gates/read-doesn't policy, after `whoami` |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | shared HTTP retry helper mechanics | `packages/core/src/__tests__/http-retry.test.ts` |
| Phase 1 | `llm`/`channels` regression (unmodified suites) | existing `packages/llm/src/__tests__/*`, `packages/channels/src/__tests__/*` |
| Phase 2 | scope argument resolution, `include_granted_scopes`, requested-vs-granted validation | `packages/google-auth/src/__tests__/scopes.test.ts`, `connect-flow.test.ts` |
| Phase 2 | `/connect google sheets` handler parsing | `apps/hermes/src/handlers/__tests__/connect.test.ts` |
| Phase 2 | `withRequiredScopes` decorator | `apps/hermes/src/agent/__tests__/with-required-scopes.test.ts` |
| Phase 2 | `whoami` refactor preserves behavior | `apps/hermes/src/agent/tools/__tests__/whoami.test.ts` |
| Phase 3 | `sheetRegistryEntrySchema` validation | `packages/core/src/__tests__/google-types.test.ts` |
| Phase 3 | registry repo CRUD, `DO UPDATE` overwrite | `packages/store/src/__tests__/sheet-registry-repo.test.ts` |
| Phase 3 | `hermes-sheets` argument parsing | `packages/store/src/__tests__/sheets-cli.test.ts` |
| Phase 4 | `ToolSpec.timeoutMs` honored in the handler race | `packages/agent/src/__tests__/loop.test.ts` |
| Phase 4 | unknown-slug resolution shape | `packages/google-sheets/src/__tests__/resolve-sheet.test.ts` |
| Phase 4 | Sheets client request construction, retry classification, redaction | `packages/google-sheets/src/__tests__/sheets-client.test.ts` |
| Phase 4 | `sheets_inspect`/`sheets_read` tools, fail-closed enforcement | `packages/google-sheets/src/tools/__tests__/sheets-inspect.test.ts`, `sheets-read.test.ts` |
| Phase 4 | access-token port persists via `updateRefreshedTokens`, no resurrection | `apps/hermes/src/google/__tests__/build-access-token-port.test.ts` |
| Phase 4 | registry repo binding has no cache | `apps/hermes/src/store/__tests__/build-sheet-registry-repo.test.ts` |
| Phase 5 | write dedupe/audit claim-complete shape | `packages/store/src/__tests__/sheet-write-log-repo.test.ts` |
| Phase 5 | canonical args determinism | `packages/google-sheets/src/__tests__/canonical-args.test.ts` |
| Phase 5 | `sheets_write`: access enforcement, dedupe, ambiguous-outcome handling | `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts` |
| Phase 6 | token revocation, delete-regardless-of-revoke-outcome | `packages/google-auth/src/__tests__/revoke.test.ts`, `apps/hermes/src/handlers/__tests__/disconnect.test.ts` |

## Human Summary

This plan turns Hermes's Google identity (`04-google-auth`) into an actual
capability: reading and writing spreadsheets, still with nothing
trading-specific baked in — that's deliberately a later, separate plan. It
starts with an unusual first move, extracting the retry/timeout logic that's
currently copy-pasted between the LLM client and the Telegram client into
one shared piece — not because Sheets strictly needs it yet, but because
adding a *third* hand-rolled copy for Sheets would be the wrong direction,
and the user chose to do that consolidation now rather than defer it. The
next piece upgrades the existing `/connect google` flow so a user can grant
Sheets access on top of their existing identity, and builds the one
mechanism ("do you have the scope you need?") every future Google tool will
reuse, proven first against the `whoami` tool that already works. Then comes
the registry: instead of the model ever seeing a raw spreadsheet ID, the
operator registers spreadsheets under short names like `clients` or
`appointments` — in a database table rather than a config file, specifically
so a future admin dashboard can edit it without redeploying, which is a
real tension with something Hermes's own roadmap currently says it won't
be, flagged here rather than quietly ignored. With the registry in place,
the actual reading and writing tools arrive: one that inspects a sheet's
shape, one that reads rows, and one that writes them — writes require an
explicit human approval in Telegram before anything happens, are refused
outright against a sheet the operator marked read-only, and use a
durable idempotency record so the same confirmed write can never
accidentally apply twice. The last piece closes a gap `04-google-auth`
knowingly left open: disconnecting in Telegram now actually revokes the
grant at Google, not just locally, which matters much more once that grant
can read and write real spreadsheets. What doesn't ship: any notion of what
a "trade" or a "client roster" *means* — that's a future package built on
top of this one's generic read/write primitives.
