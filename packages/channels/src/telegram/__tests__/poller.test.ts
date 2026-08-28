import type { Logger } from "@hermes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TelegramApiError,
  type TelegramClient,
  type TelegramMessage,
  type TelegramUpdate,
} from "../client";
import { type TelegramOffsetRepo, createTelegramPoller } from "../poller";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockOffsetRepo(initialOffset = 0): TelegramOffsetRepo {
  return {
    getOffset: vi.fn().mockResolvedValue(initialOffset),
    setOffset: vi.fn().mockResolvedValue(undefined),
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

/**
 * A `message` update missing `chat` — a field `normalizeTelegramUpdate` reads
 * unconditionally once `message.from` passes its own guard. Real Telegram
 * payloads always carry it, but nothing before `normalizeTelegramUpdate`
 * validates that against the wire response, so this models a malformed
 * payload reaching it and throwing (`TypeError: Cannot read properties of
 * undefined`) rather than returning `null` like the fields it does guard.
 */
function makeMalformedUpdate(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 111, is_bot: false },
      date: 0,
      text: "x",
    } as TelegramMessage,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTelegramPoller — message dispatch concurrency (approval-gate deadlock fix)", () => {
  // Regression test for the Phase 3 deadlock: a completion handler can await
  // a Telegram approval tap for minutes. If the poll loop awaited a message
  // handler inline the way it used to, getUpdates would never run again to
  // fetch the very callback_query that unblocks it. This must fail against
  // the pre-fix code (which awaited the handler before looping back).
  it("issues a subsequent getUpdates call while a message handler is still pending", async () => {
    const update = makeUpdate(10);
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
    // Never resolves within this test — models a handler stuck awaiting an
    // approval tap.
    const handler = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    createTelegramPoller({ client, logger, offsetRepo: createMockOffsetRepo() }).subscribe(handler);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ channelUserId: "111", text: "text-10" }),
    );

    // The handler above is still pending, yet the loop issues its next
    // getUpdates call anyway, from the already-advanced offset — proving the
    // loop no longer blocks on a message handler.
    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));
    expect(getUpdates).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 11 }));
  });

  it("delivers a callback_query to the callback handler while an earlier message handler is still pending", async () => {
    const messageUpdate = makeUpdate(11);
    const callbackUpdate: TelegramUpdate = {
      update_id: 12,
      callback_query: {
        id: "cbq-12",
        from: { id: 111, is_bot: false },
        message: { message_id: 7, chat: { id: 555, type: "private" }, date: 0 },
        data: "approval-1:approve",
      },
    };
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([messageUpdate])
      .mockResolvedValueOnce([callbackUpdate])
      .mockImplementation(() => pendingForever());
    const client: TelegramClient = {
      getUpdates,
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
    };
    const logger = createMockLogger();
    // Never resolves — this is exactly the shape of the deadlock: an
    // approval-gated completion handler awaiting the tap that follows.
    const handler = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const callbackHandler = vi.fn().mockResolvedValue(undefined);

    const poller = createTelegramPoller({ client, logger, offsetRepo: createMockOffsetRepo() });
    poller.subscribe(handler);
    poller.subscribeCallback(callbackHandler);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    // The approval tap arrives and is delivered even though the message
    // handler it's meant to unblock never resolved.
    await vi.waitFor(() => expect(callbackHandler).toHaveBeenCalledTimes(1));
    expect(callbackHandler).toHaveBeenCalledWith(expect.objectContaining({ callbackId: "cbq-12" }));
  });
});

