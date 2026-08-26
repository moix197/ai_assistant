import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, toRedactedLog } from "../load";

const validEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/hermes",
  PORT: "3000",
  LOG_LEVEL: "info",
  TELEGRAM_BOT_TOKEN: "123456:FAKE-TOKEN-abcDEF",
  TELEGRAM_ALLOWLIST: "111,222",
  LLM_PRIMARY_BASE_URL: "https://primary.example/v1",
  LLM_PRIMARY_API_KEY: "primary-key",
  LLM_PRIMARY_MODEL: "primary-model",
};

const validEnvWithFallback = {
  ...validEnv,
  LLM_FALLBACK_BASE_URL: "https://fallback.example/v1",
  LLM_FALLBACK_API_KEY: "fallback-key",
  LLM_FALLBACK_MODEL: "fallback-model",
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
      LLM_PRIMARY_BASE_URL: validEnv.LLM_PRIMARY_BASE_URL,
      LLM_PRIMARY_API_KEY: validEnv.LLM_PRIMARY_API_KEY,
      LLM_PRIMARY_MODEL: validEnv.LLM_PRIMARY_MODEL,
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

describe("loadConfig — LLM provider profiles", () => {
  it("parses a valid primary-only config with fallback undefined", () => {
    const config = loadConfig(validEnv);
    expect(config.LLM_PRIMARY_BASE_URL).toBe(validEnv.LLM_PRIMARY_BASE_URL);
    expect(config.LLM_PRIMARY_API_KEY).toBe(validEnv.LLM_PRIMARY_API_KEY);
    expect(config.LLM_PRIMARY_MODEL).toBe(validEnv.LLM_PRIMARY_MODEL);
    expect(config.LLM_FALLBACK_BASE_URL).toBeUndefined();
    expect(config.LLM_FALLBACK_API_KEY).toBeUndefined();
    expect(config.LLM_FALLBACK_MODEL).toBeUndefined();
  });

  it("parses a valid primary+fallback config with both populated", () => {
    const config = loadConfig(validEnvWithFallback);
    expect(config.LLM_FALLBACK_BASE_URL).toBe(validEnvWithFallback.LLM_FALLBACK_BASE_URL);
    expect(config.LLM_FALLBACK_API_KEY).toBe(validEnvWithFallback.LLM_FALLBACK_API_KEY);
    expect(config.LLM_FALLBACK_MODEL).toBe(validEnvWithFallback.LLM_FALLBACK_MODEL);
  });

  it("fails naming the missing key when only one of three LLM_FALLBACK_* keys is set", () => {
    const env = { ...validEnv, LLM_FALLBACK_BASE_URL: "https://fallback.example/v1" };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/LLM_FALLBACK_API_KEY/);
  });

  it("fails naming the missing key when two of three LLM_FALLBACK_* keys are set", () => {
    const env = {
      ...validEnv,
      LLM_FALLBACK_BASE_URL: "https://fallback.example/v1",
      LLM_FALLBACK_API_KEY: "fallback-key",
    };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/LLM_FALLBACK_MODEL/);
  });

  it("fails naming LLM_PRIMARY_BASE_URL when missing", () => {
    const { LLM_PRIMARY_BASE_URL: _omit, ...rest } = validEnv;
    expect(() => loadConfig(rest)).toThrow(/LLM_PRIMARY_BASE_URL/);
  });

  it("fails naming LLM_PRIMARY_API_KEY when missing", () => {
    const { LLM_PRIMARY_API_KEY: _omit, ...rest } = validEnv;
    expect(() => loadConfig(rest)).toThrow(/LLM_PRIMARY_API_KEY/);
  });

  it("fails naming LLM_PRIMARY_MODEL when missing", () => {
    const { LLM_PRIMARY_MODEL: _omit, ...rest } = validEnv;
    expect(() => loadConfig(rest)).toThrow(/LLM_PRIMARY_MODEL/);
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

  it("masks LLM_PRIMARY_API_KEY and LLM_FALLBACK_API_KEY, leaves base URL and model intact", () => {
    const config = loadConfig(validEnvWithFallback);
    const redacted = toRedactedLog(config);
    expect(redacted.LLM_PRIMARY_API_KEY).toBe("***REDACTED***");
    expect(redacted.LLM_FALLBACK_API_KEY).toBe("***REDACTED***");
    expect(redacted.LLM_PRIMARY_BASE_URL).toBe(validEnvWithFallback.LLM_PRIMARY_BASE_URL);
    expect(redacted.LLM_PRIMARY_MODEL).toBe(validEnvWithFallback.LLM_PRIMARY_MODEL);
  });

  it("masks a set secret as REDACTED without leaking its real value", () => {
    const config = loadConfig(validEnvWithFallback);
    const redacted = toRedactedLog(config);
    expect(redacted.LLM_FALLBACK_API_KEY).toBe("***REDACTED***");
    expect(redacted.LLM_FALLBACK_API_KEY).not.toBe(validEnvWithFallback.LLM_FALLBACK_API_KEY);
    expect(JSON.stringify(redacted)).not.toContain(validEnvWithFallback.LLM_FALLBACK_API_KEY);
  });

  it("omits an unset secret entirely instead of logging it as REDACTED", () => {
    const config = loadConfig(validEnv);
    const redacted = toRedactedLog(config);
    expect(redacted.LLM_FALLBACK_API_KEY).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain("LLM_FALLBACK_API_KEY");
  });
});
