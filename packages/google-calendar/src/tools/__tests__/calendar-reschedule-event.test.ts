import type { Clock } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import { CalendarApiError } from "../../calendar-client";
import type { CalendarClient, CalendarEvent } from "../../calendar-client";
import {
  type RescheduleEventPlan,
  createCalendarRescheduleEventTool,
} from "../calendar-reschedule-event";
import type { CalendarToolContext } from "../tool-deps";

function fixedClock(now: Date): Clock {
  return { now: () => now };
}

let channelUserIdCounter = 0;
function ctxFor(overrides?: Partial<CalendarToolContext>): CalendarToolContext {
  channelUserIdCounter += 1;
  return {
    signal: new AbortController().signal,
    channel: "telegram",
    channelUserId: `user-${channelUserIdCounter}`,
    turnId: "turn-1",
    ...overrides,
  };
}

const EXISTING_EVENT: CalendarEvent = {
  id: "evt-1",
  summary: "Standup",
  start: { dateTime: "2026-09-07T19:00:00Z" },
  end: { dateTime: "2026-09-07T19:30:00Z" },
};

function fakeDeps(opts: {
  timeZone?: string;
  now?: Date;
  existingEvent?: CalendarEvent | null;
  patchedEvent?: CalendarEvent;
}) {
  const getAccessToken = vi.fn().mockResolvedValue("token-abc");
  const getPrimaryCalendarTimeZone = vi.fn().mockResolvedValue(opts.timeZone ?? "America/New_York");
  const getEvent =
    opts.existingEvent === null
      ? vi.fn().mockRejectedValue(new CalendarApiError("not found", 404))
      : vi.fn().mockResolvedValue(opts.existingEvent ?? EXISTING_EVENT);
  const patchEvent = vi.fn().mockResolvedValue(
    opts.patchedEvent ?? {
      id: "evt-1",
      summary: "Standup",
      start: { dateTime: "2026-09-10T14:00:00Z" },
      end: { dateTime: "2026-09-10T14:30:00Z" },
    },
  );
  const accessTokenPort: AccessTokenPort = { getAccessToken };
  const calendarClient = {
    getPrimaryCalendarTimeZone,
    listEvents: vi.fn(),
    getEvent,
    queryFreeBusy: vi.fn(),
    insertEvent: vi.fn(),
    patchEvent,
    deleteEvent: vi.fn(),
  } as unknown as CalendarClient;
  const clock = fixedClock(opts.now ?? new Date("2026-09-07T12:00:00.000Z"));
  return { accessTokenPort, calendarClient, clock, getAccessToken, getEvent, patchEvent };
}

