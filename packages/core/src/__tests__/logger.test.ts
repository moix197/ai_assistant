import { describe, expect, it } from "vitest";
import { createLogger } from "../logger";

describe("createLogger", () => {
  it("writes JSON lines with ts/level/msg and merged fields", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });

    logger.info("hello", { userId: "abc" });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ level: "info", msg: "hello", userId: "abc" });
    expect(typeof parsed.ts).toBe("string");
  });

  it("filters out levels below the configured minimum", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", write: (line) => lines.push(line) });

    logger.debug("skip me");
    logger.info("skip me too");
    logger.warn("keep me");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe("keep me");
  });

  it("defaults to info level when none is configured", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });

    logger.debug("dropped");
    logger.info("kept");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe("kept");
  });

  it("merges base fields with per-call fields, call fields taking precedence", () => {
    const lines: string[] = [];
    const logger = createLogger({
      fields: { service: "hermes", env: "test" },
      write: (line) => lines.push(line),
    });

    logger.error("boom", { env: "override" });

    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ service: "hermes", env: "override" });
  });
});
