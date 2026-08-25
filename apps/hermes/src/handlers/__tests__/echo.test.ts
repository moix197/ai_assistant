import type { Channel, InboundMessage } from "@hermes/channels";
import { normalizeTelegramUpdate } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import { createEchoHandler } from "../echo";

const ALLOWED_ID = 111;
const DISALLOWED_ID = 999;
const ALLOWLIST = new Set([ALLOWED_ID]);

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockChannel(): Channel {
  return {
    capabilities: { markdown: true, files: false, buttons: false, maxMessageLength: 4096 },
    subscribe: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
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

describe("createEchoHandler", () => {
  it("echoes the text back for an allowed sender in a private chat", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const handler = createEchoHandler(channel, ALLOWLIST, logger);

    await handler(inboundMessage());

    expect(channel.send).toHaveBeenCalledWith("555", "hello");
  });

  it("drops a message from a disallowed sender, no send, warn logged with the id", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const handler = createEchoHandler(channel, ALLOWLIST, logger);

    await handler(inboundMessage({ channelUserId: String(DISALLOWED_ID) }));

    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "rejected: unknown user",
      expect.objectContaining({ channelUserId: DISALLOWED_ID }),
    );
  });

  it("ignores an edited message with no reply, info logged", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const handler = createEchoHandler(channel, ALLOWLIST, logger);

    await handler(inboundMessage({ kind: "edited_message" }));

    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "edited message ignored",
      expect.objectContaining({ channelUserId: ALLOWED_ID }),
    );
  });

  it("drops a non-private chat message even from an allowlisted sender, logged, no reply", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const handler = createEchoHandler(channel, ALLOWLIST, logger);

    await handler(inboundMessage({ chatType: "group" }));

    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "rejected: non-private chat",
      expect.objectContaining({ channelUserId: ALLOWED_ID, chatType: "group" }),
    );
  });

  it("never crashes on a raw update with no message.from — dropped before any handler runs", () => {
    const logger = createMockLogger();

    const normalized = normalizeTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 555, type: "private" },
          date: 0,
          text: "hi",
        },
      },
      logger,
    );

    expect(normalized).toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });
});
