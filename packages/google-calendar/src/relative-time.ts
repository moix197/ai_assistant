import { DateTime } from "luxon";

export type RelativeDay = "today" | "tomorrow" | "yesterday" | "this_week" | "next_week";

export type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type TimeOfDay = "morning" | "afternoon" | "evening" | "night";

/**
 * The small structured intent the model extracts — resolved deterministically
 * against "now" and the user's own IANA zone by the functions below, never by
 * the model itself (settled decision 2).
 */
export interface RelativeTimeIntent {
  relativeDay?: RelativeDay;
  weekday?: Weekday;
  timeOfDay?: TimeOfDay;
}

/** ISO weekday numbers (`DateTime.weekday`: 1 = Monday ... 7 = Sunday). */
const ISO_WEEKDAY: Record<Weekday, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

/** Local hour a bare instant resolves to for each `timeOfDay` — used both as the default hour and, below, as the start of that time-of-day's window range. */
const INSTANT_HOUR_BY_TIME_OF_DAY: Record<TimeOfDay, number> = {
  morning: 9,
  afternoon: 14,
  evening: 18,
  night: 21,
};

/** Local-hour `[start, end)` bounds for each `timeOfDay`, used to narrow a single-day window — each range brackets that time of day's instant default above. */
const WINDOW_HOUR_RANGE_BY_TIME_OF_DAY: Record<TimeOfDay, { startHour: number; endHour: number }> =
  {
    morning: { startHour: 6, endHour: 12 },
    afternoon: { startHour: 12, endHour: 18 },
    evening: { startHour: 18, endHour: 21 },
    night: { startHour: 21, endHour: 24 },
  };

function requireIso(dt: DateTime): string {
  const iso = dt.toUTC().toISO();
  if (iso === null) throw new Error("failed to render an invalid DateTime as ISO");
  return iso;
}

/**
 * Resolves the local calendar day `intent` refers to, independent of any
 * `timeOfDay` — shared by `resolveRelativeInstant` and
 * `resolveRelativeWindow`'s single-day path. When `weekday` is given, it
 * determines the day outright: `relativeDay: "next_week"` pushes the match
 * one week further out; any other/absent `relativeDay` resolves to the next
 * occurrence of that weekday on or after `anchorLocal` (today counts as a
 * match). Without a `weekday`, `relativeDay` shifts by whole days from
 * `anchorLocal`; `"this_week"`/`"next_week"`/`"today"`/absent all resolve to
 * `anchorLocal` itself here — `resolveRelativeWindow` special-cases
 * `this_week`/`next_week` into a week-long span before ever calling this.
 */
function resolveTargetDay(
  anchorLocal: DateTime,
  relativeDay: RelativeDay | undefined,
  weekday: Weekday | undefined,
): DateTime {
  const today = anchorLocal.startOf("day");

  if (weekday !== undefined) {
    const targetIsoWeekday = ISO_WEEKDAY[weekday];
    let daysAhead = (targetIsoWeekday - today.weekday + 7) % 7;
    if (relativeDay === "next_week") daysAhead += 7;
    return today.plus({ days: daysAhead });
  }

  switch (relativeDay) {
    case "yesterday":
      return today.minus({ days: 1 });
    case "tomorrow":
      return today.plus({ days: 1 });
    case "next_week":
      return today.plus({ days: 7 });
    default:
      return today;
  }
}

/** The Monday (ISO weekday 1) that starts `day`'s calendar week, computed off `.weekday` directly rather than luxon's locale-sensitive `startOf("week")`. */
function startOfIsoWeek(day: DateTime): DateTime {
  return day.startOf("day").minus({ days: day.weekday - 1 });
}

/**
 * `[start, end)` for a single local calendar day, narrowed to `timeOfDay`'s
 * hour range when given, else the whole day.
 */
function dayBounds(
  day: DateTime,
  timeOfDay: TimeOfDay | undefined,
): { start: DateTime; end: DateTime } {
  const base = day.startOf("day");
  if (timeOfDay === undefined) return { start: base, end: base.plus({ days: 1 }) };
  const range = WINDOW_HOUR_RANGE_BY_TIME_OF_DAY[timeOfDay];
  return { start: base.plus({ hours: range.startHour }), end: base.plus({ hours: range.endHour }) };
}

/**
 * Resolves `intent` plus "now" plus the user's IANA zone to a single
 * concrete UTC instant — built on `luxon`'s `DateTime.fromISO(...,
 * { zone: timeZone })` for IANA-timezone/DST-correct math (settled decision
 * 2). Defaults to `"morning"` (09:00 local) when `timeOfDay` is omitted.
 */
export function resolveRelativeInstant(
  intent: RelativeTimeIntent,
  nowUtcIso: string,
  timeZone: string,
): string {
  const anchorLocal = DateTime.fromISO(nowUtcIso, { zone: "utc" }).setZone(timeZone);
  const targetDay = resolveTargetDay(anchorLocal, intent.relativeDay, intent.weekday);
  const hour = INSTANT_HOUR_BY_TIME_OF_DAY[intent.timeOfDay ?? "morning"];
  const instant = targetDay.set({ hour, minute: 0, second: 0, millisecond: 0 });
  return requireIso(instant);
}

/**
 * Resolves `intent` plus "now" plus the user's IANA zone to a
 * `[startUtc, endUtc)` window for list/freebusy queries. `weekday` (with or
 * without `relativeDay`) narrows to that one calendar day; otherwise
 * `relativeDay: "this_week"`/`"next_week"` spans the whole ISO week
 * (Monday-Sunday); every other case narrows to a single day. `timeOfDay`
 * further narrows a single-day window to that time-of-day's hour range (it
 * is not applied to a week-long window).
 */
export function resolveRelativeWindow(
  intent: RelativeTimeIntent,
  nowUtcIso: string,
  timeZone: string,
): { startUtc: string; endUtc: string } {
  const anchorLocal = DateTime.fromISO(nowUtcIso, { zone: "utc" }).setZone(timeZone);

  if (
    intent.weekday === undefined &&
    (intent.relativeDay === "this_week" || intent.relativeDay === "next_week")
  ) {
    let start = startOfIsoWeek(anchorLocal);
    if (intent.relativeDay === "next_week") start = start.plus({ weeks: 1 });
    const end = start.plus({ weeks: 1 });
    return { startUtc: requireIso(start), endUtc: requireIso(end) };
  }

  const targetDay = resolveTargetDay(anchorLocal, intent.relativeDay, intent.weekday);
  const { start, end } = dayBounds(targetDay, intent.timeOfDay);
  return { startUtc: requireIso(start), endUtc: requireIso(end) };
}
