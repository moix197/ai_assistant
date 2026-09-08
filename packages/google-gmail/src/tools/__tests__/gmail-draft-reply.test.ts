import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import { GmailApiError } from "../../gmail-client";
import type { GmailClient, GmailThread } from "../../gmail-client";
import { decodeBase64Url } from "../../mime";
import { type GmailDraftReplyPlan, createGmailDraftReplyTool } from "../gmail-draft-reply";
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
  it("requiresApproval is true, declares a prepare hook, and timeoutMs is 30_000", () => {
    const tool = createGmailDraftReplyTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
    });

    expect(tool.requiresApproval).toBe(true);
    expect(typeof tool.prepare).toBe("function");
    expect(tool.timeoutMs).toBe(30_000);
  });

  it("prepare derives recipient, Re: subject and threading headers from the thread's newest message, and builds the Spanish summary", async () => {
    const tool = createGmailDraftReplyTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
    });

    const result = (await tool.prepare?.(
      { threadId: "thread-1", body: "El viernes me sirve." },
      CTX,
    )) as {
      ok: true;
      plan: GmailDraftReplyPlan;
      summary: { action: string; target?: string; items?: string[]; effects: string[] };
    };

    expect(result.ok).toBe(true);
    expect(result.plan.threadId).toBe("thread-1");
    expect(result.plan.draftId).toBeUndefined();
    expect(result.plan.to).toBe("sarah@example.com");
    expect(result.plan.subject).toBe("Re: Confirmación");
    expect(result.plan.inReplyTo).toBe("<msg-new@mail.gmail.com>");
    expect(result.plan.references).toBe("<msg-new@mail.gmail.com>");
    expect(typeof result.plan.raw).toBe("string");
    expect(decodeRawSubject(result.plan.raw)).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(decodeRawHeader(result.plan.raw, "From")).toBe(CTX.googleAccount.googleEmail);

    expect(result.summary).toEqual({
      action: "¿Guardar este borrador de respuesta?",
      target: "Para: sarah@example.com — Re: Confirmación",
      items: ["El viernes me sirve."],
      effects: ["Se guarda como borrador en Gmail. No se envía nada todavía."],
    });
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

    const result = (await tool.prepare?.(
      { threadId: "thread-1", body: "Cualquier novedad?" },
      CTX,
    )) as { ok: true; plan: GmailDraftReplyPlan };

    expect(result.ok).toBe(true);
    expect(result.plan.to).toBe("sarah@example.com");
    expect(result.plan.to).not.toBe(CTX.googleAccount.googleEmail);
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

    const result = (await tool.prepare?.({ threadId: "thread-1", body: "hola" }, CTX)) as {
      ok: true;
      plan: GmailDraftReplyPlan;
    };

    expect(result.plan.to).toBe("sarah@example.com");
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

    const result = (await tool.prepare?.({ threadId: "thread-1", body: "hola" }, CTX)) as {
      ok: true;
      plan: GmailDraftReplyPlan;
    };

    expect(result.plan.to).toBe("sarah@example.com");
  });

  it("prepare's action reads '¿Actualizar el borrador?' when a draftId is supplied", async () => {
    const tool = createGmailDraftReplyTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
    });

    const result = (await tool.prepare?.(
      { threadId: "thread-1", body: "El lunes me sirve.", draftId: "draft-1" },
      CTX,
    )) as { ok: true; plan: GmailDraftReplyPlan; summary: { action: string } };

    expect(result.plan.draftId).toBe("draft-1");
    expect(result.summary.action).toBe("¿Actualizar el borrador?");
  });

  it("a missing thread refuses pre-prompt with thread_not_found, and neither createDraft nor updateDraft is called", async () => {
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockRejectedValue(new GmailApiError("not found", 404)),
    });
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.prepare?.({ threadId: "missing-thread", body: "hola" }, CTX);

    expect(result).toEqual({ ok: false, result: { ok: false, reason: "thread_not_found" } });
    expect(gmailClient.createDraft).not.toHaveBeenCalled();
    expect(gmailClient.updateDraft).not.toHaveBeenCalled();
  });

  it("prepare surfaces a 403 as the structured insufficient_scope refusal, not a throw", async () => {
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockRejectedValue(new GmailApiError("forbidden", 403)),
    });
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.prepare?.({ threadId: "thread-1", body: "hola" }, CTX);

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

  it("create path (no draftId): handler posts ctx.plan.raw verbatim to createDraft — byte-identical to what prepare produced — and never calls updateDraft", async () => {
    const gmailClient = fakeGmailClient();
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const prepared = (await tool.prepare?.(
      { threadId: "thread-1", body: "El viernes me sirve." },
      CTX,
    )) as { ok: true; plan: GmailDraftReplyPlan };

    const result = await tool.handler(
      { threadId: "thread-1", body: "El viernes me sirve." },
      { ...CTX, plan: prepared.plan },
    );

    expect(gmailClient.createDraft).toHaveBeenCalledWith(
      "secret-token",
      { threadId: "thread-1", raw: prepared.plan.raw },
      CTX.signal,
    );
    // Byte-identity: the exact same string instance prepare produced, not a recomposed one.
    const [, createRequest] = (gmailClient.createDraft as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { raw: string }, AbortSignal];
    expect(createRequest.raw).toBe(prepared.plan.raw);
    expect(gmailClient.updateDraft).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      draftId: "draft-1",
      to: "sarah@example.com",
      subject: "Re: Confirmación",
      body: "El viernes me sirve.",
    });
  });

  it("update path (draftId given): handler posts ctx.plan.raw verbatim to updateDraft with the given draftId, and never calls createDraft", async () => {
    const gmailClient = fakeGmailClient();
    const tool = createGmailDraftReplyTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const prepared = (await tool.prepare?.(
      { threadId: "thread-1", body: "El lunes me sirve.", draftId: "existing-draft" },
      CTX,
    )) as { ok: true; plan: GmailDraftReplyPlan };

    const result = await tool.handler(
      { threadId: "thread-1", body: "El lunes me sirve.", draftId: "existing-draft" },
      { ...CTX, plan: prepared.plan },
    );

    expect(gmailClient.updateDraft).toHaveBeenCalledWith(
      "secret-token",
      "existing-draft",
      { threadId: "thread-1", raw: prepared.plan.raw },
      CTX.signal,
    );
    const [, , updateRequest] = (gmailClient.updateDraft as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, { raw: string }, AbortSignal];
    expect(updateRequest.raw).toBe(prepared.plan.raw);
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
    const plan: GmailDraftReplyPlan = {
      threadId: "thread-1",
      to: "sarah@example.com",
      subject: "Re: Confirmación",
      body: "hola",
      raw: "RAW",
    };

    const result = await tool.handler({ threadId: "thread-1", body: "hola" }, { ...CTX, plan });

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
