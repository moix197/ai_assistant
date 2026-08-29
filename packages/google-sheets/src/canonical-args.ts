import { createHash } from "node:crypto";

/**
 * Recursively sorts object keys — arrays keep their given order (order is
 * meaningful there), only object keys are reordered — so two logically
 * identical values that differ only in key insertion order stringify
 * byte-identically.
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
 * Deterministic JSON stringification of a write call's args — key order
 * never affects the output. Used both as the hash input for `sheets_write`'s
 * dedupe key (`computeDedupeKey` below) and, `JSON.parse`d back, as the
 * `canonical_args` audit value `sheet_write_log` stores (settled decision
 * 12): the dedupe key's whole point breaks if two logically-identical calls
 * hash differently just because the model happened to emit its JSON args in
 * a different key order.
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
 * JSON)`, mirroring `llm-dedupe-repo`'s claim/complete shape. `turnId` is
 * included on purpose (settled decision 12) — it's a retry guard against the
 * *model* calling `sheets_write` twice with identical args in one turn, not
 * a permanent "this exact write can only ever happen once" block: a same-turn
 * repeat hashes identically and is caught by `sheet_write_log`'s primary key,
 * while a later, genuinely repeated request (a different `turnId`) hashes
 * differently and is allowed through.
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
