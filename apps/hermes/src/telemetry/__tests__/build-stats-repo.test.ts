import type { Pool } from "@hermes/store";
import { describe, expect, it, vi } from "vitest";
import { buildStatsRepo } from "../build-stats-repo";

const SINCE = new Date("2026-08-01T00:00:00.000Z");

/** A pool whose `query` returns canned rows shaped like each real query's result. */
function createMockPool(rows: unknown[]): Pool & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool & {
    query: ReturnType<typeof vi.fn>;
  };
}

describe("buildStatsRepo — boot wiring", () => {
  it("routes sumCostSince to @hermes/store's sumCostSince against the real pool", async () => {
    const pool = createMockPool([{ total: "12.5" }]);
    const statsRepo = buildStatsRepo(pool);

    const total = await statsRepo.sumCostSince(SINCE);

    expect(total).toBe(12.5);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SUM(cost_usd)"),
      expect.arrayContaining([SINCE]),
    );
  });

  it("routes getLlmCallStatsSince to @hermes/store's getLlmCallStatsSince against the real pool", async () => {
    const pool = createMockPool([
      {
        calls: 5,
        error_calls: 1,
        input_tokens: "100",
        output_tokens: "20",
        cache_hit_tokens: "10",
      },
    ]);
    const statsRepo = buildStatsRepo(pool);

    const stats = await statsRepo.getLlmCallStatsSince(SINCE);

    expect(stats).toEqual({
      calls: 5,
      errorCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheHitTokens: 10,
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM telemetry_events"),
      expect.arrayContaining([SINCE]),
    );
  });

  it("routes getTopToolsSince to @hermes/store's getTopToolsSince against the real pool", async () => {
    const pool = createMockPool([{ tool: "search", count: 3 }]);
    const statsRepo = buildStatsRepo(pool);

    const topTools = await statsRepo.getTopToolsSince(SINCE, 5);

    expect(topTools).toEqual([{ tool: "search", count: 3 }]);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("GROUP BY tool_name"),
      expect.arrayContaining([SINCE, 5]),
    );
  });
});
