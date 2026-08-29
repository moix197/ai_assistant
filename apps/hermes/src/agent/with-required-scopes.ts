import type { ToolSpec } from "@hermes/agent";
import {
  type GoogleAccount,
  type GoogleAccountRepo,
  SHEETS_SCOPES,
  hasRequiredScopes,
} from "@hermes/google-auth";

type ToolContext = Parameters<ToolSpec["handler"]>[1];

/**
 * The ctx a scoped tool's handler receives — the base `ToolContext` plus the
 * account `withRequiredScopes` already fetched and verified. Carrying it
 * through here means a scoped handler never re-reads the row itself: one
 * `getAccount` call per tool invocation, not two.
 */
export type ScopedToolContext = ToolContext & { readonly googleAccount: GoogleAccount };

/**
 * A `ToolSpec` whose `handler` expects the richer `ScopedToolContext` instead
 * of the base one — never assigned directly to `ToolSpec.handler` (the base
 * type's `ctx` doesn't have `googleAccount`, and TS's contravariant
 * parameter checking correctly rejects that). `withRequiredScopes` is the
 * only place that bridges the two: it builds the extended ctx itself and
 * calls this handler with it, so the bridge is type-safe with no cast.
 */
export interface ScopedToolSpec {
  name: string;
  description: string;
  schema: ToolSpec["schema"];
  handler: (args: unknown, ctx: ScopedToolContext) => Promise<unknown>;
  requiresApproval: boolean;
  /** Forwarded verbatim onto the gated `ToolSpec` — see `ToolSpec.timeoutMs`. `undefined` keeps the 10s default. */
  timeoutMs?: number;
}

export interface WithRequiredScopesDeps {
  googleAccountRepo: GoogleAccountRepo;
  requiredScopes: string[];
}

/** The gate's own structured failure shapes — never a throw, so the model relays them as chat text. */
export type ScopeGateFailure =
  | { ok: false; reason: "not_connected" }
  | { ok: false; reason: "missing_scope"; scope: string; fix: string };

/**
 * The `/connect` invocation that would grant `requiredScopes` — derived, not
 * assumed, so a future scoped tool gating on identity alone (or on some
 * later incremental scope) doesn't inherit a `fix` message that names the
 * wrong sub-command. Today there are exactly two tiers: identity alone
 * (`/connect google`) and identity plus Sheets (`/connect google sheets`);
 * anything requiring a Sheets scope needs the latter.
 */
function describeConnectCommand(requiredScopes: string[]): string {
  const needsSheets = requiredScopes.some((scope) => SHEETS_SCOPES.includes(scope));
  return needsSheets ? "run /connect google sheets" : "run /connect google";
}

/**
 * Wraps a `ScopedToolSpec`'s `handler` behind a connected-account +
 * required-scope check, run before the wrapped handler ever executes — no
 * token fetched, no API call on either failure branch (fail-closed, ROADMAP
 * invariant 7). This is `TOOL_REQUIRED_SCOPES`'s first real read path
 * (`packages/google-auth/src/scopes.ts` seeded that map since
 * `04-google-auth` with nothing consulting it): `whoami` is refactored onto
 * this decorator to prove the pattern against a tool that already works,
 * before the Sheets tools (Phase 4/5) lean on it for their own gating.
 *
 * Fetches the account **once**: on success it's threaded into the wrapped
 * handler's `ctx.googleAccount` rather than re-fetched — a scoped handler
 * never calls `googleAccountRepo.getAccount` itself.
 *
 * `toolName` is asserted against `spec.name` at decoration time (construction,
 * not per-call) — a mismatch means `requiredScopes` was wired to the wrong
 * tool, and that is exactly the class of bug worth failing fast on rather
 * than silently gating the wrong tool with the wrong scopes.
 */
export function withRequiredScopes(
  toolName: string,
  deps: WithRequiredScopesDeps,
): (spec: ScopedToolSpec) => ToolSpec {
  return function decorate(spec: ScopedToolSpec): ToolSpec {
    if (spec.name !== toolName) {
      throw new Error(
        `withRequiredScopes("${toolName}") wrapped a tool named "${spec.name}" — required scopes must be wired to the tool they gate`,
      );
    }

    return {
      name: spec.name,
      description: spec.description,
      schema: spec.schema,
      requiresApproval: spec.requiresApproval,
      timeoutMs: spec.timeoutMs,
      handler: async (args: unknown, ctx: ToolContext): Promise<unknown> => {
        const account = await deps.googleAccountRepo.getAccount(ctx.channel, ctx.channelUserId);
        if (!account) {
          return { ok: false, reason: "not_connected" } satisfies ScopeGateFailure;
        }
        if (!hasRequiredScopes(account.scopes, deps.requiredScopes)) {
          return {
            ok: false,
            reason: "missing_scope",
            scope: deps.requiredScopes.join(" "),
            fix: describeConnectCommand(deps.requiredScopes),
          } satisfies ScopeGateFailure;
        }
        return spec.handler(args, { ...ctx, googleAccount: account });
      },
    };
  };
}
