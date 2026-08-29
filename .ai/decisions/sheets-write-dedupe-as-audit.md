# `sheet_write_log` is both the write dedupe guard and the durable write audit

**Decision:** `sheets_write` claims a row in `sheet_write_log` **before**
calling the Sheets API and records the outcome after, keyed on `sha256(channel,
channelUserId, turnId, tool, canonical args JSON)`. That same table — not
`telemetry_events` — is the audit of record for this mutation path (ROADMAP
invariant 3).

**Why:**

- **`telemetry_events` cannot be the audit.** The recorder is buffered,
  non-blocking and **at-most-once by design** — a slow Postgres degrades
  telemetry rather than delaying a reply. That is the right guarantee for an
  instrument and the wrong one for the record of "did we mutate a human's
  spreadsheet." Claim-before-call plus a stored outcome gives the opposite
  guarantee on exactly the path that needs it.
- **`turnId` is in the key on purpose: this is a retry guard, not a permanent
  block.** Without it, a user asking to add the same client again next week
  would be silently swallowed as a duplicate. With it, a *same-turn* repeat
  (the model calling the tool twice with identical args, or an approved call
  re-driven) short-circuits, and a later genuine request — new `turnId` —
  proceeds. Mirrors `llm_dedupe`'s claim/complete idiom, widened with
  `channel`/`channel_user_id`/`turn_id`/`tool`/`canonical_args` so the row
  doubles as the audit trail.
- **Canonicalization is load-bearing.** `canonical-args.ts` sorts keys before
  hashing; without it two logically identical calls hash differently and the
  guard does nothing.

**Three claim outcomes, not two** — the third is the whole design:

| Result | Meaning | Handler does |
| --- | --- | --- |
| `"claimed"` | INSERT won; first call for this key | proceeds to write; this call owns the row |
| `{ alreadyComplete, outcome }` | a prior call finished | returns the **stored outcome**; the API is never called again |
| `{ alreadyPending: true }` | a row exists, still `pending` | returns the `ambiguous_write` hedge and **does not write**; deliberately does **not** `complete()` — this call did not originate the write and must not clobber what the owning attempt eventually records |

`alreadyPending` is the claim-to-complete crash window made explicit. An earlier
cut returned `"claimed"` there, which let a same-turn retry hit the API twice —
enough to double an `append`. Fail-closed is correct here precisely because the
alternative silently doubles a row in a human's spreadsheet.

**`release()` — the escape hatch that keeps fail-closed from wedging.** A
`SheetsApiError` reaching `performWrite`'s catch is *provably definitive*: it
only escapes the client for a non-429 4xx (Google rejected the request outright)
or an exhausted 429 (never got past quota enforcement). Neither mutated the
sheet, so the still-`pending` row is deleted (`DELETE ... WHERE status =
'pending'`, so it can never race a legitimate `complete`) and a legitimate
same-turn retry is not left hedging over a write that provably never landed.
**Anything else keeps the pending row** — a network failure that cannot be
proven pre-send, a malformed body after a 2xx. The default stays "when in doubt,
hedge."

That definitive/ambiguous split is the same one the client draws per mode:
`updateValues` (fixed-range `PUT`, idempotent) retries a post-send-ambiguous
failure once internally and never surfaces ambiguity; `appendValues` (not
idempotent) throws `SheetsAmbiguousWriteError` immediately and the handler turns
it into a structured `{ ok: false, reason: "ambiguous_write", message }` the
model can relay verbatim — "may or may not have landed, check the sheet."
`release` applies identically to both modes; an earlier cut released only on the
append path, which could leave an `update`'s claim stuck `pending` after a write
that provably never happened.

**Rejected:**

- *`telemetry_events` as the audit* — wrong guarantee; see above.
- *Key without `turnId`* — turns a retry guard into a permanent "this row can
  only ever be written once."
- *Treat `alreadyPending` as claimable (fail open)* — the doubled-append bug.
- *Release the claim on any failure* — would release genuinely ambiguous ones,
  which is exactly the case the hedge exists for.
- *Silently retry an ambiguous append* — the outcome the user cannot detect is
  the one worth refusing.

**Constraints it creates:**

- The handler's order is load-bearing: resolve slug → enforce
  `access === "readwrite"` → **claim** → resolve `valueInputOption` → fetch
  token → call the API. A read-only refusal must never reach the claim or the
  client.
- Any new write path through this table must claim before the call and record
  after, and must classify its failures as definitive-or-ambiguous before
  deciding to `release`.
- `sheet_write_log` has **no retention policy** and grows unbounded, the same
  as `telemetry_events`.
