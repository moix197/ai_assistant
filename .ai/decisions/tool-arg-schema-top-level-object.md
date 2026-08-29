# Every tool's arg schema must convert to a top-level JSON Schema object

**Decision:** A `ToolSpec.schema` must be a zod schema whose `z.toJSONSchema`
output has a top-level `"type": "object"`. `sheets_write`, which has two
modes, is therefore a **flat `z.object` with a `mode: z.enum(["append",
"update"])` field** — not `z.discriminatedUnion("mode", [...])`. Enforced by
`apps/hermes/src/agent/__tests__/tool-schemas.test.ts`, which pulls the real
tool array out of `buildAgent` and asserts the shape for **every** registered
tool, not just this one.

**Why:**

- **A root-level union emits `anyOf` with no `type`.** `z.discriminatedUnion`
  converts to `{ anyOf: [...] }` at the top level. OpenAI-compatible providers
  require each tool's `parameters` to be an object schema; DeepSeek rejects the
  request outright with HTTP 400.
- **The blast radius is every turn, not every write.** Tool schemas ship in the
  `tools` array on *every* completion request — they are the first bytes of the
  cache-stable prefix (`assemblePrefix`, ROADMAP invariant 6). One malformed
  schema therefore failed **all** traffic, reads included, with the failure
  presenting as "the bot answers nothing" and nothing wrong on the path of the
  tool that actually caused it. This is why the constraint is global and
  test-enforced rather than a note on one tool.
- **The union bought no validation.** Both modes carry identical field sets;
  only the `mode` literal differs. The flat object accepts and rejects exactly
  the same values.

**Rejected:**

- *Keep the union, hand-write the JSON Schema* — desynchronizes the shape zod
  validates from the shape the model is told about; the next divergence is
  silent.
- *Regress it from `sheets_write`'s own test file* — the fault lives in shared
  prefix assembly, not in the tool. A per-tool assertion would not have caught
  this one and would not catch the next tool's. The sweep over the whole
  registered array is the point.
- *Normalize the schema inside `packages/llm`'s adapter* — hides an authoring
  constraint behind a rewrite, in the package least able to explain it.

**Constraints it creates:**

- New tools: top-level `z.object`, always. Express variants as an enum field
  plus optional fields. `z.union`/`z.discriminatedUnion` nested **inside a
  property** is fine (`sheets_write`'s `values` uses `z.union` at the cell
  leaf) — only the root is constrained.
- `tool-schemas.test.ts` must keep sourcing its list from the real `buildAgent`
  construction. A hand-copied tool array silently stops covering new tools.
- Sibling concern, different layer: [tool-call-wire-format](tool-call-wire-format.md)
  governs how *messages* are serialized; this file governs how *tool arg
  schemas* are.
