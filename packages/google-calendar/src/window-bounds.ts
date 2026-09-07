export interface ValidTimeWindow {
  ok: true;
}

export interface RejectedTimeWindow {
  ok: false;
  reason: "inverted_window" | "window_too_large";
}

export type TimeWindowValidation = ValidTimeWindow | RejectedTimeWindow;

export interface ValidateTimeWindowOptions {
  maxDays?: number;
}

const DEFAULT_MAX_DAYS = 31;

function toMillis(iso: string): number {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) throw new Error(`invalid ISO instant: ${iso}`);
  return ms;
}

/**
 * Pure guard against a malformed relative-time resolution (an inverted
 * range, or a multi-year span from a bad intent) reaching Google — called by
 * every tool that resolves or accepts a window (`list_events`,
 * `find_free_slot`, `check_availability`) before any Calendar API call,
 * whether the window came from `resolveRelativeWindow` or explicit
 * `startIso`/`endIso` args. `startUtc === endUtc` counts as inverted (a
 * zero-length window is never a valid list/freebusy range).
 */
export function validateTimeWindow(
  startUtc: string,
  endUtc: string,
  opts?: ValidateTimeWindowOptions,
): TimeWindowValidation {
  const maxDays = opts?.maxDays ?? DEFAULT_MAX_DAYS;
  const startMs = toMillis(startUtc);
  const endMs = toMillis(endUtc);

  if (startMs >= endMs) return { ok: false, reason: "inverted_window" };

  const maxWindowMs = maxDays * 24 * 60 * 60 * 1000;
  if (endMs - startMs > maxWindowMs) return { ok: false, reason: "window_too_large" };

  return { ok: true };
}
