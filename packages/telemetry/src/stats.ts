import type { Clock } from "@hermes/core";
import type { StatsRepo, ToolCount } from "./stats-repo-port";

/** How many rows `formatStatsMessage`'s "Top tools" line renders. */
const TOP_TOOLS_LIMIT = 5;

const NO_TOOL_CALLS_MESSAGE = "no tool calls recorded yet";

export interface Stats {
  spendTodayUsd: number;
  spendMonthUsd: number;
  capUsd: number;
  callsToday: number;
  callsMonth: number;
  inputTokensMonth: number;
  outputTokensMonth: number;
  cacheHitRateMonth: number;
  errorRateMonth: number;
  topToolsMonth: ToolCount[];
}

/** Midnight UTC on `now`'s calendar day, in UTC. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Midnight UTC on the first of `now`'s calendar month, in UTC. Deliberately
 * duplicated from `packages/llm/src/budget/check-budget.ts`'s
 * `startOfCurrentUtcMonth` rather than shared — `packages/telemetry` and
 * `packages/llm` are kept independent of each other (see
 * `plans/02-telemetry.md`), and a shared abstraction for six lines isn't
 * earned yet.
 */
function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** `0`, never `NaN`, when `denominator` is `0` — a fresh deployment's first `/stats` call before any traffic. */
function computeRate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Computes `/stats`' numbers off the injected `repo` and `Clock`. `now`
 * overrides the clock when supplied (tests only — production always omits
 * it and gets `clock.now()`). Spend comes from `repo.sumCostSince` (backed
 * by `llm_usage`); calls/tokens/cache-hit-rate/error-rate/top-tools come from
 * `repo.getLlmCallStatsSince`/`getTopToolsSince` (backed by
 * `telemetry_events`) — see the cost-source-split invariant in
 * `plans/02-telemetry.md`. "Error rate" is precisely the share of `llm.call`
 * events with `is_error = true`; budget-ceiling rejections never produce an
 * `llm.call` event, so they are excluded by construction, not by a filter
 * here.
 */
export async function computeStats(
  repo: StatsRepo,
  clock: Clock,
  capUsd: number,
  now?: Date,
): Promise<Stats> {
  const currentTime = now ?? clock.now();
  const todayStart = startOfUtcDay(currentTime);
  const monthStart = startOfUtcMonth(currentTime);

  const [spendTodayUsd, spendMonthUsd, statsToday, statsMonth, topToolsMonth] = await Promise.all([
    repo.sumCostSince(todayStart),
    repo.sumCostSince(monthStart),
    repo.getLlmCallStatsSince(todayStart),
    repo.getLlmCallStatsSince(monthStart),
    repo.getTopToolsSince(monthStart, TOP_TOOLS_LIMIT),
  ]);

  return {
    spendTodayUsd,
    spendMonthUsd,
    capUsd,
    callsToday: statsToday.calls,
    callsMonth: statsMonth.calls,
    inputTokensMonth: statsMonth.inputTokens,
    outputTokensMonth: statsMonth.outputTokens,
    cacheHitRateMonth: computeRate(
      statsMonth.cacheHitTokens,
      statsMonth.inputTokens + statsMonth.cacheHitTokens,
    ),
    errorRateMonth: computeRate(statsMonth.errorCalls, statsMonth.calls),
    topToolsMonth,
  };
}

function formatUsd(amountUsd: number): string {
  return `$${amountUsd.toFixed(6)}`;
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatTopTools(topTools: ToolCount[]): string {
  if (topTools.length === 0) return NO_TOOL_CALLS_MESSAGE;
  return topTools.map((tool) => `${tool.tool}: ${tool.count}`).join(", ");
}

/**
 * Plain text only — `packages/channels`' Telegram sender sets no
 * `parse_mode` anywhere, so Markdown here would render as literal
 * asterisks/underscores in chat. Renders the literal
 * `"no tool calls recorded yet"` when `topToolsMonth` is empty rather than
 * omitting the section.
 */
export function formatStatsMessage(stats: Stats): string {
  const budgetPercent = Math.round((stats.spendMonthUsd / stats.capUsd) * 100);
  return [
    `Spend today: ${formatUsd(stats.spendTodayUsd)}`,
    `Spend this month: ${formatUsd(stats.spendMonthUsd)} / $${stats.capUsd.toFixed(2)} (${budgetPercent}%)`,
    `Calls today: ${stats.callsToday}`,
    `Calls this month: ${stats.callsMonth}`,
    `Tokens in/out (month): ${stats.inputTokensMonth} / ${stats.outputTokensMonth}`,
    `Cache hit rate (month): ${formatPercent(stats.cacheHitRateMonth)}`,
    `Error rate (month): ${formatPercent(stats.errorRateMonth)}`,
    `Top tools (month): ${formatTopTools(stats.topToolsMonth)}`,
  ].join("\n");
}
