import { createHash } from "node:crypto";

/**
 * Recursively sorts object keys — arrays keep their given order (order is
 * meaningful there), only object keys are reordered — so two logically
 * identical values that differ only in key insertion order stringify
 * byte-identically. A package-local duplicate of
 * `@hermes/google-sheets`'s `canonical-args.ts`, for the same third-caller
 * reason `truncate.ts` documents (`09-gmail-read-then-send` Phase 6) — not
 * promoted to `@hermes/core` until a third consumer needs it.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Deterministic JSON stringification of a call's args — key order never
 * affects the output. Used both as the hash input for `gmail_send_draft`'s
 * dedupe key (`computeDedupeKey` below) and, `JSON.parse`d back, as the
 * `canonical_args` audit value `gmail_send_log` stores: the dedupe key's
 * whole point breaks if two logically-identical calls hash differently just
 * because the model happened to emit its JSON args in a different key order.
 */
export function canonicalizeArgs(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export interface DedupeKeyParts {
  channel: string;
  channelUserId: string;
  turnId: string;
  tool: string;
  /** Already-canonicalized args (`canonicalizeArgs`'s output) — computed once by the caller and reused for both hashing and the `canonical_args` audit value. */
  canonicalArgsJson: string;
}

/**
 * `sha256` over `(channel, channelUserId, turnId, tool, canonical args
 * JSON)`, mirroring `@hermes/google-sheets`'s `computeDedupeKey` (and, before
 * it, `llm-dedupe-repo`'s claim/complete shape) exactly. `turnId` is included
 * on purpose — it's a same-turn retry guard against the *model* calling
 * `gmail_send_draft` twice with identical args in one turn, never a
 * permanent "this exact draft can only ever be sent once" block: a same-turn
 * repeat hashes identically and is caught by `gmail_send_log`'s primary key,
 * while a later, genuinely repeated request (a different `turnId`) hashes
 * differently and goes through `prepare` and a brand-new approval prompt
 * exactly like the first send did.
 */
export function computeDedupeKey(parts: DedupeKeyParts): string {
  const input = JSON.stringify([
    parts.channel,
    parts.channelUserId,
    parts.turnId,
    parts.tool,
    parts.canonicalArgsJson,
  ]);
  return createHash("sha256").update(input).digest("hex");
}
