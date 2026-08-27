export interface LlmCallStats {
  calls: number;
  errorCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
}

export interface ToolCount {
  tool: string;
  count: number;
}

/**
 * Stats-reading port for `/stats` (Phase 3). `sumCostSince` is declared
 * independently here with the exact shape `packages/llm`'s `BudgetUsageRepo`
 * already declares (not imported from `llm`, mirroring how neither package
 * imports the other) — `apps/hermes` wires the **same** `@hermes/store`
 * `sumCostSince` function into both ports, which is what makes the
 * cost-source-split invariant (see `plans/02-telemetry.md`) hold in
 * practice, not just in prose. `getLlmCallStatsSince`/`getTopToolsSince`
 * mirror `@hermes/store`'s functions of the same name structurally, without
 * importing them — `@hermes/telemetry` never depends on `@hermes/store`.
 */
export interface StatsRepo {
  sumCostSince(sinceUtc: Date): Promise<number>;
  getLlmCallStatsSince(sinceUtc: Date): Promise<LlmCallStats>;
  getTopToolsSince(sinceUtc: Date, limit: number): Promise<ToolCount[]>;
}
