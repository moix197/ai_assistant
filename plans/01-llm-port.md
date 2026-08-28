# Plan: LLM Port (Roadmap Phase 2a)

**Created:** 2026-08-26
**Branch:** `feat/01-llm-port`
**Status:** Phases 1–6 complete. Phase 6 closed with its exceptions recorded in its execution notes: `pnpm test:live` fails on Gemini free-tier quota, the two container-level shutdown checks were not run, the repo has no CI, and two over-length functions are carried to follow-up. Four boxes stay unticked because that work did not happen.

## Context

Hermes today (Phases 0–1, `plans/00-skeleton.md`) is a restart-safe, single-instance
Telegram echo bot with no AI behind it: `apps/hermes`, `packages/core`,
`packages/config`, `packages/store`, `packages/channels`. This PRD implements
Roadmap **Phase 2a only** — `packages/llm`: the provider port, one
OpenAI-compatible adapter over `fetch`, retries/backoff/timeout/typed errors,
usage accounting with cache-hit tokens split out, a monthly budget ceiling, and
primary+fallback provider profiles validated at boot (ROADMAP §5, §8 PRD list:
`plans/01-llm-port.md` = "Phase 2a — provider port, adapter, budget ceiling").

**Explicitly out of scope, owned by later PRDs:**
- `packages/telemetry` (recorder implementation, cost rollups, `/stats`) —
  `plans/02-telemetry.md`, Phase 2b. This PRD does not widen the
  `TelemetryRecorder` port in `core` at all.
- `packages/agent` (tool registry, the bounded agentic loop, approval gate,
  prompt assembly, compaction, tiered routing) — `plans/03-agent-core.md`,
  Phase 2c. The blocking-approval-gate test belongs there, not here. This PRD
  ships a **thin single-shot completion handler** (one LLM call per Telegram
  message, no tool loop) as 2a's proof of life, replacing the Phase-1 echo
  fallthrough — not the bounded tool-calling loop.
- Any provider registry, capability negotiation, or automatic failover
  (ROADMAP §2.1, D5). Failover in 2a is manual: edit env vars, restart.

**Packages created here**, per the "create at its phase, never merge-then-split"
rule (ROADMAP §3 / D3): `packages/llm` only. `packages/telemetry` and
`packages/agent` remain deliberately absent — do not scaffold them.

**Packages modified here:** `packages/core` (provider-neutral `Message` /
`ToolCall` / `ToolResult` / `Usage` types; promoted `nextDelay` backoff helper),
`packages/config` (new `LLM_*` env keys + provider-profile validation),
`packages/store` (new `llm_usage` and `llm_dedupe` migrations + repos),
`packages/channels` (widen `InboundMessage` to carry a stable dedupe key;
consume the promoted `nextDelay` from `core` instead of a local copy),
`apps/hermes` (boot wiring, the new completion handler, shutdown `AbortSignal`
threading).

## Risk: high

Three correctness-critical properties live in this PRD, all with a real dollar
cost attached to getting them wrong. First, the budget ceiling is the
project's only automated defense against a runaway bill (ROADMAP §7: "Token
cost runs away" is the project's main financial risk) — a bug here means
Hermes keeps spending after the operator told it to stop. Second, dedupe
(invariant #4) now guards a **paid** action for the first time in the
codebase; the Phase-1 echo handler's "safe by inspection" reasoning explicitly
does not extend to a handler that calls a paid API, and this PRD is the one
that must close that gap with a real, DB-enforced test — not another
by-inspection note. Third, invariant #6 (cache-stable prompt ordering) is the
single highest-leverage cost lever in the whole roadmap (~10× on the DeepSeek
bill) and is unfalsifiable by inspection — it can only be verified against
real cache-hit token counts reported by a live provider, which is why this PRD
introduces a live, real-money test lane. Getting any of the three wrong is a
silent-until-the-invoice-arrives failure mode, not a crash.

## Dependencies & Risks

- **External dependency: DeepSeek and Gemini API keys.** Phase 2 (the §8
  tool-calling check) and Phase 3 (the cache-hit-token proof) cannot be
  verified without live credentials for both. See `## Prerequisites` below.
- **Ordering tension: dedupe ships in Phase 5, not Phase 1.** Phases 1–4 stand
  up a real, paid LLM call path (proof-of-life handler, the §8 check, usage
  accounting, the budget ceiling) before the dedupe key exists. A
  crash-and-redeliver of the same Telegram update in that window can trigger a
  second paid completion — invariant #4 is violated between Phases 1 and 5.
  **Accepted for this phase ordering**, for three reasons: (1) this window
  only exists during Hermes's own development/staging use, at the low message
  volumes ROADMAP's "free-tier development discipline" already assumes — not
  production traffic; (2) the vertical-slice value of proving the env-swap
  exit criterion and the cache-hit invariant early, against a real adapter,
  outweighs a bounded, low-probability, low-dollar double-charge risk during
  development; (3) restructuring to put dedupe first would mean building the
  dedupe/Postgres machinery (Phase 5) before there is any paid call for it to
  guard, which is itself a horizontal-layering violation (infrastructure with
  nothing to protect yet) — the plan-sequential format explicitly rejects
  building layers ahead of a feature that needs them. Phase 5 closes the
  exact-duplicate-delivery half of this gap deterministically (DB-enforced
  test); it deliberately does **not** close the narrower claim-to-complete
  crash window, which is a separate, smaller, explicitly accepted residual
  risk documented in Phase 5's Steps — until Phase 5 lands, keep
  `LLM_MONTHLY_BUDGET_USD` set low during manual testing of Phases 1–4 as a
  second line of defense.
- **Known risk, contained: Gemini's OpenAI-compatibility layer may prove
  quirky on tool calling** (ROADMAP §2.1, D5). Phase 2's §8 check runs the
  5-tool prompt **10 sequential trials per provider** (bounded, free-tier-safe)
  and computes two rates per provider: malformed-JSON rate (trials where the
  tool-call arguments fail to parse against their JSON Schema) and tool-pick
  accuracy (trials where the model chose the fixture's expected tool).
  **Concrete numeric trigger** — the native-adapter contingency fires if and
  only if, on that 10-trial run: Gemini's malformed-JSON rate is **≥ 20%** (2
  or more of 10) **or** Gemini's tool-pick accuracy is **≤ 70%** (7 or fewer
  of 10 correct), **and** DeepSeek's numbers on the same run do not show the
  same problem (DeepSeek malformed-JSON rate `< 10%` and accuracy `≥ 90%`) —
  the second clause exists so a fixture-quality problem that degrades both
  providers equally is not mistaken for a Gemini-specific regression. If
  triggered, Phase 2 adds a small native Gemini adapter behind the same
  `LlmProvider` port, wired only for the Gemini profile, as a contained
  follow-up task **within Phase 2**, not a redesign — see Phase 2's Steps for
  the pre-made scope of that fix. If the trigger condition is not met, no
  native adapter is built; the OpenAI-compatible adapter serves both profiles
  and D5 states the check passed cleanly.
- **Order-sensitive: budget check before the provider call, dedupe claim
  before the provider call.** Both gates in the completion path must run
  *before* `LlmProvider.complete()` is invoked, or they don't actually prevent
  the spend they exist to prevent. Phase 4 and Phase 5 both depend on this
  ordering; get it backwards and the ceiling/dedupe key only records the spend
  after the fact, uselessly.
- **Shutdown drain timing unchanged, correctness moved to dedupe.** Per
  `skeleton-shape-and-dedupe.md` Part B.7, an agent turn will often exceed the
  5s `DRAIN_TIMEOUT_MS`. This PRD threads an `AbortSignal` into the adapter's
  `fetch` call so a draining turn aborts promptly instead of being orphaned by
  `pool.end()`, but does **not** change `DRAIN_TIMEOUT_MS`/`HARD_EXIT_TIMEOUT_MS`
  — correctness on an aborted-then-redelivered turn comes from the dedupe key
  short-circuiting the replay, not from the abort itself. See Phase 5.
- **No dependency on `packages/telemetry` / `packages/agent`.** Nothing here
  imports or stubs either; they don't exist yet. The `TelemetryRecorder` port
  in `core` is untouched — widening it is 02-telemetry's job.
- **Pricing table staleness accepted, not solved here.** `packages/llm`'s
  price constant is a versioned snapshot with an "as of" date, per ROADMAP
  §2.1's "verify at signup — these move constantly" caveat. Keeping it current
  is an operational task, not something this PRD automates.
- **Reasoning models return zero-content 200s, and the adapter currently calls
  that malformed.** *(Discovered live during Phase 1 verification, against
  `gemini-3.6-flash`.)* A budget-truncated reasoning model answers HTTP 200
  with `finish_reason: "length"`, `completion_tokens: 0`, and **no `content`
  field at all** — the model spent the whole output budget thinking and emitted
  nothing. Phase 1's malformed-response rule treats a missing `text` as
  `LlmMalformedResponseError`, which is right for a genuinely broken body but
  wrong here: this is a legitimate truncation the caller should be able to
  distinguish and handle. `MAX_TOKENS_PER_TURN = 1024` makes it unlikely but
  not unreachable, and it gets *more* likely as 2c's agent loop adds tool
  schemas and history to the prompt. Phase 2 exercises exactly this model, so
  it may surface there first. **Deliberately not fixed in Phase 1** — the right
  split (empty-but-valid completion vs. malformed body) depends on how 2c's
  loop wants to react to a truncated turn, so it is recorded here rather than
  guessed at now.
- **Reasoning tokens break `prompt + completion = total`, and Phase 3's
  accounting must not assume they add up.** *(Same live check.)*
  `gemini-3.6-flash` reported `prompt_tokens: 10`, `completion_tokens: 0`,
  `total_tokens: 27` — 17 tokens of invisible reasoning, billed but absent from
  both visible counters. Any cost derivation that sums the two visible fields
  **undercounts real spend**, silently, and Phase 4's monthly ceiling inherits
  that error compounded over every call. This is the same silent-budget-hole
  failure mode Phase 3's pricing step already warns about, arriving from a
  direction the plan did not anticipate. Phase 3 must prefer the provider's own
  `total_tokens` over a computed sum, and treat a `total` exceeding
  `prompt + completion` as reasoning tokens to be priced — not as a
  discrepancy to be discarded.

## Prerequisites (manual, before Phase 1)

**Mode:** hil

- [x] Sign up for a DeepSeek API key (`https://platform.deepseek.com`, or
      current signup URL) and record it. This is the primary provider per D5.
- [x] Sign up for a Gemini API key with access to the Gemini free tier
      (`https://aistudio.google.com`, or current signup URL) and record its
      OpenAI-compatible base URL. This is the fallback provider per D5, and
      also the free-tier profile the roadmap directs all development traffic
      through ("Free-tier development discipline", ROADMAP §2.1).
- [x] Decide a starting `LLM_MONTHLY_BUDGET_USD` value for development — a
      small number (e.g. `1`) is recommended so Phase 4's budget-ceiling
      verification is cheap to trigger deliberately and so the ordering-tension
      risk above stays bounded during Phases 1–4.
- [x] Add all of the above to a local `.env` (never committed): during Phase 1
      development, set `LLM_PRIMARY_*` to the **Gemini** free-tier profile
      (cost-safe) and `LLM_FALLBACK_*` to the **DeepSeek** profile. Phase 2's
      §8 check exercises both regardless of which env slot holds which
      provider. Final Verification performs the actual env-swap to DeepSeek
      primary / Gemini fallback that matches D5's intended production posture.

---

### Phase 0: Create worktree

**This phase is always first. No exceptions** (plan-sequential format spec —
worktree creation is a plan phase, not something `/execute-prd` does on its
own behalf).

