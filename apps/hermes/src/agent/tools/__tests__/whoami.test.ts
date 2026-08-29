import { createAgent } from "@hermes/agent";
import type { GoogleAccount, GoogleAccountRepo } from "@hermes/google-auth";
import { describe, expect, it, vi } from "vitest";
import { createWhoamiTool } from "../whoami";

const CTX = {
  signal: new AbortController().signal,
  channel: "telegram",
  channelUserId: "111",
  turnId: "turn-1",
  plan: undefined,
};

function fakeAccount(overrides: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    channel: "telegram",
    channelUserId: "111",
    chatId: "555",
    googleEmail: "person@example.com",
    scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
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

describe("whoami tool", () => {
  it("carries the right identity and requires no approval", () => {
    const whoamiTool = createWhoamiTool(fakeRepo(undefined));
    expect(whoamiTool.name).toBe("whoami");
    expect(whoamiTool.requiresApproval).toBe(false);
  });

  it("declares a schema that takes no arguments", () => {
    const whoamiTool = createWhoamiTool(fakeRepo(undefined));
    expect(whoamiTool.schema.safeParse({}).success).toBe(true);
    expect(whoamiTool.schema.safeParse("not an object").success).toBe(false);
  });

  it("returns { ok: true, email } for a connected account holding the identity scope", async () => {
    const repo = fakeRepo(fakeAccount());
    const whoamiTool = createWhoamiTool(repo);

    const result = await whoamiTool.handler({}, CTX);

    expect(result).toEqual({ ok: true, email: "person@example.com" });
    expect(repo.getAccount).toHaveBeenCalledWith("telegram", "111");
    // withRequiredScopes fetches the account once, on the gate check, and
    // threads it through ctx.googleAccount — whoami's own handler must not
    // read it again.
    expect(repo.getAccount).toHaveBeenCalledTimes(1);
  });

  it("returns { ok: false, reason: 'not_connected' }, never a throw, when no account exists", async () => {
    const repo = fakeRepo(undefined);
    const whoamiTool = createWhoamiTool(repo);

    const result = await whoamiTool.handler({}, CTX);

    expect(result).toEqual({ ok: false, reason: "not_connected" });
  });

  // The "connected but missing identity scope" case (previously unreachable
  // via `/connect`, per `04-google-auth`'s own note) is now exercised once,
  // generically, by `with-required-scopes.test.ts` — this decorator is the
  // thing that produces that branch now, not `whoami.ts` itself.

  it("never trips createAgent's assertApprovalGateConfigured — requiresApproval: false needs no approvalGate at construction", () => {
    const whoamiTool = createWhoamiTool(fakeRepo(undefined));

    expect(() =>
      createAgent(
        {
          name: "hermes",
          model: "some-model",
          systemPrompt: "system",
          tools: [whoamiTool],
          channels: ["telegram"],
        },
        {
          llmProvider: { complete: vi.fn() },
          threadRepo: { getOrCreateThread: vi.fn(), appendMessages: vi.fn() },
          signal: new AbortController().signal,
        },
      ),
    ).not.toThrow();
  });

  it("reads ctx.channel/ctx.channelUserId, not a hardcoded constant", async () => {
    const repo = fakeRepo(fakeAccount({ channel: "other-channel", channelUserId: "999" }));
    const whoamiTool = createWhoamiTool(repo);

    await whoamiTool.handler(
      {},
      {
        signal: new AbortController().signal,
        channel: "other-channel",
        channelUserId: "999",
        turnId: "turn-1",
        plan: undefined,
      },
    );

    expect(repo.getAccount).toHaveBeenCalledWith("other-channel", "999");
  });
});
