import { type Clock, systemClock } from "@hermes/core";
import { z } from "zod/v4";
import { type RelativeTimeIntent, resolveRelativeInstant } from "../relative-time";
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

/**
 * Bound on the `listEvents` lookup made only when the freebusy check found a
 * conflict — a checked window is already bounded (`validateTimeWindow`), so
 * this is a response-shape cap on how many conflicting events get named, not
 * a truncation of an otherwise-unbounded result.
 */
const CONFLICT_LOOKUP_MAX_RESULTS = 10;

export type CreateCalendarCheckAvailabilityToolDeps = CalendarToolDeps & {
  /** Defaults to `systemClock`; overridden by tests for a deterministic "now" when resolving a relative-time intent. */
  clock?: Clock;
};

/**
 * Resolves a single `[startUtc, endUtc)` instant window: explicit `startIso`
 * wins outright, else `resolveRelativeInstant` (defaulting to
 * `{ relativeDay: "today" }` when no intent field was given either); explicit
 * `endIso` wins for the end, else `startUtc + durationMinutes` — same
 * explicit-wins-outright rule as `list_events`/`find_free_slot`, just
 * resolving a single instant instead of a search window (mirrors the
 * `create_event`/`reschedule_event` `startUtc`/`endUtc` resolution described
 * in the plan).
 */
function resolveCheckWindow(
  args: Args,
  nowUtcIso: string,
  timeZone: string,
): { startUtc: string; endUtc: string } {
  const hasIntent =
    args.relativeDay !== undefined || args.weekday !== undefined || args.timeOfDay !== undefined;
  const intent: RelativeTimeIntent = hasIntent
    ? { relativeDay: args.relativeDay, weekday: args.weekday, timeOfDay: args.timeOfDay }
    : { relativeDay: "today" };

  const startUtc = args.startIso ?? resolveRelativeInstant(intent, nowUtcIso, timeZone);
  const endUtc = args.endIso ?? new Date(new Date(startUtc).getTime() + args.durationMinutes * 60_000).toISOString();
  return { startUtc, endUtc };
}

/**
 * `check_availability`: ungated read — no `prepare`, same
 * `resolveUserTimeZone` pattern as `list_events`/`find_free_slot`. Resolves
 * and validates (`validateTimeWindow`) a single `[instant, instant +
 * durationMinutes)` window before ever calling
 * `calendarClient.queryFreeBusy`. A busy-free result short-circuits to
 * `available: true` with no further call; a busy result makes one bounded
 * `listEvents` lookup over the same window purely to name the conflicting
 * event(s) (freebusy alone returns only interval bounds, no `id`/`summary`).
 * Conflict entries render their `start`/`end` via `renderEventTime`, so an
 * all-day event reported as a conflict doesn't crash the response either.
 */
export function createCalendarCheckAvailabilityTool(deps: CreateCalendarCheckAvailabilityToolDeps) {
  return {
    name: "check_availability",
    description:
      "Checks whether the user's primary Google Calendar is free for a given duration at a resolved time. Args: { relativeDay?, weekday?, timeOfDay?, startIso?, endIso?, durationMinutes? } — startIso (or relativeDay/weekday/timeOfDay, defaulting to today) resolves the start instant; endIso, or startIso + durationMinutes (default 30, min 5, max 480), resolves the end. Returns available: true/false, naming any conflicting event when false.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: false,
    handler: async (args: unknown, ctx: CalendarToolContext): Promise<unknown> => {
      const parsed = args as Args;
      const clock = deps.clock ?? systemClock;

      const timeZone = await resolveUserTimeZone(deps, ctx.channel, ctx.channelUserId, ctx.signal);
      const nowUtcIso = clock.now().toISOString();
      const { startUtc, endUtc } = resolveCheckWindow(parsed, nowUtcIso, timeZone);

      const windowCheck = validateTimeWindow(startUtc, endUtc);
      if (!windowCheck.ok) return { ok: false, reason: windowCheck.reason };

      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);
      const busy = await deps.calendarClient.queryFreeBusy(
        accessToken,
        { timeMinIso: startUtc, timeMaxIso: endUtc },
        ctx.signal,
      );

      if (busy.length === 0) {
        return { ok: true, timeZone, range: { startUtc, endUtc }, available: true };
      }

      const events = await deps.calendarClient.listEvents(
        accessToken,
        { timeMinIso: startUtc, timeMaxIso: endUtc, maxResults: CONFLICT_LOOKUP_MAX_RESULTS },
        ctx.signal,
      );

      return {
        ok: true,
        timeZone,
        range: { startUtc, endUtc },
        available: false,
        conflicts: events.map((event) => ({
          id: event.id,
          summary: event.summary,
          ...renderEventTime(event, timeZone),
        })),
      };
    },
  };
}
