import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramApiError, createTelegramClient } from "../client";

const TOKEN = "123456:FAKE-TOKEN-abcDEF";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createTelegramClient — request shape", () => {
  it("calls getUpdates with the expected URL and snake_case body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: [] }));
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    await client.getUpdates({ offset: 42, timeout: 30, limit: 100, allowedUpdates: ["message"] });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(JSON.parse(init.body as string)).toEqual({
      offset: 42,
      timeout: 30,
      limit: 100,
      allowed_updates: ["message"],
    });
  });

  it("calls sendMessage with the expected URL and body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 1 } }));
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    await client.sendMessage("999", "hello");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: "999", text: "hello" });
  });
});

describe("createTelegramClient — inline keyboards (Phase 3)", () => {
  it("attaches reply_markup and returns the sent message's id when options.replyMarkup is given", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 42 } }));
    const client = createTelegramClient({ token: TOKEN, fetchImpl });
    const replyMarkup = {
      inline_keyboard: [[{ text: "Approve", callback_data: "a1:approve" }]],
    };

    const result = await client.sendMessage("999", "please approve", { replyMarkup });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: "999",
      text: "please approve",
      reply_markup: replyMarkup,
    });
    expect(result).toEqual({ messageId: 42 });
  });

  it("answerCallbackQuery calls the answerCallbackQuery endpoint with the callback id and text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: true }));
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    await client.answerCallbackQuery("cbq-1", "Approved.");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`);
    expect(JSON.parse(init.body as string)).toEqual({
      callback_query_id: "cbq-1",
      text: "Approved.",
    });
  });

  it("editMessageText calls the editMessageText endpoint with chat_id/message_id/text", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 42 } }));
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    await client.editMessageText("999", 42, "Approved.");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/editMessageText`);
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: "999",
      message_id: 42,
      text: "Approved.",
    });
  });
});

describe("createTelegramClient — getUpdates timeout margin", () => {
  it("sets the AbortController timeout longer than the poll timeout param", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: [] }));
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    const pollTimeoutSeconds = 30;
    await client.getUpdates({
      timeout: pollTimeoutSeconds,
      limit: 100,
      allowedUpdates: ["message"],
    });

    const abortTimeoutCall = setTimeoutSpy.mock.calls.find((call) => {
      const delay = call[1];
      return typeof delay === "number" && delay >= pollTimeoutSeconds * 1000;
    });
    expect(abortTimeoutCall).toBeDefined();
    const [, delayMs] = abortTimeoutCall as [unknown, number];
    expect(delayMs).toBeGreaterThan(pollTimeoutSeconds * 1000);
  });
});

