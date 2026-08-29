import type { Clock } from "@hermes/core";
import { OAuth2Client } from "google-auth-library";
import { describe, expect, it, vi } from "vitest";
import type { GoogleAccount, GoogleAccountRepo } from "../account-repo-port";
import { createConnectFlow } from "../connect-flow";
import { buildAuthUrl } from "../oauth-client";
import { createPendingConnectionStore } from "../pending-connections";
import { IDENTITY_SCOPES } from "../scopes";
import { openToken } from "../token-crypto";

const CRYPTO_KEY = Buffer.alloc(32, 7);
const FIXED_CLOCK: Clock = { now: () => new Date("2026-08-28T00:00:00.000Z") };

function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}

const GRANTED_ALL = IDENTITY_SCOPES.join(" ");

function fakeOAuthClient(overrides?: {
  getToken?: OAuth2Client["getToken"];
  grantedScope?: string;
}): OAuth2Client {
  return {
    generateAuthUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth?fake=1"),
    getToken:
      overrides?.getToken ??
      vi.fn(async () => ({
        tokens: {
          access_token: "fake-access-token",
          refresh_token: "fake-refresh-token",
          expiry_date: Date.now() + 3600_000,
          id_token: fakeIdToken({ email: "person@example.com" }),
          scope: overrides?.grantedScope ?? GRANTED_ALL,
        },
        res: null,
      })),
  } as unknown as OAuth2Client;
}

function fakeRepo(): GoogleAccountRepo & { accounts: GoogleAccount[] } {
  const accounts: GoogleAccount[] = [];
  return {
    accounts,
    getAccount: vi.fn(async (channel, channelUserId) =>
      accounts.find((a) => a.channel === channel && a.channelUserId === channelUserId),
    ),
    upsertAccount: vi.fn(async (account) => {
      accounts.push(account);
    }),
    deleteAccount: vi.fn(async () => {}),
  };
}

