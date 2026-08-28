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
  gated calls produces one message with one Approve/Deny pair, and the decision
  applies to all of them. Three prompts for one model response is a worse
  experience for no extra safety at this size.
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
- **Pending approvals live only in the process.** A restart drops them all; the
  human's tap then lands on an unknown id and gets
  `"this approval has expired, please ask again"` — the same single branch that
  serves an already-resolved id. The turn on the other side is gone with the
  process either way, so persisting the approval without also persisting the
  suspended turn would buy a nicer message and nothing else.

**Constraints it creates:**

- Every `ApprovalGate` implementation must race its own timeout against the
  turn's `AbortSignal` using `delay(ms, signal)` from `@hermes/core` — the same
  helper `invokeTool`'s handler-timeout race uses. An implementation that
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
