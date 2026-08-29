import { afterEach, describe, expect, it, vi } from "vitest";
import { SheetsAmbiguousWriteError, SheetsApiError, createSheetsClient } from "../sheets-client";

/** The shape our own timeout (`REQUEST_TIMEOUT_MS` firing, or an external signal) produces — `requestJson` preserves this identity so `classifyWrite` can key off it. */
function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

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

  it("getSpreadsheetMeta quotes an all-digit tab title, since A1 notation would otherwise misparse it as a row reference", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          sheets: [{ properties: { sheetId: 0, title: "2024" } }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { sheets: [] }));
    const client = createSheetsClient({ fetchImpl });

    await client.getSpreadsheetMeta("secret-token", "sheet-abc");

    const [dataUrl] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(dataUrl).toContain("ranges='2024'!1%3A1");
  });

  it("getSpreadsheetMeta returns the empty-tabs result instead of throwing when the properties response omits `sheets`", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const client = createSheetsClient({ fetchImpl });

    const result = await client.getSpreadsheetMeta("secret-token", "sheet-abc");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({});
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

  // appendValues/updateValues (05-google-sheets Phase 5) — request
  // construction, then the per-mode retryable-vs-ambiguous split settled
  // decision 15 draws: a pre-send failure (429, connection refused) is
  // retryable for both; a post-send ambiguous failure (timeout, 5xx) is
  // never retried for appendValues (not idempotent) and retried exactly
  // once, internally, for updateValues (a fixed-range PUT converges either
  // way).

  it("appendValues POSTs to :append with valueInputOption, insertDataOption (defaulting to INSERT_ROWS), and the values body, unwrapping the API's nested `updates` result", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        updates: {
          updatedRange: "Sheet1!A2:B2",
          updatedRows: 1,
          updatedColumns: 2,
          updatedCells: 2,
        },
      }),
    );
    const client = createSheetsClient({ fetchImpl });

    const result = await client.appendValues(
      "secret-token",
      "sheet-abc",
      "Sheet1!A1:B1",
      [["Jane", "555-0100"]],
      "USER_ENTERED",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-abc/values/Sheet1!A1%3AB1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    expect(JSON.parse(init.body as string)).toEqual({ values: [["Jane", "555-0100"]] });
    expect(result).toEqual({
      updatedRange: "Sheet1!A2:B2",
      updatedRows: 1,
      updatedColumns: 2,
      updatedCells: 2,
    });
  });

  it("appendValues honors an explicit insertDataOption override", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { updates: {} }));
    const client = createSheetsClient({ fetchImpl });

    await client.appendValues("token", "sheet-abc", "Sheet1!A1:B1", [["x"]], "RAW", "OVERWRITE");

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("insertDataOption=OVERWRITE");
  });

  it("updateValues PUTs to the fixed range with valueInputOption and the values body", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        updatedRange: "Sheet1!A1:B1",
        updatedRows: 1,
        updatedColumns: 2,
        updatedCells: 2,
      }),
    );
    const client = createSheetsClient({ fetchImpl });

    const result = await client.updateValues(
      "secret-token",
      "sheet-abc",
      "Sheet1!A1:B1",
      [["Jane", "555-0100"]],
      "USER_ENTERED",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-abc/values/Sheet1!A1%3AB1?valueInputOption=USER_ENTERED",
    );
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ values: [["Jane", "555-0100"]] });
    expect(result).toEqual({
      updatedRange: "Sheet1!A1:B1",
      updatedRows: 1,
      updatedColumns: 2,
      updatedCells: 2,
    });
  });

  /** The real shape undici raises for a connection that never got established — `cause.code` is what `classifyWrite` actually keys off, not the message text. */
  function preSendNetworkError(code: string): Error {
    return new Error("fetch failed", { cause: { code } });
  }

  it.each([
    [
      "appendValues",
      (client: ReturnType<typeof createSheetsClient>) =>
        client.appendValues("token", "sheet-abc", "Sheet1!A1:B1", [["x"]], "RAW"),
    ],
    [
      "updateValues",
      (client: ReturnType<typeof createSheetsClient>) =>
        client.updateValues("token", "sheet-abc", "Sheet1!A1:B1", [["x"]], "RAW"),
    ],
  ] as const)(
    "%s classifies a pre-send failure (cause.code ECONNREFUSED, never reaching Google) as retryable, same as a 429 — settled decision 15",
    async (_name, call) => {
      vi.useFakeTimers();
      try {
        const fetchImpl = vi
          .fn()
          .mockRejectedValueOnce(preSendNetworkError("ECONNREFUSED"))
          .mockResolvedValueOnce(jsonResponse(200, { updates: {} }));
        const client = createSheetsClient({ fetchImpl });

        const resultPromise = call(client);
        await vi.runAllTimersAsync();
        await resultPromise;

        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("appendValues does NOT retry a bare `TypeError: fetch failed` whose cause.code is a post-send socket failure (ECONNRESET) — the request may already have reached Google", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(preSendNetworkError("ECONNRESET"));
    const client = createSheetsClient({ fetchImpl });

    await expect(
      client.appendValues("token", "sheet-abc", "Sheet1!A1:B1", [["x"]], "RAW"),
    ).rejects.toBeInstanceOf(SheetsAmbiguousWriteError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("appendValues treats a `TypeError: fetch failed` with no `cause` at all as ambiguous, not pre-send — fail-safe when the pre-send/post-send distinction can't be proven", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"));
    const client = createSheetsClient({ fetchImpl });

    await expect(
      client.appendValues("token", "sheet-abc", "Sheet1!A1:B1", [["x"]], "RAW"),
    ).rejects.toBeInstanceOf(SheetsAmbiguousWriteError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("appendValues throws SheetsAmbiguousWriteError on a post-send 5xx, without retrying — a resend could double-append the row", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(500, { error: "internal" }));
    const client = createSheetsClient({ fetchImpl });

    await expect(
      client.appendValues("token", "sheet-abc", "Sheet1!A1:B1", [["x"]], "RAW"),
    ).rejects.toBeInstanceOf(SheetsAmbiguousWriteError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("appendValues throws SheetsAmbiguousWriteError on this client's own timeout (AbortError), without retrying", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(abortError());
    const client = createSheetsClient({ fetchImpl });

    await expect(
      client.appendValues("token", "sheet-abc", "Sheet1!A1:B1", [["x"]], "RAW"),
    ).rejects.toBeInstanceOf(SheetsAmbiguousWriteError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("updateValues retries a post-send 5xx exactly once, internally, with the identical range/values, and resolves to a normal success — no ambiguity surfaces to the caller", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(500, { error: "internal" }))
        .mockResolvedValueOnce(jsonResponse(200, { updatedRange: "Sheet1!A1:B1", updatedRows: 1 }));
      const client = createSheetsClient({ fetchImpl });

      const resultPromise = client.updateValues(
        "token",
        "sheet-abc",
        "Sheet1!A1:B1",
        [["Jane", "555-0100"]],
        "USER_ENTERED",
      );
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual({ updatedRange: "Sheet1!A1:B1", updatedRows: 1 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      // The retry reused the identical attempt (same URL/method/body), not a
      // freshly re-derived call.
      const calls = fetchImpl.mock.calls as [string, RequestInit][];
      const [firstUrl, firstInit] = calls[0] as [string, RequestInit];
      const [secondUrl, secondInit] = calls[1] as [string, RequestInit];
      expect(secondUrl).toBe(firstUrl);
      expect(secondInit.body).toBe(firstInit.body);
    } finally {
      vi.useRealTimers();
    }
  });

  it("updateValues throws a genuine fatal error (no ambiguity hedge) when a second post-send 5xx follows the one internal retry", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(500, { error: "internal" }))
        .mockResolvedValueOnce(jsonResponse(500, { error: "internal again" }));
      const client = createSheetsClient({ fetchImpl });

      const resultPromise = client
        .updateValues("token", "sheet-abc", "Sheet1!A1:B1", [["x"]], "RAW")
        .catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error).toBeInstanceOf(SheetsApiError);
      expect(error).not.toBeInstanceOf(SheetsAmbiguousWriteError);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
