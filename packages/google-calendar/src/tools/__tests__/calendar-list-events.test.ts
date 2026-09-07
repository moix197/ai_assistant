import type { Clock } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import type { CalendarClient, CalendarEvent } from "../../calendar-client";
import { createCalendarListEventsTool } from "../calendar-list-events";
import type { CalendarToolContext } from "../tool-deps";

function fixedClock(now: Date): Clock {
  return { now: () => now };
}

let channelUserIdCounter = 0;
function ctxFor(channelUserId?: string): CalendarToolContext {
  channelUserIdCounter += 1;
  return {
    signal: new AbortController().signal,
    channel: "telegram",
    channelUserId: channelUserId ?? `user-${channelUserIdCounter}`,
    turnId: "turn-1",
  };
}

function fakeDeps(opts: {
  timeZone?: string;
  now?: Date;
  events?: CalendarEvent[];
}) {
  const getAccessToken = vi.fn().mockResolvedValue("token-abc");
  const getPrimaryCalendarTimeZone = vi.fn().mockResolvedValue(opts.timeZone ?? "America/New_York");
  const listEvents = vi.fn().mockResolvedValue(opts.events ?? []);
  const accessTokenPort: AccessTokenPort = { getAccessToken };
  const calendarClient = {
    getPrimaryCalendarTimeZone,
    listEvents,
    getEvent: vi.fn(),
    queryFreeBusy: vi.fn(),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(),
  } as unknown as CalendarClient;
  const clock = fixedClock(opts.now ?? new Date("2026-09-07T12:00:00.000Z"));
  return {
    accessTokenPort,
    calendarClient,
    clock,
    getAccessToken,
    getPrimaryCalendarTimeZone,
    listEvents,
  };
}

