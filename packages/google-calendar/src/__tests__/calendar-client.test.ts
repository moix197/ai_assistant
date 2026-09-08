import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarApiError, createCalendarClient } from "../calendar-client";

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

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe("createCalendarClient", () => {
  it("getPrimaryCalendarTimeZone GETs /calendars/primary and returns the timeZone field", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { timeZone: "America/New_York" }));
    const client = createCalendarClient({ fetchImpl });

    const result = await client.getPrimaryCalendarTimeZone("secret-token");

    expect(result).toBe("America/New_York");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("listEvents requests the events collection with timeMin/timeMax/maxResults and singleEvents/orderBy fixed", async () => {
    const event = {
      id: "evt-1",
      summary: "Standup",
      start: { dateTime: "2026-09-08T13:00:00.000Z" },
      end: { dateTime: "2026-09-08T13:30:00.000Z" },
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { items: [event] }));
    const client = createCalendarClient({ fetchImpl });

    const result = await client.listEvents("token", {
      timeMinIso: "2026-09-08T00:00:00.000Z",
      timeMaxIso: "2026-09-09T00:00:00.000Z",
      maxResults: 20,
    });

    expect(result).toEqual([event]);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://www.googleapis.com/calendar/v3/calendars/primary/events?");
    expect(url).toContain("timeMin=2026-09-08T00%3A00%3A00.000Z");
    expect(url).toContain("timeMax=2026-09-09T00%3A00%3A00.000Z");
    expect(url).toContain("maxResults=20");
    expect(url).toContain("singleEvents=true");
    expect(url).toContain("orderBy=startTime");
  });

  it("listEvents returns an empty array when the API response omits items", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const client = createCalendarClient({ fetchImpl });

    const result = await client.listEvents("token", {
      timeMinIso: "2026-09-08T00:00:00.000Z",
      timeMaxIso: "2026-09-09T00:00:00.000Z",
      maxResults: 20,
    });

    expect(result).toEqual([]);
  });

  it("getEvent GETs the event by id, URL-encoded", async () => {
    const event = {
      id: "evt/1",
      summary: "1:1",
      start: { dateTime: "2026-09-08T13:00:00.000Z" },
      end: { dateTime: "2026-09-08T13:30:00.000Z" },
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, event));
    const client = createCalendarClient({ fetchImpl });

    const result = await client.getEvent("token", "evt/1");

    expect(result).toEqual(event);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/evt%2F1");
  });

  it("getEvent surfaces a 404 as CalendarApiError with status 404, not retried", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(404, { error: "not found" }));
    const client = createCalendarClient({ fetchImpl });

    await expect(client.getEvent("token", "missing")).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CalendarApiError);
      expect((error as CalendarApiError).status).toBe(404);
      return true;
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("queryFreeBusy POSTs to /freeBusy with the primary calendar and returns its busy intervals", async () => {
    const busy = [{ start: "2026-09-08T13:00:00.000Z", end: "2026-09-08T13:30:00.000Z" }];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { calendars: { primary: { busy } } }));
    const client = createCalendarClient({ fetchImpl });

    const result = await client.queryFreeBusy("secret-token", {
      timeMinIso: "2026-09-08T00:00:00.000Z",
      timeMaxIso: "2026-09-09T00:00:00.000Z",
    });

    expect(result).toEqual(busy);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      timeMin: "2026-09-08T00:00:00.000Z",
      timeMax: "2026-09-09T00:00:00.000Z",
      items: [{ id: "primary" }],
    });
  });

  it("queryFreeBusy returns an empty array when the primary calendar has no busy field", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { calendars: { primary: {} } }));
    const client = createCalendarClient({ fetchImpl });

    const result = await client.queryFreeBusy("token", {
      timeMinIso: "2026-09-08T00:00:00.000Z",
      timeMaxIso: "2026-09-09T00:00:00.000Z",
    });

    expect(result).toEqual([]);
  });

  it("insertEvent POSTs to the events collection, sending the caller-supplied id and wrapping start/end as dateTime objects", async () => {
    const created = {
      id: "deterministic-id",
      summary: "Lunch",
      start: { dateTime: "2026-09-08T16:00:00.000Z" },
      end: { dateTime: "2026-09-08T17:00:00.000Z" },
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, created));
    const client = createCalendarClient({ fetchImpl });

    const result = await client.insertEvent("secret-token", {
      id: "deterministic-id",
      summary: "Lunch",
      description: "with Alex",
      start: "2026-09-08T16:00:00.000Z",
      end: "2026-09-08T17:00:00.000Z",
    });

    expect(result).toEqual(created);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      id: "deterministic-id",
      summary: "Lunch",
      description: "with Alex",
      start: { dateTime: "2026-09-08T16:00:00.000Z" },
      end: { dateTime: "2026-09-08T17:00:00.000Z" },
    });
  });

  it("insertEvent omits id/description from the body when not given", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: "generated",
        summary: "Lunch",
        start: { dateTime: "2026-09-08T16:00:00.000Z" },
        end: { dateTime: "2026-09-08T17:00:00.000Z" },
      }),
    );
    const client = createCalendarClient({ fetchImpl });

    await client.insertEvent("token", {
      summary: "Lunch",
      start: "2026-09-08T16:00:00.000Z",
      end: "2026-09-08T17:00:00.000Z",
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("description");
  });

  it("insertEvent retries a post-send 5xx freely (same policy as a read) since a repeat with the same id is safe by construction", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(500, { error: "internal" }))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            id: "deterministic-id",
            summary: "Lunch",
            start: { dateTime: "2026-09-08T16:00:00.000Z" },
            end: { dateTime: "2026-09-08T17:00:00.000Z" },
          }),
        );
      const client = createCalendarClient({ fetchImpl });

      const resultPromise = client.insertEvent("token", {
        id: "deterministic-id",
        summary: "Lunch",
        start: "2026-09-08T16:00:00.000Z",
        end: "2026-09-08T17:00:00.000Z",
      });
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.id).toBe("deterministic-id");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("insertEvent surfaces a 409 as CalendarApiError with status 409, not retried — the caller treats this as already-created", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(409, { error: "conflict" }));
    const client = createCalendarClient({ fetchImpl });

    await expect(
      client.insertEvent("token", {
        id: "deterministic-id",
        summary: "Lunch",
        start: "2026-09-08T16:00:00.000Z",
        end: "2026-09-08T17:00:00.000Z",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CalendarApiError);
      expect((error as CalendarApiError).status).toBe(409);
      return true;
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("patchEvent PATCHes the event by id with only the given fields, wrapped as dateTime objects", async () => {
    const patched = {
      id: "evt-1",
      summary: "Lunch",
      start: { dateTime: "2026-09-10T16:00:00.000Z" },
      end: { dateTime: "2026-09-10T17:00:00.000Z" },
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, patched));
    const client = createCalendarClient({ fetchImpl });

    const result = await client.patchEvent("token", "evt-1", {
      start: "2026-09-10T16:00:00.000Z",
      end: "2026-09-10T17:00:00.000Z",
    });

    expect(result).toEqual(patched);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      start: { dateTime: "2026-09-10T16:00:00.000Z" },
      end: { dateTime: "2026-09-10T17:00:00.000Z" },
    });
  });

  it("deleteEvent DELETEs the event by id and resolves with no return value on a 204", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(emptyResponse(204));
    const client = createCalendarClient({ fetchImpl });

    const result = await client.deleteEvent("token", "evt-1");

    expect(result).toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1");
    expect(init.method).toBe("DELETE");
  });

  it("a 429 is classified as rate-limited and retried, honoring the server's Retry-After header", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(429, { error: "rate limited" }, { "retry-after": "5" }))
        .mockResolvedValueOnce(jsonResponse(200, { timeZone: "UTC" }));
      const client = createCalendarClient({ fetchImpl });

      const resultPromise = client.getPrimaryCalendarTimeZone("token");

      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_500);
      const result = await resultPromise;

      expect(result).toBe("UTC");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a post-send 5xx is classified as transient and retried via computed backoff", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(500, { error: "internal" }))
        .mockResolvedValueOnce(jsonResponse(200, { timeZone: "UTC" }));
      const client = createCalendarClient({ fetchImpl });

      const resultPromise = client.getPrimaryCalendarTimeZone("token");
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result).toBe("UTC");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fatal (non-retryable) status like 403 is thrown on the first attempt without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { error: "forbidden" }));
    const client = createCalendarClient({ fetchImpl });

    await expect(client.getPrimaryCalendarTimeZone("token")).rejects.toBeInstanceOf(
      CalendarApiError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never lets the access token appear in a thrown error message", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(403, { error: "forbidden: secret-token-xyz" }));
    const client = createCalendarClient({ fetchImpl });

    await expect(client.getPrimaryCalendarTimeZone("secret-token-xyz")).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(CalendarApiError);
        const message = (error as CalendarApiError).message;
        expect(message).not.toContain("secret-token-xyz");
        expect(message).toContain("<REDACTED>");
        return true;
      },
    );
  });
});
