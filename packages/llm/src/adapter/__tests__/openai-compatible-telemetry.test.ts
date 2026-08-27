import type { TelemetryEvent } from "@hermes/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  LlmHttpError,
  LlmMalformedResponseError,
  UnpricedModelError,
} from "../../errors";
import type { ProviderProfile } from "../../port";
import type { LlmUsageRepo } from "../../usage/usage-repo-port";
import {
  type OpenAiCompatibleAdapterOptions,
  createOpenAiCompatibleAdapter,
} from "../openai-compatible";

const PROFILE: ProviderProfile = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-secret",
  model: "deepseek-v4-flash",
};

// `usageRepo`/`budget` are mandatory adapter options. This suite is about
// telemetry emission, not usage accounting or the budget ceiling, so every
// adapter here gets a no-op usage repo and a cap no test spend could reach.
const PERMISSIVE_BUDGET: OpenAiCompatibleAdapterOptions["budget"] = {
  usageRepo: { sumCostSince: async () => 0 },
  capUsd: Number.POSITIVE_INFINITY,
};

function createMockUsageRepo(): LlmUsageRepo {
  return { recordUsage: vi.fn().mockResolvedValue(undefined) };
}

function createMockRecorder(): { record: ReturnType<typeof vi.fn> } {
  return { record: vi.fn() };
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

function recordedEvent(recorder: { record: ReturnType<typeof vi.fn> }): TelemetryEvent {
  return recorder.record.mock.calls[0]?.[0] as TelemetryEvent;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createOpenAiCompatibleAdapter — telemetry emission", () => {
  it("emits exactly one llm.call event on success, matching the recorded LlmUsageEntry, with a positive durationMs and no error", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => {
      vi.advanceTimersByTime(5);
      return jsonResponse({
        choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 30,
        },
      });
    });
    const recorder = createMockRecorder();
    const adapter = createOpenAiCompatibleAdapter(PROFILE, {
      fetchImpl,
      usageRepo: createMockUsageRepo(),
      budget: PERMISSIVE_BUDGET,
      recorder,
    });

    await adapter.complete(baseRequest());

    expect(recorder.record).toHaveBeenCalledTimes(1);
    const event = recordedEvent(recorder);
    expect(event).toMatchObject({
      name: "llm.call",
      threadId: null,
      turnId: null,
      model: "deepseek-v4-flash",
      inputTokens: 70, // 100 prompt - 30 cache hit
      outputTokens: 20,
      cacheHitTokens: 30,
    });
    expect(event).not.toHaveProperty("error");
    expect((event as { costUsd: number }).costUsd).toBeGreaterThan(0);
    expect((event as { durationMs: number }).durationMs).toBeGreaterThan(0);
  });

  it("emits exactly one llm.call event with error set and all numeric usage fields 0 on a provider HTTP failure, then still rethrows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "bad request" }, false, 400));
    const recorder = createMockRecorder();
    const adapter = createOpenAiCompatibleAdapter(PROFILE, {
      fetchImpl,
      usageRepo: createMockUsageRepo(),
      budget: PERMISSIVE_BUDGET,
      recorder,
    });

    await expect(adapter.complete(baseRequest())).rejects.toBeInstanceOf(LlmHttpError);

    expect(recorder.record).toHaveBeenCalledTimes(1);
    const event = recordedEvent(recorder);
    expect(event).toMatchObject({
      name: "llm.call",
      threadId: null,
      turnId: null,
      model: PROFILE.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      costUsd: 0,
    });
    expect((event as { error?: string }).error).toEqual(expect.any(String));
  });

  it("emits exactly one llm.call event with error set on a malformed-response failure, then still rethrows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: null }, finish_reason: "length" }],
      }),
    );
    const recorder = createMockRecorder();
    const adapter = createOpenAiCompatibleAdapter(PROFILE, {
      fetchImpl,
      usageRepo: createMockUsageRepo(),
      budget: PERMISSIVE_BUDGET,
      recorder,
    });

    await expect(adapter.complete(baseRequest())).rejects.toBeInstanceOf(LlmMalformedResponseError);

    expect(recorder.record).toHaveBeenCalledTimes(1);
    const event = recordedEvent(recorder);
    expect(event).toMatchObject({
      name: "llm.call",
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      costUsd: 0,
    });
    expect((event as { error?: string }).error).toEqual(expect.any(String));
  });

  it("emits exactly one llm.call event with error set and costUsd 0, using the completion's own token counts, when usage accounting throws UnpricedModelError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
    const recorder = createMockRecorder();
    const adapter = createOpenAiCompatibleAdapter(
      { ...PROFILE, model: "some-retired-model" },
      {
        fetchImpl,
        usageRepo: createMockUsageRepo(),
        budget: PERMISSIVE_BUDGET,
        recorder,
      },
    );

    await expect(
      adapter.complete({ ...baseRequest(), model: "some-retired-model" }),
    ).rejects.toBeInstanceOf(UnpricedModelError);

    expect(recorder.record).toHaveBeenCalledTimes(1);
    const event = recordedEvent(recorder);
    expect(event).toMatchObject({
      name: "llm.call",
      threadId: null,
      turnId: null,
      model: "some-retired-model",
      inputTokens: 100,
      outputTokens: 20,
      cacheHitTokens: 0,
      costUsd: 0,
    });
    expect((event as { error?: string }).error).toEqual(expect.any(String));
  });

  it("emits zero events when assertBudgetNotExceeded rejects — no provider call was attempted", async () => {
    const fetchImpl = vi.fn();
    const recorder = createMockRecorder();
    const adapter = createOpenAiCompatibleAdapter(PROFILE, {
      fetchImpl,
      usageRepo: createMockUsageRepo(),
      budget: { usageRepo: { sumCostSince: async () => 100 }, capUsd: 5 },
      recorder,
    });

    await expect(adapter.complete(baseRequest())).rejects.toBeInstanceOf(BudgetExceededError);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it("does not throw when recorder is omitted entirely — the adapter works exactly as before this phase", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    const adapter = createOpenAiCompatibleAdapter(PROFILE, {
      fetchImpl,
      usageRepo: createMockUsageRepo(),
      budget: PERMISSIVE_BUDGET,
    });

    await expect(adapter.complete(baseRequest())).resolves.toMatchObject({ text: "hi there" });
  });
});
