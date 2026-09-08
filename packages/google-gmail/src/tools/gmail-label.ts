import { z } from "zod/v4";
import { GmailApiError } from "../gmail-client";
import { toInsufficientScopeResult } from "../insufficient-scope";
import { type ThreadNotFoundResult, newestRef } from "./gmail-archive";
import type { GmailToolContext, GmailToolDeps } from "./tool-deps";

/**
 * Flat object plus enum, never a root `z.discriminatedUnion`/`z.union`
 * (`.ai/decisions/tool-arg-schema-top-level-object.md` — same reasoning
 * `sheets-write.ts`'s own schema comment documents: a top-level union's
 * `z.toJSONSchema` conversion emits a bare `anyOf` some OpenAI-compatible
 * providers reject outright).
 */
const schema = z.object({
  threadId: z.string(),
  label: z.string(),
  action: z.enum(["add", "remove"]).default("add"),
});

type Args = z.infer<typeof schema>;

/**
 * `gmail.modify` and `/connect google gmail-send` — hardcoded here rather
 * than imported from `@hermes/google-auth`'s `GMAIL_WRITE_SCOPES`, same
 * posture as `gmail-archive.ts`'s own constants (this package never imports
 * `@hermes/google-auth`).
 */
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_WRITE_FIX = "run /connect google gmail-send";

export type CreateGmailLabelToolDeps = GmailToolDeps;

/** `{ ok: false, reason: "unknown_label" }` — the shape `resolve-sheet.ts`'s `unknown_sheet` established, so an unknown label name refuses legibly, listing every label the model can retry with. */
export interface UnknownLabelResult {
  ok: false;
  reason: "unknown_label";
  available: string[];
}

/**
 * What `prepare` resolves and threads onto `ctx.plan` for `handler` — the
 * thread's newest message id (the one `modifyMessage` targets, same posture
 * as `gmail-archive.ts`'s plan), the resolved label id, and which side of
 * `addLabelIds`/`removeLabelIds` it belongs on. `handler` never re-resolves
 * the label name or re-lists labels.
 */
export interface GmailLabelPlan {
  threadId: string;
  messageId: string;
  labelId: string;
  labelName: string;
  action: "add" | "remove";
}

type LabelPrepareResult =
  | {
      ok: true;
      plan: GmailLabelPlan;
      summary: { action: string; target?: string; effects: string[] };
    }
  | {
      ok: false;
      result:
        | ThreadNotFoundResult
        | UnknownLabelResult
        | ReturnType<typeof toInsufficientScopeResult>;
    };

/** Reuses `gmail-archive.ts`'s `newestRef` — the same newest-message resolution both tools need, extracted once a second tool needed it (CLAUDE.md: reuse before reinvent). */
async function findNewestMessageId(
  deps: CreateGmailLabelToolDeps,
  accessToken: string,
  threadId: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const thread = await deps.gmailClient.getThread(accessToken, threadId, signal);
  return newestRef(thread.messages).id;
}

function buildLabelSummary(
  action: "add" | "remove",
  labelName: string,
): { action: string; effects: string[] } {
  if (action === "add") {
    return {
      action: `¿Ponerle la etiqueta "${labelName}" a esta conversación?`,
      effects: [`Se agrega la etiqueta "${labelName}".`],
    };
  }
  return {
    action: `¿Sacarle la etiqueta "${labelName}" a esta conversación?`,
    effects: [`Se quita la etiqueta "${labelName}".`],
  };
}

/**
 * `prepare(args, ctx)`: resolves the label name to its id via `listLabels`
 * and the thread's newest message id via `getThread`, refusing **before**
 * any approval prompt is built when either the thread (`thread_not_found`)
 * or the label name (`unknown_label`, listing every registered label) can't
 * be resolved. A scope revoked at Google after `withRequiredScopes`'s
 * pre-check surfaces as the structured `insufficient_scope` refusal, same as
 * every read tool's handler.
 */
async function prepareLabel(
  deps: CreateGmailLabelToolDeps,
  args: unknown,
  ctx: GmailToolContext,
): Promise<LabelPrepareResult> {
  const { threadId, label, action } = args as Args;
  const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

  try {
    const [messageId, labels] = await Promise.all([
      findNewestMessageId(deps, accessToken, threadId, ctx.signal),
      deps.gmailClient.listLabels(accessToken, ctx.signal),
    ]);

    const resolved = labels.find((candidate) => candidate.name === label);
    if (!resolved) {
      return {
        ok: false,
        result: {
          ok: false,
          reason: "unknown_label",
          available: labels.map((candidate) => candidate.name),
        },
      };
    }

    return {
      ok: true,
      plan: { threadId, messageId, labelId: resolved.id, labelName: resolved.name, action },
      summary: buildLabelSummary(action, resolved.name),
    };
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      return { ok: false, result: { ok: false, reason: "thread_not_found" } };
    }
    const refusal = toInsufficientScopeResult(error, GMAIL_MODIFY_SCOPE, GMAIL_WRITE_FIX);
    if (refusal) return { ok: false, result: refusal };
    throw error;
  }
}

/**
 * `gmail_label`: `requiresApproval: true` — every call routes through the
 * approval gate before `handler` ever runs. `handler` reads `ctx.plan`
 * (built by `prepare`) and calls `modifyMessage` with exactly the resolved
 * label id, on the `add`/`remove` side `plan.action` selected. Idempotent by
 * Gmail's own label semantics — adding an already-present label or removing
 * an already-absent one is a harmless no-op.
 */
export function createGmailLabelTool(deps: CreateGmailLabelToolDeps) {
  return {
    name: "gmail_label",
    description:
      "Adds or removes a Gmail label on a thread. Args: { threadId, label, action? } — threadId must come from a prior gmail_list_unread, gmail_search or gmail_read_thread call; label is the label's display name; action is 'add' (default) or 'remove'. Requires human approval.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: true,
    prepare: (args: unknown, ctx: GmailToolContext) => prepareLabel(deps, args, ctx),
    handler: async (
      args: unknown,
      ctx: GmailToolContext & { plan: GmailLabelPlan },
    ): Promise<unknown> => {
      const { plan } = ctx;
      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

      try {
        await deps.gmailClient.modifyMessage(
          accessToken,
          plan.messageId,
          plan.action === "add"
            ? { addLabelIds: [plan.labelId] }
            : { removeLabelIds: [plan.labelId] },
          ctx.signal,
        );
      } catch (error) {
        const refusal = toInsufficientScopeResult(error, GMAIL_MODIFY_SCOPE, GMAIL_WRITE_FIX);
        if (refusal) return refusal;
        throw error;
      }

      return { ok: true, threadId: plan.threadId, label: plan.labelName, action: plan.action };
    },
  };
}
