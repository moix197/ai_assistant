import type { Usage } from "@hermes/core";
import { describe, expect, it } from "vitest";
import { UnpricedModelError } from "../errors";
import { MODEL_PRICING, type ModelPricing, assertModelsPriced, resolveCostUsd } from "../pricing";

/** Throws (rather than a non-null assertion) if the test itself passes an unknown model id. */
function getPricing(model: string): ModelPricing {
  const pricing = MODEL_PRICING[model];
  if (!pricing) throw new Error(`test setup error: no MODEL_PRICING entry for "${model}"`);
  return pricing;
}

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    ...overrides,
  };
}

describe("resolveCostUsd — known models", () => {
  it("prices 1M miss prompt tokens and 1M completion tokens at deepseek-v4-flash's flat rates", () => {
    const cost = resolveCostUsd(
      "deepseek-v4-flash",
      usage({ promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 }),
    );
    expect(cost).toBeCloseTo(0.44 + 1.32, 6);
  });

  it("prices deepseek-v4-pro at its own, higher rates", () => {
    const cost = resolveCostUsd(
      "deepseek-v4-pro",
      usage({ promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 }),
    );
    expect(cost).toBeCloseTo(1.32 + 3.96, 6);
  });

  it("prices cache-hit tokens at the discounted rate, separate from miss tokens", () => {
    // Every prompt token is a cache hit: miss tokens = 0, so the whole
    // input side of the cost comes from the discounted cache-hit rate.
    const cost = resolveCostUsd(
      "deepseek-v4-flash",
      usage({ promptTokens: 1_000_000, cacheHitTokens: 1_000_000, totalTokens: 1_000_000 }),
    );
    const pricing = getPricing("deepseek-v4-flash");
    expect(cost).toBeCloseTo(pricing.cacheHitPerMillionUsd, 6);
  });

  it("prices the 17 unaccounted reasoning tokens at the output rate — real observed gemini-3.6-flash response", () => {
    // Observed live: prompt_tokens 10, completion_tokens 0, total_tokens 27.
    // 17 billed reasoning tokens appear in neither counter and must not be dropped.
    const cost = resolveCostUsd(
      "gemini-3.6-flash",
      usage({ promptTokens: 10, completionTokens: 0, totalTokens: 27 }),
    );
    const pricing = getPricing("gemini-3.6-flash");
    const expected =
      (10 * pricing.inputPerMillionUsd + 17 * pricing.outputPerMillionUsd) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
    expect(cost).toBeGreaterThan(0);
  });
});

describe("resolveCostUsd — unknown model", () => {
  it("throws UnpricedModelError naming the model instead of returning 0", () => {
    expect(() =>
      resolveCostUsd(
        "some-retired-model",
        usage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }),
      ),
    ).toThrow(UnpricedModelError);
    try {
      resolveCostUsd(
        "some-retired-model",
        usage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(UnpricedModelError);
      expect((error as UnpricedModelError).model).toBe("some-retired-model");
    }
  });
});

describe("assertModelsPriced", () => {
  it("resolves without throwing when every model is known", () => {
    expect(() => assertModelsPriced(["deepseek-v4-flash", "gemini-3.6-flash"])).not.toThrow();
  });

  it("throws UnpricedModelError naming the specific unknown model among several", () => {
    expect(() =>
      assertModelsPriced(["deepseek-v4-flash", "some-retired-model", "gemini-3.6-flash"]),
    ).toThrow(UnpricedModelError);
    try {
      assertModelsPriced(["deepseek-v4-flash", "some-retired-model", "gemini-3.6-flash"]);
    } catch (error) {
      expect((error as UnpricedModelError).model).toBe("some-retired-model");
    }
  });

  it("throws naming the fallback's model when only the fallback is unpriced (primary stays fine)", () => {
    expect(() => assertModelsPriced(["deepseek-v4-flash", "some-retired-fallback-model"])).toThrow(
      UnpricedModelError,
    );
    try {
      assertModelsPriced(["deepseek-v4-flash", "some-retired-fallback-model"]);
    } catch (error) {
      expect((error as UnpricedModelError).model).toBe("some-retired-fallback-model");
    }
  });

  it("resolves without throwing given an empty list — no configured fallback is valid", () => {
    expect(() => assertModelsPriced([])).not.toThrow();
  });
});

describe("MODEL_PRICING", () => {
  it("covers every model id actually configured in the environment — catches .env drift, not just a fixed pair of literal ids", () => {
    const configuredModelIds = [
      process.env.LLM_PRIMARY_MODEL,
      process.env.LLM_FALLBACK_MODEL,
    ].filter((id): id is string => typeof id === "string" && id.length > 0);

    if (configuredModelIds.length === 0) {
      // No LLM_* env set — e.g. CI without secrets. Fall back to the known
      // literal ids so the suite still asserts something concrete rather
      // than trivially passing on an empty list.
      expect(MODEL_PRICING["deepseek-v4-flash"]).toBeDefined();
      expect(MODEL_PRICING["gemini-3.6-flash"]).toBeDefined();
      return;
    }

    for (const modelId of configuredModelIds) {
      if (!(modelId in MODEL_PRICING)) {
        throw new Error(
          `MODEL_PRICING is missing "${modelId}" (from LLM_PRIMARY_MODEL/LLM_FALLBACK_MODEL). A live call using this id would throw UnpricedModelError mid-call, discarding an already-paid-for reply — see resolveCostUsd's unknown-model path.`,
        );
      }
    }
  });
});
