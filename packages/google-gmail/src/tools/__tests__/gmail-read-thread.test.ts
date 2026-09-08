import { describe, expect, it, vi } from "vitest";
import attachmentOnlyMessage from "../../__tests__/fixtures/attachment-only-message.json";
import htmlOnlyNewsletter from "../../__tests__/fixtures/html-only-newsletter.json";
import quotedPrintableMessage from "../../__tests__/fixtures/quoted-printable-message.json";
import replyChainMessage from "../../__tests__/fixtures/reply-chain-message.json";
import textPlainMessage from "../../__tests__/fixtures/text-plain-message.json";
import type { AccessTokenPort } from "../../access-token-port";
import { GmailApiError } from "../../gmail-client";
import type { GmailClient, GmailMessageFull, GmailThreadMessageRef } from "../../gmail-client";
import { MAX_BODY_CHARS_PER_MESSAGE, MAX_THREAD_MESSAGES } from "../../truncate";
import { createGmailReadThreadTool } from "../gmail-read-thread";
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

function fixtureById(
  ...fixtures: GmailMessageFull[]
): (accessToken: string, id: string) => Promise<GmailMessageFull> {
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  return async (_accessToken: string, id: string) => {
    const fixture = byId.get(id);
    if (!fixture) throw new Error(`no fixture for message id ${id}`);
    return fixture;
  };
}

