import type { Clock } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import type { CalendarClient, CalendarEvent, FreeBusyInterval } from "../../calendar-client";
import { createCalendarCheckAvailabilityTool } from "../calendar-check-availability";
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

function fakeDeps(opts: {
  timeZone?: string;
  now?: Date;
  busy?: FreeBusyInterval[];
  events?: CalendarEvent[];
}) {
  const getAccessToken = vi.fn().mockResolvedValue("token-abc");
  const getPrimaryCalendarTimeZone = vi.fn().mockResolvedValue(opts.timeZone ?? "UTC");
  const queryFreeBusy = vi.fn().mockResolvedValue(opts.busy ?? []);
  const listEvents = vi.fn().mockResolvedValue(opts.events ?? []);
  const accessTokenPort: AccessTokenPort = { getAccessToken };
  const calendarClient = {
    getPrimaryCalendarTimeZone,
    listEvents,
    getEvent: vi.fn(),
    queryFreeBusy,
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(),
  } as unknown as CalendarClient;
  const clock = fixedClock(opts.now ?? new Date("2026-09-07T12:00:00.000Z"));
  return { accessTokenPort, calendarClient, clock, getAccessToken, queryFreeBusy, listEvents };
}

describe("createCalendarCheckAvailabilityTool", () => {
  it("requiresApproval is false, no prepare — ungated read", () => {
    const tool = createCalendarCheckAvailabilityTool(fakeDeps({}));
    expect(tool.requiresApproval).toBe(false);
    expect((tool as { prepare?: unknown }).prepare).toBeUndefined();
  });

  it("available: true when freebusy reports no overlap — listEvents is never called", async () => {
    const deps = fakeDeps({ busy: [] });
    const tool = createCalendarCheckAvailabilityTool(deps);

    const result = (await tool.handler(
      { startIso: "2026-09-10T19:00:00.000Z", durationMinutes: 30 },
      ctxFor(),
    )) as { ok: true; available: boolean };

    expect(result.ok).toBe(true);
    expect(result.available).toBe(true);
    expect(deps.queryFreeBusy).toHaveBeenCalledWith(
      "token-abc",
      { timeMinIso: "2026-09-10T19:00:00.000Z", timeMaxIso: "2026-09-10T19:30:00.000Z" },
      expect.anything(),
    );
    expect(deps.listEvents).not.toHaveBeenCalled();
  });

  it("available: false with the conflicting event named when freebusy reports an overlap", async () => {
    const deps = fakeDeps({
      busy: [{ start: "2026-09-10T19:00:00.000Z", end: "2026-09-10T19:30:00.000Z" }],
      events: [
        {
          id: "evt-1",
          summary: "Team sync",
          start: { dateTime: "2026-09-10T19:00:00Z" },
          end: { dateTime: "2026-09-10T19:30:00Z" },
        },
      ],
    });
    const tool = createCalendarCheckAvailabilityTool(deps);

    const result = (await tool.handler(
      { startIso: "2026-09-10T19:00:00.000Z", durationMinutes: 30 },
      ctxFor(),
    )) as {
      ok: true;
      available: boolean;
      conflicts: Array<{ id: string; summary?: string; allDay: boolean }>;
    };

    expect(result.available).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual(
      expect.objectContaining({ id: "evt-1", summary: "Team sync", allDay: false }),
    );
  });

  it("an all-day event reported as a conflict renders without throwing", async () => {
    const deps = fakeDeps({
      timeZone: "America/New_York",
      busy: [{ start: "2026-12-25T00:00:00.000Z", end: "2026-12-26T00:00:00.000Z" }],
      events: [
        {
          id: "evt-holiday",
          summary: "Holiday",
          start: { date: "2026-12-25" },
          end: { date: "2026-12-26" },
        },
      ],
    });
    const tool = createCalendarCheckAvailabilityTool(deps);

    const result = (await tool.handler(
      { startIso: "2026-12-25T14:00:00.000Z", durationMinutes: 30 },
      ctxFor(),
    )) as {
      ok: true;
      available: boolean;
      conflicts: Array<{ id: string; allDay: boolean; localLabel: string }>;
    };

    expect(result.available).toBe(false);
    expect(result.conflicts[0]).toEqual(
      expect.objectContaining({ id: "evt-holiday", allDay: true, localLabel: "2026-12-25" }),
    );
  });

  it("resolves relativeDay/weekday/timeOfDay to a single instant, then start + durationMinutes", async () => {
    // 2026-09-07 is a Monday in UTC-equivalent zone "UTC".
    const deps = fakeDeps({ now: new Date("2026-09-07T12:00:00.000Z"), busy: [] });
    const tool = createCalendarCheckAvailabilityTool(deps);

    const result = (await tool.handler(
      { weekday: "thursday", timeOfDay: "afternoon", durationMinutes: 45 },
      ctxFor(),
    )) as { ok: true; range: { startUtc: string; endUtc: string } };

    // resolveRelativeInstant("afternoon") = 14:00 local on the target Thursday.
    expect(result.range).toEqual({
      startUtc: "2026-09-10T14:00:00.000Z",
      endUtc: "2026-09-10T14:45:00.000Z",
    });
  });

  it("durationMinutes defaults to 30, clamps to 5-480", () => {
    const tool = createCalendarCheckAvailabilityTool(fakeDeps({}));
    expect((tool.schema.parse({}) as { durationMinutes: number }).durationMinutes).toBe(30);
    expect(tool.schema.safeParse({ durationMinutes: 5 }).success).toBe(true);
    expect(tool.schema.safeParse({ durationMinutes: 480 }).success).toBe(true);
    expect(tool.schema.safeParse({ durationMinutes: 4 }).success).toBe(false);
    expect(tool.schema.safeParse({ durationMinutes: 481 }).success).toBe(false);
  });

  it("an inverted resolved window (explicit startIso/endIso) is refused before queryFreeBusy is called", async () => {
    const deps = fakeDeps({});
    const tool = createCalendarCheckAvailabilityTool(deps);

    const result = await tool.handler(
      { startIso: "2030-01-02T00:00:00.000Z", endIso: "2030-01-01T00:00:00.000Z" },
      ctxFor(),
    );

    expect(result).toEqual({ ok: false, reason: "inverted_window" });
    expect(deps.queryFreeBusy).not.toHaveBeenCalled();
  });

  it("an oversized resolved window (explicit startIso/endIso beyond maxDays) is refused before queryFreeBusy is called", async () => {
    const deps = fakeDeps({});
    const tool = createCalendarCheckAvailabilityTool(deps);

    const result = await tool.handler(
      { startIso: "2030-01-01T00:00:00.000Z", endIso: "2030-12-01T00:00:00.000Z" },
      ctxFor(),
    );

    expect(result).toEqual({ ok: false, reason: "window_too_large" });
    expect(deps.queryFreeBusy).not.toHaveBeenCalled();
  });
});
