/**
 * Default-lane companion to the §8 live check: replays the raw responses the
 * live run recorded, through the same adapter and the same scoring module, with
 * zero network and zero credentials. This is what keeps the check's assertion
 * code exercised in CI without spending money on every run.
 *
 * `fixtures/recorded/` is empty until the orchestrator performs the live run,
 * so this suite skips loudly rather than failing — and it never fabricates a
 * fixture: an invented response would poison decision D5.
 */

import { describe, expect, it } from "vitest";
import {
  EXPECTED_TOOL_NAME,
  FIVE_TOOL_DEFINITIONS,
  buildFiveToolRequest,
} from "./live/fixtures/five-tool-prompt";
import {
  type ProfileSlot,
  RECORDED_FIXTURES_DIR,
  type RecordedAttempt,
  groupAttemptsBySlot,
  groupAttemptsByTrial,
  readRecordedAttempts,
  replayRecordedAttempt,
  scorableRecordedAttempts,
} from "./recorded-fixtures";
import {
  type ProviderMetrics,
  TRIALS_PER_PROVIDER,
  type TrialOutcome,
  evaluateContingencyTrigger,
  formatContingencyVerdictLine,
  formatMetricsReport,
  scoreTrial,
  summarizeOutcomes,
} from "./tool-calling-score";

const allRecordedAttempts = readRecordedAttempts();
const recordedAttempts = scorableRecordedAttempts(allRecordedAttempts);
const skippedNon200 = allRecordedAttempts.length - recordedAttempts.length;
const hasFixtures = recordedAttempts.length > 0;

if (!hasFixtures) {
  console.warn(
    [
      "",
      "SKIPPED — §8 tool-calling fixture replay has no scorable (HTTP 200) fixtures to replay.",
      `${RECORDED_FIXTURES_DIR} holds ${allRecordedAttempts.length} recording(s), ${skippedNon200} of them non-200.`,
      "A non-200 recording is the live run failing to reach the model; it is kept as evidence, never scored.",
      "Scorable fixtures come only from the live run, which costs real money and needs real keys:",
      "  pnpm test:live",
      "Fixtures are never hand-written: a fabricated response would poison decision D5.",
      "",
    ].join("\n"),
  );
}

async function scoreRecordedAttempt(attempt: RecordedAttempt): Promise<TrialOutcome> {
  const { result, error } = await replayRecordedAttempt(
    attempt,
    buildFiveToolRequest(attempt.model, attempt.maxTokens),
  );
  return scoreTrial({
    result,
    error,
    bodyText: attempt.bodyText,
    expectedToolName: EXPECTED_TOOL_NAME,
    tools: FIVE_TOOL_DEFINITIONS,
  });
}

async function scoreTrialLadder(ladder: RecordedAttempt[]): Promise<TrialOutcome[]> {
  const outcomes: TrialOutcome[] = [];
  for (const attempt of ladder) {
    outcomes.push(await scoreRecordedAttempt(attempt));
  }
  return outcomes;
}

async function scoreSlot(slot: ProfileSlot, attempts: RecordedAttempt[]): Promise<ProviderMetrics> {
  const trials: TrialOutcome[][] = [];
  for (const ladder of groupAttemptsByTrial(attempts)) {
    trials.push(await scoreTrialLadder(ladder));
  }
  const family = attempts[0]?.providerFamily ?? "unknown";
  return summarizeOutcomes(`${slot} / ${family}`, attempts[0]?.model ?? "unknown", trials);
}

describe("§8 tool-calling check — offline fixture replay", () => {
  it.skipIf(!hasFixtures)(
    "re-scores the recorded live responses through the same accuracy/malformed/truncation logic",
    async () => {
      const bySlot = groupAttemptsBySlot(recordedAttempts);
      const allMetrics: ProviderMetrics[] = [];

      for (const [slot, attempts] of bySlot) {
        expect(groupAttemptsByTrial(attempts).length, `${slot} trials`).toBe(TRIALS_PER_PROVIDER);
        allMetrics.push(await scoreSlot(slot, attempts));
      }

      const byFamily = (family: string) => allMetrics.find((m) => m.label.endsWith(family));
      const verdict = evaluateContingencyTrigger(byFamily("gemini"), byFamily("deepseek"));

      console.log(
        `\n${formatMetricsReport(allMetrics)}\n\n${formatContingencyVerdictLine(verdict)}\n`,
      );

      for (const metrics of allMetrics) {
        expect(metrics.comparable, `${metrics.label} produced no scorable trials`).toBe(true);
        expect(metrics.hardFailures, `${metrics.label} had unrecoverable trials`).toBe(0);
        expect(metrics.scoredTrials, `${metrics.label} scored trials`).toBe(TRIALS_PER_PROVIDER);
        expect(metrics.correctToolCalls).toBeLessThanOrEqual(metrics.scoredTrials);
        expect(metrics.malformedJsonTrials).toBeLessThanOrEqual(metrics.attemptedToolCallTrials);
      }

      expect(verdict.explanation.length).toBeGreaterThan(0);
    },
  );
});
