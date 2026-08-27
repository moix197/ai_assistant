/**
 * ROADMAP §8: the live DeepSeek-vs-Gemini tool-calling check.
 *
 * **This suite spends real money against two live third-party APIs.** It runs
 * only via `pnpm test:live`; the default lane excludes `*.live.test.ts` and
 * this file is the only thing under `src/__tests__/live/` that vitest collects.
 *
 * Ten strictly sequential trials against the primary profile, then ten against
 * the fallback profile — same prompt, same tool definitions, same opening
 * max-tokens budget, and the same escalation ladder when a provider truncates.
 * Sequential, never parallel: predictable rate-limit behavior and free-tier
 * safety.
 *
 * Every raw response is recorded under `fixtures/recorded/` so
 * `../tool-calling-check-fixture-replay.test.ts` can re-score the same bodies
 * offline, through the same scoring module, forever after.
 */

import { describe, expect, it } from "vitest";
import { createOpenAiCompatibleAdapter } from "../../adapter/openai-compatible";
import type { LlmProvider, ProviderProfile } from "../../port";
import type { ProfileSlot } from "../recorded-fixtures";
import {
  type ContingencyVerdict,
  type ProviderMetrics,
  TRIALS_PER_PROVIDER,
  type TrialOutcome,
  evaluateContingencyTrigger,
  formatContingencyVerdictLine,
  formatMetricsReport,
  identifyProviderFamily,
  scoreTrial,
  summarizeOutcomes,
} from "../tool-calling-score";
import {
  EXPECTED_TOOL_NAME,
  FIVE_TOOL_DEFINITIONS,
  FIVE_TOOL_USER_PROMPT,
  buildFiveToolRequest,
} from "./fixtures/five-tool-prompt";
import {
  type AttemptContext,
  type LiveProfiles,
  type RecordingFetch,
  createRecordingFetch,
  formatLiveSkipMessage,
  loadLiveProfiles,
  missingLiveEnvKeys,
} from "./setup";

/**
 * The output budget this *measurement* gives a trial, escalating one rung each
 * time the provider comes back truncated.
 *
 * Deliberately **not** `MAX_TOKENS_PER_TURN` (1024). That constant is invariant
 * #9's production per-turn spend guard — a handler concern. Inheriting it here
 * would measure the guard instead of the provider: `gemini-3.6-flash` is a
 * reasoning model and spends output tokens on hidden reasoning *before* it emits
 * the first tool-call token, so a 1024 budget answers HTTP 200 with
 * `finish_reason: "length"`, `completion_tokens: 0` and no content. That is a
 * budget truncation, not a tool-calling failure, and at this fixture's difficulty
 * it would truncate most Gemini trials and swamp the comparison.
 *
 * 8192 opens generously: the expected answer is a single ~60-token
 * `convert_currency` call, so effectively the whole budget is reasoning headroom
 * (8x the production guard). 32768 and 65536 follow for a model that reasons
 * unusually long on a given trial.
 *
 * Three rungs is a hard cap on attempts per trial. A provider that still
 * truncates at 65536 will not be rescued by another doubling, and the cap is what
 * stops a pathological provider from looping the free tier away. A trial that
 * exhausts the ladder stays in the truncated column — it is never demoted into
 * the accuracy or malformed-JSON columns.
 */
const MAX_TOKENS_LADDER = [8192, 32768, 65536];

/**
 * 20 sequential trials, each up to `MAX_TOKENS_LADDER.length` calls, each with
 * the adapter's own bounded retries behind it — so up to 60 live calls, and the
 * later rungs let a reasoning model think for far longer than the first.
 */
const LIVE_SUITE_TIMEOUT_MS = 30 * 60_000;

const missingEnvKeys = missingLiveEnvKeys();
const liveProfiles = loadLiveProfiles();
if (!liveProfiles) console.warn(formatLiveSkipMessage(missingEnvKeys));

async function runOneTrial(
  provider: LlmProvider,
  recorder: RecordingFetch,
  context: AttemptContext,
): Promise<TrialOutcome> {
  recorder.beginAttempt(context);

  let result: Awaited<ReturnType<LlmProvider["complete"]>> | undefined;
  let error: unknown;
  try {
    result = await provider.complete(buildFiveToolRequest(context.model, context.maxTokens));
  } catch (caught) {
    error = caught;
  }
  recorder.writeLastAttempt();

  return scoreTrial({
    result,
    error,
    bodyText: recorder.lastBodyText(),
    expectedToolName: EXPECTED_TOOL_NAME,
    tools: FIVE_TOOL_DEFINITIONS,
  });
}

type TrialBase = Omit<AttemptContext, "trial" | "attemptIndex" | "attemptKind" | "maxTokens">;

/** Walks one trial up the max-tokens ladder, stopping at the first non-truncated attempt. */
async function runTrialLadder(
  provider: LlmProvider,
  recorder: RecordingFetch,
  base: TrialBase,
  trial: number,
): Promise<TrialOutcome[]> {
  const attempts: TrialOutcome[] = [];

  for (const [rung, maxTokens] of MAX_TOKENS_LADDER.entries()) {
    const outcome = await runOneTrial(provider, recorder, {
      ...base,
      trial,
      attemptIndex: rung + 1,
      attemptKind: rung === 0 ? "initial" : "retry",
      maxTokens,
    });
    attempts.push(outcome);
    if (!outcome.truncated) break;
  }

  return attempts;
}

