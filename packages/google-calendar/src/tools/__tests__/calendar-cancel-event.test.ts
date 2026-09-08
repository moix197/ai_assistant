import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import { CalendarApiError } from "../../calendar-client";
import type { CalendarClient, CalendarEvent } from "../../calendar-client";
import { type CancelEventPlan, createCalendarCancelEventTool } from "../calendar-cancel-event";
import type { CalendarToolContext } from "../tool-deps";

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
  existingEvent?: CalendarEvent | null;
  deleteError?: unknown;
}) {
  const getAccessToken = vi.fn().mockResolvedValue("token-abc");
  const getPrimaryCalendarTimeZone = vi.fn().mockResolvedValue(opts.timeZone ?? "America/New_York");
  const getEvent =
    opts.existingEvent === null
      ? vi.fn().mockRejectedValue(new CalendarApiError("not found", 404))
      : vi.fn().mockResolvedValue(opts.existingEvent ?? EXISTING_EVENT);
  const deleteEvent =
    opts.deleteError !== undefined
      ? vi.fn().mockRejectedValue(opts.deleteError)
      : vi.fn().mockResolvedValue(undefined);
  const accessTokenPort: AccessTokenPort = { getAccessToken };
  const calendarClient = {
    getPrimaryCalendarTimeZone,
    listEvents: vi.fn(),
    getEvent,
    queryFreeBusy: vi.fn(),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent,
  } as unknown as CalendarClient;
  return { accessTokenPort, calendarClient, getAccessToken, getEvent, deleteEvent };
}

describe("createCalendarCancelEventTool", () => {
  it("requiresApproval is true and declares a prepare hook", () => {
    const tool = createCalendarCancelEventTool(fakeDeps({}));
    expect(tool.requiresApproval).toBe(true);
    expect(typeof tool.prepare).toBe("function");
  });

  it("prepare pre-reads the event and builds the ApprovalSummary with the legible Spanish time range", async () => {
    const deps = fakeDeps({ timeZone: "UTC" });
    const tool = createCalendarCancelEventTool(deps);

    const result = (await tool.prepare?.({ eventId: "evt-1" }, ctxFor())) as {
      ok: true;
      plan: CancelEventPlan;
      summary: { action: string; target?: string; effects: string[] };
    };

    expect(deps.getEvent).toHaveBeenCalledWith("token-abc", "evt-1", expect.anything());
    expect(result.ok).toBe(true);
    expect(result.summary.action).toBe('Cancelar "Standup"');
    expect(result.summary.target).toBe("lunes 7 de septiembre, 19:00 – 19:30");
    expect(result.summary.target).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // never raw ISO
    expect(result.summary.effects).toEqual(["El evento se eliminará de tu calendario principal."]);
    expect(result.plan).toEqual({ eventId: "evt-1" });
  });

  it("an all-day event's target uses the plain date label, not a formatted time range — cancel is allowed to proceed", async () => {
    const allDayEvent: CalendarEvent = {
      id: "evt-holiday",
      summary: "Labor Day",
      start: { date: "2026-09-08" },
      end: { date: "2026-09-09" },
    };
    const deps = fakeDeps({ existingEvent: allDayEvent });
    const tool = createCalendarCancelEventTool(deps);

    const result = (await tool.prepare?.({ eventId: "evt-holiday" }, ctxFor())) as {
      ok: true;
      plan: CancelEventPlan;
      summary: { action: string; target?: string };
    };

    expect(result.ok).toBe(true);
    expect(result.summary.action).toBe('Cancelar "Labor Day"');
    expect(result.summary.target).toBe("2026-09-08");
    expect(result.plan).toEqual({ eventId: "evt-holiday" });
  });

  it("event_not_found refusal on a mocked 404 — no approval prompt data returned", async () => {
    const deps = fakeDeps({ existingEvent: null });
    const tool = createCalendarCancelEventTool(deps);

    const result = await tool.prepare?.({ eventId: "missing-evt" }, ctxFor());

    expect(result).toEqual({ ok: false, result: { ok: false, reason: "event_not_found" } });
  });

  it("handler calls deleteEvent with the planned id and returns ok", async () => {
    const deps = fakeDeps({});
    const tool = createCalendarCancelEventTool(deps);
    const plan: CancelEventPlan = { eventId: "evt-1" };

    const result = await tool.handler({}, { ...ctxFor(), plan });

    expect(result).toEqual({ ok: true });
    expect(deps.deleteEvent).toHaveBeenCalledWith("token-abc", "evt-1", expect.anything());
  });

  it("handler treats a mocked 404 on delete as success, not a thrown error", async () => {
    const deps = fakeDeps({ deleteError: new CalendarApiError("not found", 404) });
    const tool = createCalendarCancelEventTool(deps);
    const plan: CancelEventPlan = { eventId: "evt-1" };

    const result = await tool.handler({}, { ...ctxFor(), plan });

    expect(result).toEqual({ ok: true });
  });

  it("handler treats a mocked 410 Gone on delete as success, not a thrown error", async () => {
    const deps = fakeDeps({ deleteError: new CalendarApiError("gone", 410) });
    const tool = createCalendarCancelEventTool(deps);
    const plan: CancelEventPlan = { eventId: "evt-1" };

    const result = await tool.handler({}, { ...ctxFor(), plan });

    expect(result).toEqual({ ok: true });
  });

  it("handler propagates any other delete error", async () => {
    const deps = fakeDeps({ deleteError: new CalendarApiError("server error", 500) });
    const tool = createCalendarCancelEventTool(deps);
    const plan: CancelEventPlan = { eventId: "evt-1" };

    await expect(tool.handler({}, { ...ctxFor(), plan })).rejects.toThrow("server error");
  });
});
