import type { Clock } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../access-token-port";
import type { CalendarClient } from "../calendar-client";
import { TIMEZONE_CACHE_TTL_MS, resolveUserTimeZone } from "../timezone-cache";

function fixedClock(now: Date): Clock {
  return { now: () => now };
}

function fakeDeps(timeZone: string, now: Date) {
  const getAccessToken = vi.fn().mockResolvedValue("token-abc");
  const getPrimaryCalendarTimeZone = vi.fn().mockResolvedValue(timeZone);
  const accessTokenPort: AccessTokenPort = { getAccessToken };
  const calendarClient = {
    getPrimaryCalendarTimeZone,
  } as unknown as CalendarClient;
  return {
    accessTokenPort,
    calendarClient,
    clock: fixedClock(now),
    getAccessToken,
    getPrimaryCalendarTimeZone,
  };
}

describe("resolveUserTimeZone", () => {
  const NOW = new Date("2026-09-07T12:00:00.000Z");

  it("misses on the first call: fetches an access token and the primary calendar timezone, then caches", async () => {
    const deps = fakeDeps("America/New_York", NOW);

    const result = await resolveUserTimeZone(deps, "telegram", "cache-test-miss", undefined);

    expect(result).toBe("America/New_York");
    expect(deps.getAccessToken).toHaveBeenCalledTimes(1);
    expect(deps.getPrimaryCalendarTimeZone).toHaveBeenCalledTimes(1);
  });

  it("hits the cache on a second call within the TTL: no client call at all", async () => {
    const deps = fakeDeps("Europe/Madrid", NOW);

    await resolveUserTimeZone(deps, "telegram", "cache-test-hit", undefined);
    const second = await resolveUserTimeZone(deps, "telegram", "cache-test-hit", undefined);

    expect(second).toBe("Europe/Madrid");
    expect(deps.getAccessToken).toHaveBeenCalledTimes(1);
    expect(deps.getPrimaryCalendarTimeZone).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the TTL expires", async () => {
    const getAccessToken = vi.fn().mockResolvedValue("token-abc");
    const getPrimaryCalendarTimeZone = vi
      .fn()
      .mockResolvedValueOnce("Europe/Madrid")
      .mockResolvedValueOnce("America/Chicago");
    const accessTokenPort: AccessTokenPort = { getAccessToken };
    const calendarClient = { getPrimaryCalendarTimeZone } as unknown as CalendarClient;

    const first = await resolveUserTimeZone(
      { accessTokenPort, calendarClient, clock: fixedClock(NOW) },
      "telegram",
      "cache-test-ttl",
      undefined,
    );
    expect(first).toBe("Europe/Madrid");

    const afterExpiry = new Date(NOW.getTime() + TIMEZONE_CACHE_TTL_MS + 1);
    const second = await resolveUserTimeZone(
      { accessTokenPort, calendarClient, clock: fixedClock(afterExpiry) },
      "telegram",
      "cache-test-ttl",
      undefined,
    );

    expect(second).toBe("America/Chicago");
    expect(getPrimaryCalendarTimeZone).toHaveBeenCalledTimes(2);
  });
});
