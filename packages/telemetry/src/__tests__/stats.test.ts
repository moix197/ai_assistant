import type { Clock } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import { computeStats, formatStatsMessage } from "../stats";
import type { LlmCallStats, StatsRepo, ToolCount } from "../stats-repo-port";

const NOW = new Date("2026-08-27T15:30:00.000Z");
const EXPECTED_DAY_START = new Date("2026-08-27T00:00:00.000Z");
const EXPECTED_MONTH_START = new Date("2026-08-01T00:00:00.000Z");

function emptyLlmCallStats(): LlmCallStats {
  return { calls: 0, errorCalls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };
}

interface FakeStatsRepoOptions {
  spendTodayUsd?: number;
  spendMonthUsd?: number;
  statsToday?: LlmCallStats;
  statsMonth?: LlmCallStats;
  topToolsMonth?: ToolCount[];
}

function createFakeStatsRepo(options: FakeStatsRepoOptions = {}): StatsRepo {
  const spendTodayUsd = options.spendTodayUsd ?? 0;
  const spendMonthUsd = options.spendMonthUsd ?? 0;
  const statsToday = options.statsToday ?? emptyLlmCallStats();
  const statsMonth = options.statsMonth ?? emptyLlmCallStats();
  const topToolsMonth = options.topToolsMonth ?? [];

  return {
    sumCostSince: vi.fn().mockImplementation((sinceUtc: Date) => {
      return Promise.resolve(
        sinceUtc.getTime() === EXPECTED_DAY_START.getTime() ? spendTodayUsd : spendMonthUsd,
      );
    }),
    getLlmCallStatsSince: vi.fn().mockImplementation((sinceUtc: Date) => {
      return Promise.resolve(
        sinceUtc.getTime() === EXPECTED_DAY_START.getTime() ? statsToday : statsMonth,
      );
    }),
    getTopToolsSince: vi.fn().mockResolvedValue(topToolsMonth),
  };
}

const fixedClock: Clock = { now: () => NOW };

describe("computeStats", () => {
  it("passes the correct UTC day and month boundaries to each repo call", async () => {
    const repo = createFakeStatsRepo();

    await computeStats(repo, fixedClock, 100, NOW);

    expect(repo.sumCostSince).toHaveBeenCalledWith(EXPECTED_DAY_START);
    expect(repo.sumCostSince).toHaveBeenCalledWith(EXPECTED_MONTH_START);
    expect(repo.getLlmCallStatsSince).toHaveBeenCalledWith(EXPECTED_DAY_START);
    expect(repo.getLlmCallStatsSince).toHaveBeenCalledWith(EXPECTED_MONTH_START);
    expect(repo.getTopToolsSince).toHaveBeenCalledWith(EXPECTED_MONTH_START, expect.any(Number));
  });

  it("uses clock.now() when now is not supplied", async () => {
    const repo = createFakeStatsRepo();
    const clock: Clock = { now: vi.fn().mockReturnValue(NOW) };

    await computeStats(repo, clock, 100);

    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(repo.sumCostSince).toHaveBeenCalledWith(EXPECTED_DAY_START);
  });

  it("combines repo results into the correct Stats shape", async () => {
    const repo = createFakeStatsRepo({
      spendTodayUsd: 1.5,
      spendMonthUsd: 20,
      statsToday: {
        calls: 3,
        errorCalls: 0,
        inputTokens: 300,
        outputTokens: 60,
        cacheHitTokens: 0,
      },
      statsMonth: {
        calls: 10,
        errorCalls: 2,
        inputTokens: 1000,
        outputTokens: 200,
        cacheHitTokens: 500,
      },
      topToolsMonth: [{ tool: "search", count: 4 }],
    });

    const stats = await computeStats(repo, fixedClock, 100, NOW);

    expect(stats).toEqual({
      spendTodayUsd: 1.5,
      spendMonthUsd: 20,
      capUsd: 100,
      callsToday: 3,
      callsMonth: 10,
      inputTokensMonth: 1000,
      outputTokensMonth: 200,
      cacheHitRateMonth: 500 / 1500,
      errorRateMonth: 2 / 10,
      topToolsMonth: [{ tool: "search", count: 4 }],
    });
  });

  // Cost-source-split regression: sumCostSince and getLlmCallStatsSince
  // deliberately disagree, so the assertion below proves the spend line
  // traces to sumCostSince alone — there is no other number in this fixture
  // it could have come from.
  it("traces the spend line to sumCostSince alone, never to getLlmCallStatsSince (cost-source-split regression)", async () => {
    const repo = createFakeStatsRepo({
      spendMonthUsd: 12.345678,
      statsMonth: emptyLlmCallStats(),
    });

    const stats = await computeStats(repo, fixedClock, 100, NOW);
    const message = formatStatsMessage(stats);

    expect(stats.spendMonthUsd).toBe(12.345678);
    expect(message).toContain("Spend this month: $12.345678");
  });

  it("renders cache-hit rate and error rate as 0, not NaN, when calls/tokens are 0", async () => {
    const repo = createFakeStatsRepo({ statsMonth: emptyLlmCallStats() });

    const stats = await computeStats(repo, fixedClock, 100, NOW);

    expect(stats.cacheHitRateMonth).toBe(0);
    expect(stats.errorRateMonth).toBe(0);
    expect(Number.isNaN(stats.cacheHitRateMonth)).toBe(false);
    expect(Number.isNaN(stats.errorRateMonth)).toBe(false);
  });
});

describe("formatStatsMessage", () => {
  it("renders every section, including a real tool list when topToolsMonth is non-empty", async () => {
    const repo = createFakeStatsRepo({
      spendTodayUsd: 1.234567,
      spendMonthUsd: 45.6,
      statsToday: {
        calls: 2,
        errorCalls: 0,
        inputTokens: 200,
        outputTokens: 50,
        cacheHitTokens: 0,
      },
      statsMonth: {
        calls: 20,
        errorCalls: 1,
        inputTokens: 2000,
        outputTokens: 400,
        cacheHitTokens: 1000,
      },
      topToolsMonth: [
        { tool: "search", count: 5 },
        { tool: "lookup", count: 2 },
      ],
    });
    const stats = await computeStats(repo, fixedClock, 100, NOW);

    const message = formatStatsMessage(stats);

    expect(message).toBe(
      [
        "Spend today: $1.234567",
        "Spend this month: $45.600000 / $100.00 (45.6%)",
        "Calls today: 2",
        "Calls this month: 20",
        "Tokens in/out (month): 2000 / 400",
        "Cache hit rate (month): 33.3%",
        "Error rate (month): 5.0%",
        "Top tools (month): search: 5, lookup: 2",
      ].join("\n"),
    );
  });

  it('renders the literal "no tool calls recorded yet" when topToolsMonth is empty', async () => {
    const repo = createFakeStatsRepo({ topToolsMonth: [] });
    const stats = await computeStats(repo, fixedClock, 100, NOW);

    const message = formatStatsMessage(stats);

    expect(message).toContain("Top tools (month): no tool calls recorded yet");
  });
});
