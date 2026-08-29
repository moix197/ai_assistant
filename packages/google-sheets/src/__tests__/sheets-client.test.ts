import { afterEach, describe, expect, it, vi } from "vitest";
import { SheetsApiError, createSheetsClient } from "../sheets-client";

afterEach(() => {
  vi.useRealTimers();
});

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("createSheetsClient", () => {
  it("getSpreadsheetMeta requests tab properties first, then bounds cell data to each tab's header row via ranges", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          sheets: [
            { properties: { sheetId: 0, title: "Sheet1" } },
            { properties: { sheetId: 1, title: "Sheet 2" } },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { sheets: [] }));
    const client = createSheetsClient({ fetchImpl });

    await client.getSpreadsheetMeta("secret-token", "sheet-abc");

    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [propertiesUrl, propertiesInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(propertiesUrl).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-abc?fields=sheets.properties",
    );
    expect((propertiesInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-token",
    );

    const [dataUrl, dataInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(dataUrl).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-abc?fields=sheets.properties%2Csheets.data.rowData.values.formattedValue&ranges=Sheet1!1%3A1&ranges='Sheet%202'!1%3A1",
    );
    expect((dataInit.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("getSpreadsheetMeta skips the header-row request entirely when the spreadsheet has no tabs", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { sheets: [] }));
    const client = createSheetsClient({ fetchImpl });

    const result = await client.getSpreadsheetMeta("secret-token", "sheet-abc");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sheets: [] });
  });

  it("getValues requests the right URL (spreadsheetId, range, valueRenderOption) and Authorization header", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { range: "Sheet1!A1:B2", values: [] }));
    const client = createSheetsClient({ fetchImpl });

    await client.getValues("secret-token", "sheet-abc", "Sheet1!A1:B2", "FORMATTED_VALUE");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-abc/values/Sheet1!A1%3AB2?valueRenderOption=FORMATTED_VALUE",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  // The following retry/classification/redaction tests exercise getValues
  // rather than getSpreadsheetMeta: that shared behavior (classify/redact,
  // packages/core's withHttpRetry) is generic across both endpoints, and
  // getValues stays a single HTTP request per call — getSpreadsheetMeta now
  // issues two (properties, then ranges-bounded data; see the test above),
  // which would otherwise force every one of these to mock and account for
  // an extra leading request unrelated to what each test actually covers.

  it("a 429 is classified as rate-limited and retried, honoring the server's Retry-After header", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(429, { error: "rate limited" }, { "retry-after": "5" }))
        .mockResolvedValueOnce(jsonResponse(200, { range: "Sheet1!A1:B2", values: [] }));
      const client = createSheetsClient({ fetchImpl });

      const resultPromise = client.getValues(
        "token",
        "sheet-abc",
        "Sheet1!A1:B2",
        "FORMATTED_VALUE",
      );

      // Not yet retried before the server's own Retry-After has elapsed.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_500);
      const result = await resultPromise;

      expect(result).toEqual({ range: "Sheet1!A1:B2", values: [] });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a post-send 5xx is classified distinctly from a 429 — retried via computed backoff, not the server's Retry-After", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(500, { error: "internal" }))
        .mockResolvedValueOnce(jsonResponse(200, { range: "Sheet1!A1:B2", values: [] }));
      const client = createSheetsClient({ fetchImpl });

      const resultPromise = client.getValues(
        "token",
        "sheet-abc",
        "Sheet1!A1:B2",
        "FORMATTED_VALUE",
      );

      // No Retry-After was sent on the 5xx — the retry uses the small
      // computed exponential backoff instead, so it has already happened by
      // 1s, well under the 5s a rate-limit retry-after would have imposed.
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result).toEqual({ range: "Sheet1!A1:B2", values: [] });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets the access token appear in a thrown error message, for a fatal (non-retried) response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(403, { error: "forbidden: secret-token-xyz" }));
    const client = createSheetsClient({ fetchImpl });

    await expect(
      client.getValues("secret-token-xyz", "sheet-abc", "Sheet1!A1:B2", "FORMATTED_VALUE"),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(SheetsApiError);
      const message = (error as SheetsApiError).message;
      expect(message).not.toContain("secret-token-xyz");
      expect(message).toContain("<REDACTED>");
      return true;
    });
    // A 403 is neither 429 nor >= 500 — fatal, thrown on the first attempt.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never lets the access token appear in a thrown error message for a network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED secret-token-xyz"));
    const client = createSheetsClient({ fetchImpl });

    vi.useFakeTimers();
    try {
      const resultPromise = client
        .getValues("secret-token-xyz", "sheet-abc", "Sheet1!A1:B2", "FORMATTED_VALUE")
        .catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("secret-token-xyz");
    } finally {
      vi.useRealTimers();
    }
  });
});