The repo has commits on `main` (unlike `00-skeleton`'s Phase 0, which had to
create the first commit). The prior worktree for `00-skeleton` lived at
`../hermes-00-skeleton`, sibling to the repo root — this one follows the same
sibling convention.

**Steps:**

- [x] Confirm with the user: branch name `feat/01-llm-port`, base ref `main`
- [x] `git worktree add ../hermes-01-llm-port -b feat/01-llm-port main`
- [x] Verify worktree is active and on the correct branch: `git worktree list`
- [x] **Explicit step, do not skip:** copy `.env` from the repo root into the
      new worktree (`../hermes-01-llm-port/.env`). `.env` is gitignored, so
      the worktree does not inherit it — the `00-skeleton` execution tripped
      on forgetting exactly this step (it left a `.env.worktree-backup` at the
      repo root as a workaround after the fact). Copy it *before* attempting
      to boot anything in the new worktree, not after hitting a config error.

---

### Phase 1: Real single-shot LLM reply over Telegram, primary+fallback profiles validated at boot

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** You text the bot and get a real LLM-generated reply
instead of an echo. Provider config (base URL, API key, model) is validated
as a unit at boot — a malformed or partial profile fails boot with a readable
error naming the missing key, not a runtime crash on first message. This is
2a's proof of life and the vertical slice every later phase in this PRD
builds on.
**Commit message:** `feat: llm port, OpenAI-compatible adapter, single-shot completion handler`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/core/src/llm-types.ts` | provider-neutral `Message`, `ToolCall`, `ToolResult`, `Usage` types — so `store` and `agent` never need to import `llm` directly (per boundary rule) |
| create | `packages/core/src/backoff.ts` | `nextDelay(attempt, retryAfterHeader?)`, promoted verbatim from `packages/channels/src/telegram/backoff.ts` |
| modify | `packages/core/src/index.ts` | export the new types + `nextDelay` |
| delete | `packages/channels/src/telegram/backoff.ts` | superseded by `@hermes/core`'s copy — one implementation, not two |
| modify | `packages/channels/src/telegram/client.ts` | import `nextDelay` from `@hermes/core` instead of the local file |
| modify | `packages/channels/src/telegram/__tests__/backoff.test.ts` | move to `packages/core/src/__tests__/backoff.test.ts` (same assertions, new home) |
| create | `packages/llm/package.json`, `tsconfig.json` | new workspace package, depends on `@hermes/core` only (no `@hermes/config`, no `@hermes/store` — see boundary note in Steps) |
| create | `packages/llm/src/port.ts` | `LlmProvider` interface: `complete(request: CompletionRequest): Promise<CompletionResult>`, where `CompletionRequest = { model, system, messages, tools, maxTokens }` and `CompletionResult = { text, toolCalls, usage, finishReason }`, built from the `@hermes/core` types; also declares and exports `ProviderProfile = { baseUrl: string, apiKey: string, model: string }` — the port's own construction input, owned by `@hermes/llm` itself, **not** `@hermes/core` (it is not a provider-neutral domain type `store`/`agent` need to share, it is `llm`'s own adapter-construction shape) |
| create | `packages/llm/src/errors.ts` | `LlmTimeoutError` (the adapter's own per-request timeout fired), `LlmHttpError` (carries `status`), `LlmMalformedResponseError` (an HTTP-200 body that is non-JSON, or valid JSON missing a required field — `text` or `usage` — is treated identically: malformed, not a silent partial success) — typed error subclasses, no `Result<T,E>` anywhere in this package (per project convention: this package throws). `LlmTimeoutError` is deliberately distinct from the externally-supplied-`AbortSignal` case Phase 5 adds (`LlmAbortedError`, see Phase 5) — a caller must be able to tell "the adapter itself gave up waiting" from "the process was asked to shut down mid-call" |
| create | `packages/llm/src/adapter/openai-compatible.ts` | `createOpenAiCompatibleAdapter(profile: ProviderProfile, opts?): LlmProvider` (`ProviderProfile` imported from `./port` within the same package — no cross-package import needed) — raw `fetch` against `${baseUrl}/chat/completions`; retry policy mirrors `channels/src/telegram/client.ts`'s `callWithRetry` (429/5xx bounded retry using the shared `nextDelay`, `AbortController` + `setTimeout` per-request timeout, retries reuse the identical request body); every thrown error redacts the API key |
| create | `packages/llm/src/index.ts` | package public exports (`export type` for types, per existing `channels` convention) |
| create | `packages/llm/README.md` | port contract, adapter behavior, error types, and an explicit note that `tools`/tool-calling is wire-format-complete in this phase but has no real caller until `packages/agent` (2c) |
| modify | `packages/config/src/schema.ts` | add `LLM_PRIMARY_BASE_URL` (url), `LLM_PRIMARY_API_KEY` (min 1), `LLM_PRIMARY_MODEL` (min 1) — required; `LLM_FALLBACK_BASE_URL` / `_API_KEY` / `_MODEL` — optional strings; a `superRefine` (same pattern as the existing `TELEGRAM_ALLOWLIST` refinement) enforcing all three fallback keys present or all three absent — partial fallback config fails boot naming the missing key |
| modify | `packages/config/src/schema.ts` (`IS_SECRET_ENV_KEY`) | add entries for all 6 new keys (`*_API_KEY` → `true`, `*_BASE_URL`/`*_MODEL` → `false`) — compile error until declared, by design |
| create | `apps/hermes/src/llm/build-provider-profiles.ts` | thin pure mapping function: parsed `Env` → `{ primary: ProviderProfile, fallback?: ProviderProfile }`, importing the `ProviderProfile` **type** from `@hermes/llm`'s public exports. Lives in `apps/hermes` specifically because `apps/hermes` is the only place in the tree allowed to depend on both `@hermes/config` (the flat `LLM_PRIMARY_*`/`LLM_FALLBACK_*` env fields) and `@hermes/llm` (the `ProviderProfile` type it maps into) — `packages/config` and `packages/llm` stay mutually independent: neither imports the other, ever |
| create | `apps/hermes/src/handlers/complete.ts` | `createCompletionHandler({ channel, llmProvider, logger })` → `(message: InboundMessage) => Promise<void>`: single LLM call (`llmProvider.complete({ model, system: <fixed placeholder prompt>, messages: [{role:"user", content: message.text}], tools: undefined, maxTokens: MAX_TOKENS_PER_TURN })`), reply with `result.text`; catches provider errors and replies with a generic readable message instead of crashing (no stack trace to chat) |
| create | `packages/llm/src/max-tokens.ts` | `MAX_TOKENS_PER_TURN = 1024` (invariant #9's max-tokens-per-turn guard) — a single named, exported constant, not a magic number inlined at the call site, so 2c can later override it per-tool without re-deriving the value |
| modify | `apps/hermes/src/boot.ts` | after config load: `buildProviderProfiles(config)` → `createOpenAiCompatibleAdapter(profiles.primary)` as the active `LlmProvider`; register `completionHandler` in `dispatchCommand`'s fallthrough, replacing `echoHandler` (echo handler code stays in the tree but is no longer wired — do not delete `echo.ts`, it remains a documented reference/fallback per minimal-change). The existing `withAllowlist(withPrivateChat(dispatchCommand, logger), allowlist, logger)` composition around `dispatchCommand` is **unchanged** — this is what makes invariant #1 hold for the new paid handler: an unknown sender never reaches `dispatchCommand`, so it never reaches `completionHandler` either, so it never reaches `llmProvider.complete()` |
| modify | `tsconfig.base.json` | add `@hermes/llm` to `paths` |
| modify | `Dockerfile` | add `COPY packages/llm/package.json ...` to the build stage's package-manifest copy list |
| modify | `docker-compose.yml` | pass the 6 new `LLM_*` env vars (and `LLM_MONTHLY_BUDGET_USD`, added here even though Phase 4 is where it's read, so operators don't discover a missing var mid-Phase-4) through to the `hermes` service |
| modify | `.env.example` | document all 7 new keys with placeholder values and a comment on the Prerequisites' primary/fallback dev convention |

**Steps:**

- [x] Promote `nextDelay` to `@hermes/core` first — both `channels` and the new
      `llm` adapter need it, and duplicating the backoff calculation is
      explicitly the wrong move (CLAUDE.md: DRY). Update `channels`'s import
      and move its test file; do not leave a re-export shim, this is a clean
      move
- [x] Add `Message` / `ToolCall` / `ToolResult` / `Usage` to `@hermes/core`
      per the boundary rule that no vendor-shaped type escapes `packages/llm`
      — these are the provider-neutral shapes `store` (Phase 3+) and `agent`
      (2c) will use without ever importing `llm`
- [x] Scaffold `packages/llm` per D3's package-creation rule (created here,
      never grown inside another package first). Declared dependency:
      `@hermes/core` only. It must **not** depend on `@hermes/config` (config
      shape is boot's concern, mapped in `apps/hermes`) or `@hermes/store`
      (persistence is an injected port, arriving in Phase 3) — this is the
      single most concrete boundary decision in this phase; get it wrong and
      `llm` becomes untestable without a real env/DB
- [x] **`ProviderProfile` placement, explicit and non-negotiable:** the type
      lives in `packages/llm/src/port.ts`, exported from `@hermes/llm`. It is
      the port's own input shape (`{ baseUrl, apiKey, model }`), not a
      provider-neutral domain type — so it does **not** belong in
      `@hermes/core` alongside `Message`/`ToolCall`/`ToolResult`/`Usage`.
      `@hermes/config` produces only flat validated env fields
      (`LLM_PRIMARY_BASE_URL` etc.) and never constructs a `ProviderProfile`
      itself — that mapping happens once, in `apps/hermes/src/llm/
      build-provider-profiles.ts`, which is the one place allowed to import
      both `@hermes/config`'s `Env` type and `@hermes/llm`'s `ProviderProfile`
      type. `config` and `llm` remain mutually independent: neither ever
      imports the other
- [x] `LlmProvider` port + `CompletionRequest`/`CompletionResult` types exactly
      matching ROADMAP §5's prescribed signature: `complete({ model, system,
      messages, tools, maxTokens })` → `{ text, toolCalls, usage,
      finishReason }`
- [x] OpenAI-compatible adapter over `fetch`: request body assembles
      `tools` → system message → per-turn `messages` in that stable prefix
      order (invariant #6 — this phase establishes the ordering; Phase 3 is
      where it gets proven against real cache-hit numbers, not here).
      **Corrected during Phase 1 execution:** the system prompt is
      `messages[0]` with `role: "system"`, **not** a top-level `system` body
      key. OpenAI-compatible chat-completions APIs (DeepSeek included) have no
      top-level `system` field and silently ignore unknown top-level keys, so
      the original wording produced an adapter that sent no system prompt at
      all. The port's `CompletionRequest` still takes `system` as its own
      field — the flattening into `messages[0]` happens inside the adapter,
      where wire format belongs. Retries mirror
      `channels/src/telegram/client.ts`'s `callWithRetry` shape: separate
      bounded attempt counts for 429 vs 5xx/network, `Retry-After` header wins
      when present (via the shared `nextDelay`), request timeout via
      `AbortController` + `setTimeout`, retries resend the identical body.
      Malformed/non-JSON response bodies throw `LlmMalformedResponseError`
      rather than crashing the process. **Same treatment for an HTTP-200 body
      that parses as JSON but is missing `usage`:** do not default to a zero
      `usage` and return successfully — that would let a later phase silently
      record zero cost for a real, billed call (the same silent-budget-hole
      failure mode called out in Phase 3's pricing step). Throw
      `LlmMalformedResponseError` instead, so a missing usage block fails
      loudly at the adapter boundary rather than corrupting Phase 3's
      accounting or Phase 4's budget math downstream
- [x] **Max-tokens-per-turn guard (invariant #9):** the completion handler
      passes `maxTokens: MAX_TOKENS_PER_TURN` (`packages/llm/src/max-tokens.ts`,
      a named constant, not a magic number) on every request; the adapter
      serializes it as the outgoing body's `max_tokens` field. This bounds a
      single turn's output spend independently of the monthly ceiling
      (Phase 4) — invariant #9 groups "max iterations, max tokens per turn,
      and a monthly spend ceiling" together, and 2a's single-shot handler has
      no iteration loop to bound (that's 2c), but it still owes the
      max-tokens-per-turn half of the invariant now, not deferred
- [x] Provider-profile config: `superRefine` for the fallback all-or-none rule
      in `packages/config/src/schema.ts`, following the existing
      `TELEGRAM_ALLOWLIST` custom-refinement precedent exactly. Primary's
      three keys are plain required fields — no refine needed there
- [x] `build-provider-profiles.ts`: pure function, unit-testable without
      booting anything real
- [x] Completion handler: **no tool loop, no approval gate, no persistence
      yet** — literally one `complete()` call per Telegram message. This is
      the explicit line between 2a's proof of life and 2c's bounded agentic
      loop; do not add iteration, retries-with-validation-feedback, or a
      system prompt beyond a fixed placeholder string here
- [x] Register the three touchpoints the codebase-surface research flags:
      `tsconfig.base.json` paths, `Dockerfile` package-manifest COPY,
      `docker-compose.yml` env passthrough — miss any one and either
      typecheck fails on a clean clone or the container never sees a key it
      needs
- [x] `packages/llm/README.md`: document the port contract, the adapter's
      retry/timeout behavior, and that `tools` is wire-complete but unused
      until 2c

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/core/src/__tests__/backoff.test.ts` | moved from `channels`, same assertions: exponential growth, cap, `retry_after` override |
| create | `packages/llm/src/adapter/__tests__/openai-compatible.test.ts` | request shape (`tools`→`system`→`messages` key order, and `max_tokens` present and equal to `MAX_TOKENS_PER_TURN`); success path parses `text`/`usage`/`finishReason`; 429 retries with backoff then succeeds; 5xx exhausts retries and throws `LlmHttpError`; timeout throws `LlmTimeoutError`; malformed (non-JSON) body throws `LlmMalformedResponseError`; **well-formed JSON body with the `usage` block absent also throws `LlmMalformedResponseError`, not a zero-usage success** (the missing-usage-block edge case); API key never appears in a thrown error message — all against a stubbed global `fetch`, no network |
| create | `packages/config/src/__tests__/schema.test.ts` (extend) | valid primary-only config parses with `fallback: undefined` (confirms primary-only boot is valid, not an error); valid primary+fallback parses both; partial fallback (1 or 2 of 3 keys set) fails boot naming the missing key; missing primary key fails boot |
| create | `apps/hermes/src/llm/__tests__/build-provider-profiles.test.ts` | maps a parsed `Env` to the expected `{ primary, fallback? }` shape, both with and without fallback present |
| create | `apps/hermes/src/handlers/__tests__/complete.test.ts` | happy path replies with `result.text`; a thrown `LlmHttpError`/`LlmTimeoutError` from a fake `LlmProvider` results in a generic readable reply, not a thrown error out of the handler |
| create | `apps/hermes/src/__tests__/dispatch-allowlist-gates-llm.test.ts` | **invariant #1 regression, paid-call-specific:** builds the real composed handler chain (`withAllowlist(withPrivateChat(dispatchCommand, logger), allowlist, logger)`) with `completionHandler` wired to a call-counting fake `LlmProvider`, feeds a message from a `channelUserId` **not** on the allowlist, and asserts the fake provider's `complete()` was called **zero** times — an unknown sender must be dropped before the completion handler is ever reached, so it costs nothing. (Zero provider calls implies zero `llm_usage` rows once Phase 3 lands, since Phase 3's usage test already proves `recordUsage` is only ever called from the adapter's success path.) |