describe("createGmailReadThreadTool", () => {
  it("end-to-end: a plain-text-only message returns its decoded, unstripped text", async () => {
    const thread = {
      id: "thread-plain-1",
      messages: [{ id: "msg-plain-1", internalDate: "1000" }],
    };
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockResolvedValue(thread),
      getMessageFull: fixtureById(textPlainMessage as GmailMessageFull),
    });
    const tool = createGmailReadThreadTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.handler({ threadId: "thread-plain-1" }, CTX);

    expect(result).toEqual({
      ok: true,
      threadId: "thread-plain-1",
      subject: "Friday sync",
      messages: [
        {
          id: "msg-plain-1",
          from: "Sarah <sarah@example.com>",
          to: "Alex <alex@example.com>",
          date: "Fri, 4 Sep 2026 09:00:00 +0000",
          text: "Hi Alex,\n\nJust confirming our sync is at 3pm on Friday. See you then!\n\nThanks,\nSarah",
        },
      ],
    });
  });

  it("end-to-end: an HTML-only newsletter comes back as plain text with no tags/entities/CSS", async () => {
    const thread = {
      id: "thread-newsletter-1",
      messages: [{ id: "msg-newsletter-1", internalDate: "1000" }],
    };
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockResolvedValue(thread),
      getMessageFull: fixtureById(htmlOnlyNewsletter as GmailMessageFull),
    });
    const tool = createGmailReadThreadTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = (await tool.handler({ threadId: "thread-newsletter-1" }, CTX)) as {
      messages: { text: string }[];
    };

    const text = result.messages[0]?.text ?? "";
    expect(text).not.toMatch(/<[^>]+>/);
    expect(text).not.toContain("&amp;");
    expect(text).not.toContain("promo");
    expect(text).toBe("Weekly Deals & Offers\nSave 20% this week only.\n\nSee you soon!");
  });

  it("end-to-end: a quoted-printable body decodes correctly, including a multi-byte character", async () => {
    const thread = { id: "thread-qp-1", messages: [{ id: "msg-qp-1", internalDate: "1000" }] };
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockResolvedValue(thread),
      getMessageFull: fixtureById(quotedPrintableMessage as GmailMessageFull),
    });
    const tool = createGmailReadThreadTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = (await tool.handler({ threadId: "thread-qp-1" }, CTX)) as {
      messages: { text: string }[];
    };

    expect(result.messages[0]?.text).toBe(
      "Hi team,\n\nThe invoice total is €42.\n\nThanks,\nSarah",
    );
  });

  it("end-to-end: a deep quoted reply chain is stripped to just the new reply text, not re-narrated", async () => {
    const thread = {
      id: "thread-chain-1",
      messages: [{ id: "msg-chain-1", internalDate: "1000" }],
    };
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockResolvedValue(thread),
      getMessageFull: fixtureById(replyChainMessage as GmailMessageFull),
    });
    const tool = createGmailReadThreadTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = (await tool.handler({ threadId: "thread-chain-1" }, CTX)) as {
      messages: { text: string }[];
    };

    expect(result.messages[0]?.text).toBe("Sounds good, see you at 3pm.");
  });

  it("a thread with no readable text part returns that message with text: '', not a thrown error", async () => {
    const thread = {
      id: "thread-attachment-only-1",
      messages: [{ id: "msg-attachment-only-1", internalDate: "1000" }],
    };
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockResolvedValue(thread),
      getMessageFull: fixtureById(attachmentOnlyMessage as GmailMessageFull),
    });
    const tool = createGmailReadThreadTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = (await tool.handler({ threadId: "thread-attachment-only-1" }, CTX)) as {
      ok: boolean;
      messages: { text: string }[];
    };

    expect(result.ok).toBe(true);
    expect(result.messages[0]?.text).toBe("");
  });

  it("orders messages newest-first regardless of the order getThread returned them in", async () => {
    function messageFixture(id: string, dateHeader: string): GmailMessageFull {
      return {
        id,
        threadId: "thread-order-1",
        labelIds: ["INBOX"],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: "Re: order" },
            { name: "Date", value: dateHeader },
          ],
          body: { data: Buffer.from(`body of ${id}`).toString("base64url") },
        },
      };
    }

    const thread = {
      id: "thread-order-1",
      messages: [
        { id: "msg-oldest", internalDate: "1000" },
        { id: "msg-newest", internalDate: "3000" },
        { id: "msg-middle", internalDate: "2000" },
      ],
    };
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockResolvedValue(thread),
      getMessageFull: fixtureById(
        messageFixture("msg-oldest", "old"),
        messageFixture("msg-newest", "new"),
        messageFixture("msg-middle", "mid"),
      ),
    });
    const tool = createGmailReadThreadTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = (await tool.handler({ threadId: "thread-order-1" }, CTX)) as {
      messages: { id: string }[];
    };

    expect(result.messages.map((m) => m.id)).toEqual(["msg-newest", "msg-middle", "msg-oldest"]);
  });

  it("bounds the fan-out: a 100-message thread issues at most MAX_THREAD_MESSAGES getMessageFull calls, not 100", async () => {
    const refs: GmailThreadMessageRef[] = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i}`,
      internalDate: String(i),
    }));
    const thread = { id: "thread-huge-1", messages: refs };
    const getMessageFull = vi.fn().mockImplementation(
      async (_accessToken: string, id: string): Promise<GmailMessageFull> => ({
        id,
        threadId: "thread-huge-1",
        labelIds: ["INBOX"],
        payload: {
          mimeType: "text/plain",
          headers: [],
          body: { data: Buffer.from("body").toString("base64url") },
        },
      }),
    );
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockResolvedValue(thread),
      getMessageFull,
    });
    const tool = createGmailReadThreadTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = (await tool.handler({ threadId: "thread-huge-1" }, CTX)) as {
      messages: unknown[];
      truncated: boolean;
      returnedMessages: number;
      totalMessages: number;
      note: string;
    };

    expect(getMessageFull).toHaveBeenCalledTimes(MAX_THREAD_MESSAGES);
    expect(result.messages).toHaveLength(MAX_THREAD_MESSAGES);
    expect(result.truncated).toBe(true);
    expect(result.returnedMessages).toBe(MAX_THREAD_MESSAGES);
    expect(result.totalMessages).toBe(100);
    expect(typeof result.note).toBe("string");
    expect(result.note.length).toBeGreaterThan(0);

    // The newest 10 refs (internalDate "99" down to "90") are the ones kept.
    const keptIds = getMessageFull.mock.calls.map((call) => call[1] as string);
    expect(keptIds).toEqual(Array.from({ length: MAX_THREAD_MESSAGES }, (_, i) => `msg-${99 - i}`));
  });

  it("applies the per-message char cap after HTML-to-text and quote-stripping, not before", async () => {
    const longText = "x".repeat(MAX_BODY_CHARS_PER_MESSAGE + 500);
    const thread = { id: "thread-long-1", messages: [{ id: "msg-long-1", internalDate: "1000" }] };
    const fixture: GmailMessageFull = {
      id: "msg-long-1",
      threadId: "thread-long-1",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Subject", value: "Long message" }],
        body: { data: Buffer.from(longText).toString("base64url") },
      },
    };
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockResolvedValue(thread),
      getMessageFull: fixtureById(fixture),
    });
    const tool = createGmailReadThreadTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = (await tool.handler({ threadId: "thread-long-1" }, CTX)) as {
      messages: { text: string; bodyTruncated?: true }[];
    };

    expect(result.messages[0]?.text.length).toBe(MAX_BODY_CHARS_PER_MESSAGE);
    expect(result.messages[0]?.bodyTruncated).toBe(true);
  });

  it("an untruncated thread's result is byte-identical to the un-capped shape — no truncated key at all", async () => {
    const thread = {
      id: "thread-plain-1",
      messages: [{ id: "msg-plain-1", internalDate: "1000" }],
    };
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockResolvedValue(thread),
      getMessageFull: fixtureById(textPlainMessage as GmailMessageFull),
    });
    const tool = createGmailReadThreadTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.handler({ threadId: "thread-plain-1" }, CTX);

    expect(Object.keys(result as object).sort()).toEqual(
      ["ok", "threadId", "subject", "messages"].sort(),
    );
  });

  it("a 403 surfaces as the structured insufficient_scope refusal, not a throw", async () => {
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockRejectedValue(new GmailApiError("forbidden", 403)),
    });
    const tool = createGmailReadThreadTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.handler({ threadId: "thread-1" }, CTX);

    expect(result).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      fix: "run /connect google gmail",
    });
  });

  it("rethrows any other error", async () => {
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockRejectedValue(new GmailApiError("server error", 500)),
    });
    const tool = createGmailReadThreadTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    await expect(tool.handler({ threadId: "thread-1" }, CTX)).rejects.toBeInstanceOf(GmailApiError);
  });

  it("declares timeoutMs: 30_000 and requiresApproval: false", () => {
    const tool = createGmailReadThreadTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
    });

    expect(tool.timeoutMs).toBe(30_000);
    expect(tool.requiresApproval).toBe(false);
  });
});
