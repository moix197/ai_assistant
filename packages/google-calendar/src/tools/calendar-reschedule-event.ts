import { type Clock, systemClock } from "@hermes/core";
import { z } from "zod/v4";
import { CalendarApiError, type CalendarEvent } from "../calendar-client";
import { formatApprovalTimeRangeEs } from "../format-approval-time";
import { renderEventTime } from "../render-event-time";
import { type RelativeTimeIntent, resolveRelativeInstant } from "../relative-time";
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
    eventId: z.string().min(1),
    relativeDay: z.enum(RELATIVE_DAY).optional(),
    weekday: z.enum(WEEKDAY).optional(),
    timeOfDay: z.enum(TIME_OF_DAY).optional(),
    startIso: z.string().optional(),
    durationMinutes: z.number().int().min(5).max(1440).optional(),
    endIso: z.string().optional(),
  })
  .strict();

type Args = z.infer<typeof schema>;

export type CreateCalendarRescheduleEventToolDeps = CalendarToolDeps & {
  /** Defaults to `systemClock`; overridden by tests for a deterministic "now" when resolving a relative-time intent. */
  clock?: Clock;
};

/**
 * What `prepare` resolves and threads onto `ctx.plan` for `handler` — the
 * event to move plus its already-validated new window. `handler` never
 * re-reads or re-validates anything: it just applies `plan` verbatim, same
 * posture as `sheets_write`'s `handler` reading off `ctx.plan` instead of
 * recomputing.
 */
export interface RescheduleEventPlan {
  eventId: string;
  /** UTC ISO instant. */
  newStartUtc: string;
  /** UTC ISO instant. */
  newEndUtc: string;
}

type ReschedulePrepareResult =
  | {
      ok: true;
      plan: RescheduleEventPlan;
      summary: { action: string; target?: string; effects: string[] };
    }
  | {
      ok: false;
      result: { ok: false; reason: "event_not_found" | "inverted_window" | "window_too_large" };
    };

/** Resolves the event's new start instant: explicit `startIso` wins outright; otherwise the intent fields resolve via `resolveRelativeInstant`, same pattern as `create_event`. */
function resolveNewStartUtc(args: Args, nowUtcIso: string, timeZone: string): string {
  if (args.startIso !== undefined) return args.startIso;

  const hasIntent =
    args.relativeDay !== undefined || args.weekday !== undefined || args.timeOfDay !== undefined;
  const intent: RelativeTimeIntent = hasIntent
    ? { relativeDay: args.relativeDay, weekday: args.weekday, timeOfDay: args.timeOfDay }
    : {};
  return resolveRelativeInstant(intent, nowUtcIso, timeZone);
}

/**
 * Resolves the event's new end instant: explicit `endIso` wins outright;
 * otherwise `newStartUtc + (explicit durationMinutes ?? the event's current
 * duration, computed from the pre-read)` — omitting `durationMinutes`
 * preserves how long the event already was.
 */
function resolveNewEndUtc(args: Args, newStartUtc: string, currentDurationMs: number): string {
  if (args.endIso !== undefined) return args.endIso;
  const durationMs =
    args.durationMinutes !== undefined ? args.durationMinutes * 60_000 : currentDurationMs;
  return new Date(new Date(newStartUtc).getTime() + durationMs).toISOString();
}

/**
 * `prepare(args, ctx)`: fetches the event by id — the one bounded pre-read
 * decision 3 calls for — before ever resolving a new time or building an
 * approval prompt. A 404 fails closed with `event_not_found`, no prompt for
 * a nonexistent event (same posture as Sheets' unknown-slug refusal).
 * Otherwise resolves the new `startUtc`/`endUtc` (preserving the event's
 * current duration when `durationMinutes`/`endIso` are both omitted) and
 * validates the new window via `validateTimeWindow` before ever building it
 * into a plan — a malformed relative-time resolution can't silently move an
 * event to an inverted or absurdly long span.
 *
 * Both `target` halves are built with `formatApprovalTimeRangeEs`, never
 * `renderEventTime`'s raw ISO `localLabel` — a live user found the ISO output
 * illegible in `create_event`'s approval prompt (Phase 4 correction); the old
 * range comes from the pre-read event's own start/end, the new range from
 * the resolved `newStartUtc`/`newEndUtc`.
 */