**Verification:**

- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green (catches a missing `tsconfig.base.json` path entry)
- [x] `docker compose build` succeeds (catches a missing `Dockerfile` COPY line)
- [x] With `LLM_PRIMARY_*` pointed at Gemini free tier: message the bot →
      reply is a real, non-echoed LLM completion
- [x] Unset one `LLM_FALLBACK_*` key while leaving the other two set → boot
      fails with a readable error naming the missing key, not a stack trace
- [x] Unset all three `LLM_FALLBACK_*` keys → boot succeeds with `fallback`
      undefined — primary-only boot is a valid, supported configuration, not
      an error path
- [x] `docker compose logs hermes | grep -i <api-key-prefix>` → no match,
      including in a forced network-error scenario
- [x] Send a message from a `channelUserId` **not** on `TELEGRAM_ALLOWLIST` →
      no reply, no provider call, `docker compose logs hermes` shows the
      existing "rejected: unknown user" warn line, not an LLM error path

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: llm port, OpenAI-compatible adapter, single-shot completion handler`
- [x] Phase marked complete

---

### Phase 2: The §8 DeepSeek-vs-Gemini tool-calling check (live, against the real adapter)

**Risk:** medium
**Mode:** hil
**Type:** test
**Success criteria:** A `pnpm test:live` run produces a recorded, comparable
result — tool-call accuracy and malformed-JSON rate over 10 trials — for both
DeepSeek and Gemini against the *same* 5-tool prompt, through the real adapter
built in Phase 1. The result is written up as decision `D5` in
`.ai/decisions/`, including whether the Gemini-quirkiness contingency's
concrete numeric trigger (see `Dependencies & Risks`) fired. This satisfies
2a's second exit-criterion clause and is scheduled here — the first real task
after the adapter exists — per ROADMAP §8's "first task of this phase,"
adjusted only to come after the minimal adapter it depends on.
**Why `hil`:** this phase spends real (if small, free-tier-bounded) money
against two live third-party APIs and its output is a permanent decision
record (`D5`) — not something a subagent should trigger and interpret
unsupervised. It requires the live credentials from `## Prerequisites`, which
only the orchestrator can supply.
**Commit message:** `test: §8 DeepSeek-vs-Gemini tool-calling check, decision D5`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/llm/src/__tests__/live/tool-calling-check.live.test.ts` | the §8 check itself, 10 sequential trials per provider — tagged/named so it's excluded from the default run |
| create | `packages/llm/src/__tests__/live/fixtures/five-tool-prompt.ts` | the 5 throwaway JSON-Schema tool defs + the fixed prompt text used identically against both profiles — test-local, not `packages/agent`'s tool registry (doesn't exist yet) |
| create | `packages/llm/src/__tests__/live/setup.ts` | the one new test-setup file for the live lane: loads live provider profiles from env, skips (not fails) the suite with a clear message if either profile's env vars are absent, provides a fixture-recording helper |
| modify | root `package.json` | add `test:live` script |
| modify | `packages/llm/package.json` | add `test:live` script (`vitest run --dir src/__tests__/live`, or vitest's include/exclude glob for `*.live.test.ts` — no new test framework, no `vitest.config.ts`, matching "no vitest.config.ts anywhere") |
| create | `packages/llm/src/__tests__/live/fixtures/recorded/*.json` | recorded real responses from the actual live run, replayed by the default `pnpm test` lane so the shape of the check stays covered offline without spending money on every CI-adjacent run |
| create | `.ai/decisions/d5-deepseek-primary-gemini-fallback.md` | decision D5 write-up: the roadmap's original D5 text, plus this check's actual measured result (accuracy + malformed-JSON rate per provider) and whether the native-Gemini-adapter contingency triggered |

**Steps:**

- [x] Build the 5-tool fixture: five small, plausible JSON-Schema tool defs
      (e.g. `get_current_time`, `echo`, and three more representative
      thin/fat-tool shapes) and one fixed user prompt designed to exercise
      tool selection — this is test-local fixture data, not a real tool
      registry; `packages/agent` (2c) owns the real registry
- [x] Live test: call `LlmProvider.complete()` **10 times** built from the
      **primary** profile's real credentials with the 5-tool prompt, then 10
      more times against the **fallback** profile's real credentials — same
      prompt, same tool defs each trial, all sequential (not parallel, to keep
      rate limits predictable and free-tier-safe)
- [x] Metrics captured per ROADMAP §8, per provider, over the 10 trials: (1)
      tool-call accuracy — count of trials where the model picked the
      fixture's defensible tool, judged by a fixed expected-tool assertion,
      not a subjective read; (2) malformed-JSON rate — count of trials where
      the adapter's own JSON-Schema-shaped tool-call arguments failed to parse
- [x] **Expect zero-content 200s from the reasoning model, and do not score
      them as malformed JSON.** Per the "reasoning models return zero-content
      200s" risk above, `gemini-3.6-flash` can answer HTTP 200 with
      `finish_reason: "length"`, `completion_tokens: 0`, and no `content` —
      which Phase 1's adapter currently raises as
      `LlmMalformedResponseError`. If a trial dies that way, it is a *budget
      truncation*, not a tool-calling failure: count it in a **third, separate
      column** (truncated-trial count) and re-run that trial with a larger
      `maxTokens` rather than letting it inflate the malformed-JSON rate and
      libel the provider in the D5 write-up. If truncated trials are common
      enough to distort the comparison, say so explicitly in the decision doc —
      "this model needs a bigger output budget to tool-call reliably" is itself
      a D5-relevant finding
- [x] Record all 20 raw responses (10 per provider) as fixtures under
      `fixtures/recorded/`; the default `pnpm test` lane gets a **separate**,
      non-live test (in the normal `__tests__` tree, not `live/`) that replays
      these fixtures through the same assertion logic, so the check's
      assertion code stays exercised in CI without spending money or needing
      live keys
- [x] Run the check for real, live, once, via `pnpm test:live`. Read the
      actual result before writing D5 — do not pre-write a passing result
- [x] **Contingency evaluation (only take this branch if the concrete numeric
      trigger in `Dependencies & Risks` fires):** Gemini malformed-JSON rate
      ≥ 20% or accuracy ≤ 70%, with DeepSeek not showing the same problem on
      the same run. If triggered, add `packages/llm/src/adapter/
      gemini-native.ts` — a small adapter behind the same `LlmProvider` port,
      wired only for the Gemini profile, scoped to fixing exactly the failure
      mode the trigger measured (malformed tool-call JSON parsing, or tool
      selection) and nothing broader — as part of this phase's commit, and
      note the exact trigger numbers and the fix in D5. If the trigger does
      not fire, do not build it; D5 states the measured numbers and that the
      check passed cleanly on the OpenAI-compatible path for both providers
- [x] `.ai/decisions/d5-deepseek-primary-gemini-fallback.md`: this PRD's one
      decision doc (per "Decision docs" scoping — D1/D2 are not this PRD's to
      write). Include rejected alternatives already settled by the roadmap
      (provider registry, automatic failover) and the check's actual numbers

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/llm/src/__tests__/live/tool-calling-check.live.test.ts` | live, tagged, excluded from default run and CI — the actual §8 check, 10 trials against each real profile, asserting the measured rates against the concrete numeric trigger from `Dependencies & Risks` |
| create | `packages/llm/src/__tests__/tool-calling-check-fixture-replay.test.ts` | default lane: replays the recorded fixtures from the live run through the same accuracy/malformed-JSON assertion logic, offline |

**Verification:**

- [x] `pnpm test` (default lane) does **not** attempt any network call for
      this check — confirm by running with no `LLM_*` env vars set at all and
      seeing it still pass via fixture replay
- [x] `pnpm test:live` (with both real credential sets present) runs the live
      check (10 trials per provider) and prints a clear pass/fail plus the two
      measured metrics per provider (malformed-JSON rate, accuracy), and
      whether the concrete numeric trigger fired
- [x] `.ai/decisions/d5-deepseek-primary-gemini-fallback.md` exists and states
      the actual measured result, not a placeholder
- [x] If the contingency triggered: `gemini-native.ts` exists, is wired only
      for the Gemini profile, and the same live check passes against it. If
      not triggered: confirm no such file was added

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `test: §8 DeepSeek-vs-Gemini tool-calling check, decision D5`
- [x] Phase marked complete

---

### Phase 3: Usage accounting, with the cache-hit-token proof

**Risk:** high
**Mode:** hil
**Type:** backend
**Success criteria:** Every completion call writes a usage row to Postgres
with cache-hit tokens tracked as a distinct column from regular input tokens.
**The invariant #6 test is its own labeled verification here**, not a bullet
buried in the usage-accounting list: two live calls sharing a stable
`tools`→`system`→`messages` prefix must show the second call's reported
cache-hit token count materially greater than zero, proven against real
provider-reported numbers — not against the serialized request shape.
**Why `hil`:** the invariant #6 proof is only meaningful against real,
billed DeepSeek calls and real provider-reported token counts — a subagent
running this unsupervised would be spending money to produce a number a human
still has to read and judge ("materially greater than zero... a meaningful
fraction") before it can be written into a permanent usage-accounting design
proof. Requires the live credentials from `## Prerequisites`.
**Commit message:** `feat: llm usage accounting with cache-hit token tracking`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/store/src/migrations/002_llm_usage.sql` | `llm_usage(id bigserial pk, created_at timestamptz not null default now(), provider text not null, model text not null, input_tokens int not null, output_tokens int not null, cache_hit_tokens int not null, cost_usd numeric(12,6) not null)` |
| create | `packages/store/src/llm-usage-repo.ts` | `recordUsage(pool, entry)`, `sumCostSince(pool, sinceUtc)` — plain exported functions taking `pool` first, matching the `telegram-offset-repo.ts` pattern exactly, no ORM, no class |
| create | `packages/llm/src/usage/usage-repo-port.ts` | the injected port interface `LlmUsageRepo { recordUsage(entry): Promise<void> }` that `packages/llm` depends on — mirrors `TelegramOffsetRepo`'s shape in `channels`, so `llm` never imports `@hermes/store` |
| create | `packages/llm/src/pricing.ts` | `MODEL_PRICING` versioned typed constant keyed by model id (`{ inputPerMillionUsd, outputPerMillionUsd, cacheHitDiscount }`), dated "as of 2026-08-26" per ROADMAP §2.1's directional table, covering **`deepseek-chat` and `gemini-3.6-flash` at minimum** — these are the model ids actually configured in `.env` and verified live during Phase 1; the plan's original `deepseek-v4-flash` / `gemini-flash-lite-3.5` were speculative and `gemini-2.0-flash` was confirmed retired by the provider (HTTP 404, "no longer available") during that same check, so price what is really being called; `resolveCostUsd(model, usage)` — unknown model logs a `warn` via an injected logger and returns `0`, never a silent miscount |
| modify | `packages/llm/src/adapter/openai-compatible.ts` | `createOpenAiCompatibleAdapter` now takes an injected `usageRepo: LlmUsageRepo` and `logger`; after every successful `complete()`, calls `resolveCostUsd` then `usageRepo.recordUsage(...)` before returning the result to the caller |
| modify | `apps/hermes/src/boot.ts` | wire `llmUsageRepo = { recordUsage: (e) => recordUsage(pool, e) }` from `@hermes/store`, pass into `createOpenAiCompatibleAdapter` |
| create | `packages/store/README.md` (extend) | document the `llm_usage` table shape and why cache-hit tokens are a separate column, not folded into `input_tokens` |

**Steps:**

- [x] Migration `002_llm_usage.sql`, following `001_telegram_offset.sql`'s
      conventions (own transaction, tracked in `schema_migrations`)
- [x] `llm-usage-repo.ts`: two functions against the pool; `sumCostSince`
      exists here already (used by Phase 4, built now since it's the natural
      home next to `recordUsage`, not because Phase 4 needs it yet — this is
      not speculative, both consumers land in this same PRD)
- [x] Injected-port shape in `packages/llm`: confirm `llm` still declares no
      dependency on `@hermes/store` in `package.json` — this is the same
      boundary rule Phase 1 established, now under real pressure since
      there's an actual DB write to make
- [x] Pricing constant: start from the ROADMAP §2.1 directional table values
      as a draft, then **[x] verify every model id string and both
      per-token prices against current provider pricing docs before this
      phase ships — do not carry the roadmap's directional numbers over
      unverified.** Record the actual verification date as the file-level
      "as of" comment (not the roadmap's date, unless re-verified on the same
      day). **Concrete failure mode, not a nicety:** `resolveCostUsd`'s
      unknown-model path returns `0` — a wrong or stale model id string (e.g.
      the provider renamed/retired `deepseek-v4-flash` after this table was
      written) does not error, it silently falls into that path and reports
      **zero cost for every real, billed call using that id**, which quietly
      disables the budget ceiling (Phase 4) for that model with no error
      anywhere. Treat a mismatch between `MODEL_PRICING`'s keys and the
      model ids actually configured in `LLM_PRIMARY_MODEL`/
      `LLM_FALLBACK_MODEL` as a blocking finding for this phase, not a
      follow-up
- [x] **Never derive total spend by summing the visible token counters.** Per
      the "reasoning tokens break `prompt + completion = total`" risk above,
      `gemini-3.6-flash` was observed live returning `prompt_tokens: 10`,
      `completion_tokens: 0`, `total_tokens: 27` — 17 billed reasoning tokens
      visible in *neither* counter. `resolveCostUsd` must therefore treat the
      provider's own `total_tokens` as authoritative, and when
      `total > prompt + completion`, price the remainder as reasoning/thinking
      tokens rather than dropping it. Dropping it silently undercounts real
      spend on every reasoning-model call and quietly widens Phase 4's ceiling
      by the same margin. Add a unit test using these exact observed numbers
      (10 / 0 / 27) so the case is pinned to a real provider response, not a
      hypothetical
- [x] Wire usage recording into the adapter's success path only — a failed
      call (already thrown as a typed error before this point) records
      nothing, since no tokens were billed
- [x] **Invariant #6 proof, live:** two sequential `complete()` calls sharing
      an identical `tools`+`system` prefix and differing only in the trailing
      `messages` content (matching the invariant's "volatile content last"
      rule). Assert the **second** call's `usage.cacheHitTokens` is greater
      than zero and a meaningful fraction of the shared prefix's token count
      — read from the actual provider response, never inferred from the
      request JSON's key order. A shape-only assertion does not satisfy this
      step
- [x] `packages/store/README.md`: document the table and the cache-hit column

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/llm/src/__tests__/pricing.test.ts` | known model → correct cost math including cache-hit discount; unknown model → cost `0` + a `warn` log call, asserted via a fake logger |
| create | `packages/llm/src/adapter/__tests__/openai-compatible-usage.test.ts` | successful `complete()` calls the injected `usageRepo.recordUsage` exactly once with the parsed usage numbers, against a stubbed `fetch`; a failed call never calls `recordUsage` |
| create (test:db) | `packages/store/src/__tests__/llm-usage-repo.test.ts` | integration, gated on `TEST_DATABASE_URL`: migration applies cleanly; a recorded row round-trips with `cache_hit_tokens` distinct from `input_tokens`; `sumCostSince` sums correctly across multiple rows |
| create (test:live) | `packages/llm/src/__tests__/live/cache-hit-tokens.live.test.ts` | **invariant #6, live and unmissable:** two real calls sharing a stable prefix, asserting the second call's real `cacheHitTokens` > 0, against DeepSeek (the provider with documented prefix caching) |

**Verification:**

- [x] `pnpm test` green (fake `fetch`, fake usage repo)
- [x] `pnpm test:db` green against the docker-compose Postgres — confirms the
      migration and the cache-hit-column round-trip for real
- [x] `pnpm test:live` green — confirms real cache-hit token counts are
      nonzero on the second of two prefix-sharing calls. **This is the
      concrete, unfalsifiable check the requester called out by name — a
      failing or skipped result here means invariant #6 is not actually
      proven, regardless of what the request-shape unit tests say**
- [x] Manually inspect one `llm_usage` row via `psql` after a live call:
      `cache_hit_tokens` is populated and distinct from `input_tokens`
- [x] **Pricing verification, explicit:** every key in `MODEL_PRICING`
      matches a model id currently configured in `LLM_PRIMARY_MODEL` /
      `LLM_FALLBACK_MODEL`, each price was checked against the provider's
      current published pricing page (not copied from the roadmap without
      re-checking), and the file-level "as of" comment carries the actual
      verification date

**Execution notes (deviations from the plan as written):**

- **`deepseek-chat` was retired by the provider.** `GET /v1/models` on the
  live key returns only `deepseek-v4-flash`, `deepseek-v4-pro`,
  `deepseek-v4-flash-vision-exp`. This is exactly the blocking failure mode
  the pricing step warned about, and it had already happened: the configured
  `LLM_PRIMARY_MODEL` was a dead id, so the primary provider was broken, not
  merely mispriced. `.env` now sets `LLM_PRIMARY_MODEL=deepseek-v4-flash`.
  `.ai/decisions/d5-deepseek-primary-gemini-fallback.md` still records the
  Phase 2 tool-calling measurement against `deepseek-chat` — that result is
  stale and must be flagged during the knowledge-base sync.
- **`packages/core` was modified, though Phase 3's file table did not list
  it.** `Usage` had no `cacheHitTokens` field, so the phase's own
  verification (`usage.cacheHitTokens > 0`) was unsatisfiable as specified.
  Added `cacheHitTokens` to `Usage` and parsed both wire shapes in the
  adapter: DeepSeek's `usage.prompt_cache_hit_tokens` and the
  OpenAI-compatible `usage.prompt_tokens_details.cached_tokens` (Gemini).
  Absent/non-numeric cache info yields `0` — unlike an absent `usage` block,
  which still throws.
- **`MODEL_PRICING` carries DeepSeek's peak prices, not off-peak.** DeepSeek
  publishes a ~50% off-peak discount that the flat table shape deliberately
  does not model. Pricing high can only over-report spend, which is the safe
  direction for the Phase 4 ceiling.
- **`input_tokens` stores the cache-MISS portion only**, so
  `input_tokens + cache_hit_tokens` recovers the provider's raw prompt count
  with no double counting. Documented in `packages/store/README.md`.
- **The live cache-hit test seeds its prefix per run.** A literally constant
  prefix stays warm in DeepSeek's cache once any run has populated it, so
  every later run reported a hit on the FIRST call too and the cold→warm
  transition became unobservable — the test passed while proving nothing.
  A `randomUUID()` in the system prompt guarantees call one is a genuine
  miss, and the test now asserts `first.cacheHitTokens === 0` as well.
- **Invariant #6, measured** (final run, after the run seed moved ahead of
  the tools block): cold call `promptTokens 3190 / cacheHitTokens 0 /
  $0.001427`; warm call `promptTokens 3190 / cacheHitTokens 3072 /
  $0.000144` — a ~9.9x cost reduction on an identical prefix, from real
  provider-reported counts. 3072 = 48 x 64, on DeepSeek's documented 64-token
  cache granularity. An earlier run with the seed in the system prompt only
  measured 3166 / 0 -> 3072 at 12.8x; both agree on the cold->warm
  transition.
- **`llm_usage` row verified end-to-end through `boot.ts`'s own wiring**, not
  a test double: row 23 shows `input_tokens 27, cache_hit_tokens 1536`.
- **`pnpm test:live` runs the whole live directory**, so it also re-fires
  Phase 2's 10-trials-per-provider tool-calling check (~140s, 20 billed
  calls) and rewrites that phase's tracked fixtures under
  `fixtures/recorded/`. Those fixtures were reverted. In that run Gemini
  recorded 2 hard failures, both HTTP 429 free-tier rate limits on trials 9
  and 10 — not a regression from this phase.
- **A `recordUsage` failure logs and continues; it does not throw.** The
  provider call has already succeeded and the tokens are already billed by
  that point, so letting the insert's rejection propagate would cost the
  operator the reply *on top of* the lost row. The `error` log carries
  provider, model, all three token counts and the resolved cost, so a dropped
  row can be reconstructed from logs.
- **Adapter construction was extracted to
  `apps/hermes/src/llm/build-llm-provider.ts`** (shaped like
  `build-provider-profiles.ts`). `boot.ts` offered no testable seam — it
  builds a real pool, Telegram channel and advisory lock — so the wiring that
  routes `usageRepo` to the store's `recordUsage` had no test pinning it, and
  `usageRepo`/`logger` both default to no-ops: dropping them would have
  silently disabled all cost recording with nothing failing.
- **`pricing.test.ts` now validates `MODEL_PRICING` against the configured
  `LLM_*_MODEL` env vars when they are set**, falling back to literal-key
  assertions when they are not. Literal-only assertions could not have caught
  the `deepseek-chat` retirement that this phase ran into.
- **`LlmUsageEntry` now lives in `@hermes/core`**, re-exported from both `llm`
  and `store`, so the two sides can no longer drift a field apart without a
  type error.

- **`deepseek-v4-flash` spends its output budget on reasoning.** A 32-token
  `maxTokens` call returned empty text with `completionTokens: 32`. Phase 1's
  max-tokens ladder covers this; noted here because the model swap above
  changes which model the ladder is exercising.


- **Code review: green, no blocking findings.** All six focus areas verified
  (`total_tokens` authoritative with the reasoning remainder priced, the
  10/0/27 case pinned, `MODEL_PRICING` keys matching the configured
  `LLM_*_MODEL`, cache-miss-only `input_tokens` with both wire shapes,
  `packages/llm` still core-only, non-throwing `recordUsage` with a
  reconstructable error log, success-path-only recording). Four nits recorded,
  none fixed here: (1) the no-op `usageRepo`/`logger` defaults in
  `openai-compatible.ts` re-open the silent-$0 hole at a second seam, pinned
  only by `build-llm-provider.test.ts`; (2) doc drift — `usage-repo-port.ts`,
  `llm-usage-repo.ts` and `packages/store/README.md` still say `boot.ts` wires
  the port, which moved to `build-llm-provider.ts`; (3) `cacheHitDiscount` as
  a derived multiplier (`0.031818`) is less checkable than an explicit
  `cacheHitPerMillionUsd`; (4) `cost_usd numeric(12,6)` floors sub-$5e-7 calls
  to zero — harmless at present volumes, relevant to Phase 4's ceiling.
- **`pnpm test:db` did not exist when this phase ticked it green.** No such
  script was defined in any `package.json`; the DB integration tests are
  `describe.skipIf(!TEST_DATABASE_URL)` under plain `pnpm test`, and
  `TEST_DATABASE_URL` was absent from `.env`, so all 11 DB tests silently
  skipped. The claims themselves hold — run properly against a scratch
  database, all 14 `@hermes/store` tests pass, `llm-usage-repo.test.ts`
  included — but the gate that was supposed to prove them was vacuous. The
  script is added as separate infrastructure before Phase 4, since Phases 4
  and 5 both depend on it and Phase 5's invariant-#4 proof is `test:db`-only.
  The DB test files also cannot run in parallel against one database
  (concurrent `runMigrations` + `DELETE` produce `ECONNRESET`), so the script
  forces serial execution.
- **Orchestrator approval for this phase was delegated, not individually
  given** ("please do what you can from here, just let me know when we get to
  the spending money part"). The green review plus the re-run DB suite is what
  the approval box rests on here.

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: llm usage accounting with cache-hit token tracking`
- [x] Phase marked complete

---

### Phase 4: Budget ceiling

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** With `LLM_MONTHLY_BUDGET_USD` set low, QA sends enough
messages to exceed it and gets back a readable Telegram message saying Hermes
is out of budget this month — never a stack trace, never a silent hang. No
further provider calls happen once the ceiling is breached, verified by the
usage table not growing further.
**Commit message:** `feat: monthly budget ceiling with typed BudgetExceededError`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/llm/src/budget/resolve-budget-cap.ts` | `resolveBudgetCapUsd(env: { LLM_MONTHLY_BUDGET_USD: number }): number` — the single seam function; every cap read goes through this, so a future DB-backed cap replaces only this function's body, not any call site |
| create | `packages/llm/src/budget/check-budget.ts` | `assertBudgetNotExceeded(usageRepo, capUsd, clock): Promise<void>` — sums spend since the start of the current calendar month **in UTC** via `usageRepo.sumCostSince`, throws `BudgetExceededError` if the sum meets or exceeds the cap |
| create | `packages/llm/src/errors.ts` (extend) | `BudgetExceededError` — carries `capUsd` and `spentUsd` for a useful message |
| modify | `packages/llm/src/adapter/openai-compatible.ts` | `complete()` calls `assertBudgetNotExceeded` **before** issuing the `fetch` — the check must run before the spend it prevents, not after |
| modify | `packages/config/src/schema.ts` | add `LLM_MONTHLY_BUDGET_USD` (coerced positive number) + `IS_SECRET_ENV_KEY` entry (`false`) |
| modify | `apps/hermes/src/handlers/complete.ts` | catch `BudgetExceededError` specifically and reply with a fixed, readable "out of budget this month" message — distinct from the Phase 1 generic-error fallback |

**Steps:**

- [x] `resolveBudgetCapUsd`: reads the already-parsed config value; this is
      purely a naming/indirection seam per decision — do not add caching,
      DB reads, or multi-tenancy here, that is explicitly future scope
- [x] `assertBudgetNotExceeded`: month boundary is **calendar month, UTC** —
      use an injected `Clock` (already exists in `@hermes/core` from Phase 1
      of `00-skeleton`) so this is testable without waiting for a real
      month rollover
- [x] Wire the check into the adapter's `complete()` as the very first thing
      it does, before building the request — a breach must cost nothing
- [x] `BudgetExceededError` message includes both numbers (`spentUsd`,
      `capUsd`) so the boot logs are useful, but the **user-facing** Telegram
      reply is a fixed friendly string, not the raw error message (avoid
      leaking internal cost figures to chat by default — note this as a
      deliberate choice in the handler, `/stats` is where spend surfaces,
      per 02-telemetry)
- [x] Confirm no test or manual run can bypass the check by calling the
      adapter without a `usageRepo`/cap wired — the constructor should make
      the dependency mandatory, not optional-with-a-silent-no-op default
- [x] **Design note — granularity of "breached mid-conversation":** the check
      gates the *next* call against spend already recorded, not against spend
      still in flight. A call that passed the check and is executing when its
      own cost would push cumulative spend over the cap still completes and
      is recorded — the ceiling stops the *following* call, not that one. In
      2a this window is exactly one call wide, since the completion handler
      is single-shot (no loop, no multi-call turn) — a 2c multi-call turn
      revisits this if a tighter, per-turn-aware cap is ever needed. State
      this explicitly in `packages/llm/README.md` so it isn't mistaken for a
      bug: the ceiling bounds cumulative monthly spend to within one call's
      cost of the configured cap, not to an exact hard stop

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/llm/src/budget/__tests__/resolve-budget-cap.test.ts` | pure function, reads the configured number |
| create | `packages/llm/src/budget/__tests__/check-budget.test.ts` | under cap → resolves; at/over cap → throws `BudgetExceededError` with correct numbers; fake `usageRepo` + fake `Clock`, no DB |
| create | `packages/llm/src/adapter/__tests__/openai-compatible-budget.test.ts` | over-budget short-circuits before any `fetch` call — assert the stubbed `fetch` was never invoked |
| create (test:db) | `packages/store/src/__tests__/llm-usage-repo-month-boundary.test.ts` | integration: rows dated last calendar month (UTC) are excluded from `sumCostSince(startOfThisMonthUtc)`; rows dated this month are included; a row exactly at the boundary second is handled correctly |
| create | `apps/hermes/src/handlers/__tests__/complete.test.ts` (extend) | `BudgetExceededError` from a fake `LlmProvider` produces the specific out-of-budget reply, not the generic Phase-1 fallback message |

**Verification:**

- [x] `pnpm test` green
- [x] `pnpm test:db` green (month-boundary sum test, against the compose Postgres)
- [x] Manual: set `LLM_MONTHLY_BUDGET_USD` to a value already exceeded by
      Phase 3's live-test spend (or send messages until it is), restart,
      message the bot → readable "out of budget" reply, no stack trace in
      `docker compose logs`
- [x] Confirm via `psql` that no new `llm_usage` row was written for the
      rejected call (the ceiling really did stop the spend, not just the reply)

**Execution notes (deviations from the plan as written):**

- **This phase's File-changes table was stale, and the first implementation
  shipped a ceiling that enforced nothing.** The table predates Phase 3, which
  moved adapter construction out of `boot.ts` into
  `apps/hermes/src/llm/build-llm-provider.ts`. Commit `40bca81` therefore built
  the whole budget mechanism, passed every test, and never wired it to the
  running bot — `buildLlmProvider` constructed the adapter with no `budget`, so
  the real Telegram path had zero enforcement. The implementing agent was right
  to stop at the file list rather than widen it; the orchestrator authorized the
  expansion, and `dd69545` closed it. Worth recording because the phase looked
  complete and green at the point where it was still entirely inert.
- **`usageRepo` and `budget` are now required adapter options, not optional.**
  The Steps called for this ("mandatory, not optional-with-a-silent-no-op
  default") and `40bca81` shipped `budget?` with an `if (opts?.budget)` guard,
  which leaves the ceiling bypassable by omission — the same silent-money-hole
  shape Phase 3's review had already raised about `usageRepo`'s no-op default.
  Both were made required together in `dd69545`, across ~26 call sites. `logger`
  stays optional: its only effect is a diagnostic warn, so omitting it cannot
  cost money.
- **`DEFAULT_LLM_MONTHLY_BUDGET_USD = 1_000_000` was reviewed and kept.** It
  looks like a silent hole but is not: compose passes an unset host var as `""`,
  which `z.coerce.number()` reads as `0` and `.positive()` rejects loudly, so a
  real deployment cannot fall through to it. The default only serves callers
  that do not touch the budget feature.
- **Test fixture rows reached the app database and were counted as real spend.**
  A `provider: "p", model: "m1", cost_usd: 0.005` row from
  `llm-usage-repo.test.ts` was found in the `hermes` database, accounting for
  92% of the month's apparent spend ($0.005424 reported vs. $0.000424 real). A
  `test:db` run had been pointed at the app database instead of the scratch one.
  This is a budget-integrity defect, not just untidy data: the ceiling reads
  whatever `recordUsage` wrote, so any stray test run permanently lowers the
  effective cap in real dollars with nothing reporting it. The row was deleted
  and `db-env.ts` now refuses to run when `TEST_DATABASE_URL` equals
  `DATABASE_URL` or names a database not ending in `_test` — two independent
  checks, throwing rather than skipping, since a silent skip is how the
  misconfiguration survived unnoticed the first time.
- **The store suite is only deterministic under `--no-file-parallelism`.** Run
  in parallel, the two `llm_usage`-touching files race and fail 25/25; serially
  they pass 25/25. The flag was added to both `test` and `test:db` and is
  load-bearing, not a tuning preference.
- **A pre-existing flake in `sumCostSince` was diagnosed and fixed.** `since`
  came from `new Date()` while `created_at` defaults to Postgres `now()` — a
  different clock — so roughly 1 run in 20 dropped the first row from the sum
  (expected 0.003, got 0.002). `since` is now backdated one second; the window
  under test is minutes wide. The new month-boundary test injects every
  timestamp and never had the problem.
- **Manual verification, performed live by the orchestrator.** With the cap at
  `1e-7` and $0.005424 already recorded, two Telegram messages both received
  "Hermes is out of budget for this month. Please try again after the monthly
  reset." The `llm_usage` count did not move (3 rows, unchanged), proving the
  ceiling stopped the spend and not merely the reply, and the logs carried a
  structured `capUsd`/`spentUsd` error line with no stack trace and no figures
  leaked to chat. Restoring the cap to `5` and messaging again produced a normal
  answer and a new usage row (+$0.000128) — the ceiling releases rather than
  permanently wedging the bot.
- **Two `.env` files exist and only one is read.** The worktree's `.env` is
  gitignored and does not track the repo root's; editing the root copy has no
  effect on the running bot. Separately, `docker compose restart` re-reads
  neither `.env` nor rebuilt code — the container under test was built before
  this phase existed, so `docker compose up -d --build` is required for any
  manual verification of new behavior to mean anything.
- **Code review: green, no blocking findings.** Four nits, all fixed: the stale
  `.env.example` comment, the unexported `BudgetUsageRepo` type, the
  `sumCostSince` flake above, and the missing `.ai/` sync.

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: monthly budget ceiling with typed BudgetExceededError`
- [x] Phase marked complete

---

### Phase 5: Dedupe + abortable shutdown

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** Closes the ordering-tension gap flagged in `Dependencies
& Risks`. **Two labeled proofs, not buried bullets:** (1) feeding the
identical Telegram update through the completion handler twice results in
exactly one provider call and exactly one `llm_usage` row, with the
uniqueness enforced by a Postgres constraint; (2) a `SIGTERM` during an
in-flight completion call aborts the underlying `fetch` promptly via
`AbortSignal`, and the redelivered update on restart correctly short-circuits
through the dedupe key rather than paying twice. Both proofs run as automated
`pnpm test:db` integration tests against a real Postgres, including a
simulated crash-window scenario (see the accepted-risk write-up in Steps) —
nothing in this phase depends on a human eyeballing a live crash or a log
line, which is what makes `afk` correct here.
**Why `afk` (was `hil` in an earlier draft):** every proof this phase makes —
the exact-duplicate case, the crash-window retry case, and the abort-signal
behavior — is expressible as a deterministic `test:db`/unit assertion against
fakes and a real scratch Postgres. Unlike Phase 2/3, nothing here requires
live LLM credentials or spends real money; a subagent can implement, run, and
verify all of it unattended. The one genuinely live check (`docker compose
kill hermes` against a real running container) is a nice-to-have sanity
check, not this phase's proof — it moves to Phase 6's Final Verification,
which is `hil` regardless.
**Commit message:** `feat: dedupe LLM calls by Telegram update_id, abortable shutdown`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/store/src/migrations/003_llm_dedupe.sql` | `llm_dedupe(dedupe_key text primary key, status text not null default 'pending', result_text text, created_at timestamptz not null default now(), completed_at timestamptz)` |
| create | `packages/store/src/llm-dedupe-repo.ts` | `claim(pool, dedupeKey)` — `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key`; row returned → `{status:"claimed"}`; else `SELECT status, result_text` → `status:"completed"` returns the stored `resultText`, `status:"pending"` (crash-window case) returns `{status:"claimed"}` again, allowing one retry — see the labeled accepted-risk write-up in Steps for why this is the deliberate, correct behavior, not a bug. `complete(pool, dedupeKey, resultText)` — `UPDATE ... SET status='completed', result_text=$2, completed_at=now()` |
| create | `packages/llm/src/errors.ts` (extend) | `LlmAbortedError` — thrown when the externally-supplied shutdown `signal` (not the adapter's own per-request timeout) fires; distinct from `LlmTimeoutError` so a caller can tell "shutdown asked us to stop" from "the adapter gave up waiting on the provider" |
| create | `packages/llm/src/dedupe/dedupe-repo-port.ts` | **not** used by `packages/llm` — dedupe is an application-level concern per decision (the handler owns claiming, not the adapter). This file is only the shared TS shape re-declared for `apps/hermes` to import cleanly; if that turns out redundant with a type already in `packages/store`, keep the definition in `packages/store` instead and drop this file (call this out to the reviewer) |
| modify | `packages/channels/src/channel.ts` | widen `InboundMessage` to add `updateId: number` |
| modify | `packages/channels/src/telegram/poller.ts` | `normalizeTelegramUpdate` populates `updateId` from `update.update_id` |
| modify | `apps/hermes/src/handlers/complete.ts` | derive `dedupeKey = \`telegram:${message.updateId}\``; call `dedupeRepo.claim(dedupeKey)` **before** `llmProvider.complete()`; on `{status:"completed"}` reply with the stored `resultText` directly, skip the provider call entirely; on `{status:"claimed"}` proceed, then call `dedupeRepo.complete(dedupeKey, resultText)` after a successful reply |
| modify | `apps/hermes/src/boot.ts` | create one boot-lifetime `AbortController`; pass `controller.signal` into `createOpenAiCompatibleAdapter`'s options; on the existing shutdown sequence, call `controller.abort()` as part of the drain step (before `pool.end()`, alongside the existing `channel.stop()` bound) |
| modify | `packages/llm/src/adapter/openai-compatible.ts` | accept an optional `signal: AbortSignal` in adapter options, pass it into the per-request `fetch`/`AbortController` composition (combine with the existing per-request timeout abort, not replace it); on abort, inspect **which** signal fired — the external shutdown `signal` throws `LlmAbortedError`, the adapter's own per-request timeout still throws `LlmTimeoutError` — so a crash between claim and complete (see Steps) is distinguishable in logs from an ordinary provider-side timeout |
| modify | `packages/store/README.md` | document `llm_dedupe`'s three states and why the pending-state retry is an accepted, narrow residual risk, not a full solve — mirroring how `telegram_offset`'s at-least-once contract is documented today |
| modify | `packages/channels/README.md` | document the new `updateId` field on `InboundMessage` and that it exists specifically so paid handlers can derive a dedupe key — echo/`/ping`/`/start` remain unaffected, still safe by inspection |
| modify | `apps/hermes/package.json` | add a `test:db` script — this phase is the first to put `test:db` files under `apps/hermes`, and that package has none. Mirror `packages/store`'s exactly, including `--no-file-parallelism` and the guard that refuses to start when `TEST_DATABASE_URL` is unset. The root `test:db` is recursive (`pnpm -r --workspace-concurrency=1 run test:db`), so adding the script is sufficient — no root change. Serial is load-bearing, not tuning: these files share one database with the store's, and in parallel the `llm_usage`-touching files fail every run |

**Steps:**

- [x] **Wire both mechanisms into the real paths, and pin each with a test
      that fails if the wiring is dropped.** Phase 4 shipped a complete,
      fully-tested budget ceiling that enforced nothing for one commit,
      because the adapter it was built into was never handed the option in
      `build-llm-provider.ts` — every test passed against a mechanism the
      running bot did not use. The same trap is open twice here: dedupe is
      worthless unless the *real* completion handler claims before calling,
      and the `AbortSignal` is worthless unless the *real* shutdown sequence
      aborts the controller. A green suite is not evidence either one is
      connected; a test that would go red if the wiring vanished is. Note
      also that `usageRepo` and `budget` are **required** adapter options as
      of Phase 4 — any new `createOpenAiCompatibleAdapter` call site must
      supply both
- [x] Migration `003_llm_dedupe.sql`
- [x] `claim`/`complete` in `llm-dedupe-repo.ts`: the `INSERT ... ON CONFLICT
      DO NOTHING RETURNING` pattern is what makes the uniqueness a Postgres
      guarantee, not an application race — two concurrent claims for the same
      key can only ever have one winner, enforced by the primary key
      constraint itself, not by application logic checking-then-inserting
- [x] Widen `InboundMessage`/poller exactly as scoped by decision: add
      `updateId`, nothing else. Echo/`/ping`/`/start` handlers are unaffected
      (they simply ignore the new field) — do not retrofit dedupe onto them,
      out of scope, invariant #4 has applied to them by-inspection since
      Phase 1 of `00-skeleton` and that reasoning still holds (no paid or
      external-write side effect)
- [x] Handler ordering, load-bearing: `claim()` → (if claimed) `complete()` →
      (if over budget, budget check still runs first inside the adapter) →
      reply → `dedupeRepo.complete()`. Getting `complete()` (the dedupe
      write) before the reply is sent would mark a call "done" that the user
      never actually received; getting it after is correct — a crash between
      reply-sent and dedupe-write-recorded leaves the row `pending`, which is
      exactly the documented residual retry case, not a new failure mode
- [x] **Accepted risk, named and deliberate — the claim-to-complete crash
      window:** the exact window is between `dedupeRepo.claim()` returning
      `{status:"claimed"}` and the later `dedupeRepo.complete()` call landing
      (i.e. any crash while a claimed row is still `pending`: mid-provider-call,
      mid-reply-send, or between reply-send and the `complete()` write). On
      restart, the redelivered update's `claim()` call sees `pending` and
      returns `{status:"claimed"}` again — **the retry proceeds and may issue
      a second real paid call.** This is the one case in this phase that does
      not fully eliminate a possible double-charge, and it is intentionally
      **fail-open (retry), not fail-closed (permanently block).** Rationale,
      stated plainly: a chat assistant that permanently wedges a user's
      message because of a bounded, rare crash-timing race is a worse outcome
      than a bounded, rare, low-dollar double-charge (single-shot completion,
      capped by `MAX_TOKENS_PER_TURN` and the monthly budget ceiling either
      way) — silently and permanently dropping a message the user is waiting
      on has no recovery path from the user's side, while a duplicate reply
      is at worst annoying and self-evidently visible. This is **narrower and
      fundamentally different** from the exact-duplicate-delivery case
      (identical `updateId` redelivered after `complete()` already landed),
      which this phase's Postgres `UNIQUE`/primary-key constraint on
      `dedupe_key` closes **deterministically** — that case can never produce
      a second provider call, proven by the `complete-dedupe.test.ts` test
      below. The crash-window case is a narrower, probabilistically-rare,
      explicitly-accepted residual, proven *not to permanently block* (not
      proven to fully prevent a duplicate call) by
      `complete-dedupe-crash-window.test.ts`. **What would close this gap
      later, as a forward-looking non-task, not built here:** a finer-grained
      `llm_dedupe` schema — e.g. an `attempt` counter or a richer status enum
      (`pending` → `provider_called` → `completed`) — that lets a resumed
      process distinguish "claimed but the provider was never called" from
      "the provider call was actually issued and may have succeeded" before
      deciding to retry, enabling true exactly-once completion detection
      instead of today's at-most-one-retry-on-crash behavior
- [x] `AbortSignal` wiring: one controller for the process lifetime (the
      poller is serial — never more than one in-flight completion call at a
      time — so a single shared controller is sufficient, no per-request
      controller needed). Combine with the adapter's existing per-request
      timeout `AbortController` via composition (e.g. abort whichever fires
      first), not by replacing the timeout mechanism
      **Superseded (03-agent-core):** `c5be8b6` made message-update dispatch
      in `packages/channels/src/telegram/poller.ts` concurrent, so "the
      poller is serial — never more than one in-flight completion call at a
      time" is no longer true. See
      `.ai/decisions/poller-concurrent-message-dispatch.md`. The one shared
      process-lifetime `AbortController` is still correct — that decision
      confirms it — only the serial-poller premise above is false; left
      as-is rather than edited, per this plan's own historical-record rule
- [x] Confirm `DRAIN_TIMEOUT_MS`/`HARD_EXIT_TIMEOUT_MS` are **not** changed —
      per `Dependencies & Risks`, correctness here comes from dedupe on
      redelivery, not from extending the drain window
- [x] Document the residual pending-state risk explicitly in
      `packages/store/README.md`, matching the project's existing pattern of
      writing down accepted gaps rather than hiding them (see
      `telegram-long-polling-correctness.md`)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/llm/src/adapter/__tests__/openai-compatible-abort.test.ts` | passing a pre-aborted external shutdown `signal` into the adapter aborts the `fetch` call and throws `LlmAbortedError`; separately, a per-request timeout still throws `LlmTimeoutError` on the same adapter instance — asserting the two are **distinct error classes**, not conflated, so log-based diagnosis can tell shutdown from an ordinary provider timeout |
| create (test:db) | `packages/store/src/__tests__/llm-dedupe-repo.test.ts` | integration, gated on `TEST_DATABASE_URL`: first `claim` on a key returns `claimed`; a second `claim` on the same key while still `pending` also returns `claimed` (documented retry case); after `complete()`, a further `claim` returns `completed` with the stored `resultText`; a raw duplicate `INSERT` on the same `dedupe_key` (bypassing `claim`'s `ON CONFLICT`) is rejected by the primary-key constraint itself — proves the uniqueness is DB-enforced, not application-only |
| create (test:db) | `apps/hermes/src/handlers/__tests__/complete-dedupe.test.ts` | **the exact-duplicate-delivery proof the requester called out by name, deterministic:** builds a real completion handler wired to a real Postgres-backed `llm-dedupe-repo` and `llm-usage-repo` (via `TEST_DATABASE_URL`) and a **fake** `LlmProvider` (call-counting spy, no live network); feeds the identical `InboundMessage` (same `updateId`) through the handler **twice, after the first call has fully completed**, sequentially; asserts the fake provider's `complete()` was called **exactly once** and exactly **one** `llm_usage` row exists for that dedupe key afterward — the Postgres `UNIQUE` constraint makes this case unconditional, not probabilistic |
| create (test:db) | `apps/hermes/src/handlers/__tests__/complete-dedupe-crash-window.test.ts` | **the crash-window accepted-risk proof, automated (replaces the manual `docker compose kill` step):** claims a `dedupeKey` via `dedupeRepo.claim()` directly (simulating "claimed, provider call started") **without** calling `dedupeRepo.complete()` (simulating the crash before completion is recorded); then runs the completion handler for the same `updateId` again against the fake `LlmProvider`; asserts (1) the retry is **not permanently blocked** — the fake provider **is** called and the user gets a real reply, proving fail-open works as designed, and (2) after that retry, `dedupeRepo.complete()` succeeds and a subsequent third delivery of the same `updateId` correctly short-circuits via the now-`completed` row, calling the fake provider **zero** further times |
| create | `apps/hermes/src/__tests__/shutdown-abort.test.ts` | automated, no real `SIGTERM`/Docker: directly invokes the registered shutdown sequence (same harness pattern as `00-skeleton`'s `shutdown-order.test.ts`) with a fake in-flight completion call holding the boot-lifetime `AbortController`'s signal; asserts `controller.abort()` fires as part of the drain step, strictly before `pool.end()` |

**Verification:**

- [x] `pnpm test` green (includes the abort-vs-timeout error-type distinction
      test and the automated `shutdown-abort.test.ts`)
- [x] `pnpm test:db` green — including both dedupe proofs above:
      `complete-dedupe.test.ts` (the exact-duplicate case, deterministic,
      **this is the concrete test the requester called out by name; a passing
      result here, not application-level reasoning, is what closes the
      invariant #4 gap this PRD exists to close**) and
      `complete-dedupe-crash-window.test.ts` (the accepted-risk case: retry
      succeeds, no permanent block)
- [x] All of the above run unattended — no live Docker kill, no human
      watching a log line, is required for this phase's proofs. (The one
      live, real-process `docker compose kill hermes` sanity check is a
      `hil` cross-check performed once in Phase 6's Final Verification, not a
      requirement of this phase.)

**Code-review resolution (2026-08-26):** first pass on `b3f19e8` returned
**yellow** with two blocking findings, both instances of the Phase-4 trap this
phase's first Step warns about: (1) `dedupeRepo` and `controller` shipped as
*optional* parameters, so deleting either wiring line in `boot.ts` left the
suite green; (2) `updateId` shipped optional on `InboundMessage` instead of the
required `number` this phase scoped, letting every keyless message collapse onto
a single `telegram:undefined` dedupe key — a silent cross-chat reply leak.
Both fixed in `a717798`, which makes each dependency required (deleting either
`boot.ts` wire is now a `TS2345` typecheck failure, verified empirically by the
reviewer) and `updateId` a required `number`. Two nits fixed in the same commit:
the duplicate `LlmDedupeClaimResult` declaration resolved the way this phase's
File-changes table anticipated — `packages/llm/src/dedupe/dedupe-repo-port.ts`
deleted, the `@hermes/store` definition kept as the single source, with
`LlmDedupeRepo` declared next to its consumer in `complete.ts` per the codebase's
existing port-next-to-consumer pattern; and `--no-file-parallelism` added to
`apps/hermes`'s `test` script, since store and hermes test files share one
database and the `llm_usage` row-count assertion races otherwise. Re-review
verdict: **green**, with one stale-doc nit (`packages/channels/README.md` still
described `updateId` as optional), fixed by the orchestrator in the same commit
as these checkbox updates.

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
      — satisfied by `/execute-prd`'s dispatch route instead of a pasted prompt:
      the `code-reviewer` agent ran in its own fresh, clean context, which is the
      guarantee the handoff prompt exists to provide
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
      — not applicable for the same reason; the reviewer's context was fresh by
      construction, so no `/clear` was needed
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: dedupe LLM calls by Telegram update_id, abortable shutdown`
- [x] Phase marked complete

---

### Phase 6: Final Verification

**Mode:** hil
**Type:** mixed

**Overall success criteria:**

- Texting the bot produces a real LLM reply (not an echo), through whichever
  provider is currently configured in `LLM_PRIMARY_*`.
- Swapping `LLM_PRIMARY_BASE_URL`/`_API_KEY`/`_MODEL` from Gemini to DeepSeek
  values and restarting changes which provider answers, with no code change —
  this PRD's first exit-criterion clause, verified concretely here (not just
  asserted by earlier phases' env choices).
- The §8 tool-calling check has run against the real adapter and its result
  (including the Gemini-quirkiness contingency decision) is recorded in
  `.ai/decisions/d5-deepseek-primary-gemini-fallback.md` — this PRD's second
  exit-criterion clause.
- Usage rows record cache-hit tokens distinctly, proven against real
  provider-reported numbers (Phase 3's live test).
- A low budget cap produces a readable "out of budget" chat message, and no
  further spend occurs once breached.
- An identical Telegram update processed twice results in exactly one
  provider call and exactly one usage row, enforced by a Postgres constraint.
- A `SIGTERM` during an in-flight completion call aborts promptly instead of
  orphaning the request.
- No CLAUDE.md invariant is violated: thin entry points, no dead code, small
  functions, comments explain *why* not *what*.
- `packages/llm` depends on `@hermes/core` only — never `@hermes/config` or
  `@hermes/store` directly.

**Steps:**

- [x] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block, scoped to end-to-end review of Phases 1–5 together
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent reviews the entire change end-to-end
- [x] Any changes made in response to the final code-reviewer review reflected back into this plan file
- [ ] All tests pass: `pnpm test` (default, hermetic), `pnpm test:db` (gated on `TEST_DATABASE_URL`), `pnpm test:live` (gated on real credentials — confirm the default `pnpm test` and CI both genuinely exclude it)
- [x] No CLAUDE.md invariants violated
- [ ] Feature tested manually: golden path (real LLM reply, env-swap changes
      provider) + edge cases (budget breach, duplicate update from an
      allowlisted sender, unknown sender costs nothing, mid-flight SIGTERM)
- [ ] **Live crash-window sanity check (moved here from Phase 5, `hil`-only):**
      send a message, `docker compose kill hermes` while the completion call
      is in flight (before the reply arrives), `docker compose up -d hermes`
      — confirm the process recovers and exactly one reply eventually
      arrives, or note if the narrow, documented crash-window retry produced
      a second real call (Phase 5's accepted-risk write-up); either outcome
      is consistent with the documented risk and should be reported honestly.
      Separately, `docker compose stop hermes` while a completion call is in
      flight → logs show the `fetch` aborting promptly via `LlmAbortedError`,
      clean exit within the grace period
- [x] **Re-measure D5 — its recorded numbers are against a model that no
      longer exists.** `.ai/decisions/d5-deepseek-primary-gemini-fallback.md`
      records the §8 tool-calling result as 10/10 for `deepseek-chat`, which
      DeepSeek retired between Phase 2 and Phase 3 (`GET /v1/models` no longer
      lists it; the configured `LLM_PRIMARY_MODEL` is now
      `deepseek-v4-flash`). The decision to run DeepSeek primary therefore
      rests on evidence that cannot be reproduced. This phase's `pnpm
      test:live` re-fires that check against the models actually configured,
      so record the new numbers in D5 and mark the old table as superseded
      rather than leaving two results side by side. If the new measurement
      does not reproduce the original verdict, D5 itself is what needs
      revisiting — say so plainly instead of quietly keeping the conclusion.
      Note that the live run also rewrites Phase 2's tracked fixtures under
      `fixtures/recorded/`; decide deliberately whether to keep the new ones
      (they match the models in use) or revert them, and say which
- [ ] Overall success criteria met
- [x] `sync-knowledge` run to close out `.ai/` per the Knowledge Base Impact table below
- [ ] All phase checkboxes above are ticked

**Phase 6 execution notes (what was verified, deviated, and left open):**

- **Review mechanics deviated.** The end-to-end review of Phases 1-5 ran as a
  dispatched `code-reviewer` subagent with a clean context, not via a pasted
  handoff prompt into a `/clear`ed session. The review's *intent* was met; the
  two mechanics checkboxes stay unticked because the literal steps did not
  happen.
- **Review verdict: yellow, one blocking finding, since fixed.** The hermes DB
  suites had reimplemented `packages/store`'s `TEST_DATABASE_URL` resolver
  *without* its `assertNotTheAppDatabase` guard, while running
  `DELETE FROM llm_usage` - a mis-set `TEST_DATABASE_URL` would have wiped real
  spend history and silently reset the budget ceiling. Fixed in `b15523e` by
  sharing the guarded helper through a new `@hermes/store/testing` subpath
  export; both guard branches proven to throw before any pool or DELETE.
- **Two further defects found during the live run and fixed in `2464a26`:**
  the adapter read rate-limit retry hints only from the `Retry-After` header,
  which Google does not send (it returns `RetryInfo` in the error body), making
  the Gemini fallback unrecoverable under throttling; and the section 8 check
  scored any non-truncation throw as a hard failure, so a quota event was
  indistinguishable from a model-quality failure.
- **`No CLAUDE.md invariants violated` — resolved in `47de917`.** The review had
  flagged `apps/hermes/src/boot.ts` (~110 lines) and
  `apps/hermes/src/handlers/complete.ts` (~44 lines) as over the ~30-line
  guidance. Both were split into named steps by pure extraction, with boot and
  shutdown ordering byte-unchanged (`controller.abort()` still strictly before
  `channel.stop()` -> `lock.release()` -> `pool.end()`). `handleCompletion` is
  now 28 lines. `boot()` is 40, ~9 of them comments or blanks: the remainder is
  one line per documented boot step, and splitting the linear sequence further
  would hide the load-bearing order rather than clarify it. Recorded as a
  deliberate judgment call, not an oversight.
- **Two further review nits fixed in `2576601`.** The retry sleep ignored
  `externalSignal`, so honoring a provider's 429 hint raised the worst-case
  post-SIGTERM wait to the 30s cap while the in-flight call never surfaced
  `LlmAbortedError`. `delay()` now races the timer against the abort signal
  (both paths clean up, no listener leak per retry attempt), and
  `completeWithRetry` checks `externalSignal?.aborted` before any `instanceof`
  branch. Separately `packages/store`'s `files` array now includes
  `src/__tests__`, so it agrees with the `./testing` export subpath.
- **Deliberately NOT changed: `pricing.ts`'s unknown-model -> $0.** The review
  suggested failing boot instead. That behavior is a recorded decision in
  `.ai/decisions/llm-cost-accounting.md` ("unknown model -> warn + $0, never a
  throw"); reversing it belongs in its own change, not a pre-merge nit sweep.
- **Test lanes.** `pnpm test` (58 llm / 39 hermes / 21 store / core / config /
  channels - all green), `pnpm test:db` green, `pnpm typecheck` and
  `biome check` clean. The default `pnpm test` genuinely excludes the live lane
  (verified: the llm package collects 9 files, no `*.live.test.ts`). The
  "and CI" half of that clause is **vacuous - this repo has no CI**; there is no
  `.github/` directory. Worth a follow-up.
- **D5 re-measurement, partial.** `deepseek-v4-flash`: 10/10 accuracy, 0
  malformed, 0 truncated, 0 hard failures - the original verdict reproduces on
  the configured model, and the retired `deepseek-chat` table was deleted from
  D5 rather than left alongside. `gemini-3.6-flash`: **not measured.** 7 of 10
  trials returned HTTP 429 `RESOURCE_EXHAUSTED` (free-tier quota, limit 20); the
  3 that completed were clean but self-selected. D5 records no Gemini verdict
  from this run; the standing evidence remains the tracked `gemini-3.6-flash`
  fixtures.
- **Fixtures decision (`b3669e5`): asymmetric, deliberately.** The new
  `deepseek-v4-flash` primary recordings were kept (they finally retire the
  `deepseek-chat` evidence); the 10 fallback recordings were reverted to HEAD,
  because the live run captured quota errors rather than a measurement and the
  tracked ones are against the same model still configured.
- **Fallback path never exercised end to end.** The manual env-swap proved
  either provider works as *primary*. Whether Hermes fails over to the fallback
  profile is untested - consistent with this PRD shipping manual failover only
  (edit env, restart), but not evidence of failover working.

- **`All tests pass` is deliberately unticked.** `pnpm test` and `pnpm test:db`
  are green, but `pnpm test:live` **failed**: its Gemini column exhausted the
  free-tier quota (7/10 trials HTTP 429), and the run exits non-zero. The
  hermetic and DB lanes pass; the live lane does not currently pass end to end.
- **Manual verification, what the orchestrator actually ran.** Confirmed by the
  operator against the live bot: golden path (real LLM reply, not an echo),
  non-allowlisted sender gets no reply and costs nothing, group chat behaves,
  budget ceiling enforced, and the provider env-swap works in both directions.
- **Two live checks NOT performed.** The mid-flight `SIGTERM` abort
  (`docker compose stop hermes` -> `LlmAbortedError`, clean exit in the grace
  period) and the crash-window sanity check (`docker compose kill hermes`
  mid-flight -> recover, count replies and `llm_usage` rows) were **not run**.
  Both behaviors are covered by passing automated tests
  (`shutdown-abort.test.ts`, `shutdown-order.test.ts`,
  `complete-dedupe-crash-window.test.ts`), but neither was exercised against a
  real container. Recorded as a known gap, not as a passed check.
- **`Overall success criteria met` is unticked for the same reason.** Every
  criterion is satisfied except the two shutdown behaviors above, which are
  verified in tests but unverified in deployment.
- **The end-to-end code review predates the last four commits.** It covered
  Phases 1-5 as of `251523b`; `b15523e`, `b3669e5`, `e72bb05`, `2464a26` and
  `2e69a21` landed after it. The adapter retry path and the section 8 scoring
  changes in `2464a26` have not been reviewed by a second pass.

## Documentation

| Change | Documentation location |
|---|---|
| `LlmProvider` port, adapter behavior, error types, tools-unused-until-2c note | `packages/llm/README.md` |
| Provider-neutral `Message`/`ToolCall`/`ToolResult`/`Usage` types, promoted `nextDelay` | `packages/core/README.md` |
| `llm_usage`/`llm_dedupe` table shapes; the claim-to-complete crash window as a named, accepted, fail-open-not-fail-closed risk (distinct from the DB-enforced exact-duplicate case) | `packages/store/README.md` |
| `InboundMessage.updateId` field, why it exists, non-effect on existing handlers | `packages/channels/README.md` |
| New `LLM_*` env vars, provider-profile validation rule, budget cap var | root `README.md`, `.env.example` |
| Boot wiring order for `llm`, `AbortController` in shutdown | `apps/hermes/README.md` |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `index.md` | update | new `packages/llm` row (provider port + adapter, the only package that talks HTTP to a model provider); note on `core`'s expanded scope (types + backoff) |
| `architecture.md` | update | dependency diagram gains `llm → core`; boundary note that `llm` never imports `config`/`store`; data flow: Telegram → `channels` (now carrying `updateId`) → completion handler → `llm` (budget check → dedupe-aware call) → `store` |
| `decisions/d5-deepseek-primary-gemini-fallback.md` | create | D5 write-up with the §8 check's actual measured result and the Gemini-native-adapter contingency outcome (this PRD's one decision doc — D1/D2 belong to 03-agent-core/02-telemetry and are not written here) |
| `decisions/telegram-long-polling-correctness.md` | update | note that `InboundMessage` now carries `updateId`, and that the at-least-once contract now has one consumer (the completion handler) with a real dedupe key, closing the gap the original doc flagged as future work; record the claim-to-complete crash window as a named accepted risk (fail-open retry, not fail-closed block) alongside the deterministic exact-duplicate case, and the forward-looking non-task that would close it (an `attempt`/finer-status column enabling exactly-once completion detection) |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | promoted backoff helper | `packages/core/src/__tests__/backoff.test.ts` |
| Phase 1 | OpenAI-compatible adapter: request shape, retries, timeout, malformed response, key redaction | `packages/llm/src/adapter/__tests__/openai-compatible.test.ts` |
| Phase 1 | provider-profile config validation (primary required, fallback all-or-none) | `packages/config/src/__tests__/schema.test.ts` |
| Phase 1 | env → `ProviderProfile` mapping | `apps/hermes/src/llm/__tests__/build-provider-profiles.test.ts` |
| Phase 1 | completion handler happy path + generic error fallback | `apps/hermes/src/handlers/__tests__/complete.test.ts` |
| Phase 1 | **invariant #1: unknown sender never reaches the paid handler (zero provider calls)** | `apps/hermes/src/__tests__/dispatch-allowlist-gates-llm.test.ts` |
| Phase 2 | §8 check, live, 10 trials/provider against the concrete numeric trigger | `packages/llm/src/__tests__/live/tool-calling-check.live.test.ts` |
| Phase 2 | §8 check, offline fixture replay | `packages/llm/src/__tests__/tool-calling-check-fixture-replay.test.ts` |
| Phase 3 | pricing table + unknown-model warning | `packages/llm/src/__tests__/pricing.test.ts` |
| Phase 3 | adapter records usage on success only | `packages/llm/src/adapter/__tests__/openai-compatible-usage.test.ts` |
| Phase 3 | usage repo round-trip incl. cache-hit column (DB) | `packages/store/src/__tests__/llm-usage-repo.test.ts` |
| Phase 3 | **invariant #6: real cache-hit token counts across a stable prefix (live)** | `packages/llm/src/__tests__/live/cache-hit-tokens.live.test.ts` |
| Phase 4 | budget cap resolver | `packages/llm/src/budget/__tests__/resolve-budget-cap.test.ts` |
| Phase 4 | budget check under/over cap | `packages/llm/src/budget/__tests__/check-budget.test.ts` |
| Phase 4 | over-budget short-circuits before `fetch` | `packages/llm/src/adapter/__tests__/openai-compatible-budget.test.ts` |
| Phase 4 | month-boundary UTC sum (DB) | `packages/store/src/__tests__/llm-usage-repo-month-boundary.test.ts` |
| Phase 4 | handler replies with budget-specific message | `apps/hermes/src/handlers/__tests__/complete.test.ts` |
| Phase 5 | external shutdown abort vs. per-request timeout — distinct error classes (`LlmAbortedError` vs `LlmTimeoutError`) | `packages/llm/src/adapter/__tests__/openai-compatible-abort.test.ts` |
| Phase 5 | dedupe repo claim/complete states + PK-enforced uniqueness (DB) | `packages/store/src/__tests__/llm-dedupe-repo.test.ts` |
| Phase 5 | **invariant #4: identical update twice (after completion) → one provider call, one usage row, DB-enforced, deterministic (DB)** | `apps/hermes/src/handlers/__tests__/complete-dedupe.test.ts` |
| Phase 5 | **accepted risk, automated: claim-to-complete crash window → retry succeeds, never permanently blocked (DB)** | `apps/hermes/src/handlers/__tests__/complete-dedupe-crash-window.test.ts` |
| Phase 5 | automated shutdown-abort ordering (`controller.abort()` before `pool.end()`), no live SIGTERM needed | `apps/hermes/src/__tests__/shutdown-abort.test.ts` |

## Human Summary

This plan gives Hermes a brain's plumbing without yet giving it the brain's
loop. It starts by wiring a real, provider-neutral LLM port and one
OpenAI-compatible adapter, then swaps the Phase-1 echo bot for a one-shot
completion handler — the smallest possible proof that a Telegram message can
reach a real model and come back with a real answer, with primary and
fallback provider profiles validated at boot so an env-var swap really does
change providers. Next, rather than treat the DeepSeek-vs-Gemini tool-calling
comparison as a throwaway benchmark, it runs that check live against the real
adapter as this phase's second task — its result becomes a permanent decision
record and, if Gemini's compatibility layer proves quirky, triggers a small,
contained native adapter rather than a redesign. The plan then earns the
project's central cost lever: usage accounting that tracks cache-hit tokens
separately and proves, against real provider numbers, that the
`tools`→`system`→`messages` ordering actually produces cache hits — not just
that the JSON looks right. A monthly budget ceiling turns "the bill could run
away" into a typed error and a readable chat message. Finally, because an LLM
call is Hermes's first side effect that costs real money, the plan closes a
gap the skeleton phase left open by design: a Telegram update's `update_id`
becomes a real, Postgres-enforced dedupe key, so an exact-duplicate delivery
can no longer double-charge — a real, deterministic test proves it, not
another "safe by inspection" note. A second, narrower trade-off is named
explicitly rather than buried: the brief window between claiming a message
and recording its completion is deliberately fail-open (retry) rather than
fail-closed (permanently drop the user's message), because wedging a
conversation forever is worse than a rare, bounded, low-dollar duplicate call
— and that "retry, never permanently blocked" behavior is itself proven by an
automated test, not just asserted in prose. The one accepted trade-off at the
plan-ordering level, also stated plainly: because dedupe lands in the last
implementation phase, the four phases before it carry a narrow, low-volume,
development-only double-charge risk, judged worth it for the sake of proving
the env-swap and cache-hit invariants early against the real adapter. The
bounded agentic loop, the approval gate, and `/stats` are deliberately not
here — they're `agent`'s job (2c) and `telemetry`'s job (2b), both PRDs that
plug into the port this one builds.
