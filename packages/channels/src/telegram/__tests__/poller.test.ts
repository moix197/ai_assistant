import type { Logger } from "@hermes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramApiError, type TelegramClient, type TelegramUpdate } from "../client";
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTelegramPoller — offset ordering", () => {
  // In-memory only: proves sequential backpressure (handler awaited before the next
  // getUpdates call). The crash-before-persist offset guarantee is owned by Phase 3's
  // poller-crash-replay.test.ts, once the offset is actually persisted.
  it("awaits the handler before requesting the next batch (sequential backpressure, happy path)", async () => {
    const update = makeUpdate(10);
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update])
      .mockImplementation(() => pendingForever());
    const client: TelegramClient = { getUpdates, sendMessage: vi.fn(), deleteWebhook: vi.fn() };
    const logger = createMockLogger();
    let resolveHandler: () => void = () => {};
    const handlerPromise = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });
    const handler = vi.fn().mockReturnValue(handlerPromise);

    createTelegramPoller({ client, logger, offsetRepo: createMockOffsetRepo() }).subscribe(handler);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ channelUserId: "111", text: "text-10" }),
    );

    // While the handler is still pending, the poll loop must not have looped
    // back to request the next batch — proves the loop awaits each handler
    // before issuing the next getUpdates call (sequential backpressure).
    expect(getUpdates).toHaveBeenCalledTimes(1);
    expect(getUpdates).not.toHaveBeenCalledWith(expect.objectContaining({ offset: 11 }));

    resolveHandler();

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));
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
    const client: TelegramClient = { getUpdates, sendMessage: vi.fn(), deleteWebhook: vi.fn() };
    const logger = createMockLogger();
    const handler = vi.fn().mockRejectedValue(new Error("transient send failure"));

    createTelegramPoller({
      client,
      logger,
      offsetRepo: createMockOffsetRepo(),
      retryDelayMs: 1,
    }).subscribe(handler);

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));

    expect(handler).toHaveBeenCalledTimes(1);
    // Second poll re-requests from the same (unadvanced) offset — update 20
    // is redelivered by Telegram rather than silently skipped, and the loop
    // is still running (a second getUpdates call happened at all).
    expect(getUpdates).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 0 }));
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
    const client: TelegramClient = { getUpdates, sendMessage: vi.fn(), deleteWebhook: vi.fn() };
    const logger = createMockLogger();
    const handler = vi.fn().mockRejectedValueOnce(new Error("boom"));

    createTelegramPoller({
      client,
      logger,
      offsetRepo: createMockOffsetRepo(),
      retryDelayMs: 1,
    }).subscribe(handler);

    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2));

    // Update 31 was never attempted this batch — advancing past update 30
    // despite its failure would leapfrog the offset and lose it forever.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getUpdates).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 0 }));
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
    const client: TelegramClient = { getUpdates, sendMessage: vi.fn(), deleteWebhook: vi.fn() };
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

describe("createTelegramPoller — fatal 409 conflict", () => {
  it("stops polling and reports the fatal error instead of retrying forever", async () => {
    const conflictError = new TelegramApiError("conflict, gave up after retries", {
      status: 409,
    });
    const getUpdates = vi.fn().mockRejectedValue(conflictError);
    const client: TelegramClient = { getUpdates, sendMessage: vi.fn(), deleteWebhook: vi.fn() };
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
