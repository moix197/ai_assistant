/**
 * Offline unit tests for the pure scoring module both §8 lanes share. No
 * network, no credentials, no fixtures — these guard the three ways the check's
 * *reported numbers* could mislead the reader of decision D5:
 *
 *   1. an unmeasured rate rendering as a measured `0%`
 *   2. a provider with nothing scorable still printing a trigger verdict
 *   3. a provider that never tool-called earning a flattering malformed-JSON rate
 */

import { describe, expect, it } from "vitest";
import type { CompletionResult, FinishReason, ToolDefinition } from "../port";
import {
  type ProviderMetrics,
  type TrialOutcome,
  evaluateContingencyTrigger,
  formatContingencyVerdictLine,
  formatMetricsReport,
  resolveTrialOutcome,
  scoreTrial,
  summarizeOutcomes,
} from "./tool-calling-score";

const TOOLS: ToolDefinition[] = [
  {
    name: "convert_currency",
    description: "Convert money between currencies.",
    parameters: {
      type: "object",
      properties: { amount: { type: "number" }, from: { type: "string" }, to: { type: "string" } },
      required: ["amount", "from", "to"],
    },
  },
];

const TRUNCATED_BODY = JSON.stringify({
  choices: [{ message: { content: null }, finish_reason: "length" }],
  usage: { prompt_tokens: 900, completion_tokens: 0, total_tokens: 900 },
});

function completionResult(
  toolCalls: CompletionResult["toolCalls"],
  finishReason: FinishReason,
): CompletionResult {
  return {
    text: toolCalls.length > 0 ? "" : "I'd rather explain it in prose.",
    toolCalls,
    usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940 },
    finishReason,
  };
}

