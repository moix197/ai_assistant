import type { Clock } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError } from "../../errors";
import { assertBudgetNotExceeded } from "../check-budget";
import type { BudgetUsageRepo } from "../check-budget";

function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

function fakeUsageRepo(sumCostSince: number): BudgetUsageRepo {
  return { sumCostSince: vi.fn().mockResolvedValue(sumCostSince) };
}

describe("assertBudgetNotExceeded", () => {
  it("resolves when spend is under the cap", async () => {
    const usageRepo = fakeUsageRepo(4.99);
    const clock = fixedClock("2026-08-26T12:00:00.000Z");

    await expect(assertBudgetNotExceeded(usageRepo, 5, clock)).resolves.toBeUndefined();
  });

  it("throws BudgetExceededError with the correct numbers when spend equals the cap", async () => {
    const usageRepo = fakeUsageRepo(5);
    const clock = fixedClock("2026-08-26T12:00:00.000Z");

    await expect(assertBudgetNotExceeded(usageRepo, 5, clock)).rejects.toMatchObject({
      capUsd: 5,
      spentUsd: 5,
    });
  });

  it("throws BudgetExceededError when spend exceeds the cap", async () => {
    const usageRepo = fakeUsageRepo(7.5);
    const clock = fixedClock("2026-08-26T12:00:00.000Z");

    const error = await assertBudgetNotExceeded(usageRepo, 5, clock).catch((e) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as InstanceType<typeof BudgetExceededError>).capUsd).toBe(5);
    expect((error as InstanceType<typeof BudgetExceededError>).spentUsd).toBe(7.5);
  });

  it("sums cost since the start of the current calendar month in UTC, per the injected Clock", async () => {
    const usageRepo = fakeUsageRepo(0);
    // Deliberately near a local-timezone-sensitive instant: 2026-08-01T02:00
    // UTC is still August in UTC, so the boundary must be computed in UTC,
    // not local time.
    const clock = fixedClock("2026-08-01T02:00:00.000Z");

    await assertBudgetNotExceeded(usageRepo, 5, clock);

    expect(usageRepo.sumCostSince).toHaveBeenCalledWith(new Date("2026-08-01T00:00:00.000Z"));
  });

  it("uses July's month start when the clock reads the last moment of July UTC", async () => {
    const usageRepo = fakeUsageRepo(0);
    const clock = fixedClock("2026-07-31T23:59:59.999Z");

    await assertBudgetNotExceeded(usageRepo, 5, clock);

    expect(usageRepo.sumCostSince).toHaveBeenCalledWith(new Date("2026-07-01T00:00:00.000Z"));
  });
});
