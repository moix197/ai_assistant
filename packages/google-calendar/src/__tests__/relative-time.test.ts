import { describe, expect, it } from "vitest";
import { resolveRelativeInstant, resolveRelativeWindow } from "../relative-time";

// Monday, 2026-09-07, 08:00 America/New_York (EDT, UTC-4) — a fixed "now"
// used across every combination below so expected values are all
// hand-computed against one anchor.
const NOW_UTC_ISO = "2026-09-07T12:00:00.000Z";
const NY = "America/New_York";

describe("resolveRelativeInstant", () => {
  it("relativeDay 'today' + timeOfDay 'morning' resolves to 09:00 local today", () => {
    expect(resolveRelativeInstant({ relativeDay: "today", timeOfDay: "morning" }, NOW_UTC_ISO, NY)).toBe(
      "2026-09-07T13:00:00.000Z",
    );
  });

  it("relativeDay 'tomorrow' + timeOfDay 'afternoon' resolves to 14:00 local tomorrow", () => {
    expect(
      resolveRelativeInstant({ relativeDay: "tomorrow", timeOfDay: "afternoon" }, NOW_UTC_ISO, NY),
    ).toBe("2026-09-08T18:00:00.000Z");
  });

  it("relativeDay 'yesterday' + timeOfDay 'evening' resolves to 18:00 local yesterday", () => {
    expect(
      resolveRelativeInstant({ relativeDay: "yesterday", timeOfDay: "evening" }, NOW_UTC_ISO, NY),
    ).toBe("2026-09-06T22:00:00.000Z");
  });

  it("weekday alone (no relativeDay) resolves to the next occurrence of that weekday, timeOfDay 'night' -> 21:00 local", () => {
    // today is Monday; the next Thursday is 3 days out.
    expect(resolveRelativeInstant({ weekday: "thursday", timeOfDay: "night" }, NOW_UTC_ISO, NY)).toBe(
      "2026-09-11T01:00:00.000Z",
    );
  });

  it("weekday + relativeDay 'next_week' pushes the match one week further out, even when today already matches", () => {
    // today IS Monday; next_week forces next Monday, not today.
    expect(
      resolveRelativeInstant(
        { weekday: "monday", relativeDay: "next_week", timeOfDay: "morning" },
        NOW_UTC_ISO,
        NY,
      ),
    ).toBe("2026-09-14T13:00:00.000Z");
  });

  it("a weekday earlier in the ISO week than today wraps forward to next week", () => {
    // today is Monday (iso 1); sunday (iso 7) is 6 days out, not -1.
    expect(resolveRelativeInstant({ weekday: "sunday", timeOfDay: "afternoon" }, NOW_UTC_ISO, NY)).toBe(
      "2026-09-13T18:00:00.000Z",
    );
  });

  it("defaults to 'morning' (09:00 local) when timeOfDay is omitted", () => {
    expect(resolveRelativeInstant({ relativeDay: "today" }, NOW_UTC_ISO, NY)).toBe(
      "2026-09-07T13:00:00.000Z",
    );
  });

  it("defaults to today, morning, when the intent is entirely empty", () => {
    expect(resolveRelativeInstant({}, NOW_UTC_ISO, NY)).toBe("2026-09-07T13:00:00.000Z");
  });

  it("respects the given IANA zone, not just the offset a US zone happens to share", () => {
    // UTC has no offset at all, so 09:00 local == 09:00Z, unlike NY's -04:00.
    expect(resolveRelativeInstant({ relativeDay: "today", timeOfDay: "morning" }, NOW_UTC_ISO, "UTC")).toBe(
      "2026-09-07T09:00:00.000Z",
    );
  });

  it("resolves the correct offset across a real DST spring-forward transition (America/New_York, 2026-03-08)", () => {
    // 2026-03-08 is the US spring-forward date: 2:00 EST jumps to 3:00 EDT.
    // "now" sits well after the jump (EDT already in effect); "tomorrow
    // morning" (09:00 local) must resolve using EDT's -04:00 offset, not
    // yesterday's EST -05:00 — a naive fixed-offset implementation would be
    // off by an hour here.
    const nowBeforeTransitionDay = "2026-03-07T12:00:00.000Z"; // Saturday, still EST
    expect(
      resolveRelativeInstant(
        { relativeDay: "tomorrow", timeOfDay: "morning" },
        nowBeforeTransitionDay,
        NY,
      ),
    ).toBe("2026-03-08T13:00:00.000Z");
  });
});

describe("resolveRelativeWindow", () => {
  it("relativeDay 'today' spans the whole local day", () => {
    expect(resolveRelativeWindow({ relativeDay: "today" }, NOW_UTC_ISO, NY)).toEqual({
      startUtc: "2026-09-07T04:00:00.000Z",
      endUtc: "2026-09-08T04:00:00.000Z",
    });
  });

  it("relativeDay 'tomorrow' + timeOfDay 'morning' narrows to that day's morning hour range", () => {
    expect(
      resolveRelativeWindow({ relativeDay: "tomorrow", timeOfDay: "morning" }, NOW_UTC_ISO, NY),
    ).toEqual({
      startUtc: "2026-09-08T10:00:00.000Z",
      endUtc: "2026-09-08T16:00:00.000Z",
    });
  });

  it("relativeDay 'this_week' (no weekday) spans the whole ISO week, Monday through the following Monday", () => {
    expect(resolveRelativeWindow({ relativeDay: "this_week" }, NOW_UTC_ISO, NY)).toEqual({
      startUtc: "2026-09-07T04:00:00.000Z",
      endUtc: "2026-09-14T04:00:00.000Z",
    });
  });

  it("relativeDay 'next_week' (no weekday) spans the following ISO week", () => {
    expect(resolveRelativeWindow({ relativeDay: "next_week" }, NOW_UTC_ISO, NY)).toEqual({
      startUtc: "2026-09-14T04:00:00.000Z",
      endUtc: "2026-09-21T04:00:00.000Z",
    });
  });

  it("weekday + timeOfDay narrows to that one day's time-of-day hour range", () => {
    expect(resolveRelativeWindow({ weekday: "friday", timeOfDay: "evening" }, NOW_UTC_ISO, NY)).toEqual({
      startUtc: "2026-09-11T22:00:00.000Z",
      endUtc: "2026-09-12T01:00:00.000Z",
    });
  });

  it("weekday present alongside relativeDay 'this_week' resolves the single matching day, not the whole week", () => {
    expect(
      resolveRelativeWindow({ weekday: "wednesday", relativeDay: "this_week" }, NOW_UTC_ISO, NY),
    ).toEqual({
      startUtc: "2026-09-09T04:00:00.000Z",
      endUtc: "2026-09-10T04:00:00.000Z",
    });
  });

  it("a wall-clock day is DST-aware, not a fixed 24h — the spring-forward day is 23 hours", () => {
    const nowOnTransitionDay = "2026-03-08T12:00:00.000Z";
    const window = resolveRelativeWindow({ relativeDay: "today" }, nowOnTransitionDay, NY);

    expect(window).toEqual({
      startUtc: "2026-03-08T05:00:00.000Z",
      endUtc: "2026-03-09T04:00:00.000Z",
    });
    const durationMs = new Date(window.endUtc).getTime() - new Date(window.startUtc).getTime();
    expect(durationMs).toBe(23 * 60 * 60 * 1000);
  });
});
