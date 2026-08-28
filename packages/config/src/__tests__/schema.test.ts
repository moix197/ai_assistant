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

const VALID_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

const validEnvWithGoogle = {
  ...validEnv,
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEY: VALID_TOKEN_ENCRYPTION_KEY,
};

describe("loadConfig — Google OAuth", () => {
  it("parses cleanly with all three Google keys unset — features absent, boot still succeeds", () => {
    const config = loadConfig(validEnv);
    expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(config.TOKEN_ENCRYPTION_KEY).toBeUndefined();
  });

  it("parses cleanly with all three Google keys set", () => {
    const config = loadConfig(validEnvWithGoogle);
    expect(config.GOOGLE_CLIENT_ID).toBe(validEnvWithGoogle.GOOGLE_CLIENT_ID);
    expect(config.GOOGLE_CLIENT_SECRET).toBe(validEnvWithGoogle.GOOGLE_CLIENT_SECRET);
    expect(config.TOKEN_ENCRYPTION_KEY).toBe(validEnvWithGoogle.TOKEN_ENCRYPTION_KEY);
  });

  it("fails naming the missing keys when only GOOGLE_CLIENT_ID is set", () => {
    const env = { ...validEnv, GOOGLE_CLIENT_ID: validEnvWithGoogle.GOOGLE_CLIENT_ID };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/GOOGLE_CLIENT_SECRET/);
  });

  it("fails naming the missing key when only GOOGLE_CLIENT_SECRET is set", () => {
    const env = { ...validEnv, GOOGLE_CLIENT_SECRET: validEnvWithGoogle.GOOGLE_CLIENT_SECRET };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it("fails naming the missing key when only TOKEN_ENCRYPTION_KEY is set", () => {
    const env = { ...validEnv, TOKEN_ENCRYPTION_KEY: VALID_TOKEN_ENCRYPTION_KEY };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it("fails naming the missing key when two of three Google keys are set", () => {
    const env = {
      ...validEnv,
      GOOGLE_CLIENT_ID: validEnvWithGoogle.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: validEnvWithGoogle.GOOGLE_CLIENT_SECRET,
    };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("fails naming TOKEN_ENCRYPTION_KEY when it decodes to the wrong byte length", () => {
    const env = {
      ...validEnvWithGoogle,
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64"),
    };
    expect(() => loadConfig(env)).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("fails naming TOKEN_ENCRYPTION_KEY when it is not valid base64", () => {
    const env = { ...validEnvWithGoogle, TOKEN_ENCRYPTION_KEY: "not base64!!! @@@" };
    expect(() => loadConfig(env)).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("accepts a base64url-encoded 32-byte TOKEN_ENCRYPTION_KEY", () => {
    const key = Buffer.alloc(32, 0xfb).toString("base64url");
    expect(key).toMatch(/[-_]/);
    const config = loadConfig({ ...validEnvWithGoogle, TOKEN_ENCRYPTION_KEY: key });
    expect(config.TOKEN_ENCRYPTION_KEY).toBe(key);
  });

  it("fails naming TOKEN_ENCRYPTION_KEY when a base64url value decodes to the wrong byte length", () => {
    const env = {
      ...validEnvWithGoogle,
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 0xfb).toString("base64url"),
    };
    expect(() => loadConfig(env)).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("fails naming TOKEN_ENCRYPTION_KEY when the two base64 alphabets are mixed", () => {
    const env = { ...validEnvWithGoogle, TOKEN_ENCRYPTION_KEY: "-/v7+_v7-/v7+_v7-/v7+_v7-/v7+_v7" };
    expect(() => loadConfig(env)).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("defaults OAUTH_REDIRECT_BASE_URL to http://localhost:3000 when unset", () => {
    const config = loadConfig(validEnv);
    expect(config.OAUTH_REDIRECT_BASE_URL).toBe("http://localhost:3000");
  });

  it("validates OAUTH_REDIRECT_BASE_URL independently of the Google key group", () => {
    const env = { ...validEnv, OAUTH_REDIRECT_BASE_URL: "not-a-url" };
    expect(() => loadConfig(env)).toThrow(/OAUTH_REDIRECT_BASE_URL/);
  });

  it("accepts an https OAUTH_REDIRECT_BASE_URL", () => {
    const config = loadConfig({ ...validEnv, OAUTH_REDIRECT_BASE_URL: "https://example.com" });
    expect(config.OAUTH_REDIRECT_BASE_URL).toBe("https://example.com");
  });

  it("accepts an http OAUTH_REDIRECT_BASE_URL on localhost and 127.0.0.1", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
      expect(
        loadConfig({ ...validEnv, OAUTH_REDIRECT_BASE_URL: url }).OAUTH_REDIRECT_BASE_URL,
      ).toBe(url);
    }
  });

  it("fails naming OAUTH_REDIRECT_BASE_URL when http is used for a non-loopback host", () => {
    const env = { ...validEnv, OAUTH_REDIRECT_BASE_URL: "http://example.com" };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/OAUTH_REDIRECT_BASE_URL/);
    expect(() => loadConfig(env)).toThrow(/https/);
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