describe("createTelegramPoller — message handler failure (no redelivery under detached dispatch)", () => {
  // A message handler failure can no longer stop the batch or hold back the
  // offset the way it used to (see poller-offset-ordering.test.ts and
  // poller-crash-replay.test.ts for the callback_query behavior that still
  // works this way) — the loop already moved on before the handler even
  // settles. The failure is logged loudly instead, per
  // packages/channels/README.md's narrowed idempotency contract.
  it("still advances the offset when a message handler throws, and logs the failure without retrying", async () => {
    const update = makeUpdate(20);
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
    const handler = vi.fn().mockRejectedValue(new Error("transient send failure"));
    const setOffset = vi.fn().mockResolvedValue(undefined);

    createTelegramPoller({
      client,
      logger,
      offsetRepo: { getOffset: vi.fn().mockResolvedValue(0), setOffset },
      retryDelayMs: 1,
    }).subscribe(handler);

    // The offset advances past update 20 despite the handler's eventual
    // rejection — there is no redelivery to fall back on any more.
    await vi.waitFor(() => expect(setOffset).toHaveBeenCalledWith(21));
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        "message handler failed after its offset was already advanced, not retried",
        expect.objectContaining({ updateId: 20 }),
      ),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      "handler failed, will retry this update",
      expect.anything(),
    );
  });

  it("keeps processing the rest of a batch after a message handler throws, instead of stopping", async () => {
    const first = makeUpdate(30);
    const second = makeUpdate(31);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([first, second])
      .mockImplementation(() => pendingForever());
    const client: TelegramClient = {
      getUpdates,
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
    };
    const logger = createMockLogger();
    const handler = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);

    createTelegramPoller({
      client,
      logger,
      offsetRepo: createMockOffsetRepo(),
      retryDelayMs: 1,
    }).subscribe(handler);

    // Update 31 is dispatched too, in the same batch, despite update 30's
    // handler having failed — detached dispatch never leapfrogs or skips
    // the rest of the batch, it just doesn't wait.
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: "text-31" }));
  });

  // Regression test: normalizeTelegramUpdate() used to run outside
  // dispatchMessage's try block, so a malformed update that made it throw
  // rejected the detached promise trackDispatch hands to `void
  // ....finally(...)` — an unhandled rejection, and a promise Promise.all
  // would have propagated as a stop() rejection had it fired mid-drain.
  it("does not leak an unhandled rejection when normalizeTelegramUpdate throws on a malformed update, and stop() still resolves cleanly", async () => {
    const update = makeMalformedUpdate(40);
    // Mirrors the "graceful shutdown" describe below: the loop's second,
    // in-flight getUpdates() call must settle promptly once aborted, or
    // stop()'s await on the still-running loop iteration would hang this
    // test regardless of what dispatchMessage did with update 40.
    const controller = new AbortController();
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update])
      .mockImplementation(
        (params: { signal?: AbortSignal }) =>
          new Promise<TelegramUpdate[]>((_resolve, reject) => {
            params.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          }),
      );
    const client: TelegramClient = {
      getUpdates,
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
    };
    const logger = createMockLogger();
    const handler = vi.fn().mockResolvedValue(undefined);
    const setOffset = vi.fn().mockResolvedValue(undefined);

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const poller = createTelegramPoller({
        client,
        logger,
        offsetRepo: { getOffset: vi.fn().mockResolvedValue(0), setOffset },
        retryDelayMs: 1,
        signal: controller.signal,
      });
      poller.subscribe(handler);

      // The offset still advances even though normalization threw before a
      // message ever reached the handler — detached dispatch still "handled"
      // this update as far as the loop is concerned.
      await vi.waitFor(() => expect(setOffset).toHaveBeenCalledWith(41));
      expect(handler).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(logger.error).toHaveBeenCalledWith(
          "message handler failed after its offset was already advanced, not retried",
          expect.objectContaining({ updateId: 40 }),
        ),
      );

      // Give a leaked rejection a turn of the event loop to surface as
      // `unhandledRejection` before asserting none did.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandledRejections).toEqual([]);

      // Proves the detached dispatch settled (not rejected) from stop()'s
      // point of view too — with the old code and Promise.all, a rejection
      // here would have made stop() itself reject instead of resolve.
      controller.abort();
      await expect(poller.stop()).resolves.toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

