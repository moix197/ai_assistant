import type { Env } from "@hermes/config";
import { OAuth2Client } from "google-auth-library";

export interface GoogleOAuthClientBundle {
  oauthClient: OAuth2Client;
  cryptoKey: Buffer;
}

/**
 * Pure mapping from validated env to the `google-auth-library` client and
 * the decoded `TOKEN_ENCRYPTION_KEY` buffer `token-crypto.ts` needs. Lives
 * here, not in `@hermes/config` or `@hermes/google-auth`, because
 * `apps/hermes` is the one place allowed to depend on both `@hermes/config`
 * and the OAuth SDK directly — the same `build-provider-profiles.ts`
 * precedent (`config`'s flat env fields mapped into another package's
 * construction shape). `@hermes/google-auth` never imports `@hermes/config`.
 *
 * Returns `undefined` when the all-or-none Google key group is unset —
 * `envSchema`'s `superRefine` already guarantees the three keys are set
 * together or not at all, so checking one is sufficient. `TOKEN_ENCRYPTION_KEY`
 * has already been validated to decode to exactly 32 bytes at config load
 * time; this just performs that decode.
 */
export function buildGoogleOAuthClient(env: Env): GoogleOAuthClientBundle | undefined {
  if (
    env.GOOGLE_CLIENT_ID === undefined ||
    env.GOOGLE_CLIENT_SECRET === undefined ||
    env.TOKEN_ENCRYPTION_KEY === undefined
  ) {
    return undefined;
  }

  const oauthClient = new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.OAUTH_REDIRECT_BASE_URL}/oauth/callback`,
  });
  const cryptoKey = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64");

  return { oauthClient, cryptoKey };
}
