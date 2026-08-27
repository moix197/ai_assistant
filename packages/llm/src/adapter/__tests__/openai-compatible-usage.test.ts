import type { Logger } from "@hermes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnpricedModelError } from "../../errors";
import type { ProviderProfile } from "../../port";
import type { LlmUsageEntry, LlmUsageRepo } from "../../usage/usage-repo-port";
import {
  type OpenAiCompatibleAdapterOptions,
  createOpenAiCompatibleAdapter,
} from "../openai-compatible";

const PROFILE: ProviderProfile = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-secret",
  model: "deepseek-v4-flash",
};

// `budget` is mandatory now (Phase 4 gap fix). This suite is about usage
// accounting, not the budget ceiling, so every adapter here gets a cap no
// test spend could reach rather than relying on a removed default.
const PERMISSIVE_BUDGET: OpenAiCompatibleAdapterOptions["budget"] = {
  usageRepo: { sumCostSince: async () => 0 },
  capUsd: Number.POSITIVE_INFINITY,
};

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockUsageRepo(): LlmUsageRepo & { recordUsage: ReturnType<typeof vi.fn> } {
  return { recordUsage: vi.fn().mockResolvedValue(undefined) };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function baseRequest() {
  return {
    model: PROFILE.model,
    system: "you are a helpful assistant",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: undefined,
    maxTokens: 100,
  };
}

function recordedEntry(usageRepo: { recordUsage: ReturnType<typeof vi.fn> }): LlmUsageEntry {
  return usageRepo.recordUsage.mock.calls[0]?.[0] as LlmUsageEntry;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOpenAiCompatibleAdapter — usage recording", () => {
  it("records usage exactly once after a successful complete(), parsing DeepSeek's prompt_cache_hit_tokens", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 30,
        },
      }),
    );
    const usageRepo = createMockUsageRepo();
    const logger = createMockLogger();
    const adapter = createOpenAiCompatibleAdapter(PROFILE, {
      fetchImpl,
      usageRepo,
      logger,
      budget: PERMISSIVE_BUDGET,
    });

    const result = await adapter.complete(baseRequest());

    expect(result.usage.cacheHitTokens).toBe(30);
    expect(usageRepo.recordUsage).toHaveBeenCalledTimes(1);
    const entry = recordedEntry(usageRepo);
    expect(entry.model).toBe("deepseek-v4-flash");
    expect(entry.cacheHitTokens).toBe(30);
    expect(entry.inputTokens).toBe(70); // 100 prompt - 30 cache hit
    expect(entry.outputTokens).toBe(20); // completion only, no reasoning-token gap
    expect(entry.costUsd).toBeGreaterThan(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("parses the OpenAI-compatible prompt_tokens_details.cached_tokens shape (Gemini) and prices reasoning tokens as output", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 0,
          total_tokens: 27,
          prompt_tokens_details: { cached_tokens: 5 },
        },
      }),
    );
    const usageRepo = createMockUsageRepo();
    const logger = createMockLogger();
    const adapter = createOpenAiCompatibleAdapter(
      { ...PROFILE, model: "gemini-3.6-flash" },
      { fetchImpl, usageRepo, logger, budget: PERMISSIVE_BUDGET },
    );

    const result = await adapter.complete({ ...baseRequest(), model: "gemini-3.6-flash" });

    expect(result.usage.cacheHitTokens).toBe(5);
    const entry = recordedEntry(usageRepo);
    expect(entry.cacheHitTokens).toBe(5);
    expect(entry.inputTokens).toBe(5); // 10 prompt - 5 cache hit
    expect(entry.outputTokens).toBe(17); // 0 completion + 17 reasoning tokens
  });

  it("defaults cacheHitTokens to 0 when neither wire shape is present", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    const usageRepo = createMockUsageRepo();
    const adapter = createOpenAiCompatibleAdapter(PROFILE, {
      fetchImpl,
      usageRepo,
      logger: createMockLogger(),
      budget: PERMISSIVE_BUDGET,
    });

    const result = await adapter.complete(baseRequest());

    expect(result.usage.cacheHitTokens).toBe(0);
    expect(recordedEntry(usageRepo).cacheHitTokens).toBe(0);
  });

  it("logs an error and still returns the completion result when recordUsage rejects", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
    const usageRepo = createMockUsageRepo();
    usageRepo.recordUsage.mockRejectedValue(new Error("db down"));
    const logger = createMockLogger();
    const adapter = createOpenAiCompatibleAdapter(PROFILE, {
      fetchImpl,
      usageRepo,
      logger,
      budget: PERMISSIVE_BUDGET,
    });

    const result = await adapter.complete(baseRequest());

    expect(result.text).toBe("hi there");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        model: "deepseek-v4-flash",
        costUsd: expect.any(Number),
        error: "db down",
      }),
    );
  });

  it("never calls recordUsage when the call fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "bad request" }, false, 400));
    const usageRepo = createMockUsageRepo();
    const adapter = createOpenAiCompatibleAdapter(PROFILE, {
      fetchImpl,
      usageRepo,
      logger: createMockLogger(),
      budget: PERMISSIVE_BUDGET,
    });

    await expect(adapter.complete(baseRequest())).rejects.toThrow();
    expect(usageRepo.recordUsage).not.toHaveBeenCalled();
  });

  // Pins Phase 4's reversal at the adapter boundary, not just in
  // pricing.test.ts: a successful response using a model absent from
  // MODEL_PRICING must reject complete() with UnpricedModelError rather than
  // resolving with a $0-costed usage row.
  it("rejects with UnpricedModelError, never recording a $0-costed row, when the model has no MODEL_PRICING entry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
    const usageRepo = createMockUsageRepo();
    const adapter = createOpenAiCompatibleAdapter(
      { ...PROFILE, model: "some-retired-model" },
      { fetchImpl, usageRepo, logger: createMockLogger(), budget: PERMISSIVE_BUDGET },
    );

    await expect(
      adapter.complete({ ...baseRequest(), model: "some-retired-model" }),
    ).rejects.toBeInstanceOf(UnpricedModelError);
    expect(usageRepo.recordUsage).not.toHaveBeenCalled();
  });
});
