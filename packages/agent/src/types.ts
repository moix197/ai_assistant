import type { z } from "zod/v4";
import type { ApprovalSummary } from "./approval-gate-port";

/** Reused, not redefined — `@hermes/core`'s `Message` is the one shared conversation-turn shape every package agrees on. */
export type { Message } from "@hermes/core";

/**
 * The ctx every tool's `handler` (with `plan` added, see `ToolSpec`) and
 * `prepare` (without it — `prepare` is what *produces* a plan, so it never
 * receives one) share. Exported by name so every consumer references the
 * identical type instead of re-deriving an inline shape (e.g.
 * `apps/hermes/src/agent/with-required-scopes.ts` used to alias its own
 * `Parameters<ToolSpec["handler"]>[1]` before this phase).
 */
export interface ToolContext {
  signal: AbortSignal;
  channel: string;
  channelUserId: string;
  turnId: string;
}

/**
 * `ToolSpec.prepare`'s result. `ok: false` refuses the call outright — no
 * approval prompt is ever sent, and `result` becomes the call's tool-result
 * content, the same as if the handler itself had returned it (a tool's own
 * domain-specific refusal shape, e.g. `sheets_write`'s `unknown_sheet` —
 * never a bespoke "prepare" code of its own). `ok: true` carries `plan` —
 * threaded onto `ctx.plan` for the eventual `handler` call — and `summary`,
 * the legible, generic description shown to the human in place of raw JSON.
 */
export type ToolPreparation<P> =
  | { ok: false; result: unknown }
  | { ok: true; plan: P; summary: ApprovalSummary };

/**
 * A tool made available to the model. `schema` is a `zod/v4` schema — its
 * JSON Schema is derived once, deterministically, by `assemblePrefix`
 * (`prompt.ts`). No mutable `register()`: tools are supplied once, at
 * `AgentDefinition` construction, because registration-order nondeterminism
 * would threaten the byte-stable prefix invariant #6 depends on.
 *
 * `P` is the shape of the plan a declared `prepare` hook resolves — `void`
 * for a tool with no `prepare` (every tool before this phase, and every
 * ungated tool in this codebase today). `ctx.plan` is still present on
 * `handler`'s ctx in that case, just typed `void` and always `undefined` at
 * runtime — "no plan" is a value, never an absent property, which is what
 * makes a handler reading a plan that was never computed a type error
 * instead of a silent `undefined` read.
 */
export interface ToolSpec<P = void> {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  /**
   * `ctx.channel`/`ctx.channelUserId` identify who is asking — threaded
   * through from `runTurn`'s own `channel`/`channelUserId` parameters (the
   * latter itself threaded from `Agent.handleMessage`). `whoami`
   * (`apps/hermes/src/agent/tools/whoami.ts`, `04-google-auth` Phase 3) is
   * the first tool that needs this: a required-field widening of this
   * contract, not an additive one, so every existing `ctx` literal
   * (including in tests that invoke a handler directly) must supply both.
   * `ctx.turnId` (`05-google-sheets` Phase 4) widens the contract the same
   * way, for `sheets_write`'s dedupe key (Phase 5) — `loop.ts` always knew
   * the turn's id, it just never forwarded it into the handler's `ctx`
   * before now. `ctx.plan` (`06-legible-approvals-bounded-reads` Phase 3)
   * widens it once more, the same way — see the type-level doc above.
   */
  handler: (args: unknown, ctx: ToolContext & { plan: P }) => Promise<unknown>;
  /**
   * Gates this tool behind the approval flow: `true` routes the call through
   * `runGatedToolCalls`, which requires `RunTurnDeps.approvalGate` (enforced
   * at construction via `assertApprovalGateConfigured`). `echoTool`
   * (`apps/hermes/src/agent/tools/echo.ts`) is the one tool that sets this.
   */
  requiresApproval: boolean;
  /**
   * Overrides `loop.ts`'s default handler timeout (10s, see
   * `TOOL_HANDLER_TIMEOUT_MS`) for this one tool — a real outbound HTTP call
   * (e.g. `sheets_inspect`/`sheets_read`, `05-google-sheets` Phase 4) can
   * legitimately take longer than a local computation, especially once its
   * own internal retries are counted. Costs UX when set high (settled
   * decision 14): a turn can stall up to this many ms with the user watching
   * a silent chat. ROADMAP invariant 9 ("every loop bounded") still holds —
   * the bound is explicit and finite, just larger than the default. Also
   * bounds a declared `prepare` call, via the identical race (settled — no
   * new timeout surface for `prepare`). `undefined` (every existing tool)
   * keeps the 10s default unchanged.
   */
  timeoutMs?: number;
  /**
   * Resolves this call's plan/approval-summary before the gate ever asks a
   * human (`packages/agent/src/loop.ts`'s `prepareGatedCall`) — declared
   * only by a gated tool that needs to show something more legible than raw
   * JSON, or that can refuse outright before the prompt (e.g. an unknown
   * target). Raced against the same `timeoutMs ?? TOOL_HANDLER_TIMEOUT_MS`
   * bound the handler itself uses; a throw, a timeout, an abort mid-flight,
   * or an `{ok:false}` result are all "refused" the same way — no prompt is
   * ever sent for that call, and it resolves immediately with `{ok:false,
   * reason:"prepare_failed"}` (throw/timeout/abort) or the tool's own
   * `result` (`{ok:false}`).
   */
  prepare?(args: unknown, ctx: ToolContext): Promise<ToolPreparation<P>>;
}

// biome-ignore lint/suspicious/noExplicitAny: the one accepted escape hatch at the heterogeneous tool-registry boundary — variance on `P` (contravariant in `handler`'s ctx, covariant in `ToolPreparation`'s `plan`) makes a precise array/map type impractical; every tool factory still returns and is authored against its own concrete `ToolSpec<ConcretePlan>`.
export type AnyToolSpec = ToolSpec<any>;

/**
 * The one configuration object per agent — the D4 multi-agent seam
 * (settled decision 10): reserved, not built. `createAgent` takes one
 * `AgentDefinition`, not a list; `apps/hermes` constructs exactly one at
 * boot (`build-agent.ts`). Agent #2 is a second `createAgent` call plus
 * whatever decides which agent a message goes to — not "one more list
 * entry" — see `.ai/decisions/agent-multi-agent-seam.md`. `packages/agent`
 * never imports a feature package — `tools` are defined in `apps/hermes`
 * and passed in already-built. `tools: AnyToolSpec[]`, not a precisely
 * generic array — see `AnyToolSpec`'s own doc above.
 */
export interface AgentDefinition {
  name: string;
  model: string;
  systemPrompt: string;
  tools: AnyToolSpec[];
  channels: string[];
}
