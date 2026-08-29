import type { ToolSpec } from "@hermes/agent";
import { type GoogleAccountRepo, IDENTITY_SCOPES } from "@hermes/google-auth";
import { z } from "zod/v4";
import type { ScopedToolSpec } from "../with-required-scopes";
import { withRequiredScopes } from "../with-required-scopes";

/**
 * `{ ok: true, email }` is the only shape this handler ever returns —
 * `withRequiredScopes` has already rejected an unconnected or under-scoped
 * account before this handler runs at all, and hands the already-fetched
 * account through `ctx.googleAccount` — so this handler makes no database
 * call of its own, it just projects the email off the account it was given.
 */
type WhoamiSuccess = { ok: true; email: string };

/**
 * Identity check: "who am I connected as?" — the exit-criterion tool for
 * `04-google-auth`. Reads no row itself: `ctx.googleAccount` is the
 * `google_accounts` row `withRequiredScopes` already fetched and verified
 * this same call. Makes no live Google API call. `requiresApproval: false`
 * — a pure, idempotent read of an identity already consented to, not a
 * consequence (settled decision 3).
 */
function createBaseWhoamiTool(): ScopedToolSpec {
  return {
    name: "whoami",
    description:
      "Reports the Google account this chat is currently connected as, if any. Takes no arguments.",
    schema: z.object({}),
    handler: async (_args, ctx): Promise<WhoamiSuccess> => {
      return { ok: true, email: ctx.googleAccount.googleEmail };
    },
    requiresApproval: false,
  };
}

/**
 * `whoami` wrapped in `withRequiredScopes`, gating on `IDENTITY_SCOPES` —
 * the pattern the Sheets tools (Phase 4/5) lean on, proven here first
 * against a tool that already works. Uses `ctx.channel`/`ctx.channelUserId`
 * — never a hardcoded constant, via the decorator — so this tool works
 * under whatever channel `AgentDefinition` eventually adds beyond Telegram.
 * `googleAccountRepo` is only ever read by the decorator now: one
 * `getAccount` call per invocation, not two.
 */
export function createWhoamiTool(googleAccountRepo: GoogleAccountRepo): ToolSpec {
  return withRequiredScopes("whoami", {
    googleAccountRepo,
    requiredScopes: IDENTITY_SCOPES,
  })(createBaseWhoamiTool());
}
