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

/** Never resolves — freezes the poll loop once a test has captured the calls it needs. */
function pendingForever(): Promise<TelegramUpdate[]> {
  return new Promise(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTelegramPoller — offset persistence ordering", () => {
  it("calls offsetRepo.setOffset only after the handler resolves for the update", async () => {
    const update = makeUpdate(40);
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
    const handler = vi.fn().mockReturnValue(handlerPromise);

    const setOffset = vi.fn().mockResolvedValue(undefined);
    const offsetRepo: TelegramOffsetRepo = {
      getOffset: vi.fn().mockResolvedValue(0),
      setOffset,
    };

    createTelegramPoller({ client, logger, offsetRepo }).subscribe(handler);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    // Handler is still pending: the offset must not have been persisted yet.
    expect(setOffset).not.toHaveBeenCalled();

    resolveHandler();

    await vi.waitFor(() => expect(setOffset).toHaveBeenCalledTimes(1));
    expect(setOffset).toHaveBeenCalledWith(41);
  });

  it("does not advance the persisted offset past an update whose handler throws", async () => {
    const update = makeUpdate(50);
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
    const handler = vi.fn().mockRejectedValue(new Error("boom"));

    const setOffset = vi.fn().mockResolvedValue(undefined);
    const offsetRepo: TelegramOffsetRepo = {
      getOffset: vi.fn().mockResolvedValue(0),
      setOffset,
    };

    createTelegramPoller({ client, logger, offsetRepo, retryDelayMs: 1 }).subscribe(handler);

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(setOffset).not.toHaveBeenCalled();
  });
});
