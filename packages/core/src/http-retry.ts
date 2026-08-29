import { MAX_DELAY_MS, nextDelay } from "./backoff";
import { delay } from "./delay";

export interface RetryClassConfig {
  /** Bound on attempts made under this class before giving up. */
  maxAttempts: number;
  /**
   * Builds the error thrown once `maxAttempts` is exceeded, in place of
   * rethrowing the classified failure verbatim — e.g. a class whose
   * exhausted-retries message should read differently from any single
   * attempt's own error (see `packages/channels`' 409-conflict class:
   * `client.ts`'s `conflict` class names the other `getUpdates` consumer
   * only once retries are actually exhausted, not on every attempt).
   * Default: rethrow the same error every failed attempt under this class
   * already carried.
   */
  buildExhaustedError?: (error: unknown, attemptsMade: number) => Error;
}

export interface RetryClassification<TClassName extends string> {
  class: TClassName;
  /**
   * A caller-computed delay (ms) that beats computed backoff — e.g. a
   * `Retry-After` header's value, or (per `packages/llm`) a body-carried
   * `RetryInfo.retryDelay` fallback when no header is sent. Capped at the
   * same ceiling as computed backoff either way (see `resolveDelayMs`).
   */
  retryAfterMs?: number;
}

export interface HttpRetryOptions<T, TClassName extends string> {
  /**
   * Performs exactly one attempt against `signal` — already composed by
   * this helper from `timeoutMs` and `externalSignal` below, see
   * `runOneAttempt` — and either resolves with the success value or
   * throws. A failure that should never be retried (a non-retryable HTTP
   * status, a malformed body, an already-typed abort/timeout error, ...)
   * must be thrown as the caller's own typed error directly, whether from
   * here or from `classify`: this function never constructs or throws a
   * typed error of its own.
   */
  attempt: (signal: AbortSignal) => Promise<T>;
  /** Per-request timeout (ms). A fresh `AbortController` backs every attempt. */
  timeoutMs: number;
  /**
   * The boot-lifetime shutdown signal, composed with — not a replacement
   * for — each attempt's own per-request timeout, via a manual `abort`
   * listener added on this signal and removed in a `finally` once the
   * attempt settles, driving the attempt's own `AbortController` — never
   * `AbortSignal.any`, which Node 22 never releases a dependent signal
   * from (measured ~2.5KB/call leak; see `packages/channels`' `client.ts`,
   * whose already-proven listener pattern this generalizes for every
   * caller).
   */
  externalSignal?: AbortSignal;
  /** Named, caller-defined retry classes — arbitrary keys, each independently bounded and backed off. */
  classes: Record<TClassName, RetryClassConfig>;
  /**
   * Maps a thrown `attempt()` error to one of `classes`' names, optionally
   * with a computed `retryAfterMs`. This helper never hardcodes what
   * "rate limited" or "fatal" means for a given protocol — that mapping,
   * and any retryAfter parsing (header, response body, ...), is entirely
   * `classify`'s job. A non-retryable error must be thrown directly from
   * here instead of returned.
   */
  classify: (error: unknown) => RetryClassification<TClassName>;
  /**
   * Builds the error thrown when the external shutdown signal is found
   * already aborted right after a failed attempt — lets a caller
   * distinguish "shutdown" from "this attempt just failed on its own" (see
   * `packages/llm`'s distinct `LlmAbortedError`/`LlmTimeoutError`). Default
   * (omitted): rethrow whatever `attempt()`'s own failure already was.
   *
   * Also gates a second checkpoint, right after a backoff sleep the signal
   * cut short: supplying this hook additionally skips the next attempt
   * entirely and throws it there instead — an optimization, not a
   * correctness requirement, so it only applies when a caller has opted in
   * by supplying this hook. A caller that omits it (no distinct
   * abort-vs-failure error type to build) keeps the pre-existing behavior
   * of spending one more real attempt, which then fails against the
   * already-aborted signal and is caught by the first checkpoint above —
   * `packages/channels`' `client.ts` relies on this: it has no distinct
   * "aborted" error type, so its mid-backoff-abort error is whatever that
   * one doomed attempt's own failure produces, exactly as before this
   * helper existed.
   */
  buildAbortedError?: () => Error;
}

