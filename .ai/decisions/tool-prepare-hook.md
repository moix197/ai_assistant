# `ToolSpec.prepare`: a tool resolves its call once, before the human is asked

**Decision:** `ToolSpec` becomes `ToolSpec<P = void>` and gains an optional
`prepare?(args, ctx): Promise<ToolPreparation<P>>`, run by `loop.ts`'s
`prepareGatedCall` on the **gated** path only, after `safeParse` and before
the approval prompt is built. It returns either `{ok: false, result}` — the
call is refused outright, no prompt is ever sent, and `result` becomes the
tool result — or `{ok: true, plan, summary}`, where `plan: P` is threaded onto
the handler's `ctx.plan` and `summary` is a concrete `ApprovalSummary` the
gate renders in place of raw JSON. `sheets_write` is the one tool that
declares one.

**Why:**

- **One resolution, shown and executed.** The gap this closes (see
  [approval-gate-design](approval-gate-design.md)) was that the prompt showed
  the model's unresolved args while the handler resolved them itself,
  afterwards. Re-resolving at display time would have been worse, not better:
  two resolutions can disagree, and the human would have approved the one that
  did not run. `prepare` resolves once; the resulting `plan` is what the
  handler receives, so drift is unrepresentable rather than merely unlikely.
- **`ApprovalSummary` is concrete, not a pre-rendered string and not
  `unknown`.** `{action, target?, items?, itemsTotal?, effects}` — five fields,
  nothing speculative. A pre-rendered string was rejected because it moves
  layout into every tool and lets one tool's prompt look nothing like
  another's (and lets a tool emit whatever text it likes into a safety
  control). `unknown` was rejected because it is not a contract: the gate
  would have to guess a shape at runtime, and TypeScript could not reject a
  `prepare` that forgot `action`.
- **The gate renders with zero per-tool knowledge.** Everything Sheets-shaped
  in a `sheets_write` prompt — the Spanish question, the row preview, the
  `valueInputOption` warning — is produced by that tool's own `prepare` in
  `packages/google-sheets`. `apps/hermes/src/agent/approval-prompt-renderer.ts`
  only lays out the five fields, so a second gated tool needs no renderer
  change, and `packages/agent` still imports nothing Sheets-specific.
- **`plan` is a value, never an absent property.** A prepare-less tool is
  `ToolSpec<void>` and its handler still receives `ctx.plan` — typed `void`,
  `undefined` at runtime. A handler reading a plan its tool never computes is
  therefore a type error, not a silent `undefined`.
- **Fail-closed, uniformly.** A throw, a timeout (the same `spec.timeoutMs ??
  TOOL_HANDLER_TIMEOUT_MS` race the handler runs under, no new timeout
  surface), an abort mid-flight, and an explicit `{ok: false}` are one
  outcome: the call resolves with no prompt and no handler. Degrading to a
  raw-JSON prompt when `prepare` fails would ask a human to approve a call the
  system could not describe.
- **Validation order changes only for the gated path.** `parseToolCallArgs` is
  shared with the ungated path, so a validation failure counts against the
  same per-tool-name retry budget and produces byte-identical content either
  way; what moved is *when* it runs — before the prompt instead of after the
  decision. `buildApprovalBatch` then splits a batch into refusals (resolved
  immediately, `approved: false`, no `approvalWaitMs`) and survivors, and
  `requestApproval` is skipped entirely when nothing survives.
- **The batch entry keeps the model's raw args.** `ApprovalRequest.args` is
  still `toolCall.arguments`, never the `safeParse`d form `prepare` and the
  handler receive, so a zod default or coercion can never silently change what
  a human is shown or what `tool.call` logs. `plan` rides along on the request
  for debug logging only — `apps/hermes`'s gate logs it at debug level; the
  renderer never reads it, and it never reaches chat.
- **The scope decorator wraps `prepare` too.** `withRequiredScopes`
  (`apps/hermes`) gates both slots through one shared `checkScopeGate`, so an
  unconnected or under-scoped user is refused before the prompt rather than
  after approving one, and each invocation still costs exactly one
  `getAccount`.

**Rejected:**

- *Re-resolving the call at display time* — could show something other than
  what is about to run; the whole point is that it cannot.
- *A `sheets_write`-shaped branch inside `loop.ts` or the renderer* — wrong
  layer, and `packages/agent` may not import a feature package at all.
- *`ApprovalSummary = unknown`, or a pre-rendered string* — see above.
- *Running `prepare` on the ungated path* — nothing needs it (no ungated tool
  declares one), and it would put a pre-handler round trip in front of the
  cheap path for no gain. `resolveToolCall` documents the `plan: undefined` it
  passes as deliberate, not an oversight.
- *A separate `prepareTimeoutMs`* — one more knob for a second race with the
  same shape.

**Constraints it creates:**

- A tool that declares `prepare` must be able to resolve everything the prompt
  claims **without** side effects the human has not yet approved. `prepare` is
  reached before consent, so a write, a mutation, or an expensive call belongs
  in the handler.
- Whatever the handler needs from that resolution must travel in `plan`. A
  handler that re-derives it (re-resolving a slug, recomputing an effective
  option) reopens exactly the drift this closes.
- A new prompt line is an `ApprovalSummary` field a tool populates, not a
  renderer change. If a genuine sixth field is ever needed, widen the
  interface deliberately — do not smuggle layout into `action` or `effects`.
- `ApprovalRequest.plan` is debug-log-only. Anything a human must see belongs
  in `summary`; `plan` may carry ids and internals (`spreadsheetId`) that must
  not reach chat.