describe("createTelegramPoller — graceful shutdown drains in-flight message dispatch", () => {
  it("stop() awaits a detached message dispatch instead of dropping it or hanging", async () => {
    const update = makeUpdate(90);
    // Mirrors the "abort signal wiring" describe below (and boot.ts's real
    // shutdown sequence: controller.abort() then channel.stop()) so the
    // second, in-flight getUpdates() call settles promptly once aborted,
    // instead of a pendingForever() call making the loop itself un-exitable
    // (nothing in this test's job is to prove getUpdates behavior — only
    // that stop() drains the detached dispatch once the loop has exited).
    const controller = new AbortController();
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update])
      .mockImplementation(
        (params: { signal?: AbortSignal }) =>
          new Promise<TelegramUpdate[]>((_resolve, reject) => {
            params.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          }),
      );
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

    const poller = createTelegramPoller({
      client,
      logger,
      offsetRepo: createMockOffsetRepo(),
      signal: controller.signal,
    });
    poller.subscribe(handler);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    // The loop has already moved on to its next getUpdates call, in flight,
    // while the message handler above is still pending — this is the fix
    // being proven, not an incidental setup detail.
    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));

    controller.abort();
    let stopResolved = false;
    const stopPromise = poller.stop().then(() => {
      stopResolved = true;
    });

    // The dispatch is still pending: stop() must not resolve out from under it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopResolved).toBe(false);

    resolveHandler();

    await stopPromise;
    expect(stopResolved).toBe(true);
  });
});

