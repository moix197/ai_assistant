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

describe("createTelegramPoller — crash-before-persist replay", () => {
  it("replays the same update on a fresh instance when persistence failed before a crash, then advances once persistence succeeds", async () => {
    const update = makeUpdate(60);
    // Models the durable, shared database row: unaffected by a failed write.
    let persistedOffset = 0;

    // --- Instance 1: handles the update, then "crashes" before its offset write lands ---
    const getUpdates1 = vi
      .fn()
      .mockResolvedValueOnce([update])
      .mockImplementation(() => pendingForever());
    const client1: TelegramClient = {
      getUpdates: getUpdates1,
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
    };
    const handler1 = vi.fn().mockResolvedValue(undefined);
    const offsetRepo1: TelegramOffsetRepo = {
      getOffset: vi.fn(async () => persistedOffset),
      // Simulates a crash between "handler completed" and "offset persisted":
      // the write never lands, so the durable offset is left unchanged.
      setOffset: vi.fn().mockRejectedValueOnce(new Error("simulated crash before persistence")),
    };

    createTelegramPoller({
      client: client1,
      logger: createMockLogger(),
      offsetRepo: offsetRepo1,
    }).subscribe(handler1);

    await vi.waitFor(() => expect(handler1).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(offsetRepo1.setOffset).toHaveBeenCalledTimes(1));
    expect(persistedOffset).toBe(0); // the failed write never persisted

    // --- Instance 2: a fresh poller (simulating a process restart) built
    // against the same, unchanged persisted offset ---
    const getUpdates2 = vi
      .fn()
      .mockResolvedValueOnce([update]) // Telegram redelivers the un-acked update
      .mockImplementation(() => pendingForever());
    const client2: TelegramClient = {
      getUpdates: getUpdates2,
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
    };
    const handler2 = vi.fn().mockResolvedValue(undefined);
    const offsetRepo2: TelegramOffsetRepo = {
      getOffset: vi.fn(async () => persistedOffset),
      setOffset: vi.fn(async (updateId: number) => {
        persistedOffset = updateId;
      }),
    };

    createTelegramPoller({
      client: client2,
      logger: createMockLogger(),
      offsetRepo: offsetRepo2,
    }).subscribe(handler2);

    // The un-acked update is genuinely redelivered and re-handled, not just
    // asserted in prose: instance 2's first getUpdates call resumes from
    // offset 0 (the unchanged persisted value) and receives update 60 again.
    // The loop may have already issued its next getUpdates call by the time
    // this runs, so only the first call's args are asserted, not the count.
    await vi.waitFor(() => expect(handler2).toHaveBeenCalledTimes(1));
    expect(getUpdates2).toHaveBeenNthCalledWith(1, expect.objectContaining({ offset: 0 }));
    expect(handler2).toHaveBeenCalledWith(expect.objectContaining({ text: "text-60" }));

    await vi.waitFor(() => expect(persistedOffset).toBe(61));
  });
});
