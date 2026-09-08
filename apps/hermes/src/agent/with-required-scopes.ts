import type { ToolContext, ToolPreparation, ToolSpec } from "@hermes/agent";
import {
  CALENDAR_SCOPES,
  GMAIL_READ_SCOPES,
  type GoogleAccount,
  type GoogleAccountRepo,
  SHEETS_SCOPES,
  hasRequiredScopes,
} from "@hermes/google-auth";

/**
 * The ctx a scoped tool's handler/`prepare` receives — the base `ToolContext`
 * plus the account `withRequiredScopes` already fetched and verified.
 * Carrying it through here means a scoped handler never re-reads the row
 * itself: one `getAccount` call per invocation, not two.
 */
export type ScopedToolContext = ToolContext & { readonly googleAccount: GoogleAccount };

/**
 * A `ToolSpec` whose `handler`/`prepare` expect the richer `ScopedToolContext`
 * instead of the base one — never assigned directly to `ToolSpec`'s slots
 * (the base type's `ctx` doesn't have `googleAccount`, and TS's contravariant
 * parameter checking correctly rejects that). `withRequiredScopes` is the
 * only place that bridges the two: it builds the extended ctx itself and
 * calls the wrapped function with it, so the bridge is type-safe with no
 * cast. `P` mirrors `ToolSpec<P>`'s own plan type — `void` for a tool with no
 * `prepare`.
 */
export interface ScopedToolSpec<P = void> {
  name: string;
  description: string;
  schema: ToolSpec["schema"];
  handler: (args: unknown, ctx: ScopedToolContext & { plan: P }) => Promise<unknown>;
  requiresApproval: boolean;
  /** Forwarded verbatim onto the gated `ToolSpec` — see `ToolSpec.timeoutMs`. `undefined` keeps the 10s default. */
  timeoutMs?: number;
  /** Forwarded, wrapped the same way `handler` is — see `decorate()` below. */
  prepare?(args: unknown, ctx: ScopedToolContext): Promise<ToolPreparation<P>>;
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
 * wrong sub-command. An ordered table of `{ scopes, command }` tiers, checked
 * in order: the first tier sharing any scope with `requiredScopes` wins,
 * falling back to bare identity (`/connect google`) when none match.
 */
const CONNECT_COMMAND_TIERS: ReadonlyArray<{ scopes: readonly string[]; command: string }> = [
  { scopes: CALENDAR_SCOPES, command: "run /connect google calendar" },
  { scopes: SHEETS_SCOPES, command: "run /connect google sheets" },
  { scopes: GMAIL_READ_SCOPES, command: "run /connect google gmail" },
];

function describeConnectCommand(requiredScopes: string[]): string {
  const tier = CONNECT_COMMAND_TIERS.find((entry) =>
    requiredScopes.some((scope) => entry.scopes.includes(scope)),
  );
  return tier?.command ?? "run /connect google";
}

/**
 * The connected-account + required-scope check shared by `handler`'s and
 * `prepare`'s wraps below — fetches the account **once** per invocation and
 * returns either it or the exact structured refusal `ScopeGateFailure`
 * shape, so neither wrap duplicates the not-connected/missing-scope
 * decision logic.
 */
async function checkScopeGate(
  deps: WithRequiredScopesDeps,
  ctx: ToolContext,
): Promise<{ ok: true; account: GoogleAccount } | { ok: false; failure: ScopeGateFailure }> {
  const account = await deps.googleAccountRepo.getAccount(ctx.channel, ctx.channelUserId);
  if (!account) {
    return { ok: false, failure: { ok: false, reason: "not_connected" } };
  }
  if (!hasRequiredScopes(account.scopes, deps.requiredScopes)) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "missing_scope",
        scope: deps.requiredScopes.join(" "),
        fix: describeConnectCommand(deps.requiredScopes),
      },
    };
  }
  return { ok: true, account };
}

/**
 * Wraps a `ScopedToolSpec`'s `handler` (and, when declared, `prepare`)
 * behind a connected-account + required-scope check, run before either ever
 * executes — no token fetched, no API call on either failure branch
 * (fail-closed, ROADMAP invariant 7). `whoami` is refactored onto this
 * decorator to prove the pattern against a tool that already works, before
 * the Sheets tools (Phase 4/5) lean on it for their own gating. `deps.
 * requiredScopes` is supplied by the caller, not derived here — for the
 * Sheets tools, `apps/hermes/src/agent/build-agent.ts` reads it from
 * `TOOL_REQUIRED_SCOPES` (`packages/google-auth/src/scopes.ts`) per tool
 * name, so each tool's scope requirement is declared in that one map, not
 * duplicated at each `withRequiredScopes` call site.
 *
 * `prepare` is wrapped the same way `handler` is — not deferred to a later
 * phase (`06-legible-approvals-bounded-reads` Phase 3, settled per that
 * plan's Dependencies & Risks): a missing account or missing scope
 * short-circuits `prepare` itself, returning the identical refusal shapes
 * `handler`'s wrap already produces, just reachable one step earlier — an
 * under-scoped user is never shown an approval prompt for a call already
 * destined to fail.
 *
 * Fetches the account **once** per invocation: on success it's threaded
 * into the wrapped function's `ctx.googleAccount` rather than re-fetched — a
 * scoped handler/`prepare` never calls `googleAccountRepo.getAccount` itself.
 *
 * `toolName` is asserted against `spec.name` at decoration time (construction,
 * not per-call) — a mismatch means `requiredScopes` was wired to the wrong
 * tool, and that is exactly the class of bug worth failing fast on rather
 * than silently gating the wrong tool with the wrong scopes.
 */
export function withRequiredScopes<P = void>(
  toolName: string,
  deps: WithRequiredScopesDeps,
): (spec: ScopedToolSpec<P>) => ToolSpec<P> {
  return function decorate(spec: ScopedToolSpec<P>): ToolSpec<P> {
    if (spec.name !== toolName) {
      throw new Error(
        `withRequiredScopes("${toolName}") wrapped a tool named "${spec.name}" — required scopes must be wired to the tool they gate`,
      );
    }

    const prepare = spec.prepare;

    return {
      name: spec.name,
      description: spec.description,
      schema: spec.schema,
      requiresApproval: spec.requiresApproval,
      timeoutMs: spec.timeoutMs,
      handler: async (args: unknown, ctx: ToolContext & { plan: P }): Promise<unknown> => {
        const gate = await checkScopeGate(deps, ctx);
        if (!gate.ok) return gate.failure;
        return spec.handler(args, { ...ctx, googleAccount: gate.account });
      },
      ...(prepare && {
        prepare: async (args: unknown, ctx: ToolContext): Promise<ToolPreparation<P>> => {
          const gate = await checkScopeGate(deps, ctx);
          if (!gate.ok) return { ok: false, result: gate.failure };
          return prepare(args, { ...ctx, googleAccount: gate.account });
        },
      }),
    };
  };
}
