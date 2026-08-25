import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, toRedactedLog } from "../load";

const validEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/hermes",
  PORT: "3000",
  LOG_LEVEL: "info",
  TELEGRAM_BOT_TOKEN: "123456:FAKE-TOKEN-abcDEF",
  TELEGRAM_ALLOWLIST: "111,222",
};

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      DATABASE_URL: validEnv.DATABASE_URL,
      PORT: 3000,
      LOG_LEVEL: "info",
    });
  });

  it("applies defaults for PORT, LOG_LEVEL, and TELEGRAM_ALLOWLIST when omitted", () => {
    const config = loadConfig({
      DATABASE_URL: validEnv.DATABASE_URL,
      TELEGRAM_BOT_TOKEN: validEnv.TELEGRAM_BOT_TOKEN,
    });
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.TELEGRAM_ALLOWLIST).toBe("");
  });

  it("fails naming DATABASE_URL when missing", () => {
    const { DATABASE_URL: _omit, ...rest } = validEnv;
    expect(() => loadConfig(rest)).toThrow(ConfigError);
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it("fails naming DATABASE_URL when malformed", () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: "not-a-url" })).toThrow(/DATABASE_URL/);
  });

  it("fails naming PORT when non-numeric", () => {
    expect(() => loadConfig({ ...validEnv, PORT: "not-a-number" })).toThrow(/PORT/);
  });

  it("fails naming LOG_LEVEL when not one of the allowed values", () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });

  it("fails naming TELEGRAM_BOT_TOKEN when missing", () => {
    const { TELEGRAM_BOT_TOKEN: _omit, ...rest } = validEnv;
    expect(() => loadConfig(rest)).toThrow(ConfigError);
    expect(() => loadConfig(rest)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("accepts an empty TELEGRAM_ALLOWLIST", () => {
    const config = loadConfig({ ...validEnv, TELEGRAM_ALLOWLIST: "" });
    expect(config.TELEGRAM_ALLOWLIST).toBe("");
  });

  it("fails naming the bad entry when TELEGRAM_ALLOWLIST has a non-numeric entry", () => {
    expect(() => loadConfig({ ...validEnv, TELEGRAM_ALLOWLIST: "111,not-a-number" })).toThrow(
      /TELEGRAM_ALLOWLIST/,
    );
    expect(() => loadConfig({ ...validEnv, TELEGRAM_ALLOWLIST: "111,not-a-number" })).toThrow(
      /not-a-number/,
    );
  });

  it("fails naming the bad entry when TELEGRAM_ALLOWLIST has a trailing comma", () => {
    expect(() => loadConfig({ ...validEnv, TELEGRAM_ALLOWLIST: "111,222," })).toThrow(
      /TELEGRAM_ALLOWLIST/,
    );
  });
});

describe("toRedactedLog", () => {
  it("masks DATABASE_URL and TELEGRAM_BOT_TOKEN, and leaves other fields intact", () => {
    const config = loadConfig(validEnv);
    const redacted = toRedactedLog(config);
    expect(redacted.DATABASE_URL).toBe("***REDACTED***");
    expect(redacted.TELEGRAM_BOT_TOKEN).toBe("***REDACTED***");
    expect(redacted.PORT).toBe(3000);
    expect(redacted.LOG_LEVEL).toBe("info");
    expect(redacted.TELEGRAM_ALLOWLIST).toBe(validEnv.TELEGRAM_ALLOWLIST);
  });
});
