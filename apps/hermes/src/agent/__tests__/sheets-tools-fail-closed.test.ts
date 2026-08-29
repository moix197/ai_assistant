import type { GoogleAccount, GoogleAccountRepo } from "@hermes/google-auth";
import { IDENTITY_SCOPES, SHEETS_SCOPES } from "@hermes/google-auth";
import type { AccessTokenPort, SheetRegistryPort, SheetsClient } from "@hermes/google-sheets";
import { createSheetsInspectTool, createSheetsReadTool } from "@hermes/google-sheets";
import { describe, expect, it, vi } from "vitest";
import { withRequiredScopes } from "../with-required-scopes";

/**
 * Code-review fix (Phase 4): the plan's own Step demands a real fail-closed
 * proof — "the fake Sheets HTTP client (or `AccessTokenPort`) is a spy that
 * must be called exactly zero times" for an unconnected account and for a
 * connected-but-under-scoped (identity-only) account — mirroring
 * `with-required-scopes.test.ts`'s rigor (Phase 2). `build-agent.test.ts`'s
 * existing assertion only proves nothing is called on a turn that never
 * invokes a Sheets tool at all, which is a different (and much weaker)
 * claim. These tests wrap the real `createSheetsInspectTool`/
 * `createSheetsReadTool` in the real `withRequiredScopes` — the exact
 * composition `build-agent.ts` wires — and invoke the gated handler
 * directly.
 */

const CTX = {
  signal: new AbortController().signal,
  channel: "telegram",
  channelUserId: "111",
  turnId: "turn-1",
};

function fakeAccount(overrides: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    channel: "telegram",
    channelUserId: "111",
    chatId: "555",
    googleEmail: "person@example.com",
    scopes: IDENTITY_SCOPES,
    tokenEnvelope: { v: 1, iv: "iv", tag: "tag", ct: "ct" },
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
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

interface FakeSheetsDeps {
  sheetRegistry: SheetRegistryPort;
  accessTokenPort: AccessTokenPort & { getAccessToken: ReturnType<typeof vi.fn> };
  sheetsClient: SheetsClient & {
    getSpreadsheetMeta: ReturnType<typeof vi.fn>;
    getValues: ReturnType<typeof vi.fn>;
  };
}

function fakeSheetsDeps(): FakeSheetsDeps {
  return {
    sheetRegistry: { getBySlug: vi.fn(), listAll: vi.fn() },
    accessTokenPort: { getAccessToken: vi.fn() },
    sheetsClient: { getSpreadsheetMeta: vi.fn(), getValues: vi.fn() },
  };
}

function expectZeroApiCalls(deps: FakeSheetsDeps): void {
  expect(deps.accessTokenPort.getAccessToken).not.toHaveBeenCalled();
  expect(deps.sheetsClient.getSpreadsheetMeta).not.toHaveBeenCalled();
  expect(deps.sheetsClient.getValues).not.toHaveBeenCalled();
}

describe("Sheets tools — fail-closed gating (real proof, not assumption)", () => {
  describe("sheets_inspect", () => {
    it("unconnected account: refused before any accessTokenPort or sheetsClient call", async () => {
      const deps = fakeSheetsDeps();
      const gated = withRequiredScopes("sheets_inspect", {
        googleAccountRepo: fakeRepo(undefined),
        requiredScopes: SHEETS_SCOPES,
      })(createSheetsInspectTool(deps));

      const result = await gated.handler({ sheet: "appointments" }, CTX);

      expect(result).toEqual({ ok: false, reason: "not_connected" });
      expectZeroApiCalls(deps);
    });

    it("connected but identity-only (no Sheets scope): refused before any accessTokenPort or sheetsClient call", async () => {
      const deps = fakeSheetsDeps();
      const gated = withRequiredScopes("sheets_inspect", {
        googleAccountRepo: fakeRepo(fakeAccount()),
        requiredScopes: SHEETS_SCOPES,
      })(createSheetsInspectTool(deps));

      const result = await gated.handler({ sheet: "appointments" }, CTX);

      expect(result).toEqual({
        ok: false,
        reason: "missing_scope",
        scope: SHEETS_SCOPES.join(" "),
        fix: "run /connect google sheets",
      });
      expectZeroApiCalls(deps);
    });
  });

  describe("sheets_read", () => {
    it("unconnected account: refused before any accessTokenPort or sheetsClient call", async () => {
      const deps = fakeSheetsDeps();
      const gated = withRequiredScopes("sheets_read", {
        googleAccountRepo: fakeRepo(undefined),
        requiredScopes: SHEETS_SCOPES,
      })(createSheetsReadTool(deps));

      const result = await gated.handler(
        { sheet: "appointments", range: "A1:B2", valueRenderOption: "FORMATTED_VALUE" },
        CTX,
      );

      expect(result).toEqual({ ok: false, reason: "not_connected" });
      expectZeroApiCalls(deps);
    });

    it("connected but identity-only (no Sheets scope): refused before any accessTokenPort or sheetsClient call", async () => {
      const deps = fakeSheetsDeps();
      const gated = withRequiredScopes("sheets_read", {
        googleAccountRepo: fakeRepo(fakeAccount()),
        requiredScopes: SHEETS_SCOPES,
      })(createSheetsReadTool(deps));

      const result = await gated.handler(
        { sheet: "appointments", range: "A1:B2", valueRenderOption: "FORMATTED_VALUE" },
        CTX,
      );

      expect(result).toEqual({
        ok: false,
        reason: "missing_scope",
        scope: SHEETS_SCOPES.join(" "),
        fix: "run /connect google sheets",
      });
      expectZeroApiCalls(deps);
    });
  });
});
