import type { ApprovalRequest } from "@hermes/agent";
import type { InboundCallback, TelegramPoller } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramApprovalGate } from "../telegram-approval-gate";

function fakeChannel(): TelegramPoller & {
  send: ReturnType<typeof vi.fn>;
  editMessage: ReturnType<typeof vi.fn>;
  answerCallback: ReturnType<typeof vi.fn>;
} {
  return {
    capabilities: { markdown: true, files: true, buttons: true, maxMessageLength: 4096 },
    subscribe: vi.fn(),
    subscribeCallback: vi.fn(),
    send: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    answerCallback: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeLogger(): Logger & { debug: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Recovers the generated approval id from the buttons `channel.send` was called with. */
function extractApprovalId(sendMock: ReturnType<typeof vi.fn>): string {
  const options = sendMock.mock.calls[0]?.[2] as {
    buttons: { label: string; callbackData: string }[][];
  };
  const raw = options.buttons[0]?.[0]?.callbackData ?? "";
  return raw.slice(0, raw.lastIndexOf(":"));
}

function makeCallback(approvalId: string, action: "approve" | "deny"): InboundCallback {
  return {
    callbackId: "cbq-1",
    callbackData: `${approvalId}:${action}`,
    chatId: "555",
    messageId: "msg-1",
    channelUserId: "111",
  };
}

/** Waits for `requestApproval`'s internal `pending.set(...)` to have run — see the ordering note below. */
async function waitForPromptSent(channel: { send: ReturnType<typeof vi.fn> }): Promise<void> {
  // `requestApproval` registers its own continuation on this exact promise
  // before this line runs, so awaiting it here guarantees that continuation
  // (which synchronously calls `pending.set`) has already executed by the
  // time this resolves — same-promise `.then()` callbacks fire in
  // registration order.
  const sendResult = channel.send.mock.results[0];
  if (!sendResult) {
    throw new Error("expected channel.send to have been called before waitForPromptSent");
  }
  await sendResult.value;
}

afterEach(() => {
  vi.useRealTimers();
});

const BATCH: ApprovalRequest[] = [{ tool: "echo", args: { text: "hi" } }];
const CONTEXT = { threadId: "thread-1", turnId: "turn-1" };

describe("createTelegramApprovalGate — combined batch prompt", () => {
  it("sends one message with Approve/Deny buttons naming every gated call in a multi-call batch", async () => {
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555", fakeLogger());
    const batch: ApprovalRequest[] = [
      { tool: "echo", args: { text: "hi" } },
      { tool: "echo", args: { text: "bye" } },
    ];

    const decisionPromise = gate.requestApproval(batch, CONTEXT, new AbortController().signal);
    await waitForPromptSent(channel);

    expect(channel.send).toHaveBeenCalledTimes(1);
    const [target, text, options] = channel.send.mock.calls[0] as [
      string,
      string,
      { buttons: { label: string; callbackData: string }[][] },
    ];
    expect(target).toBe("555");
    expect(text).toContain('echo({"text":"hi"})');
    expect(text).toContain('echo({"text":"bye"})');
    expect(options.buttons).toEqual([
      [
        { label: "Aprobar", callbackData: expect.stringContaining(":approve") },
        { label: "Rechazar", callbackData: expect.stringContaining(":deny") },
      ],
    ]);

    // Resolve it so the test doesn't leave a dangling pending promise.
    await gate.handleCallback(makeCallback(extractApprovalId(channel.send), "approve"));
    await expect(decisionPromise).resolves.toBe("approved");
  });
});

describe("createTelegramApprovalGate — resolution via tap", () => {
  it("resolves 'approved' on a matching Approve tap and edits the message to a resolved state", async () => {
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555", fakeLogger());
    const decisionPromise = gate.requestApproval(BATCH, CONTEXT, new AbortController().signal);
    await waitForPromptSent(channel);
    const approvalId = extractApprovalId(channel.send);

    await gate.handleCallback(makeCallback(approvalId, "approve"));

    expect(await decisionPromise).toBe("approved");
    expect(channel.answerCallback).toHaveBeenCalledWith(
      "cbq-1",
      expect.stringContaining("Aprobado"),
    );
    expect(channel.editMessage).toHaveBeenCalledWith(
      "555",
      "msg-1",
      expect.stringContaining("Aprobado"),
    );
    // handleCallback is the sole owner of the edit on a tap — requestApproval
    // must not also edit once it wakes up from the resolved promise.
    expect(channel.editMessage).toHaveBeenCalledTimes(1);
  });

  it("resolves 'denied' on a matching Deny tap and edits the message to a resolved state", async () => {
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555", fakeLogger());
    const decisionPromise = gate.requestApproval(BATCH, CONTEXT, new AbortController().signal);
    await waitForPromptSent(channel);
    const approvalId = extractApprovalId(channel.send);

    await gate.handleCallback(makeCallback(approvalId, "deny"));

    expect(await decisionPromise).toBe("denied");
    expect(channel.answerCallback).toHaveBeenCalledWith(
      "cbq-1",
      expect.stringContaining("Rechazado"),
    );
    expect(channel.editMessage).toHaveBeenCalledWith(
      "555",
      "msg-1",
      expect.stringContaining("Rechazado"),
    );
    // Same single-owner invariant as the approve case above.
    expect(channel.editMessage).toHaveBeenCalledTimes(1);
  });
});

describe("createTelegramApprovalGate — unknown, already-resolved, or post-restart callbacks", () => {
  it("answers an unknown approval id with the expiry text, never resolving or executing anything", async () => {
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555", fakeLogger());

    await gate.handleCallback(makeCallback("no-such-id", "approve"));

    expect(channel.answerCallback).toHaveBeenCalledWith(
      "cbq-1",
      "esta aprobación ya expiró, pídelo de nuevo",
    );
    expect(channel.editMessage).not.toHaveBeenCalled();
  });

  it("answers a second tap against an already-resolved approval with the same expiry text, not a second resolution", async () => {
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555", fakeLogger());
    const decisionPromise = gate.requestApproval(BATCH, CONTEXT, new AbortController().signal);
    await waitForPromptSent(channel);
    const approvalId = extractApprovalId(channel.send);

    await gate.handleCallback(makeCallback(approvalId, "approve"));
    expect(await decisionPromise).toBe("approved");

    channel.answerCallback.mockClear();
    channel.editMessage.mockClear();
    await gate.handleCallback(makeCallback(approvalId, "deny"));

    expect(channel.answerCallback).toHaveBeenCalledWith(
      "cbq-1",
      "esta aprobación ya expiró, pídelo de nuevo",
    );
    // The second tap resolves nothing further — no second edit either.
    expect(channel.editMessage).not.toHaveBeenCalled();
  });
});

describe("createTelegramApprovalGate — timeout", () => {
  it("resolves 'denied' via fake timers once timeoutMs elapses, never a real 5-minute wait, and edits the message", async () => {
    vi.useFakeTimers();
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555", fakeLogger(), 1_000);

    const decisionPromise = gate.requestApproval(BATCH, CONTEXT, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(await decisionPromise).toBe("denied");
    expect(channel.editMessage).toHaveBeenCalledWith(
      "555",
      "msg-1",
      expect.stringContaining("Rechazado"),
    );
  });

  it("a stale callback arriving immediately after the timer fires still gets the expiry reply, not a second resolution", async () => {
    vi.useFakeTimers();
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555", fakeLogger(), 1_000);

    const decisionPromise = gate.requestApproval(BATCH, CONTEXT, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    const approvalId = extractApprovalId(channel.send);

    await vi.advanceTimersByTimeAsync(1_000);
    // Dispatched right after the timer fired — the map entry must already be
    // gone (deleted synchronously, before the timer's own editMessage awaits).
    await gate.handleCallback(makeCallback(approvalId, "approve"));

    expect(await decisionPromise).toBe("denied");
    expect(channel.answerCallback).toHaveBeenCalledWith(
      "cbq-1",
      "esta aprobación ya expiró, pídelo de nuevo",
    );
  });
});

describe("createTelegramApprovalGate — prepared-batch debug logging (06-legible-approvals-bounded-reads Phase 3)", () => {
  it("logs each ready call's tool/args/plan at debug level right before sending the prompt", async () => {
    const channel = fakeChannel();
    const logger = fakeLogger();
    const gate = createTelegramApprovalGate(channel, () => "555", logger);
    const batch: ApprovalRequest[] = [
      {
        tool: "sheets_write",
        args: { mode: "append", sheet: "clients" },
        plan: {
          sheetSlug: "clients",
          spreadsheetId: "sheet-123",
          effectiveValueInputOption: "USER_ENTERED",
        },
        summary: { action: "¿Escribir en clients?", effects: [] },
      },
    ];

    const decisionPromise = gate.requestApproval(batch, CONTEXT, new AbortController().signal);
    await waitForPromptSent(channel);

    expect(logger.debug).toHaveBeenCalledWith("approval prompt prepared", {
      tool: "sheets_write",
      args: { mode: "append", sheet: "clients" },
      plan: {
        sheetSlug: "clients",
        spreadsheetId: "sheet-123",
        effectiveValueInputOption: "USER_ENTERED",
      },
    });
    // Logged before the prompt is sent, not after.
    const debugOrder = logger.debug.mock.invocationCallOrder[0] as number;
    const sendOrder = channel.send.mock.invocationCallOrder[0] as number;
    expect(debugOrder).toBeLessThan(sendOrder);

    await gate.handleCallback(makeCallback(extractApprovalId(channel.send), "approve"));
    await decisionPromise;
  });

  it("never logs a plan field for a prepare-less call", async () => {
    const channel = fakeChannel();
    const logger = fakeLogger();
    const gate = createTelegramApprovalGate(channel, () => "555", logger);

    const decisionPromise = gate.requestApproval(BATCH, CONTEXT, new AbortController().signal);
    await waitForPromptSent(channel);

    expect(logger.debug).toHaveBeenCalledWith("approval prompt prepared", {
      tool: "echo",
      args: { text: "hi" },
      plan: undefined,
    });

    await gate.handleCallback(makeCallback(extractApprovalId(channel.send), "approve"));
    await decisionPromise;
  });
});

describe("createTelegramApprovalGate — post-restart describer (09-gmail-read-then-send Phase 5)", () => {
  it("an unknown callback id with a describer returning a string answers that string instead of the generic expiry text", async () => {
    const channel = fakeChannel();
    const describeExpiredApproval = vi
      .fn()
      .mockResolvedValue(
        "no se envió nada, el borrador sigue guardado — pedime «envialo» de nuevo",
      );
    const gate = createTelegramApprovalGate(
      channel,
      () => "555",
      fakeLogger(),
      undefined,
      describeExpiredApproval,
    );

    await gate.handleCallback(makeCallback("no-such-id", "approve"));

    expect(describeExpiredApproval).toHaveBeenCalledWith("telegram", "111");
    expect(channel.answerCallback).toHaveBeenCalledWith(
      "cbq-1",
      "no se envió nada, el borrador sigue guardado — pedime «envialo» de nuevo",
    );
  });

  it("no describer given answers the existing EXPIRED_CALLBACK_TEXT byte-identically", async () => {
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555", fakeLogger());

    await gate.handleCallback(makeCallback("no-such-id", "approve"));

    expect(channel.answerCallback).toHaveBeenCalledWith(
      "cbq-1",
      "esta aprobación ya expiró, pídelo de nuevo",
    );
  });

  it("a describer resolving to undefined (no matching intent found) falls back to EXPIRED_CALLBACK_TEXT byte-identically", async () => {
    const channel = fakeChannel();
    const describeExpiredApproval = vi.fn().mockResolvedValue(undefined);
    const gate = createTelegramApprovalGate(
      channel,
      () => "555",
      fakeLogger(),
      undefined,
      describeExpiredApproval,
    );

    await gate.handleCallback(makeCallback("no-such-id", "approve"));

    expect(channel.answerCallback).toHaveBeenCalledWith(
      "cbq-1",
      "esta aprobación ya expiró, pídelo de nuevo",
    );
  });

  it("a describer that throws (e.g. the DB is down) falls back to EXPIRED_CALLBACK_TEXT and never breaks the tap handler", async () => {
    const channel = fakeChannel();
    const describeExpiredApproval = vi.fn().mockRejectedValue(new Error("connection refused"));
    const gate = createTelegramApprovalGate(
      channel,
      () => "555",
      fakeLogger(),
      undefined,
      describeExpiredApproval,
    );

    await expect(
      gate.handleCallback(makeCallback("no-such-id", "approve")),
    ).resolves.toBeUndefined();

    expect(channel.answerCallback).toHaveBeenCalledWith(
      "cbq-1",
      "esta aprobación ya expiró, pídelo de nuevo",
    );
  });

  it("the describer's presence never causes a tool invocation or resolves a genuinely pending approval — it only answers the stale callback", async () => {
    const channel = fakeChannel();
    const describeExpiredApproval = vi.fn().mockResolvedValue("described text");
    const gate = createTelegramApprovalGate(
      channel,
      () => "555",
      fakeLogger(),
      undefined,
      describeExpiredApproval,
    );
    const decisionPromise = gate.requestApproval(BATCH, CONTEXT, new AbortController().signal);
    await waitForPromptSent(channel);
    const approvalId = extractApprovalId(channel.send);

    // A stale, unrelated callback id arrives while a real approval is still
    // genuinely pending — the describer must not touch that pending entry.
    await gate.handleCallback(makeCallback("some-other-id", "approve"));

    expect(describeExpiredApproval).toHaveBeenCalledTimes(1);
    expect(channel.answerCallback).toHaveBeenCalledWith("cbq-1", "described text");

    // The real pending approval is untouched — it still resolves normally.
    await gate.handleCallback(makeCallback(approvalId, "approve"));
    expect(await decisionPromise).toBe("approved");
  });
});

describe("createTelegramApprovalGate — abort mid-wait", () => {
  it("resolves 'denied' immediately when the signal aborts, without advancing fake timers, and skips the edit", async () => {
    vi.useFakeTimers();
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555", fakeLogger());
    const controller = new AbortController();

    const decisionPromise = gate.requestApproval(BATCH, CONTEXT, controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(await decisionPromise).toBe("denied");
    expect(channel.editMessage).not.toHaveBeenCalled();
  });
});
