import { z } from "zod/v4";
import { CalendarApiError, type CalendarEvent } from "../calendar-client";
import { formatApprovalTimeRangeEs } from "../format-approval-time";
import { renderEventTime } from "../render-event-time";
import { resolveUserTimeZone } from "../timezone-cache";
import type { CalendarToolContext, CalendarToolDeps } from "./tool-deps";

const schema = z
  .object({
    eventId: z.string().min(1),
  })
  .strict();

type Args = z.infer<typeof schema>;

export type CreateCalendarCancelEventToolDeps = CalendarToolDeps;

/**
 * What `prepare` resolves and threads onto `ctx.plan` for `handler` — just
 * the id of the event to delete. `handler` never re-reads anything: it
 * applies `plan` verbatim, same posture as `reschedule_event`'s `handler`.
 */
export interface CancelEventPlan {
  eventId: string;
}

type CancelPrepareResult =
  | {
      ok: true;
      plan: CancelEventPlan;
      summary: { action: string; target?: string; effects: string[] };
    }
  | {
      ok: false;
      result: { ok: false; reason: "event_not_found" };
    };

/**
 * Renders the pre-read event's own start/end for the approval prompt's
 * `target`. Unlike `reschedule_event`, cancelling doesn't need a duration or
 * a new window — the event's own time range is display-only here, so an
 * all-day event can still be cancelled: its `renderEventTime().localLabel`
 * (a plain date, e.g. `"2026-09-08"`) is used as-is, since there's no time
 * range to format; a timed event uses `formatApprovalTimeRangeEs`, never
 * `renderEventTime`'s raw ISO (same correction as Phase 5).
 */
function renderCancelTarget(event: CalendarEvent, timeZone: string): string {
  const rendered = renderEventTime(event, timeZone);
  if (rendered.allDay || rendered.startUtc === undefined || rendered.endUtc === undefined) {
    return rendered.localLabel;
  }
  return formatApprovalTimeRangeEs(rendered.startUtc, rendered.endUtc, timeZone);
}

/**
 * `prepare(args, ctx)`: fetches the event by id — the one bounded pre-read
 * decision 3 calls for — before ever building an approval prompt. A 404
 * fails closed with `event_not_found`, no prompt for a nonexistent event,
 * same posture as `reschedule_event`. No `all_day_event` guard here: unlike
 * reschedule, cancel doesn't need to compute a duration or a new window —
 * `deleteEvent` only needs the `eventId`, so an all-day event can be
 * cancelled the same as a timed one; only the approval `target`'s rendering
 * branches (see `renderCancelTarget`).
 */
async function prepareCancelEvent(
  deps: CreateCalendarCancelEventToolDeps,
  args: unknown,
  ctx: CalendarToolContext,
): Promise<CancelPrepareResult> {
  const parsed = args as Args;
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
  const localRange = renderCancelTarget(event, timeZone);

  return {
    ok: true,
    plan: { eventId: parsed.eventId },
    summary: {
      action: `Cancelar "${event.summary}"`,
      target: localRange,
      effects: ["El evento se eliminará de tu calendario principal."],
    },
  };
}

/**
 * `cancel_event`: `requiresApproval: true` — every call routes through the
 * approval gate before `handler` ever runs. `handler` reads `ctx.plan`
 * (built by `prepare`) and calls `calendarClient.deleteEvent` with exactly
 * the planned id. Calendar's `DELETE` on an already-deleted/unknown event id
 * returns `404`/`410 Gone` — treated as a successful no-op (the end state
 * the user wanted, "gone", already holds), not an error.
 */
export function createCalendarCancelEventTool(deps: CreateCalendarCancelEventToolDeps) {
  return {
    name: "cancel_event",
    description:
      "Cancels (deletes) an existing event on the user's primary Google Calendar. Args: { eventId } — eventId must come from a prior list_events call. Requires human approval.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: true,
    prepare: (args: unknown, ctx: CalendarToolContext) => prepareCancelEvent(deps, args, ctx),
    handler: async (
      args: unknown,
      ctx: CalendarToolContext & { plan: CancelEventPlan },
    ): Promise<unknown> => {
      const { plan } = ctx;
      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);
      try {
        await deps.calendarClient.deleteEvent(accessToken, plan.eventId, ctx.signal);
      } catch (error) {
        if (error instanceof CalendarApiError && (error.status === 404 || error.status === 410)) {
          return { ok: true };
        }
        throw error;
      }
      return { ok: true };
    },
  };
}
