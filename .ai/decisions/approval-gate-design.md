# Human approval for gated tool calls: a channel-agnostic port, one prompt per batch, in memory only

**Decision:** A tool marked `requiresApproval: true` cannot run until a human
answers. The port is `ApprovalGate`/`ApprovalRequest`
(`packages/agent/src/approval-gate-port.ts`), injected as `RunTurnDeps.
approvalGate`; the only implementation is Telegram inline keyboards
(`apps/hermes/src/agent/telegram-approval-gate.ts`). One combined prompt covers
a whole batch of gated calls from the same model response, an unanswered prompt
resolves as a **denial** after 5 minutes, and nothing about a pending approval
is persisted.

**Why:**

- **The port carries no channel.** `requestApproval` gets `{ tool, args }` per
  call plus `{ threadId, turnId }` and the turn's `AbortSignal` — no chat id, no
  message id. `packages/agent` must not import `@hermes/channels` (see
  [architecture](../architecture.md#dependency-direction)), so everything
  Telegram-shaped lives in `apps/hermes`. The cost of that boundary is the
  `targetResolver` stopgap below.
- **One prompt for the batch, not one per call.** A response requesting three
  gated calls produces one message with one Aprobar/Rechazar pair (Spanish
  labels since `06-legible-approvals-bounded-reads`; the callback tokens
  underneath are still `approve`/`deny`), and the decision applies to all of
  them. Three prompts for one model response is a worse experience for no
  extra safety at this size. The *body* of that one message is rendered per
  call, though: a call whose `prepare` produced a summary renders legibly and
  a call without one falls back to its own raw-JSON line, so one prepare-less
  call never drags the whole batch back to JSON.
- **Resolution is exactly one code path with three triggers** — a tap, the
  timeout, or the turn's `AbortSignal` firing. Whichever fires first deletes the
  `pending` map entry **synchronously, before any `await`**, which is what makes
  double-resolution unrepresentable rather than merely unlikely. The same
  discipline decides who edits the prompt message: a tap edits inside
  `handleCallback`, the timeout/abort race edits inside `requestApproval`
  (guarded by `resolvedByTimer`), never both — one `editMessage` per resolution.
  An abort additionally skips the edit entirely: shutting down means no further
  Telegram calls.
- **Denied, timed out, and aborted mid-wait are the same outcome by design.**
  Every call in the batch gets the literal tool result `"user did not approve"`,
  its `tool.call` event is emitted with `approved: false`, and no handler ever
  runs. The turn is *not* aborted and the per-tool retry counter is not touched
  — a denial is information fed back to the model, not an error, which is why
  `TurnOutcome` has no approval-denial member (see
  [agent-loop-design](agent-loop-design.md)). Those `approved: false` rows carry
  a `duration_ms` measuring the *wait*, not any handler — a known, accepted
  wart recorded in
  [telemetry-event-schema](telemetry-event-schema.md).
- **A turn that is already aborted never sends a prompt.**
  `runGatedToolCalls` calls `assertToolInvocationAllowed(deps.signal)` before
  building the batch, mirroring the per-call check the ungated path makes.
  Without it, a shutdown landing between the model's response and the gate would
  push an Approve/Deny message into the user's chat that nothing is left alive
  to answer.
- **Gated and ungated calls in the same response run concurrently.**
  `executeToolCalls` splits the batch and `Promise.all`s both halves, so a
  five-minute approval wait never delays an ungated `get_current_time` in the
  same response. Approval gates *whether* a call runs, never how its arguments
  are validated or retried — an approved batch falls through to the identical
  path an ungated call takes.
- **A gated tool with no gate fails at construction.** `createAgent` calls
  `assertApprovalGateConfigured` synchronously, before any I/O, so the
  misconfiguration surfaces at boot instead of at the first gated call — where
  it would present as "the tool silently ran without asking".

- **`sheets_write` is the second worked example of the mutation-gates /
  read-doesn't policy**, after `whoami`, and the first one that actually
  mutates anything outside this process. `sheets_inspect`/`sheets_read` are
  ungated: they leave no trace on the user's data and gating every read would
  train the human to tap Approve without reading. `sheets_write` carries
  `requiresApproval: true` and additionally refuses outright against a sheet
  registered `access: "read"` — the gate answers "did a human agree," the
  registry answers "is this sheet writable at all," and neither substitutes for
  the other. The gate's in-memory volatility is safe here because it fails
  toward *not writing*: a restart drops the pending approval and the write
  simply never happens, which is the same outcome as a denial.

**Rejected:**

- *One approval prompt per tool call* — the user's explicit override; see above.
- *Persisting pending approvals* — see the stopgap below; deliberately deferred,
  not overlooked.
- *A timeout that leaves the call unresolved, or that aborts the turn* — both
  turn a human being slow into a stuck or failed turn. Timeout-as-denial keeps
  the turn moving with an answer the model can react to.
- *Gating the inbound callback behind `withAllowlist`/`withPrivateChat`* —
  `boot.ts` wires `subscribeCallback` straight to the resolver. A tap answers a
  prompt this bot itself sent into an already-allowlisted private chat; there is
  no unauthenticated inbound surface here to gate.

**Known stopgaps — accepted, and not to be mistaken for design:**

- **`targetResolver` is an in-memory `threadId → chatId` index**
  (`createThreadRepoWithChatIndex` in `apps/hermes/src/agent/build-agent.ts`),
  populated as a side effect of every `getOrCreateThread`. It exists only
  because `packages/store`'s `ThreadRepo` has no reverse lookup — no
  `getThreadById`. It never evicts (bounded by the number of distinct
  allowlisted threads, which is small by construction) and is **empty after a
  restart**; that is harmless today solely because every turn loads its thread
  before it can reach a gated call, so the entry always exists by the time
  `requestApproval` runs. Any future consumer that needs `threadId → chatId`
  *outside* a live turn must add the reverse lookup to `ThreadRepo` rather than
  widening this index.
- **~~The prompt shows the model's raw args, so a `sheets_write` approver
  cannot see the whole stake~~ — CLOSED by
  `06-legible-approvals-bounded-reads`.** The predicted fix is the one that
  shipped: an `ApprovalGate` contract change, not sheets-write-specific
  resolution inside the generic loop. `ToolSpec.prepare` resolves the call
  once, before the prompt exists, and contributes a concrete, tool-agnostic
  `ApprovalSummary` the gate renders with zero per-tool knowledge — see
  [tool-prepare-hook](tool-prepare-hook.md). The same resolved values are
  threaded onto `ctx.plan` for the handler, so the human and the handler
  provably see one resolution, never two; re-resolving at display time stayed
  rejected for exactly the reason recorded above. `sheets_write`'s prompt now
  names the sheet by slug and description, previews up to three rows, states
  the mode's consequence, and warns when the *effective* `valueInputOption`
  is `USER_ENTERED` over a value Sheets would reinterpret — the `RAW` vs
  `USER_ENTERED` stake this bullet said was invisible. Two failure modes that
  used to reach a human first — an unknown slug and a sheet registered
  `access: "read"` — are now refused during `prepare`, so no prompt is sent
  for a call already destined to fail.
- **Column headers as labels, and a before→after diff in the prompt ("Tier
  2") — OPEN, deliberately deferred (`06-legible-approvals-bounded-reads`).**
  The prompt still previews raw cell values with no column names, and an
  `update` still says which rows it replaces without showing what they
  currently hold. Both need a Google API read *before* the human is asked,
  and that is the whole cost: `prepare` today touches only the registry, so
  adding a pre-approval read puts a network call (and its latency, its
  failure modes, and a second reason a prompt might not appear) in front of
  every write prompt. It would also force the scope decorator's `prepare`
  wrap to carry a token-fetching path it currently does not need. Deferred
  because it is not user-driven: the shipped Tier 1 prompt already answers
  "which sheet, how many rows, what will be written, what will it become".
  `mode: "update"` gets most of the value after the fact instead — the
  handler's pre-overwrite snapshot puts `replaced` in the tool result, so the
  model can narrate the before→after change in its reply. Closing this
  properly means deciding whether a pre-approval read is worth a slower, more
  failure-prone prompt, not just writing the rendering code.
- **Pending approvals live only in the process.** A restart drops them all; the
  human's tap then lands on an unknown id and gets
  `"this approval has expired, please ask again"` — the same single branch that
  serves an already-resolved id. The turn on the other side is gone with the
  process either way, so persisting the approval without also persisting the
  suspended turn would buy a nicer message and nothing else.

**Constraints it creates:**

- Every `ApprovalGate` implementation must race its own timeout against the
  turn's `AbortSignal` using `delay(ms, signal)` from `@hermes/core` — the same
  helper `invokeToolHandler`'s handler-timeout race uses. An implementation that
  ignores the signal leaks a pending wait through shutdown.
- A gated tool can only be configured on a channel whose
  `capabilities.buttons` is true *and* which implements `subscribeCallback` /
  `editMessage` / `answerCallback` — those three are optional on the `Channel`
  port and required on `TelegramPoller`.
- The approval prompt is a real outbound message in the user's chat. Anything
  that changes `send`'s chunking must keep the inline keyboard attached to the
  **last** part, or a long prompt strands its buttons mid-message.
- This gate is what made the poller's dispatch change necessary — read
  [poller-concurrent-message-dispatch](poller-concurrent-message-dispatch.md)
  before changing either side.
- **Making a prompt say more is a tool-side change, never a renderer
  change.** `apps/hermes/src/agent/approval-prompt-renderer.ts` lays out
  `ApprovalSummary`'s five fields and knows nothing else; a tool that wants
  to say more populates `items`/`effects` in its own `prepare`. A
  `sheets_write`-shaped branch inside the renderer or the loop is the thing
  this design exists to prevent — see
  [tool-prepare-hook](tool-prepare-hook.md).
- **A `prepare` that fails refuses; it never degrades to a raw-JSON
  prompt.** A throw, a timeout, an abort, or an explicit refusal all resolve
  the call without asking a human. Anything else would mean a human tapping
  Aprobar on a call the system could not fully describe.
