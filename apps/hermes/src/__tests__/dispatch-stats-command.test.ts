import type { Channel, InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import type { LlmProvider } from "@hermes/llm";
import { describe, expect, it, vi } from "vitest";
import { createDispatchCommand } from "../boot";
import { type LlmDedupeRepo, createCompletionHandler } from "../handlers/complete";
import { withAllowlist } from "../handlers/with-allowlist";
import { withPrivateChat } from "../handlers/with-private-chat";

const ALLOWED_ID = 111;
const DISALLOWED_ID = 999;

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockChannel(): Channel {
  return {
    capabilities: { markdown: true, files: false, buttons: false, maxMessageLength: 4096 },
    subscribe: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function createPermissiveDedupeRepo(): LlmDedupeRepo {
  return {
    claim: vi.fn().mockResolvedValue({ status: "claimed" }),
    complete: vi.fn().mockResolvedValue(undefined),
  };
}

function inboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelUserId: String(ALLOWED_ID),
    chatId: "555",
    text: "/stats",
    chatType: "private",
    kind: "message",
    updateId: 1,
    ...overrides,
  };
}

describe("/stats is routed before the paid fallthrough (routing regression)", () => {
  it("invokes the stats path and never the LLM provider's complete()", async () => {
    const logger = createMockLogger();
    const channel = createMockChannel();
    const complete = vi.fn().mockResolvedValue({
      text: "should never be reached",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0 },
      finishReason: "stop",
    });
    const llmProvider: LlmProvider = { complete };
    const completionHandler = createCompletionHandler({
      channel,
      llmProvider,
      model: "some-model",
      logger,
      dedupeRepo: createPermissiveDedupeRepo(),
    });
    const statsHandler = vi.fn().mockResolvedValue(undefined);

    const dispatchCommand = createDispatchCommand({
      pingHandler: vi.fn(),
      startHandler: vi.fn(),
      statsHandler,
      completionHandler,
    });

    const allowlist = new Set([ALLOWED_ID]);
    const handler = withAllowlist(withPrivateChat(dispatchCommand, logger), allowlist, logger);

    await handler(inboundMessage());

    expect(statsHandler).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(0);
  });

  it("drops a /stats message from an unallowlisted sender before the stats handler is ever called", async () => {
    const logger = createMockLogger();
    const channel = createMockChannel();
    const complete = vi.fn().mockResolvedValue({
      text: "should never be reached",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0 },
      finishReason: "stop",
    });
    const llmProvider: LlmProvider = { complete };
    const completionHandler = createCompletionHandler({
      channel,
      llmProvider,
      model: "some-model",
      logger,
      dedupeRepo: createPermissiveDedupeRepo(),
    });
    const statsHandler = vi.fn().mockResolvedValue(undefined);

    const dispatchCommand = createDispatchCommand({
      pingHandler: vi.fn(),
      startHandler: vi.fn(),
      statsHandler,
      completionHandler,
    });

    const allowlist = new Set([ALLOWED_ID]);
    const handler = withAllowlist(withPrivateChat(dispatchCommand, logger), allowlist, logger);

    await handler(inboundMessage({ channelUserId: String(DISALLOWED_ID) }));

    expect(statsHandler).toHaveBeenCalledTimes(0);
    expect(complete).toHaveBeenCalledTimes(0);
    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "rejected: unknown user",
      expect.objectContaining({ channelUserId: DISALLOWED_ID }),
    );
  });
});
