# @hermes/llm

Provider-neutral LLM port plus one adapter: an OpenAI-compatible
`chat/completions` client over raw `fetch`. No vendor SDK — the adapter
speaks two things (`complete`, error mapping), which doesn't justify a
mega-package.

## Port contract

`src/port.ts`:

- `ProviderProfile { baseUrl, apiKey, model }` — the adapter's own
  construction input. Owned by this package, not `@hermes/core`: it's not a
  provider-neutral domain type `store`/`agent` need to share, it's `llm`'s
  own adapter-construction shape. `@hermes/config` never constructs one
  itself — `apps/hermes/src/llm/build-provider-profiles.ts` is the one place
  that maps `Env`'s flat `LLM_PRIMARY_*`/`LLM_FALLBACK_*` fields into it.
- `LlmProvider.complete(request: CompletionRequest): Promise<CompletionResult>`
  — `CompletionRequest = { model, system, messages, tools, maxTokens }`,
  `CompletionResult = { text, toolCalls, usage, finishReason }`. `Message`,
  `ToolCall`, and `Usage` come from `@hermes/core` — no vendor-shaped type
  ever escapes this package.
- `ToolDefinition` (a tool's name/description/JSON-schema parameters) is
  wire-format-complete in this phase — the adapter serializes `tools` and
  can parse `tool_calls` back out of a response — but has no real caller
  until `packages/agent` (2c) builds the bounded tool loop.

## OpenAI-compatible adapter

`createOpenAiCompatibleAdapter(profile: ProviderProfile, opts?)` posts to
`${profile.baseUrl}/chat/completions` with an `Authorization: Bearer
<apiKey>` header. Request body key order is `model` -> `tools` (when
present) -> `messages` -> `max_tokens`. OpenAI-compatible chat-completions
APIs (DeepSeek included) have no top-level `system` field, so the system
prompt is serialized as `messages[0]` with `role: "system"`, ahead of the
per-turn messages: `tools` (schema, most stable) -> system message (stable
per profile) -> variable per-turn messages (invariant #6 establishes the
ordering here; Phase 3 proves it against real cache-hit numbers).

Tool calling is the adapter's job on both sides of the wire. Outbound, each
port-level `ToolDefinition` is wrapped in the OpenAI envelope
`{ type: "function", function: { name, description, parameters } }` — posting
the bare port shape is rejected outright (DeepSeek: HTTP 400 "tools[0]: missing
field `type`"; Gemini's OpenAI-compatible endpoint: `Unknown name "name" at
'tools[0]'`). Inbound, `choices[0].message.tool_calls` is mapped back to
`ToolCall[]`, with each call's `arguments` string `JSON.parse`d — a parse
failure yields an empty argument object rather than throwing, leaving schema
enforcement to the caller. A tool-call reply carries `content: null`, which is
**not** malformed: the tool call is the message, and `text` is `""` for it.

Retry/timeout policy mirrors `packages/channels/src/telegram/client.ts`'s
`callWithRetry`, reusing `@hermes/core`'s `nextDelay`:

- `429` — bounded retries, backoff via `nextDelay`; the provider's
  `Retry-After` header (seconds) wins over the computed backoff when
  present, same as the Telegram client's `retry_after` handling. Google's
  Generative Language API sends no `Retry-After` header on a 429 at all — the
  adapter falls back to the body's `google.rpc.RetryInfo.retryDelay` detail
  (e.g. `"26.6s"`) instead. Either source is still capped by `nextDelay`'s
  usual ceiling.
- `5xx` or a network/timeout failure — bounded retries, exponential backoff.
- Any other non-ok status — thrown immediately as `LlmHttpError` (carries
  `status`), not retried.
- Per-request timeout via an internally-owned `AbortController` +
  `setTimeout`; firing throws `LlmTimeoutError`. Retries resend the
  identical request body.
- An HTTP-200 body that isn't valid JSON, or is valid JSON carrying neither
  `content` nor `tool_calls`, or missing a well-formed `usage` block, throws
  `LlmMalformedResponseError` — never a silent partial success. A tool-call
  reply with `content: null` is not that case; it is valid, and yields `text:
  ""`. A missing `usage` in particular is never defaulted
  to zero: that would let a later phase record zero cost for a real, billed
  call.
- Every thrown error's message is redacted so the API key never appears in
  it, including on the network-failure path.

## Errors

`src/errors.ts`: `LlmTimeoutError`, `LlmHttpError` (`status`, `retryAfter`),
`LlmMalformedResponseError`, `UnpricedModelError` (`model`) — typed
subclasses, no `Result<T,E>` in this package (this package throws, per
project convention). `LlmTimeoutError` is distinct from `LlmAbortedError`
(Phase 5): "the adapter itself gave up waiting" vs. "the process was asked
to shut down mid-call".

## Usage accounting

`Usage` (from `@hermes/core`) carries a `cacheHitTokens` field alongside
`promptTokens`/`completionTokens`/`totalTokens` — a subset of
`promptTokens`, not additional tokens. The adapter parses it from either wire
shape a provider might use: DeepSeek's own `usage.prompt_cache_hit_tokens`,
or the OpenAI-compatible `usage.prompt_tokens_details.cached_tokens` shape
Gemini's endpoint uses. Absent in both is a legitimate "no cache info" and
parses to `0` — only a missing `usage` block entirely is malformed (see
Errors above).

`src/pricing.ts` exports `MODEL_PRICING` (per-model
`{ inputPerMillionUsd, outputPerMillionUsd, cacheHitPerMillionUsd }` — the
cache-hit price is held as a published *rate*, not a multiplier off the input
rate: a multiplier has to be divided back out to check against a pricing page,
and doing that arithmetic hid a rounding error in every entry; verified
against each provider's own pricing page — see the file-level comment for
the "as of" date and sources) and `resolveCostUsd(model, usage)`. An unknown
model id throws `UnpricedModelError(model)` rather than returning `0` —
silent, uncounted `$0` on a real, billed call was the failure mode this
guards against, and a thrown error is louder than a log line that can go
unread. This is a deliberate reversal (`02-telemetry` Phase 4) of the
original "warn and cost `$0`" behavior; see
`.ai/decisions/llm-cost-accounting.md`.

`src/pricing.ts` also exports `assertModelsPriced(models: readonly
string[])` — pure and synchronous, throws `UnpricedModelError` naming the
first unpriced id it finds. `apps/hermes/src/boot.ts` calls it immediately
after config loads, before any DB or network I/O, against both
`LLM_PRIMARY_MODEL` and (when set) `LLM_FALLBACK_MODEL`, so a misconfigured
model refuses to boot instead of ever reaching `resolveCostUsd`'s throw on a
live, already-paid-for call. That throw is the deliberate backstop for a
model id that reaches `resolveCostUsd` by some route boot validation didn't
cover — not the routine case.

The provider's own `total_tokens` is authoritative: `resolveCostUsd` never
derives spend by summing `promptTokens + completionTokens` alone.
`gemini-3.6-flash` has been observed live returning `prompt_tokens: 10,
completion_tokens: 0, total_tokens: 27` — 17 billed reasoning tokens in
neither visible counter. `deriveBilledTokens(usage)` computes that
remainder (`reasoningTokens`, floored at 0) plus the non-cache-hit `miss`
portion of the prompt (`missTokens`), and prices `reasoningTokens` at the
output rate rather than dropping it.

`src/usage/usage-repo-port.ts` exports `LlmUsageRepo { recordUsage(entry):
Promise<void> }` and its `LlmUsageEntry` shape — a small injected port, not
a direct `@hermes/store` dependency, mirroring `packages/channels`'
`TelegramOffsetRepo`. `apps/hermes/src/boot.ts` wires it to `@hermes/store`'s
`recordUsage(pool, entry)`.

`createOpenAiCompatibleAdapter`'s `opts.usageRepo` is mandatory (`opts.logger`
stays optional, defaulting to a no-op — its only job is diagnostic warnings
(a dropped usage insert, a telemetry recorder that threw), so omitting it
can't silently disable spend tracking or the budget ceiling below).
`usageRepo` used to default to a no-op the same way, which meant a
construction site could forget to wire it and cost recording would simply,
silently stop happening — exactly the failure mode Phase 4's budget ceiling
depends on not existing, since the ceiling reads its "spend so far" from the
same recorded rows. Every caller, including every test, now wires an
explicit `usageRepo` (a real one or a fake). After every successful
`complete()`, the adapter resolves cost via `resolveCostUsd` and calls
`usageRepo.recordUsage(...)` before returning the result — a failed call
records nothing, since no tokens were billed. The recorded `provider` label
is the profile's `baseUrl` hostname (e.g. `api.deepseek.com`), derived
rather than hardcoded so a new host needs no code change here.

## Telemetry emission

`createOpenAiCompatibleAdapter`'s `opts.recorder?: TelemetryRecorder` (from
`@hermes/core`) is optional — this package stays usable with no telemetry
wired at all, unlike `usageRepo`/`budget` above. When supplied, `complete()`
emits exactly one `llm.call` event per call. `durationMs` starts immediately
after the budget check (nothing has been attempted yet); on the success path
it stops the moment `completeWithRetry` settles, so the `llm_usage` write that
follows is excluded from the latency number. On the failure path it is taken in
the `catch`, which means a failure raised *while* recording usage (the
`UnpricedModelError` case) includes that write's own time — an error's duration
is a diagnostic, not the latency metric `/stats` is built on.

- **Success:** fired after `recordCompletionUsage`, reusing the
  `LlmUsageEntry` it already built (`model`/`inputTokens`/`outputTokens`/
  `cacheHitTokens`/`costUsd`) rather than re-deriving those numbers a second
  time — one derivation, one source of truth. `error` is absent.
- **Failure:** fired with `costUsd: 0` and `error` set to the failure's
  message, then the original error is rethrown unchanged. The token fields
  depend on how far the call got, and the distinction matters:
  - *No response was ever produced* — `completeWithRetry` itself threw (HTTP,
    timeout, malformed response, abort). All numeric usage fields are `0`,
    because nothing was billed.
  - *The response arrived and the failure came afterwards, while recording it*
    — the `UnpricedModelError` path, where the HTTP call succeeded and only
    cost resolution failed. The event reports the **real billed tokens** from
    the completion's own usage block, still at `costUsd: 0`. Those tokens were
    genuinely charged; zeroing them would hide a paid call from `/stats`
    exactly when a pricing-table drift is the thing you need to see.
  - `errorEventTokens` is the one function that makes this choice.
- **Budget-ceiling rejection:** does **not** fire. `assertBudgetNotExceeded`
  throws before any provider call is attempted, so there is no duration or
  cost to attribute — a deliberate scope line, not an omission (see
  `plans/02-telemetry.md`).

`record()` itself is synchronous, non-blocking, and never throws (see
`@hermes/telemetry`'s README) — wiring it in here can never slow down or fail
a real completion, including after the recorder has been stopped.

## Budget ceiling

`src/budget/resolve-budget-cap.ts` exports `resolveBudgetCapUsd(env)`, the
single seam that reads the configured monthly cap — a future DB-backed or
per-tenant cap replaces only this function's body. `src/budget/check-budget.ts`
exports `assertBudgetNotExceeded(usageRepo, capUsd, clock)`, which sums spend
recorded since the start of the current calendar month **in UTC** (via the
injected `BudgetUsageRepo.sumCostSince`) and throws `BudgetExceededError`
when that sum meets or exceeds the cap.

`createOpenAiCompatibleAdapter`'s `opts.budget` (`{ usageRepo, capUsd, clock?
}`) is mandatory, for the same reason `usageRepo` above is: an
optional-with-a-silent-skip default would let any construction site —
production or test — bypass the ceiling without anyone noticing.
`apps/hermes/src/llm/build-llm-provider.ts` is the one production
construction site and wires `resolveBudgetCapUsd(config)` and a
`sumCostSince(pool, ...)`-backed `usageRepo` together; every test that
doesn't care about budget behavior passes an explicit, permissive cap
instead. The check runs as the very first thing `complete()` does, before
the request is built or `fetch` is issued — a breach must cost nothing, not
merely record nothing.

**Design note — granularity of "breached mid-conversation":** the check
gates the *next* call against spend already recorded, not against spend
still in flight. A call that passed the check and is executing when its own
cost would push cumulative spend over the cap still completes and is
recorded — the ceiling stops the *following* call, not that one. In 2a
(today's single-shot completion handler — no loop, no multi-call turn) this
window is exactly one call wide: cumulative monthly spend is bounded to
within one call's cost of the configured cap, never to an exact hard stop.
That is deliberate, not a bug. A 2c multi-call turn would revisit this if a
tighter, per-turn-aware cap is ever needed.

## Max tokens

`src/max-tokens.ts` exports `MAX_TOKENS_PER_TURN` (1024) — invariant #9's
max-tokens-per-turn guard, a named constant so a later phase can override it
per-tool without re-deriving the value.

## Dependencies

`@hermes/core` only. Deliberately **not** `@hermes/config` (env/config
shape is boot's concern, mapped in `apps/hermes`) or `@hermes/store`
(persistence arrives as an injected port in Phase 3) — this package must
stay testable without a real env or database.
