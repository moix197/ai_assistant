import { describe, expect, it } from "vitest";
import { formatApprovalTimeRangeEs } from "../format-approval-time";

// Fixed IANA zone (not a naive UTC offset) so the test proves real timezone
// conversion: America/Argentina/Buenos_Aires is UTC-3 year-round (no DST).
const BA = "America/Argentina/Buenos_Aires";

describe("formatApprovalTimeRangeEs", () => {
  it("renders a same-local-day range as one date with two times", () => {
    // 2026-09-08T15:00:00Z / 16:00:00Z -> 12:00 / 13:00 America/Argentina/Buenos_Aires (UTC-3).
    expect(
      formatApprovalTimeRangeEs("2026-09-08T15:00:00.000Z", "2026-09-08T16:00:00.000Z", BA),
    ).toBe("martes 8 de septiembre, 12:00 – 13:00");
  });

  it("renders a range crossing local midnight with a full date+time on both ends", () => {
    // 2026-09-09T02:30:00Z / 04:00:00Z -> 23:30 Tue / 01:00 Wed America/Argentina/Buenos_Aires (UTC-3).
    expect(
      formatApprovalTimeRangeEs("2026-09-09T02:30:00.000Z", "2026-09-09T04:00:00.000Z", BA),
    ).toBe("martes 8 de septiembre, 23:30 – miércoles 9 de septiembre, 01:00");
  });
});
