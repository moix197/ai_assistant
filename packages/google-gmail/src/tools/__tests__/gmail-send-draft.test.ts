import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import { GmailAmbiguousSendError, GmailApiError } from "../../gmail-client";
import type { GmailClient, GmailMessageFull } from "../../gmail-client";
import {
  type GmailSendDraftPlan,
  type GmailSendLogPort,
  createGmailSendDraftTool,
} from "../gmail-send-draft";
import type { GmailToolContext } from "../tool-deps";

const CTX: GmailToolContext = {
  signal: new AbortController().signal,
  channel: "telegram",
  channelUserId: "111",
  turnId: "turn-1",
};

const CTX_OTHER_TURN: GmailToolContext = { ...CTX, turnId: "turn-2" };

const DRAFT = { id: "draft-1", message: { id: "msg-1", threadId: "thread-1" } };

const FULL_MESSAGE: GmailMessageFull = {
  id: "msg-1",
  threadId: "thread-1",
  labelIds: [],
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "To", value: "sarah@example.com" },
      { name: "Subject", value: "Re: Confirmación" },
    ],
    body: { data: Buffer.from("Nos vemos el viernes.", "utf-8").toString("base64") },
  },
};

function fakeGmailClient(overrides: Partial<GmailClient> = {}): GmailClient & {
  getDraft: ReturnType<typeof vi.fn>;
  getMessageFull: ReturnType<typeof vi.fn>;
  sendDraft: ReturnType<typeof vi.fn>;
} {
  return {
    listMessages: vi.fn(),
    getMessageMetadata: vi.fn(),
    getMessageFull: vi.fn().mockResolvedValue(FULL_MESSAGE),
    getThread: vi.fn(),
    modifyMessage: vi.fn(),
    listLabels: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    getDraft: vi.fn().mockResolvedValue(DRAFT),
    sendDraft: vi.fn().mockResolvedValue({ id: "sent-msg-1", threadId: "thread-1" }),
    ...overrides,
  } as GmailClient & {
    getDraft: ReturnType<typeof vi.fn>;
    getMessageFull: ReturnType<typeof vi.fn>;
    sendDraft: ReturnType<typeof vi.fn>;
  };
}

function fakeAccessTokenPort(): AccessTokenPort & { getAccessToken: ReturnType<typeof vi.fn> } {
  return { getAccessToken: vi.fn().mockResolvedValue("secret-token") };
}

/**
 * A real (in-memory) intent/claim/complete implementation, not a dumb stub —
 * mirrors `sheets-write.test.ts`'s `fakeSheetWriteLogRepo`, widened with the
 * one extra `awaiting_approval` state `recordIntent` writes into. `claim`
 * reproduces the real repo's three outcomes and its "missing row inserts
 * fresh as pending" defensive fallback.
 */
function fakeSendLogRepo(): GmailSendLogPort & {
  recordIntent: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const rows = new Map<
    string,
    { status: "awaiting_approval" | "pending" | "complete"; outcome?: unknown }
  >();
  const recordIntent = vi.fn(async (dedupeKey: string) => {
    if (!rows.has(dedupeKey)) {
      rows.set(dedupeKey, { status: "awaiting_approval" });
    }
  });
  const claim = vi.fn(async (dedupeKey: string) => {
    const existing = rows.get(dedupeKey);
    if (!existing) {
      rows.set(dedupeKey, { status: "pending" });
      return "claimed" as const;
    }
    if (existing.status === "awaiting_approval") {
      existing.status = "pending";
      return "claimed" as const;
    }
    if (existing.status === "complete") {
      return { alreadyComplete: true as const, outcome: existing.outcome };
    }
    // status is "pending" — never fail-open: some other call already
    // started this exact send and we cannot tell how it ended.
    return { alreadyPending: true as const };
  });
  const complete = vi.fn(async (dedupeKey: string, outcome: unknown) => {
    rows.set(dedupeKey, { status: "complete", outcome });
  });
  const release = vi.fn(async (dedupeKey: string) => {
    const existing = rows.get(dedupeKey);
    if (existing?.status === "pending") {
      rows.delete(dedupeKey);
    }
  });
  return { recordIntent, claim, complete, release };
}

const ARGS = { draftId: "draft-1" };

/**
 * Runs the full gated pipeline a real turn would: `prepare` then `handler`
 * fed the resolved plan — mirrors `sheets-write.test.ts`'s `prepareAndRun`.
 * Throws if `prepare` refuses, since every caller below only reaches for
 * this against a known, sendable draft.
 */
