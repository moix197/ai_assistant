import type { Channel, InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../agent/build-agent";
import { createDispatchCommand } from "../boot";
import { type LlmDedupeRepo, createCompletionHandler } from "../handlers/complete";
import { withAllowlist } from "../handlers/with-allowlist";
import { withPrivateChat } from "../handlers/with-private-chat";

const ALLOWED_ID = 111;
const DISALLOWED_ID = 999;

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

// `dedupeRepo` is a mandatory handler option (Phase 5 gap fix — see
// complete.ts). This file exercises allowlist gating, unrelated to dedupe,
// so a permissive fake that always reports "claimed" stands in.
function createPermissiveDedupeRepo(): LlmDedupeRepo {
  return {
    claim: vi.fn().mockResolvedValue({ status: "claimed" }),
    complete: vi.fn().mockResolvedValue(undefined),
  };
}

function inboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelUserId: String(DISALLOWED_ID),
    chatId: "555",
    text: "hello",
    chatType: "private",
    kind: "message",
    updateId: 1,
    ...overrides,
  };
}

describe("allowlist gates the paid completion handler (invariant #1, paid-call-specific)", () => {
  it("drops a message from an unallowlisted sender before the agent is ever called", async () => {
    const logger = createMockLogger();
    const channel = createMockChannel();
    const handleMessage = vi.fn().mockResolvedValue("should never be reached");
    const agent: Agent = { handleMessage };
    const completionHandler = createCompletionHandler({
      channel,
      agent,
      logger,
      dedupeRepo: createPermissiveDedupeRepo(),
    });

    const dispatchCommand = createDispatchCommand({
      pingHandler: vi.fn(),
      startHandler: vi.fn(),
      statsHandler: vi.fn(),
      connectHandler: vi.fn(),
      statusHandler: vi.fn(),
      disconnectHandler: vi.fn(),
      completionHandler,
    });

    const allowlist = new Set([ALLOWED_ID]);
    const handler = withAllowlist(withPrivateChat(dispatchCommand, logger), allowlist, logger);

    await handler(inboundMessage());

    expect(handleMessage).toHaveBeenCalledTimes(0);
    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "rejected: unknown user",
      expect.objectContaining({ channelUserId: DISALLOWED_ID }),
    );
  });

  it("reaches the agent for an allowlisted sender in a private chat", async () => {
    const logger = createMockLogger();
    const channel = createMockChannel();
    const handleMessage = vi.fn().mockResolvedValue("a real reply");
    const agent: Agent = { handleMessage };
    const completionHandler = createCompletionHandler({
      channel,
      agent,
      logger,
      dedupeRepo: createPermissiveDedupeRepo(),
    });

    const dispatchCommand = createDispatchCommand({
      pingHandler: vi.fn(),
      startHandler: vi.fn(),
      statsHandler: vi.fn(),
      connectHandler: vi.fn(),
      statusHandler: vi.fn(),
      disconnectHandler: vi.fn(),
      completionHandler,
    });

    const allowlist = new Set([ALLOWED_ID]);
    const handler = withAllowlist(withPrivateChat(dispatchCommand, logger), allowlist, logger);

    await handler(inboundMessage({ channelUserId: String(ALLOWED_ID) }));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith("555", "a real reply");
  });
});
