import type { Channel, InboundMessage } from "@hermes/channels";
import type { Pool } from "@hermes/store";
import { describe, expect, it, vi } from "vitest";
import { createStartHandler } from "../start";

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
    text: "/start",
    chatType: "private",
    kind: "message",
    updateId: 1,
  };
}

describe("createStartHandler", () => {
  it("confirms allowlist membership and connectivity when the DB is up", async () => {
    const channel = createMockChannel();
    const pool = createMockPool(() => Promise.resolve());
    const handler = createStartHandler(channel, pool);

    await handler(inboundMessage());

    expect(channel.send).toHaveBeenCalledWith("555", expect.stringContaining("allowlisted"));
    const [, text] = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(text).not.toContain("unreachable");
  });

  it("reports the DB as unreachable when the DB check fails", async () => {
    const channel = createMockChannel();
    const pool = createMockPool(() => Promise.reject(new Error("connection refused")));
    const handler = createStartHandler(channel, pool);

    await handler(inboundMessage());

    const [, text] = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(text).toContain("unreachable");
  });
});
