import { describe, expect, it } from "vitest";
import { matchesCommand } from "../boot";

describe("matchesCommand", () => {
  it("matches an exact command", () => {
    expect(matchesCommand("/ping", "/ping")).toBe(true);
  });

  it("matches a command with an @botusername suffix, as Telegram sends in groups", () => {
    expect(matchesCommand("/ping@yourbotname", "/ping")).toBe(true);
  });

  it("does not match a different command", () => {
    expect(matchesCommand("/start", "/ping")).toBe(false);
  });

  it("does not match a command that merely starts with the target command", () => {
    expect(matchesCommand("/pingpong", "/ping")).toBe(false);
  });

  it("does not match arbitrary text", () => {
    expect(matchesCommand("hello", "/ping")).toBe(false);
  });
});
