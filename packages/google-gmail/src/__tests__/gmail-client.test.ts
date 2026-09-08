import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailApiError, createGmailClient } from "../gmail-client";

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

describe("createGmailClient", () => {
  it("listMessages requests the right URL (labelIds, maxResults) and Authorization header", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [] }));
    const client = createGmailClient({ fetchImpl });

    await client.listMessages("secret-token", { labelIds: ["UNREAD", "INBOX"] }, 10);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=UNREAD&labelIds=INBOX&maxResults=10",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("listMessages includes q when given, before labelIds/maxResults", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [] }));
    const client = createGmailClient({ fetchImpl });

    await client.listMessages("token", { q: "is:unread", labelIds: ["INBOX"] }, 5);

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread&labelIds=INBOX&maxResults=5",
    );
  });

  it("listMessages returns an empty messages array (never undefined) when the API response omits the field", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const client = createGmailClient({ fetchImpl });

    const result = await client.listMessages("token", { labelIds: ["UNREAD"] }, 10);

    expect(result).toEqual({ messages: [] });
  });

  it("listMessages returns messages and resultSizeEstimate as given by the API", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        messages: [
          { id: "msg-1", threadId: "thread-1" },
          { id: "msg-2", threadId: "thread-2" },
        ],
        resultSizeEstimate: 2,
      }),
    );
    const client = createGmailClient({ fetchImpl });

    const result = await client.listMessages("token", { labelIds: ["UNREAD"] }, 10);

    expect(result).toEqual({
      messages: [
        { id: "msg-1", threadId: "thread-1" },
        { id: "msg-2", threadId: "thread-2" },
      ],
      resultSizeEstimate: 2,
    });
  });

  it("getMessageMetadata requests format=metadata with one metadataHeaders entry per header, and the Authorization header", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: "msg-1",
        threadId: "thread-1",
        labelIds: ["UNREAD", "INBOX"],
        snippet: "Hello there...",
        payload: {
          headers: [
            { name: "From", value: "sender@example.com" },
            { name: "Subject", value: "Hello" },
          ],
        },
      }),
    );
    const client = createGmailClient({ fetchImpl });

    const result = await client.getMessageMetadata("secret-token", "msg-1");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    expect(result).toEqual({
      id: "msg-1",
      threadId: "thread-1",
      labelIds: ["UNREAD", "INBOX"],
      headers: { From: "sender@example.com", Subject: "Hello" },
      snippet: "Hello there...",
    });
  });

  it("getMessageMetadata returns empty labelIds/headers/snippet (never undefined) when the API response omits them", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: "msg-1", threadId: "thread-1" }));
    const client = createGmailClient({ fetchImpl });

    const result = await client.getMessageMetadata("token", "msg-1");

    expect(result).toEqual({
      id: "msg-1",
      threadId: "thread-1",
      labelIds: [],
      headers: {},
      snippet: "",
    });
  });

  it("a 429 is classified as rate-limited and retried, honoring the server's Retry-After header", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(429, { error: "rate limited" }, { "retry-after": "5" }))
        .mockResolvedValueOnce(jsonResponse(200, { messages: [] }));
      const client = createGmailClient({ fetchImpl });

      const resultPromise = client.listMessages("token", { labelIds: ["UNREAD"] }, 10);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_500);
      const result = await resultPromise;

      expect(result).toEqual({ messages: [] });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a post-send 5xx is classified as transient and retried, within its bound", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(500, { error: "internal" }))
        .mockResolvedValueOnce(jsonResponse(200, { messages: [] }));
      const client = createGmailClient({ fetchImpl });

      const resultPromise = client.listMessages("token", { labelIds: ["UNREAD"] }, 10);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result).toEqual({ messages: [] });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([401, 403])(
    "a %i throws immediately with zero retries, never letting the access token appear in the thrown message",
    async (status) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse(status, { error: "forbidden: secret-token-xyz" }));
      const client = createGmailClient({ fetchImpl });

      await expect(
        client.listMessages("secret-token-xyz", { labelIds: ["UNREAD"] }, 10),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(GmailApiError);
        expect((error as GmailApiError).status).toBe(status);
        const message = (error as GmailApiError).message;
        expect(message).not.toContain("secret-token-xyz");
        expect(message).toContain("<REDACTED>");
        return true;
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("createDraft POSTs to /drafts with { message: { threadId, raw } } and returns the created draft", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: "draft-1",
        message: { id: "msg-1", threadId: "thread-1" },
      }),
    );
    const client = createGmailClient({ fetchImpl });

    const result = await client.createDraft("secret-token", {
      threadId: "thread-1",
      raw: "RAW_BYTES",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      message: { threadId: "thread-1", raw: "RAW_BYTES" },
    });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    expect(result).toEqual({ id: "draft-1", message: { id: "msg-1", threadId: "thread-1" } });
  });

  it("updateDraft PUTs to /drafts/{draftId} with { message: { threadId, raw } } and returns the updated draft", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: "draft-1",
        message: { id: "msg-2", threadId: "thread-1" },
      }),
    );
    const client = createGmailClient({ fetchImpl });

    const result = await client.updateDraft("secret-token", "draft-1", {
      threadId: "thread-1",
      raw: "RAW_BYTES_2",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft-1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      message: { threadId: "thread-1", raw: "RAW_BYTES_2" },
    });
    expect(result).toEqual({ id: "draft-1", message: { id: "msg-2", threadId: "thread-1" } });
  });

  it("getDraft GETs /drafts/{draftId}", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: "draft-1",
        message: { id: "msg-1", threadId: "thread-1" },
      }),
    );
    const client = createGmailClient({ fetchImpl });

    const result = await client.getDraft("secret-token", "draft-1");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft-1");
    expect(init.method).toBe("GET");
    expect(result).toEqual({ id: "draft-1", message: { id: "msg-1", threadId: "thread-1" } });
  });

  it("never lets the access token appear in a thrown error message for a network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED secret-token-xyz"));
    const client = createGmailClient({ fetchImpl });

    vi.useFakeTimers();
    try {
      const resultPromise = client
        .listMessages("secret-token-xyz", { labelIds: ["UNREAD"] }, 10)
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
