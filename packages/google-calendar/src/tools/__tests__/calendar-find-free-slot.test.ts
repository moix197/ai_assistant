import type { Clock } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import type { CalendarClient, FreeBusyInterval } from "../../calendar-client";
import { createCalendarFindFreeSlotTool } from "../calendar-find-free-slot";
import type { CalendarToolContext } from "../tool-deps";

function fixedClock(now: Date): Clock {
  return { now: () => now };
}

let channelUserIdCounter = 0;
function ctxFor(): CalendarToolContext {
  channelUserIdCounter += 1;
  return {
    signal: new AbortController().signal,
    channel: "telegram",
    channelUserId: `user-${channelUserIdCounter}`,
    turnId: "turn-1",
  };
}

function fakeDeps(opts: { timeZone?: string; now?: Date; busy?: FreeBusyInterval[] }) {
  const getAccessToken = vi.fn().mockResolvedValue("token-abc");
  const getPrimaryCalendarTimeZone = vi.fn().mockResolvedValue(opts.timeZone ?? "UTC");
  const queryFreeBusy = vi.fn().mockResolvedValue(opts.busy ?? []);
  const accessTokenPort: AccessTokenPort = { getAccessToken };
  const calendarClient = {
    getPrimaryCalendarTimeZone,
    listEvents: vi.fn(),
    getEvent: vi.fn(),
    queryFreeBusy,
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(),
  } as unknown as CalendarClient;
  const clock = fixedClock(opts.now ?? new Date("2026-09-07T12:00:00.000Z"));
  return { accessTokenPort, calendarClient, clock, getAccessToken, queryFreeBusy };
}

describe("createCalendarFindFreeSlotTool", () => {
  it("requiresApproval is false, no prepare — ungated read", () => {
    const tool = createCalendarFindFreeSlotTool(fakeDeps({}));
    expect(tool.requiresApproval).toBe(false);
    expect((tool as { prepare?: unknown }).prepare).toBeUndefined();
  });

  it("durationMinutes defaults to 30, clamps to 5-480", () => {
    const tool = createCalendarFindFreeSlotTool(fakeDeps({}));
    expect((tool.schema.parse({}) as { durationMinutes: number }).durationMinutes).toBe(30);
    expect(tool.schema.safeParse({ durationMinutes: 5 }).success).toBe(true);
    expect(tool.schema.safeParse({ durationMinutes: 480 }).success).toBe(true);
    expect(tool.schema.safeParse({ durationMinutes: 4 }).success).toBe(false);
    expect(tool.schema.safeParse({ durationMinutes: 481 }).success).toBe(false);
  });

  it("finds gaps between busy blocks that are >= durationMinutes, one candidate per qualifying gap", async () => {
    // Window: 2026-09-07T09:00:00Z - 2026-09-07T17:00:00Z (explicit).
    // Busy: 10:00-10:30 and 12:00-15:00.
    // Gaps: [09:00-10:00) = 60min, [10:30-12:00) = 90min, [15:00-17:00) = 120min.
    // durationMinutes = 30 -> all three gaps qualify.
    const deps = fakeDeps({
      busy: [
        { start: "2026-09-07T10:00:00.000Z", end: "2026-09-07T10:30:00.000Z" },
        { start: "2026-09-07T12:00:00.000Z", end: "2026-09-07T15:00:00.000Z" },
      ],
    });
    const tool = createCalendarFindFreeSlotTool(deps);

    const result = (await tool.handler(
      {
        startIso: "2026-09-07T09:00:00.000Z",
        endIso: "2026-09-07T17:00:00.000Z",
        durationMinutes: 30,
      },
      ctxFor(),
    )) as { ok: true; candidates: Array<{ startUtc: string; endUtc: string }> };

    expect(result.ok).toBe(true);
    expect(
      result.candidates.map(({ startUtc, endUtc }) => ({ startUtc, endUtc })),
    ).toEqual([
      { startUtc: "2026-09-07T09:00:00.000Z", endUtc: "2026-09-07T09:30:00.000Z" },
      { startUtc: "2026-09-07T10:30:00.000Z", endUtc: "2026-09-07T11:00:00.000Z" },
      { startUtc: "2026-09-07T15:00:00.000Z", endUtc: "2026-09-07T15:30:00.000Z" },
    ]);
  });

  it("a window with no gap >= durationMinutes returns an empty candidate list, not an error", async () => {
    const deps = fakeDeps({
      busy: [{ start: "2026-09-07T09:00:00.000Z", end: "2026-09-07T17:00:00.000Z" }],
    });
    const tool = createCalendarFindFreeSlotTool(deps);

    const result = (await tool.handler(
      {
        startIso: "2026-09-07T09:00:00.000Z",
        endIso: "2026-09-07T17:00:00.000Z",
        durationMinutes: 30,
      },
      ctxFor(),
    )) as { ok: true; candidates: unknown[] };

    expect(result.ok).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  it("an empty busy list yields one candidate at the window's start", async () => {
    const deps = fakeDeps({ busy: [] });
    const tool = createCalendarFindFreeSlotTool(deps);

    const result = (await tool.handler(
      {
        startIso: "2026-09-07T09:00:00.000Z",
        endIso: "2026-09-07T17:00:00.000Z",
        durationMinutes: 30,
      },
      ctxFor(),
    )) as { ok: true; candidates: Array<{ startUtc: string; endUtc: string }> };

    expect(
      result.candidates.map(({ startUtc, endUtc }) => ({ startUtc, endUtc })),
    ).toEqual([{ startUtc: "2026-09-07T09:00:00.000Z", endUtc: "2026-09-07T09:30:00.000Z" }]);
  });

  it("an inverted resolved window (explicit startIso/endIso) is refused before queryFreeBusy is called", async () => {
    const deps = fakeDeps({});
    const tool = createCalendarFindFreeSlotTool(deps);

    const result = await tool.handler(
      { startIso: "2030-01-02T00:00:00.000Z", endIso: "2030-01-01T00:00:00.000Z" },
      ctxFor(),
    );

    expect(result).toEqual({ ok: false, reason: "inverted_window" });
    expect(deps.queryFreeBusy).not.toHaveBeenCalled();
  });

  it("an oversized resolved window (explicit startIso/endIso beyond maxDays) is refused before queryFreeBusy is called", async () => {
    const deps = fakeDeps({});
    const tool = createCalendarFindFreeSlotTool(deps);

    const result = await tool.handler(
      { startIso: "2030-01-01T00:00:00.000Z", endIso: "2030-12-01T00:00:00.000Z" },
      ctxFor(),
    );

    expect(result).toEqual({ ok: false, reason: "window_too_large" });
    expect(deps.queryFreeBusy).not.toHaveBeenCalled();
  });
});
