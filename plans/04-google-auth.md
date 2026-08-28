# Plan: Google identity (Roadmap Phase 3)

**Created:** 2026-08-28
**Branch:** `feat/04-google-auth`
**Status:** not started

## Context

`03-agent-core` gave Hermes a bounded tool loop, an approval gate, and two
throwaway tools (`get_current_time`, `echo`) whose only job was to prove the
registry, the retry logic, and the Telegram button flow work. It shipped no
real capability. ROADMAP §5 Phase 3 is the foundation every future real tool
(Gmail, Calendar, Sheets) needs before any of them can exist: one OAuth2
identity per Telegram user, an encrypted token store that survives a
restart, a scope registry that supports incremental consent, and automatic
refresh that fails loudly instead of silently. The exit criterion is
narrow and deliberate — `/connect google`, then a `whoami` tool that returns
the connected Gmail address, and that connection survives a container
restart. Nothing beyond identity ships here.

Two pieces of technical debt `03-agent-core` recorded and deliberately did
not fix now become live hazards rather than latent ones: `runTurn` persists
only two hardcoded message literals per turn (`loop.ts:455-458`), which
means a tool call and its result are invisible to the next turn's history —
harmless while the only tools were throwaways, but the first real tool this
codebase ships (`whoami`) is exactly the case that exposes it. And
`thread-repo.ts` casts persisted jsonb to `Message[]` with zero runtime
validation — harmless while only user/assistant text was ever written,
false the moment tool-call messages start landing in that column. Both are
fixed in Phase 1, before any Google code, so the Google work builds on a
history layer that actually holds what it claims to.

**Explicitly out of scope, owned by later PRDs:**

- **Any real Google API tool.** No Gmail, Calendar, or Sheets wrapper ships
  here. `whoami` is the only Google-backed tool, and it never calls a scoped
  Google API — it projects the email captured at connect time. Building the
  `fetch`-based Gmail/Calendar/Sheets clients ROADMAP §6 names is Phase 4+.
- **Google API verification review.** This phase requests only
  `openid`/`userinfo.email` — non-sensitive scopes that need no Google
  review. The moment a later phase requests Gmail (a restricted scope), that
  phase must either submit for verification or drop the consent screen back
  to Testing and accept ~7-day refresh-token expiry (settled decision 15).
  That decision belongs to that phase; this plan only names the consequence
  so it isn't a surprise.
- **Automated key rotation.** `TOKEN_ENCRYPTION_KEY` rotation is documented
  (set new key → restart → decrypt failures surface as disconnected →
  operator re-runs `/connect google`), not automated. A rotation tool or
  dual-key decrypt window is a future card, not this one.
- **Persisted pending-connection state.** Like the approval gate's own
  in-memory pending map (`03-agent-core`, settled decision 6), a `/connect
  google` in flight when the process restarts is simply gone; the operator
  re-runs the command. No queue, no durability.
- **A second identity provider.** The scope registry and token-store shape
  are Google-specific by design this phase; a future Microsoft/Slack
  identity would need its own provider adapter, not a generalized abstraction
  built speculatively now.
- **Tokenizer-accurate context budgeting or summarization.** Phase 1 extends
  the existing chars/4 trim to be group- and tool-call-aware; it does not
  replace the crude estimate itself — that's still the `03-agent-core`-named
  Phase 8 non-goal.

