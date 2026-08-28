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

afterEach(() => {
  vi.restoreAllMocks();
});

// This file's guarantee — offset persisted only once the handler has
// actually resolved — used to hold for every update kind. It's now
// callback-only: a message update's offset advances immediately, without
// waiting on its handler (see poller-crash-replay.test.ts and
// packages/channels/README.md for the deadlock that forced the narrowing).
// callback_query stays on the old, stricter contract because its handler
// (the approval gate acking a tap) is fast and its replay-on-crash behavior
// is still load-bearing.
describe("createTelegramPoller — offset persistence ordering (callback_query)", () => {
  it("calls offsetRepo.setOffset only after the callback handler resolves for the update", async () => {
    const update = makeCallbackUpdate(40);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update])
      .mockImplementation(() => pendingForever());
    const client: TelegramClient = {
      getUpdates,
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
    };
    const logger = createMockLogger();

    let resolveHandler: () => void = () => {};
    const handlerPromise = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });
    const callbackHandler = vi.fn().mockReturnValue(handlerPromise);

    const setOffset = vi.fn().mockResolvedValue(undefined);
    const offsetRepo: TelegramOffsetRepo = {
      getOffset: vi.fn().mockResolvedValue(0),
      setOffset,
    };

    const poller = createTelegramPoller({ client, logger, offsetRepo });
    poller.subscribe(vi.fn());
    poller.subscribeCallback(callbackHandler);

    await vi.waitFor(() => expect(callbackHandler).toHaveBeenCalledTimes(1));

    // Handler is still pending: the offset must not have been persisted yet.
    expect(setOffset).not.toHaveBeenCalled();

    resolveHandler();

    await vi.waitFor(() => expect(setOffset).toHaveBeenCalledTimes(1));
    expect(setOffset).toHaveBeenCalledWith(41);
  });

  it("does not advance the persisted offset past a callback_query update whose handler throws", async () => {
    const update = makeCallbackUpdate(50);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update])
      .mockImplementation(() => pendingForever());
    const client: TelegramClient = {
      getUpdates,
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
    };
    const logger = createMockLogger();
    const callbackHandler = vi.fn().mockRejectedValue(new Error("boom"));

    const setOffset = vi.fn().mockResolvedValue(undefined);
    const offsetRepo: TelegramOffsetRepo = {
      getOffset: vi.fn().mockResolvedValue(0),
      setOffset,
    };

    const poller = createTelegramPoller({ client, logger, offsetRepo, retryDelayMs: 1 });
    poller.subscribe(vi.fn());
    poller.subscribeCallback(callbackHandler);

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));

    expect(callbackHandler).toHaveBeenCalledTimes(1);
    expect(setOffset).not.toHaveBeenCalled();
  });
});
