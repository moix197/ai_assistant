/**
 * On-disk format for the §8 check's recorded raw responses, plus the reader
 * the offline replay lane uses. Kept separate from `tool-calling-score.ts` so
 * the scoring stays pure: this module is the only place that touches the
 * filesystem or reconstructs a `Response`.
 *
 * The recorded directory is populated **only** by a real
 * `pnpm --filter @hermes/llm test:live` run. It is never fabricated: an
 * invented fixture would poison decision D5.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAiCompatibleAdapter } from "../adapter/openai-compatible";
import type { CompletionRequest, CompletionResult } from "../port";

export const RECORDED_FIXTURES_DIR = fileURLToPath(
  new URL("./live/fixtures/recorded/", import.meta.url),
);

export type ProfileSlot = "primary" | "fallback";
/** `initial` is the trial as specified; `retry` is the bigger-budget re-run after a truncation. */
export type AttemptKind = "initial" | "retry";

export interface RecordedAttempt {
  profileSlot: ProfileSlot;
  providerFamily: string;
  model: string;
  trial: number;
  /** 1-based rung of the trial's max-tokens ladder. Keeps successive re-runs distinct on disk. */
  attemptIndex: number;
  attemptKind: AttemptKind;
  maxTokens: number;
  status: number;
  /** The provider's response body, verbatim. Never contains the API key. */
  bodyText: string;
}

function fixtureFileName(attempt: RecordedAttempt): string {
  const trial = String(attempt.trial).padStart(2, "0");
  const index = String(attempt.attemptIndex).padStart(2, "0");
  return `${attempt.profileSlot}-trial-${trial}-attempt-${index}-${attempt.attemptKind}.json`;
}

/**
 * Writes one attempt, overwriting any earlier HTTP attempt for the same ladder
 * rung so the file always holds the response that rung was actually scored on
 * (adapter-internal 429/5xx retries are not separate attempts).
 */
export function writeRecordedAttempt(attempt: RecordedAttempt): string {
  mkdirSync(RECORDED_FIXTURES_DIR, { recursive: true });
  const path = join(RECORDED_FIXTURES_DIR, fixtureFileName(attempt));
  writeFileSync(path, `${JSON.stringify(attempt, null, 2)}\n`, "utf8");
  return path;
}

/** Every recorded attempt, sorted by filename. Empty when the live run has not happened yet. */
export function readRecordedAttempts(): RecordedAttempt[] {
  if (!existsSync(RECORDED_FIXTURES_DIR)) return [];
  return readdirSync(RECORDED_FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(RECORDED_FIXTURES_DIR, name), "utf8")));
}

/**
 * The recordings the replay lane may score: HTTP 200 only. A non-200 attempt
 * is the live run failing to reach the model at all — a transport or
 * request-shape fault — so it measures nothing about tool calling and would
 * otherwise land in the hard-failure column and mark the whole run NOT
 * COMPARABLE. Such recordings are deliberately *kept on disk as evidence* of
 * the run that produced them and skipped here rather than deleted.
 */
export function scorableRecordedAttempts(attempts: RecordedAttempt[]): RecordedAttempt[] {
  return attempts.filter((attempt) => attempt.status === 200);
}

export function groupAttemptsBySlot(
  attempts: RecordedAttempt[],
): Map<ProfileSlot, RecordedAttempt[]> {
  const bySlot = new Map<ProfileSlot, RecordedAttempt[]>();
  for (const attempt of attempts) {
    const existing = bySlot.get(attempt.profileSlot);
    if (existing) existing.push(attempt);
    else bySlot.set(attempt.profileSlot, [attempt]);
  }
  return bySlot;
}

/**
 * One entry per trial, in trial order, each holding that trial's max-tokens
 * ladder in rung order — the shape `summarizeOutcomes` folds.
 */
export function groupAttemptsByTrial(attempts: RecordedAttempt[]): RecordedAttempt[][] {
  const byTrial = new Map<number, RecordedAttempt[]>();
  for (const attempt of attempts) {
    const existing = byTrial.get(attempt.trial);
    if (existing) existing.push(attempt);
    else byTrial.set(attempt.trial, [attempt]);
  }
  return [...byTrial.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, ladder]) => ladder.sort((left, right) => left.attemptIndex - right.attemptIndex));
}

/**
 * Feeds a recorded body back through the real adapter so the replay lane
 * exercises the same parsing the live lane did. Non-200 fixtures short-circuit:
 * the adapter would burn its bounded 429/5xx backoff re-hitting a fixed
 * fixture, and the recorded status already *is* the trial's outcome.
 */
export async function replayRecordedAttempt(
  attempt: RecordedAttempt,
  request: CompletionRequest,
): Promise<{ result?: CompletionResult; error?: unknown }> {
  if (attempt.status !== 200) {
    return { error: new Error(`recorded HTTP ${attempt.status}: ${attempt.bodyText}`) };
  }

  const fetchImpl: typeof fetch = async () =>
    new Response(attempt.bodyText, {
      status: attempt.status,
      headers: { "content-type": "application/json" },
    });
  const adapter = createOpenAiCompatibleAdapter(
    { baseUrl: "https://replay.invalid/v1", apiKey: "replay", model: attempt.model },
    {
      fetchImpl,
      // `usageRepo`/`budget` are mandatory adapter options (Phase 4 gap
      // fix); this replay lane re-scores recorded bodies offline and has
      // nothing to do with usage accounting or the budget ceiling.
      usageRepo: { recordUsage: async () => {} },
      budget: { usageRepo: { sumCostSince: async () => 0 }, capUsd: Number.POSITIVE_INFINITY },
    },
  );

  try {
    return { result: await adapter.complete(request) };
  } catch (error) {
    return { error };
  }
}
