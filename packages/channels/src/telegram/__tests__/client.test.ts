import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramClient } from "../client";

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

describe("createTelegramClient — token redaction", () => {
  it("never surfaces the raw token in a thrown error on a network failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(
        new TypeError(
          `request to https://api.telegram.org/bot${TOKEN}/getUpdates failed, reason: ECONNRESET`,
        ),
      );
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    try {
      await client.getUpdates({ timeout: 30, limit: 100, allowedUpdates: ["message"] });
      throw new Error("expected getUpdates to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(TOKEN);
      expect(message).toContain("<REDACTED>");
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
