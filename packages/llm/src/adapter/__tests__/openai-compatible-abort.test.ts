import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmAbortedError, LlmTimeoutError } from "../../errors";
import { MAX_TOKENS_PER_TURN } from "../../max-tokens";
import type { ProviderProfile } from "../../port";
import {
  type OpenAiCompatibleAdapterOptions,
  createOpenAiCompatibleAdapter,
} from "../openai-compatible";

const PROFILE: ProviderProfile = {
  baseUrl: "https://provider.example/v1",
  apiKey: "sk-super-secret-key",
  model: "some-model",
};

// `usageRepo`/`budget` are mandatory adapter options (Phase 4 gap fix). This
// file exercises abort behavior, unrelated to usage/budget, so a permissive
// no-op stands in — mirrors openai-compatible.test.ts's PERMISSIVE_OPTS.
const PERMISSIVE_OPTS: Pick<OpenAiCompatibleAdapterOptions, "usageRepo" | "budget"> = {
  usageRepo: { recordUsage: async () => {} },
  budget: { usageRepo: { sumCostSince: async () => 0 }, capUsd: Number.POSITIVE_INFINITY },
};

function baseRequest() {
  return {
    model: PROFILE.model,
    system: "you are a helpful assistant",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: undefined,
    maxTokens: MAX_TOKENS_PER_TURN,
  };
}

/** Mimics real `fetch`: rejects immediately if the signal is already aborted, otherwise rejects on the signal's `abort` event. */
function abortAwareFetch(): typeof fetch {
  return vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.signal?.aborted) {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOpenAiCompatibleAdapter — external shutdown signal vs. per-request timeout", () => {
  it("throws LlmAbortedError, not LlmTimeoutError, when a pre-aborted external shutdown signal is supplied", async () => {
    const fetchImpl = abortAwareFetch();
    const shutdownController = new AbortController();
    shutdownController.abort();

    const adapter = createOpenAiCompatibleAdapter(PROFILE, {
      ...PERMISSIVE_OPTS,
      fetchImpl,
      timeoutMs: 30_000,
      signal: shutdownController.signal,
    });

    await expect(adapter.complete(baseRequest())).rejects.toBeInstanceOf(LlmAbortedError);
  });

  it("still throws LlmTimeoutError for an ordinary per-request timeout when no external signal fires — proving the two are distinct error classes, not conflated", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = abortAwareFetch();
      // A never-aborted external signal, so the timeout controller is the
      // only thing that fires — proves composition doesn't change ordinary
      // timeout behavior.
      const shutdownController = new AbortController();

      const adapter = createOpenAiCompatibleAdapter(PROFILE, {
        ...PERMISSIVE_OPTS,
        fetchImpl,
        timeoutMs: 1_000,
        signal: shutdownController.signal,
      });

      const resultPromise = adapter.complete(baseRequest()).then(
        () => {
          throw new Error("expected rejection");
        },
        (error) => error,
      );

      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error).toBeInstanceOf(LlmTimeoutError);
      expect(error).not.toBeInstanceOf(LlmAbortedError);
    } finally {
      vi.useRealTimers();
    }
  });
});
