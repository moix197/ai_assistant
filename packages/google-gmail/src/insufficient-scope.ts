import { GmailApiError } from "./gmail-client";

/**
 * The same field shape `apps/hermes/src/agent/with-required-scopes.ts`'s
 * `withRequiredScopes` returns for its pre-call `missing_scope` gate, so the
 * model has one refusal vocabulary regardless of which check caught it.
 */
export interface InsufficientScopeResult {
  ok: false;
  reason: "insufficient_scope";
  scope: string;
  fix: string;
}

/**
 * Maps a caught `GmailApiError` with status 401 or 403 to the structured
 * `insufficient_scope` refusal — `scope`/`fix` are supplied by the caller
 * rather than looked up here, since this package never imports
 * `@hermes/google-auth` (the consumer-declares-its-port convention this
 * package's `AccessTokenPort` also follows). Returns `undefined` for any
 * other error so the caller rethrows it as a genuine fatal error. Shared by
 * every Gmail tool from here on — the gate `withRequiredScopes` runs before
 * a call is even attempted normally makes a 401/403 unreachable, but a scope
 * revoked at Google *after* that pre-check still needs a structured refusal,
 * not a throw.
 */
export function toInsufficientScopeResult(
  error: unknown,
  scope: string,
  fix: string,
): InsufficientScopeResult | undefined {
  if (error instanceof GmailApiError && (error.status === 401 || error.status === 403)) {
    return { ok: false, reason: "insufficient_scope", scope, fix };
  }
  return undefined;
}
