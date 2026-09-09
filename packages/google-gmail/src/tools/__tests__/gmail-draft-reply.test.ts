import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import { GmailApiError } from "../../gmail-client";
import type { GmailClient, GmailThread } from "../../gmail-client";
import { decodeBase64Url } from "../../mime";
import { createGmailDraftReplyTool } from "../gmail-draft-reply";
import type { GmailToolContext } from "../tool-deps";

const CTX: GmailToolContext & { googleAccount: { googleEmail: string } } = {
  signal: new AbortController().signal,
  channel: "telegram",
  channelUserId: "111",
  turnId: "turn-1",
  googleAccount: { googleEmail: "me@example.com" },
};

const THREAD: GmailThread = {
  id: "thread-1",
  messages: [
    { id: "msg-old", internalDate: "1000" },
    { id: "msg-new", internalDate: "2000" },
  ],
};

const NEWEST_METADATA = {
  id: "msg-new",
  threadId: "thread-1",
  labelIds: ["INBOX"],
  headers: {
    From: "sarah@example.com",
    To: "me@example.com",
    Subject: "Confirmación",
    "Message-ID": "<msg-new@mail.gmail.com>",
  },
  snippet: "",
};

function fakeGmailClient(overrides: Partial<GmailClient> = {}): GmailClient {
  return {
    listMessages: vi.fn(),
    getMessageMetadata: vi.fn().mockResolvedValue(NEWEST_METADATA),
    getMessageFull: vi.fn(),
    getThread: vi.fn().mockResolvedValue(THREAD),
    modifyMessage: vi.fn(),
    listLabels: vi.fn(),
    createDraft: vi
      .fn()
      .mockResolvedValue({ id: "draft-1", message: { id: "m1", threadId: "thread-1" } }),
    updateDraft: vi
      .fn()
      .mockResolvedValue({ id: "draft-1", message: { id: "m2", threadId: "thread-1" } }),
    getDraft: vi.fn(),
    ...overrides,
  } as GmailClient;
}

function fakeAccessTokenPort(): AccessTokenPort {
  return { getAccessToken: vi.fn().mockResolvedValue("secret-token") };
}

function decodeRawSubject(raw: string): string {
  const text = decodeBase64Url(raw).toString("utf-8");
  const line = text.split("\r\n").find((l) => l.startsWith("Subject: ")) as string;
  return line.slice("Subject: ".length);
}

function decodeRawHeader(raw: string, name: string): string {
  const text = decodeBase64Url(raw).toString("utf-8");
  const line = text.split("\r\n").find((l) => l.startsWith(`${name}: `)) as string;
  return line.slice(`${name}: `.length);
}