describe("createCalendarRescheduleEventTool", () => {
  it("requiresApproval is true and declares a prepare hook", () => {
    const tool = createCalendarRescheduleEventTool(fakeDeps({}));
    expect(tool.requiresApproval).toBe(true);
    expect(typeof tool.prepare).toBe("function");
  });

  it("prepare pre-reads the event and shows the real old->new range in the ApprovalSummary.target, using the legible Spanish formatter", async () => {
    const deps = fakeDeps({ timeZone: "UTC" });
    const tool = createCalendarRescheduleEventTool(deps);

    const result = (await tool.prepare?.(
      { eventId: "evt-1", startIso: "2026-09-10T14:00:00.000Z" },
      ctxFor(),
    )) as { ok: true; plan: RescheduleEventPlan; summary: { action: string; target?: string } };

    expect(deps.getEvent).toHaveBeenCalledWith("token-abc", "evt-1", expect.anything());
    expect(result.ok).toBe(true);
    expect(result.summary.action).toBe('Mover "Standup"');
    // Old range: 2026-09-07 19:00-19:30 UTC. New range: 2026-09-10 14:00-14:30 UTC
    // (duration preserved from the 30-minute pre-read event).
    expect(result.summary.target).toBe(
      "lunes 7 de septiembre, 19:00 – 19:30 → jueves 10 de septiembre, 14:00 – 14:30",
    );
    expect(result.summary.target).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // never raw ISO
    expect(result.plan.newStartUtc).toBe("2026-09-10T14:00:00.000Z");
    expect(result.plan.newEndUtc).toBe("2026-09-10T14:30:00.000Z");
  });

  it("preserves the event's current duration when durationMinutes/endIso are both omitted", async () => {
    const deps = fakeDeps({ timeZone: "UTC" });
    const tool = createCalendarRescheduleEventTool(deps);

    const result = (await tool.prepare?.(
      { eventId: "evt-1", startIso: "2026-09-10T14:00:00.000Z" },
      ctxFor(),
    )) as { ok: true; plan: RescheduleEventPlan };

    // Pre-read event is 19:00-19:30 (30 min) -> new end is new start + 30 min.
    expect(result.plan.newEndUtc).toBe("2026-09-10T14:30:00.000Z");
  });

  it("an explicit durationMinutes overrides the preserved duration", async () => {
    const deps = fakeDeps({ timeZone: "UTC" });
    const tool = createCalendarRescheduleEventTool(deps);

    const result = (await tool.prepare?.(
      { eventId: "evt-1", startIso: "2026-09-10T14:00:00.000Z", durationMinutes: 90 },
      ctxFor(),
    )) as { ok: true; plan: RescheduleEventPlan };

    expect(result.plan.newEndUtc).toBe("2026-09-10T15:30:00.000Z");
  });

  it("an explicit endIso overrides both durationMinutes and the preserved duration", async () => {
    const deps = fakeDeps({ timeZone: "UTC" });
    const tool = createCalendarRescheduleEventTool(deps);

    const result = (await tool.prepare?.(
      {
        eventId: "evt-1",
        startIso: "2026-09-10T14:00:00.000Z",
        durationMinutes: 90,
        endIso: "2026-09-10T14:15:00.000Z",
      },
      ctxFor(),
    )) as { ok: true; plan: RescheduleEventPlan };

    expect(result.plan.newEndUtc).toBe("2026-09-10T14:15:00.000Z");
  });

  it("resolves a relative intent for the new start time via resolveRelativeInstant", async () => {
    const deps = fakeDeps({ timeZone: "America/New_York", now: new Date("2026-09-07T12:00:00.000Z") });
    const tool = createCalendarRescheduleEventTool(deps);

    const result = (await tool.prepare?.(
      { eventId: "evt-1", weekday: "thursday", timeOfDay: "morning" },
      ctxFor(),
    )) as { ok: true; plan: RescheduleEventPlan };

    // Thursday 2026-09-10 09:00 America/New_York (EDT, UTC-4) is 13:00 UTC.
    expect(result.plan.newStartUtc).toBe("2026-09-10T13:00:00.000Z");
  });

  it("event_not_found refusal on a mocked 404 — no approval prompt data returned, no timezone/window resolution attempted", async () => {
    const deps = fakeDeps({ existingEvent: null });
    const tool = createCalendarRescheduleEventTool(deps);

    const result = await tool.prepare?.(
      { eventId: "missing-evt", startIso: "2026-09-10T14:00:00.000Z" },
      ctxFor(),
    );

    expect(result).toEqual({ ok: false, result: { ok: false, reason: "event_not_found" } });
  });

  it("a resolved new window that is inverted is refused before being built into a plan", async () => {
    const deps = fakeDeps({ timeZone: "UTC" });
    const tool = createCalendarRescheduleEventTool(deps);

    const result = await tool.prepare?.(
      {
        eventId: "evt-1",
        startIso: "2026-09-10T14:00:00.000Z",
        endIso: "2026-09-10T14:00:00.000Z",
      },
      ctxFor(),
    );

    expect(result).toEqual({ ok: false, result: { ok: false, reason: "inverted_window" } });
  });

  it("a resolved new window that is oversized is refused before being built into a plan", async () => {
    const deps = fakeDeps({ timeZone: "UTC" });
    const tool = createCalendarRescheduleEventTool(deps);

    const result = await tool.prepare?.(
      {
        eventId: "evt-1",
        startIso: "2026-09-10T14:00:00.000Z",
        endIso: "2026-12-10T14:00:00.000Z",
      },
      ctxFor(),
    );

    expect(result).toEqual({ ok: false, result: { ok: false, reason: "window_too_large" } });
  });

  it("handler calls patchEvent with exactly the planned start/end and returns the updated event", async () => {
    const patchedEvent: CalendarEvent = {
      id: "evt-1",
      summary: "Standup",
      start: { dateTime: "2026-09-10T14:00:00Z" },
      end: { dateTime: "2026-09-10T14:30:00Z" },
    };
    const deps = fakeDeps({ patchedEvent });
    const tool = createCalendarRescheduleEventTool(deps);
    const plan: RescheduleEventPlan = {
      eventId: "evt-1",
      newStartUtc: "2026-09-10T14:00:00.000Z",
      newEndUtc: "2026-09-10T14:30:00.000Z",
    };

    const result = await tool.handler({}, { ...ctxFor(), plan });

    expect(result).toEqual(patchedEvent);
    expect(deps.patchEvent).toHaveBeenCalledWith(
      "token-abc",
      "evt-1",
      { start: "2026-09-10T14:00:00.000Z", end: "2026-09-10T14:30:00.000Z" },
      expect.anything(),
    );
  });
});
