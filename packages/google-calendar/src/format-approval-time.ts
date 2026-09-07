import { DateTime } from "luxon";

/**
 * Renders a UTC instant pair as a legible Spanish label for `create_event`'s
 * human-facing approval summary — a distinct UI surface from `renderEventTime`
 * (`render-event-time.ts`), whose ISO-based `localLabel` is correct and
 * untouched for tool-result JSON (`list_events`/`find_free_slot`/
 * `check_availability`). A non-technical Telegram user approves a real
 * calendar write off this string, so it must read as a sentence, never as raw
 * ISO — same legibility bar `sheets_write`'s approval `target` already holds
 * (`sheets-write.ts`'s `prepareWrite`, always a slug/description, never A1
 * notation or raw values).
 *
 * Same calendar day (in `timeZone`): one date, two times, e.g. "martes 8 de
 * septiembre, 12:00 – 13:00". Crossing a calendar day: full date+time on both
 * ends, e.g. "martes 8 de septiembre, 12:00 – miércoles 9 de septiembre,
 * 08:00" — omitting the end date would misstate an overnight event's length.
 */
export function formatApprovalTimeRangeEs(
  startUtc: string,
  endUtc: string,
  timeZone: string,
): string {
  const start = DateTime.fromISO(startUtc, { zone: "utc" }).setZone(timeZone).setLocale("es");
  const end = DateTime.fromISO(endUtc, { zone: "utc" }).setZone(timeZone).setLocale("es");

  if (start.hasSame(end, "day")) {
    return `${start.toFormat("cccc d 'de' LLLL")}, ${start.toFormat("HH:mm")} – ${end.toFormat("HH:mm")}`;
  }

  return `${start.toFormat("cccc d 'de' LLLL, HH:mm")} – ${end.toFormat("cccc d 'de' LLLL, HH:mm")}`;
}
