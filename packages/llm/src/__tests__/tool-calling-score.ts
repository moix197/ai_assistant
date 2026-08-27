/**
 * Scoring for the ROADMAP §8 tool-calling check. Pure — no network, no fs, no
 * env — so the live lane (`live/tool-calling-check.live.test.ts`) and the
 * offline replay lane (`tool-calling-check-fixture-replay.test.ts`) score
 * through *the same code*, not two drifting copies.
 *
 * Three independent columns per provider, per the plan:
 *   1. tool-call accuracy      — did the model pick the fixture's expected tool,
 *                                over the trials that produced a scorable answer
 *   2. malformed-JSON rate     — did its tool-call arguments fail to parse (or
 *                                violate the tool's declared JSON Schema), over
 *                                the trials where it *attempted* a tool call.
 *                                Prose-only trials are not in this denominator:
 *                                a model that ignores tool-calling entirely must
 *                                not thereby earn a perfect malformed-JSON rate
 *   3. truncated-trial count   — a *separate* column: a budget-truncated
 *                                reasoning model answers HTTP 200 with
 *                                `finish_reason: "length"` and no `content`,
 *                                which the Phase 1 adapter raises as
 *                                `LlmMalformedResponseError`. That is a spend
 *                                problem, not a tool-calling problem, and must
 *                                never inflate column 2.
 *
 * Every rate here is `undefined` — rendered `n/a` — over an empty denominator.
 * These numbers are copied into a permanent decision record, so an unmeasured
 * rate must never be mistakable for a measured 0%.
 */

import type { ToolCall } from "@hermes/core";
import { LlmMalformedResponseError } from "../errors";
import type { CompletionResult, ProviderProfile, ToolDefinition } from "../port";

/** Trials per provider, per ROADMAP §8 (bounded and free-tier-safe). */
export const TRIALS_PER_PROVIDER = 10;

/**
 * The concrete numeric trigger from the plan's `Dependencies & Risks`. The
 * native-Gemini-adapter contingency fires if and only if Gemini's
 * malformed-JSON rate is >= 20% *or* its accuracy is <= 70%, **and** DeepSeek
 * does not show the same problem on the same run (malformed < 10% and
 * accuracy >= 90%) — the second clause exists so a fixture-quality problem
 * degrading both providers equally is not mistaken for a Gemini regression.
 */
export const CONTINGENCY_TRIGGER = {
  geminiMalformedPctAtLeast: 20,
  geminiAccuracyPctAtMost: 70,
  deepseekMalformedPctBelow: 10,
  deepseekAccuracyPctAtLeast: 90,
} as const;

/**
 * `"infra"` — the trial could not be measured at all: a 429/5xx, a network or
 * timeout error, a shutdown abort, or the harness never getting a result.
 * `"quality"` — the model *answered*, but with something unusable (malformed
 * or unparseable). Only a `LlmMalformedResponseError` is a quality signal;
 * see `classifyFailureKind`. A pure rate-limit run must read as "we could not
 * measure Gemini", never as "Gemini did badly" — conflating the two nearly
 * corrupted a decision record from a live run that was purely 429s.
 */
export type FailureKind = "infra" | "quality";

export interface TrialOutcome {
  /** The tool the model picked, or `undefined` when it answered with prose. */
  pickedTool: string | undefined;
  /** The model emitted a tool call at all. This — not "trial" — is the malformed-JSON denominator. */
  attemptedToolCall: boolean;
  correctTool: boolean;
  malformedArguments: boolean;
  /** Budget truncation, scored in its own column and re-run with a bigger budget. */
  truncated: boolean;
  /** Set when the trial produced neither a scorable answer nor a truncation. */
  failure: string | undefined;
  /** Set alongside `failure`; `undefined` exactly when `failure` is. */
  failureKind: FailureKind | undefined;
  detail: string | undefined;
}

