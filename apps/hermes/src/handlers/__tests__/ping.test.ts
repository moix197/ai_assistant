import type { Channel, InboundMessage } from "@hermes/channels";
import type { Pool } from "@hermes/store";
import { describe, expect, it, vi } from "vitest";
import { createPingHandler } from "../ping";

function createMockChannel(): Channel {
  return {
    capabilities: { markdown: true, files: false, buttons: false, maxMessageLength: 4096 },
    subscribe: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPool(queryImpl: () => Promise<unknown>): Pool {
  return { query: vi.fn().mockImplementation(queryImpl) } as unknown as Pool;
}

function inboundMessage(): InboundMessage {
  return {
    channelUserId: "111",
    chatId: "555",
    text: "/ping",
    chatType: "private",
    kind: "message",
  };
}

describe("createPingHandler", () => {
  it("replies with uptime and 'connected' when the DB is up", async () => {
    const channel = createMockChannel();
    const pool = createMockPool(() => Promise.resolve());
    const handler = createPingHandler(channel, pool);

    await handler(inboundMessage());

    expect(channel.send).toHaveBeenCalledTimes(1);
    const [chatId, text] = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(chatId).toBe("555");
    expect(text).toContain("uptime:");
    expect(text).toContain("db: connected");
  });

  it("replies with 'disconnected' when the DB check fails", async () => {
    const channel = createMockChannel();
    const pool = createMockPool(() => Promise.reject(new Error("connection refused")));
    const handler = createPingHandler(channel, pool);

    await handler(inboundMessage());

    const [, text] = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(text).toContain("db: disconnected");
  });
});
