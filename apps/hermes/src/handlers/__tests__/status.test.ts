import type { Channel, InboundMessage } from "@hermes/channels";
import type { GoogleAccount, GoogleAccountRepo } from "@hermes/google-auth";
import { describe, expect, it, vi } from "vitest";
import { createStatusHandler } from "../status";

function createMockChannel(): Channel {
  return {
    capabilities: { markdown: true, files: false, buttons: false, maxMessageLength: 4096 },
    subscribe: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeAccount(overrides: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    channel: "telegram",
    channelUserId: "111",
    chatId: "555",
    googleEmail: "person@example.com",
    scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
    tokenEnvelope: { v: 1, iv: "iv", tag: "tag", ct: "ct" },
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeRepo(account: GoogleAccount | undefined): GoogleAccountRepo {
  return {
    getAccount: vi.fn().mockResolvedValue(account),
    upsertAccount: vi.fn(),
    deleteAccount: vi.fn(),
  };
}

function inboundMessage(): InboundMessage {
  return {
    channelUserId: "111",
    chatId: "555",
    text: "/status",
    chatType: "private",
    kind: "message",
    updateId: 1,
  };
}

describe("createStatusHandler", () => {
  it("replies with the connected email and its granted scopes, read from the stored row", async () => {
    const channel = createMockChannel();
    const repo = fakeRepo(fakeAccount());
    const handler = createStatusHandler(channel, repo);

    await handler(inboundMessage());

    expect(channel.send).toHaveBeenCalledWith(
      "555",
      "Connected as person@example.com, scopes: openid https://www.googleapis.com/auth/userinfo.email",
    );
  });

  it("replies with a not-connected message, no LLM call, when no account exists", async () => {
    const channel = createMockChannel();
    const repo = fakeRepo(undefined);
    const handler = createStatusHandler(channel, repo);

    await handler(inboundMessage());

    expect(channel.send).toHaveBeenCalledWith("555", expect.stringContaining("Not connected"));
  });
});
