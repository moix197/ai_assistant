import type { Clock } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { BudgetUsageRepo } from "../../budget/check-budget";
import { BudgetExceededError } from "../../errors";
import type { ProviderProfile } from "../../port";
import { createOpenAiCompatibleAdapter } from "../openai-compatible";

const PROFILE: ProviderProfile = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-secret",
  model: "deepseek-v4-flash",
};

function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

function fakeBudgetUsageRepo(sumCostSince: number): BudgetUsageRepo {
  return { sumCostSince: vi.fn().mockResolvedValue(sumCostSince) };
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

describe("createOpenAiCompatibleAdapter — budget ceiling", () => {
  it("throws BudgetExceededError and never calls fetch when spend is already over the cap", async () => {
    const fetchImpl = vi.fn();
    const budgetUsageRepo = fakeBudgetUsageRepo(10);
    const clock = fixedClock("2026-08-26T12:00:00.000Z");
    const adapter = createOpenAiCompatibleAdapter(PROFILE, {
      fetchImpl,
      budget: { usageRepo: budgetUsageRepo, capUsd: 5, clock },
    });

    await expect(adapter.complete(baseRequest())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("proceeds to call fetch when spend is under the cap", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      text: async () => "",
    });
    const budgetUsageRepo = fakeBudgetUsageRepo(1);
    const clock = fixedClock("2026-08-26T12:00:00.000Z");
    const adapter = createOpenAiCompatibleAdapter(PROFILE, {
      fetchImpl,
      budget: { usageRepo: budgetUsageRepo, capUsd: 5, clock },
    });

    await adapter.complete(baseRequest());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips the check entirely when no budget config is supplied", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      text: async () => "",
    });
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl });

    await expect(adapter.complete(baseRequest())).resolves.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
