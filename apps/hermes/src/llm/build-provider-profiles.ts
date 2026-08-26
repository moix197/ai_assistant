import type { Env } from "@hermes/config";
import type { ProviderProfile } from "@hermes/llm";

export interface ProviderProfiles {
  primary: ProviderProfile;
  fallback?: ProviderProfile;
}

/**
 * Pure mapping from validated env to `ProviderProfile`s. Lives here, not in
 * `@hermes/config` or `@hermes/llm`, because `apps/hermes` is the one place
 * allowed to depend on both: `config` owns the flat `LLM_PRIMARY_*` /
 * `LLM_FALLBACK_*` env fields, `llm` owns the `ProviderProfile` shape they
 * map into. `config` and `llm` stay mutually independent — neither imports
 * the other.
 */
export function buildProviderProfiles(env: Env): ProviderProfiles {
  const primary: ProviderProfile = {
    baseUrl: env.LLM_PRIMARY_BASE_URL,
    apiKey: env.LLM_PRIMARY_API_KEY,
    model: env.LLM_PRIMARY_MODEL,
  };

  const fallback = buildFallbackProfile(env);
  return fallback ? { primary, fallback } : { primary };
}

/**
 * `envSchema`'s `superRefine` already guarantees all three `LLM_FALLBACK_*`
 * keys are set together or not at all, so checking any one of them here is
 * sufficient to detect "fallback configured".
 */
function buildFallbackProfile(env: Env): ProviderProfile | undefined {
  if (
    env.LLM_FALLBACK_BASE_URL === undefined ||
    env.LLM_FALLBACK_API_KEY === undefined ||
    env.LLM_FALLBACK_MODEL === undefined
  ) {
    return undefined;
  }

  return {
    baseUrl: env.LLM_FALLBACK_BASE_URL,
    apiKey: env.LLM_FALLBACK_API_KEY,
    model: env.LLM_FALLBACK_MODEL,
  };
}