describe("createCalendarListEventsTool", () => {
  it("requiresApproval is false, no prepare — ungated read", () => {
    const tool = createCalendarListEventsTool(fakeDeps({}));
    expect(tool.requiresApproval).toBe(false);
    expect((tool as { prepare?: unknown }).prepare).toBeUndefined();
  });

  it("explicit startIso/endIso wins outright over intent fields", async () => {
    const deps = fakeDeps({});
    const tool = createCalendarListEventsTool(deps);

    const result = (await tool.handler(
      {
        relativeDay: "tomorrow",
        startIso: "2030-01-01T00:00:00.000Z",
        endIso: "2030-01-02T00:00:00.000Z",
        maxResults: 20,
      },
      ctxFor(),
    )) as { ok: true; range: { startUtc: string; endUtc: string } };

    expect(result.ok).toBe(true);
    expect(result.range).toEqual({
      startUtc: "2030-01-01T00:00:00.000Z",
      endUtc: "2030-01-02T00:00:00.000Z",
    });
    expect(deps.listEvents).toHaveBeenCalledWith(
      "token-abc",
      expect.objectContaining({
        timeMinIso: "2030-01-01T00:00:00.000Z",
        timeMaxIso: "2030-01-02T00:00:00.000Z",
        maxResults: 20,
      }),
      expect.anything(),
    );
  });

  it("defaults to today's window when no intent field or explicit ISO is given (fixed clock, America/New_York)", async () => {
    const deps = fakeDeps({ now: new Date("2026-09-07T12:00:00.000Z") });
    const tool = createCalendarListEventsTool(deps);

    const result = (await tool.handler({ maxResults: 20 }, ctxFor())) as {
      ok: true;
      range: { startUtc: string; endUtc: string };
    };

    expect(result.ok).toBe(true);
    // 2026-09-07 12:00 UTC is 2026-09-07 08:00 in America/New_York (EDT,
    // UTC-4) — "today" there spans the full local calendar day.
    expect(result.range).toEqual({
      startUtc: "2026-09-07T04:00:00.000Z",
      endUtc: "2026-09-08T04:00:00.000Z",
    });
  });

  it("resolves 'tomorrow' relative to the fixed clock", async () => {
    const deps = fakeDeps({ now: new Date("2026-09-07T12:00:00.000Z") });
    const tool = createCalendarListEventsTool(deps);

    const result = (await tool.handler({ relativeDay: "tomorrow" }, ctxFor())) as {
      ok: true;
      range: { startUtc: string; endUtc: string };
    };

    expect(result.range).toEqual({
      startUtc: "2026-09-08T04:00:00.000Z",
      endUtc: "2026-09-09T04:00:00.000Z",
    });
  });

  it("resolves a weekday intent field to that day's window", async () => {
    // 2026-09-07 is a Monday in America/New_York.
    const deps = fakeDeps({ now: new Date("2026-09-07T12:00:00.000Z") });
    const tool = createCalendarListEventsTool(deps);

    const result = (await tool.handler({ weekday: "thursday" }, ctxFor())) as {
      ok: true;
      range: { startUtc: string; endUtc: string };
    };

    expect(result.range).toEqual({
      startUtc: "2026-09-10T04:00:00.000Z",
      endUtc: "2026-09-11T04:00:00.000Z",
    });
  });

  it("resolves 'this_week' to the full ISO week window", async () => {
    const deps = fakeDeps({ now: new Date("2026-09-07T12:00:00.000Z") });
    const tool = createCalendarListEventsTool(deps);

    const result = (await tool.handler({ relativeDay: "this_week" }, ctxFor())) as {
      ok: true;
      range: { startUtc: string; endUtc: string };
    };

    expect(result.range).toEqual({
      startUtc: "2026-09-07T04:00:00.000Z",
      endUtc: "2026-09-14T04:00:00.000Z",
    });
  });

  describe("maxResults schema bounds", () => {
    it("defaults to 20 when omitted", () => {
      const tool = createCalendarListEventsTool(fakeDeps({}));
      const parsed = tool.schema.parse({});
      expect((parsed as { maxResults: number }).maxResults).toBe(20);
    });

    it("accepts the boundary values 1 and 50", () => {
      const tool = createCalendarListEventsTool(fakeDeps({}));
      expect(tool.schema.safeParse({ maxResults: 1 }).success).toBe(true);
      expect(tool.schema.safeParse({ maxResults: 50 }).success).toBe(true);
    });

    it("rejects 0 and 51", () => {
      const tool = createCalendarListEventsTool(fakeDeps({}));
      expect(tool.schema.safeParse({ maxResults: 0 }).success).toBe(false);
      expect(tool.schema.safeParse({ maxResults: 51 }).success).toBe(false);
    });
  });

  it("truncates a description over 500 chars with a trailing marker, leaves a shorter one untouched", async () => {
    const longDescription = "x".repeat(600);
    const deps = fakeDeps({
      events: [
        {
          id: "evt-long",
          summary: "Long one",
          description: longDescription,
          start: { dateTime: "2026-09-07T14:00:00Z" },
          end: { dateTime: "2026-09-07T15:00:00Z" },
        },
        {
          id: "evt-short",
          summary: "Short one",
          description: "short",
          start: { dateTime: "2026-09-07T16:00:00Z" },
          end: { dateTime: "2026-09-07T17:00:00Z" },
        },
      ],
    });
    const tool = createCalendarListEventsTool(deps);

    const result = (await tool.handler({}, ctxFor())) as {
      ok: true;
      events: Array<{ id: string; description?: string }>;
    };

    const long = result.events.find((event) => event.id === "evt-long");
    const short = result.events.find((event) => event.id === "evt-short");
    expect(long?.description?.length).toBe(500 + "… (truncado)".length);
    expect(long?.description?.endsWith("… (truncado)")).toBe(true);
    expect(short?.description).toBe("short");
  });

  it("result always includes id per event, and renders start/end via renderEventTime", async () => {
    const deps = fakeDeps({
      timeZone: "UTC",
      events: [
        {
          id: "evt-1",
          summary: "Meeting",
          start: { dateTime: "2026-09-07T14:00:00Z" },
          end: { dateTime: "2026-09-07T15:00:00Z" },
        },
      ],
    });
    const tool = createCalendarListEventsTool(deps);

    const result = (await tool.handler({}, ctxFor())) as {
      ok: true;
      events: Array<{ id: string; allDay: boolean; startUtc?: string; endUtc?: string }>;
    };

    expect(result.events[0]?.id).toBe("evt-1");
    expect(result.events[0]?.allDay).toBe(false);
    expect(result.events[0]?.startUtc).toBe("2026-09-07T14:00:00.000Z");
    expect(result.events[0]?.endUtc).toBe("2026-09-07T15:00:00.000Z");
  });

  it("an all-day event in a mocked API response renders without throwing and without a timezone-converted time", async () => {
    const deps = fakeDeps({
      timeZone: "America/New_York",
      events: [
        {
          id: "evt-allday",
          summary: "Holiday",
          start: { date: "2026-12-25" },
          end: { date: "2026-12-26" },
        },
      ],
    });
    const tool = createCalendarListEventsTool(deps);

    const result = (await tool.handler({}, ctxFor())) as {
      ok: true;
      events: Array<{ id: string; allDay: boolean; localLabel: string; startUtc?: string }>;
    };

    expect(result.events[0]).toEqual(
      expect.objectContaining({ id: "evt-allday", allDay: true, localLabel: "2026-12-25" }),
    );
    expect(result.events[0]?.startUtc).toBeUndefined();
  });

  it("an inverted window (explicit startIso/endIso) is refused before any client call", async () => {
    const deps = fakeDeps({});
    const tool = createCalendarListEventsTool(deps);

    const result = await tool.handler(
      { startIso: "2030-01-02T00:00:00.000Z", endIso: "2030-01-01T00:00:00.000Z" },
      ctxFor(),
    );

    expect(result).toEqual({ ok: false, reason: "inverted_window" });
    // The window rejects before the Calendar `list_events` API call itself —
    // resolving the user's timezone (a prerequisite, via resolveUserTimeZone)
    // already needs its own access token fetch, so that one call is expected.
    expect(deps.listEvents).not.toHaveBeenCalled();
  });

  it("an oversized window (explicit startIso/endIso beyond maxDays) is refused before any client call", async () => {
    const deps = fakeDeps({});
    const tool = createCalendarListEventsTool(deps);

    const result = await tool.handler(
      { startIso: "2030-01-01T00:00:00.000Z", endIso: "2030-12-01T00:00:00.000Z" },
      ctxFor(),
    );

    expect(result).toEqual({ ok: false, reason: "window_too_large" });
    expect(deps.listEvents).not.toHaveBeenCalled();
  });
});
