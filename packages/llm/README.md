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
present) -> `system` -> `messages` -> `max_tokens`: `tools`/`system` sit
ahead of the per-call `messages` deliberately (invariant #6 establishes the
ordering here; Phase 3 proves it against real cache-hit numbers).

Retry/timeout policy mirrors `packages/channels/src/telegram/client.ts`'s
`callWithRetry`, reusing `@hermes/core`'s `nextDelay`:

- `429` — bounded retries, backoff via `nextDelay`.
- `5xx` or a network/timeout failure — bounded retries, exponential backoff.
- Any other non-ok status — thrown immediately as `LlmHttpError` (carries
  `status`), not retried.
- Per-request timeout via an internally-owned `AbortController` +
  `setTimeout`; firing throws `LlmTimeoutError`. Retries resend the
  identical request body.
- An HTTP-200 body that isn't valid JSON, or is valid JSON missing `text` or
  a well-formed `usage` block, throws `LlmMalformedResponseError` — never a
  silent partial success. A missing `usage` in particular is never defaulted
  to zero: that would let a later phase record zero cost for a real, billed
  call.
- Every thrown error's message is redacted so the API key never appears in
  it, including on the network-failure path.

## Errors

`src/errors.ts`: `LlmTimeoutError`, `LlmHttpError` (`status`),
`LlmMalformedResponseError` — typed subclasses, no `Result<T,E>` in this
package (this package throws, per project convention). `LlmTimeoutError` is
distinct from `LlmAbortedError` (Phase 5): "the adapter itself gave up
waiting" vs. "the process was asked to shut down mid-call".

## Max tokens

`src/max-tokens.ts` exports `MAX_TOKENS_PER_TURN` (1024) — invariant #9's
max-tokens-per-turn guard, a named constant so a later phase can override it
per-tool without re-deriving the value.

## Dependencies

`@hermes/core` only. Deliberately **not** `@hermes/config` (env/config
shape is boot's concern, mapped in `apps/hermes`) or `@hermes/store`
(persistence arrives as an injected port in Phase 3) — this package must
stay testable without a real env or database.
