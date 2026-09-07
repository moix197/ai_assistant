import { describe, expect, it } from "vitest";
import { renderEventTime } from "../render-event-time";

describe("renderEventTime", () => {
  it("timed event: renders raw UTC ISO for start/end and a local-offset-ISO localLabel in the given timezone", () => {
    const rendered = renderEventTime(
      {
        start: { dateTime: "2026-09-08T18:00:00Z" },
        end: { dateTime: "2026-09-08T19:00:00Z" },
      },
      "America/New_York",
    );

    expect(rendered.allDay).toBe(false);
    expect(rendered.startUtc).toBe("2026-09-08T18:00:00.000Z");
    expect(rendered.endUtc).toBe("2026-09-08T19:00:00.000Z");
    // America/New_York is UTC-4 in September (EDT).
    expect(rendered.localLabel).toBe(
      "2026-09-08T14:00:00.000-04:00 – 2026-09-08T15:00:00.000-04:00",
    );
  });

  it("timed event: an already-offset dateTime is normalized to UTC for startUtc/endUtc", () => {
    const rendered = renderEventTime(
      {
        start: { dateTime: "2026-09-08T14:00:00-04:00" },
        end: { dateTime: "2026-09-08T15:00:00-04:00" },
      },
      "America/New_York",
    );

    expect(rendered.startUtc).toBe("2026-09-08T18:00:00.000Z");
    expect(rendered.endUtc).toBe("2026-09-08T19:00:00.000Z");
  });

  it("all-day event: renders the plain date, allDay: true, no timezone math attempted, and no startUtc/endUtc", () => {
    const rendered = renderEventTime(
      { start: { date: "2026-12-25" }, end: { date: "2026-12-26" } },
      "America/New_York",
    );

    expect(rendered).toEqual({ allDay: true, localLabel: "2026-12-25" });
  });

  it("throws when a non-all-day event is missing dateTime on either side", () => {
    expect(() =>
      renderEventTime({ start: {}, end: { dateTime: "2026-09-08T19:00:00Z" } }, "UTC"),
    ).toThrow();
  });
});
