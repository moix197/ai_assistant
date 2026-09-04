import type { Logger } from "@hermes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramClient, TelegramUpdate } from "../client";
import { type TelegramOffsetRepo, createTelegramPoller } from "../poller";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeUpdate(updateId: number, userId = 111): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false },
      chat: { id: 555, type: "private" },
      date: 0,
      text: `text-${updateId}`,
    },
  };
}

function makeCallbackUpdate(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: 111, is_bot: false },
      message: {
        message_id: 7,
        chat: { id: 555, type: "private" },
        date: 0,
      },
      data: "approval-1:approve",
    },
  };
}

/** Never resolves — freezes the poll loop once a test has captured the calls it needs. */
function pendingForever(): Promise<TelegramUpdate[]> {
  return new Promise(() => {});
}

function makeClient(getUpdates: TelegramClient["getUpdates"]): TelegramClient {
  return {
    getUpdates,
    sendMessage: vi.fn(),
    deleteWebhook: vi.fn(),
    answerCallbackQuery: vi.fn(),
    editMessageText: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// This file pins the one real double-charge race this PRD phase closes: a
// message update's offset must be persisted BEFORE its handler is dispatched
// at all, not merely before the handler settles (that weaker ordering is
// what poller-offset-ordering.test.ts and poller-crash-replay.test.ts already
// cover for callback_query, and what used to hold — wrongly, for the
// double-charge case — for message updates too). See packages/channels/README.md.
describe("createTelegramPoller — ack before dispatch (message updates)", () => {
  it("never calls the message handler when offsetRepo.setOffset rejects", async () => {
    const update = makeUpdate(100);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update])
      .mockImplementation(() => pendingForever());
    const client = makeClient(getUpdates);
    const logger = createMockLogger();
    const handler = vi.fn().mockResolvedValue(undefined);
    const setOffset = vi.fn().mockRejectedValueOnce(new Error("simulated setOffset failure"));

    createTelegramPoller({
      client,
      logger,
      offsetRepo: { getOffset: vi.fn().mockResolvedValue(0), setOffset },
      retryDelayMs: 1,
    }).subscribe(handler);

    // Wait for the batch-abort path (see poller.ts's shared catch) to have
    // run and issued its retry getUpdates call, proving setOffset's
    // rejection was already observed before asserting the handler's call
    // count.
    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));

    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches the handler exactly once when the un-acked update is redelivered", async () => {
    const update = makeUpdate(101);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update]) // setOffset rejects for this delivery
      .mockResolvedValueOnce([update]) // Telegram redelivers the same, still-un-acked update
      .mockImplementation(() => pendingForever());
    const client = makeClient(getUpdates);
    const logger = createMockLogger();
    const handler = vi.fn().mockResolvedValue(undefined);
    const setOffset = vi
      .fn()
      .mockRejectedValueOnce(new Error("simulated setOffset failure"))
      .mockResolvedValue(undefined);

    createTelegramPoller({
      client,
      logger,
      offsetRepo: { getOffset: vi.fn().mockResolvedValue(0), setOffset },
      retryDelayMs: 1,
    }).subscribe(handler);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: "text-101" }));
    expect(setOffset).toHaveBeenCalledTimes(2);
    expect(setOffset).toHaveBeenNthCalledWith(2, 102);
  });

  it("resolves setOffset fully before the handler's first call, on the success path", async () => {
    const update = makeUpdate(102);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update])
      .mockImplementation(() => pendingForever());
    const client = makeClient(getUpdates);
    const logger = createMockLogger();

    const order: string[] = [];
    const handler = vi.fn().mockImplementation(async () => {
      order.push("handler");
    });
    const setOffset = vi.fn().mockImplementation(async () => {
      order.push("setOffset");
    });

    createTelegramPoller({
      client,
      logger,
      offsetRepo: { getOffset: vi.fn().mockResolvedValue(0), setOffset },
    }).subscribe(handler);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    expect(order).toEqual(["setOffset", "handler"]);
  });

  it("regression guard: a callback_query update still calls handleCallback before setOffset", async () => {
    const update = makeCallbackUpdate(103);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update])
      .mockImplementation(() => pendingForever());
    const client = makeClient(getUpdates);
    const logger = createMockLogger();

    const order: string[] = [];
    const callbackHandler = vi.fn().mockImplementation(async () => {
      order.push("handleCallback");
    });
    const setOffset = vi.fn().mockImplementation(async () => {
      order.push("setOffset");
    });

    const poller = createTelegramPoller({
      client,
      logger,
      offsetRepo: { getOffset: vi.fn().mockResolvedValue(0), setOffset },
    });
    poller.subscribe(vi.fn());
    poller.subscribeCallback(callbackHandler);

    await vi.waitFor(() => expect(callbackHandler).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(setOffset).toHaveBeenCalledTimes(1));

    expect(order).toEqual(["handleCallback", "setOffset"]);
  });

  it("dispatches neither update's handler when the first update's setOffset rejects in a batch", async () => {
    const first = makeUpdate(104);
    const second = makeUpdate(105);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([first, second])
      .mockImplementation(() => pendingForever());
    const client = makeClient(getUpdates);
    const logger = createMockLogger();
    const handler = vi.fn().mockResolvedValue(undefined);
    const setOffset = vi.fn().mockRejectedValueOnce(new Error("simulated setOffset failure"));

    createTelegramPoller({
      client,
      logger,
      offsetRepo: { getOffset: vi.fn().mockResolvedValue(0), setOffset },
      retryDelayMs: 1,
    }).subscribe(handler);

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));

    expect(handler).not.toHaveBeenCalled();
  });
});
