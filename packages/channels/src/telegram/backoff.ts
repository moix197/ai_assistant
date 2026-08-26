const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
/** Uniform jitter of +/-20% around the computed exponential delay, to avoid synchronized retries. */
const JITTER_RATIO = 0.2;

/**
 * Computes the delay before the next retry attempt (1-based `attempt`).
 * `retryAfterHeader` (seconds, from Telegram's 429 response) always wins
 * when present — it's an authoritative signal from the server, not an
 * estimate. Otherwise, exponential backoff capped at `MAX_DELAY_MS` with
 * jitter. No clock dependency: callers pass the attempt count directly.
 */
export function nextDelay(attempt: number, retryAfterHeader?: number): number {
  if (retryAfterHeader !== undefined) {
    return retryAfterHeader * 1000;
  }

  const exponential = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  const jitter = exponential * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.min(MAX_DELAY_MS, Math.round(exponential + jitter)));
}
