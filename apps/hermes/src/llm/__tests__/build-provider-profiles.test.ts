import type { Env } from "@hermes/config";
import { describe, expect, it } from "vitest";
import { buildProviderProfiles } from "../build-provider-profiles";

const baseEnv: Env = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/hermes",
  PORT: 3000,
  LOG_LEVEL: "info",
  TELEGRAM_BOT_TOKEN: "123456:FAKE-TOKEN-abcDEF",
  TELEGRAM_ALLOWLIST: "",
  LLM_PRIMARY_BASE_URL: "https://primary.example/v1",
  LLM_PRIMARY_API_KEY: "primary-key",
  LLM_PRIMARY_MODEL: "primary-model",
  LLM_MONTHLY_BUDGET_USD: 100,
  OAUTH_REDIRECT_BASE_URL: "http://localhost:3000",
};

describe("buildProviderProfiles", () => {
  it("maps the primary env fields to a primary profile, fallback undefined when absent", () => {
    const profiles = buildProviderProfiles(baseEnv);

    expect(profiles).toEqual({
      primary: {
        baseUrl: "https://primary.example/v1",
        apiKey: "primary-key",
        model: "primary-model",
      },
    });
    expect(profiles.fallback).toBeUndefined();
  });

  it("maps both primary and fallback env fields when fallback is present", () => {
    const env: Env = {
      ...baseEnv,
      LLM_FALLBACK_BASE_URL: "https://fallback.example/v1",
      LLM_FALLBACK_API_KEY: "fallback-key",
      LLM_FALLBACK_MODEL: "fallback-model",
    };

    const profiles = buildProviderProfiles(env);

    expect(profiles).toEqual({
      primary: {
        baseUrl: "https://primary.example/v1",
        apiKey: "primary-key",
        model: "primary-model",
      },
      fallback: {
        baseUrl: "https://fallback.example/v1",
        apiKey: "fallback-key",
        model: "fallback-model",
      },
    });
  });
});
