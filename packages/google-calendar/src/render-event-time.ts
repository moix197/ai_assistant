import { DateTime } from "luxon";

/**
 * The subset of Calendar API's `start`/`end` shape this function needs —
 * matches `CalendarEventDateTime` (`calendar-client.ts`) structurally rather
 * than importing it, so this stays a pure, dependency-free function callable
 * against any event-shaped value (a fresh `insertEvent` response, a
 * `getEvent` pre-read, a `listEvents` item).
 */
export interface RenderableEventDateTime {
  /** Present for an all-day event; mutually exclusive with `dateTime`. */
  date?: string;
  /** Present for a timed event; an offset/UTC ISO instant. */
  dateTime?: string;
}

export interface RenderedEventTime {
  allDay: boolean;
  /** UTC ISO instant — only present for a timed event. */
  startUtc?: string;
  /** UTC ISO instant — only present for a timed event. */
  endUtc?: string;
  /**
   * A human-legible rendering: for a timed event, the local-offset ISO
   * start/end (e.g. `"2026-09-07T14:00:00-04:00 – 2026-09-07T15:00:00-04:00"`)
   * in the user's own timezone — no separate free-text formatting layer, per
   * the plan's Context. For an all-day event, the plain `date` Google
   * returned, no timezone conversion attempted.
   */
  localLabel: string;
}

function toUtcIso(iso: string): string {
  const isoResult = DateTime.fromISO(iso).toUTC().toISO();
  if (isoResult === null)
    throw new Error(`invalid ISO instant in Calendar event date-time: ${iso}`);
  return isoResult;
}

function toLocalIso(iso: string, timeZone: string): string {
  const isoResult = DateTime.fromISO(iso).setZone(timeZone).toISO();
  if (isoResult === null)
    throw new Error(`invalid ISO instant in Calendar event date-time: ${iso}`);
  return isoResult;
}

/**
 * Pure function branching on `start.date` (all-day) vs `start.dateTime`
 * (timed) — never crashes on an *existing* all-day event Google returns (a
 * holiday, a birthday), per the plan's Context: all-day events render a
 * plain date label, no timezone-converted clock time attempted. Shared by
 * `list_events` (Phase 2) and `check_availability`'s conflict display
 * (Phase 3).
 */
export function renderEventTime(
  event: { start: RenderableEventDateTime; end: RenderableEventDateTime },
  timeZone: string,
): RenderedEventTime {
  if (event.start.date !== undefined) {
    return { allDay: true, localLabel: event.start.date };
  }

  const startIso = event.start.dateTime;
  const endIso = event.end.dateTime;
  if (startIso === undefined || endIso === undefined) {
    throw new Error("timed Calendar event is missing start.dateTime or end.dateTime");
  }

  return {
    allDay: false,
    startUtc: toUtcIso(startIso),
    endUtc: toUtcIso(endIso),
    localLabel: `${toLocalIso(startIso, timeZone)} – ${toLocalIso(endIso, timeZone)}`,
  };
}
