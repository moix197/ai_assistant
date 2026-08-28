# Tool-call messages map onto the wire format field-by-field, never spread verbatim

**Decision:** `packages/llm/src/adapter/openai-compatible.ts`'s `toWireMessage`
translates each domain `Message` into the OpenAI-compatible wire shape
explicitly: a `role: "tool"` message emits `tool_call_id: message.toolCallId`;
a `role: "assistant"` message carrying `toolCalls` emits
`tool_calls: message.toolCalls.map(toWireToolCall)`. `buildRequestBody` maps
every message through this function — it never spreads `request.messages`
verbatim onto the outgoing body. `packages/core/src/llm-types.ts`'s `Message`
is a discriminated union on `role`, so a `ToolMessage` without `toolCallId` is
unrepresentable at the type level, not merely checked at this boundary.

**Why:** the domain's `Message` is intentionally provider-neutral
(`toolCallId`/`toolCalls`, not the wire's `tool_call_id`/`tool_calls`) so
`@hermes/agent` and `@hermes/store` can name it without depending on any
adapter's wire shape.

- **Spreading verbatim shipped the domain's own key names.** An earlier cut of
  `toWireMessage` spread `message` directly onto the wire body, so
  `toolCallId` (camelCase, not a key any OpenAI-compatible provider
  recognizes) rode along unmapped while the provider-required `tool_call_id`
  was simply absent — every OpenAI-compatible provider rejects a `role:
  "tool"` message missing it ("tool message must be a response to a preceding
  message with tool_calls" / missing `tool_call_id`).
- **The assistant's own tool-call request needs the same treatment.** A
  `role: "assistant"` message that requested tool calls must carry the wire's
  `tool_calls` array (each entry wrapped `{id, type: "function", function:
  {name, arguments}}` by `toWireToolCall`) and must precede the `role: "tool"`
  result messages answering it, or the provider 400s. `converse()` in
  `packages/agent/src/loop.ts` pushes that assistant message before the
  tool-result messages for exactly this reason.
- **Fixed in the Phase 2 review pass**, commit `1ce3a22` (`fix(agent): carry
  assistant tool_calls over the wire, cancel handler timeout, report real
  error-path stats`). Pinned by
  `packages/llm/src/adapter/__tests__/openai-compatible.test.ts`'s
  "tool-call message wire format" suite.

**Rejected:**

- *Spreading `request.messages` verbatim* — the bug this decision fixes; see
  above.
- *Renaming the domain field to `tool_call_id`* — would leak the wire's
  naming convention into `@hermes/core`, which is deliberately
  provider-neutral (see `.ai/index.md`'s `@hermes/llm` row and
  `architecture.md`'s dependency-direction section).
- *A runtime guard on `toolCallId` at the adapter boundary* — an optional
  field plus a runtime check reproduces the same silent-drop failure mode for
  any call site the check doesn't cover. The discriminated union makes the
  invalid state unrepresentable instead.

**Constraints it creates:**

- Any new field added to `Message` that needs wire representation must be
  added to `toWireMessage` explicitly — there is no spread fallback to catch
  it.
- A `role: "tool"` message always carries `toolCallId`; a `role: "assistant"`
  message's `toolCalls` is only ever read after narrowing on `message.role
  === "assistant"` — the union does not expose `toolCalls` on the other
  variants.
