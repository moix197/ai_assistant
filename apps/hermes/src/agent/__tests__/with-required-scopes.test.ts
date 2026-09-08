import type { GoogleAccount, GoogleAccountRepo } from "@hermes/google-auth";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import type { ScopedToolContext, ScopedToolSpec } from "../with-required-scopes";
import { withRequiredScopes } from "../with-required-scopes";

const CTX = {
  signal: new AbortController().signal,
  channel: "telegram",
  channelUserId: "111",
  turnId: "turn-1",
  plan: undefined,
};
const IDENTITY_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"];
const SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"];
const GMAIL_READ_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const GMAIL_WRITE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

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

function fakeSpecWithPrepare(
  prepare: NonNullable<ScopedToolSpec["prepare"]> = vi.fn().mockResolvedValue({
    ok: true,
    plan: undefined,
    summary: { action: "¿Hacer algo?", effects: [] },
  }),
  handler: ScopedToolSpec["handler"] = vi
    .fn()
    .mockResolvedValue({ ok: true, value: "real result" }),
): ScopedToolSpec {
  return {
    name: "some-tool",
    description: "a fake tool with prepare",
    schema: z.object({}),
    handler,
    requiresApproval: true,
    prepare,
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

  it("connected but missing scope, gating on Calendar: returns missing_scope with a fix pointing at /connect google calendar, wrapped handler never invoked", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, value: "should never run" });
    const spec = fakeSpec(handler);
    const repo = fakeRepo(fakeAccount({ scopes: IDENTITY_SCOPES }));
    const gated = withRequiredScopes("some-tool", {
      googleAccountRepo: repo,
      requiredScopes: [...IDENTITY_SCOPES, ...CALENDAR_SCOPES],
    })(spec);

    const result = await gated.handler({}, CTX);

    expect(result).toEqual({
      ok: false,
      reason: "missing_scope",
      scope: [...IDENTITY_SCOPES, ...CALENDAR_SCOPES].join(" "),
      fix: "run /connect google calendar",
    });
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it("connected but missing scope, gating on Gmail read: returns missing_scope with a fix pointing at /connect google gmail, wrapped handler never invoked", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, value: "should never run" });
    const spec = fakeSpec(handler);
    const repo = fakeRepo(fakeAccount({ scopes: IDENTITY_SCOPES }));
    const gated = withRequiredScopes("some-tool", {
      googleAccountRepo: repo,
      requiredScopes: [...IDENTITY_SCOPES, ...GMAIL_READ_SCOPES],
    })(spec);

    const result = await gated.handler({}, CTX);

    expect(result).toEqual({
      ok: false,
      reason: "missing_scope",
      scope: [...IDENTITY_SCOPES, ...GMAIL_READ_SCOPES].join(" "),
      fix: "run /connect google gmail",
    });
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it("connected but missing scope, gating on the full Gmail write tier: returns missing_scope with a fix pointing at /connect google gmail-send, wrapped handler never invoked", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, value: "should never run" });
    const spec = fakeSpec(handler);
    const repo = fakeRepo(fakeAccount({ scopes: IDENTITY_SCOPES }));
    const gated = withRequiredScopes("some-tool", {
      googleAccountRepo: repo,
      requiredScopes: [...IDENTITY_SCOPES, ...GMAIL_WRITE_SCOPES],
    })(spec);

    const result = await gated.handler({}, CTX);

    expect(result).toEqual({
      ok: false,
      reason: "missing_scope",
      scope: [...IDENTITY_SCOPES, ...GMAIL_WRITE_SCOPES].join(" "),
      fix: "run /connect google gmail-send",
    });
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it("connected but missing scope, gating on Gmail write (gmail.modify only, e.g. gmail_archive/gmail_label): returns missing_scope with a fix pointing at /connect google gmail-send, wrapped handler never invoked", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, value: "should never run" });
    const spec = fakeSpec(handler);
    const repo = fakeRepo(fakeAccount({ scopes: IDENTITY_SCOPES }));
    const gmailModifyScope = "https://www.googleapis.com/auth/gmail.modify";
    const gated = withRequiredScopes("some-tool", {
      googleAccountRepo: repo,
      requiredScopes: [gmailModifyScope],
    })(spec);

    const result = await gated.handler({}, CTX);

    expect(result).toEqual({
      ok: false,
      reason: "missing_scope",
      scope: gmailModifyScope,
      fix: "run /connect google gmail-send",
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

  it("forwards timeoutMs onto the gated ToolSpec unchanged", () => {
    const spec = fakeSpec();
    spec.timeoutMs = 30_000;
    const repo = fakeRepo(undefined);
    const gated = withRequiredScopes("some-tool", {
      googleAccountRepo: repo,
      requiredScopes: IDENTITY_SCOPES,
    })(spec);

    expect(gated.timeoutMs).toBe(30_000);
  });

  it("leaves timeoutMs undefined on the gated ToolSpec when the wrapped spec doesn't set it", () => {
    const spec = fakeSpec();
    const repo = fakeRepo(undefined);
    const gated = withRequiredScopes("some-tool", {
      googleAccountRepo: repo,
      requiredScopes: IDENTITY_SCOPES,
    })(spec);

    expect(gated.timeoutMs).toBeUndefined();
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

  describe("prepare (06-legible-approvals-bounded-reads Phase 3)", () => {
    it("does not add a prepare to the gated ToolSpec when the wrapped spec declares none — the whitelist must never invent one", () => {
      const spec = fakeSpec();
      const repo = fakeRepo(fakeAccount());
      const gated = withRequiredScopes("some-tool", {
        googleAccountRepo: repo,
        requiredScopes: IDENTITY_SCOPES,
      })(spec);

      expect(gated.prepare).toBeUndefined();
    });

    it("connected and scoped: forwards a declared prepare through the decorator, and its result passes through unchanged — the named regression test (the whitelist previously dropped prepare by omission)", async () => {
      const prepare = vi.fn().mockResolvedValue({
        ok: true,
        plan: { resolvedId: "abc" },
        summary: { action: "¿Hacer algo?", effects: [] },
      });
      const spec = fakeSpecWithPrepare(prepare);
      const repo = fakeRepo(fakeAccount());
      const gated = withRequiredScopes("some-tool", {
        googleAccountRepo: repo,
        requiredScopes: IDENTITY_SCOPES,
      })(spec);

      const result = await gated.prepare?.({}, CTX);

      expect(result).toEqual({
        ok: true,
        plan: { resolvedId: "abc" },
        summary: { action: "¿Hacer algo?", effects: [] },
      });
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    it("fetches the account exactly once and threads it through ctx.googleAccount to the wrapped prepare, same as handler", async () => {
      const account = fakeAccount();
      const prepare = vi.fn().mockResolvedValue({
        ok: true,
        plan: undefined,
        summary: { action: "¿Hacer algo?", effects: [] },
      });
      const spec = fakeSpecWithPrepare(prepare);
      const repo = fakeRepo(account);
      const gated = withRequiredScopes("some-tool", {
        googleAccountRepo: repo,
        requiredScopes: IDENTITY_SCOPES,
      })(spec);

      await gated.prepare?.({}, CTX);

      expect(repo.getAccount).toHaveBeenCalledTimes(1);
      const [, ctxSeenByPrepare] = prepare.mock.calls[0] as [unknown, ScopedToolContext];
      expect(ctxSeenByPrepare.googleAccount).toEqual(account);
    });

    it("not connected: prepare itself refuses with structured not_connected, the wrapped prepare is never invoked", async () => {
      const prepare = vi.fn().mockResolvedValue({
        ok: true,
        plan: undefined,
        summary: { action: "should never run", effects: [] },
      });
      const spec = fakeSpecWithPrepare(prepare);
      const repo = fakeRepo(undefined);
      const gated = withRequiredScopes("some-tool", {
        googleAccountRepo: repo,
        requiredScopes: IDENTITY_SCOPES,
      })(spec);

      const result = await gated.prepare?.({}, CTX);

      expect(result).toEqual({ ok: false, result: { ok: false, reason: "not_connected" } });
      expect(prepare).not.toHaveBeenCalled();
    });

    it("missing scope: prepare itself refuses with structured missing_scope, the wrapped prepare is never invoked — no approval prompt is ever built for a call already destined to fail", async () => {
      const prepare = vi.fn().mockResolvedValue({
        ok: true,
        plan: undefined,
        summary: { action: "should never run", effects: [] },
      });
      const spec = fakeSpecWithPrepare(prepare);
      const repo = fakeRepo(fakeAccount({ scopes: ["some-other-scope"] }));
      const gated = withRequiredScopes("some-tool", {
        googleAccountRepo: repo,
        requiredScopes: IDENTITY_SCOPES,
      })(spec);

      const result = await gated.prepare?.({}, CTX);

      expect(result).toEqual({
        ok: false,
        result: {
          ok: false,
          reason: "missing_scope",
          scope: IDENTITY_SCOPES.join(" "),
          fix: "run /connect google",
        },
      });
      expect(prepare).not.toHaveBeenCalled();
    });
  });
});
