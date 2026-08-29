import type { GoogleAccount, GoogleAccountRepo } from "@hermes/google-auth";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import type { ScopedToolContext, ScopedToolSpec } from "../with-required-scopes";
import { withRequiredScopes } from "../with-required-scopes";

const CTX = { signal: new AbortController().signal, channel: "telegram", channelUserId: "111" };
const IDENTITY_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"];
const SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

function fakeAccount(overrides: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    channel: "telegram",
    channelUserId: "111",
    chatId: "555",
    googleEmail: "person@example.com",
    scopes: IDENTITY_SCOPES,
    tokenEnvelope: { v: 1, iv: "iv", tag: "tag", ct: "ct" },
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeRepo(account: GoogleAccount | undefined): GoogleAccountRepo {
  return {
    getAccount: vi.fn().mockResolvedValue(account),
    upsertAccount: vi.fn(),
    deleteAccount: vi.fn(),
  };
}

function fakeSpec(
  handler: ScopedToolSpec["handler"] = vi
    .fn()
    .mockResolvedValue({ ok: true, value: "real result" }),
): ScopedToolSpec {
  return {
    name: "some-tool",
    description: "a fake tool",
    schema: z.object({}),
    handler,
    requiresApproval: false,
  };
}

describe("withRequiredScopes", () => {
  it("connected and scoped: wrapped handler runs and its result passes through unchanged", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, value: "real result" });
    const spec = fakeSpec(handler);
    const repo = fakeRepo(fakeAccount());
    const gated = withRequiredScopes("some-tool", {
      googleAccountRepo: repo,
      requiredScopes: IDENTITY_SCOPES,
    })(spec);

    const result = await gated.handler({}, CTX);

    expect(result).toEqual({ ok: true, value: "real result" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fetches the account exactly once and threads it through ctx.googleAccount to the wrapped handler", async () => {
    const account = fakeAccount();
    const handler = vi.fn().mockResolvedValue({ ok: true, value: "real result" });
    const spec = fakeSpec(handler);
    const repo = fakeRepo(account);
    const gated = withRequiredScopes("some-tool", {
      googleAccountRepo: repo,
      requiredScopes: IDENTITY_SCOPES,
    })(spec);

    await gated.handler({}, CTX);

    expect(repo.getAccount).toHaveBeenCalledTimes(1);
    const [, ctxSeenByHandler] = handler.mock.calls[0] as [unknown, ScopedToolContext];
    expect(ctxSeenByHandler.googleAccount).toEqual(account);
    expect(ctxSeenByHandler.channel).toBe("telegram");
    expect(ctxSeenByHandler.channelUserId).toBe("111");
  });

  it("not connected: returns structured not_connected, wrapped handler is never invoked", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, value: "should never run" });
    const spec = fakeSpec(handler);
    const repo = fakeRepo(undefined);
    const gated = withRequiredScopes("some-tool", {
      googleAccountRepo: repo,
      requiredScopes: IDENTITY_SCOPES,
    })(spec);

    const result = await gated.handler({}, CTX);

    expect(result).toEqual({ ok: false, reason: "not_connected" });
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it("connected but missing scope, gating on identity: returns missing_scope with a fix pointing at bare /connect google, wrapped handler never invoked", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, value: "should never run" });
    const spec = fakeSpec(handler);
    const repo = fakeRepo(fakeAccount({ scopes: ["some-other-scope"] }));
    const gated = withRequiredScopes("some-tool", {
      googleAccountRepo: repo,
      requiredScopes: IDENTITY_SCOPES,
    })(spec);

    const result = await gated.handler({}, CTX);

    expect(result).toEqual({
      ok: false,
      reason: "missing_scope",
      scope: IDENTITY_SCOPES.join(" "),
      fix: "run /connect google",
    });
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it("connected but missing scope, gating on Sheets: returns missing_scope with a fix pointing at /connect google sheets, wrapped handler never invoked", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, value: "should never run" });
    const spec = fakeSpec(handler);
    const repo = fakeRepo(fakeAccount({ scopes: IDENTITY_SCOPES }));
    const gated = withRequiredScopes("some-tool", {
      googleAccountRepo: repo,
      requiredScopes: [...IDENTITY_SCOPES, ...SHEETS_SCOPES],
    })(spec);

    const result = await gated.handler({}, CTX);

    expect(result).toEqual({
      ok: false,
      reason: "missing_scope",
      scope: [...IDENTITY_SCOPES, ...SHEETS_SCOPES].join(" "),
      fix: "run /connect google sheets",
    });
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it("preserves every other ToolSpec field unchanged", () => {
    const spec = fakeSpec();
    const repo = fakeRepo(undefined);
    const gated = withRequiredScopes("some-tool", {
      googleAccountRepo: repo,
      requiredScopes: IDENTITY_SCOPES,
    })(spec);

    expect(gated.name).toBe("some-tool");
    expect(gated.description).toBe("a fake tool");
    expect(gated.schema).toBe(spec.schema);
    expect(gated.requiresApproval).toBe(false);
  });

  it("throws at decoration time when toolName doesn't match the wrapped spec's name", () => {
    const spec = fakeSpec();
    const repo = fakeRepo(undefined);

    expect(() =>
      withRequiredScopes("a-different-tool-name", {
        googleAccountRepo: repo,
        requiredScopes: IDENTITY_SCOPES,
      })(spec),
    ).toThrow(/a-different-tool-name/);
  });
});
