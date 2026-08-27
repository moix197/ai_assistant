import type { Channel, InboundMessage } from "@hermes/channels";
import { normalizeTelegramUpdate } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import { createEchoHandler } from "../echo";

const ALLOWED_ID = 111;

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
    updateId: 1,
    ...overrides,
  };
}

describe("createEchoHandler", () => {
  it("echoes the text back for a sender in a private chat", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const handler = createEchoHandler(channel, logger);

    await handler(inboundMessage());

    expect(channel.send).toHaveBeenCalledWith("555", "hello");
  });

  it("ignores an edited message with no reply, info logged", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const handler = createEchoHandler(channel, logger);

    await handler(inboundMessage({ kind: "edited_message" }));

    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "edited message ignored",
      expect.objectContaining({ channelUserId: ALLOWED_ID }),
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
