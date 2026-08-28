import type { Channel, InboundMessage } from "@hermes/channels";
import type { ConnectFlow } from "@hermes/google-auth";
import { describe, expect, it, vi } from "vitest";
import { createConnectHandler } from "../connect";

function createMockChannel(): Channel {
  return {
    capabilities: { markdown: true, files: false, buttons: false, maxMessageLength: 4096 },
    subscribe: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeConnectFlow(): ConnectFlow {
  return {
    startConnect: vi.fn().mockReturnValue({ url: "https://accounts.google.com/fake", state: "s1" }),
    completeConnect: vi.fn(),
  };
}

function inboundMessage(): InboundMessage {
  return {
    channelUserId: "111",
    chatId: "555",
    text: "/connect google",
    chatType: "private",
    kind: "message",
    updateId: 1,
  };
}

describe("createConnectHandler", () => {
  it("valid /connect google sends a reply containing the auth URL", async () => {
    const channel = createMockChannel();
    const connectFlow = fakeConnectFlow();
    const handler = createConnectHandler(channel, connectFlow);

    await handler(inboundMessage(), "google");

    expect(connectFlow.startConnect).toHaveBeenCalledWith("telegram", "111", "555", [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
    expect(channel.send).toHaveBeenCalledWith("555", "https://accounts.google.com/fake");
  });

  it("/connect anything-else replies with usage help and never calls startConnect", async () => {
    const channel = createMockChannel();
    const connectFlow = fakeConnectFlow();
    const handler = createConnectHandler(channel, connectFlow);

    await handler(inboundMessage(), "bogus");

    expect(connectFlow.startConnect).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledWith("555", expect.stringContaining("/connect google"));
  });

  it("bare /connect (empty args) replies with usage help", async () => {
    const channel = createMockChannel();
    const connectFlow = fakeConnectFlow();
    const handler = createConnectHandler(channel, connectFlow);

    await handler(inboundMessage(), "");

    expect(connectFlow.startConnect).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledWith("555", expect.stringContaining("/connect google"));
  });

  it("replies with a not-configured message when connectFlow is undefined", async () => {
    const channel = createMockChannel();
    const handler = createConnectHandler(channel, undefined);

    await handler(inboundMessage(), "google");

    expect(channel.send).toHaveBeenCalledWith("555", expect.stringContaining("not configured"));
  });
});
