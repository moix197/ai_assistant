/**
 * Typed error subclasses — no `Result<T,E>` in this package (project
 * convention: `llm` throws). `LlmTimeoutError` is the adapter's own
 * per-request timeout firing (an internally-owned `AbortController`), kept
 * deliberately distinct from the externally-supplied-`AbortSignal` case
 * Phase 5 adds (`LlmAbortedError`): a caller must be able to tell "the
 * adapter itself gave up waiting" from "the process was asked to shut down
 * mid-call".
 */

export class LlmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmTimeoutError";
  }
}

/**
 * Thrown when the externally-supplied shutdown `signal` (Phase 5's
 * boot-lifetime `AbortController`, not the adapter's own per-request
 * timeout controller) fires mid-call. Kept a distinct class from
 * `LlmTimeoutError` so a caller — and log-based diagnosis — can tell
 * "the process was asked to shut down mid-call" from "the adapter itself
 * gave up waiting on the provider".
 */
export class LlmAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmAbortedError";
  }
}

/**
 * Carries the HTTP status of a non-ok response from the provider, plus the
 * server's `Retry-After` header (seconds) when a 429 response sends one —
 * an authoritative signal that wins over computed backoff, mirroring
 * `channels/src/telegram/client.ts`'s `TelegramApiError.retryAfter`.
 */
export class LlmHttpError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "LlmHttpError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * An HTTP-200 body that is non-JSON, or valid JSON carrying neither text nor a
 * tool call, or missing a well-formed `usage` block, is treated identically:
 * malformed, not a silent partial success. Text alone is not required — an
 * OpenAI-compatible provider answers a tool call with `content: null`, and the
 * tool call *is* the message. In particular, a missing `usage` block never
 * defaults to zero — that would let a later phase silently record zero cost
 * for a real, billed call.
 */
export class LlmMalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmMalformedResponseError";
  }
}

/**
 * Thrown by `assertBudgetNotExceeded` (see `budget/check-budget.ts`) when
 * cumulative spend for the current calendar month (UTC) meets or exceeds the
 * configured cap. Carries both numbers so boot logs are useful, but the
 * **user-facing** Telegram reply must never surface `message` directly — it
 * would leak internal cost figures to chat. `apps/hermes/src/handlers/
 * complete.ts` catches this specifically and replies with a fixed, friendly
 * string instead; `/stats` (02-telemetry) is where spend surfaces to users.
 */
export class BudgetExceededError extends Error {
  readonly capUsd: number;
  readonly spentUsd: number;

  constructor(capUsd: number, spentUsd: number) {
    super(
      `monthly LLM budget exceeded: spent $${spentUsd.toFixed(6)} of a $${capUsd.toFixed(2)} cap`,
    );
    this.name = "BudgetExceededError";
    this.capUsd = capUsd;
    this.spentUsd = spentUsd;
  }
}
