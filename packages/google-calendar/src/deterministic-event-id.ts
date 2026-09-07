import { sha256HexOfCanonicalJson } from "@hermes/core";

/**
 * `create_event`'s idempotency id (settled decision 6, corrected — see
 * `.ai/decisions/calendar-event-idempotency.md`). Delegates canonicalization
 * and hashing entirely to `@hermes/core`'s `sha256HexOfCanonicalJson` — no
 * bespoke encoding logic here. A SHA-256 hex digest (`0`-`9`, `a`-`f`) is
 * already a valid base32hex string (`0`-`9`, `a`-`v`) and well within
 * Calendar's `id` field's 5-1024 length bound, so nothing further is done to
 * the output. Same `(turnId, canonicalArgs)` within the same turn yields the
 * same id; a different turn or different args yields a different one.
 */
export function deriveEventId(turnId: string, canonicalArgs: unknown): string {
  return sha256HexOfCanonicalJson({ turnId, args: canonicalArgs });
}
