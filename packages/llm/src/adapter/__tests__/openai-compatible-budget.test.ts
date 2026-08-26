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

// `usageRepo` is a mandatory adapter option (Phase 4 gap fix); this suite is
// about the budget check, not usage recording, so a no-op stands in.
const NOOP_USAGE_REPO = { recordUsage: async () => {} };

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
      usageRepo: NOOP_USAGE_REPO,
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
      usageRepo: NOOP_USAGE_REPO,
      budget: { usageRepo: budgetUsageRepo, capUsd: 5, clock },
    });

    await adapter.complete(baseRequest());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // There used to be a third case here — "skips the check entirely when no
  // budget config is supplied" — proving the adapter fell back to a silent
  // no-op when `budget` was omitted. That was precisely the bypass the plan
  // called out as unacceptable: `budget` (and `usageRepo`) are now required
  // fields on `OpenAiCompatibleAdapterOptions`, so omitting either is a
  // compile error, not a runtime behavior to test.
});
