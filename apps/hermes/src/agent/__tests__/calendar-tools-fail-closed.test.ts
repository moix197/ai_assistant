import type { GoogleAccount, GoogleAccountRepo } from "@hermes/google-auth";
import { CALENDAR_SCOPES, IDENTITY_SCOPES } from "@hermes/google-auth";
import type { AccessTokenPort, CalendarClient, CalendarToolDeps } from "@hermes/google-calendar";
import { createCalendarListEventsTool } from "@hermes/google-calendar";
import { describe, expect, it, vi } from "vitest";
import { withRequiredScopes } from "../with-required-scopes";

/**
 * Mirrors `sheets-tools-fail-closed.test.ts`: a real fail-closed proof —
 * an account with only identity scopes (or no account at all) gets the
 * `missing_scope`/`not_connected` refusal with `fix: "run /connect google
 * calendar"` from `list_events`, and the fake `AccessTokenPort`/
 * `CalendarClient` are spies that must be called exactly zero times. Wraps
 * the real `createCalendarListEventsTool` in the real `withRequiredScopes` —
 * the exact composition `build-agent.ts` wires — and invokes the gated
 * handler directly.
 */

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

interface FakeCalendarDeps {
  accessTokenPort: AccessTokenPort & { getAccessToken: ReturnType<typeof vi.fn> };
  calendarClient: CalendarClient & {
    getPrimaryCalendarTimeZone: ReturnType<typeof vi.fn>;
    listEvents: ReturnType<typeof vi.fn>;
  };
}

function fakeCalendarDeps(): FakeCalendarDeps {
  return {
    accessTokenPort: { getAccessToken: vi.fn() },
    calendarClient: {
      getPrimaryCalendarTimeZone: vi.fn(),
      listEvents: vi.fn(),
      getEvent: vi.fn(),
      queryFreeBusy: vi.fn(),
      insertEvent: vi.fn(),
      patchEvent: vi.fn(),
      deleteEvent: vi.fn(),
    },
  };
}

function expectZeroApiCalls(deps: FakeCalendarDeps): void {
  expect(deps.accessTokenPort.getAccessToken).not.toHaveBeenCalled();
  expect(deps.calendarClient.getPrimaryCalendarTimeZone).not.toHaveBeenCalled();
  expect(deps.calendarClient.listEvents).not.toHaveBeenCalled();
}

describe("Calendar tools — fail-closed gating (real proof, not assumption)", () => {
  describe("list_events", () => {
    it("unconnected account: refused before any accessTokenPort or calendarClient call", async () => {
      const deps: CalendarToolDeps = fakeCalendarDeps();
      const gated = withRequiredScopes("list_events", {
        googleAccountRepo: fakeRepo(undefined),
        requiredScopes: CALENDAR_SCOPES,
      })(createCalendarListEventsTool(deps));

      const result = await gated.handler({ relativeDay: "tomorrow" }, CTX);

      expect(result).toEqual({ ok: false, reason: "not_connected" });
      expectZeroApiCalls(deps as FakeCalendarDeps);
    });

    it("connected but identity-only (no Calendar scope): refused before any accessTokenPort or calendarClient call, fix points at /connect google calendar", async () => {
      const deps: CalendarToolDeps = fakeCalendarDeps();
      const gated = withRequiredScopes("list_events", {
        googleAccountRepo: fakeRepo(fakeAccount()),
        requiredScopes: CALENDAR_SCOPES,
      })(createCalendarListEventsTool(deps));

      const result = await gated.handler({ relativeDay: "tomorrow" }, CTX);

      expect(result).toEqual({
        ok: false,
        reason: "missing_scope",
        scope: CALENDAR_SCOPES.join(" "),
        fix: "run /connect google calendar",
      });
      expectZeroApiCalls(deps as FakeCalendarDeps);
    });
  });
});
