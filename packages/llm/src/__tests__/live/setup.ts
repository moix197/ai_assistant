/**
 * Setup for the live lane only. Nothing in the default `pnpm test` lane
 * imports this file.
 *
 * Two jobs: resolve both live provider profiles from the environment (and say
 * clearly why the suite is *skipped*, never failed, when they are absent), and
 * hand the check a `fetch` that records every raw provider response so the
 * offline replay lane has real fixtures to score.
 *
 * It reads `process.env` (falling back to the repo-root `.env` for keys the
 * shell did not set) rather than going through `@hermes/config`:
 * `packages/llm` must not depend on `@hermes/config` (Phase 1's boundary
 * decision), and `loadConfig` would additionally demand `DATABASE_URL` and
 * `TELEGRAM_BOT_TOKEN`, which this check has no use for.
 */

import { fileURLToPath } from "node:url";
import type { ProviderProfile } from "../../port";
import type { AttemptKind, ProfileSlot, RecordedAttempt } from "../recorded-fixtures";
import { writeRecordedAttempt } from "../recorded-fixtures";

/** The repo-root `.env`, five directories up from `src/__tests__/live/`. */
const REPO_ENV_FILE = fileURLToPath(new URL("../../../../../.env", import.meta.url));

const PROFILE_ENV_KEYS = {
  primary: ["LLM_PRIMARY_BASE_URL", "LLM_PRIMARY_API_KEY", "LLM_PRIMARY_MODEL"],
  fallback: ["LLM_FALLBACK_BASE_URL", "LLM_FALLBACK_API_KEY", "LLM_FALLBACK_MODEL"],
} as const satisfies Record<ProfileSlot, readonly string[]>;

export interface LiveProfiles {
  primary: ProviderProfile;
  fallback: ProviderProfile;
}

/** Every `LLM_*` key this check needs that is unset or empty. Empty array means "ready to run". */
export function missingLiveEnvKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.values(PROFILE_ENV_KEYS)
    .flat()
    .filter((key) => (env[key] ?? "").trim() === "");
}

/**
 * Loads the whole repo-root `.env` when any live key is still unset, so
 * `pnpm test:live` works with no shell setup. There is no `vitest.config.ts`
 * anywhere (the plan forbids one), so nothing else loads that file for us.
 *
 * `process.loadEnvFile` has no per-key filter: one missing `LLM_*` key pulls in
 * every variable the file declares (`DATABASE_URL` and the rest), not just the
 * ones this check needs. Harmless here — the live lane is the only importer —
 * but it is a whole-file load, not a targeted one.
 *
 * Node's own `process.loadEnvFile` never overwrites a key already present in
 * `process.env`, so an explicitly exported value still wins. A missing or
 * unreadable `.env` is not an error: the keys simply stay absent and the suite
 * skips with its usual message.
 *
 * Live lane only — the default `pnpm test` lane never imports this module, so
 * no `.env` is read there.
 */
function loadRepoEnvFileWhenLiveKeysAreMissing(): void {
  if (missingLiveEnvKeys().length === 0) return;
  try {
    process.loadEnvFile(REPO_ENV_FILE);
  } catch {
    // No readable `.env`; the skip path below reports whatever is still missing.
  }
}

loadRepoEnvFileWhenLiveKeysAreMissing();

/** Both profiles, or `undefined` when any key is missing — the caller skips, it never fails. */
export function loadLiveProfiles(env: NodeJS.ProcessEnv = process.env): LiveProfiles | undefined {
  if (missingLiveEnvKeys(env).length > 0) return undefined;
  return {
    primary: readProfile(env, "primary"),
    fallback: readProfile(env, "fallback"),
  };
}

function readProfile(env: NodeJS.ProcessEnv, slot: ProfileSlot): ProviderProfile {
  const [baseUrlKey, apiKeyKey, modelKey] = PROFILE_ENV_KEYS[slot];
  return {
    baseUrl: (env[baseUrlKey] as string).trim(),
    apiKey: (env[apiKeyKey] as string).trim(),
    model: (env[modelKey] as string).trim(),
  };
}

export function formatLiveSkipMessage(missing: string[]): string {
  return [
    "",
    "SKIPPED — the §8 live tool-calling check needs both live provider profiles.",
    `Missing or empty: ${missing.join(", ")}`,
    "Set all six LLM_* keys (both profiles) and re-run:",
    "  pnpm test:live",
    "This suite is skipped, not failed: the default lane must never need credentials.",
    "",
  ].join("\n");
}

export type AttemptContext = Omit<RecordedAttempt, "status" | "bodyText">;

export interface RecordingFetch {
  /** Pass to `createOpenAiCompatibleAdapter`'s `fetchImpl`. */
  fetchImpl: typeof fetch;
  /** Declare which trial the next HTTP call belongs to. */
  beginAttempt(context: AttemptContext): void;
  /** The raw body of the last response, or `""` when the call never reached the server. */
  lastBodyText(): string;
  /** Persists the last response under `fixtures/recorded/`; returns the path written. */
  writeLastAttempt(): string | undefined;
}

/** Headers the adapter actually reads. Copied deliberately rather than cloning wholesale. */
function forwardedHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "retry-after"]) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}

/**
 * Reads each response body once, keeps the text, and hands the adapter an
 * equivalent `Response` built from it — the adapter's own `.json()`/`.text()`
 * still work because the body it receives has never been consumed.
 * Adapter-internal 429/5xx retries simply overwrite the kept attempt, so what
 * is recorded is the response the trial was actually scored on.
 */
export function createRecordingFetch(baseFetch: typeof fetch = fetch): RecordingFetch {
  let context: AttemptContext | undefined;
  let lastAttempt: RecordedAttempt | undefined;

  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    const bodyText = await response.text();
    if (context) lastAttempt = { ...context, status: response.status, bodyText };
    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: forwardedHeaders(response),
    });
  };

  return {
    fetchImpl,
    beginAttempt(next: AttemptContext) {
      context = next;
      lastAttempt = undefined;
    },
    lastBodyText: () => lastAttempt?.bodyText ?? "",
    writeLastAttempt: () => (lastAttempt ? writeRecordedAttempt(lastAttempt) : undefined),
  };
}

export type { AttemptKind, ProfileSlot };
