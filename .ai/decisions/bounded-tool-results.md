# Bounded tool results: dual caps, whole-row/whole-tab granularity, additive fields

**Decision:** Every Sheets read bounds what it returns, client-side, after the
API responds. `packages/google-sheets/src/truncate.ts`'s `truncateBySize<T>
(items, measure, caps?)` accumulates items in order against **two** caps at
once — `MAX_CELLS = 500` and `MAX_VALUE_CHARS = 4_000` — and stops before an
item would push either total over. `sheets_read` applies it per row,
`sheets_inspect` per tab, and `sheets_write`'s update-mode `replaced` snapshot
per row. A truncated result adds fields; an untruncated one is byte-identical
to what shipped before.

**Why:**

- **The failure it prevents is silent.** An unbounded read of a wide range or
  a many-tab spreadsheet dumped everything into the tool result, which lands
  in conversation history. Nothing errored — the model just started behaving
  worse a few turns later as the trim budget evicted real context. A cap turns
  an invisible degradation into a visible, model-readable statement.
- **Two caps, because either dimension alone is wrong.** Cells alone lets 500
  paragraph-length cells through; characters alone lets thousands of tiny
  cells through. Both bounds are cheap to compute and each catches what the
  other misses.
- **Whole rows and whole tabs, never a partial one.** A half-row is worse than
  no row: the model cannot tell a truncated cell from a real value. The
  accumulator therefore stops *before* the offending item — **except for the
  very first item**, which is always kept, so a single oversized row or tab is
  returned whole rather than turning a legitimate read into an empty result.
- **Truncation fields are additive, via conditional spread.** `truncated`,
  `returnedRows`/`returnedTabs`, `totalRows`/`totalTabs`, `totalColumns` and
  `note` exist only on a truncated result. An untruncated read keeps the exact
  shape every existing caller and test already expects, so the cap is not a
  breaking change to the tool contract.
- **Counts come from what Google actually returned.** `values.get` returns
  only rows with data — `A1:Z1000` against a 40-row sheet returns 40 rows —
  so `totalRows` is the response's row count, never the requested range's
  nominal size, and `totalColumns` is computed over the pre-truncation rows.
- **`note` is model-facing Spanish, and only promises what is true.**
  `sheets_read`'s note tells the model to ask for a smaller range, because it
  can. `sheets_inspect`'s does not: that tool takes only a slug, so there is
  no narrower request to make — an earlier draft advising a retry was removed
  as actively misleading.
- **The caps are package-internal constants, not env config.** Same posture as
  `MAX_ITERATIONS` and `HISTORY_BUDGET_CHARS`: the right value is a function
  of the model's context budget, which the operator does not know better than
  the code does, and a per-deploy value would make "how much context can a
  read consume" unanswerable without checking the environment.

**Rejected:**

- *Bounding the request instead of the response* — the A1 range is the
  model's, and rewriting it would silently answer a different question than
  the one asked.
- *Truncating within a row/tab to hit the cap exactly* — a partial row is
  indistinguishable from real data.
- *Dropping a single oversized item entirely* — turns one big row into an
  empty read with no explanation.
- *Env-configurable caps* — see above.
- *A cap in `packages/agent` over every tool result* — the generic loop cannot
  measure "cells", and truncating a JSON blob at the loop boundary is the
  partial-row problem again at a larger scale.

**Constraints it creates:**

- A new read-shaped Sheets result must go through `truncateBySize` with its
  own `measure`, not roll its own bound. `measureRow` already covers
  row-shaped callers.
- Whatever a caller adds on truncation must stay additive, and its `note` must
  not promise a remedy the tool cannot honor.
- A consumer of these results must treat `values`/`tabs`/`replaced` as
  possibly partial and check `truncated` before drawing a conclusion about
  totals.