describe("createGmailDraftReplyTool", () => {
  it("requiresApproval is false, declares no prepare hook, and timeoutMs is 30_000", () => {
    const tool = createGmailDraftReplyTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
    });

    expect(tool.requiresApproval).toBe(false);
    expect("prepare" in tool).toBe(false);
    expect(tool.timeoutMs).toBe(30_000);
  });

  it("handler derives recipient, Re: subject and threading headers from the thread's newest message, composes the raw MIME message, and saves a new draft", async () => {
    const gmailClient = fakeGmailClient();
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = (await tool.handler(
      { threadId: "thread-1", body: "El viernes me sirve." },
      CTX,
    )) as { ok: true; draftId: string; to: string; subject: string; body: string };

    expect(result.ok).toBe(true);
    expect(result.to).toBe("sarah@example.com");
    expect(result.subject).toBe("Re: Confirmación");
    expect(result.body).toBe("El viernes me sirve.");

    const [, createRequest] = (gmailClient.createDraft as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { threadId: string; raw: string }, AbortSignal];
    expect(createRequest.threadId).toBe("thread-1");
    expect(decodeRawSubject(createRequest.raw)).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(decodeRawHeader(createRequest.raw, "From")).toBe(CTX.googleAccount.googleEmail);
    expect(decodeRawHeader(createRequest.raw, "In-Reply-To")).toBe("<msg-new@mail.gmail.com>");
    expect(decodeRawHeader(createRequest.raw, "References")).toBe("<msg-new@mail.gmail.com>");
    expect(gmailClient.updateDraft).not.toHaveBeenCalled();
  });

  it("when the connected account sent the thread's last message, the reply goes to that message's To (the other party), not back to ourselves", async () => {
    const gmailClient = fakeGmailClient({
      getMessageMetadata: vi.fn().mockResolvedValue({
        ...NEWEST_METADATA,
        headers: {
          From: "me@example.com",
          To: "sarah@example.com",
          Subject: "Confirmación",
          "Message-ID": "<msg-new@mail.gmail.com>",
        },
      }),
    });
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = (await tool.handler(
      { threadId: "thread-1", body: "Cualquier novedad?" },
      CTX,
    )) as {
      ok: true;
      to: string;
    };

    expect(result.ok).toBe(true);
    expect(result.to).toBe("sarah@example.com");
    expect(result.to).not.toBe(CTX.googleAccount.googleEmail);
  });

  it("matches the connected account's address against From case-insensitively", async () => {
    const gmailClient = fakeGmailClient({
      getMessageMetadata: vi.fn().mockResolvedValue({
        ...NEWEST_METADATA,
        headers: {
          From: "Me@Example.com",
          To: "sarah@example.com",
          Subject: "Confirmación",
          "Message-ID": "<msg-new@mail.gmail.com>",
        },
      }),
    });
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = (await tool.handler({ threadId: "thread-1", body: "hola" }, CTX)) as {
      to: string;
    };

    expect(result.to).toBe("sarah@example.com");
  });

  it('matches a display-name-form From header ("Name <addr>") against the connected account\'s bare address', async () => {
    const gmailClient = fakeGmailClient({
      getMessageMetadata: vi.fn().mockResolvedValue({
        ...NEWEST_METADATA,
        headers: {
          From: "Yo Mismo <me@example.com>",
          To: "sarah@example.com",
          Subject: "Confirmación",
          "Message-ID": "<msg-new@mail.gmail.com>",
        },
      }),
    });
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = (await tool.handler({ threadId: "thread-1", body: "hola" }, CTX)) as {
      to: string;
    };

    expect(result.to).toBe("sarah@example.com");
  });

  it("a missing thread refuses with thread_not_found, and neither createDraft nor updateDraft is called", async () => {
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockRejectedValue(new GmailApiError("not found", 404)),
    });
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.handler({ threadId: "missing-thread", body: "hola" }, CTX);

    expect(result).toEqual({ ok: false, reason: "thread_not_found" });
    expect(gmailClient.createDraft).not.toHaveBeenCalled();
    expect(gmailClient.updateDraft).not.toHaveBeenCalled();
  });

  it("surfaces a 403 on getThread as the structured insufficient_scope refusal, not a throw", async () => {
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockRejectedValue(new GmailApiError("forbidden", 403)),
    });
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.handler({ threadId: "thread-1", body: "hola" }, CTX);

    expect(result).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scope: "https://www.googleapis.com/auth/gmail.modify",
      fix: "run /connect google gmail-send",
    });
  });

  it("create path (no draftId): handler calls createDraft and never calls updateDraft", async () => {
    const gmailClient = fakeGmailClient();
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.handler({ threadId: "thread-1", body: "El viernes me sirve." }, CTX);

    expect(gmailClient.createDraft).toHaveBeenCalledTimes(1);
    expect(gmailClient.updateDraft).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      draftId: "draft-1",
      to: "sarah@example.com",
      subject: "Re: Confirmación",
      body: "El viernes me sirve.",
    });
  });

  it("update path (draftId given): handler calls updateDraft with the given draftId, and never calls createDraft", async () => {
    const gmailClient = fakeGmailClient();
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.handler(
      { threadId: "thread-1", body: "El lunes me sirve.", draftId: "existing-draft" },
      CTX,
    );

    expect(gmailClient.updateDraft).toHaveBeenCalledWith(
      "secret-token",
      "existing-draft",
      { threadId: "thread-1", raw: expect.any(String) },
      CTX.signal,
    );
    expect(gmailClient.createDraft).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      draftId: "existing-draft",
      to: "sarah@example.com",
      subject: "Re: Confirmación",
      body: "El lunes me sirve.",
    });
  });

  it("handler surfaces a 403 on createDraft as the structured insufficient_scope refusal, not a throw", async () => {
    const gmailClient = fakeGmailClient({
      createDraft: vi.fn().mockRejectedValue(new GmailApiError("forbidden", 403)),
    });
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.handler({ threadId: "thread-1", body: "hola" }, CTX);

    expect(result).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scope: "https://www.googleapis.com/auth/gmail.modify",
      fix: "run /connect google gmail-send",
    });
  });

  it("never references drafts.send or messages.send anywhere in the tool's source", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(__dirname, "..", "gmail-draft-reply.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/drafts\.send/);
    expect(source).not.toMatch(/messages\.send/);
    expect(source).not.toMatch(/sendDraft/);
  });
});