export interface ProviderMetrics {
  label: string;
  model: string;
  /** Trials attempted, regardless of how they resolved. */
  totalTrials: number;
  /** Trials that produced a scorable answer (excludes truncations and hard failures). */
  scoredTrials: number;
  /** False when nothing scorable came back: this provider's run is INVALID / NOT COMPARABLE. */
  comparable: boolean;
  correctToolCalls: number;
  /** Over `scoredTrials`. `undefined` when that denominator is empty — render as `n/a`, never 0%. */
  accuracyPct: number | undefined;
  /** Scorable trials in which the model actually emitted a tool call. */
  attemptedToolCallTrials: number;
  malformedJsonTrials: number;
  /** Over `attemptedToolCallTrials`. `undefined` when that denominator is empty. */
  malformedJsonPct: number | undefined;
  /** Trials still truncated after the caller's max-tokens ladder was exhausted. */
  truncatedTrials: number;
  /** Extra attempts the ladder spent re-running truncated trials with a bigger budget. */
  truncationRetries: number;
  /** `infraFailures + qualityFailures`. Kept for callers that only need "did anything go hard-wrong". */
  hardFailures: number;
  /** 429/5xx/network/timeout/abort: we could not measure this trial at all. */
  infraFailures: number;
  /** The model answered with something unusable (malformed/unparseable). A real quality signal. */
  qualityFailures: number;
}

export type ProviderFamily = "gemini" | "deepseek" | "unknown";

/**
 * Which slot (`LLM_PRIMARY_*` / `LLM_FALLBACK_*`) holds which provider is not
 * fixed: the plan's Prerequisites put Gemini in the primary slot during
 * development and swap them at Final Verification. The contingency trigger is
 * written in terms of *Gemini vs DeepSeek*, so the family is identified from
 * the profile itself rather than assumed from the slot.
 */
export function identifyProviderFamily(profile: ProviderProfile): ProviderFamily {
  const haystack = `${profile.model} ${profile.baseUrl}`.toLowerCase();
  if (haystack.includes("gemini") || haystack.includes("googleapis")) return "gemini";
  if (haystack.includes("deepseek")) return "deepseek";
  return "unknown";
}

/**
 * A budget-truncated reasoning model: HTTP 200, `finish_reason: "length"`, and
 * no usable `content`. Detected from the raw body because the adapter throws
 * before the caller can see the finish reason.
 */
export function isBudgetTruncation(bodyText: string): boolean {
  const choice = firstChoice(bodyText);
  if (!choice) return false;
  const hasText = typeof choice.message?.content === "string" && choice.message.content !== "";
  const hasToolCall = (choice.message?.tool_calls?.length ?? 0) > 0;
  return choice.finish_reason === "length" && !hasText && !hasToolCall;
}

interface RawChoice {
  finish_reason?: string;
  message?: {
    content?: string | null;
    tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  };
}

function firstChoice(bodyText: string): RawChoice | undefined {
  try {
    const payload = JSON.parse(bodyText) as { choices?: RawChoice[] };
    return payload.choices?.[0];
  } catch {
    return undefined;
  }
}

/**
 * The adapter deliberately swallows a tool-call `JSON.parse` failure into an
 * empty argument object, so "did the arguments parse" can only be answered
 * from the raw body. `undefined` means "no raw tool call to check".
 */
function rawToolCallArgumentsFailedToParse(bodyText: string): boolean | undefined {
  const raw = firstChoice(bodyText)?.message?.tool_calls?.[0]?.function?.arguments;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed !== "object" || parsed === null || Array.isArray(parsed);
  } catch {
    return true;
  }
}

interface JsonSchemaShape {
  properties?: Record<string, { type?: string }>;
  required?: string[];
}

function matchesJsonType(value: unknown, type: string | undefined): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/** Returns a human-readable violation, or `undefined` when the arguments fit the schema. */
export function findSchemaViolation(
  toolCall: ToolCall,
  tools: ToolDefinition[],
): string | undefined {
  const tool = tools.find((candidate) => candidate.name === toolCall.name);
  if (!tool) return `model called unknown tool "${toolCall.name}"`;

  const schema = tool.parameters as JsonSchemaShape;
  for (const key of schema.required ?? []) {
    if (!(key in toolCall.arguments)) return `missing required argument "${key}"`;
  }
  for (const [key, value] of Object.entries(toolCall.arguments)) {
    const expectedType = schema.properties?.[key]?.type;
    if (!matchesJsonType(value, expectedType)) {
      return `argument "${key}" is not of declared type "${expectedType}"`;
    }
  }
  return undefined;
}

