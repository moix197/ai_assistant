import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, toRedactedLog } from "../load";

const validEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/hermes",
  PORT: "3000",
  LOG_LEVEL: "info",
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

  it("applies defaults for PORT and LOG_LEVEL when omitted", () => {
    const config = loadConfig({ DATABASE_URL: validEnv.DATABASE_URL });
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe("info");
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
});

describe("toRedactedLog", () => {
  it("masks DATABASE_URL and leaves other fields intact", () => {
    const config = loadConfig(validEnv);
    const redacted = toRedactedLog(config);
    expect(redacted.DATABASE_URL).toBe("***REDACTED***");
    expect(redacted.PORT).toBe(3000);
    expect(redacted.LOG_LEVEL).toBe("info");
  });
});