function scoreToolCallTrial(argumentsJson: string): TrialOutcome {
  const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
  const bodyText = JSON.stringify({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ function: { name: "convert_currency", arguments: argumentsJson } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  return scoreTrial({
    result: completionResult(
      [{ id: "call_1", name: "convert_currency", arguments: parsed }],
      "tool_calls",
    ),
    bodyText,
    expectedToolName: "convert_currency",
    tools: TOOLS,
  });
}

function scoreProseTrial(): TrialOutcome {
  const bodyText = JSON.stringify({
    choices: [{ message: { content: "250 USD is roughly 39,000 JPY." }, finish_reason: "stop" }],
  });
  return scoreTrial({
    result: completionResult([], "stop"),
    bodyText,
    expectedToolName: "convert_currency",
    tools: TOOLS,
  });
}

function scoreTruncatedTrial(): TrialOutcome {
  return scoreTrial({
    bodyText: TRUNCATED_BODY,
    expectedToolName: "convert_currency",
    tools: TOOLS,
  });
}

function summarize(label: string, trials: TrialOutcome[][]): ProviderMetrics {
  return summarizeOutcomes(label, "some-model", trials);
}

describe("resolveTrialOutcome — the max-tokens ladder", () => {
  it("scores the trial on the first attempt that came back scorable", () => {
    const resolved = resolveTrialOutcome([
      scoreTruncatedTrial(),
      scoreToolCallTrial('{"amount":250,"from":"USD","to":"JPY"}'),
    ]);

    expect(resolved?.truncated).toBe(false);
    expect(resolved?.correctTool).toBe(true);
  });

  it("keeps a trial that exhausted the ladder truncated rather than demoting it to a failure", () => {
    const resolved = resolveTrialOutcome([
      scoreTruncatedTrial(),
      scoreTruncatedTrial(),
      scoreTruncatedTrial(),
    ]);

    expect(resolved?.truncated).toBe(true);
    expect(resolved?.malformedArguments).toBe(false);
    expect(resolved?.failure).toBeUndefined();
  });
});

describe("summarizeOutcomes — empty denominators are never 0%", () => {
  it("reports rates as undefined and the provider as not comparable when every trial truncated", () => {
    const metrics = summarize(
      "fallback / gemini",
      [1, 2, 3].map(() => [scoreTruncatedTrial(), scoreTruncatedTrial(), scoreTruncatedTrial()]),
    );

    expect(metrics.scoredTrials).toBe(0);
    expect(metrics.comparable).toBe(false);
    expect(metrics.accuracyPct).toBeUndefined();
    expect(metrics.malformedJsonPct).toBeUndefined();
    expect(metrics.truncatedTrials).toBe(3);
    expect(metrics.truncationRetries).toBe(6);
  });

  it('renders an unmeasured rate as "n/a" and flags the run INVALID, never printing a 0%', () => {
    const metrics = summarize("fallback / gemini", [[scoreTruncatedTrial()]]);

    const report = formatMetricsReport([metrics]);

    expect(report).toContain("0/0 (n/a)");
    expect(report).not.toContain("(0%)");
    expect(report).toContain("INVALID");
    expect(report).toContain("NOT COMPARABLE");
  });

  it('distinguishes a real measured 0% from an unmeasured "n/a" in the same row', () => {
    const metrics = summarize("primary / deepseek", [[scoreProseTrial()], [scoreProseTrial()]]);

    expect(metrics.accuracyPct).toBe(0);
    expect(metrics.malformedJsonPct).toBeUndefined();
    expect(formatMetricsReport([metrics])).toContain("0/2 (0%)");
    expect(formatMetricsReport([metrics])).toContain("0/0 (n/a)");
  });
});

describe("summarizeOutcomes — malformed-JSON denominator", () => {
  it("counts only trials that attempted a tool call, so prose-only trials do not flatter the rate", () => {
    const metrics = summarize("primary / deepseek", [
      [scoreProseTrial()],
      [scoreProseTrial()],
      [scoreProseTrial()],
      [scoreToolCallTrial('{"amount":250,"from":"USD","to":"JPY"}')],
      [scoreToolCallTrial('{"amount":"250","from":"USD","to":"JPY"}')],
    ]);

    expect(metrics.scoredTrials).toBe(5);
    expect(metrics.attemptedToolCallTrials).toBe(2);
    expect(metrics.malformedJsonTrials).toBe(1);
    expect(metrics.malformedJsonPct).toBe(50);
  });

  it("keeps accuracy's denominator at scorable trials, unchanged by the malformed split", () => {
    const metrics = summarize("primary / deepseek", [
      [scoreProseTrial()],
      [scoreToolCallTrial('{"amount":250,"from":"USD","to":"JPY"}')],
    ]);

    expect(metrics.accuracyPct).toBe(50);
    expect(metrics.correctToolCalls).toBe(1);
    expect(metrics.scoredTrials).toBe(2);
  });

  it("shows the attempted-tool-call denominator in the report", () => {
    const metrics = summarize("primary / deepseek", [
      [scoreProseTrial()],
      [scoreToolCallTrial('{"amount":"250","from":"USD","to":"JPY"}')],
    ]);

    expect(formatMetricsReport([metrics])).toContain("1/1 (100%)");
  });
});

describe("evaluateContingencyTrigger — zero scorable trials", () => {
  const deepseek = summarize("primary / deepseek", [
    [scoreToolCallTrial('{"amount":250,"from":"USD","to":"JPY"}')],
  ]);
  const geminiAllTruncated = summarize("fallback / gemini", [[scoreTruncatedTrial()]]);

  it("does not evaluate, and never reports fired or not-fired", () => {
    const verdict = evaluateContingencyTrigger(geminiAllTruncated, deepseek);

    expect(verdict.evaluated).toBe(false);
    expect(verdict.fired).toBe(false);
    expect(verdict.explanation).toContain("NOT EVALUATED — insufficient scorable trials");
    expect(verdict.explanation).not.toContain("TRIGGER FIRED");
    expect(verdict.explanation).not.toContain("TRIGGER DID NOT FIRE");
  });

  it('prints the verdict line as "NOT EVALUATED", not "not fired"', () => {
    const line = formatContingencyVerdictLine(
      evaluateContingencyTrigger(geminiAllTruncated, deepseek),
    );

    expect(line).toBe("contingency trigger: NOT EVALUATED — insufficient scorable trials");
    expect(line).not.toContain("FIRED");
  });

  it("still evaluates normally once both providers have scorable trials", () => {
    const geminiProse = summarize("fallback / gemini", [[scoreProseTrial()]]);

    const verdict = evaluateContingencyTrigger(geminiProse, deepseek);

    expect(verdict.evaluated).toBe(true);
    expect(verdict.fired).toBe(true);
    expect(formatContingencyVerdictLine(verdict)).toBe("contingency trigger: FIRED");
  });
});