async function runProviderTrials(
  profileSlot: ProfileSlot,
  profile: ProviderProfile,
): Promise<ProviderMetrics> {
  const recorder = createRecordingFetch();
  // `usageRepo`/`budget` are mandatory adapter options (Phase 4 gap fix);
  // this live check pays real provider cost by design and isn't exercising
  // usage accounting or the budget ceiling, so a permissive no-op stands in
  // for both.
  const provider = createOpenAiCompatibleAdapter(profile, {
    fetchImpl: recorder.fetchImpl,
    usageRepo: { recordUsage: async () => {} },
    budget: { usageRepo: { sumCostSince: async () => 0 }, capUsd: Number.POSITIVE_INFINITY },
  });
  const providerFamily = identifyProviderFamily(profile);
  const base = { profileSlot, providerFamily, model: profile.model };
  const trials: TrialOutcome[][] = [];

  for (let trial = 1; trial <= TRIALS_PER_PROVIDER; trial++) {
    trials.push(await runTrialLadder(provider, recorder, base, trial));
  }

  return summarizeOutcomes(`${profileSlot} / ${providerFamily}`, profile.model, trials);
}

function metricsForFamily(
  allMetrics: ProviderMetrics[],
  profiles: LiveProfiles,
  family: "gemini" | "deepseek",
): ProviderMetrics | undefined {
  const slots: ProfileSlot[] = ["primary", "fallback"];
  const index = slots.findIndex((slot) => identifyProviderFamily(profiles[slot]) === family);
  return index === -1 ? undefined : allMetrics[index];
}

/**
 * The headline. A run in which any provider produced no scorable trials is
 * INVALID before it is pass-or-fail: its percentages are not measurements and
 * must not reach D5.
 */
function runHeadline(allMetrics: ProviderMetrics[], verdict: ContingencyVerdict): string {
  if (!allMetrics.every((metrics) => metrics.comparable)) {
    return "INVALID RUN — NOT COMPARABLE, nothing here is a measured result";
  }
  // An infra failure (429/5xx/network/timeout) means the run was starved, not
  // that the model was judged and found wanting — say so distinctly rather
  // than reporting a plain "FAIL" a reader could mistake for a quality
  // result recordable in D5.
  if (allMetrics.some((metrics) => metrics.infraFailures > 0)) {
    return "FAIL — INFRASTRUCTURE (429/5xx/network/timeout), not a quality result; rerun once cleared";
  }
  const clean = allMetrics.every(
    (metrics) => metrics.qualityFailures === 0 && metrics.scoredTrials === TRIALS_PER_PROVIDER,
  );
  return clean && !verdict.fired ? "PASS" : "FAIL";
}

function providerFootnote(metrics: ProviderMetrics): string {
  return (
    `${metrics.label}: model=${metrics.model}, ` +
    `infra failures=${metrics.infraFailures}, quality failures=${metrics.qualityFailures}, ` +
    `trials still truncated after the ladder=${metrics.truncatedTrials}, ` +
    `bigger-budget re-runs spent=${metrics.truncationRetries}`
  );
}

function formatRunReport(allMetrics: ProviderMetrics[], verdict: ContingencyVerdict): string {
  return [
    "",
    `§8 tool-calling check — ${runHeadline(allMetrics, verdict)}`,
    `prompt: ${FIVE_TOOL_USER_PROMPT}`,
    `expected tool: ${EXPECTED_TOOL_NAME} (of ${FIVE_TOOL_DEFINITIONS.length} offered)`,
    `maxTokens ladder: ${MAX_TOKENS_LADDER.join(" -> ")}`,
    "",
    formatMetricsReport(allMetrics),
    "",
    ...allMetrics.map(providerFootnote),
    "",
    formatContingencyVerdictLine(verdict),
    verdict.explanation,
    "",
  ].join("\n");
}

describe.skipIf(!liveProfiles)("§8 live tool-calling check — DeepSeek vs Gemini", () => {
  it(
    "runs 10 sequential trials per provider and reports accuracy, malformed-JSON, and truncation",
    async () => {
      // Safe: `describe.skipIf` above guarantees the profiles resolved.
      const profiles = liveProfiles as LiveProfiles;

      const primary = await runProviderTrials("primary", profiles.primary);
      const fallback = await runProviderTrials("fallback", profiles.fallback);
      const allMetrics = [primary, fallback];

      const verdict = evaluateContingencyTrigger(
        metricsForFamily(allMetrics, profiles, "gemini"),
        metricsForFamily(allMetrics, profiles, "deepseek"),
      );
      console.log(formatRunReport(allMetrics, verdict));

      for (const metrics of allMetrics) {
        expect(metrics.comparable, `${metrics.label} produced no scorable trials`).toBe(true);
        // Split so a rate-limited/outage run fails on its own, distinct
        // assertion, with a message that says "we could not measure" —
        // never conflated with the model-quality assertion below it.
        expect(
          metrics.infraFailures,
          `${metrics.label} could not be measured — ${metrics.infraFailures} trial(s) failed on infrastructure grounds (429/5xx/network/timeout), not model quality. This is not a quality result; rerun once the provider's rate limit/outage has cleared.`,
        ).toBe(0);
        expect(
          metrics.qualityFailures,
          `${metrics.label} produced ${metrics.qualityFailures} quality failure(s) (malformed/unparseable response) — a genuine model-quality result.`,
        ).toBe(0);
        expect(
          metrics.truncatedTrials,
          `${metrics.label} still truncated at ${MAX_TOKENS_LADDER.at(-1)} maxTokens`,
        ).toBe(0);
        expect(metrics.scoredTrials, `${metrics.label} scored trials`).toBe(TRIALS_PER_PROVIDER);
      }
      // A red assertion here is the signal to take the plan's contingency
      // branch (a native Gemini adapter), not a flaky test.
      if (verdict.evaluated) {
        expect(verdict.fired, verdict.explanation).toBe(false);
      }
    },
    LIVE_SUITE_TIMEOUT_MS,
  );
});