**Packages created here**, per D3 ("create at its phase, never
merge-then-split"): `packages/google-auth` only.

**Packages modified here:** `packages/core` (`ToolCallEvent` gains
`approvalWaitMs`; `llm-types.ts` becomes schema-first — `Message` and its
four variants become zod schemas with the TS types derived via `z.infer`,
which means `core` gains its first real dependency, `zod` — see Dependencies
& Risks for why this is a deliberate, written architecture change, not a
silent one), `packages/store` (migration `007_google_accounts.sql`, new
`google-account-repo.ts`, a shared generic row-validation helper,
`thread-repo.ts` validates on read using `core`'s schema), `packages/agent`
(`loop.ts` persists the real conversation tail instead of two literals and
splits gated-call wait time from handler time, `context-trim.ts` becomes
group-aware, `types.ts`/`index.ts` thread `channel`/`channelUserId` into
tool handler context — a public tool-contract change), `packages/config`
(four new env vars), `apps/hermes` (`health.ts` becomes path/query-aware and
gains the OAuth callback route, three new command handlers, one new tool,
`boot.ts` dispatcher argument parsing and new wiring,
`Dockerfile`/`docker-compose.yml`/`.env.example`).

## Risk: high

Three things earn "high," each independent of the others. First, this is
the first phase where Hermes holds a genuine external secret at rest — a
Google refresh token, encrypted, but a bug in the AES-256-GCM envelope
(wrong key derivation, IV reuse, a swallowed decrypt error) either leaks a
credential that can read someone's email or silently bricks every stored
token with no error until the next `/connect`. Second, the OAuth callback
is a *second* unauthenticated inbound HTTP surface — `apps/hermes/src/health.ts`
today serves exactly one route with no query-string handling at all — and
its entire security model rests on one thing: a `state` nonce with PKCE,
implemented correctly, with no window where a guessed or replayed state
completes someone else's connection. Third, the automatic-refresh design
(D16) explicitly depends on an existing invariant — exactly one Hermes
process per database, enforced by the advisory lock `02-telemetry` and
`03-agent-core` already lean on — to make its in-process single-flight map
correct; a future change that adds a second refresh entrypoint (a cron
script, a worker process) outside `boot()` would silently reintroduce the
race the lock exists to prevent, with no test catching it. None of these
three is hypothetical span-of-imagination risk — each is a specific,
nameable failure mode this plan's Dependencies & Risks section addresses
directly.

## Dependencies & Risks

- **Invariant 5 (complete message history) is fixed in Phase 1, before any
  Google code, and its sizing is already confirmed.** `packages/core/src/llm-types.ts:10-47`
  already has `AssistantMessage.toolCalls` and `ToolMessage.toolCallId`;
  `packages/llm/src/adapter/openai-compatible.ts:204-226`'s `toWireMessage`
  already maps both, and the in-turn loop already pushes those same domain
  `Message`s (`loop.ts:402,412`) — one mapping, not two, so persisted and
  wire shapes already converge. `loop.ts:374-375` already replays the full
  union on the next turn. The gap is exactly two files: `loop.ts:455-458`
  persists the two literals `[{role:"user",...},{role:"assistant",content:text}]`
  instead of the conversation tail, and `context-trim.ts:33-44`'s
  `messages.slice(dropCount)` is role-blind — it will orphan a `role:"tool"`
  message from its preceding assistant `toolCalls` (an orphan a real
  OpenAI-compatible API rejects outright), and `estimateSize` (:20-22) reads
  only `.content`, so a tool call's arguments and a tool result's payload
  are both invisible to `HISTORY_BUDGET_CHARS`. Needs group-aware slicing
  **and** tool-call-aware sizing. Tests to update:
  `packages/agent/src/__tests__/loop.test.ts:101-104,299-302` and
  `packages/agent/src/__tests__/context-trim.test.ts` (whole file, esp.
  :23,:33,:48,:57).
- **Failed turns keep persisting nothing — this is not reopened.** A turn
  that throws (`MaxIterationsReachedError`, provider error, timeout) still
  never reaches `appendMessages` (`loop.ts:470-490`), locked in by
  `loop.test.ts:187,221,585,924`. A partial-turn persist would write the
  exact orphan shape the new group-aware trim exists to prevent, and it
  would be replayed to the provider on the next turn. **Known limitation,
  written down rather than fixed:** a failed turn is auditable in telemetry
  `turn` events, never in thread history.
- **`thread-repo.ts`'s unvalidated jsonb cast is fixed by making `Message`
  schema-first in `packages/core`, not by hand-mirroring a duplicate schema
  in `packages/store`.** `packages/store/src/thread-repo.ts:15` casts a
  jsonb row straight to `Message[]` with no runtime check; a malformed row
  (hand-edited, written by an older schema, corrupted) would flow straight
  into `trimHistory`/`converse` as if well-typed, and a `role:"tool"`
  message with no preceding assistant `toolCalls` would be replayed to the
  provider and rejected. **Revised from an earlier draft of this plan,
  which proposed a hand-synced duplicate zod schema living in
  `packages/store` to avoid giving `core` a dependency.** That was wrong: a
  hand-mirrored copy of a discriminated union across a package boundary is
  exactly the drift CLAUDE.md's DRY rule exists to prevent, and a drifted
  schema fails either open (a real malformed row sails through because the
  copy is looser than the type) or closed (a legitimate row is rejected
  because the copy is stricter) — either way, silently, since nothing
  would catch the two definitions diverging. The actual fix: `Message` and
  its four variants (`SystemMessage`/`UserMessage`/`AssistantMessage`/`ToolMessage`)
  move to a schema-first definition in `packages/core/src/llm-types.ts` —
  each is a `z.object`/`z.discriminatedUnion`, and the TS type is
  `z.infer<typeof schema>`, never hand-written. Drift becomes structurally
  impossible rather than merely detected, because there is only one
  definition to drift from. **This does cost `packages/core` its documented
  zero-dependency property** (`architecture.md:43`: "packages/core depends
  on nothing"), and this plan amends that line rather than pretending
  otherwise (see Knowledge Base Impact) — but the amendment is narrow:
  "depends on nothing" becomes "depends on no other `@hermes/*` package";
  `zod` is a leaf, third-party validation library already load-bearing in
  `packages/agent` and `packages/config`, not another package's
  implementation `core` would be coupling to. The reasoning `architecture.md`
  gives for the zero-dependency posture ("so lower packages can be depended
  on without depending on their implementations") is about workspace-package
  coupling, and `zod` doesn't touch that. `packages/store` keeps a small
  **generic** row-validation helper (`parseValidatedJson<T>(schema, value,
  context)`) that takes any zod schema — it validates `core`'s `Message`
  schema for `thread-repo.ts` and, in Phase 2, `packages/google-auth`'s own
  (also schema-first) `GoogleAccount` schema for `GoogleAccountRepo` — one
  generic helper serving two schema-first types declared in the packages
  that own them, which is settled decision 12(b)'s "one idiom, not two"
  satisfied without a shared-schema package.
- **The gated-call `duration_ms`/wait-time split (settled decision 12a) is
  folded into Phase 1, not given its own phase.** Recorded as an open item
  in `.ai/decisions/telemetry-event-schema.md`: a denied/timed-out gated
  `tool.call`'s `duration_ms` today measures the approval wait (one observed
  row reads `301723`ms — the 5-minute window — for a call whose handler
  never ran), because `runGatedToolCalls` starts its clock before
  `requestApproval`. Fixed by splitting the clock: `durationMs` becomes
  handler-execution time only, a new `approvalWaitMs` field on
  `ToolCallEvent` carries the wait. **Honestly flagged, not glossed over:**
  no phase in this plan ships a gated Google tool — `whoami` is explicitly
  ungated (settled decision 3) — so nothing here exercises the split live.
  Coverage is by unit test only. It's folded into Phase 1 rather than given
  its own phase because Phase 1 is already "pay down `03-agent-core`'s
  recorded debt before building on top of it," and a phase whose only
  content is an internal telemetry field split has no user-visible acid-test
  answer to stand alone on.
- **The loopback OAuth redirect reuses the existing health server, and that
  server has to learn query strings for the first time.** `apps/hermes/src/health.ts`
  compares `req.url === "/health"` with strict equality today — `/health?x=1`
  already 404s, so there is no router to extend, only a strict compare to
  replace with a real `pathname` switch. The container already publishes
  `3000:3000` (`docker-compose.yml`), so `http://localhost:3000/oauth/callback`
  reaches the container from the host browser with no network change.
  Google client type is **Web application** (not "Desktop"/installed-app),
  because the redirect URI must exact-match, and the fixed published port
  guarantees that. New env `OAUTH_REDIRECT_BASE_URL`, default
  `http://localhost:3000`, so a future non-local deploy is a config change,
  not a code change.
- **The health server is constructed before the Telegram channel exists in
  `boot()` today, but the callback route needs `channel.send` to deliver the
  "Connected as <email>" confirmation — this plan does not reorder boot.**
  `apps/hermes/src/boot.ts`'s `boot()` calls `serveHealth(pool, config.PORT, logger)`
  before `wireRuntimeAndShutdown` constructs the Telegram channel. Boot order
  is documented as load-bearing, step-by-step (`architecture.md`), so this
  plan does not reshuffle it for one route's convenience. Instead, the OAuth
  callback's request handler is built as a small mutable holder
  (`createOauthCallbackRoute()` returning `{ handleRequest, bind(connectFlow,
  notify) }`) constructed early and passed into `serveHealth`'s router
  unbound; `wireRuntimeAndShutdown` calls `.bind(...)` once the channel and
  `connectFlow` exist. A callback arriving before `bind()` runs (only
  possible if Google redirects back before Hermes finishes booting, which
  cannot happen — the operator can't reach `/connect google` until the bot
  is live) gets a `503`. **This indirection is not covered by any of the 16
  settled decisions — it is this plan's own call, made to avoid touching
  boot's documented ordering for a single route.**
- **The callback's authorization is the state nonce plus PKCE — nothing
  else, and it is consumed exactly once.** `/connect google` mints a random
  `state` and an S256 PKCE verifier, recording a pending entry keyed by
  `state` holding `{ channelUserId, chatId, scopes, verifier, exp }` in an
  in-process map, 10-minute TTL. The callback is authorized **solely** by
  presenting a `state` that resolves to a live entry: constant-time compare,
  consumed on first use, so a replayed or guessed `state` — expired,
  unknown, or already-consumed — is one branch, a `400` with no detail
  (mirrors the approval gate's "expired, ask again" collapse of restart and
  already-answered into one branch). In-memory is a deliberate mirror of the
  approval gate's own documented tradeoff: a restart drops a pending
  connection, the operator re-runs `/connect`. The browser's landing page
  never echoes the code, success or failure; the result is reported into
  Telegram, not the browser tab.
- **The dispatcher learns arguments in Phase 2, and it closes a real
  paid-fallthrough hole while it's at it.** `boot.ts:74-76`'s `matchesCommand`
  is exact-match (or `cmd@bot`), so `/connect google` today matches nothing
  and falls through to the **paid** completion handler. Fixed by splitting
  incoming text on the first whitespace — head is the command, tail is the
  argument string — so `/connect google`, `/disconnect`, `/status` all route
  locally, and every other command gets the same fix as a side effect: no
  command with an argument can fall through to the paid handler by accident
  again. Tests pin `/stats` unchanged (bare command → empty args) and
  `/connect bogus` handled locally, never reaching the completion handler.
  Touchpoints: `boot.ts:74-76`, `:97-106` (`createDispatchCommand`),
  `:371-414` (`createMessageHandlers`).
- **The encryption key has one job and a fixed shape, validated at boot, not
  at first use.** `TOKEN_ENCRYPTION_KEY` = 32 random bytes, base64,
  generated once by the operator (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`),
  gitignored `.env` only. `packages/config`'s zod schema validates it decodes
  to exactly 32 bytes, so a malformed key fails boot with a named error
  instead of failing silently at the first token write, weeks later.
  Ciphertext is stored as a self-describing envelope `{ v: 1, iv, tag, ct }`
  so a future two-key rotation scheme needs no migration — the envelope
  already carries a version. Rotation itself stays manual and documented
  (see Context's out-of-scope list), not automated.
- **`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `TOKEN_ENCRYPTION_KEY`
  are one all-or-none group, not three independent required vars** — the
  `checkFallbackAllOrNone` idiom `packages/config` already uses for its LLM
  fallback profile. Set all three, Google features work; set none, they're
  cleanly absent and boot succeeds; set a partial set, boot fails naming the
  missing key. `OAUTH_REDIRECT_BASE_URL` is **not** in that group — it has a
  default (`http://localhost:3000`) and is meaningful even before any
  Google var is set, so it validates independently.
- **Token row keying is `(channel, channel_user_id)`, and `chat_id` is
  captured as its own column, not derived at alert time.** New migration
  `007_google_accounts.sql` (confirmed next — `006_threads.sql` is the
  current highest; **re-verify at Phase 2 execution time** before creating
  it, the same caveat `03-agent-core` carried for its own migrations and got
  right). Primary key `(channel, channel_user_id)` — the same identity the
  allowlist already gates on, stable across threads and restarts. `chat_id`
  is captured at `/connect` time specifically so Phase 4's refresh-failure
  alert is a column read: `apps/hermes/src/agent/build-agent.ts`'s existing
  `threadId → chatId` in-memory index is empty after a restart and would be
  useless for a background sweep that runs independent of any turn.
  Columns: `channel`, `channel_user_id`, `chat_id`, `google_email`, `scopes
  text[]`, `token_envelope jsonb`, `expires_at timestamptz`, plus
  created/updated timestamps.
- **`@hermes/google-auth` owns the flow; `packages/store` never sees a
  plaintext token.** New package per D3/D7: OAuth2 flow (via
  `google-auth-library`), the scope registry, the AES-256-GCM seal/open
  (`token-crypto.ts`), and — Phase 4 — the refresh coordinator all live
  here, so `TOKEN_ENCRYPTION_KEY` never enters `packages/store`'s config
  surface. `packages/store` gains migration `007` and a `GoogleAccountRepo`
  implementation that persists an **opaque** `token_envelope` and reads it
  back the same way — it never decrypts. Port-binding follows the existing
  `build-thread-repo.ts` idiom: the port type is declared inside
  `packages/google-auth`, `apps/hermes/src/store/build-google-account-repo.ts`
  binds it to `@hermes/store`'s free functions. **No `packages/crypto`** —
  one consumer is not two; CLAUDE.md rejects the speculative split.
  `.ai/index.md:21`'s "google-* packages are deliberately absent until their
  phase" line is edited in this plan's Knowledge Base Impact — this is that
  phase. Also: a new package means the `Dockerfile`'s explicit
  package.json COPY list and `tsconfig.base.json`'s `paths` both gain an
  entry, the same as `03-agent-core` had to do for `packages/agent`.
- **The OAuth flow never touches the agent loop — stated here as an
  invariant, not left implicit.** `/connect google`, `/disconnect`,
  `/status` are command handlers, not tools; the model never sees the auth
  URL, the state nonce, the code, or a token. Tool handlers that need Google
  access (future phases) receive an authenticated client — a callable that
  injects the access token — never the credential itself, so there is
  nothing in model context an injected prompt could exfiltrate. `whoami`
  returns a projection (the email), never a credential.
- **The agent cannot escalate its own scopes.** When a tool's required scope
  is missing (or, this phase, when the account simply doesn't exist yet),
  the handler returns a structured non-fatal result — `{ ok: false, reason:
  "not_connected" }` for `whoami`, the general shape `{ ok: false, reason:
  "missing_scope", scope }` for later phases' tools — which the model relays
  as "run /connect google." The agent can never mint a consent URL or raise
  a prompt itself; incremental consent is the exact primitive an injected
  agent would use to escalate, so every scope Hermes holds was granted by a
  human typing a command. The scope registry (`packages/google-auth/src/scopes.ts`)
  is the single place a tool's required scopes are declared, consulted at
  tool-selection time in later phases; this phase's `whoami` requires only
  the identity scope every connected account already has, so the
  missing-scope branch is exercised only by "not connected at all," not by
  a partial-consent case — that case is real starting Phase 4+.
- **`whoami` needs to know *whose* Google account to read, and the tool
  handler's context has no identity field today — this plan widens
  `ToolSpec`'s public contract to add one.** `ToolSpec.handler`'s signature
  is `(args: unknown, ctx: { signal: AbortSignal }) => Promise<unknown>`
  (`packages/agent/src/types.ts`), constructed in exactly one place today —
  `spec.handler(args, { signal })` at `loop.ts:152` — and called directly,
  bypassing the loop entirely, in two existing test files
  (`apps/hermes/src/agent/tools/__tests__/get-current-time.test.ts:17`,
  `echo.test.ts:17-19`), both of which build the `ctx` object literal by
  hand. `runTurn`/`Agent.handleMessage` only carry `channel` and `chatId`,
  never the sender's channel-scoped identity (`channelUserId` — the same
  identity the allowlist gates on and `GoogleAccountRepo`'s primary key's
  second column uses) — and `GoogleAccountRepo` is keyed on **both**
  `channel` and `channel_user_id` (settled decision 6), so `ctx` widens to
  carry both, not `channelUserId` alone: `{ signal: AbortSignal; channel:
  string; channelUserId: string }`. `channel` costs nothing new to thread —
  `runTurn` already receives it as a parameter, it's simply never been
  passed into `ctx` — and passing it means `whoami`'s handler reads
  `ctx.channel` rather than importing a hardcoded `CHANNEL_TELEGRAM`
  constant from `build-agent.ts` (which would be an ugly reverse import:
  `build-agent.ts` constructs `whoami.ts`, so `whoami.ts` importing back
  from `build-agent.ts` is backwards). **Correction from an earlier draft
  of this plan, which called this change "additive" — it is not, fully.**
  Existing tool *bodies* don't change (`get_current_time`/`echo` ignore the
  new fields, no source edit needed), but this is a widening of
  `ToolSpec.handler`'s **required** ctx shape — a public surface change to
  the tool contract every future `ToolSpec` implementation must honor — and
  the two test files that construct `ctx` literals directly, bypassing
  `loop.ts`, fail to typecheck until each gains `channel`/`channelUserId` on
  its literal. Both are one-line fixes, listed explicitly in Phase 3's File
  changes rather than left to be discovered by a red `pnpm -r typecheck`.
  Threaded through `Agent.handleMessage(channel, chatId, channelUserId,
  text)` → `runTurn(...)` → `converse(...)` → each tool invocation.
  `apps/hermes/src/handlers/complete.ts` already receives an
  `InboundMessage` carrying the sender's id; it now passes it through
  instead of dropping it. **This wiring is not covered by any of the 16
  settled decisions — it's this plan's own design, made because `whoami` is
  the first tool in this codebase that needs to know who's asking**, and
  every future Google-backed tool inherits the same `ctx.channel`/
  `ctx.channelUserId` for free.
- **`google-auth-library` is a pre-approved dependency (ROADMAP §6); this
  plan still records it in writing per CLAUDE.md.** Load-bearing: OAuth2 +
  token refresh is an auth/token protocol, the exact category CLAUDE.md
  names as worth a dependency rather than a worse, less-tested homemade
  copy. Low-risk: first-party from the vendor whose service is being
  depended on — the strongest case CLAUDE.md's own bar names. Used
  narrowly — the OAuth2 client for code exchange and refresh only.
  Everything else (scope registry, crypto, storage, the future
  Gmail/Calendar/Sheets `fetch` wrappers) is homemade. Rejected:
  `googleapis` (a generated SDK for hundreds of endpoints this codebase will
  never call at the ~15-endpoint scale ROADMAP §6 names — use `fetch`
  directly once real API calls exist), `express` (the existing
  `node:http` health server is extended, exactly as ROADMAP §6 already
  rejects `express` for "a handful of webhook routes").
- **Automatic refresh (Phase 4) goes through one seam — `getValidAccessToken`
  — that both the boot-owned sweep and every future request-path tool call
  share, so this design does not have to be replaced the moment Phase 4+
  ships a real Google API tool.** `whoami` itself reads the cached
  `google_email` column captured at connect time and makes no live Google
  API call this phase (settled decision 14), so nothing in *this plan*
  calls the seam reactively — but a design that only works because nothing
  calls it yet is not a design, it's a placeholder, and a future PRD adding
  a real Gmail/Calendar tool must not have to redo this. **Revised from an
  earlier draft, which put the single-flight map directly behind a
  sweep-only `refreshAccount` function** — instead,
  `createRefreshCoordinator` exposes exactly one public entry point,
  `getValidAccessToken(account): Promise<{ accessToken: string; account:
  GoogleAccount }>`: if `account.expiresAt - now() < REFRESH_SKEW_MS`, it
  refreshes (through the single-flight map) and returns the updated
  account; otherwise it decrypts and returns the cached access token
  unchanged. **The sweep and a future request-path call are both just
  callers of this one function** — the sweep calls it for every account its
  `listAccountsExpiringBefore(cutoff)` query returns (`cutoff` computed from
  the *same* `REFRESH_SKEW_MS` constant, so the query's notion of "expiring
  soon" and the accessor's notion of "needs refresh" can never drift apart
  into two independently-tuned numbers), and a future tool would call it
  lazily on the request path — both share one single-flight map
  (`Map<accountKey, Promise<...>>`, entry deleted in a `finally`), so a
  request-path call racing a sweep tick for the same account is already
  handled by construction, not left as a gap for that later phase to
  discover. Concrete values: `REFRESH_SWEEP_INTERVAL_MS = 5 * 60_000` (5
  minutes), `REFRESH_SKEW_MS = 10 * 60_000` (10 minutes) — skew deliberately
  double the interval, so one missed or slow tick still leaves a full
  interval of buffer before a token actually expires. Single-flight is
  **sufficient, not merely convenient**, specifically because
  `packages/store/src/advisory-lock.ts:29` takes a session-level
  `pg_try_advisory_lock` at boot and `boot.ts:169-176` exits non-zero when
  it's held — exactly one Hermes process per database. **Constraint this
  plan adds and future work must respect: token refresh must never be
  reachable from an entrypoint outside `boot()`** (a standalone script, a
  second worker process) — that assumption is what makes the in-process
  map correct; a second process would share neither the map nor the lock's
  protection. Stated explicitly, not left implicit: the sweep's first
  `runOnce()` call is wired inside `wireRuntimeAndShutdown`, which in
  `boot()`'s documented step order (`architecture.md`) runs strictly after
  `acquireInstanceLockOrExit` — the sweep cannot run before the advisory
  lock is held because nothing in `boot()` can reach that point without it.
  Refresh failure (`invalid_grant`/revoked) raises a proactive Telegram
  alert to the row's `chat_id` and marks the account disconnected — never a
  silent, repeating 401.
- **No CI change.** This plan adds no new live-provider test lane and no
  excluded-glob change — `pnpm test`/`pnpm test:db` already cover everything
  here the same way they cover `03-agent-core`'s suites.
- **`pnpm lint` is a named gate in Final Verification, not an afterthought.**
  `03-agent-core` shipped Phase 3 with `pnpm lint` red (10 errors, two left
  behind by an earlier phase) and had to clean it up mid-review, because CI
  runs lint before test and nothing in that plan's Verification checklist
  named it explicitly until then. This plan names it from the start.

## Prerequisites (manual, before Phase 1)

**Mode:** hil

Google's own console UI changes over time — treat every specific label,
menu path, and toggle below as **verify at execution time**, and the
underlying requirement (Web application client type, Production publishing
status, these exact scopes pre-listed) as fixed.

- [ ] Create (or choose) a GCP project for Hermes.
- [ ] Configure the OAuth consent screen: **External** user type, publish
      to **Production** (not Testing) — settled decision 15: because this
      phase requests only non-sensitive scopes (`openid`, `userinfo.email`),
      no Google verification review is required to publish, and refresh
      tokens are long-lived, which is what makes "survives a container
      restart" hold without a weekly re-consent chore. Write down for
      future reference: the moment a later phase adds a restricted scope
      (Gmail), that phase either submits for verification or drops back to
      Testing and accepts ~7-day refresh-token expiry — this plan names the
      consequence, that phase decides it.
- [ ] Create an OAuth 2.0 Client ID of type **Web application** (not
      "Desktop app") — required for the exact-match redirect URI settled
      decision 1 depends on.
- [ ] Register the authorized redirect URI: `http://localhost:3000/oauth/callback`
      (matches `OAUTH_REDIRECT_BASE_URL`'s default plus the new route added
      in Phase 2).
- [ ] Enable the Gmail API and the Calendar API now, and note their scope
      strings, even though no code calls them this phase — so a later phase
      needs only a browser re-consent (incremental consent), not a second
      console trip.
- [ ] Generate the token-encryption key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- [ ] Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`
      to the repo-root `.env` (gitignored). `OAUTH_REDIRECT_BASE_URL` may be
      left unset — it defaults to `http://localhost:3000`.

---

### Phase 0: Create worktree

**This phase is always first. No exceptions.**

Follows the same sibling-worktree convention `01-llm-port`, `02-telemetry`,
and `03-agent-core` used.

**Steps:**

- [x] Confirm with the user: branch name `feat/04-google-auth`, base ref `main`
- [x] `git worktree add ../hermes-04-google-auth -b feat/04-google-auth main`
- [x] Verify worktree is active and on the correct branch: `git worktree list`
- [x] **Explicit step, do not skip:** copy `.env` from the repo root into the
      new worktree (`../hermes-04-google-auth/.env`) — gitignored, so the
      worktree starts without it, and without it the Prerequisites section's
      Google vars are invisible to the app.

---

### Phase 1: Complete tool-call history, group-aware trim, validated persistence

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** Ask the bot "what time is it?" (exercising the
existing `get_current_time` tool), then ask a follow-up that depends on
having seen that answer — the model can actually reference the tool result
in a later turn, because it's now in stored history, not just discarded at
the end of the turn it ran in. `psql` shows the thread's `messages` jsonb
containing the assistant's `tool_calls` and the matching `role:"tool"`
result, not just a bare user/assistant text pair. A long, tool-heavy
conversation that exceeds `HISTORY_BUDGET_CHARS` trims without ever
orphaning a `role:"tool"` message from its assistant `toolCalls` — verified
by a test that forces a trim boundary to fall inside a tool-call group. A
manually corrupted thread row (`psql` edit to break the `Message` shape) is
rejected on read with a clear error instead of being silently replayed to
the provider. This phase also lands the `duration_ms`/`approval_wait_ms`
telemetry split recorded as an open item after `03-agent-core` — folded in
here rather than given its own phase because nothing in this plan ships a
gated Google tool to exercise it live (`whoami` is ungated); it is
unit-tested only, which this plan states rather than implies otherwise.
**Commit message:** `fix: persist full tool-call history, group-aware trim, validated thread reads`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/agent/src/loop.ts` | `runTurn`'s persist call (today `loop.ts:455-458`, two hardcoded literals) replaced with appending the actual conversation tail `converse` produced this turn — the seed user message plus every assistant/tool message generated during the loop, in order, ending with the final assistant reply. Persist still happens **only on success** (unchanged from `03-agent-core`'s settled behavior — see Dependencies & Risks) |
| modify | `packages/agent/src/loop.ts` (`runGatedToolCalls`/`finishToolCall`) | split the clock: `durationMs` starts when a call actually begins executing (handler start for ungated, post-resolution for a gated call that was approved); a new `approvalWaitMs` is recorded separately for gated calls, measuring time spent in `requestApproval` — present (possibly `0`) only on calls that went through the gate, `undefined` on ungated calls |
| modify | `packages/core/src/telemetry.ts` | `ToolCallEvent` gains `approvalWaitMs?: number` |
| modify | `packages/agent/src/context-trim.ts` | `trimHistory` becomes group-aware: a `role:"assistant"` message carrying `toolCalls` and every following `role:"tool"` message answering those calls are treated as one atomic group for trim purposes — dropped together, never split. `estimateSize` extended to include a tool call's serialized `arguments` and a tool message's `content`, not just plain `.content`, so a tool-heavy turn is no longer invisible to `HISTORY_BUDGET_CHARS`. The newest user message is still never passed into `trimHistory` (`03-agent-core`'s existing contract, unchanged) |
| modify | `packages/core/src/llm-types.ts` | `SystemMessage`/`UserMessage`/`AssistantMessage`/`ToolMessage`/`Message` become schema-first: each a `z.object`/the union a `z.discriminatedUnion("role", [...])`, with the exported TS types becoming `z.infer<typeof ...>` instead of hand-written interfaces — eliminates the hand-sync drift risk a mirrored schema in `packages/store` would carry (see Dependencies & Risks). Also exports `messageSchema`/`messagesArraySchema` for the store's read-validation |
| modify | `packages/core/package.json` | add `"zod": "^3.25.0"` — `core`'s first real dependency; version pinned to match `packages/agent`'s existing `zod` range |
| modify | `.ai/architecture.md` | amend the line "`packages/core` depends on nothing" — see Knowledge Base Impact for the exact wording |
| create | `packages/store/src/validate-row.ts` | a small **generic** helper, e.g. `parseValidatedJson<T>(schema: z.ZodType<T>, value: unknown, context: string): T` — throws a descriptive error naming the table/column on validation failure (fail closed, per ROADMAP invariant 7); takes any zod schema, so it's reused unmodified by `GoogleAccountRepo` in Phase 2 against `packages/google-auth`'s own schema-first `GoogleAccount` type — one generic helper, two schema-first types each declared in the package that owns them (settled decision 12b's "one idiom, not two") |
| modify | `packages/store/src/thread-repo.ts` | `toThread` runs the row's `messages` through `parseValidatedJson(messagesArraySchema, row.messages, "threads.messages")` (importing `messagesArraySchema` from `@hermes/core`) instead of casting; a malformed row throws instead of silently flowing into `trimHistory`/`converse` |
| modify | `packages/store/README.md` | document that `threads.messages` is now runtime-validated on read against `@hermes/core`'s schema, and what a validation failure looks like |
| modify | `packages/core/README.md` | document that `Message` is now schema-first (zod, with `z.infer`-derived types) and that `core` depends on `zod` — its one deliberate exception to "no other `@hermes/*` package," not a reversal of the dependency-direction rule |
| modify | `packages/agent/README.md` | document that persisted history now includes the full tool-call/tool-result shape, the group-aware trim contract, and the `approvalWaitMs` telemetry split |
| modify | `packages/agent/src/__tests__/loop.test.ts` | lines 101-104, 299-302 (persist-shape assertions) updated to expect the real conversation tail, not the two-literal shape |
| modify | `packages/agent/src/__tests__/context-trim.test.ts` | whole file rewritten for group-aware behavior (esp. lines 23, 33, 48, 57 per the research note) |

**Steps:**

- [x] **Persist the actual conversation tail, not a re-derived one.**
      `converse`'s local `conversation` array (`loop.ts:375` seed onward)
      already holds every message generated this turn in wire order — reuse
      that array's *new* entries directly in the `appendMessages` call
      rather than reconstructing them from `result.text`/`toolCalls`
      separately, so there is exactly one source of truth for what a turn
      produced
- [x] Confirm the wire-order invariant `03-agent-core` established still
      holds after this change: an assistant message with `toolCalls` is
      always persisted **before** the `role:"tool"` messages answering it —
      write a test asserting this ordering survives a full round trip
      through `appendMessages` → `getOrCreateThread` → the next turn's
      `trimHistory`/`converse` seed
- [x] **Group-aware trim**: write the test that forces the trim boundary to
      land *inside* a tool-call group (an assistant-with-toolCalls message
      old enough to be a trim candidate, but its tool-result messages
      younger) and assert the whole group drops together, never half of it
- [x] `estimateSize`'s new tool-call-aware sizing: write a test where a
      conversation is small in plain-text `.content` but large once a tool
      call's `arguments`/a tool result's `content` are counted, and confirm
      it now trims when it previously wouldn't have
- [x] `approvalWaitMs`/`durationMs` split: since no gated tool ships this
      phase, exercise it with `03-agent-core`'s existing `echo` tool (still
      wired, still gated) in a unit test — approve a call and assert
      `durationMs` reflects only handler time while `approvalWaitMs`
      reflects the approval-gate wait; deny/timeout a call and assert
      `durationMs` is small (or zero) while `approvalWaitMs` carries what
      used to be misattributed to `durationMs`
- [x] `parseValidatedJson`'s error message must name the table/column and
      not leak the malformed row's full content into logs indiscriminately —
      match the truncation posture `03-agent-core` already applies to
      `tool.call`'s `error` field (500 chars)
- [x] Confirm `GoogleAccountRepo` (Phase 2) can reuse `validate-row.ts`
      unmodified — check its generic signature doesn't accidentally bake in
      anything `Message`-specific before Phase 2 needs it
- [x] **Converting `Message`'s hand-written interfaces to `z.infer`-derived
      types must not change their runtime or compile-time shape** — after
      the conversion, run `pnpm -r typecheck` and `pnpm -r test` across
      `packages/llm` and `packages/agent` (both consume `Message` today)
      with **no source changes to either package** and confirm both stay
      green; if either needs an edit, the conversion introduced a real shape
      change and the schema is wrong, not the consumer
- [x] Confirm `packages/core/package.json` gaining a `dependencies` field
      for the first time doesn't break its `tsup` build (`format esm --dts`)
      — `zod` is already bundled the same way by `packages/agent`/`packages/config`,
      so this should be a non-event, but verify `pnpm --filter @hermes/core build`
      still produces a working `dist/index.js`

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `packages/agent/src/__tests__/loop.test.ts` | a turn that calls a tool persists the full conversation tail (assistant-with-toolCalls, tool result, final assistant text), not two literals; wire-order survives a round trip through a fake `ThreadRepo`; `approvalWaitMs` vs `durationMs` split for an approved and a denied/timed-out gated call (using the existing `echo` tool) |
| modify | `packages/agent/src/__tests__/context-trim.test.ts` | a trim boundary inside a tool-call group drops the whole group, never orphans a `role:"tool"` message; `estimateSize` counts tool-call arguments and tool-result content, not just `.content`; existing drop-oldest/keep-under-budget/never-drop-current-message cases from `03-agent-core` still pass |
| create | `packages/core/src/__tests__/llm-types.test.ts` (or extend if a file already covers `llm-types.ts`) | valid `Message[]` shapes for all four roles parse via `messagesArraySchema`; a `role:"tool"` message missing `toolCallId` is rejected; an unknown `role` is rejected; `z.infer`-derived `Message`/`SystemMessage`/etc. types still satisfy every existing usage in `packages/llm`/`packages/agent` (typecheck-only assertion, no runtime test needed for this half) |
| modify | `packages/store/src/__tests__/thread-repo.test.ts` (test:db) | a hand-corrupted row (raw SQL `UPDATE` breaking the `Message` shape) causes `getOrCreateThread`'s read to throw a descriptive error instead of returning silently-cast garbage |

**Verification:**

- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm test:db` green
- [ ] Manual: ask the bot "what time is it?", then in the same chat ask "what
      did that tool just tell you?" → the reply demonstrates the model
      actually has the tool result in context, not just a restated guess
- [ ] Manual: `psql` into the app database after that exchange → the
      thread's `messages` jsonb contains an assistant message with
      `tool_calls` and a following `role: "tool"` entry with a matching
      `tool_call_id`, not a bare two-message pair

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `fix: persist full tool-call history, group-aware trim, validated thread reads`
- [x] Phase marked complete

**Outstanding for Phase 1 (deliberately unticked):** the two `Manual:` verification items need a live bot + `psql` session and are the orchestrator's to run; the handoff/`/clear` boxes do not apply because this phase was executed and reviewed in one session. Code-review verdict: **green**, no blocking findings. Commits: `9dc59fe` (phase), `b587374` (review nits).

---

### Phase 2: `/connect google` end to end

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** In Telegram, send `/connect google`. The bot replies
with a link. Opening it in a browser goes through Google's consent screen
(requesting only the account's email identity), redirects back to
`http://localhost:3000/oauth/callback`, and the browser shows a minimal
"you can close this tab" page — the authorization code is never visible
anywhere in that page's HTML. Back in Telegram, a message arrives:
"Connected as `<email>`." `psql` shows one row in `google_accounts` keyed by
`(channel, channel_user_id)`, with `token_envelope` an opaque `{v,iv,tag,ct}`
JSON blob — never a readable token. Sending `/connect bogus` is handled
locally with a usage message and never reaches the paid completion handler.
**Commit message:** `feat: google OAuth connect flow, encrypted token store, oauth callback route`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `apps/hermes/src/boot.ts` | `matchesCommand`/`createDispatchCommand` (`:74-76`, `:97-106`) split incoming text on first whitespace into `{ command, args }`; every existing command handler's signature gains an `args: string` parameter (empty string when none supplied); `DispatchCommandDeps` gains `connectHandler`/`disconnectHandler`/`statusHandler` fields; `createMessageHandlers` (`:371-414`) wires all three |
| create | `apps/hermes/src/handlers/connect.ts` | `createConnectHandler(channel, connectFlow, ...)` — parses `args` (`"google"` is the only supported provider this phase; anything else replies with usage help, handled locally); calls `connectFlow.startConnect(channelUserId, chatId, IDENTITY_SCOPES)`, replies with the auth URL as plain text (a clickable link, no inline keyboard needed). **`/disconnect` and `/status` are not created this phase** — Phase 3 owns both, alongside `whoami`, so no half-finished handler crosses a phase boundary |
| modify | `packages/config/src/schema.ts` | add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (`optionalLlmString`-style empty-string normalization), `TOKEN_ENCRYPTION_KEY` (a named module-level schema validating base64-decodes to exactly 32 bytes, no default — fail closed), all three in one `checkFallbackAllOrNone`-style group; `OAUTH_REDIRECT_BASE_URL` (`z.string().url().default("http://localhost:3000")`), validated independently, not part of the group |
| modify | `packages/config/src/schema.ts` (`IS_SECRET_ENV_KEY`) | `GOOGLE_CLIENT_SECRET: true`, `TOKEN_ENCRYPTION_KEY: true`, `GOOGLE_CLIENT_ID: false`, `OAUTH_REDIRECT_BASE_URL: false` — exhaustive over `Env`, will not compile otherwise |
| modify | `packages/config/README.md` | document the four new vars, the all-or-none group, and the key-format validator |
| modify | `.env.example` | add all four with comment blocks explaining what's unset if absent ("Google features cleanly disabled") and cross-reference the Prerequisites key-generation command |
| modify | `docker-compose.yml` | add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `OAUTH_REDIRECT_BASE_URL` to the `hermes` service's `environment:` block, `${VAR:-}` passthrough matching existing optional vars |
| modify | `tsconfig.base.json` | add `@hermes/google-auth` to `paths` |
| modify | `Dockerfile` | add `COPY packages/google-auth/package.json packages/google-auth/package.json` to the manifest copy list |
| create | `packages/google-auth/package.json`, `tsconfig.json` | new workspace package templated on `packages/agent`'s shape: `type: module`, `dist` main/types, `typecheck`/`build`/`test` scripts; dependencies `@hermes/core`, `google-auth-library`, `zod` |
| create | `packages/google-auth/src/pkce.ts` | `generatePkcePair(): { verifier: string; challenge: string }` — S256: a random verifier, `challenge = base64url(sha256(verifier))`, per RFC 7636 |
| create | `packages/google-auth/src/scopes.ts` | scope registry: `IDENTITY_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"]`; `hasRequiredScopes(granted: string[], required: string[]): boolean`; a `Map` of tool name → required scopes, seeded this phase with only `whoami → IDENTITY_SCOPES` (consulted starting Phase 3) |
| create | `packages/google-auth/src/token-crypto.ts` | `sealToken(plaintext: string, key: Buffer): TokenEnvelope` / `openToken(envelope: TokenEnvelope, key: Buffer): string` — AES-256-GCM, random 12-byte IV per seal, envelope `{ v: 1, iv: base64, tag: base64, ct: base64 }`; `openToken` throws a typed `TokenDecryptError` on tag-mismatch (tampered/wrong-key) rather than returning garbage |
| create | `packages/google-auth/src/pending-connections.ts` | in-memory `Map<state, PendingConnection>`; `createPendingConnection(...)` mints a high-entropy random `state` (not attacker-guessable — the practical implementation of settled decision 10's "constant-time compare": a `Map` keyed on the exact state string is an O(1) hash lookup, not a byte-by-byte comparison against a list of live states, so there is no timing side channel to guard against separately), stores `{ channelUserId, chatId, scopes, verifier, exp }`, 10-minute TTL; `consumePendingConnection(state)` deletes on read, returns `undefined` for unknown/expired/already-consumed (one branch, no distinction) |
| create | `packages/google-auth/src/oauth-client.ts` | thin wrapper over `google-auth-library`'s `OAuth2Client`: `buildAuthUrl(client, { scopes, state, codeChallenge }): string`; `exchangeCode(client, { code, verifier }): Promise<{ accessToken, refreshToken, expiresAt, idTokenClaims }>` |
| create | `packages/google-auth/src/account-repo-port.ts` | `GoogleAccount` is **schema-first**, matching the idiom `packages/core`'s `Message` now uses (Phase 1) — a `z.object` (`channel: z.string()`, `channelUserId: z.string()`, `chatId: z.string()`, `googleEmail: z.string()`, `scopes: z.array(z.string())`, `tokenEnvelope: tokenEnvelopeSchema`, `expiresAt: z.date()`) with `type GoogleAccount = z.infer<typeof googleAccountSchema>`; `GoogleAccountRepo { getAccount(channel, channelUserId): Promise<GoogleAccount \| undefined>; upsertAccount(account: GoogleAccount): Promise<void>; deleteAccount(channel, channelUserId): Promise<void> }` — the injected port; `packages/google-auth` never imports `@hermes/store` |
| create | `packages/google-auth/src/connect-flow.ts` | `createConnectFlow(deps: { oauthClient, repo: GoogleAccountRepo, cryptoKey: Buffer, pendingStore, clock })`: `startConnect(channelUserId, chatId, scopes): { url, state }` (mints PKCE + state, records pending, builds the auth URL); `completeConnect(state, code): Promise<{ ok: true; email: string; chatId: string } \| { ok: false; reason: "invalid_state" }>`. **Per CLAUDE.md's ~30-line-function guidance, `completeConnect` is decomposed into small named steps rather than one long function** — e.g. `validatePendingConnection(state)`, `exchangeAndSealTokens(pending, code)`, `persistAccount(...)` — each independently readable, `completeConnect` itself just sequences them: consume the pending entry, exchange the code with the stored verifier, decode `idTokenClaims.email`, seal both tokens into one envelope (or two — **verify at execution time** whether `google-auth-library`'s refresh token needs separate sealing from the access token, or one envelope holding both suffices), call `repo.upsertAccount` |
| create | `packages/google-auth/src/index.ts` | public exports: `createConnectFlow`, `GoogleAccountRepo`, `GoogleAccount`, `IDENTITY_SCOPES`, `hasRequiredScopes`, `sealToken`/`openToken`/`TokenEnvelope` (for the repo's opaque storage), `generatePkcePair` |
| create | `packages/google-auth/README.md` | the flow shape: PKCE + state authorize the callback, tokens never leave this package unsealed, the scope registry, what Phase 4 will add |
| create | `packages/store/src/migrations/007_google_accounts.sql` | table per settled decision 6: `channel`, `channel_user_id`, `chat_id`, `google_email`, `scopes text[]`, `token_envelope jsonb`, `expires_at timestamptz`, `created_at`/`updated_at timestamptz not null default now()`, `PRIMARY KEY (channel, channel_user_id)`, plus `CREATE INDEX google_accounts_expires_at_idx ON google_accounts (expires_at)` — Phase 4's `listAccountsExpiringBefore` sweep query filters on this column every tick; an unindexed sequential scan is cheap at today's row counts but there's no reason to ship it unindexed when `006_threads.sql` already set the precedent of an explicit named index. **Provisional number — re-verify `006` is still highest before creating this file** |
| create | `packages/store/src/google-account-repo.ts` | free functions taking `pool: Pool` first, matching `thread-repo.ts`'s shape: `getAccount`, `upsertAccount` (`INSERT ... ON CONFLICT (channel, channel_user_id) DO UPDATE` — **first `DO UPDATE` in this codebase, a deliberate, justified exception to the `DO NOTHING`-only precedent**: unlike `threads`/`llm_dedupe`, reconnecting the same identity must overwrite the old token, not silently keep it), `deleteAccount`; reads validated via `packages/store/src/validate-row.ts`'s generic `parseValidatedJson` helper against `@hermes/google-auth`'s own schema-first `googleAccountSchema` — the same generic helper Phase 1 introduced for `Message`, pointed at a different package's schema, not a second hand-mirrored copy |
| modify | `packages/store/src/index.ts` | export `getAccount`, `upsertAccount`, `deleteAccount`, `GoogleAccountRow`-equivalent types |
| modify | `packages/store/README.md` | document `google_accounts`: keyed by `(channel, channel_user_id)`, `token_envelope` opaque to this package, the one `DO UPDATE` exception and why |
| modify | `apps/hermes/src/health.ts` | replace the strict `req.url === "/health"` compare with a `new URL(req.url, "http://localhost")`-based `pathname` switch; `/health` keeps its existing handler; `/oauth/callback` delegates to the bound (or unbound-503) OAuth callback route handler; everything else still 404s |
| create | `apps/hermes/src/google/build-oauth-callback-route.ts` | `createOauthCallbackRoute(): { handleRequest, bind(connectFlow, notify: (chatId, text) => Promise<void>) }` — the mutable-holder indirection described in Dependencies & Risks; `handleRequest` parses `code`/`state` query params, calls `connectFlow.completeConnect`, serves the minimal "you can close this tab" (success) or a generic failure page (never echoing `code`/`state`/error detail), and — on success — calls `notify(chatId, "Connected as <email>")` |
| create | `apps/hermes/src/google/build-google-oauth-client.ts` | the one place allowed to import both `@hermes/config` and `@hermes/google-auth`, per the `build-provider-profiles.ts` precedent — maps `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`OAUTH_REDIRECT_BASE_URL` into a `google-auth-library` `OAuth2Client`, and decodes `TOKEN_ENCRYPTION_KEY` into the 32-byte `Buffer` `token-crypto.ts` needs |
| create | `apps/hermes/src/store/build-google-account-repo.ts` | binds `packages/store`'s free functions to the `GoogleAccountRepo` port, matching `build-thread-repo.ts`'s 14-line shape |
| modify | `apps/hermes/src/boot.ts` | construct `oauthCallbackRoute` early (before `serveHealth`), pass its `handleRequest` into the health server's router; construct `oauthClient`/`cryptoKey`/`googleAccountRepo`/`connectFlow` and call `oauthCallbackRoute.bind(connectFlow, (chatId, text) => channel.send(chatId, text))` once `channel` exists in `wireRuntimeAndShutdown` |
| modify | `apps/hermes/package.json` | add `"@hermes/google-auth": "workspace:*"` |
| modify | `pnpm-lock.yaml` | regenerated for `google-auth-library`, the new `packages/google-auth` importer, and the new workspace dependency |
| create | `.ai/decisions/google-oauth-flow.md`, `.ai/decisions/google-token-encryption.md`, `.ai/decisions/google-auth-library-dependency.md` | per Knowledge Base Impact below |

**Steps:**

- [x] **Re-list `packages/store/src/migrations/` first** and confirm `006`
      is still the highest-numbered file before creating `007` — do not
      trust this plan's assumed number if the directory has moved on
- [x] Dispatcher argument parsing: split on the **first** whitespace only
      (so `/connect google extra text` still parses `args = "google extra
      text"` and the handler decides what to do with the rest); write the
      pinning tests before wiring new handlers in — `/stats` unchanged
      (bare command → `args === ""`), `/connect bogus` handled locally and
      never reaches `completionHandler`
- [x] PKCE: generate the verifier with enough entropy per RFC 7636 (43-128
      chars, base64url alphabet), compute the challenge as S256 — write a
      test vector check, not just "it round-trips"
- [x] **State nonce properties, tested explicitly, not assumed**: unknown
      state → `400`; expired state (past the 10-minute TTL, fake timers) →
      `400`; a state presented twice (replay) → the second attempt gets the
      same `400` the first unknown-state case gets, proving consumption is
      real and not just a read
- [x] `token-crypto.ts`: write a tamper test — flip one byte of `ct` or
      `tag` after sealing and assert `openToken` throws rather than
      returning corrupted plaintext; confirm a wrong key also throws, not
      silently decrypts to garbage
- [x] `completeConnect` never logs or returns the authorization code or the
      raw tokens anywhere — grep the implementation for `code`/`accessToken`
      appearing in any `logger.*` call or HTTP response body before
      considering this step done
- [x] The callback's success/failure HTML page: write (or manually inspect)
      it and confirm neither `code` nor `state` nor any token material
      appears in the rendered output, only a static "you can close this
      tab" (or generic failure) message
- [x] Confirm the `checkFallbackAllOrNone`-style group actually fails boot
      naming the *missing* key when exactly one or two of
      `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`TOKEN_ENCRYPTION_KEY` are
      set — test all three partial combinations, not just "all set" and
      "all unset"
- [x] `TOKEN_ENCRYPTION_KEY`'s validator: confirm it rejects a
      wrong-length or non-base64 value with a message naming the key,
      matching the existing `envSchema` convention of custom per-key
      messages
- [x] Confirm `apps/hermes/package.json` gains `"@hermes/google-auth":
      "workspace:*"` and `pnpm-lock.yaml` regenerates cleanly (`pnpm
      install` with no unexpected diff)
- [x] **CLAUDE.md's ~30-line function guidance**: `completeConnect` is the
      one function in this phase with real risk of growing past that —
      confirm it's decomposed into named helper steps (see its File-changes
      row) rather than one long function mixing pending-lookup, token
      exchange, sealing, and persistence
- [x] Author the three new `.ai/decisions/` docs per Knowledge Base Impact —
      no YAML frontmatter, first line a full-sentence decision statement,
      matching the existing 14 docs' format exactly (see
      `.ai/decisions/approval-gate-design.md` as the closest structural
      analog: a flow with named stopgaps)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-auth/src/__tests__/pkce.test.ts` | verifier meets RFC 7636 length/alphabet constraints; challenge is the correct S256 digest of the verifier |
| create | `packages/google-auth/src/__tests__/token-crypto.test.ts` | seal/open round trip preserves plaintext; a tampered ciphertext or tag throws `TokenDecryptError`; a wrong key throws; two seals of the same plaintext produce different envelopes (IV is fresh each time) |
| create | `packages/google-auth/src/__tests__/pending-connections.test.ts` | a fresh state resolves once and only once (second consume returns `undefined`); an expired entry (fake timers past the TTL) returns `undefined`; state values are not predictable from each other (basic entropy sanity, not a full statistical test) |
| create | `packages/google-auth/src/__tests__/connect-flow.test.ts` | fake `oauthClient`/`repo`/`pendingStore`: `startConnect` → `completeConnect` with the right state/code succeeds, calls `repo.upsertAccount` with a sealed envelope (never plaintext), returns the decoded email; unknown/expired/replayed state all return `{ ok: false, reason: "invalid_state" }`; a `repo.upsertAccount` failure propagates rather than being swallowed |
| create | `apps/hermes/src/__tests__/dispatcher-argument-parsing.test.ts` | `/stats` (bare) → `args === ""`; `/connect google` → `command === "/connect"`, `args === "google"`; `/connect bogus` handled locally, `completionHandler` never invoked; an unrecognized bare command still falls through to `completionHandler` unchanged (regression guard) |
| create | `apps/hermes/src/handlers/__tests__/connect.test.ts` | valid `/connect google` sends a reply containing the auth URL; `/connect anything-else` replies with usage help and never calls `connectFlow.startConnect` |
| create | `apps/hermes/src/google/__tests__/build-oauth-callback-route.test.ts` | before `bind()`, `handleRequest` returns `503`; after `bind()`, a successful `completeConnect` serves the "close this tab" page and calls `notify` with the email; a failed `completeConnect` serves a generic failure page and never calls `notify` |
| modify | `apps/hermes/src/__tests__/health.test.ts` (or create if none exists — **verify at execution time**) | `/health` still works; `/health?x=1` no longer 404s solely because of the query string; `/oauth/callback?code=...&state=...` routes to the bound handler; an unrelated path still 404s |
| create | `packages/store/src/__tests__/google-account-repo.test.ts` (test:db) | `upsertAccount` twice for the same `(channel, channel_user_id)` overwrites rather than duplicating (the one `DO UPDATE` exception); `getAccount` round-trips `token_envelope` byte-for-byte as opaque JSON; `deleteAccount` removes the row |

**Verification:**

- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm test:db` green — migration `007` applies cleanly, repo round-trips
- [x] `pnpm lint` green
- [x] `docker compose build` succeeds (catches a missing `Dockerfile` COPY line)
- [ ] Manual: `/connect google` in Telegram → tap the link → complete Google
      consent (email only) → browser shows the closing-tab page with no
      code visible in its HTML source → Telegram receives "Connected as
      `<email>`"
- [ ] Manual: `psql` → one `google_accounts` row for that `(channel,
      channel_user_id)`, `token_envelope` is unreadable JSON, `google_email`
      matches the connected account
- [ ] Manual: `/connect bogus` → local usage-help reply, no LLM call (check
      no new `llm.call` telemetry row lands for that message)

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: google OAuth connect flow, encrypted token store, oauth callback route`
- [x] Phase marked complete

**Outstanding for Phase 2 (deliberately unticked):** the three `Manual:` items need live Google credentials (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` from the Prerequisites block) and a running bot — orchestrator's to run. The handoff/`/clear` boxes do not apply: this phase was executed and reviewed in one session. Code-review verdict: **green**, no blocking findings; the one substantive nit (`created_at` preservation asserted only by inspection) was closed with a test. Commits: `7424a60` (phase).

---

### Phase 3: `/status`, `/disconnect`, and the `whoami` tool — exit criterion

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** This phase carries the plan's exit criterion. After
`/connect google`, ask the bot "who am I connected as?" (or similar) — it
calls `whoami` and answers with the real Gmail address, with a `tool.call`
telemetry row showing `approved: true` unconditionally (`whoami` is never
gated). `/status` replies with the connected email and granted scopes, or
"not connected" if none. `/disconnect` removes the row and a follow-up
`whoami` call reports not-connected rather than erroring. **Restart the
container** (`docker compose up -d --build`, per the project's own
documented restart caveat) and ask `whoami` again in the same chat — still
connected, same email, no re-consent needed.
**Commit message:** `feat: /status, /disconnect, whoami tool — Google identity exit criterion`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/agent/src/types.ts` | `ToolSpec.handler`'s `ctx` widens from `{ signal: AbortSignal }` to `{ signal: AbortSignal; channel: string; channelUserId: string }` — a public change to the tool contract, not purely additive (see Dependencies & Risks); `get_current_time`/`echo`'s handler *bodies* need no edit (they ignore the new fields), but every direct construction of a `ctx` literal must gain both |
| modify | `packages/agent/src/loop.ts` | `runTurn`'s signature gains `channelUserId: string` (it already has `channel`); both threaded into every `invokeTool` call's `ctx` |
| modify | `packages/agent/src/index.ts` | `Agent.handleMessage(channel: string, chatId: string, channelUserId: string, text: string): Promise<string>` — the interface `03-agent-core` made canonical here (per its own Phase 1.5) gains the new parameter |
| modify | `packages/agent/README.md` | document `ctx.channel`/`ctx.channelUserId` and why they exist (the first tool that needs to know who's asking), and that this is a breaking change to `ToolSpec.handler`'s contract for any future tool author |
| modify | `apps/hermes/src/agent/tools/__tests__/get-current-time.test.ts` | its direct `getCurrentTimeTool.handler({}, { signal: ... })` call (line 17) gains `channel: "telegram", channelUserId: "123"` on the ctx literal — required for `pnpm -r typecheck`, not a behavior change |
| modify | `apps/hermes/src/agent/tools/__tests__/echo.test.ts` | same fix to its direct `echoTool.handler(..., { signal: ... })` call (lines 17-19) |
| modify | `apps/hermes/src/handlers/complete.ts` | `replyWithCompletion` passes the inbound message's sender id through to `agent.handleMessage` instead of dropping it |
| modify | `apps/hermes/src/handlers/__tests__/complete.test.ts` | assert `channelUserId` reaches `agent.handleMessage` unchanged |
| create | `apps/hermes/src/handlers/disconnect.ts` | `createDisconnectHandler`: parse no arguments, call `googleAccountRepo.deleteAccount(channel, channelUserId)`, reply confirming disconnection (idempotent — disconnecting an already-disconnected account replies the same way, no error) |
| create | `apps/hermes/src/handlers/status.ts` | `createStatusHandler`: reads the account via `googleAccountRepo.getAccount`; connected → "Connected as `<email>`, scopes: `<scopes>`"; not connected → "Not connected. Run /connect google to connect."; no LLM call either way (mirrors `stats.ts`'s thin shape) |
| create | `apps/hermes/src/agent/tools/whoami.ts` | `ToolSpec`: `name: "whoami"`, `description`: identity check, no arguments; `schema: z.object({})`; `handler: async (_args, ctx) => { const account = await googleAccountRepo.getAccount(ctx.channel, ctx.channelUserId); if (!account) return { ok: false, reason: "not_connected" }; if (!hasRequiredScopes(account.scopes, IDENTITY_SCOPES)) return { ok: false, reason: "missing_scope", scope: IDENTITY_SCOPES.join(" ") }; return { ok: true, email: account.googleEmail }; }`; `requiresApproval: false` (settled decision 3 — a pure, idempotent read of the identity granted at the consent moment, not a consequence). The `hasRequiredScopes` check is a **real, executed check, not a hollow always-true assertion** — every connected account requests `IDENTITY_SCOPES` unconditionally today so this branch is unreachable in practice this phase, but it's the exact pattern D11 establishes for later phases' partial-consent tools, and leaving it out of `whoami` would mean the pattern's first real usage ships untested against a genuine (if currently unreachable) branch. Uses `ctx.channel` — no import from `build-agent.ts` |
| modify | `apps/hermes/src/agent/build-agent.ts` | `AgentDefinition.tools` gains `[getCurrentTimeTool, echoTool, whoamiTool]`; `whoamiTool` is constructed here with the bound `googleAccountRepo` closed over, matching the `get_current_time`/`echo` construction pattern |
| modify | `apps/hermes/src/boot.ts` | `dispatchCommand` gains `/status`/`/disconnect` matching (argument-aware, from Phase 2's dispatcher change); `createMessageHandlers` wires `statusHandler`/`disconnectHandler` |
| modify | `.ai/decisions/google-oauth-flow.md` | (if not already covered in Phase 2's authoring) confirm it documents settled decision 3's reasoning: mutations/outbound sends gate, pure reads within an already-consented scope do not — `whoami` is the worked example |
| modify | `apps/hermes/README.md` | document `/status`, `/disconnect`, and `whoami`'s ungated status and why |

**Steps:**

- [x] Thread `channel`/`channelUserId` through `runTurn`/`converse`/`invokeTool`
      — **this is a required-field widening of `ToolSpec.handler`'s `ctx`,
      not a purely additive change**: `pnpm -r typecheck` will fail on the
      two direct-invocation test call sites
      (`get-current-time.test.ts:17`, `echo.test.ts:17-19`) until their
      literal `ctx` objects gain both fields — fix those two files as part
      of this step, don't treat a red typecheck here as a surprise to debug
      later
- [x] `whoami`'s not-connected path returns a **structured** result
      (`{ ok: false, reason: "not_connected" }`), not a thrown error — the
      model relays it as "you're not connected, try /connect google,"
      consistent with settled decision 11's shape for the missing-scope
      case later phases will add
- [x] Write the fail-fast-construction analog check for `whoami`: confirm
      `createAgent`'s `assertApprovalGateConfigured` (from `03-agent-core`)
      does **not** fire for `whoami`, since `requiresApproval: false` — a
      quick assertion, not a new mechanism
- [x] `/disconnect` idempotency: calling it twice in a row produces the same
      reply both times, no error on the second call even though
      `deleteAccount` affects zero rows
- [x] `/status`'s scope list formatting: confirm it reads `scopes` from the
      stored row (an array), not from the scope registry — the row is the
      source of truth for what was actually granted, the registry is only
      what a tool *requires*
- [x] Manual verification for the exit criterion specifically requires
      `docker compose up -d --build`, **not** `docker compose restart`
      (per `architecture.md`'s documented trap: restart replays the
      existing image and does not re-read `.env` or rebuilt code) — state
      this explicitly in the Verification checklist below so it isn't
      silently satisfied by the weaker command

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `apps/hermes/src/agent/tools/__tests__/whoami.test.ts` | connected account with the identity scope → `{ ok: true, email }`; no account → `{ ok: false, reason: "not_connected" }`; an account row missing the identity scope (constructed directly in the test — not reachable via `/connect` today, but the handler's branch must still be provably correct) → `{ ok: false, reason: "missing_scope", scope }`; uses `ctx.channel`/`ctx.channelUserId`, not any hardcoded constant |
| modify | `apps/hermes/src/agent/tools/__tests__/get-current-time.test.ts` | direct handler-invocation ctx literal gains `channel`/`channelUserId`, compiles and passes unchanged otherwise |
| modify | `apps/hermes/src/agent/tools/__tests__/echo.test.ts` | same fix |
| create | `apps/hermes/src/handlers/__tests__/status.test.ts` | connected → reply includes email and scopes; not connected → reply says so; no LLM call in either branch |
| create | `apps/hermes/src/handlers/__tests__/disconnect.test.ts` | removes an existing account; calling twice is idempotent, no throw |
| modify | `apps/hermes/src/agent/__tests__/build-agent.test.ts` | `tools` now includes `whoamiTool`; assert its presence doesn't change the byte-stable-prefix determinism test's shape (still deterministic with three tools) |
| modify | `packages/agent/src/__tests__/loop.test.ts` | a tool handler receives `ctx.channelUserId` matching what `runTurn` was called with |

**Verification:**

- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm test:db` green
- [x] `pnpm lint` green
- [ ] Manual: `/connect google` → ask "who am I connected as?" → real email
      in the reply; `psql` shows a `tool.call` row, `tool_name = 'whoami'`,
      `approved = true`
- [ ] Manual: `/status` → shows connected email + scopes
- [ ] Manual: `/disconnect` → confirmation; `/status` immediately after →
      "not connected"; `whoami` immediately after → model relays
      "not connected, run /connect google"
- [ ] Manual: `/connect google` again, then `docker compose up -d --build`
      (not `restart` — see Steps), then ask `whoami` in the same chat →
      still connected, same email, no re-consent prompt — **this is the
      plan's exit criterion**

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: /status, /disconnect, whoami tool — Google identity exit criterion`
- [x] Phase marked complete

**Outstanding for Phase 3 (deliberately unticked):** the four `Manual:` items — including the plan's **exit criterion** (`/connect google` → `whoami` → `docker compose up -d --build` → still connected) — need live Google credentials and a running bot, so they are the orchestrator's to run. The handoff/`/clear` boxes do not apply: executed and reviewed in one session. Code-review verdict: **green**, no blocking findings. The reviewer traced the full `channel`/`channelUserId` parameter chain across all 25 updated call sites and confirmed no transposition with `chatId`/`userText`. Sole nit (three separate `buildGoogleAccountRepo(pool)` calls) judged not worth changing — pure closure factory over the shared pool, matching `buildThreadRepo` precedent. Commit: `36467c1`.

---

### Phase 4: Automatic refresh, single-flight, proactive alert

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** Force a connected account's token to look expired
(`psql`: `UPDATE google_accounts SET expires_at = now() - interval '1 hour'`),
restart the container, and observe (`psql`) that the row's `expires_at` and
`token_envelope` were refreshed automatically within one sweep pass — no
`/connect` needed. Force a refresh failure (`psql`: corrupt the envelope, or
manually revoke access via Google's account permissions page) and observe a
proactive Telegram message in the original connecting chat saying the
Google connection needs to be re-established, and `/status` afterward shows
"not connected."
**Commit message:** `feat: proactive token refresh sweep, single-flight coordinator, refresh-failure alert`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/google-auth/src/refresh.ts` | `createRefreshCoordinator(deps: { oauthClient, cryptoKey })` exposes **one public entry point**: `getValidAccessToken(account: GoogleAccount): Promise<{ accessToken: string; account: GoogleAccount }>` — if `account.expiresAt.getTime() - clock.now() < REFRESH_SKEW_MS`, refreshes (decrypts the refresh token, calls `oauthClient`'s refresh, reseals, returns the updated account — does not persist, caller's job) through a single-flight `Map<accountKey, Promise<...>>` keyed on `(channel, channelUserId)`, entry deleted in a `finally`; otherwise decrypts and returns the cached access token unchanged. This is **the single seam both the sweep and any future request-path tool call go through** — neither Phase 4 nor a later phase needs a second refresh code path. Throws a typed `RefreshFailedError` distinguishing `invalid_grant`/revoked from a transient network failure (only the former marks disconnected). `REFRESH_SKEW_MS` (10 minutes) is exported so `listAccountsExpiringBefore`'s cutoff and this function's staleness check are computed from the same constant, never two independently-tuned numbers |
| modify | `packages/google-auth/src/index.ts` | export `createRefreshCoordinator`, `RefreshFailedError`, `REFRESH_SKEW_MS` |
| modify | `packages/google-auth/README.md` | document the single-seam design: `getValidAccessToken` is called by the boot-owned sweep this phase and will be called lazily by any future request-path tool with no design change; the constraint that refresh must never be reachable outside `boot()` |
| modify | `packages/store/src/google-account-repo.ts` | add `listAccountsExpiringBefore(pool, cutoff: Date): Promise<GoogleAccount[]>` (uses the new `expires_at` index from migration `007`), `markDisconnected(pool, channel, channelUserId): Promise<void>` (same as `deleteAccount`, or a soft-disconnect — **verify at execution time**: settled decision 16 says "marks the account disconnected," this plan treats that as removing the row, consistent with `/disconnect`'s own behavior, so a subsequent `whoami` gets the same "not connected" path with no new state to reason about) |
| modify | `packages/store/src/index.ts` | export the two new functions |
| create | `apps/hermes/src/google/refresh-sweep.ts` | `createRefreshSweep(deps: { repo, coordinator, channel, clock, logger })`: `runOnce(): Promise<void>` — lists accounts via `listAccountsExpiringBefore(clock.now() + REFRESH_SKEW_MS)`, calls `coordinator.getValidAccessToken(account)` for each (the same seam a future tool call would use — the sweep does not call a separate "force refresh" function), persists a changed account via `repo.upsertAccount`, on `RefreshFailedError` with `reason: "invalid_grant"` calls `repo.markDisconnected` then `channel.send(account.chatId, ...)` with a plain-language "reconnect" message, on a transient failure logs and leaves the row alone for the next tick; a boot with zero connected accounts is a no-op, not an error; `start(intervalMs, signal): void` / `stop(): Promise<void>` — runs `runOnce` immediately, then on `REFRESH_SWEEP_INTERVAL_MS` (5 minutes — deliberately half of `REFRESH_SKEW_MS`, so one missed/slow tick still leaves a full interval of buffer before an actual token expiry), stops cleanly on `signal` abort |
| modify | `apps/hermes/src/boot.ts` | construct the refresh sweep once `channel`/`googleAccountRepo`/refresh coordinator all exist in `wireRuntimeAndShutdown` — **confirmed by `boot()`'s documented step order (`architecture.md`) to run strictly after `acquireInstanceLockOrExit`**, so the sweep's first tick cannot execute before the advisory lock is held; call `runOnce()` once immediately (this is what makes "survives a restart" true without waiting out the interval) then `start(REFRESH_SWEEP_INTERVAL_MS, controller.signal)`; add `sweep.stop()` to the shutdown sequence, bounded the same way `channel.stop()`/`telemetryRecorder.stop()` are |
| modify | `apps/hermes/README.md` | document the sweep: runs once at boot, then on an interval; single-flight; refresh failure disconnects + alerts |
| modify | `.ai/decisions/google-oauth-flow.md` or a new `.ai/decisions/google-token-refresh.md` | record the sweep design and its dependency on the single-instance advisory lock (settled decision 16) |

**Steps:**

- [x] **Single-flight test must prove actual sharing, not just "both
      succeeded"**: two concurrent `getValidAccessToken` calls for the same
      stale account must be provably backed by the *same* refresh (e.g., a
      fake `oauthClient.refreshToken` that counts invocations — assert it's
      called exactly once for two concurrent callers), matching the rigor
      `03-agent-core` applied to its own parallel-tool-execution proof
- [x] Confirm `getValidAccessToken`'s skew check is real: an account whose
      `expiresAt` is well outside `REFRESH_SKEW_MS` returns the cached token
      **without** calling `oauthClient.refreshToken` at all — write a test
      asserting zero refresh calls for a fresh token, not just "the right
      token came back"
- [x] Confirm the `finally`-deletion means a failed refresh doesn't poison a
      later, independent attempt — test: first `getValidAccessToken` call
      rejects, a later call (not concurrent, after the first settles) is
      allowed to try again, not permanently blocked
- [x] Confirm `REFRESH_SKEW_MS` is the *only* place "how close to expiry
      counts as needs-refresh" is defined — `listAccountsExpiringBefore`'s
      cutoff in `refresh-sweep.ts` must import and reuse it, not hardcode
      its own duration
- [x] `runOnce`'s failure classification: a `RefreshFailedError` with
      `invalid_grant`/revoked marks disconnected and alerts; anything else
      (network timeout, 500) leaves the row untouched for the next tick —
      write a test asserting a transient failure does **not** delete the
      account or send an alert
- [x] Confirm the sweep is wired **only** inside `boot()`'s construction
      path — no standalone script or bin entry is added for it, per the
      constraint this plan states in Dependencies & Risks; confirm by
      inspection that its construction site in `wireRuntimeAndShutdown` is
      reached only after `acquireInstanceLockOrExit` in `boot()`'s call
      order, not merely assumed
- [x] `sweep.stop()`'s shutdown budget: confirm it fits inside the existing
      8s hard-exit ceiling alongside `channel.stop()` (5s) and
      `telemetryRecorder.stop()` (1s) — size its own bound accordingly and
      say so explicitly if it needs a slice of that budget
- [x] Manual verification: forcing `expires_at` into the past via `psql` is
      the only practical way to exercise this without waiting out a real
      Google access-token lifetime (~1 hour) — state this in Verification
      rather than leaving it to be rediscovered

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-auth/src/__tests__/refresh.test.ts` | `getValidAccessToken` on a fresh (not-near-expiry) account returns the cached token and calls `oauthClient.refreshToken` zero times; on a stale account, single-flight — two concurrent calls for the same account share one underlying refresh call; a failed refresh doesn't poison a later independent attempt; a successful refresh reseals with a fresh IV |
| create | `apps/hermes/src/google/__tests__/refresh-sweep.test.ts` | `runOnce` refreshes only accounts `listAccountsExpiringBefore` returns (cutoff derived from `REFRESH_SKEW_MS`), calling `coordinator.getValidAccessToken` for each — not a separate force-refresh path; a successful refresh persists via `repo.upsertAccount`; an `invalid_grant` failure calls `markDisconnected` and `channel.send` with the alert; a transient failure touches neither; zero connected accounts is a no-op; `start`/`stop` run `runOnce` immediately then on the interval, and stop cleanly on an aborted signal (fake timers) |
| modify | `packages/store/src/__tests__/google-account-repo.test.ts` (test:db) | `listAccountsExpiringBefore` returns only accounts under the cutoff; `markDisconnected` removes the row |

**Verification:**

- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm test:db` green
- [x] `pnpm lint` green
- [ ] Manual: `psql` force-expire a connected account's `expires_at`,
      `docker compose up -d --build`, wait for the immediate boot-time sweep
      pass, `psql` → `expires_at` and `token_envelope` have changed, no
      Telegram message was sent (this was a success, not a failure)
- [ ] Manual: force a refresh failure (revoke the app's access from
      Google's account permissions page, or corrupt the stored envelope so
      decryption fails at refresh time), wait for the next sweep tick →
      Telegram receives the reconnect alert in the original chat; `/status`
      afterward shows not connected

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: proactive token refresh sweep, single-flight coordinator, refresh-failure alert`
- [x] Phase marked complete

**Outstanding for Phase 4 (deliberately unticked):** the two `Manual:` items need live Google credentials and a running bot. The handoff/`/clear` boxes do not apply: executed and reviewed in one session. Code-review verdict: **green**, no blocking findings; the reviewer confirmed against `google-auth-library@9.15.1` source that an *unrecognized* refresh error falls to log-only and leaves the row intact — only an explicit `invalid_grant` disconnects, so a transient blip cannot delete a valid credential.

**Deferred, recorded, not blocking merge:** `oauth-client.ts`'s `refreshAccessToken` still reaches around `OAuth2Client`'s **protected** `refreshToken()` via a cast. The race it avoids is real (the public methods read and write the shared client's `credentials`), but a public-API alternative exists — a throwaway `OAuth2Client` per refresh, whose constructor does no I/O. It was not adopted because `refresh.test.ts`'s `fakeOAuthClient` mocks the protected method directly, so the swap needs a client-factory injection seam rather than a behavior change. That is test coupling dictating production design, not a correctness argument — worth revisiting, and worth watching on any `google-auth-library` upgrade, since a `protected` member can be renamed without a semver signal. Recorded in `.ai/decisions/google-token-refresh.md`. Commits: `482f3bd` (phase), `de99666` (review nits).

---

### Phase 5: Final Verification

**Mode:** hil

**Type:** mixed

**Overall success criteria:**

- The plan's exit criterion holds end to end: `/connect google` in
  Telegram, then a `whoami` tool call returns the real Gmail address, and
  that connection survives `docker compose up -d --build`.
- `/status` and `/disconnect` both work correctly and idempotently.
- Automatic refresh works without operator intervention (proven via the
  forced-expiry manual check) and a genuine refresh failure produces a
  proactive Telegram alert, never a silent, repeating failure.
- No credential — code, access token, refresh token — ever appears in a
  Telegram message, a log line, or the OAuth callback's HTML response.
  `token_envelope` in Postgres is opaque ciphertext, confirmed by
  inspection.
- The state-nonce + PKCE authorization on `/oauth/callback` genuinely
  rejects unknown, expired, and replayed states — confirmed by the Phase 2
  tests, re-verified by manual inspection of at least one rejected attempt.
- `packages/google-auth` depends only on `@hermes/core`, `google-auth-library`,
  `zod` — never `@hermes/store` or any `apps/hermes` feature module —
  confirmed by inspection, not assumption.
- `packages/agent`'s dependency boundary from `03-agent-core` still holds:
  only `@hermes/core`, `@hermes/llm`, `zod` — the new `channel`/`channelUserId`
  threading did not introduce a `@hermes/google-auth` or `@hermes/store`
  import into `packages/agent`.
- `packages/core`'s new `zod` dependency is the **only** dependency change
  to `core` this plan makes — confirmed by inspection that `core` still
  imports no other `@hermes/*` package, and that the `Message` schema-first
  conversion changed no consuming package's source (`packages/llm`,
  `packages/agent`) beyond picking up the same types transparently.
- Thread history correctly carries tool-call/tool-result pairs across
  turns and restarts, and a corrupted row is rejected on read rather than
  silently replayed — Phase 1's fix, re-confirmed here now that a real
  tool (`whoami`) exercises it in practice, not just in a throwaway-tool
  test.
- No CLAUDE.md invariant is violated: functions stay near the ~30-line
  guidance, no dead code, comments explain *why* not *what*, the dependency
  policy's written justification exists for `google-auth-library`.

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block, scoped to end-to-end review of Phases 1–4 together
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review reflected back into this plan file
- [ ] `pnpm lint` — zero errors (named explicitly: `03-agent-core` shipped a
      phase with this red because nothing named it until review caught it)
- [ ] `pnpm -r test` green
- [ ] `pnpm -r typecheck` green
- [ ] `pnpm test:db` green
- [ ] No CLAUDE.md invariants violated
- [ ] Feature tested manually end to end: golden path (`/connect` → consent
      → confirmation → `whoami` → restart → still connected → `/status` →
      `/disconnect` → reconnect), plus edge cases (unknown/expired/replayed
      OAuth state, malformed thread row rejected on read, forced token
      expiry refreshed automatically, forced refresh failure alerts and
      disconnects, `/connect bogus` handled locally with no paid call)
- [ ] Overall success criteria met
- [ ] `sync-knowledge` run to close out `.ai/` per the Knowledge Base Impact
      table below
- [ ] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| Full tool-call history persisted; group-aware trim; `approvalWaitMs`/`durationMs` split | `packages/agent/README.md` |
| `Message` becomes schema-first (zod, `z.infer`); `core` gains its one dependency | `packages/core/README.md` |
| Runtime validation on `threads.messages` read | `packages/store/README.md` |
| New `google_accounts` table, keying, opaque envelope, one `DO UPDATE` exception | `packages/store/README.md` |
| Four new env vars, all-or-none group, key-format validator | `packages/config/README.md`, `.env.example` |
| OAuth flow shape, PKCE + state authorization, scope registry, token crypto | `packages/google-auth/README.md` (new) |
| `/connect`, `/status`, `/disconnect`, `whoami`, dispatcher argument parsing | `apps/hermes/README.md` |
| `/oauth/callback` route, path/query-aware health server | `apps/hermes/README.md` |
| Refresh sweep design, single-flight, failure-alert behavior | `packages/google-auth/README.md`, `apps/hermes/README.md` |
| `ctx.channel`/`ctx.channelUserId` on `ToolSpec.handler` (breaking contract change) | `packages/agent/README.md` |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `index.md` | update | new `@hermes/google-auth` row; edit the "google-*, scheduler, ingress are deliberately absent" line to drop `google-*`; `@hermes/config` row gains a link to the new decisions; Cross-cutting table gains rows for token storage/encryption and the OAuth callback inbound surface; the existing Inbound authorization row is amended — the callback path is a *second* non-allowlist-gated inbound surface, defended by state+PKCE rather than the allowlist |
| `architecture.md` | update | `packages/google-auth` added to the System shape ASCII list and the Dependency direction diagram, following the injected-repo-port precedent (`GoogleAccountRepo` declared in `google-auth`, bound in `apps/hermes/src/store/build-google-account-repo.ts`); Data flow gains the `/connect` command path and the loopback-callback path; Boot and shutdown order re-narrated for the OAuth callback route indirection and the refresh sweep's start/stop. **Also**: the line "`packages/core` depends on nothing" (`architecture.md:43`) is amended to "`packages/core` depends on no other `@hermes/*` package" with a new sentence explaining the one exception — `zod`, adopted so `Message` can be schema-first and eliminate the hand-sync drift risk a mirrored validation schema in `packages/store` would carry — and noting the reasoning for the zero-*internal*-dependency posture (no coupling to another package's implementation) is unaffected by a leaf third-party library already used by `packages/agent`/`packages/config` |
| `index.md` — `@hermes/core` row | update | "zero deps" in the one-line responsibility description is corrected to "zero deps on other `@hermes/*` packages (plus `zod`, for schema-first `Message`)" |
| `decisions/google-oauth-flow.md` | create | loopback redirect + Web application client type, PKCE + state nonce authorization, in-memory pending connections mirroring the approval gate's own tradeoff, incremental consent via the scope registry, why the agent never sees a credential |
| `decisions/google-token-encryption.md` | create | AES-256-GCM envelope shape and versioning, key lifecycle (generation, storage, manual rotation), why the schema fails boot rather than failing at first write |
| `decisions/google-token-refresh.md` | create | the single-seam `getValidAccessToken` design — both the boot-owned sweep and any future request-path tool call go through it, so this phase's design doesn't need replacing when a real Google API tool ships; single-flight coordinator and the shared `REFRESH_SKEW_MS` constant; its dependency on the single-instance advisory lock; the "never reachable outside boot()" constraint |
| `decisions/google-auth-library-dependency.md` | create | the written justification CLAUDE.md requires even for a ROADMAP-pre-approved dependency: load-bearing + low-risk, narrow usage, rejected alternatives (`googleapis`, `express`) |
| `decisions/telemetry-event-schema.md` | update | close the `duration_ms`-measures-approval-wait open item: `ToolCallEvent` now carries `approvalWaitMs` separately: `durationMs` is handler time only |
| `decisions/d3-monorepo-package-per-concern.md` | update | cite `packages/google-auth` as the next example of "created at its phase, never merge-then-split" |
| `decisions/approval-gate-design.md` | update | note settled decision 3's policy explicitly: mutations/outbound sends gate, pure reads within an already-consented scope do not — `whoami` is the first tool proving the distinction in practice |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | full conversation tail persisted, wire order preserved | `packages/agent/src/__tests__/loop.test.ts` |
| Phase 1 | `approvalWaitMs`/`durationMs` split | `packages/agent/src/__tests__/loop.test.ts` |
| Phase 1 | group-aware trim, tool-call-aware sizing | `packages/agent/src/__tests__/context-trim.test.ts` |
| Phase 1 | `Message` union schema-first validation (`z.infer`-derived types) | `packages/core/src/__tests__/llm-types.test.ts` |
| Phase 1 | corrupted thread row rejected on read | `packages/store/src/__tests__/thread-repo.test.ts` |
| Phase 2 | PKCE generation correctness | `packages/google-auth/src/__tests__/pkce.test.ts` |
| Phase 2 | AES-256-GCM seal/open, tamper/wrong-key rejection | `packages/google-auth/src/__tests__/token-crypto.test.ts` |
| Phase 2 | pending-connection state: consume-once, TTL expiry | `packages/google-auth/src/__tests__/pending-connections.test.ts` |
| Phase 2 | connect flow: success, invalid/expired/replayed state | `packages/google-auth/src/__tests__/connect-flow.test.ts` |
| Phase 2 | dispatcher argument parsing, `/connect bogus` local handling | `apps/hermes/src/__tests__/dispatcher-argument-parsing.test.ts` |
| Phase 2 | `/connect` handler | `apps/hermes/src/handlers/__tests__/connect.test.ts` |
| Phase 2 | OAuth callback route: unbound 503, success/failure pages, notify | `apps/hermes/src/google/__tests__/build-oauth-callback-route.test.ts` |
| Phase 2 | path/query-aware health server routing | `apps/hermes/src/__tests__/health.test.ts` |
| Phase 2 | `google_accounts` upsert-overwrites, opaque envelope round trip | `packages/store/src/__tests__/google-account-repo.test.ts` |
| Phase 3 | `whoami` handler: connected/not-connected | `apps/hermes/src/agent/tools/__tests__/whoami.test.ts` |
| Phase 3 | `/status`, `/disconnect` handlers | `apps/hermes/src/handlers/__tests__/status.test.ts`, `disconnect.test.ts` |
| Phase 3 | `ctx.channelUserId` threading through the loop | `packages/agent/src/__tests__/loop.test.ts` |
| Phase 4 | single-flight refresh coordinator | `packages/google-auth/src/__tests__/refresh.test.ts` |
| Phase 4 | refresh sweep: success, invalid_grant disconnect+alert, transient no-op | `apps/hermes/src/google/__tests__/refresh-sweep.test.ts` |
| Phase 4 | `listAccountsExpiringBefore`, `markDisconnected` | `packages/store/src/__tests__/google-account-repo.test.ts` |

## Human Summary

This plan gives Hermes a Google identity — the foundation every real
Google-backed capability (Gmail, Calendar, Sheets) needs before any of them
can exist, but this plan itself adds no such capability. It starts by
paying down two things `03-agent-core` deliberately left unfinished: the
turn loop was only ever saving a fake, flattened version of what happened
in a conversation (never the actual tool calls or their results), and
nothing checked that what came back out of the database was shaped the way
the code assumed — both harmless while the only tools were throwaways, both
false the moment a real tool exists. With that fixed, the plan builds the
OAuth piece: `/connect google` in Telegram sends a link, the link goes
through Google's consent screen asking only for the account's email
identity, and the browser lands back on a page that shows nothing sensitive
and tells you to close the tab — the actual confirmation arrives back in
Telegram instead. Everything about that round trip is designed so a
guessed or replayed link can't complete someone else's connection, and so
the AI model itself never sees the authorization code, the token, or
anything it could leak. The token that results is encrypted at rest with a
key the operator generates once and never checked into anything git
tracks. The plan's exit criterion — `/connect google`, then a `whoami` tool
that answers with your real Gmail address, and that connection still
working after the container restarts — is what Phase 3 delivers, and it's
deliberately the only real capability this plan ships: `whoami` proves the
whole pipe works without needing to touch a single real Google API. The
last piece makes the connection maintain itself: a background check that
runs once at boot and then on a schedule, refreshing a token before it
expires so nothing ever silently breaks, and — if Google ever actually
revokes access — sending an unprompted Telegram message saying so instead
of leaving the bot quietly broken. Real Google capabilities — reading
email, checking a calendar, editing a sheet — are deliberately the next
plan, not this one.