describe("createTelegramPoller — abort signal wiring (idle-bot shutdown regression)", () => {
  it("propagates the signal into getUpdates and resolves stop() promptly once it aborts, without waiting out retryDelayMs", async () => {
    const controller = new AbortController();
    // Mirrors the real TelegramClient: the in-flight long-poll only settles
    // once the signal it was given aborts, exactly like a real fetch(...,
    // { signal }) would.
    const getUpdates = vi.fn().mockImplementation(
      (params: { signal?: AbortSignal }) =>
        new Promise<TelegramUpdate[]>((_resolve, reject) => {
          params.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const client: TelegramClient = {
      getUpdates,
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
    };
    const logger = createMockLogger();
    const handler = vi.fn();

    const poller = createTelegramPoller({
      client,
      logger,
      offsetRepo: createMockOffsetRepo(),
      // A large retryDelayMs proves stop() does NOT wait this out — it only
      // resolves promptly if the abort skips the delay entirely.
      retryDelayMs: 10_000,
      signal: controller.signal,
    });
    poller.subscribe(handler);

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(1));
    expect(getUpdates).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));

    const startedAt = Date.now();
    controller.abort();
    await poller.stop();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe("createTelegramPoller — callback_query inbound (Phase 3)", () => {
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

  it("requests callback_query in allowedUpdates", async () => {
    const getUpdates = vi.fn().mockImplementation(() => pendingForever());
    const client: TelegramClient = {
      getUpdates,
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
    };

    createTelegramPoller({
      client,
      logger: createMockLogger(),
      offsetRepo: createMockOffsetRepo(),
    }).subscribe(vi.fn());

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(1));
    expect(getUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ allowedUpdates: expect.arrayContaining(["callback_query"]) }),
    );
  });

  it("normalizes a callback_query update into the inbound callback kind and dispatches it to subscribeCallback's handler", async () => {
    const update = makeCallbackUpdate(70);
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
    const messageHandler = vi.fn();
    const callbackHandler = vi.fn().mockResolvedValue(undefined);

    const poller = createTelegramPoller({
      client,
      logger: createMockLogger(),
      offsetRepo: createMockOffsetRepo(),
    });
    poller.subscribe(messageHandler);
    poller.subscribeCallback(callbackHandler);

    await vi.waitFor(() => expect(callbackHandler).toHaveBeenCalledTimes(1));
    expect(callbackHandler).toHaveBeenCalledWith({
      callbackId: "cbq-70",
      callbackData: "approval-1:approve",
      chatId: "555",
      messageId: "7",
      channelUserId: "111",
    });
    expect(messageHandler).not.toHaveBeenCalled();
  });

  // Unlike a message update (see the "no redelivery under detached
  // dispatch" describe above), a callback_query is still awaited inline by
  // pollOnce, so it keeps the pre-fix batch-stop-and-retry behavior in full.
  it("awaits the callback handler before requesting the next batch (sequential backpressure preserved for callbacks)", async () => {
    const update = makeCallbackUpdate(71);
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
    let resolveHandler: () => void = () => {};
    const handlerPromise = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });
    const callbackHandler = vi.fn().mockReturnValue(handlerPromise);

    const poller = createTelegramPoller({
      client,
      logger: createMockLogger(),
      offsetRepo: createMockOffsetRepo(),
    });
    poller.subscribe(vi.fn());
    poller.subscribeCallback(callbackHandler);

    await vi.waitFor(() => expect(callbackHandler).toHaveBeenCalledTimes(1));

    expect(getUpdates).toHaveBeenCalledTimes(1);
    expect(getUpdates).not.toHaveBeenCalledWith(expect.objectContaining({ offset: 72 }));

    resolveHandler();

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));
    expect(getUpdates).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 72 }));
  });

  it("does not advance the offset when a callback handler throws, and stops processing the rest of the batch", async () => {
    const first = makeCallbackUpdate(72);
    const second = makeCallbackUpdate(73);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([first, second])
      .mockImplementation(() => pendingForever());
    const client: TelegramClient = {
      getUpdates,
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
    };
    const logger = createMockLogger();
    const callbackHandler = vi.fn().mockRejectedValueOnce(new Error("boom"));

    const poller = createTelegramPoller({
      client,
      logger,
      offsetRepo: createMockOffsetRepo(),
      retryDelayMs: 1,
    });
    poller.subscribe(vi.fn());
    poller.subscribeCallback(callbackHandler);

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));

    // The second callback in the batch was never attempted — advancing past
    // the first despite its failure would leapfrog the offset and lose it.
    expect(callbackHandler).toHaveBeenCalledTimes(1);
    expect(getUpdates).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 0 }));
    expect(logger.warn).toHaveBeenCalledWith(
      "handler failed, will retry this update",
      expect.objectContaining({ updateId: 72 }),
    );
  });
});

describe("createTelegramPoller — fatal 409 conflict", () => {
  it("stops polling and reports the fatal error instead of retrying forever", async () => {
    const conflictError = new TelegramApiError("conflict, gave up after retries", {
      status: 409,
    });
    const getUpdates = vi.fn().mockRejectedValue(conflictError);
    const client: TelegramClient = {
      getUpdates,
      sendMessage: vi.fn(),
      deleteWebhook: vi.fn(),
      answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn(),
    };
    const logger = createMockLogger();
    const onFatalError = vi.fn();
    const handler = vi.fn();

    createTelegramPoller({
      client,
      logger,
      offsetRepo: createMockOffsetRepo(),
      retryDelayMs: 1,
      onFatalError,
    }).subscribe(handler);

    await vi.waitFor(() => expect(onFatalError).toHaveBeenCalledTimes(1));
    expect(onFatalError).toHaveBeenCalledWith(conflictError);
    expect(logger.error).toHaveBeenCalledWith(
      "fatal: telegram getUpdates conflict, stopping poller",
      expect.objectContaining({ error: conflictError.message }),
    );

    const callsAtFatal = getUpdates.mock.calls.length;
    // Give the loop a chance to run again if it hadn't actually stopped.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getUpdates.mock.calls.length).toBe(callsAtFatal);
    expect(logger.warn).not.toHaveBeenCalledWith("getUpdates failed, retrying", expect.anything());
  });
});
