import type { InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import { withAllowlist } from "../with-allowlist";
import { withPrivateChat } from "../with-private-chat";

const ALLOWED_ID = 111;

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function inboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelUserId: String(ALLOWED_ID),
    chatId: "555",
    text: "hello",
    chatType: "private",
    kind: "message",
    ...overrides,
  };
}

describe("withPrivateChat", () => {
  it("calls through to the handler for a private chat", async () => {
    const logger = createMockLogger();
    const inner = vi.fn().mockResolvedValue(undefined);
    const handler = withPrivateChat(inner, logger);

    const message = inboundMessage();
    await handler(message);

    expect(inner).toHaveBeenCalledWith(message);
  });

  it("drops a non-private chat message, no call-through, warn logged with id and chatType", async () => {
    const logger = createMockLogger();
    const inner = vi.fn().mockResolvedValue(undefined);
    const handler = withPrivateChat(inner, logger);

    await handler(inboundMessage({ chatType: "group" }));

    expect(inner).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "rejected: non-private chat",
      expect.objectContaining({ channelUserId: ALLOWED_ID, chatType: "group" }),
    );
  });
});

describe("withAllowlist(withPrivateChat(handler)) — composed as boot.ts registers it", () => {
  it("reaches no handler for an allowlisted sender in a non-private chat", async () => {
    const logger = createMockLogger();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const allowlist = new Set([ALLOWED_ID]);
    const handler = withAllowlist(withPrivateChat(dispatch, logger), allowlist, logger);

    await handler(inboundMessage({ chatType: "group" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "rejected: non-private chat",
      expect.objectContaining({ channelUserId: ALLOWED_ID, chatType: "group" }),
    );
  });

  it("reaches the handler for an allowlisted sender in a private chat", async () => {
    const logger = createMockLogger();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const allowlist = new Set([ALLOWED_ID]);
    const handler = withAllowlist(withPrivateChat(dispatch, logger), allowlist, logger);

    const message = inboundMessage();
    await handler(message);

    expect(dispatch).toHaveBeenCalledWith(message);
  });
});
