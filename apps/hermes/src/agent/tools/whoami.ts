import type { ToolSpec } from "@hermes/agent";
import { type GoogleAccountRepo, IDENTITY_SCOPES, hasRequiredScopes } from "@hermes/google-auth";
import { z } from "zod/v4";

/**
 * `{ ok: false, reason: "..." }` on any failure path, never a throw — the
 * model relays these verbatim as "you're not connected, try /connect
 * google" or the missing-scope equivalent (`.ai/decisions/
 * google-oauth-flow.md`, settled decision 3's worked example). `scope` on
 * the missing-scope branch is a single space-joined string, not an array —
 * matches the shape `runTurn`'s `invokeTool` serializes non-string tool
 * results through (`JSON.stringify`), and reads cleanly relayed as text.
 */
type WhoamiResult =
  | { ok: true; email: string }
  | { ok: false; reason: "not_connected" }
  | {
      ok: false;
      reason: "missing_scope";
      scope: string;
    };

/**
 * Identity check: "who am I connected as?" — the exit-criterion tool for
 * `04-google-auth`. Reads the `google_accounts` row already captured at
 * `/connect google` time; makes no live Google API call. `requiresApproval:
 * false` — a pure, idempotent read of an identity already consented to, not
 * a consequence (settled decision 3). Every account today requests
 * `IDENTITY_SCOPES` unconditionally, so the `missing_scope` branch is
 * unreachable via `/connect` this phase — it is still a real, executed
 * check (not a hollow always-true assertion), since it is the exact pattern
 * `TOOL_REQUIRED_SCOPES` establishes for later phases' partial-consent
 * tools. Uses `ctx.channel`/`ctx.channelUserId` — never a hardcoded
 * constant, so this tool works under whatever channel `AgentDefinition`
 * eventually adds beyond Telegram.
 */
export function createWhoamiTool(googleAccountRepo: GoogleAccountRepo): ToolSpec {
  return {
    name: "whoami",
    description:
      "Reports the Google account this chat is currently connected as, if any. Takes no arguments.",
    schema: z.object({}),
    handler: async (_args, ctx): Promise<WhoamiResult> => {
      const account = await googleAccountRepo.getAccount(ctx.channel, ctx.channelUserId);
      if (!account) {
        return { ok: false, reason: "not_connected" };
      }
      if (!hasRequiredScopes(account.scopes, IDENTITY_SCOPES)) {
        return { ok: false, reason: "missing_scope", scope: IDENTITY_SCOPES.join(" ") };
      }
      return { ok: true, email: account.googleEmail };
    },
    requiresApproval: false,
  };
}