describe("createTelegramClient — 409 conflict retry policy", () => {
  it("retries a persistent 409 a bounded number of times, then rejects fatally with a readable message", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            ok: false,
            error_code: 409,
            description: "Conflict: terminated by other getUpdates request",
          },
          false,
          409,
        ),
      );
      const client = createTelegramClient({ token: TOKEN, fetchImpl });

      const resultPromise = client
        .getUpdates({ timeout: 30, limit: 100, allowedUpdates: ["message"] })
        .then(
          () => {
            throw new Error("expected getUpdates to reject");
          },
          (error: unknown) => error,
        );
      await vi.runAllTimersAsync();
      const error = await resultPromise;

      // 1 initial attempt + 3 bounded retries, then it gives up for good.
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("409");
      expect(message).toContain("another instance is already polling");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createTelegramClient — external abort signal (shutdown)", () => {
  /** Mimics real `fetch`: rejects immediately if the signal is already aborted, otherwise rejects on the signal's `abort` event. Mirrors packages/llm's openai-compatible-abort.test.ts. */
  function abortAwareFetch(): ReturnType<typeof vi.fn> {
    return vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        return Promise.reject(error);
      }
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
  }

  it("rejects promptly on a pre-aborted signal instead of exhausting the transient-retry policy", async () => {
    const fetchImpl = abortAwareFetch();
    const shutdownController = new AbortController();
    shutdownController.abort();
    const client = createTelegramClient({
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.getUpdates({
        timeout: 30,
        limit: 100,
        allowedUpdates: ["message"],
        signal: shutdownController.signal,
      }),
    ).rejects.toThrow();

    // A single attempt, not the up-to-6 attempts MAX_TRANSIENT_RETRIES would
    // otherwise allow — proves the abort short-circuits the retry loop
    // instead of being treated as an ordinary transient failure.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight long-poll as soon as the signal fires mid-request", async () => {
    const fetchImpl = abortAwareFetch();
    const shutdownController = new AbortController();
    const client = createTelegramClient({
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const resultPromise = client
      .getUpdates({
        timeout: 30,
        limit: 100,
        allowedUpdates: ["message"],
        signal: shutdownController.signal,
      })
      .then(
        () => {
          throw new Error("expected getUpdates to reject");
        },
        (error: unknown) => error,
      );

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    shutdownController.abort();
    const error = await resultPromise;

    expect(error).toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes a not-yet-aborted signal through to fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: [] }));
    const shutdownController = new AbortController();
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    await client.getUpdates({
      timeout: 30,
      limit: 100,
      allowedUpdates: ["message"],
      signal: shutdownController.signal,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeDefined();
    expect(init.signal?.aborted).toBe(false);
  });

  it("aborts the fetch's own signal when the caller's signal fires mid-request (not a separate, uncombined signal)", async () => {
    const fetchImpl = abortAwareFetch();
    const shutdownController = new AbortController();
    const client = createTelegramClient({
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const resultPromise = client
      .getUpdates({
        timeout: 30,
        limit: 100,
        allowedUpdates: ["message"],
        signal: shutdownController.signal,
      })
      .catch((error: unknown) => error);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(false);

    shutdownController.abort();
    await resultPromise;

    // Proves the caller's abort reaches the exact signal handed to fetch
    // (not a leaked, uncombined `AbortSignal.any` composite that fetch never
    // saw fire).
    expect(init.signal?.aborted).toBe(true);
  });

  it("still independently fires its own per-request timeout and aborts the fetch when the caller's signal never aborts", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = abortAwareFetch();
      const shutdownController = new AbortController();
      const client = createTelegramClient({
        token: TOKEN,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const resultPromise = client
        .getUpdates({
          timeout: 30,
          limit: 100,
          allowedUpdates: ["message"],
          signal: shutdownController.signal,
        })
        .then(
          () => {
            throw new Error("expected getUpdates to reject");
          },
          (error: unknown) => error,
        );

      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error).toBeInstanceOf(Error);
      expect(shutdownController.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the abort listener from the caller's signal once the request settles", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: [] }));
    const shutdownController = new AbortController();
    const removeEventListenerSpy = vi.spyOn(shutdownController.signal, "removeEventListener");
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    await client.getUpdates({
      timeout: 30,
      limit: 100,
      allowedUpdates: ["message"],
      signal: shutdownController.signal,
    });

    expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    // With the listener gone, firing the signal after settlement has no
    // further effect on this already-resolved call.
    expect(() => shutdownController.abort()).not.toThrow();
  });

  /** Resolves the first call with a 409 response, then behaves like `abortAwareFetch` (mimicking real `fetch`) for every call after. */
  function abortAwareFetchAfterFirstAttempt409(): ReturnType<typeof vi.fn> {
    let callCount = 0;
    return vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          jsonResponse(
            {
              ok: false,
              error_code: 409,
              description: "Conflict: terminated by other getUpdates request",
            },
            false,
            409,
          ),
        );
      }
      if (init.signal?.aborted) {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        return Promise.reject(error);
      }
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
  }

  it("propagates a plain Error (not TelegramApiError) when the shutdown signal aborts mid-409-backoff, matching pre-shared-helper behavior", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = abortAwareFetchAfterFirstAttempt409();
      const shutdownController = new AbortController();
      const client = createTelegramClient({
        token: TOKEN,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const resultPromise = client
        .getUpdates({
          timeout: 30,
          limit: 100,
          allowedUpdates: ["message"],
          signal: shutdownController.signal,
        })
        .then(
          () => {
            throw new Error("expected getUpdates to reject");
          },
          (error: unknown) => error,
        );

      // Flush microtasks so the first 409 response is classified and the
      // retry loop reaches its backoff `setTimeout`, without advancing fake
      // time (the delay's timer must not have fired yet).
      await vi.advanceTimersByTimeAsync(0);
      shutdownController.abort();
      const error = await resultPromise;

      // This client supplies no `buildAbortedError` to `@hermes/core`'s
      // `withHttpRetry` (it has no distinct abort-vs-failure error type), so
      // an abort landing mid-backoff still spends one more real, doomed
      // attempt before giving up — exactly the pre-shared-helper behavior —
      // rather than short-circuiting to a synthesized abort error. That
      // doomed attempt's own generic, redacted network-failure `Error` is
      // what must propagate here: a `TelegramApiError` would wrongly read as
      // a fatal 409 to `poller.ts`'s classification (checked ahead of its
      // own `signal?.aborted` check), firing `onFatalError` on what should
      // be a clean shutdown.
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TelegramApiError);
      expect((error as Error).message).not.toContain("409");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createTelegramClient — token redaction", () => {
  it("never surfaces the raw token in a thrown error on a network failure", async () => {
    // Network/timeout errors are retried with backoff before rethrowing
    // (see client.ts's callWithRetry) — fake timers fast-forward through
    // those delays so this test doesn't take several real seconds.
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockRejectedValue(
          new TypeError(
            `request to https://api.telegram.org/bot${TOKEN}/getUpdates failed, reason: ECONNRESET`,
          ),
        );
      const client = createTelegramClient({ token: TOKEN, fetchImpl });

      const resultPromise = client
        .getUpdates({ timeout: 30, limit: 100, allowedUpdates: ["message"] })
        .then(
          () => {
            throw new Error("expected getUpdates to reject");
          },
          (error: unknown) => error,
        );
      await vi.runAllTimersAsync();
      const error = await resultPromise;

      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(TOKEN);
      expect(message).toContain("<REDACTED>");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never surfaces the raw token in a thrown error on an HTTP error response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 401));
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    try {
      await client.sendMessage("1", "hi");
      throw new Error("expected sendMessage to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(TOKEN);
      expect(message).toContain("<REDACTED>");
    }
  });

  it("never surfaces the raw token when Telegram responds ok: false", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        description: `bot${TOKEN} is not authorized`,
      }),
    );
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    try {
      await client.sendMessage("1", "hi");
      throw new Error("expected sendMessage to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(TOKEN);
    }
  });
});