describe("createConnectFlow", () => {
  it("completes a connect started with the right state and code", async () => {
    const repo = fakeRepo();
    const oauthClient = fakeOAuthClient();
    const flow = createConnectFlow({
      oauthClient,
      repo,
      cryptoKey: CRYPTO_KEY,
      pendingStore: createPendingConnectionStore(FIXED_CLOCK),
      clock: FIXED_CLOCK,
    });

    const { state, url } = flow.startConnect("telegram", "user-1", "chat-1", ["openid"]);
    expect(url).toContain("https://accounts.google.com");

    const result = await flow.completeConnect(state, "fake-auth-code");

    expect(result).toEqual({ ok: true, email: "person@example.com", chatId: "chat-1" });
    expect(repo.upsertAccount).toHaveBeenCalledTimes(1);
    const [persisted] = repo.accounts;
    if (!persisted) throw new Error("expected repo.upsertAccount to have persisted an account");
    expect(persisted.channel).toBe("telegram");
    expect(persisted.channelUserId).toBe("user-1");
    expect(persisted.googleEmail).toBe("person@example.com");
    // Granted, not requested: `startConnect` asked for `["openid"]` alone.
    expect(persisted.scopes).toEqual(IDENTITY_SCOPES);

    // Sealed, never plaintext.
    expect(JSON.stringify(persisted.tokenEnvelope)).not.toContain("fake-access-token");
    expect(JSON.stringify(persisted.tokenEnvelope)).not.toContain("fake-refresh-token");
    const opened = JSON.parse(openToken(persisted.tokenEnvelope, CRYPTO_KEY));
    expect(opened).toEqual({
      accessToken: "fake-access-token",
      refreshToken: "fake-refresh-token",
    });
  });

  it("persists only what Google granted, even when it is narrower than the request", async () => {
    const repo = fakeRepo();
    const flow = createConnectFlow({
      oauthClient: fakeOAuthClient({
        grantedScope: `${GRANTED_ALL} https://www.googleapis.com/auth/gmail.readonly`,
      }),
      repo,
      cryptoKey: CRYPTO_KEY,
      pendingStore: createPendingConnectionStore(FIXED_CLOCK),
      clock: FIXED_CLOCK,
    });

    const { state } = flow.startConnect("telegram", "user-1", "chat-1", IDENTITY_SCOPES);
    await flow.completeConnect(state, "code");

    const [persisted] = repo.accounts;
    expect(persisted?.scopes).toEqual([
      ...IDENTITY_SCOPES,
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });

  it("persists the account on a partial grant (identity only) when Sheets was also requested, flagging the shortfall", async () => {
    const repo = fakeRepo();
    const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
    const flow = createConnectFlow({
      oauthClient: fakeOAuthClient({ grantedScope: GRANTED_ALL }),
      repo,
      cryptoKey: CRYPTO_KEY,
      pendingStore: createPendingConnectionStore(FIXED_CLOCK),
      clock: FIXED_CLOCK,
    });

    const { state } = flow.startConnect("telegram", "user-1", "chat-1", [
      ...IDENTITY_SCOPES,
      SHEETS_SCOPE,
    ]);
    const result = await flow.completeConnect(state, "code");

    expect(result).toEqual({
      ok: true,
      email: "person@example.com",
      chatId: "chat-1",
      missingScopes: [SHEETS_SCOPE],
    });
    expect(repo.upsertAccount).toHaveBeenCalledTimes(1);
    expect(repo.accounts[0]?.scopes).toEqual(IDENTITY_SCOPES);
  });

  it("rejects a grant missing an identity scope and persists nothing", async () => {
    const repo = fakeRepo();
    const flow = createConnectFlow({
      oauthClient: fakeOAuthClient({ grantedScope: "openid" }),
      repo,
      cryptoKey: CRYPTO_KEY,
      pendingStore: createPendingConnectionStore(FIXED_CLOCK),
      clock: FIXED_CLOCK,
    });

    const { state } = flow.startConnect("telegram", "user-1", "chat-1", IDENTITY_SCOPES);
    const result = await flow.completeConnect(state, "code");

    expect(result).toEqual({ ok: false, reason: "missing_scopes" });
    expect(repo.upsertAccount).not.toHaveBeenCalled();
  });

  it("treats a token response carrying no scope at all as missing_scopes", async () => {
    const repo = fakeRepo();
    const flow = createConnectFlow({
      oauthClient: fakeOAuthClient({ grantedScope: "" }),
      repo,
      cryptoKey: CRYPTO_KEY,
      pendingStore: createPendingConnectionStore(FIXED_CLOCK),
      clock: FIXED_CLOCK,
    });

    const { state } = flow.startConnect("telegram", "user-1", "chat-1", IDENTITY_SCOPES);
    const result = await flow.completeConnect(state, "code");

    expect(result).toEqual({ ok: false, reason: "missing_scopes" });
    expect(repo.upsertAccount).not.toHaveBeenCalled();
  });

  it("rejects an unknown state with invalid_state", async () => {
    const flow = createConnectFlow({
      oauthClient: fakeOAuthClient(),
      repo: fakeRepo(),
      cryptoKey: CRYPTO_KEY,
      pendingStore: createPendingConnectionStore(FIXED_CLOCK),
      clock: FIXED_CLOCK,
    });

    const result = await flow.completeConnect("never-issued", "code");

    expect(result).toEqual({ ok: false, reason: "invalid_state" });
  });

  it("rejects an expired state with invalid_state", async () => {
    let now = new Date("2026-08-28T00:00:00.000Z");
    const clock: Clock = { now: () => now };
    const flow = createConnectFlow({
      oauthClient: fakeOAuthClient(),
      repo: fakeRepo(),
      cryptoKey: CRYPTO_KEY,
      pendingStore: createPendingConnectionStore(clock),
      clock,
    });

    const { state } = flow.startConnect("telegram", "user-1", "chat-1", ["openid"]);
    now = new Date(now.getTime() + 10 * 60_000 + 1);

    const result = await flow.completeConnect(state, "code");

    expect(result).toEqual({ ok: false, reason: "invalid_state" });
  });

  it("rejects a replayed state with the same invalid_state result", async () => {
    const flow = createConnectFlow({
      oauthClient: fakeOAuthClient(),
      repo: fakeRepo(),
      cryptoKey: CRYPTO_KEY,
      pendingStore: createPendingConnectionStore(FIXED_CLOCK),
      clock: FIXED_CLOCK,
    });

    const { state } = flow.startConnect("telegram", "user-1", "chat-1", ["openid"]);
    const first = await flow.completeConnect(state, "code");
    expect(first.ok).toBe(true);

    const replay = await flow.completeConnect(state, "code");

    expect(replay).toEqual({ ok: false, reason: "invalid_state" });
  });

  it("propagates a repo.upsertAccount failure rather than swallowing it", async () => {
    const repo = fakeRepo();
    repo.upsertAccount = vi.fn(async () => {
      throw new Error("db is down");
    });
    const flow = createConnectFlow({
      oauthClient: fakeOAuthClient(),
      repo,
      cryptoKey: CRYPTO_KEY,
      pendingStore: createPendingConnectionStore(FIXED_CLOCK),
      clock: FIXED_CLOCK,
    });

    const { state } = flow.startConnect("telegram", "user-1", "chat-1", ["openid"]);

    await expect(flow.completeConnect(state, "code")).rejects.toThrow("db is down");
  });
});

describe("buildAuthUrl", () => {
  it("includes the literal include_granted_scopes=true query param, alongside every other existing option unchanged", () => {
    const client = new OAuth2Client({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      redirectUri: "https://hermes.example.com/oauth/callback",
    });

    const url = buildAuthUrl(client, {
      scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
      state: "state-1",
      codeChallenge: "challenge-1",
    });

    const params = new URL(url).searchParams;
    expect(params.get("include_granted_scopes")).toBe("true");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("state")).toBe("state-1");
    expect(params.get("code_challenge")).toBe("challenge-1");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("scope")).toBe("openid https://www.googleapis.com/auth/userinfo.email");
  });
});
