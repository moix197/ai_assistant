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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTelegramPoller — crash-before-persist replay (callback_query)", () => {
  // A callback_query is still awaited inline by pollOnce and its offset is
  // still persisted only after its handler completes (see poller.ts and
  // packages/channels/README.md) — this guarantee was NEVER extended to
  // message updates, only narrowed to exclude them (see the sibling test
  // below), so this pins it exactly as it always worked, just for the one
  // update kind that still keeps it.
  it("replays the same callback_query on a fresh instance when persistence failed before a crash, then advances once persistence succeeds", async () => {
    const update = makeCallbackUpdate(60);
    // Models the durable, shared database row: unaffected by a failed write.
    let persistedOffset = 0;

    // --- Instance 1: handles the callback, then "crashes" before its offset write lands ---
    const getUpdates1 = vi
      .fn()
      .mockResolvedValueOnce([update])
      .mockImplementation(() => pendingForever());
    const client1: TelegramClient = {
      getUpdates: getUpdates1,
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
    };
    const callbackHandler1 = vi.fn().mockResolvedValue(undefined);
    const offsetRepo1: TelegramOffsetRepo = {
      getOffset: vi.fn(async () => persistedOffset),
      // Simulates a crash between "handler completed" and "offset persisted":
      // the write never lands, so the durable offset is left unchanged.
      setOffset: vi.fn().mockRejectedValueOnce(new Error("simulated crash before persistence")),
    };

    const poller1 = createTelegramPoller({
      client: client1,
      logger: createMockLogger(),
      offsetRepo: offsetRepo1,
    });
    poller1.subscribe(vi.fn());
    poller1.subscribeCallback(callbackHandler1);

    await vi.waitFor(() => expect(callbackHandler1).toHaveBeenCalledTimes(1));
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
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
    };
    const callbackHandler2 = vi.fn().mockResolvedValue(undefined);
    const offsetRepo2: TelegramOffsetRepo = {
      getOffset: vi.fn(async () => persistedOffset),
      setOffset: vi.fn(async (updateId: number) => {
        persistedOffset = updateId;
      }),
    };

    const poller2 = createTelegramPoller({
      client: client2,
      logger: createMockLogger(),
      offsetRepo: offsetRepo2,
    });
    poller2.subscribe(vi.fn());
    poller2.subscribeCallback(callbackHandler2);

    // The un-acked callback is genuinely redelivered and re-handled, not just
    // asserted in prose: instance 2's first getUpdates call resumes from
    // offset 0 (the unchanged persisted value) and receives the same
    // callback_query again.
    // The loop may have already issued its next getUpdates call by the time
    // this runs, so only the first call's args are asserted, not the count.
    await vi.waitFor(() => expect(callbackHandler2).toHaveBeenCalledTimes(1));
    expect(getUpdates2).toHaveBeenNthCalledWith(1, expect.objectContaining({ offset: 0 }));
    expect(callbackHandler2).toHaveBeenCalledWith(
      expect.objectContaining({ callbackId: "cbq-60" }),
    );

    await vi.waitFor(() => expect(persistedOffset).toBe(61));
  });
});

describe("createTelegramPoller — message offset advances without waiting for its handler", () => {
  // The old crash-replay invariant above ("offset persisted only after the
  // handler fully completes") is deliberately NOT true for message updates
  // any more — see the approval-gate deadlock this file's history documents
  // and packages/channels/README.md. A message update's offset now advances
  // BEFORE it's even dispatched, not merely without waiting on its handler,
  // whether or not (and regardless of how long before) its handler ever
  // resolves. This means a crash while a message handler is in flight is
  // NOT redelivered on restart, and nothing downstream recovers it: the
  // pending llm_dedupe row it leaves behind is inert, so that turn is lost
  // rather than retried — an accepted trade-off.
  it("persists a message update's offset even while its handler is still pending", async () => {
    const update = makeUpdate(80);
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

    // Never resolves within this test — models a completion handler stuck
    // awaiting an approval tap for minutes.
    const handler = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    let persistedOffset = 0;
    const offsetRepo: TelegramOffsetRepo = {
      getOffset: vi.fn(async () => persistedOffset),
      setOffset: vi.fn(async (updateId: number) => {
        persistedOffset = updateId;
      }),
    };

    createTelegramPoller({ client, logger, offsetRepo }).subscribe(handler);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    // The handler above never resolves, yet the offset still advances —
    // proving persistence does not wait on it.
    await vi.waitFor(() => expect(persistedOffset).toBe(81));
  });
});
