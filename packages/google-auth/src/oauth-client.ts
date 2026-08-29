import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";

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
 * authorization is the state nonce plus PKCE"). `include_granted_scopes:
 * true` (the SDK's `boolean` option, serialized onto the authorize URL as
 * the literal query value `"true"`) makes Google's response the
 * authoritative accumulation: a user who already granted identity and now
 * runs `/connect google sheets` gets back the *cumulative* grant in the
 * token response's `scope`, so `completeConnect` never has to union scopes
 * across connects itself (settled decision 8).
 */
export function buildAuthUrl(client: OAuth2Client, options: BuildAuthUrlOptions): string {
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: options.scopes,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    include_granted_scopes: true,
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
  /**
   * What Google actually **granted**, parsed from the token response's
   * space-delimited `scope` — never the list Hermes asked for. Google's
   * granular-consent screen lets a user deselect individual checkboxes, so
   * the requested set is only a request; this is the authoritative answer,
   * and the only thing worth persisting on the account row.
   */
  grantedScopes: string[];
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
    grantedScopes: tokens.scope?.split(" ").filter((scope) => scope !== "") ?? [],
  };
}

export interface RefreshedAccessToken {
  accessToken: string;
  expiresAt: Date;
}

/**
 * The port `refresh.ts`'s coordinator depends on: a refresh token in, a fresh
 * access token out. A function type this package owns, so the coordinator is
 * decoupled from `google-auth-library` entirely and its tests fake *this*
 * rather than standing in for an SDK-internal method — the same
 * ports-and-injection idiom `GoogleAccountRepo`/`ThreadRepo`/`LlmUsageRepo`
 * already follow.
 */
export type RefreshAccessTokenPort = (refreshToken: string) => Promise<RefreshedAccessToken>;

/**
 * The production adapter. Builds a throwaway `OAuth2Client` per call and uses
 * the public `refreshAccessToken()` on it: that method reads and writes
 * `this.credentials`, which is exactly why it must not be called on a client
 * shared between accounts — a per-call instance has no shared state to race
 * on. Constructing one is field assignment plus `super(opts)`, no I/O.
 *
 * This replaces an earlier cast that reached around `OAuth2Client`'s
 * `protected refreshToken()`; the SDK marks that method `@private` in its own
 * JSDoc, so it is a real API boundary, not a mere visibility annotation.
 */
export function createGoogleRefreshAccessToken(client: OAuth2Client): RefreshAccessTokenPort {
  const clientId = client._clientId;
  const clientSecret = client._clientSecret;

  return async function refreshAccessToken(refreshToken: string): Promise<RefreshedAccessToken> {
    const perCallClient = new OAuth2Client({ clientId, clientSecret });
    perCallClient.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await perCallClient.refreshAccessToken();

    if (!credentials.access_token) {
      throw new Error("refreshAccessToken: response carried no access_token");
    }
    if (!credentials.expiry_date) {
      throw new Error("refreshAccessToken: response carried no expiry_date");
    }
    return { accessToken: credentials.access_token, expiresAt: new Date(credentials.expiry_date) };
  };
}
