import type { Clock } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import { CalendarApiError } from "../../calendar-client";
import type { CalendarClient, CalendarEvent } from "../../calendar-client";
import { type CreateEventPlan, createCalendarCreateEventTool } from "../calendar-create-event";
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

function fakeDeps(opts: {
  timeZone?: string;
  now?: Date;
  insertedEvent?: CalendarEvent;
  existingEvent?: CalendarEvent;
  insertError?: unknown;
}) {
  const getAccessToken = vi.fn().mockResolvedValue("token-abc");
  const getPrimaryCalendarTimeZone = vi.fn().mockResolvedValue(opts.timeZone ?? "America/New_York");
  const insertEvent = opts.insertError
    ? vi.fn().mockRejectedValue(opts.insertError)
    : vi.fn().mockResolvedValue(
        opts.insertedEvent ?? {
          id: "evt-inserted",
          summary: "Lunch with Alex",
          start: { dateTime: "2026-09-08T16:00:00Z" },
          end: { dateTime: "2026-09-08T17:00:00Z" },
        },
      );
  const getEvent = vi.fn().mockResolvedValue(
    opts.existingEvent ?? {
      id: "evt-existing",
      summary: "Lunch with Alex",
      start: { dateTime: "2026-09-08T16:00:00Z" },
      end: { dateTime: "2026-09-08T17:00:00Z" },
    },
  );
  const accessTokenPort: AccessTokenPort = { getAccessToken };
  const calendarClient = {
    getPrimaryCalendarTimeZone,
    listEvents: vi.fn(),
    getEvent,
    queryFreeBusy: vi.fn(),
    insertEvent,
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(),
  } as unknown as CalendarClient;
  const clock = fixedClock(opts.now ?? new Date("2026-09-07T12:00:00.000Z"));
  return { accessTokenPort, calendarClient, clock, getAccessToken, insertEvent, getEvent };
}

