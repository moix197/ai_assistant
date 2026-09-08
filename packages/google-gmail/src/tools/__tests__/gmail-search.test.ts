import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import { GmailApiError } from "../../gmail-client";
import type { GmailClient } from "../../gmail-client";
import { createGmailSearchTool } from "../gmail-search";
import type { GmailToolContext } from "../tool-deps";

const CTX: GmailToolContext = {
  signal: new AbortController().signal,
  channel: "telegram",
  channelUserId: "111",
  turnId: "turn-1",
};

function fakeGmailClient(overrides: Partial<GmailClient> = {}): GmailClient {
  return {
    listMessages: vi.fn(),
    getMessageMetadata: vi.fn(),
    getMessageFull: vi.fn(),
    getThread: vi.fn(),
    ...overrides,
  } as GmailClient;
}

function fakeAccessTokenPort(): AccessTokenPort {
  return { getAccessToken: vi.fn().mockResolvedValue("secret-token") };
}

describe("createGmailSearchTool", () => {
  it("the q string reaches the client verbatim", async () => {
    const gmailClient = fakeGmailClient({
      listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    });
    const tool = createGmailSearchTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    await tool.handler({ query: "from:sarah@example.com newer_than:7d", maxResults: 10 }, CTX);

    expect(gmailClient.listMessages).toHaveBeenCalledWith(
      "secret-token",
      { q: "from:sarah@example.com newer_than:7d" },
      10,
      CTX.signal,
    );
  });

  it("maxResults defaults to 10 when omitted", async () => {
    const gmailClient = fakeGmailClient({
      listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    });
    const tool = createGmailSearchTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const parsed = tool.schema.parse({ query: "is:unread" });
    await tool.handler(parsed, CTX);

    expect(gmailClient.listMessages).toHaveBeenCalledWith(
      "secret-token",
      { q: "is:unread" },
      10,
      CTX.signal,
    );
  });

  it("maxResults is clamped by the schema to the [1, 25] range", () => {
    const tool = createGmailSearchTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
    });

    expect(() => tool.schema.parse({ query: "x", maxResults: 0 })).toThrow();
    expect(() => tool.schema.parse({ query: "x", maxResults: 26 })).toThrow();
    expect(tool.schema.parse({ query: "x", maxResults: 25 })).toEqual({
      query: "x",
      maxResults: 25,
    });
  });

  it("happy path: projects sender/subject/date/flags/snippet from a fixture payload", async () => {
    const gmailClient = fakeGmailClient({
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: "msg-1", threadId: "thread-1" }],
      }),
      getMessageMetadata: vi.fn().mockResolvedValue({
        id: "msg-1",
        threadId: "thread-1",
        labelIds: ["INBOX", "IMPORTANT"],
        headers: {
          From: "sarah@example.com",
          Subject: "Friday sync",
          Date: "Fri, 4 Sep 2026 09:00:00 +0000",
        },
        snippet: "Just confirming our sync is at 3pm...",
      }),
    });
    const tool = createGmailSearchTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.handler({ query: "sync", maxResults: 10 }, CTX);

    expect(result).toEqual({
      ok: true,
      messages: [
        {
          id: "msg-1",
          threadId: "thread-1",
          from: "sarah@example.com",
          subject: "Friday sync",
          date: "Fri, 4 Sep 2026 09:00:00 +0000",
          unread: false,
          important: true,
          snippet: "Just confirming our sync is at 3pm...",
        },
      ],
    });
  });

  it("empty results are {ok:true, messages: []}, never an error", async () => {
    const gmailClient = fakeGmailClient({
      listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    });
    const tool = createGmailSearchTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.handler({ query: "no matches at all", maxResults: 10 }, CTX);

    expect(result).toEqual({ ok: true, messages: [] });
    expect(gmailClient.getMessageMetadata).not.toHaveBeenCalled();
  });

  it("a 403 surfaces as the structured insufficient_scope refusal, not a throw", async () => {
    const gmailClient = fakeGmailClient({
      listMessages: vi.fn().mockRejectedValue(new GmailApiError("forbidden", 403)),
    });
    const tool = createGmailSearchTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.handler({ query: "x", maxResults: 10 }, CTX);

    expect(result).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      fix: "run /connect google gmail",
    });
  });

  it("rethrows any other error", async () => {
    const gmailClient = fakeGmailClient({
      listMessages: vi.fn().mockRejectedValue(new GmailApiError("server error", 500)),
    });
    const tool = createGmailSearchTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    await expect(tool.handler({ query: "x", maxResults: 10 }, CTX)).rejects.toBeInstanceOf(
      GmailApiError,
    );
  });

  it("declares timeoutMs: 30_000 and requiresApproval: false", () => {
    const tool = createGmailSearchTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
    });

    expect(tool.timeoutMs).toBe(30_000);
    expect(tool.requiresApproval).toBe(false);
  });
});
