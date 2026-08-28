import type { Clock } from "@hermes/core";
import { describe, expect, it } from "vitest";
import { type PendingConnection, createPendingConnectionStore } from "../pending-connections";

function mutableClock(startIso: string): Clock & { advanceMs(ms: number): void } {
  let current = new Date(startIso);
  return {
    now: () => current,
    advanceMs(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

const ENTRY: PendingConnection = {
  channel: "telegram",
  channelUserId: "user-1",
  chatId: "chat-1",
  scopes: ["openid"],
  verifier: "verifier-value",
};

describe("createPendingConnectionStore", () => {
  it("resolves a fresh state once and only once", () => {
    const store = createPendingConnectionStore(mutableClock("2026-08-28T00:00:00.000Z"));
    const state = store.createPendingConnection(ENTRY);

    expect(store.consumePendingConnection(state)).toEqual(ENTRY);
    expect(store.consumePendingConnection(state)).toBeUndefined();
  });

  it("returns undefined for an unknown state", () => {
    const store = createPendingConnectionStore(mutableClock("2026-08-28T00:00:00.000Z"));

    expect(store.consumePendingConnection("never-issued")).toBeUndefined();
  });

  it("returns undefined once the 10-minute TTL has passed", () => {
    const clock = mutableClock("2026-08-28T00:00:00.000Z");
    const store = createPendingConnectionStore(clock);
    const state = store.createPendingConnection(ENTRY);

    clock.advanceMs(10 * 60_000 + 1);

    expect(store.consumePendingConnection(state)).toBeUndefined();
  });

  it("still resolves right at the edge of the TTL window", () => {
    const clock = mutableClock("2026-08-28T00:00:00.000Z");
    const store = createPendingConnectionStore(clock);
    const state = store.createPendingConnection(ENTRY);

    clock.advanceMs(10 * 60_000 - 1);

    expect(store.consumePendingConnection(state)).toEqual(ENTRY);
  });

  it("mints states that are not predictable from one another", () => {
    const store = createPendingConnectionStore(mutableClock("2026-08-28T00:00:00.000Z"));
    const states = new Set(Array.from({ length: 20 }, () => store.createPendingConnection(ENTRY)));

    expect(states.size).toBe(20);
    for (const state of states) {
      expect(state.length).toBeGreaterThanOrEqual(32);
    }
  });
});
