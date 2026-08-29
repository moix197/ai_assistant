import type { Channel, InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import type { GoogleAccount, GoogleAccountRepo } from "@hermes/google-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DisconnectHandlerDeps, createDisconnectHandler } from "../disconnect";

const REFRESH_TOKEN = "the-decrypted-refresh-token";

function createMockChannel(): Channel {
  return {
    capabilities: { markdown: true, files: false, buttons: false, maxMessageLength: 4096 },
    subscribe: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeRepo(account?: GoogleAccount): GoogleAccountRepo {
  return {
    getAccount: vi.fn().mockResolvedValue(account),
    upsertAccount: vi.fn(),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeAccount(): GoogleAccount {
  return {
    channel: "telegram",
    channelUserId: "111",
    chatId: "555",
    googleEmail: "person@example.com",
    scopes: ["openid"],
    tokenEnvelope: { v: 1, iv: "iv", tag: "tag", ct: "ct" },
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  };
}

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
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

/** No Google env group configured — the "cleanly absent" case every other Google-gated dep in this codebase follows. */
function undisconnectedDeps(): DisconnectHandlerDeps {
  return { decryptRefreshToken: undefined, logger: fakeLogger() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDisconnectHandler", () => {
  it("removes the account and confirms disconnection", async () => {
    const channel = createMockChannel();
    const repo = fakeRepo();
    const handler = createDisconnectHandler(channel, repo, undisconnectedDeps());

    await handler(inboundMessage());

    expect(repo.deleteAccount).toHaveBeenCalledWith("telegram", "111");
    expect(channel.send).toHaveBeenCalledWith("555", expect.stringContaining("Disconnected"));
  });

  it("is idempotent: calling it twice replies the same way both times, no throw on the second call", async () => {
    const channel = createMockChannel();
    const repo = fakeRepo();
    const handler = createDisconnectHandler(channel, repo, undisconnectedDeps());

    await handler(inboundMessage());
    await expect(handler(inboundMessage())).resolves.toBeUndefined();

    expect(repo.deleteAccount).toHaveBeenCalledTimes(2);
    const firstReply = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const secondReply = (channel.send as ReturnType<typeof vi.fn>).mock.calls[1]?.[1];
    expect(firstReply).toBe(secondReply);
  });

  it("revokes the grant at Google with the decrypted refresh token before deleting the local row", async () => {
    const channel = createMockChannel();
    const repo = fakeRepo(fakeAccount());
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const callOrder: string[] = [];
    (repo.deleteAccount as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("delete");
    });
    const decryptRefreshToken = vi.fn().mockImplementation(() => {
      callOrder.push("decrypt");
      return REFRESH_TOKEN;
    });
    const deps: DisconnectHandlerDeps = { decryptRefreshToken, logger: fakeLogger() };
    const handler = createDisconnectHandler(channel, repo, deps);

    await handler(inboundMessage());

    expect(decryptRefreshToken).toHaveBeenCalledWith(fakeAccount());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe(`https://oauth2.googleapis.com/revoke?token=${REFRESH_TOKEN}`);
    expect(callOrder).toEqual(["decrypt", "delete"]);
    expect(repo.deleteAccount).toHaveBeenCalledWith("telegram", "111");
    expect(channel.send).toHaveBeenCalledWith("555", expect.stringContaining("Disconnected"));
  });

  it("still deletes the local row and replies the same way when Google's revoke responds with a non-2xx", async () => {
    const channel = createMockChannel();
    const repo = fakeRepo(fakeAccount());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("invalid_token", { status: 400 })),
    );
    const logger = fakeLogger();
    const deps: DisconnectHandlerDeps = {
      decryptRefreshToken: () => REFRESH_TOKEN,
      logger,
    };
    const handler = createDisconnectHandler(channel, repo, deps);

    await handler(inboundMessage());

    expect(repo.deleteAccount).toHaveBeenCalledWith("telegram", "111");
    expect(channel.send).toHaveBeenCalledWith("555", expect.stringContaining("Disconnected"));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("still deletes the local row when decrypting the stored token fails", async () => {
    const channel = createMockChannel();
    const repo = fakeRepo(fakeAccount());
    const logger = fakeLogger();
    const decryptRefreshToken = vi.fn().mockImplementation(() => {
      throw new Error("token-crypto: failed to decrypt token envelope");
    });
    const deps: DisconnectHandlerDeps = { decryptRefreshToken, logger };
    const handler = createDisconnectHandler(channel, repo, deps);

    await handler(inboundMessage());

    expect(repo.deleteAccount).toHaveBeenCalledWith("telegram", "111");
    expect(channel.send).toHaveBeenCalledWith("555", expect.stringContaining("Disconnected"));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("still deletes the local row and replies the same way when getAccount rejects", async () => {
    const channel = createMockChannel();
    const repo = fakeRepo();
    (repo.getAccount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection reset"));
    const logger = fakeLogger();
    const deps: DisconnectHandlerDeps = {
      decryptRefreshToken: vi.fn(),
      logger,
    };
    const handler = createDisconnectHandler(channel, repo, deps);

    await handler(inboundMessage());

    expect(repo.deleteAccount).toHaveBeenCalledWith("telegram", "111");
    expect(channel.send).toHaveBeenCalledWith("555", expect.stringContaining("Disconnected"));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("never calls the Google account repo's getAccount/decrypt when Google is unconfigured", async () => {
    const channel = createMockChannel();
    const repo = fakeRepo();
    const handler = createDisconnectHandler(channel, repo, undisconnectedDeps());

    await handler(inboundMessage());

    expect(repo.getAccount).not.toHaveBeenCalled();
  });
});