async function prepareRescheduleEvent(
  deps: CreateCalendarRescheduleEventToolDeps,
  args: unknown,
  ctx: CalendarToolContext,
): Promise<ReschedulePrepareResult> {
  const parsed = args as Args;
  const clock = deps.clock ?? systemClock;
  const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

  let event: CalendarEvent;
  try {
    event = await deps.calendarClient.getEvent(accessToken, parsed.eventId, ctx.signal);
  } catch (error) {
    if (error instanceof CalendarApiError && error.status === 404) {
      return { ok: false, result: { ok: false, reason: "event_not_found" } };
    }
    throw error;
  }

  const timeZone = await resolveUserTimeZone(deps, ctx.channel, ctx.channelUserId, ctx.signal);
  const rendered = renderEventTime(event, timeZone);
  if (rendered.allDay || rendered.startUtc === undefined || rendered.endUtc === undefined) {
    // All-day events are never created or rescheduled (plan Context,
    // structural scoping) — this branch only guards against attempting to
    // move one that predates the bot, e.g. a holiday the user manually put
    // on their own calendar.
    throw new Error("cannot reschedule an all-day event");
  }
  const currentDurationMs =
    new Date(rendered.endUtc).getTime() - new Date(rendered.startUtc).getTime();

  const nowUtcIso = clock.now().toISOString();
  const newStartUtc = resolveNewStartUtc(parsed, nowUtcIso, timeZone);
  const newEndUtc = resolveNewEndUtc(parsed, newStartUtc, currentDurationMs);

  const windowCheck = validateTimeWindow(newStartUtc, newEndUtc);
  if (!windowCheck.ok) {
    return { ok: false, result: { ok: false, reason: windowCheck.reason } };
  }

  const oldLocalRange = formatApprovalTimeRangeEs(rendered.startUtc, rendered.endUtc, timeZone);
  const newLocalRange = formatApprovalTimeRangeEs(newStartUtc, newEndUtc, timeZone);

  return {
    ok: true,
    plan: { eventId: parsed.eventId, newStartUtc, newEndUtc },
    summary: {
      action: `Mover "${event.summary}"`,
      target: `${oldLocalRange} → ${newLocalRange}`,
      effects: ["El evento se moverá a la nueva fecha y hora."],
    },
  };
}

/**
 * `reschedule_event`: `requiresApproval: true` — every call routes through
 * the approval gate before `handler` ever runs. `handler` reads `ctx.plan`
 * (built by `prepare`, already validated) and calls `calendarClient
 * .patchEvent` with exactly the planned start/end — it never re-reads or
 * re-resolves anything.
 */
export function createCalendarRescheduleEventTool(deps: CreateCalendarRescheduleEventToolDeps) {
  return {
    name: "reschedule_event",
    description:
      "Moves an existing event on the user's primary Google Calendar to a new time. Args: { eventId, relativeDay?, weekday?, timeOfDay?, startIso?, durationMinutes?, endIso? } — eventId must come from a prior list_events call. startIso wins outright over the intent fields for the new start time; endIso wins outright over durationMinutes for the new end time; if neither is given, the event's current duration is preserved. Requires human approval.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: true,
    prepare: (args: unknown, ctx: CalendarToolContext) => prepareRescheduleEvent(deps, args, ctx),
    handler: async (
      args: unknown,
      ctx: CalendarToolContext & { plan: RescheduleEventPlan },
    ): Promise<unknown> => {
      const { plan } = ctx;
      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);
      return deps.calendarClient.patchEvent(
        accessToken,
        plan.eventId,
        { start: plan.newStartUtc, end: plan.newEndUtc },
        ctx.signal,
      );
    },
  };
}
