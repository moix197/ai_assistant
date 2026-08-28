import { CodeChallengeMethod, type OAuth2Client } from "google-auth-library";

export interface BuildAuthUrlOptions {
  scopes: string[];
  state: string;
  codeChallenge: string;
}

/**
 * `access_type: "offline"` + `prompt: "consent"` so a refresh token comes
 * back on every connect, not only the account's first-ever consent — a
 * reconnect after a revoked/expired token must yield a fresh refresh token
 * too. PKCE (`code_challenge`/`S256`) rides alongside `state`; neither
 * substitutes for the other (Dependencies & Risks: "the callback's
 * authorization is the state nonce plus PKCE").
 */
export function buildAuthUrl(client: OAuth2Client, options: BuildAuthUrlOptions): string {
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: options.scopes,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });
}

export interface ExchangeCodeOptions {
  code: string;
  verifier: string;
}

export interface ExchangeCodeResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  idTokenClaims: Record<string, unknown>;
}

/**
 * Decodes an ID token's payload without verifying its signature. Safe here
 * specifically because this ID token is never client-supplied: it arrives
 * only in the direct server-to-server response from Google's token endpoint
 * (`client.getToken`, over TLS, authenticated with the client secret) — the
 * exact channel `verifyIdToken`'s signature check exists to substitute for
 * when a token instead arrives via the browser/a third party. There is no
 * such third party in this path.
 */
function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  const payloadSegment = idToken.split(".")[1];
  if (!payloadSegment) {
    throw new Error("exchangeCode: malformed id_token (no payload segment)");
  }
  const json = Buffer.from(payloadSegment, "base64url").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Exchanges the authorization `code` for tokens using the PKCE `verifier`
 * recorded at `/connect` time — never logs or returns `code` itself (see
 * `connect-flow.ts`).
 */
export async function exchangeCode(
  client: OAuth2Client,
  options: ExchangeCodeOptions,
): Promise<ExchangeCodeResult> {
  const { tokens } = await client.getToken({
    code: options.code,
    codeVerifier: options.verifier,
  });

  if (!tokens.access_token) throw new Error("exchangeCode: response carried no access_token");
  if (!tokens.refresh_token) throw new Error("exchangeCode: response carried no refresh_token");
  if (!tokens.expiry_date) throw new Error("exchangeCode: response carried no expiry_date");
  if (!tokens.id_token) throw new Error("exchangeCode: response carried no id_token");

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(tokens.expiry_date),
    idTokenClaims: decodeIdTokenClaims(tokens.id_token),
  };
}

export interface RefreshedAccessToken {
  accessToken: string;
  expiresAt: Date;
}

/**
 * `OAuth2Client.refreshToken(refreshToken)` is the one SDK call that takes an
 * explicit refresh token and returns fresh credentials **without** mutating
 * the client's own `credentials` field — unlike the public
 * `refreshAccessToken()`/`getAccessToken()`, which read/write `this.credentials`
 * on the shared client instance and would race if `refresh.ts`'s single-flight
 * coordinator (keyed per-account, not per-client) ever refreshed two accounts
 * through the same `OAuth2Client` concurrently. It's typed `protected` in
 * `google-auth-library` — an SDK-internal visibility marker, not a documented
 * public/private API boundary (`refreshTokenNoCache`, which it delegates to,
 * performs no `this.credentials` read or write) — so this narrow, documented
 * reach-around is safer than the shared-mutable-state alternative the public
 * methods force.
 */
export async function refreshAccessToken(
  client: OAuth2Client,
  refreshToken: string,
): Promise<RefreshedAccessToken> {
  const refreshable = client as unknown as {
    refreshToken(refreshToken?: string | null): Promise<{
      tokens: { access_token?: string | null; expiry_date?: number | null };
    }>;
  };
  const { tokens } = await refreshable.refreshToken(refreshToken);

  if (!tokens.access_token) throw new Error("refreshAccessToken: response carried no access_token");
  if (!tokens.expiry_date) throw new Error("refreshAccessToken: response carried no expiry_date");

  return { accessToken: tokens.access_token, expiresAt: new Date(tokens.expiry_date) };
}
