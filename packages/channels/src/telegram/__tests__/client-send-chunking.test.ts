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
