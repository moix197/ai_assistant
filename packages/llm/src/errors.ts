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

/** Carries the HTTP status of a non-ok response from the provider. */
export class LlmHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "LlmHttpError";
    this.status = status;
  }
}

/**
 * An HTTP-200 body that is non-JSON, or valid JSON missing a required field
 * (`text` or `usage`), is treated identically: malformed, not a silent
 * partial success. In particular, a missing `usage` block never defaults to
 * zero — that would let a later phase silently record zero cost for a real,
 * billed call.
 */
export class LlmMalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmMalformedResponseError";
  }
}
