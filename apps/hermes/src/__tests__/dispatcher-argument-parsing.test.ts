import type { InboundMessage } from "@hermes/channels";
import { describe, expect, it, vi } from "vitest";
import { createDispatchCommand, splitCommand } from "../boot";

function inboundMessage(text: string): InboundMessage {
  return {
    channelUserId: "111",
    chatId: "555",
    text,
    chatType: "private",
    kind: "message",
    updateId: 1,
  };
}

describe("splitCommand", () => {
  it("a bare command splits to itself with empty args", () => {
    expect(splitCommand("/stats")).toEqual({ command: "/stats", args: "" });
  });

  it("splits on the first whitespace only, leaving the rest of the text intact", () => {
    expect(splitCommand("/connect google")).toEqual({ command: "/connect", args: "google" });
    expect(splitCommand("/connect google extra text")).toEqual({
      command: "/connect",
      args: "google extra text",
    });
  });

  it("arbitrary non-command text with no leading slash still splits the same way", () => {
    expect(splitCommand("hello there")).toEqual({ command: "hello", args: "there" });
  });
});

describe("createDispatchCommand — argument routing", () => {
  function createDeps() {
    return {
      pingHandler: vi.fn().mockResolvedValue(undefined),
      startHandler: vi.fn().mockResolvedValue(undefined),
      statsHandler: vi.fn().mockResolvedValue(undefined),
      connectHandler: vi.fn().mockResolvedValue(undefined),
      statusHandler: vi.fn().mockResolvedValue(undefined),
      disconnectHandler: vi.fn().mockResolvedValue(undefined),
      completionHandler: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("/stats (bare) reaches statsHandler with args === ''", async () => {
    const deps = createDeps();
    const dispatch = createDispatchCommand(deps);

    await dispatch(inboundMessage("/stats"));

    expect(deps.statsHandler).toHaveBeenCalledWith(expect.anything(), "");
  });

  it("/connect google reaches connectHandler with args === 'google'", async () => {
    const deps = createDeps();
    const dispatch = createDispatchCommand(deps);

    await dispatch(inboundMessage("/connect google"));

    expect(deps.connectHandler).toHaveBeenCalledWith(expect.anything(), "google");
    expect(deps.completionHandler).not.toHaveBeenCalled();
  });

  it("/connect bogus is handled locally by connectHandler, never reaching completionHandler", async () => {
    const deps = createDeps();
    const dispatch = createDispatchCommand(deps);

    await dispatch(inboundMessage("/connect bogus"));

    expect(deps.connectHandler).toHaveBeenCalledWith(expect.anything(), "bogus");
    expect(deps.completionHandler).not.toHaveBeenCalled();
  });

  it("/status (bare) reaches statusHandler with args === '', never completionHandler", async () => {
    const deps = createDeps();
    const dispatch = createDispatchCommand(deps);

    await dispatch(inboundMessage("/status"));

    expect(deps.statusHandler).toHaveBeenCalledWith(expect.anything(), "");
    expect(deps.completionHandler).not.toHaveBeenCalled();
  });

  it("/disconnect (bare) reaches disconnectHandler with args === '', never completionHandler", async () => {
    const deps = createDeps();
    const dispatch = createDispatchCommand(deps);

    await dispatch(inboundMessage("/disconnect"));

    expect(deps.disconnectHandler).toHaveBeenCalledWith(expect.anything(), "");
    expect(deps.completionHandler).not.toHaveBeenCalled();
  });

  it("an unrecognized bare command still falls through to completionHandler unchanged (regression guard)", async () => {
    const deps = createDeps();
    const dispatch = createDispatchCommand(deps);

    await dispatch(inboundMessage("what is the capital of France?"));

    expect(deps.completionHandler).toHaveBeenCalledWith(
      expect.anything(),
      "is the capital of France?",
    );
    expect(deps.pingHandler).not.toHaveBeenCalled();
    expect(deps.startHandler).not.toHaveBeenCalled();
    expect(deps.statsHandler).not.toHaveBeenCalled();
    expect(deps.connectHandler).not.toHaveBeenCalled();
    expect(deps.statusHandler).not.toHaveBeenCalled();
    expect(deps.disconnectHandler).not.toHaveBeenCalled();
  });
});
