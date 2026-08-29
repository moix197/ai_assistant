import type { Logger } from "@hermes/core";
import { withHttpRetry } from "@hermes/core";

const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
/** Per-attempt timeout — this call blocks `/disconnect`'s reply, so it stays well under a chat-latency budget even after a retry. */
const REQUEST_TIMEOUT_MS = 5_000;
/** One retry for a network failure before any response came back — Google never saw the request, so retrying is safe. A non-2xx *response* is never retried (see `classify`). */
const MAX_TRANSIENT_RETRIES = 1;

/** Thrown internally by `attemptRevoke` for a non-2xx response. Never escapes `revokeToken` — see its doc comment. */
class RevokeApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Google revoke endpoint returned HTTP ${status}`);
    this.name = "RevokeApiError";
    this.status = status;
  }
}

/** Strips `secret` out of `value` wherever it appears — the same belt-and-braces the token never appears in a thrown error's message, even if some `fetch` implementation ever echoed the request URL back into a failure message. */
function redact(value: string, secret: string): string {
  return value.split(secret).join("<REDACTED>");
}

type RevokeRetryClass = "transient";

/**
 * A failure before any response came back (network error, our own timeout)
 * is `"transient"` and retried once. A `RevokeApiError` (a response *did*
 * come back, just not 2xx) is thrown directly, never retried — Google
 * already applied the request, so resending changes nothing; a 400
 * typically just means the token was already revoked or invalid, which is
 * the outcome the caller wanted anyway.
 */
function classify(error: unknown): { class: RevokeRetryClass } {
  if (error instanceof RevokeApiError) throw error;
  return { class: "transient" };
}

async function attemptRevoke(
  fetchImpl: typeof fetch,
  refreshToken: string,
  signal: AbortSignal,
): Promise<void> {
  const url = `${REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`Google revoke request failed: ${message}`, refreshToken));
  }
  if (!response.ok) throw new RevokeApiError(response.status);
}

export interface RevokeTokenOptions {
  logger: Logger;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Revokes `refreshToken` at Google's OAuth2 revoke endpoint (`POST
 * https://oauth2.googleapis.com/revoke?token=<refreshToken>`), built on
 * `@hermes/core`'s shared `withHttpRetry` — the same retrying-fetch
 * primitive `packages/google-sheets`' client and `packages/llm`'s adapter
 * use, not a bare `fetch`.
 *
 * **Never throws.** `apps/hermes/src/handlers/disconnect.ts`'s contract is
 * "attempt revoke, then delete the local row regardless" — any failure
 * (network, timeout, or a non-2xx response) is logged at `warn` and
 * swallowed here, so a revoke failure never blocks or changes the local
 * disconnect. `refreshToken` itself never appears in a log line or a thrown
 * error's message anywhere in this function — only Google's HTTP status
 * (via `RevokeApiError`) or a redacted network-failure message ever does.
 */
export async function revokeToken(refreshToken: string, opts: RevokeTokenOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    await withHttpRetry<void, RevokeRetryClass>({
      attempt: (signal) => attemptRevoke(fetchImpl, refreshToken, signal),
      timeoutMs: REQUEST_TIMEOUT_MS,
      classes: { transient: { maxAttempts: MAX_TRANSIENT_RETRIES } },
      classify,
    });
  } catch (error) {
    opts.logger.warn("failed to revoke Google OAuth grant; local account will still be deleted", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
