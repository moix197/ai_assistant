import { MaxIterationsReachedError } from "@hermes/agent";
import { type Channel, type InboundMessage, TelegramPartialSendError } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import { BudgetExceededError, LlmHttpError, LlmTimeoutError } from "@hermes/llm";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../../agent/build-agent";
import {
  EMPTY_REPLY_FALLBACK,
  GENERIC_FAILURE_REPLY,
  type LlmDedupeRepo,
  MAX_ITERATIONS_REPLY,
  PARTIAL_SEND_NOTICE,
  createCompletionHandler,
} from "../complete";

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

function createMockAgent(): Agent & { handleMessage: ReturnType<typeof vi.fn> } {
  return { handleMessage: vi.fn().mockResolvedValue("a real agent reply") };
}

// `dedupeRepo` is a mandatory handler option (Phase 5 gap fix — see
// complete.ts). This file exercises unrelated completion behavior, so a
// permissive fake that always reports "claimed" (never short-circuits)
// stands in, mirroring how other suites wire a no-op for a mandatory,
// unrelated-to-the-test-at-hand dependency.
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
    text: "hello",
    chatType: "private",
    kind: "message",
    updateId: 1,
    ...overrides,
  };
}

describe("createCompletionHandler", () => {
  it("replies with the agent's reply text on the happy path", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const agent = createMockAgent();
    agent.handleMessage.mockResolvedValue("a real agent reply");
    const handler = createCompletionHandler({
      channel,
      agent,
      logger,
      dedupeRepo: createPermissiveDedupeRepo(),
    });

    await handler(inboundMessage());

    expect(channel.send).toHaveBeenCalledWith("555", "a real agent reply");
  });

  it("calls agent.handleMessage with the telegram channel identifier, the chatId, the sender's channelUserId, and the message text", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const agent = createMockAgent();
    const handler = createCompletionHandler({
      channel,
      agent,
      logger,
      dedupeRepo: createPermissiveDedupeRepo(),
    });

    await handler(
      inboundMessage({
        chatId: "555",
        channelUserId: "111",
        text: "what is the capital of France?",
      }),
    );

    expect(agent.handleMessage).toHaveBeenCalledWith(
      "telegram",
      "555",
      "111",
      "what is the capital of France?",
    );
  });

  it("replies with a generic message, not a thrown error, when the agent throws LlmHttpError", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const agent = createMockAgent();
    agent.handleMessage.mockRejectedValue(new LlmHttpError("HTTP 500", 500));
    const handler = createCompletionHandler({
      channel,
      agent,
      logger,
      dedupeRepo: createPermissiveDedupeRepo(),
    });

    await expect(handler(inboundMessage())).resolves.toBeUndefined();
    expect(channel.send).toHaveBeenCalledTimes(1);
    const [, replyText] = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(replyText).not.toContain("HTTP 500");
  });

  it("replies with a generic message, not a thrown error, when the agent throws LlmTimeoutError", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const agent = createMockAgent();
    agent.handleMessage.mockRejectedValue(new LlmTimeoutError("timed out"));
    const handler = createCompletionHandler({
      channel,
      agent,
      logger,
      dedupeRepo: createPermissiveDedupeRepo(),
    });

    await expect(handler(inboundMessage())).resolves.toBeUndefined();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("replies with the specific out-of-budget message, not the generic fallback, when the agent throws BudgetExceededError", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const agent = createMockAgent();
    agent.handleMessage.mockRejectedValue(new BudgetExceededError(5, 5.5));
    const handler = createCompletionHandler({
      channel,
      agent,
      logger,
      dedupeRepo: createPermissiveDedupeRepo(),
    });

    await expect(handler(inboundMessage())).resolves.toBeUndefined();
    expect(channel.send).toHaveBeenCalledTimes(1);
    const [, replyText] = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(replyText).toMatch(/presupuesto/i);
    expect(replyText).not.toMatch(/\$5/);
    expect(replyText).not.toBe(GENERIC_FAILURE_REPLY);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   \n\t  "],
  ] as const)(
    "sends the exact EMPTY_REPLY_FALLBACK text and still records dedupe completion when the agent reply is %s",
    async (_name, agentReply) => {
      const channel = createMockChannel();
      const logger = createMockLogger();
      const agent = createMockAgent();
      agent.handleMessage.mockResolvedValue(agentReply);
      const dedupeRepo = createPermissiveDedupeRepo();
      const handler = createCompletionHandler({ channel, agent, logger, dedupeRepo });

      await handler(inboundMessage());

      expect(channel.send).toHaveBeenCalledTimes(1);
      const [, replyText] = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        string,
      ];
      expect(replyText).toBe(EMPTY_REPLY_FALLBACK);
      expect(dedupeRepo.complete).toHaveBeenCalledWith("telegram:1", replyText);
      expect(logger.warn).toHaveBeenCalled();
    },
  );

  it("sends the exact MAX_ITERATIONS_REPLY text and still records dedupe completion when the agent turn exhausts MAX_ITERATIONS", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const agent = createMockAgent();
    agent.handleMessage.mockRejectedValue(new MaxIterationsReachedError(1.23, 12));
    const dedupeRepo = createPermissiveDedupeRepo();
    const handler = createCompletionHandler({ channel, agent, logger, dedupeRepo });

    await expect(handler(inboundMessage())).resolves.toBeUndefined();

    expect(channel.send).toHaveBeenCalledWith("555", MAX_ITERATIONS_REPLY);
    expect(channel.send).not.toHaveBeenCalledWith("555", GENERIC_FAILURE_REPLY);
    expect(dedupeRepo.complete).toHaveBeenCalledWith("telegram:1", MAX_ITERATIONS_REPLY);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ iterations: 12, totalCostUsd: 1.23 }),
    );
  });

  it("never records dedupe completion and logs exactly one warn when the max-iterations notice itself fails to deliver", async () => {
    const channel = createMockChannel();
    (channel.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("bot blocked"));
    const logger = createMockLogger();
    const agent = createMockAgent();
    agent.handleMessage.mockRejectedValue(new MaxIterationsReachedError(1.23, 12));
    const dedupeRepo = createPermissiveDedupeRepo();
    const handler = createCompletionHandler({ channel, agent, logger, dedupeRepo });

    await expect(handler(inboundMessage())).resolves.toBeUndefined();

    expect(dedupeRepo.complete).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ iterations: 12, totalCostUsd: 1.23 }),
    );
  });

  it("sends the exact PARTIAL_SEND_NOTICE text and records dedupe completion when the reply send fails with TelegramPartialSendError", async () => {
    const channel = createMockChannel();
    (channel.send as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(
        new TelegramPartialSendError("delivered 1 of 3 parts before failing: boom", {
          partsSent: 1,
          totalParts: 3,
        }),
      )
      .mockResolvedValueOnce(undefined);
    const logger = createMockLogger();
    const agent = createMockAgent();
    const dedupeRepo = createPermissiveDedupeRepo();
    const handler = createCompletionHandler({ channel, agent, logger, dedupeRepo });

    await expect(handler(inboundMessage())).resolves.toBeUndefined();

    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.send).toHaveBeenNthCalledWith(2, "555", PARTIAL_SEND_NOTICE);
    expect(channel.send).not.toHaveBeenCalledWith("555", GENERIC_FAILURE_REPLY);
    expect(dedupeRepo.complete).toHaveBeenCalledWith("telegram:1", PARTIAL_SEND_NOTICE);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ partsSent: 1, totalParts: 3 }),
    );
  });

  it("never records dedupe completion and never sends the generic failure text when the cut-off notice itself also fails to send", async () => {
    const channel = createMockChannel();
    (channel.send as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(
        new TelegramPartialSendError("delivered 1 of 3 parts before failing: boom", {
          partsSent: 1,
          totalParts: 3,
        }),
      )
      .mockRejectedValueOnce(new Error("bot blocked"));
    const logger = createMockLogger();
    const agent = createMockAgent();
    const dedupeRepo = createPermissiveDedupeRepo();
    const handler = createCompletionHandler({ channel, agent, logger, dedupeRepo });

    await expect(handler(inboundMessage())).resolves.toBeUndefined();

    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.send).not.toHaveBeenCalledWith("555", GENERIC_FAILURE_REPLY);
    expect(dedupeRepo.complete).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ partsSent: 1, totalParts: 3 }),
    );
  });

  it("falls through to the ordinary generic-failure reply, unchanged, on a total (first-chunk) send failure", async () => {
    const channel = createMockChannel();
    (channel.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network down"));
    const logger = createMockLogger();
    const agent = createMockAgent();
    const dedupeRepo = createPermissiveDedupeRepo();
    const handler = createCompletionHandler({ channel, agent, logger, dedupeRepo });

    await expect(handler(inboundMessage())).resolves.toBeUndefined();

    // Two calls total: the failed send attempt, then the ordinary
    // generic-failure reply — same shape as any other total-failure path.
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.send).toHaveBeenNthCalledWith(2, "555", GENERIC_FAILURE_REPLY);
    expect(dedupeRepo.complete).not.toHaveBeenCalled();
  });

  it("logs exactly one warn and resolves, without a second mislabeled error, when channel.send is blocked on every call", async () => {
    const channel = createMockChannel();
    (channel.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("bot blocked"));
    const logger = createMockLogger();
    const agent = createMockAgent();
    const dedupeRepo = createPermissiveDedupeRepo();
    const handler = createCompletionHandler({ channel, agent, logger, dedupeRepo });

    await expect(handler(inboundMessage())).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "failed to deliver notice to user — likely blocked the bot or unreachable",
      expect.objectContaining({ channelUserId: ALLOWED_ID, error: expect.any(String) }),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "llm completion failed",
      expect.objectContaining({ channelUserId: ALLOWED_ID }),
    );
  });

  it("ignores an edited message, no agent call", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const agent = createMockAgent();
    const handler = createCompletionHandler({
      channel,
      agent,
      logger,
      dedupeRepo: createPermissiveDedupeRepo(),
    });

    await handler(inboundMessage({ kind: "edited_message" }));

    expect(agent.handleMessage).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });
});
