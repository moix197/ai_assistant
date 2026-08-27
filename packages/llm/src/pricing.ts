/**
 * Flat per-model USD pricing table for LLM usage accounting. Verified
 * 2026-08-26 against the providers' own current pricing pages:
 *   - https://api-docs.deepseek.com/quick_start/pricing
 *   - https://ai.google.dev/gemini-api/docs/pricing
 *
 * DeepSeek publishes a ~50% off-peak discount window on top of these
 * numbers. This table deliberately prices at DeepSeek's PEAK (higher) rate
 * only — time-of-day pricing is out of scope for this flat table shape, and
 * pricing high can only ever over-report spend, which is the safe direction
 * for the Phase 4 budget ceiling.
 *
 * Every key here MUST match a model id actually configured in
 * `LLM_PRIMARY_MODEL` / `LLM_FALLBACK_MODEL` — an id that silently drifts
 * out of sync with this table falls into `resolveCostUsd`'s unknown-model
 * path and reports $0 for real, billed calls (see its own doc comment).
 */

import type { Logger, Usage } from "@hermes/core";

export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /**
   * Price per million cache-hit input tokens, as published. Held as a rate
   * rather than a multiplier off `inputPerMillionUsd`: a multiplier has to be
   * divided out by hand to check against a pricing page, and the arithmetic
   * hid a rounding error in every entry (0.031818 x 0.44 = $0.0140 rather
   * than the published $0.014). A rate is read straight off the page.
   */
  cacheHitPerMillionUsd: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "deepseek-v4-flash": {
    inputPerMillionUsd: 0.44,
    outputPerMillionUsd: 1.32,
    cacheHitPerMillionUsd: 0.014,
  },
  "deepseek-v4-pro": {
    inputPerMillionUsd: 1.32,
    outputPerMillionUsd: 3.96,
    cacheHitPerMillionUsd: 0.044,
  },
  "gemini-3.6-flash": {
    inputPerMillionUsd: 0.75,
    outputPerMillionUsd: 3.75,
    cacheHitPerMillionUsd: 0.075,
  },
};

export interface BilledTokens {
  /** Prompt tokens not served from cache — billed at the full input rate. */
  missTokens: number;
  /**
   * `totalTokens - promptTokens - completionTokens`, floored at 0: reasoning
   * / thinking tokens a provider bills as output without surfacing in
   * either visible counter. Never dropped — see `resolveCostUsd`.
   */
  reasoningTokens: number;
}

/**
 * Splits raw usage into the token counts both `resolveCostUsd` and the
 * adapter's usage-row recording bill against. The provider's own
 * `total_tokens` is authoritative: never derive spend by summing
 * `promptTokens + completionTokens` alone, since a reasoning model can bill
 * tokens neither counter shows (see `resolveCostUsd`'s doc comment for the
 * real observed `gemini-3.6-flash` case this guards against).
 */
export function deriveBilledTokens(usage: Usage): BilledTokens {
  return {
    missTokens: Math.max(0, usage.promptTokens - usage.cacheHitTokens),
    reasoningTokens: Math.max(0, usage.totalTokens - usage.promptTokens - usage.completionTokens),
  };
}

/**
 * Resolves the USD cost of one completion call. An unknown model id logs a
 * `warn` via the injected `logger` and returns `0` rather than throwing — a
 * stale or mistyped `MODEL_PRICING` key must not crash a live call, but
 * silently reporting `0` cost for a real, billed call with no signal
 * anywhere would quietly disable the Phase 4 budget ceiling for that model.
 * The `warn` is what keeps that failure mode loud.
 *
 * `total_tokens` is treated as authoritative: `gemini-3.6-flash` has been
 * observed live returning `prompt_tokens: 10, completion_tokens: 0,
 * total_tokens: 27` — 17 billed reasoning tokens visible in neither counter.
 * That remainder is priced at the output rate here, never dropped.
 */
export function resolveCostUsd(model: string, usage: Usage, logger: Logger): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    logger.warn("unknown model id, cannot price usage — reporting $0 cost", { model });
    return 0;
  }

  const { missTokens, reasoningTokens } = deriveBilledTokens(usage);
  const inputCost = missTokens * pricing.inputPerMillionUsd;
  const cacheHitCost = usage.cacheHitTokens * pricing.cacheHitPerMillionUsd;
  const outputCost = (usage.completionTokens + reasoningTokens) * pricing.outputPerMillionUsd;

  return (inputCost + cacheHitCost + outputCost) / 1_000_000;
}
