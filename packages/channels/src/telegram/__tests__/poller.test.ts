import type { Logger } from "@hermes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramClient, TelegramUpdate } from "../client";
import { createTelegramPoller } from "../poller";

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

describe("createTelegramPoller — offset ordering", () => {
  it("advances the offset only after the handler resolves (happy path)", async () => {
    const update = makeUpdate(10);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update])
      .mockImplementation(() => pendingForever());
    const client: TelegramClient = { getUpdates, sendMessage: vi.fn() };
    const logger = createMockLogger();
    const handler = vi.fn().mockResolvedValue(undefined);

    createTelegramPoller({ client, logger }).subscribe(handler);

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ channelUserId: "111", text: "text-10" }),
    );
    // Second poll requests from the advanced offset — proves the offset only
    // moves past update 10 once its handler has resolved (plan dependency
    // note: "offset persisted after handling, not before").
    expect(getUpdates).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 11 }));
  });
});

describe("createTelegramPoller — handler failure", () => {
  it("does not advance the offset when the handler throws, and the loop survives to the next iteration", async () => {
    const update = makeUpdate(20);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update])
      .mockImplementation(() => pendingForever());
    const client: TelegramClient = { getUpdates, sendMessage: vi.fn() };
    const logger = createMockLogger();
    const handler = vi.fn().mockRejectedValue(new Error("transient send failure"));

    createTelegramPoller({ client, logger }).subscribe(handler);

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));

    expect(handler).toHaveBeenCalledTimes(1);
    // Second poll re-requests from the same (unadvanced) offset — update 20
    // is redelivered by Telegram rather than silently skipped, and the loop
    // is still running (a second getUpdates call happened at all).
    expect(getUpdates).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: undefined }));
    expect(logger.warn).toHaveBeenCalledWith(
      "handler failed, will retry this update",
      expect.objectContaining({ updateId: 20 }),
    );
  });

  it("stops processing the rest of a batch after a handler failure, instead of skipping past it", async () => {
    const first = makeUpdate(30);
    const second = makeUpdate(31);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([first, second])
      .mockImplementation(() => pendingForever());
    const client: TelegramClient = { getUpdates, sendMessage: vi.fn() };
    const logger = createMockLogger();
    const handler = vi.fn().mockRejectedValueOnce(new Error("boom"));

    createTelegramPoller({ client, logger }).subscribe(handler);

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));

    // Update 31 was never attempted this batch — advancing past update 30
    // despite its failure would leapfrog the offset and lose it forever.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getUpdates).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: undefined }));
  });
});