export interface TrialInput {
  result?: CompletionResult;
  error?: unknown;
  /** The raw HTTP body the adapter saw, recorded verbatim. */
  bodyText: string;
  expectedToolName: string;
  tools: ToolDefinition[];
}

const CLEAN_OUTCOME: TrialOutcome = {
  pickedTool: undefined,
  attemptedToolCall: false,
  correctTool: false,
  malformedArguments: false,
  truncated: false,
  failure: undefined,
  failureKind: undefined,
  detail: undefined,
};

/**
 * Only a malformed/unparseable response is a genuine quality signal — the
 * model answered, just with something unusable. Everything else the adapter
 * throws (`LlmHttpError` for a 429/5xx, `LlmTimeoutError`, `LlmAbortedError`,
 * a redacted network-failure `Error`) is a transport-level failure: we could
 * not measure the trial at all, so it must not count against the model.
 */
function classifyFailureKind(error: unknown): FailureKind {
  return error instanceof LlmMalformedResponseError ? "quality" : "infra";
}

/** Scores one attempt into the three columns. The single source of truth for both lanes. */
export function scoreTrial(input: TrialInput): TrialOutcome {
  if (isBudgetTruncation(input.bodyText)) {
    return { ...CLEAN_OUTCOME, truncated: true, detail: 'finish_reason "length", no content' };
  }
  if (input.error !== undefined) return scoreFailedTrial(input.error);
  if (!input.result) {
    // The harness never got a result and never caught an error either — an
    // internal inconsistency, not a model answer, so "we could not measure"
    // (infra) rather than "the model did badly" (quality).
    return {
      ...CLEAN_OUTCOME,
      failure: "NoResult",
      failureKind: "infra",
      detail: "no result recorded",
    };
  }
  return scoreCompletedTrial(input.result, input);
}

function scoreFailedTrial(error: unknown): TrialOutcome {
  const failure = error instanceof Error ? error.name : "UnknownError";
  const detail = error instanceof Error ? error.message : String(error);
  return { ...CLEAN_OUTCOME, failure, failureKind: classifyFailureKind(error), detail };
}

function scoreCompletedTrial(result: CompletionResult, input: TrialInput): TrialOutcome {
  const toolCall = result.toolCalls[0];
  if (!toolCall) {
    if (result.finishReason === "length") {
      return { ...CLEAN_OUTCOME, truncated: true, detail: 'finish_reason "length", no tool call' };
    }
    return { ...CLEAN_OUTCOME, detail: "answered with prose, no tool call" };
  }

  const parseFailed = rawToolCallArgumentsFailedToParse(input.bodyText) === true;
  const violation = findSchemaViolation(toolCall, input.tools);
  const malformedArguments = parseFailed || violation !== undefined;

  return {
    pickedTool: toolCall.name,
    attemptedToolCall: true,
    correctTool: toolCall.name === input.expectedToolName,
    malformedArguments,
    truncated: false,
    failure: undefined,
    failureKind: undefined,
    detail: parseFailed ? "tool-call arguments are not valid JSON" : violation,
  };
}

/** `undefined` over an empty denominator: a rate nobody measured is not 0%. */
function rate(part: number, whole: number): number | undefined {
  return whole === 0 ? undefined : Math.round((part / whole) * 1000) / 10;
}

/** `"3/10 (30%)"`, or `"0/0 (n/a)"` when nothing was measured. */
export function formatRate(part: number, whole: number, pct: number | undefined): string {
  return `${part}/${whole} (${pct === undefined ? "n/a" : `${pct}%`})`;
}

function isScorable(outcome: TrialOutcome): boolean {
  return !outcome.truncated && outcome.failure === undefined;
}

