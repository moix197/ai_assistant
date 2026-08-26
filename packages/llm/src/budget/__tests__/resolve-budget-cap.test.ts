import { describe, expect, it } from "vitest";
import { resolveBudgetCapUsd } from "../resolve-budget-cap";

describe("resolveBudgetCapUsd", () => {
  it("returns the configured LLM_MONTHLY_BUDGET_USD value unchanged", () => {
    expect(resolveBudgetCapUsd({ LLM_MONTHLY_BUDGET_USD: 25 })).toBe(25);
  });

  it("passes through a fractional cap", () => {
    expect(resolveBudgetCapUsd({ LLM_MONTHLY_BUDGET_USD: 0.5 })).toBe(0.5);
  });
});
