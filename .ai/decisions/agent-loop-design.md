# The turn loop is bounded, and every tool failure is information rather than an error

**Decision:** `runTurn` (`packages/agent/src/loop.ts`) calls the model at most
`MAX_ITERATIONS = 8` times per user message, running the tool calls each
response asks for in between. Every way a tool call can fail — unknown name,
arguments that fail zod, a throwing handler, a handler that outruns its 10s
timeout — becomes a *tool result message fed back to the model*, not a thrown
error. Only the shutdown signal ends a turn early. Invalid arguments additionally
get one corrective attempt, counted per **tool name** per turn.

**Why:**

- **The iteration cap is a spend bound, not a safety rail.** Every iteration is
  a paid provider call, and a model that keeps requesting tools would otherwise
  spend without limit on one message. Eight is the ceiling on that; the budget
  ceiling in `packages/llm` bounds the month, this bounds the message. Hitting it
  throws `MaxIterationsReachedError`, which `runTurn` converts into a `turn`
  event with `outcome: "max_iterations"` (carrying the real accumulated cost) and
  then **rethrows** — so the user sees `complete.ts`'s generic failure reply,
  indistinguishable from a provider outage. Deliberate: there is nothing useful
  to say to a user about an internal iteration budget. The distinction lives in
  telemetry, which is where the operator looks.
- **Feeding failures back beats aborting, because the model can usually fix
  them.** A wrong tool name or a bad argument is the model's mistake and the
  model is the only thing that can correct it; aborting the turn converts a
  recoverable mistake into a failed reply. This is why `TurnOutcome` has no
  member for a validation failure or an approval denial — neither ends a turn,
  so neither is an outcome. A turn that recovered from three bad tool calls is
  `"completed"`, and that is the honest label.
- **The retry counter is keyed on the tool's *name*, never the tool call's id.**
  Providers issue a fresh `id` for every tool call in every iteration, so a
  counter keyed on it would see "attempt 1" forever and the loop would burn all
  eight iterations on the same malformed call. Name-keyed and turn-scoped, the
  second bad attempt at the same tool gets `invalid arguments, giving up: …`
  instead of the raw zod message, so one confused tool costs at most two paid
  calls rather than eight. The map is created inside `converse`, so it never
  outlives the turn — a tool that failed validation yesterday starts clean today.
- **"Giving up" is a message, not a stop.** The second-strike branch still
  returns a tool result and the loop still continues; `MAX_ITERATIONS` remains
  the only hard stop. Worth knowing before reading the counter as a circuit
  breaker.
- **Only *validation* touches the counter.** An unknown tool, a throwing
  handler and a timed-out handler are all fed back without incrementing
  anything, because none of them is an argument the model could restate
  correctly on a second try in the same way a zod error is.
- **The handler timeout is cancelled, not just raced.** `invokeTool` races the
  handler against `delay(TOOL_HANDLER_TIMEOUT_MS, …)` and aborts the timer in a
  `finally`, so a fast handler does not leave a 10s timer pending behind it —
  which at turn scale is the difference between a clean shutdown and one that
  waits on timers nobody is listening to. The race's timeout branch is a private
  `Symbol`, so a handler that happens to resolve with a colliding value cannot
  be mistaken for a timeout, and `signal.aborted` is re-checked afterwards so
  "we shut down mid-handler" reports as itself rather than as a timeout.

**Rejected:**

- *Aborting the turn on a tool failure* — see above; it throws away the model's
  ability to correct itself and converts most recoverable mistakes into a
  generic failure reply.
- *A retry counter keyed on the tool call id* — silently never fires, for the
  reason above. It is the obvious implementation and it is wrong.
- *A global per-turn failure budget instead of a per-tool one* — one flaky tool
  would consume the allowance for every other tool in the same turn.
- *Making the second strike terminate the turn* — the model still deserves the
  chance to do something else with the remaining iterations, including replying
  without the tool.
- *A user-visible "I gave up after 8 steps" reply* — exposes an internal budget
  the user cannot act on, and needs a second error path through
  `complete.ts` for no gain.

**Constraints it creates:**

- Anything added to the tool phase must decide, explicitly, whether it feeds
  back or throws. Throwing is reserved for the shutdown signal
  (`assertToolInvocationAllowed`); everything else returns a tool result.
- A new failure mode that the model *could* correct on retry belongs in the
  `retryCounts` branch. One that it could not must not touch the counter, or it
  will consume a real tool's strikes.
- `MAX_ITERATIONS` bounds paid calls per message. Raising it raises the worst
  case for a single message linearly, and the overshoot the budget ceiling
  already accepts along with it — see
  [monthly-budget-ceiling](monthly-budget-ceiling.md).
- **History is trimmed exactly once, before the first iteration.** The
  assistant and tool messages a turn generates are appended to the in-flight
  conversation and never re-trimmed, so a tool-heavy turn can exceed the budget
  within itself. Accepted: the bound that matters is across turns, and
  re-trimming mid-turn risks dropping the tool call an outstanding tool result
  answers, which every OpenAI-compatible provider 400s on (see
  [tool-call-wire-format](tool-call-wire-format.md)).
- **`HISTORY_BUDGET_CHARS = 8_000` is measured in *estimated tokens*, not
  chars** — it is compared against `length / 4`, so the real ceiling is roughly
  32,000 characters of history. The name is misleading; do not "fix" it by
  changing the comparison. The chars/4 estimate itself is ROADMAP §2c's
  deliberate crudeness, not a placeholder awaiting a tokenizer.
- The current user message is protected from the trim **structurally** — it is
  appended after `trimHistory` returns and is never passed to it. Do not
  refactor it into the trimmed array and re-add a guard.
- Trimming affects only what is sent to the model. `threads` always stores the
  full untrimmed history; any future compaction has to decide that separately.