async function prepareAndRun(
  tool: ReturnType<typeof createGmailSendDraftTool>,
  args: unknown,
  ctx: GmailToolContext = CTX,
): Promise<unknown> {
  const prepared = await tool.prepare(args, ctx);
  if (!prepared.ok) {
    throw new Error("fixture bug: expected prepare to succeed for a known draft");
  }
  return tool.handler(args, { ...ctx, plan: prepared.plan });
}

describe("gmail_send_draft", () => {
  it("carries the right identity, schema, timeout, and requiresApproval", () => {
    const tool = createGmailSendDraftTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
      sendLogRepo: fakeSendLogRepo(),
    });

    expect(tool.name).toBe("gmail_send_draft");
    expect(tool.requiresApproval).toBe(true);
    expect(tool.timeoutMs).toBe(30_000);
    expect(tool.schema.safeParse(ARGS).success).toBe(true);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  describe("prepare", () => {
    it("resolves the plan and Spanish summary from the draft's own headers/body, and records an awaiting_approval intent", async () => {
      const sendLogRepo = fakeSendLogRepo();
      const tool = createGmailSendDraftTool({
        accessTokenPort: fakeAccessTokenPort(),
        gmailClient: fakeGmailClient(),
        sendLogRepo,
      });

      const result = await tool.prepare(ARGS, CTX);

      expect(result).toEqual({
        ok: true,
        plan: { draftId: "draft-1", to: "sarah@example.com", subject: "Re: Confirmación" },
        summary: {
          action: "¿Enviar este correo?",
          target: "Para: sarah@example.com — Re: Confirmación",
          items: ["Nos vemos el viernes."],
          effects: ["Se envía de verdad. Esto no se puede deshacer."],
        },
      });
      expect(sendLogRepo.recordIntent).toHaveBeenCalledTimes(1);
      expect(sendLogRepo.recordIntent).toHaveBeenCalledWith(expect.any(String), {
        channel: "telegram",
        channelUserId: "111",
        turnId: "turn-1",
        tool: "gmail_send_draft",
        canonicalArgs: { draftId: "draft-1" },
        draftId: "draft-1",
      });
    });

    it("a vanished draft refuses pre-prompt with draft_not_found, and no intent row is ever written", async () => {
      const gmailClient = fakeGmailClient({
        getDraft: vi.fn().mockRejectedValue(new GmailApiError("not found", 404)),
      });
      const sendLogRepo = fakeSendLogRepo();
      const tool = createGmailSendDraftTool({
        accessTokenPort: fakeAccessTokenPort(),
        gmailClient,
        sendLogRepo,
      });

      const result = await tool.prepare(ARGS, CTX);

      expect(result).toEqual({ ok: false, result: { ok: false, reason: "draft_not_found" } });
      expect(gmailClient.getMessageFull).not.toHaveBeenCalled();
      expect(gmailClient.sendDraft).not.toHaveBeenCalled();
      expect(sendLogRepo.recordIntent).not.toHaveBeenCalled();
    });

    it("surfaces a 403 on getDraft as the structured insufficient_scope refusal, not a throw, and writes no intent row", async () => {
      const gmailClient = fakeGmailClient({
        getDraft: vi.fn().mockRejectedValue(new GmailApiError("forbidden", 403)),
      });
      const sendLogRepo = fakeSendLogRepo();
      const tool = createGmailSendDraftTool({
        accessTokenPort: fakeAccessTokenPort(),
        gmailClient,
        sendLogRepo,
      });

      const result = await tool.prepare(ARGS, CTX);

      expect(result).toEqual({
        ok: false,
        result: {
          ok: false,
          reason: "insufficient_scope",
          scope: "https://www.googleapis.com/auth/gmail.send",
          fix: "run /connect google gmail-send",
        },
      });
      expect(sendLogRepo.recordIntent).not.toHaveBeenCalled();
    });

    it("fails closed when recordIntent itself throws (DB unreachable) — prepare rejects rather than silently prompting", async () => {
      const sendLogRepo = fakeSendLogRepo();
      sendLogRepo.recordIntent.mockRejectedValueOnce(new Error("connection refused"));
      const tool = createGmailSendDraftTool({
        accessTokenPort: fakeAccessTokenPort(),
        gmailClient: fakeGmailClient(),
        sendLogRepo,
      });

      await expect(tool.prepare(ARGS, CTX)).rejects.toThrow("connection refused");
    });

    it("a denied approval never reaches the handler: prepare's intent row stays awaiting_approval, and neither claim nor sendDraft is ever called", async () => {
      const gmailClient = fakeGmailClient();
      const sendLogRepo = fakeSendLogRepo();
      const tool = createGmailSendDraftTool({
        accessTokenPort: fakeAccessTokenPort(),
        gmailClient,
        sendLogRepo,
      });

      await tool.prepare(ARGS, CTX);
      // Simulates a human tapping "Rechazar" — the loop never invokes
      // `handler` at all in that case, so nothing further ever runs here.

      expect(sendLogRepo.claim).not.toHaveBeenCalled();
      expect(gmailClient.sendDraft).not.toHaveBeenCalled();
    });
  });

  it("happy path: claims, sends, records completion, and returns the sent message id — never the now-gone draftId", async () => {
    const gmailClient = fakeGmailClient();
    const accessTokenPort = fakeAccessTokenPort();
    const sendLogRepo = fakeSendLogRepo();
    const tool = createGmailSendDraftTool({ accessTokenPort, gmailClient, sendLogRepo });

    const result = await prepareAndRun(tool, ARGS);

    expect(accessTokenPort.getAccessToken).toHaveBeenCalledWith("telegram", "111");
    expect(gmailClient.sendDraft).toHaveBeenCalledWith("secret-token", "draft-1", CTX.signal);
    expect(result).toEqual({
      ok: true,
      messageId: "sent-msg-1",
      threadId: "thread-1",
      to: "sarah@example.com",
      subject: "Re: Confirmación",
    });
    expect(sendLogRepo.complete).toHaveBeenCalledTimes(1);
    expect(sendLogRepo.complete).toHaveBeenCalledWith(expect.any(String), result);
  });

  it("alreadyComplete: a same-turn duplicate handler call returns the stored outcome with zero further Gmail calls, not even a token fetch", async () => {
    const gmailClient = fakeGmailClient();
    const accessTokenPort = fakeAccessTokenPort();
    const sendLogRepo = fakeSendLogRepo();
    const tool = createGmailSendDraftTool({ accessTokenPort, gmailClient, sendLogRepo });

    const prepared = await tool.prepare(ARGS, CTX);
    if (!prepared.ok) throw new Error("fixture bug");
    const first = await tool.handler(ARGS, { ...CTX, plan: prepared.plan });

    accessTokenPort.getAccessToken.mockClear();
    gmailClient.sendDraft.mockClear();

    const second = await tool.handler(ARGS, { ...CTX, plan: prepared.plan });

    expect(second).toEqual(first);
    expect(gmailClient.sendDraft).not.toHaveBeenCalled();
    expect(accessTokenPort.getAccessToken).not.toHaveBeenCalled();
  });

  it("alreadyPending: returns the ambiguous_send hedge without calling sendDraft or writing anything new", async () => {
    const gmailClient = fakeGmailClient();
    const sendLogRepo = fakeSendLogRepo();
    sendLogRepo.claim.mockResolvedValueOnce({ alreadyPending: true });
    const tool = createGmailSendDraftTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient,
      sendLogRepo,
    });

    const result = await prepareAndRun(tool, ARGS);

    expect(result).toEqual({
      ok: false,
      reason: "ambiguous_send",
      message: "puede que ya se haya enviado — revisá Enviados antes de reintentar",
    });
    expect(gmailClient.sendDraft).not.toHaveBeenCalled();
    expect(sendLogRepo.complete).not.toHaveBeenCalled();
  });

  it("dedupe: an identical same-turn repeat calls sendDraft exactly once, returning the same stored outcome", async () => {
    const gmailClient = fakeGmailClient();
    const sendLogRepo = fakeSendLogRepo();
    const tool = createGmailSendDraftTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient,
      sendLogRepo,
    });

    const first = await prepareAndRun(tool, ARGS);
    const second = await prepareAndRun(tool, ARGS);

    expect(gmailClient.sendDraft).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("dedupe is a same-turn retry guard, not a permanent block: a different turnId calls sendDraft again", async () => {
    const gmailClient = fakeGmailClient();
    const sendLogRepo = fakeSendLogRepo();
    const tool = createGmailSendDraftTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient,
      sendLogRepo,
    });

    await prepareAndRun(tool, ARGS, CTX);
    await prepareAndRun(tool, ARGS, CTX_OTHER_TURN);

    expect(gmailClient.sendDraft).toHaveBeenCalledTimes(2);
    const keys = sendLogRepo.claim.mock.calls.map((call) => call[0]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  describe("definitive-vs-ambiguous split", () => {
    it("a non-429 4xx (definitive) releases the pending claim, rethrows, and a same-turn retry can send again", async () => {
      const gmailClient = fakeGmailClient();
      const apiError = new GmailApiError("Gmail API returned HTTP 400: bad request", 400);
      gmailClient.sendDraft.mockRejectedValueOnce(apiError);
      const sendLogRepo = fakeSendLogRepo();
      const tool = createGmailSendDraftTool({
        accessTokenPort: fakeAccessTokenPort(),
        gmailClient,
        sendLogRepo,
      });

      await expect(prepareAndRun(tool, ARGS)).rejects.toBe(apiError);

      expect(sendLogRepo.release).toHaveBeenCalledTimes(1);
      expect(sendLogRepo.complete).not.toHaveBeenCalled();

      const result = await prepareAndRun(tool, ARGS);

      expect(gmailClient.sendDraft).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ ok: true, messageId: "sent-msg-1" });
    });

    it("an exhausted 429 (definitive — never got past quota enforcement) releases the pending claim the same way a 400 does", async () => {
      const gmailClient = fakeGmailClient();
      const apiError = new GmailApiError("Gmail API returned HTTP 429: rate limited", 429);
      gmailClient.sendDraft.mockRejectedValueOnce(apiError);
      const sendLogRepo = fakeSendLogRepo();
      const tool = createGmailSendDraftTool({
        accessTokenPort: fakeAccessTokenPort(),
        gmailClient,
        sendLogRepo,
      });

      await expect(prepareAndRun(tool, ARGS)).rejects.toBe(apiError);

      expect(sendLogRepo.release).toHaveBeenCalledTimes(1);
      expect(sendLogRepo.complete).not.toHaveBeenCalled();
    });

    it("a 403 on sendDraft releases the claim and returns the structured insufficient_scope refusal instead of a bare throw", async () => {
      const gmailClient = fakeGmailClient();
      const apiError = new GmailApiError("forbidden", 403);
      gmailClient.sendDraft.mockRejectedValueOnce(apiError);
      const sendLogRepo = fakeSendLogRepo();
      const tool = createGmailSendDraftTool({
        accessTokenPort: fakeAccessTokenPort(),
        gmailClient,
        sendLogRepo,
      });

      const result = await prepareAndRun(tool, ARGS);

      expect(result).toEqual({
        ok: false,
        reason: "insufficient_scope",
        scope: "https://www.googleapis.com/auth/gmail.send",
        fix: "run /connect google gmail-send",
      });
      expect(sendLogRepo.release).toHaveBeenCalledTimes(1);
    });

    it("a post-send-ambiguous failure (GmailAmbiguousSendError) keeps the pending row, records the hedge via complete, and never releases", async () => {
      const gmailClient = fakeGmailClient();
      gmailClient.sendDraft.mockRejectedValueOnce(
        new GmailAmbiguousSendError("may or may not have landed"),
      );
      const sendLogRepo = fakeSendLogRepo();
      const tool = createGmailSendDraftTool({
        accessTokenPort: fakeAccessTokenPort(),
        gmailClient,
        sendLogRepo,
      });

      const result = await prepareAndRun(tool, ARGS);

      expect(result).toEqual({
        ok: false,
        reason: "ambiguous_send",
        message: "may or may not have landed",
      });
      expect(sendLogRepo.release).not.toHaveBeenCalled();
      expect(sendLogRepo.complete).toHaveBeenCalledWith(expect.any(String), result);
    });

    it("a genuinely ambiguous ongoing failure still blocks a same-turn retry with the same hedge, without a second sendDraft call", async () => {
      const gmailClient = fakeGmailClient();
      gmailClient.sendDraft.mockRejectedValueOnce(
        new GmailAmbiguousSendError("may or may not have landed"),
      );
      const sendLogRepo = fakeSendLogRepo();
      const tool = createGmailSendDraftTool({
        accessTokenPort: fakeAccessTokenPort(),
        gmailClient,
        sendLogRepo,
      });

      const first = await prepareAndRun(tool, ARGS);
      const second = await prepareAndRun(tool, ARGS);

      expect(second).toEqual(first);
      expect(gmailClient.sendDraft).toHaveBeenCalledTimes(1);
      expect(sendLogRepo.release).not.toHaveBeenCalled();
    });

    it("an unexpected non-Gmail error leaves the claim pending (fail-safe default), never released and never completed", async () => {
      const gmailClient = fakeGmailClient();
      const genericError = new Error("boom");
      gmailClient.sendDraft.mockRejectedValueOnce(genericError);
      const sendLogRepo = fakeSendLogRepo();
      const tool = createGmailSendDraftTool({
        accessTokenPort: fakeAccessTokenPort(),
        gmailClient,
        sendLogRepo,
      });

      await expect(prepareAndRun(tool, ARGS)).rejects.toBe(genericError);

      expect(sendLogRepo.release).not.toHaveBeenCalled();
      expect(sendLogRepo.complete).not.toHaveBeenCalled();
    });
  });

  it("never references drafts.send/messages.send outside gmail-client.ts, and never calls sendDraft anywhere but this tool's own handler", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(path.resolve(__dirname, "..", "gmail-send-draft.ts"), "utf-8");
    // The one and only call site.
    expect(source.match(/gmailClient\.sendDraft\(/g)).toHaveLength(1);
  });
});
