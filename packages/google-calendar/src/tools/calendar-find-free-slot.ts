import { type Clock, systemClock } from "@hermes/core";
import { z } from "zod/v4";
import type { FreeBusyInterval } from "../calendar-client";
import { type RelativeTimeIntent, resolveRelativeWindow } from "../relative-time";
import { renderEventTime } from "../render-event-time";
import { resolveUserTimeZone } from "../timezone-cache";
import { validateTimeWindow } from "../window-bounds";
import type { CalendarToolContext, CalendarToolDeps } from "./tool-deps";

const RELATIVE_DAY = ["today", "tomorrow", "yesterday", "this_week", "next_week"] as const;
const WEEKDAY = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
const TIME_OF_DAY = ["morning", "afternoon", "evening", "night"] as const;

const schema = z
  .object({
    relativeDay: z.enum(RELATIVE_DAY).optional(),
    weekday: z.enum(WEEKDAY).optional(),
    timeOfDay: z.enum(TIME_OF_DAY).optional(),
    startIso: z.string().optional(),
    endIso: z.string().optional(),
    durationMinutes: z.number().int().min(5).max(480).default(30),
  })
  .strict();

type Args = z.infer<typeof schema>;

/** At most this many candidate slots are returned — freebusy windows are bounded (`validateTimeWindow`), so this is a response-shape cap, not a truncation of an otherwise-unbounded result (Context: no dual-cap accumulator needed here). */
const MAX_CANDIDATES = 5;

export type CreateCalendarFindFreeSlotToolDeps = CalendarToolDeps & {
  /** Defaults to `systemClock`; overridden by tests for a deterministic "now" when resolving a relative-time intent. */
  clock?: Clock;
};

/**
 * Resolves the search window: explicit `startIso`/`endIso` win outright when
 * both are given; otherwise the intent fields (`relativeDay`/`weekday`/
 * `timeOfDay`) resolve via `resolveRelativeWindow`, defaulting to
 * `{ relativeDay: "today" }` when none of the three intent fields were given
 * either — same rule as `list_events`' `resolveWindow`.
 */
function resolveWindow(
  args: Args,
  nowUtcIso: string,
  timeZone: string,
): { startUtc: string; endUtc: string } {
  if (args.startIso !== undefined && args.endIso !== undefined) {
    return { startUtc: args.startIso, endUtc: args.endIso };
  }

  const hasIntent =
    args.relativeDay !== undefined || args.weekday !== undefined || args.timeOfDay !== undefined;
  const intent: RelativeTimeIntent = hasIntent
    ? { relativeDay: args.relativeDay, weekday: args.weekday, timeOfDay: args.timeOfDay }
    : { relativeDay: "today" };
  return resolveRelativeWindow(intent, nowUtcIso, timeZone);
}

/**
 * Pure gap computation, no I/O: walks the sorted busy intervals inside
 * `[windowStartUtc, windowEndUtc)` and, for each free stretch at least
 * `durationMinutes` long, emits one candidate slot of exactly that duration
 * starting at the earliest free instant in that stretch — one candidate per
 * qualifying gap (not multiple slices of a single large gap), capped at
 * `MAX_CANDIDATES`. An empty `busy` list yields a single candidate at the
 * window's start (the whole window is one big gap).
 */
function findFreeGaps(
  busy: FreeBusyInterval[],
  windowStartUtc: string,
  windowEndUtc: string,
  durationMinutes: number,
): Array<{ startUtc: string; endUtc: string }> {
  const windowStartMs = new Date(windowStartUtc).getTime();
  const windowEndMs = new Date(windowEndUtc).getTime();
  const durationMs = durationMinutes * 60_000;

  const sortedBusy = [...busy]
    .map((interval) => ({
      startMs: new Date(interval.start).getTime(),
      endMs: new Date(interval.end).getTime(),
    }))
    .sort((a, b) => a.startMs - b.startMs);

  const candidates: Array<{ startUtc: string; endUtc: string }> = [];
  let cursorMs = windowStartMs;

  for (const busyInterval of sortedBusy) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const freeUntilMs = Math.min(busyInterval.startMs, windowEndMs);
    if (freeUntilMs - cursorMs >= durationMs) {
      candidates.push({
        startUtc: new Date(cursorMs).toISOString(),
        endUtc: new Date(cursorMs + durationMs).toISOString(),
      });
    }
    cursorMs = Math.max(cursorMs, busyInterval.endMs);
    if (cursorMs >= windowEndMs) break;
  }

  if (
    candidates.length < MAX_CANDIDATES &&
    cursorMs < windowEndMs &&
    windowEndMs - cursorMs >= durationMs
  ) {
    candidates.push({
      startUtc: new Date(cursorMs).toISOString(),
      endUtc: new Date(cursorMs + durationMs).toISOString(),
    });
  }

  return candidates.slice(0, MAX_CANDIDATES);
}

/**
 * `find_free_slot`: ungated read — no `prepare`, same `resolveUserTimeZone` +
 * `resolveRelativeWindow` pattern as `list_events`. Resolves and validates
 * (`validateTimeWindow`) the search window before ever calling
 * `calendarClient.queryFreeBusy`, then computes gaps of at least
 * `durationMinutes` between the returned busy intervals — up to
 * `MAX_CANDIDATES` candidate slots, rendered in the user's own timezone via
 * `renderEventTime` (reused here purely for its local-offset-ISO formatting,
 * fed a synthetic timed "event" for each candidate).
 */
export function createCalendarFindFreeSlotTool(deps: CreateCalendarFindFreeSlotToolDeps) {
  return {
    name: "find_free_slot",
    description:
      "Finds up to 5 free time slots of a given duration on the user's primary Google Calendar within a resolved search window. Args: { relativeDay?, weekday?, timeOfDay?, startIso?, endIso?, durationMinutes? } — window resolution matches list_events (defaults to today when no window is given); durationMinutes defaults to 30, min 5, max 480.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: false,
    handler: async (args: unknown, ctx: CalendarToolContext): Promise<unknown> => {
      const parsed = args as Args;
      const clock = deps.clock ?? systemClock;

      const timeZone = await resolveUserTimeZone(deps, ctx.channel, ctx.channelUserId, ctx.signal);
      const nowUtcIso = clock.now().toISOString();
      const { startUtc, endUtc } = resolveWindow(parsed, nowUtcIso, timeZone);

      const windowCheck = validateTimeWindow(startUtc, endUtc);
      if (!windowCheck.ok) return { ok: false, reason: windowCheck.reason };

      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);
      const busy = await deps.calendarClient.queryFreeBusy(
        accessToken,
        { timeMinIso: startUtc, timeMaxIso: endUtc },
        ctx.signal,
      );

      const candidates = findFreeGaps(busy, startUtc, endUtc, parsed.durationMinutes).map((slot) =>
        renderEventTime(
          { start: { dateTime: slot.startUtc }, end: { dateTime: slot.endUtc } },
          timeZone,
        ),
      );

      return {
        ok: true,
        timeZone,
        durationMinutes: parsed.durationMinutes,
        range: { startUtc, endUtc },
        candidates,
      };
    },
  };
}
