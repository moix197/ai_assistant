import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import { GmailApiError } from "../../gmail-client";
import type { GmailClient } from "../../gmail-client";
import { createGmailListUnreadTool } from "../gmail-list-unread";
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
    ...overrides,
  } as GmailClient;
}

function fakeAccessTokenPort(): AccessTokenPort {
  return { getAccessToken: vi.fn().mockResolvedValue("secret-token") };
}

describe("createGmailListUnreadTool", () => {
  it("happy path: projects sender/subject/date/flags from a fixture payload", async () => {
    const gmailClient = fakeGmailClient({
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: "msg-1", threadId: "thread-1" }],
      }),
      getMessageMetadata: vi.fn().mockResolvedValue({
        id: "msg-1",
        threadId: "thread-1",
        labelIds: ["UNREAD", "INBOX", "IMPORTANT"],
        headers: {
          From: "sender@example.com",
          Subject: "Hello",
          Date: "Mon, 1 Sep 2026 00:00:00 +0000",
        },
      }),
    });
    const tool = createGmailListUnreadTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient,
    });

    const result = await tool.handler({ maxResults: 10 }, CTX);

    expect(result).toEqual({
      ok: true,
      messages: [
        {
          id: "msg-1",
          threadId: "thread-1",
          from: "sender@example.com",
          subject: "Hello",
          date: "Mon, 1 Sep 2026 00:00:00 +0000",
          unread: true,
          important: true,
        },
      ],
    });
    expect(gmailClient.listMessages).toHaveBeenCalledWith(
      "secret-token",
      { labelIds: ["UNREAD", "INBOX"] },
      10,
      CTX.signal,
    );
  });

  it("maxResults defaults to 10 when omitted", async () => {
    const gmailClient = fakeGmailClient({
      listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    });
    const tool = createGmailListUnreadTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient,
    });

    const parsed = tool.schema.parse({});
    await tool.handler(parsed, CTX);

    expect(gmailClient.listMessages).toHaveBeenCalledWith(
      "secret-token",
      { labelIds: ["UNREAD", "INBOX"] },
      10,
      CTX.signal,
    );
  });

  it("maxResults is clamped by the schema to the [1, 25] range", () => {
    const tool = createGmailListUnreadTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
    });

    expect(() => tool.schema.parse({ maxResults: 0 })).toThrow();
    expect(() => tool.schema.parse({ maxResults: 26 })).toThrow();
    expect(tool.schema.parse({ maxResults: 25 })).toEqual({ maxResults: 25 });
  });

  it("an empty inbox returns {ok:true, messages: []}, never an error", async () => {
    const gmailClient = fakeGmailClient({
      listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    });
    const tool = createGmailListUnreadTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient,
    });

    const result = await tool.handler({ maxResults: 10 }, CTX);

    expect(result).toEqual({ ok: true, messages: [] });
    expect(gmailClient.getMessageMetadata).not.toHaveBeenCalled();
  });

  it("a client 403 surfaces as the structured insufficient_scope refusal, not a throw", async () => {
    const gmailClient = fakeGmailClient({
      listMessages: vi.fn().mockRejectedValue(new GmailApiError("forbidden", 403)),
    });
    const tool = createGmailListUnreadTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient,
    });

    const result = await tool.handler({ maxResults: 10 }, CTX);

    expect(result).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      fix: "run /connect google gmail",
    });
  });

  it("rethrows any other error (e.g. a transient 5xx exhausted by the client's own retries)", async () => {
    const gmailClient = fakeGmailClient({
      listMessages: vi.fn().mockRejectedValue(new GmailApiError("server error", 500)),
    });
    const tool = createGmailListUnreadTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient,
    });

    await expect(tool.handler({ maxResults: 10 }, CTX)).rejects.toBeInstanceOf(GmailApiError);
  });

  it("declares timeoutMs: 30_000 and requiresApproval: false", () => {
    const tool = createGmailListUnreadTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
    });

    expect(tool.timeoutMs).toBe(30_000);
    expect(tool.requiresApproval).toBe(false);
  });
});