/**
 * Folds one trial's max-tokens ladder into the single outcome that trial is
 * scored on: the first attempt that came back scorable, else the last attempt —
 * which is what "still truncated after the ladder was exhausted" looks like, and
 * is deliberately kept truncated rather than demoted into an accuracy or
 * malformed-JSON failure.
 */
export function resolveTrialOutcome(attempts: TrialOutcome[]): TrialOutcome | undefined {
  return attempts.find(isScorable) ?? attempts.at(-1);
}

/**
 * Folds one provider's trials into the three columns. Each entry is one trial's
 * attempt ladder (initial attempt first, bigger-budget re-runs after).
 *
 * Truncated and hard-failed trials are excluded from both denominators;
 * additionally, prose-only trials are excluded from the malformed-JSON
 * denominator, since a model that never tool-called produced no tool-call JSON
 * to be malformed.
 */
export function summarizeOutcomes(
  label: string,
  model: string,
  trials: TrialOutcome[][],
): ProviderMetrics {
  const resolved = trials.map(resolveTrialOutcome).filter((outcome) => outcome !== undefined);
  const scored = resolved.filter(isScorable);
  const attempted = scored.filter((outcome) => outcome.attemptedToolCall);
  const correctToolCalls = scored.filter((outcome) => outcome.correctTool).length;
  const malformedJsonTrials = attempted.filter((outcome) => outcome.malformedArguments).length;
  const failed = resolved.filter((outcome) => outcome.failure !== undefined);
  const infraFailures = failed.filter((outcome) => outcome.failureKind === "infra").length;
  const qualityFailures = failed.filter((outcome) => outcome.failureKind === "quality").length;

  return {
    label,
    model,
    totalTrials: trials.length,
    scoredTrials: scored.length,
    comparable: scored.length > 0,
    correctToolCalls,
    accuracyPct: rate(correctToolCalls, scored.length),
    attemptedToolCallTrials: attempted.length,
    malformedJsonTrials,
    malformedJsonPct: rate(malformedJsonTrials, attempted.length),
    truncatedTrials: resolved.filter((outcome) => outcome.truncated).length,
    truncationRetries: trials.reduce(
      (total, attempts) => total + Math.max(attempts.length - 1, 0),
      0,
    ),
    hardFailures: failed.length,
    infraFailures,
    qualityFailures,
  };
}

export interface ContingencyVerdict {
  /**
   * False when the run cannot support a verdict at all — either it lacks one
   * identifiable Gemini and one DeepSeek profile, or a provider produced no
   * scorable trials. A non-evaluated verdict is never reported as "not fired".
   */
  evaluated: boolean;
  fired: boolean;
  explanation: string;
}

/**
 * A rate for threshold comparison. An unmeasured rate (empty denominator)
 * cannot trip a threshold, so it reads as 0 here — it never *creates* a
 * verdict. A provider that never tool-called has no malformed-JSON evidence
 * either way, and its 0% accuracy is what carries the verdict instead.
 */
function thresholdRate(pct: number | undefined): number {
  return pct ?? 0;
}