describe("createCalendarCreateEventTool", () => {
  it("requiresApproval is true and declares a prepare hook", () => {
    const tool = createCalendarCreateEventTool(fakeDeps({}));
    expect(tool.requiresApproval).toBe(true);
    expect(typeof tool.prepare).toBe("function");
  });

  it("prepare resolves an explicit startIso/endIso outright", async () => {
    const deps = fakeDeps({});
    const tool = createCalendarCreateEventTool(deps);

    const result = (await tool.prepare?.(
      {
        summary: "Lunch with Alex",
        startIso: "2030-01-01T12:00:00.000Z",
        endIso: "2030-01-01T13:00:00.000Z",
      },
      ctxFor(),
    )) as { ok: true; plan: CreateEventPlan };

    expect(result.ok).toBe(true);
    expect(result.plan.startUtc).toBe("2030-01-01T12:00:00.000Z");
    expect(result.plan.endUtc).toBe("2030-01-01T13:00:00.000Z");
  });

  it("prepare resolves a relative intent + durationMinutes identically to list_events' resolution (fixed clock, America/New_York)", async () => {
    const deps = fakeDeps({ now: new Date("2026-09-07T12:00:00.000Z") });
    const tool = createCalendarCreateEventTool(deps);

    const result = (await tool.prepare?.(
      { summary: "Lunch with Alex", relativeDay: "tomorrow", timeOfDay: "afternoon", durationMinutes: 60 },
      ctxFor(),
    )) as { ok: true; plan: CreateEventPlan };

    // 2026-09-08 14:00 America/New_York (EDT, UTC-4) is 18:00 UTC.
    expect(result.plan.startUtc).toBe("2026-09-08T18:00:00.000Z");
    expect(result.plan.endUtc).toBe("2026-09-08T19:00:00.000Z");
  });

  it("ApprovalSummary names the title, shows the local start-end range, and one effect sentence", async () => {
    const deps = fakeDeps({ timeZone: "UTC", now: new Date("2026-09-07T12:00:00.000Z") });
    const tool = createCalendarCreateEventTool(deps);

    const result = (await tool.prepare?.(
      {
        summary: "Lunch with Alex",
        startIso: "2026-09-08T12:00:00.000Z",
        endIso: "2026-09-08T13:00:00.000Z",
      },
      ctxFor(),
    )) as { ok: true; summary: { action: string; target?: string; effects: string[] } };

    expect(result.summary.action).toBe('Crear evento: "Lunch with Alex"');
    expect(result.summary.target).toBe(
      "2026-09-08T12:00:00.000Z – 2026-09-08T13:00:00.000Z",
    );
    expect(result.summary.effects).toEqual([
      "Se creará un evento nuevo en tu calendario principal.",
    ]);
  });

  it("eventId is stable across two prepare calls with the same turnId+args, and differs for a different turnId", async () => {
    const deps = fakeDeps({});
    const tool = createCalendarCreateEventTool(deps);
    const args = {
      summary: "Lunch with Alex",
      startIso: "2030-01-01T12:00:00.000Z",
      endIso: "2030-01-01T13:00:00.000Z",
    };

    const first = (await tool.prepare?.(args, ctxFor({ turnId: "turn-a" }))) as {
      ok: true;
      plan: CreateEventPlan;
    };
    const second = (await tool.prepare?.(args, ctxFor({ turnId: "turn-a" }))) as {
      ok: true;
      plan: CreateEventPlan;
    };
    const differentTurn = (await tool.prepare?.(args, ctxFor({ turnId: "turn-b" }))) as {
      ok: true;
      plan: CreateEventPlan;
    };

    expect(first.plan.eventId).toBe(second.plan.eventId);
    expect(first.plan.eventId).not.toBe(differentTurn.plan.eventId);
  });

  it("handler on a fresh insert returns the created event", async () => {
    const insertedEvent: CalendarEvent = {
      id: "evt-inserted",
      summary: "Lunch with Alex",
      start: { dateTime: "2026-09-08T16:00:00Z" },
      end: { dateTime: "2026-09-08T17:00:00Z" },
    };
    const deps = fakeDeps({ insertedEvent });
    const tool = createCalendarCreateEventTool(deps);
    const plan: CreateEventPlan = {
      eventId: "derived-id-1",
      summary: "Lunch with Alex",
      startUtc: "2026-09-08T16:00:00.000Z",
      endUtc: "2026-09-08T17:00:00.000Z",
    };

    const result = await tool.handler({}, { ...ctxFor(), plan });

    expect(result).toEqual(insertedEvent);
    expect(deps.insertEvent).toHaveBeenCalledWith(
      "token-abc",
      {
        id: "derived-id-1",
        summary: "Lunch with Alex",
        description: undefined,
        start: "2026-09-08T16:00:00.000Z",
        end: "2026-09-08T17:00:00.000Z",
      },
      expect.anything(),
    );
    expect(deps.getEvent).not.toHaveBeenCalled();
  });

  it("handler on a mocked 409 fetches and returns the existing event instead of throwing", async () => {
    const existingEvent: CalendarEvent = {
      id: "derived-id-1",
      summary: "Lunch with Alex",
      start: { dateTime: "2026-09-08T16:00:00Z" },
      end: { dateTime: "2026-09-08T17:00:00Z" },
    };
    const deps = fakeDeps({
      existingEvent,
      insertError: new CalendarApiError("conflict", 409),
    });
    const tool = createCalendarCreateEventTool(deps);
    const plan: CreateEventPlan = {
      eventId: "derived-id-1",
      summary: "Lunch with Alex",
      startUtc: "2026-09-08T16:00:00.000Z",
      endUtc: "2026-09-08T17:00:00.000Z",
    };

    const result = await tool.handler({}, { ...ctxFor(), plan });

    expect(result).toEqual(existingEvent);
    expect(deps.getEvent).toHaveBeenCalledWith("token-abc", "derived-id-1", expect.anything());
  });

  it("handler propagates a non-409 CalendarApiError unchanged", async () => {
    const deps = fakeDeps({ insertError: new CalendarApiError("server error", 500) });
    const tool = createCalendarCreateEventTool(deps);
    const plan: CreateEventPlan = {
      eventId: "derived-id-1",
      summary: "Lunch with Alex",
      startUtc: "2026-09-08T16:00:00.000Z",
      endUtc: "2026-09-08T17:00:00.000Z",
    };

    await expect(tool.handler({}, { ...ctxFor(), plan })).rejects.toThrow("server error");
    expect(deps.getEvent).not.toHaveBeenCalled();
  });
});
