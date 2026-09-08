import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import { GmailApiError } from "../../gmail-client";
import type { GmailClient, GmailLabel, GmailThread } from "../../gmail-client";
import { type GmailLabelPlan, createGmailLabelTool } from "../gmail-label";
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

const LABELS: GmailLabel[] = [
  { id: "Label_1", name: "Trabajo" },
  { id: "Label_2", name: "Personal" },
];

function fakeGmailClient(overrides: Partial<GmailClient> = {}): GmailClient {
  return {
    listMessages: vi.fn(),
    getMessageMetadata: vi.fn(),
    getMessageFull: vi.fn(),
    getThread: vi.fn().mockResolvedValue(THREAD),
    modifyMessage: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue(LABELS),
    ...overrides,
  } as GmailClient;
}

function fakeAccessTokenPort(): AccessTokenPort {
  return { getAccessToken: vi.fn().mockResolvedValue("secret-token") };
}

describe("createGmailLabelTool", () => {
  it("requiresApproval is true, declares a prepare hook, and timeoutMs is 30_000", () => {
    const tool = createGmailLabelTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
    });

    expect(tool.requiresApproval).toBe(true);
    expect(typeof tool.prepare).toBe("function");
    expect(tool.timeoutMs).toBe(30_000);
  });

  it("schema is a flat object with an enum field, action defaulting to 'add'", () => {
    const tool = createGmailLabelTool({
      accessTokenPort: fakeAccessTokenPort(),
      gmailClient: fakeGmailClient(),
    });

    expect(tool.schema.parse({ threadId: "t1", label: "Trabajo" })).toEqual({
      threadId: "t1",
      label: "Trabajo",
      action: "add",
    });
    expect(tool.schema.parse({ threadId: "t1", label: "Trabajo", action: "remove" })).toEqual({
      threadId: "t1",
      label: "Trabajo",
      action: "remove",
    });
    expect(() =>
      tool.schema.parse({ threadId: "t1", label: "Trabajo", action: "bogus" }),
    ).toThrow();
  });

  it("resolves a label name to its id and builds an 'add' summary distinct from 'remove'", async () => {
    const gmailClient = fakeGmailClient();
    const tool = createGmailLabelTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const addResult = (await tool.prepare?.(
      { threadId: "thread-1", label: "Trabajo", action: "add" },
      CTX,
    )) as { ok: true; plan: GmailLabelPlan; summary: { action: string; effects: string[] } };
    const removeResult = (await tool.prepare?.(
      { threadId: "thread-1", label: "Trabajo", action: "remove" },
      CTX,
    )) as { ok: true; plan: GmailLabelPlan; summary: { action: string; effects: string[] } };

    expect(addResult.plan).toEqual({
      threadId: "thread-1",
      messageId: "msg-new",
      labelId: "Label_1",
      labelName: "Trabajo",
      action: "add",
    });
    expect(addResult.summary).toEqual({
      action: '¿Ponerle la etiqueta "Trabajo" a esta conversación?',
      effects: ['Se agrega la etiqueta "Trabajo".'],
    });
    expect(removeResult.plan.action).toBe("remove");
    expect(removeResult.summary).toEqual({
      action: '¿Sacarle la etiqueta "Trabajo" a esta conversación?',
      effects: ['Se quita la etiqueta "Trabajo".'],
    });
    expect(addResult.summary).not.toEqual(removeResult.summary);
  });

  it("an unknown label refuses pre-prompt, listing every available label, and modifyMessage is never called", async () => {
    const gmailClient = fakeGmailClient();
    const tool = createGmailLabelTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.prepare?.({ threadId: "thread-1", label: "Nonexistent" }, CTX);

    expect(result).toEqual({
      ok: false,
      result: { ok: false, reason: "unknown_label", available: ["Trabajo", "Personal"] },
    });
    expect(gmailClient.modifyMessage).not.toHaveBeenCalled();
  });

  it("a missing thread refuses pre-prompt with thread_not_found", async () => {
    const gmailClient = fakeGmailClient({
      getThread: vi.fn().mockRejectedValue(new GmailApiError("not found", 404)),
    });
    const tool = createGmailLabelTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.prepare?.({ threadId: "missing-thread", label: "Trabajo" }, CTX);

    expect(result).toEqual({ ok: false, result: { ok: false, reason: "thread_not_found" } });
  });

  it("prepare surfaces a 403 as the structured insufficient_scope refusal, not a throw", async () => {
    const gmailClient = fakeGmailClient({
      listLabels: vi.fn().mockRejectedValue(new GmailApiError("forbidden", 403)),
    });
    const tool = createGmailLabelTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });

    const result = await tool.prepare?.({ threadId: "thread-1", label: "Trabajo" }, CTX);

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

  it("handler applies the resolved id from ctx.plan: 'add' calls modifyMessage with addLabelIds, 'remove' with removeLabelIds — distinct payloads", async () => {
    const gmailClient = fakeGmailClient();
    const tool = createGmailLabelTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });
    const addPlan: GmailLabelPlan = {
      threadId: "thread-1",
      messageId: "msg-new",
      labelId: "Label_1",
      labelName: "Trabajo",
      action: "add",
    };
    const removePlan: GmailLabelPlan = { ...addPlan, action: "remove" };

    const addResult = await tool.handler({}, { ...CTX, plan: addPlan });
    const removeResult = await tool.handler({}, { ...CTX, plan: removePlan });

    expect(addResult).toEqual({ ok: true, threadId: "thread-1", label: "Trabajo", action: "add" });
    expect(removeResult).toEqual({
      ok: true,
      threadId: "thread-1",
      label: "Trabajo",
      action: "remove",
    });
    expect(gmailClient.modifyMessage).toHaveBeenNthCalledWith(
      1,
      "secret-token",
      "msg-new",
      { addLabelIds: ["Label_1"] },
      CTX.signal,
    );
    expect(gmailClient.modifyMessage).toHaveBeenNthCalledWith(
      2,
      "secret-token",
      "msg-new",
      { removeLabelIds: ["Label_1"] },
      CTX.signal,
    );
    expect(gmailClient.getThread).not.toHaveBeenCalled();
    expect(gmailClient.listLabels).not.toHaveBeenCalled();
  });

  it("handler surfaces a 403 on modifyMessage as the structured insufficient_scope refusal, not a throw", async () => {
    const gmailClient = fakeGmailClient({
      modifyMessage: vi.fn().mockRejectedValue(new GmailApiError("forbidden", 403)),
    });
    const tool = createGmailLabelTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });
    const plan: GmailLabelPlan = {
      threadId: "thread-1",
      messageId: "msg-new",
      labelId: "Label_1",
      labelName: "Trabajo",
      action: "add",
    };

    const result = await tool.handler({}, { ...CTX, plan });

    expect(result).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scope: "https://www.googleapis.com/auth/gmail.modify",
      fix: "run /connect google gmail-send",
    });
  });

  it("re-adding an already-present label is a harmless no-op: calling the handler twice with the same plan succeeds both times with one call each to modifyMessage", async () => {
    const gmailClient = fakeGmailClient();
    const tool = createGmailLabelTool({ accessTokenPort: fakeAccessTokenPort(), gmailClient });
    const plan: GmailLabelPlan = {
      threadId: "thread-1",
      messageId: "msg-new",
      labelId: "Label_1",
      labelName: "Trabajo",
      action: "add",
    };

    const first = await tool.handler({}, { ...CTX, plan });
    const second = await tool.handler({}, { ...CTX, plan });

    expect(first).toEqual({ ok: true, threadId: "thread-1", label: "Trabajo", action: "add" });
    expect(second).toEqual({ ok: true, threadId: "thread-1", label: "Trabajo", action: "add" });
    expect(gmailClient.modifyMessage).toHaveBeenCalledTimes(2);
  });
});
