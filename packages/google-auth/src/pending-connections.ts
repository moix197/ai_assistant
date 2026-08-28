import { randomBytes } from "node:crypto";
import type { Clock } from "@hermes/core";

const PENDING_CONNECTION_TTL_MS = 10 * 60_000;

export interface PendingConnection {
  channel: string;
  channelUserId: string;
  chatId: string;
  scopes: string[];
  verifier: string;
}

interface StoredPendingConnection extends PendingConnection {
  exp: Date;
}

export interface PendingConnectionStore {
  createPendingConnection(entry: PendingConnection): string;
  consumePendingConnection(state: string): PendingConnection | undefined;
}

/**
 * In-memory `Map<state, PendingConnection>` — the same restart-drops-it
 * tradeoff the approval gate's own pending map accepts (settled decision 6;
 * see `apps/hermes/src/agent/telegram-approval-gate.ts`). `state` is minted
 * with `randomBytes(32)` (256 bits, base64url) — authorization is a `Map`
 * hash lookup on an unguessable key, not a byte-by-byte compare against live
 * states, so there is no timing side channel to defend separately (the
 * practical form of settled decision 10's "constant-time compare").
 *
 * `consumePendingConnection` deletes on read *before* checking expiry, so a
 * replayed state is indistinguishable from an unknown one — one branch, not
 * three, matching the approval gate's own "expired, ask again" collapse.
 */
export function createPendingConnectionStore(clock: Clock): PendingConnectionStore {
  const pending = new Map<string, StoredPendingConnection>();

  function createPendingConnection(entry: PendingConnection): string {
    const state = randomBytes(32).toString("base64url");
    const exp = new Date(clock.now().getTime() + PENDING_CONNECTION_TTL_MS);
    pending.set(state, { ...entry, exp });
    return state;
  }

  function consumePendingConnection(state: string): PendingConnection | undefined {
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry) return undefined;
    if (entry.exp.getTime() < clock.now().getTime()) return undefined;
    const { exp: _exp, ...rest } = entry;
    return rest;
  }

  return { createPendingConnection, consumePendingConnection };
}
