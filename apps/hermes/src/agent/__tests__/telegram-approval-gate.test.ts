import type { ApprovalRequest } from "@hermes/agent";
import type { InboundCallback, TelegramPoller } from "@hermes/channels";
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
  await channel.send.mock.results[0]!.value;
}

afterEach(() => {
  vi.useRealTimers();
});

const BATCH: ApprovalRequest[] = [{ tool: "echo", args: { text: "hi" } }];
const CONTEXT = { threadId: "thread-1", turnId: "turn-1" };

describe("createTelegramApprovalGate — combined batch prompt", () => {
  it("sends one message with Approve/Deny buttons naming every gated call in a multi-call batch", async () => {
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555");
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
        { label: "Approve", callbackData: expect.stringContaining(":approve") },
        { label: "Deny", callbackData: expect.stringContaining(":deny") },
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
    const gate = createTelegramApprovalGate(channel, () => "555");
    const decisionPromise = gate.requestApproval(BATCH, CONTEXT, new AbortController().signal);
    await waitForPromptSent(channel);
    const approvalId = extractApprovalId(channel.send);

    await gate.handleCallback(makeCallback(approvalId, "approve"));

    expect(await decisionPromise).toBe("approved");
    expect(channel.answerCallback).toHaveBeenCalledWith("cbq-1", expect.stringContaining("Approved"));
    expect(channel.editMessage).toHaveBeenCalledWith(
      "555",
      "msg-1",
      expect.stringContaining("Approved"),
    );
  });

  it("resolves 'denied' on a matching Deny tap and edits the message to a resolved state", async () => {
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555");
    const decisionPromise = gate.requestApproval(BATCH, CONTEXT, new AbortController().signal);
    await waitForPromptSent(channel);
    const approvalId = extractApprovalId(channel.send);

    await gate.handleCallback(makeCallback(approvalId, "deny"));

    expect(await decisionPromise).toBe("denied");
    expect(channel.answerCallback).toHaveBeenCalledWith("cbq-1", expect.stringContaining("Denied"));
  });
});

describe("createTelegramApprovalGate — unknown, already-resolved, or post-restart callbacks", () => {
  it("answers an unknown approval id with the expiry text, never resolving or executing anything", async () => {
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555");

    await gate.handleCallback(makeCallback("no-such-id", "approve"));

    expect(channel.answerCallback).toHaveBeenCalledWith(
      "cbq-1",
      "this approval has expired, please ask again",
    );
    expect(channel.editMessage).not.toHaveBeenCalled();
  });

  it("answers a second tap against an already-resolved approval with the same expiry text, not a second resolution", async () => {
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555");
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
      "this approval has expired, please ask again",
    );
    // The second tap resolves nothing further — no second edit either.
    expect(channel.editMessage).not.toHaveBeenCalled();
  });
});

describe("createTelegramApprovalGate — timeout", () => {
  it("resolves 'denied' via fake timers once timeoutMs elapses, never a real 5-minute wait, and edits the message", async () => {
    vi.useFakeTimers();
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555", 1_000);

    const decisionPromise = gate.requestApproval(BATCH, CONTEXT, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(await decisionPromise).toBe("denied");
    expect(channel.editMessage).toHaveBeenCalledWith(
      "555",
      "msg-1",
      expect.stringContaining("Denied"),
    );
  });

  it("a stale callback arriving immediately after the timer fires still gets the expiry reply, not a second resolution", async () => {
    vi.useFakeTimers();
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555", 1_000);

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
      "this approval has expired, please ask again",
    );
  });
});

describe("createTelegramApprovalGate — abort mid-wait", () => {
  it("resolves 'denied' immediately when the signal aborts, without advancing fake timers, and skips the edit", async () => {
    vi.useFakeTimers();
    const channel = fakeChannel();
    const gate = createTelegramApprovalGate(channel, () => "555");
    const controller = new AbortController();

    const decisionPromise = gate.requestApproval(BATCH, CONTEXT, controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(await decisionPromise).toBe("denied");
    expect(channel.editMessage).not.toHaveBeenCalled();
  });
});
