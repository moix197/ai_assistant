import type { Channel, InboundMessage } from "@hermes/channels";
import type { GoogleAccountRepo } from "@hermes/google-auth";
import { describe, expect, it, vi } from "vitest";
import { createDisconnectHandler } from "../disconnect";

function createMockChannel(): Channel {
  return {
    capabilities: { markdown: true, files: false, buttons: false, maxMessageLength: 4096 },
    subscribe: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeRepo(): GoogleAccountRepo {
  return {
    getAccount: vi.fn(),
    upsertAccount: vi.fn(),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
  };
}

function inboundMessage(): InboundMessage {
  return {
    channelUserId: "111",
    chatId: "555",
    text: "/disconnect",
    chatType: "private",
    kind: "message",
    updateId: 1,
  };
}

describe("createDisconnectHandler", () => {
  it("removes the account and confirms disconnection", async () => {
    const channel = createMockChannel();
    const repo = fakeRepo();
    const handler = createDisconnectHandler(channel, repo);

    await handler(inboundMessage());

    expect(repo.deleteAccount).toHaveBeenCalledWith("telegram", "111");
    expect(channel.send).toHaveBeenCalledWith("555", expect.stringContaining("Disconnected"));
  });

  it("is idempotent: calling it twice replies the same way both times, no throw on the second call", async () => {
    const channel = createMockChannel();
    const repo = fakeRepo();
    const handler = createDisconnectHandler(channel, repo);

    await handler(inboundMessage());
    await expect(handler(inboundMessage())).resolves.toBeUndefined();

    expect(repo.deleteAccount).toHaveBeenCalledTimes(2);
    const firstReply = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const secondReply = (channel.send as ReturnType<typeof vi.fn>).mock.calls[1]?.[1];
    expect(firstReply).toBe(secondReply);
  });
});
