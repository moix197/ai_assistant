import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import { GmailApiError } from "../../gmail-client";
import type { GmailClient, GmailThread } from "../../gmail-client";
import { type GmailArchivePlan, createGmailArchiveTool } from "../gmail-archive";
import type { GmailToolContext } from "../tool-deps";

const CTX: GmailToolContext = {
  signal: new AbortController().signal,
  channel: "telegram",
  channelUserId: "111",
  turnId: "turn-1",
};

const THREAD: GmailThread = {
  id: "thread-1",
  messages: [
    { id: "msg-old", internalDate: "1000" },
    { id: "msg-new", internalDate: "2000" },
  ],
};

function fakeGmailClient(overrides: Partial<GmailClient> = {}): GmailClient {
  return {
    listMessages: vi.fn(),
    getMessageMetadata: vi.fn(),
    getMessageFull: vi.fn(),
    getThread: vi.fn(),
    modifyMessage: vi.fn(),
    listLabels: vi.fn(),
    ...overrides,
  } as GmailClient;
}

function fakeAccessTokenPort(): AccessTokenPort {
  return { getAccessToken: vi.fn().mockResolvedValue("secret-token") };
}

describe("createGmailArchiveTool", () => {
  it("requiresApproval is true, declares a prepare hook, and timeoutMs is 30_000", () => {
    const tool = createGmailArchiveTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
    });

    expect(tool.requiresApproval).toBe(true);
    expect(typeof tool.prepare).toBe("function");
    expect(tool.timeoutMs).toBe(30_000);
  });

  it("prepare resolves the thread's newest message and builds the plan and Spanish approval summary", async () => {
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockResolvedValue(THREAD),
      getMessageMetadata: vi.fn().mockResolvedValue({
        id: "msg-new",
        threadId: "thread-1",
        labelIds: ["INBOX"],
        headers: { Subject: "Q3 budget", From: "sarah@example.com" },
        snippet: "",
      }),
    });
    const tool = createGmailArchiveTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = (await tool.prepare?.({ threadId: "thread-1" }, CTX)) as {
      ok: true;
      plan: GmailArchivePlan;
      summary: { action: string; target?: string; effects: string[] };
    };

    expect(gmailClient.getMessageMetadata).toHaveBeenCalledWith(
      "secret-token",
      "msg-new",
      CTX.signal,
    );
    expect(result.ok).toBe(true);
    expect(result.plan).toEqual({
      threadId: "thread-1",
      messageId: "msg-new",
      subject: "Q3 budget",
    });
    expect(result.summary).toEqual({
      action: "¿Archivar esta conversación?",
      target: "Q3 budget",
      effects: ["Sale de Recibidos. Sigue disponible en Todos los mensajes."],
    });
  });

  it("a missing thread refuses pre-prompt with thread_not_found, and modifyMessage is never called", async () => {
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockRejectedValue(new GmailApiError("not found", 404)),
    });
    const tool = createGmailArchiveTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.prepare?.({ threadId: "missing-thread" }, CTX);

    expect(result).toEqual({ ok: false, result: { ok: false, reason: "thread_not_found" } });
    expect(gmailClient.modifyMessage).not.toHaveBeenCalled();
  });

  it("prepare surfaces a 403 as the structured insufficient_scope refusal, not a throw", async () => {
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockRejectedValue(new GmailApiError("forbidden", 403)),
    });
    const tool = createGmailArchiveTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.prepare?.({ threadId: "thread-1" }, CTX);

    expect(result).toEqual({
      ok: false,
      result: {
        ok: false,
        reason: "insufficient_scope",
        scope: "https://www.googleapis.com/auth/gmail.modify",
        fix: "run /connect google gmail-send",
      },
    });
  });

  it("handler removes exactly INBOX via the planned messageId, reading ctx.plan rather than re-resolving (getThread called once, not twice)", async () => {
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockResolvedValue(THREAD),
      getMessageMetadata: vi.fn().mockResolvedValue({
        id: "msg-new",
        threadId: "thread-1",
        labelIds: ["INBOX"],
        headers: { Subject: "Q3 budget" },
        snippet: "",
      }),
      modifyMessage: vi.fn().mockResolvedValue(undefined),
    });
    const tool = createGmailArchiveTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const prepared = (await tool.prepare?.({ threadId: "thread-1" }, CTX)) as {
      ok: true;
      plan: GmailArchivePlan;
    };
    const result = await tool.handler({ threadId: "thread-1" }, { ...CTX, plan: prepared.plan });

    expect(result).toEqual({ ok: true, threadId: "thread-1", subject: "Q3 budget" });
    expect(gmailClient.modifyMessage).toHaveBeenCalledWith(
      "secret-token",
      "msg-new",
      { removeLabelIds: ["INBOX"] },
      CTX.signal,
    );
    expect(gmailClient.getThread).toHaveBeenCalledTimes(1);
  });

  it("handler surfaces a 403 on modifyMessage as the structured insufficient_scope refusal, not a throw", async () => {
    const gmailClient = fakeGmailClient({
      modifyMessage: vi.fn().mockRejectedValue(new GmailApiError("forbidden", 403)),
    });
    const tool = createGmailArchiveTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });
    const plan: GmailArchivePlan = {
      threadId: "thread-1",
      messageId: "msg-new",
      subject: "Q3 budget",
    };

    const result = await tool.handler({ threadId: "thread-1" }, { ...CTX, plan });

    expect(result).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scope: "https://www.googleapis.com/auth/gmail.modify",
      fix: "run /connect google gmail-send",
    });
  });

  it("re-archiving an already-archived thread is a harmless no-op: calling the handler twice with the same plan succeeds both times with one call each to modifyMessage", async () => {
    const gmailClient = fakeGmailClient({ modifyMessage: vi.fn().mockResolvedValue(undefined) });
    const tool = createGmailArchiveTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });
    const plan: GmailArchivePlan = {
      threadId: "thread-1",
      messageId: "msg-new",
      subject: "Q3 budget",
    };

    const first = await tool.handler({ threadId: "thread-1" }, { ...CTX, plan });
    const second = await tool.handler({ threadId: "thread-1" }, { ...CTX, plan });

    expect(first).toEqual({ ok: true, threadId: "thread-1", subject: "Q3 budget" });
    expect(second).toEqual({ ok: true, threadId: "thread-1", subject: "Q3 budget" });
    expect(gmailClient.modifyMessage).toHaveBeenCalledTimes(2);
  });
});
