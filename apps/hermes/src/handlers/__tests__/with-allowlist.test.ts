import type { InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import { withAllowlist } from "../with-allowlist";

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

describe("withAllowlist", () => {
  it("calls through to the handler for an allowlisted sender", async () => {
    const logger = createMockLogger();
    const inner = vi.fn().mockResolvedValue(undefined);
    const handler = withAllowlist(inner, ALLOWLIST, logger);

    const message = inboundMessage();
    await handler(message);

    expect(inner).toHaveBeenCalledWith(message);
  });

  it("drops a message from a disallowed sender, no call-through, warn logged with the id", async () => {
    const logger = createMockLogger();
    const inner = vi.fn().mockResolvedValue(undefined);
    const handler = withAllowlist(inner, ALLOWLIST, logger);

    await handler(inboundMessage({ channelUserId: String(DISALLOWED_ID) }));

    expect(inner).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "rejected: unknown user",
      expect.objectContaining({ channelUserId: DISALLOWED_ID }),
    );
  });
});
