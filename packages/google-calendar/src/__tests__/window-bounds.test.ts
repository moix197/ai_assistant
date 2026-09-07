import { describe, expect, it } from "vitest";
import { validateTimeWindow } from "../window-bounds";

describe("validateTimeWindow", () => {
  it("accepts a valid, forward window within the default max", () => {
    expect(
      validateTimeWindow("2026-09-08T00:00:00.000Z", "2026-09-09T00:00:00.000Z"),
    ).toEqual({ ok: true });
  });

  it("rejects an equal start/end as inverted_window (zero-length window)", () => {
    expect(
      validateTimeWindow("2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.000Z"),
    ).toEqual({ ok: false, reason: "inverted_window" });
  });

  it("rejects start > end as inverted_window", () => {
    expect(
      validateTimeWindow("2026-09-09T00:00:00.000Z", "2026-09-08T00:00:00.000Z"),
    ).toEqual({ ok: false, reason: "inverted_window" });
  });

  it("rejects a window past maxDays as window_too_large", () => {
    expect(
      validateTimeWindow("2026-09-08T00:00:00.000Z", "2026-10-10T00:00:00.000Z", { maxDays: 31 }),
    ).toEqual({ ok: false, reason: "window_too_large" });
  });

  it("accepts a window exactly at the maxDays boundary", () => {
    expect(
      validateTimeWindow("2026-09-08T00:00:00.000Z", "2026-10-09T00:00:00.000Z", { maxDays: 31 }),
    ).toEqual({ ok: true });
  });

  it("honors a caller-supplied maxDays override", () => {
    expect(
      validateTimeWindow("2026-09-08T00:00:00.000Z", "2026-09-10T00:00:00.000Z", { maxDays: 1 }),
    ).toEqual({ ok: false, reason: "window_too_large" });
  });
});
