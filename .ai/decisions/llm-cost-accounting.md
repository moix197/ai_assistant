# LLM cost accounting — how a call becomes a priced `llm_usage` row

**Decision:** Every successful `complete()` writes one `llm_usage` row from
inside `packages/llm`'s adapter, priced by a flat in-repo table
(`packages/llm/src/pricing.ts`) rather than by anything the provider reports as
money. Persistence arrives through the injected `LlmUsageRepo` port, wired in
`apps/hermes/src/llm/build-llm-provider.ts`.

**Why:** the non-obvious parts are all in *which* numbers get billed, and each
one has a failure mode that is silent rather than loud.

- **`total_tokens` is authoritative — never `prompt + completion`.** A reasoning
  model can bill tokens that appear in neither visible counter.
  `gemini-3.6-flash` was observed live returning `prompt 10 / completion 0 /
  total 27`: 17 billed reasoning tokens invisible to both. `deriveBilledTokens`
  recovers them as `total - prompt - completion` (floored at 0) and prices them
  at the output rate. Summing the two visible counters silently undercounts
  every reasoning-model call, and reasoning models are the primary today.
- **`llm_usage.input_tokens` holds the cache-MISS portion only.**
  `cacheHitTokens` is already *inside* the provider's `prompt_tokens`, so
  storing the raw prompt count next to it would double count. Storing the miss
  makes the two columns additive: `input_tokens + cache_hit_tokens` recovers the
  raw prompt count exactly.
- **`MODEL_PRICING` carries DeepSeek's PEAK prices.** DeepSeek publishes a ~50%
  off-peak discount that the flat table shape deliberately does not model.
  Pricing high can only over-report spend — the safe direction for a budget
  ceiling.
- **An unknown model id throws `UnpricedModelError`; it no longer warns and
  costs `0`.** (Reversed by `02-telemetry` Phase 4 — see the entry it
  supersedes in Rejected below.) `0` for a genuinely billed call was invisible
  in the data — the drift it guards against is real, not hypothetical:
  `deepseek-chat` was retired by DeepSeek while still configured as
  `LLM_PRIMARY_MODEL`. The reversal is safe now because a new boot-time guard,
  `assertModelsPriced` (`apps/hermes/src/boot.ts`, called immediately after
  config loads), refuses to boot at all with an unpriced
  `LLM_PRIMARY_MODEL`/`LLM_FALLBACK_MODEL` — making `resolveCostUsd`'s throw a
  rare backstop (an id arriving by a route boot validation didn't cover)
  instead of a routine live-call hazard. `packages/llm/src/__tests__/pricing.test.ts`
  still validates `MODEL_PRICING`'s keys against the configured `LLM_*_MODEL`
  env vars when they are set; literal-key assertions alone could not have
  caught that retirement.
- **A `recordUsage` failure logs at `error` and continues.** By the time it runs,
  the provider call has succeeded and the tokens are already billed. Letting the
  insert's rejection propagate would cost the operator the *reply* on top of the
  lost row. The error line carries provider, model, all three token counts and
  the resolved cost, so a dropped row is reconstructable from logs.

**Rejected:**

- *Deriving spend from `prompt + completion`* — see the `gemini-3.6-flash` case
  above. It is the intuitive reading of the usage block and it is wrong.
- *Trusting a provider-reported cost field* — not offered uniformly across the
  OpenAI-compatible dialect the adapter speaks, and it would make cost
  unverifiable offline.
- *Time-of-day / off-peak pricing* — a second axis on a table that exists to be
  auditable at a glance, in exchange for an error that already biases safe.
- *Throwing on a failed usage insert* — trades a bookkeeping problem for a
  user-visible outage; the call already succeeded and was billed by that
  point, so the reply must not be discarded over a persistence failure.
- ~~*Throwing on an unknown model*~~ — **reversed by `02-telemetry` Phase 4.**
  Originally rejected as trading a bookkeeping problem for a user-visible
  outage, but that reasoning held only in the absence of boot-time
  validation. With `assertModelsPriced` refusing to boot on an unpriced
  `LLM_PRIMARY_MODEL`/`LLM_FALLBACK_MODEL`, throwing (`UnpricedModelError`)
  is now the safer default: it stops an unpriced model from ever quietly
  disabling the budget ceiling, and the live-call throw path it opens is a
  rare backstop, not the routine case.
- *`packages/llm` importing `@hermes/store`* — would put Postgres behind the
  provider port. The injected repo mirrors `channels`' `TelegramOffsetRepo`.

**Constraints it creates:**

- Adding or swapping a configured model means adding its `MODEL_PRICING` key in
  the same change, re-checked against the provider's live pricing page and
  stamped with the verification date in the file header. `pricing.test.ts` fails
  otherwise when the env vars are present.
- Usage is recorded once per logical `complete()`, from the adapter's success
  path only — never from `callOnce`/`completeWithRetry`, which run once per HTTP
  attempt. A retried call must not produce two rows.
- `usageRepo` is a **required** adapter option (as is `budget`) — it used to
  default to a no-op, which let a wiring path disable cost recording with
  nothing failing. `logger` still defaults to a no-op, so forgetting it costs
  only the usage-recording-failure and telemetry-drop warnings (the
  unknown-model case no longer warns — it throws, unconditionally on
  `logger`). That wiring lives in one tested place (`build-llm-provider.ts`);
  keep it there.
- These rows are what the monthly ceiling reads. Under-pricing a call does not
  just misreport — it raises the real spend the cap permits; see
  [monthly-budget-ceiling](monthly-budget-ceiling.md).
- New fields belong on `LlmUsageEntry` in `@hermes/core`, which both `llm` and
  `store` re-export, so the two sides cannot drift a field apart silently.
- `created_at` is stamped by Postgres `now()`, so it is on a different clock
  from any caller. A `sumCostSince` bound taken from a local `new Date()` can
  therefore land *after* a row the caller just wrote (~1 run in 20 in the repo
  suite before it was fixed). Harmless for the month ceiling — its boundary is
  days away from any row — but a query with a bound seconds wide (a `/stats`
  "last N minutes", a just-wrote-then-read assertion) must take slack or inject
  the timestamps rather than assume the two clocks agree.