export function evaluateContingencyTrigger(
  gemini: ProviderMetrics | undefined,
  deepseek: ProviderMetrics | undefined,
): ContingencyVerdict {
  if (!gemini || !deepseek) {
    return {
      evaluated: false,
      fired: false,
      explanation:
        "Contingency trigger NOT EVALUATED — the run did not contain one identifiable " +
        "Gemini profile and one identifiable DeepSeek profile. Judge the numbers by hand.",
    };
  }
  if (!gemini.comparable || !deepseek.comparable) {
    return {
      evaluated: false,
      fired: false,
      explanation: [
        "Contingency trigger NOT EVALUATED — insufficient scorable trials ",
        `(${gemini.label}: ${gemini.scoredTrials} scorable, `,
        `${deepseek.label}: ${deepseek.scoredTrials} scorable). `,
        "This run is INVALID for at least one provider; record nothing from it in D5.",
      ].join(""),
    };
  }

  const geminiMalformedPct = thresholdRate(gemini.malformedJsonPct);
  const geminiAccuracyPct = thresholdRate(gemini.accuracyPct);
  const deepseekMalformedPct = thresholdRate(deepseek.malformedJsonPct);
  const deepseekAccuracyPct = thresholdRate(deepseek.accuracyPct);

  const geminiIsBad =
    geminiMalformedPct >= CONTINGENCY_TRIGGER.geminiMalformedPctAtLeast ||
    geminiAccuracyPct <= CONTINGENCY_TRIGGER.geminiAccuracyPctAtMost;
  const deepseekIsClean =
    deepseekMalformedPct < CONTINGENCY_TRIGGER.deepseekMalformedPctBelow &&
    deepseekAccuracyPct >= CONTINGENCY_TRIGGER.deepseekAccuracyPctAtLeast;
  const fired = geminiIsBad && deepseekIsClean;

  return {
    evaluated: true,
    fired,
    explanation: [
      `Gemini malformed-JSON ${geminiMalformedPct}% (>= ${CONTINGENCY_TRIGGER.geminiMalformedPctAtLeast}%?) `,
      `or accuracy ${geminiAccuracyPct}% (<= ${CONTINGENCY_TRIGGER.geminiAccuracyPctAtMost}%?) => ${geminiIsBad}; `,
      `DeepSeek malformed-JSON ${deepseekMalformedPct}% (< ${CONTINGENCY_TRIGGER.deepseekMalformedPctBelow}%?) `,
      `and accuracy ${deepseekAccuracyPct}% (>= ${CONTINGENCY_TRIGGER.deepseekAccuracyPctAtLeast}%?) => ${deepseekIsClean}. `,
      fired
        ? "TRIGGER FIRED: build packages/llm/src/adapter/gemini-native.ts, scoped to this failure mode."
        : "TRIGGER DID NOT FIRE: no native Gemini adapter; the OpenAI-compatible path serves both.",
    ].join(""),
  };
}

/** The one line a reader should look at first: FIRED, DID NOT FIRE, or NOT EVALUATED. */
export function formatContingencyVerdictLine(verdict: ContingencyVerdict): string {
  if (!verdict.evaluated)
    return "contingency trigger: NOT EVALUATED — insufficient scorable trials";
  return `contingency trigger: ${verdict.fired ? "FIRED" : "not fired"}`;
}

const REPORT_HEADER = [
  "provider                       accuracy          malformed-JSON     truncated  status",
  "------------------------------ ----------------- ------------------ ---------- ------------------------",
];

function metricsRow(metrics: ProviderMetrics): string {
  return [
    metrics.label.padEnd(31),
    formatRate(metrics.correctToolCalls, metrics.scoredTrials, metrics.accuracyPct).padEnd(18),
    formatRate(
      metrics.malformedJsonTrials,
      metrics.attemptedToolCallTrials,
      metrics.malformedJsonPct,
    ).padEnd(19),
    String(metrics.truncatedTrials).padEnd(11),
    metrics.comparable ? "comparable" : "INVALID — NOT COMPARABLE",
  ].join("");
}

function invalidRunNote(metrics: ProviderMetrics): string {
  return [
    `INVALID RUN — ${metrics.label} produced 0 scorable trials out of ${metrics.totalTrials} `,
    `(${metrics.truncatedTrials} still truncated, ${metrics.infraFailures} infra failures, `,
    `${metrics.qualityFailures} quality failures). `,
    metrics.infraFailures > 0 && metrics.qualityFailures === 0
      ? "This run could not be measured (infrastructure only, e.g. rate limiting) — "
      : "",
    "Its numbers are NOT COMPARABLE and must not be recorded in D5.",
  ].join("");
}

/** The three-column report printed by both lanes, plus its denominators in plain sight. */
export function formatMetricsReport(allMetrics: ProviderMetrics[]): string {
  const notes = [
    "accuracy denominator = scorable trials; malformed-JSON denominator = trials that attempted a tool call.",
    "'n/a' means the denominator was empty: nothing was measured. It is not a measured 0%.",
    ...allMetrics.filter((metrics) => !metrics.comparable).map(invalidRunNote),
  ];
  return [...REPORT_HEADER, ...allMetrics.map(metricsRow), "", ...notes].join("\n");
}