function throwIfAborted(
  externalSignal: AbortSignal | undefined,
  lastError: unknown,
  buildAbortedError: (() => Error) | undefined,
): void {
  if (!externalSignal?.aborted) return;
  throw buildAbortedError ? buildAbortedError() : lastError;
}

/**
 * Runs one attempt with a composed abort signal: a fresh per-attempt
 * `AbortController`, aborted either by its own `timeoutMs` timer or by
 * `externalSignal` firing. `addEventListener` never fires for a signal
 * already aborted before the listener was attached, so that case is
 * handled explicitly. The listener is always removed in `finally` — on
 * success, on a thrown failure, or on abort — so nothing survives past a
 * settled attempt.
 */
async function runOneAttempt<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    return await attempt(controller.signal);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * `retryAfterMs` wins over computed backoff when present, capped at the
 * same ceiling either way. Not reused by calling
 * `nextDelay(attempt, retryAfterMs / 1000)` — that round-trips through
 * seconds and back, and while every value this codebase's callers pass
 * happens to survive that round trip intact, a helper this general
 * shouldn't depend on float division/multiplication inverting cleanly for
 * every future caller's value. Capped directly against `nextDelay`'s own
 * `MAX_DELAY_MS` instead, so there is exactly one ceiling constant.
 */
function resolveDelayMs(attemptCount: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, MAX_DELAY_MS);
  }
  return nextDelay(attemptCount);
}

/**
 * A low-level retrying-fetch primitive shared by every Hermes package that
 * calls out over HTTP with retry/backoff — `packages/llm` (2 classes) and
 * `packages/channels` (3 classes) as of this writing. Owns: per-request
 * timeout composed with an external shutdown signal (`runOneAttempt`),
 * named-retry-class bookkeeping and its bounded backoff (`nextDelay`), and
 * `retryAfterMs`-over-computed-backoff precedence. Deliberately does not
 * own: classification (what counts as retryable, and as which class, is
 * entirely `classify`'s job), error construction or redaction content
 * (every thrown error is the caller's own — from `attempt`, `classify`, or
 * the `buildExhaustedError`/`buildAbortedError` hooks; this function
 * throws nothing of its own and never inspects a message string), or the
 * retry-class count/names (arbitrary, caller-supplied).
 */
export async function withHttpRetry<T, TClassName extends string>(
  options: HttpRetryOptions<T, TClassName>,
): Promise<T> {
  const { attempt, timeoutMs, externalSignal, classes, classify, buildAbortedError } = options;
  const attemptsByClass: Partial<Record<TClassName, number>> = {};

  while (true) {
    try {
      return await runOneAttempt(attempt, timeoutMs, externalSignal);
    } catch (error) {
      throwIfAborted(externalSignal, error, buildAbortedError);

      const classification = classify(error);
      const config = classes[classification.class];
      const attemptCount = (attemptsByClass[classification.class] ?? 0) + 1;
      attemptsByClass[classification.class] = attemptCount;

      if (attemptCount > config.maxAttempts) {
        throw config.buildExhaustedError ? config.buildExhaustedError(error, attemptCount) : error;
      }

      await delay(resolveDelayMs(attemptCount, classification.retryAfterMs), externalSignal);
      // Only short-circuits when the caller opted in via `buildAbortedError`
      // (see its own doc comment) — otherwise falls through to spend one
      // more real attempt, preserving a caller-without-that-hook's
      // pre-existing behavior exactly.
      if (buildAbortedError) throwIfAborted(externalSignal, error, buildAbortedError);
    }
  }
}
