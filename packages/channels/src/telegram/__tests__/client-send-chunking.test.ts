import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramApiError, TelegramPartialSendError, createTelegramClient } from "../client";

const TOKEN = "123456:FAKE-TOKEN-abcDEF";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A 400 (non-retryable, no wait) API failure — `classify` throws it directly. */
function apiErrorResponse(): Response {
  return jsonResponse({ ok: false, description: "bad request" }, false, 400);
}

/**
 * Three words with no internal whitespace, sized so `chunkText` splits this
 * into exactly three parts at the space between each word: each of the
 * first two windows (4096 chars) ends exactly on a trailing space, so the
 * split lands there rather than hard-cutting mid-word.
 */
function threeChunkText(): string {
  return `${"a".repeat(4095)} ${"b".repeat(4095)} ${"c".repeat(2000)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTelegramClient — sendMessage chunking", () => {
  it("splits a 6000-character send into multiple in-order sendMessage calls", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 1 } }));
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    const text = "word ".repeat(1200); // 6000 chars, well over the 4096 cap
    await client.sendMessage("999", text);

    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);

    const sentParts = fetchImpl.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return (JSON.parse(init.body as string) as { text: string }).text;
    });

    for (const part of sentParts) {
      expect(part.length).toBeLessThanOrEqual(4096);
    }
    expect(sentParts.join("")).toBe(text);
  });

  it("sends text under the limit as a single sendMessage call", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 1 } }));
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    await client.sendMessage("999", "hello");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createTelegramClient — sendMessage partial-send signal", () => {
  it("wraps a later-chunk failure in TelegramPartialSendError carrying partsSent/totalParts", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 1 } }))
      .mockResolvedValueOnce(apiErrorResponse());
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    const text = threeChunkText();
    let thrown: unknown;
    try {
      await client.sendMessage("999", text);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TelegramPartialSendError);
    const error = thrown as TelegramPartialSendError;
    expect(error.partsSent).toBe(1);
    expect(error.totalParts).toBe(3);
    // The underlying TelegramApiError detail isn't lost when wrapped.
    expect(error.message).toContain("bad request");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rethrows the original, unwrapped error on a first-chunk failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(apiErrorResponse());
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    let thrown: unknown;
    try {
      await client.sendMessage("999", "hello");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TelegramApiError);
    expect(thrown).not.toBeInstanceOf(TelegramPartialSendError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
