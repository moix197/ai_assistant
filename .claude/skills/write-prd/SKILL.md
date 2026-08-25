---
name: write-prd
description: Create a structured implementation plan (PRD) before coding. Triggers on "plan this", "make a plan", "/write-prd", "/plan", or non-trivial tasks needing research + design.
---

# Write PRD Skill

Produces a planning document and writes it to `plans/` at the project root.
Output format is chosen mid-flow based on whether the work has parallelizable
branches:

- **Sequential** — single phased file `plans/<plan-slug>.md`. Format spec lives
  in `.claude/skills/plan-sequential/SKILL.md`.
- **Issues** — kanban directory `plans/<plan-slug>/` with `BOARD.md` +
  `cards/<id>.md`. Format spec lives in `.claude/skills/plan-issues/SKILL.md`.

The output is always only the plan — never execution.

---

## Workflow

### Context discipline (applies to every phase)

Planning a non-trivial task produces a lot of intermediate text: tool dumps, grep output, research notes, draft plans, review notes. Keeping all of that in the main conversation is what blows the context window. The rule: **research subagents distill; the main thread carries only signal.**

- **The main thread never calls project-specific MCP tools or runs raw codebase searches during planning.** All MCP calls and Grep/Glob exploration happen inside research subagents.
- **Default path: distill into chat.** Each research subagent's reply must be ≤300 words and contain only the signal a downstream agent needs (key file paths, constraints, schema/permission facts, reusable utilities). No raw tool output, no grep dumps, no code blocks longer than ~10 lines.
- **Disk fallback (opt-in): `plans/.research/<plan-slug>/<topic>.md`.** Only when a subagent's useful signal genuinely exceeds a 300-word reply (long config audit, multi-file pattern catalog, schema diff across many fields). The reply then becomes: file path + ≤50-word summary + top 5 file paths.
- **The draft plan still goes to disk.** For sequential, that's `plans/<plan-slug>.draft.md`. For issues, the entire `plans/<plan-slug>/` directory is the draft and revised in place; there is no `.draft` directory. Either way, do not paste plan bodies into chat.
- When handing off between agents, pass distilled summaries inline (they're small) plus any disk-fallback paths.
- Every agent prompt includes a word cap matched to its role (see caps below). The cap applies to the chat reply only — files on disk are unbounded.
- Cleanup: at end of Phase 4, delete `plans/.research/<plan-slug>/` **only if it exists**. Plans that never used disk fallback skip cleanup entirely.

### Phase 1: Research

Gather context before designing anything. **All MCP and codebase exploration happens inside subagents — the main thread does not call MCP tools or run grep here.**

Spawn 1–3 research subagents in parallel. Each subagent's prompt MUST include all of the following:

0. **Consult `.ai/` first.** If `.ai/index.md` exists, read it — plus any `architecture.md` and linked `decisions/` it points to — **before** grepping raw source. Use it to jump straight to the relevant paths; fall back to codebase search only for what the index doesn't cover or that looks stale against the code. If `.ai/` is absent, proceed with codebase search as below. This is the read side of the knowledge base: it's what keeps research from re-deriving the whole codebase every pass.

1. **Project-specific MCP tools** — if CLAUDE.md lists any, the subagent must call them before reading raw source. Skip if none are defined.

2. **Codebase search focus** — distinct per agent, no overlap. Look for existing patterns, similar implementations, reusable code, files that will need changes, relevant tests, configs, registration touchpoints.

3. **Distillation contract** — reply must be ≤300 words and include: top 5–10 relevant file paths, key constraints/invariants found, reusable utilities/components, schema/permission/config facts that affect design. **No raw tool output. No grep dumps. No code blocks longer than ~10 lines.**

4. **Open Questions block (mandatory, separate section)** — every subagent reply MUST end with an `## Open Questions` block, even if empty. List every decision the codebase did not pick a clear winner for: ambiguous scope, contested design directions, scoping/isolation calls left implicit, UX flow choices, naming, anything the user's original prompt didn't pin down. One question per line. If genuinely nothing is open, write `## Open Questions\n_None — every decision in this subagent's scope has a clear winner from the codebase._` Do not bury open questions inside the distillation prose.

5. **Disk fallback rule** — if useful signal genuinely exceeds 300 words, write the overflow to `plans/.research/<plan-slug>/<topic>.md` and reply with: the path, a ≤50-word "what's in this file" summary, and the top 5 file paths. The `## Open Questions` block stays inline in the chat reply — never push it to disk.

**Subagent type selection:**

- **Default: `Explore`** — faster, read-optimized, supports Read/Grep/Glob/Bash. Use when the task is well-scoped and chat-only summaries are clearly enough.
- **Switch to `general-purpose`** when the agent may need the disk fallback. `Explore` lacks `Write/Edit/NotebookEdit` and cannot reliably create files in `plans/.research/`. Choose `general-purpose` for large/uncertain scopes, multi-file pattern catalogs, or any prompt where you've explicitly asked for disk fallback as a possibility.
- Never tell an `Explore` agent to write to disk.

The chat history of subagent replies IS the index — main thread already has the summaries and any disk paths. Do **not** write a separate research `index.md` under `plans/.research/`. (This is unrelated to the project-level `.ai/index.md`, which subagents *read* in item 0 and never write during research.)

### Phase 1.5: Resolve open questions (grill the user)

Research subagents surface what the codebase knows. Anything still ambiguous after Phase 1 is, by definition, something only the user can answer — feed those questions to the `grill-me` skill before any design happens.

**Default posture: Phase 1.5 always runs.** Grilling is the rule, skipping is the exception. The main thread does not get to silently decide research was "enough" — the user sees the questions and decides.

**The only valid skip condition:** every Phase 1 subagent's `## Open Questions` block came back explicitly empty (`_None — every decision in this subagent's scope has a clear winner from the codebase._`) AND the user's original prompt was specific enough that no scope/permission/UX/success-criteria decision is implicit. If either side has even one open question, grill.

**Tie-breaker for borderline cases:** if you're unsure whether to fire, fire. The cost of one extra round of questions is small; the cost of designing on top of an unresolved assumption is a thrown-away plan.

**Minimum grilling floor (when Phase 1.5 runs):** even if subagents' Open Questions are short, cover at minimum: **scope** (which users/roles/areas), **success criteria** (what "done" looks like, observable), **edge cases / failure modes** the user cares about, and any **UX or data-shape decision** the codebase did not pick a clear winner for. Stop only when the user signals they're done, not when the listed questions run out.

**How to fire it:**

Invoke the `grill-me` skill (`.claude/skills/grill-me/SKILL.md`). Hand it the union of all Phase 1 subagents' `## Open Questions` blocks plus any minimum-floor topics not already covered. The skill interviews the user one question at a time, providing a recommended answer for each. The skill itself enforces the rule: **if a question turns out to be answerable from the codebase, the skill must explore the codebase (or spawn a research subagent) instead of asking the user.**

**Handoff to Phase 1.7:** record only the resolved decisions inline — they're small. Do not paste the full grilling transcript into the next phase.

### Phase 1.7: Shape decision (sequential vs issues)

After research (and grill-me if it ran), the main thread now has enough signal to choose the output shape. The choice is recorded explicitly and passed to the Phase 2 specialist; both shapes use the same specialist routing, only the format spec differs.

**Heuristic — recommend ISSUES when most of these hold:**

- Work touches 3+ largely independent areas (separate modules, separate packages, separate UI pages, separate API surfaces)
- Estimated breakdown is 4+ logical units with at most 2-deep dependency chains
- Most units don't share files (hot files are limited to 1–2 units; majority of units have disjoint touch lists)
- Order between units is loose — only dependency chains matter, not a strict global sequence

**Heuristic — recommend SEQUENTIAL when most of these hold:**

- Single tight area (refactor across one package, one feature in one app, one route family)
- Strict global ordering required (interface change → consumer migration → tests; data model evolution → API → UI for a tightly coupled feature)
- ≤3 logical phases, each builds on the prior such that none make sense in isolation

**When neither clearly wins**, recommend sequential — lower coordination cost. Issues is worth the overhead only when parallelism is real.

**Mechanics:**

1. Main thread emits a 3–5 sentence summary in chat: scope from research, areas touched, observed parallelism (or lack of it), recommended shape, one-sentence rationale.
2. Confirm via `AskUserQuestion`. Two options: "Sequential" / "Issues" — put the recommended one first and label it `(Recommended)`. User can override.
3. Record the chosen shape (call it `<shape>` below). The Phase 2 specialist prompt MUST include:
    - `shape: sequential` or `shape: issues`
    - Instruction to read either `.claude/skills/plan-sequential/SKILL.md` or `.claude/skills/plan-issues/SKILL.md` (matching the chosen shape) for the output format spec
    - Instruction to write the draft per that format spec — single file (`plans/<plan-slug>.draft.md`) for sequential, directory (`plans/<plan-slug>/`) for issues

### Phase 2: Design

Route research findings + the shape directive to the right specialized agent.

| Task type                                   | Agent                                     |
| ------------------------------------------- | ----------------------------------------- |
| Backend architecture, API design, DB schema | `backend-architect`                       |
| Frontend pages, components, Next.js routing | `nextjs-frontend-architect`               |
| UI/UX design, accessibility, design systems | `ux-design-architect` or `ui-ux-designer` |
| Security, auth, API hardening               | `api-security-auditor`                    |
| API documentation, OpenAPI specs            | `api-documenter`                          |
| TypeScript type system, strict typing       | `typescript-expert`                       |
| Mixed or no specific domain                 | Handle directly (no agent)                |

**Agent prompt must include:**

- The distilled summaries from Phase 1 subagents — paste them inline (they're small by contract).
- Any `plans/.research/<plan-slug>/<topic>.md` paths created via disk fallback, with instruction to read those files directly and **not echo their contents back** in the chat reply.
- The user's requirements and constraints.
- CLAUDE.md invariants that apply.
- The shape decision from Phase 1.7 (`shape: sequential` or `shape: issues`) and the path to the matching format spec skill.
- **Vertical-slice phasing instruction** — phases (sequential) or cards (issues) must be testable end-to-end slices, not horizontal layers (schema → API → UI). Every unit must pass the acid test ("After this commits, what can the user/QA actually do that they couldn't before?"). The format spec skills repeat this rule but restate it here so the specialist sees it directly.
- **Mode + Type tagging (consumed by `/execute-prd`)** — every unit (phase or card) must be tagged with two fields:
    - `mode: afk | hil` — default `afk` (a subagent can implement autonomously). Mark `hil` only when human action is genuinely required: manual UI testing, design decisions left open by the plan, deploy steps, anything touching external systems Claude can't reach. The Final-Verification phase/card is **always `hil`**.
    - `type: backend | frontend | typescript | security | docs | ux | config | test | mixed` — routes execution to a specialist subagent (`backend` → backend-architect, `frontend` → nextjs-frontend-architect, `typescript` → typescript-expert, `security` → api-security-auditor, `docs` → api-documenter, `ux` → ux-design-architect; `config`/`test`/`mixed` → general-purpose). Default to `mixed` when no specialist clearly fits.

    Sequential plans put these as `**Mode:**` and `**Type:**` lines in the phase header; issues plans put them in the card frontmatter. See [`.claude/skills/plan-sequential/SKILL.md`](../plan-sequential/SKILL.md) and [`.claude/skills/plan-issues/SKILL.md`](../plan-issues/SKILL.md) for the exact placement.
- Explicit output target: `plans/<plan-slug>.draft.md` (sequential) **or** `plans/<plan-slug>/` directory with `BOARD.md`, `cards/`, and `README.md` (issues).
- **Chat reply cap: 200–400 words.** Reply with: draft path(s), per-phase or per-card outline (one line each), and any flagged decisions or open questions. Do not echo plan body or card bodies back.

### Phase 3: Revision

Same specialized agent from Phase 2 reviews and edits the draft in place. For sequential, that means editing `plans/<plan-slug>.draft.md`. For issues, that means editing files inside `plans/<plan-slug>/` (cards, BOARD.md, README.md). It reviews for:

- Edge cases and error paths
- Security concerns
- Performance implications
- Missing validations or guards
- Opportunities to reuse existing code that was overlooked
- Compliance with CLAUDE.md invariants
- Whether phases / cards are truly independent and verifiable
- **Whether phases / cards are vertical slices, not horizontal layers** — apply the acid test to every unit. If a unit produces nothing the user/QA can exercise, push the layer-work down into the first vertical slice that needs it. Reject layer-by-layer phasing/decomposition unless one of the two documented exceptions applies and is justified in the plan.
- **(Issues only) Dependency and overlap sanity** — every card declares `depends_on` and `touches`; the DAG has no cycles; no two cards in the same Ready batch share a `touches` path that can't be split.

**Chat reply cap: 300–500 words.** Reply with a diff summary: what changed, what stayed, and why. Do not re-emit the full plan or card bodies.

### Phase 4: Finalize

Once revision is accepted:

1. **Rename / confirm structure**:
    - **Sequential**: rename `plans/<plan-slug>.draft.md` to `plans/<plan-slug>.md`.
    - **Issues**: no rename — the directory `plans/<plan-slug>/` is already final after Phase 3 in-place revision. Confirm structure: `BOARD.md` + `cards/<id>.md` files (one per card) + `README.md` exist and are internally consistent.
2. **Clean up disk fallback**: if `plans/.research/<plan-slug>/` exists, delete it unless the user asks to keep it. If it never existed, this is a no-op — don't create it just to delete it.
3. **Commit the plan to the current branch** — required so that `/execute-prd`'s worktree (created from this branch) will inherit the plan files at `<worktree>/plans/<slug>...`. Steps:
    - Stage the plan: `git add plans/<plan-slug>.md` (sequential) or `git add plans/<plan-slug>/` (issues).
    - Confirm with the orchestrator the staged paths and the commit message: `chore(plan): add plan <plan-slug>`. One confirmation.
    - On approval, run `git commit -m "chore(plan): add plan <plan-slug>"`.
    - On decline, leave the plan staged; the orchestrator will commit it later. Tell them: "Plan staged but not committed. Run `git commit` when ready, then `/execute-prd <slug>`."
    - Do NOT push; pushing is the orchestrator's call.

**Do not execute the plan itself. This skill produces the plan + commit only. `/execute-prd` is a separate step.**

### Phase shape: vertical slices, not horizontal layers (applies to both shapes)

Every unit — phase (sequential) or card (issues) — must be a **vertical slice**: a thin, end-to-end piece the user (or QA) can exercise on its own. Never a **horizontal layer** (Phase/Card 1 = schema, 2 = API, 3 = UI) where nothing is testable until the last unit lands.

**Vertical (correct):**

- Unit 1 — one field works end-to-end: schema field + API route + minimal UI input + display. Testable: user enters the field, sees it stored, sees it back.
- Unit 2 — validation + error states. Testable: user sees error messages on bad input.
- Unit 3 — bulk import + advanced filters. Testable: user uploads a CSV.

**Horizontal (wrong):**

- Unit 1 — add all schema fields and migrations.
- Unit 2 — build all API routes.
- Unit 3 — build the full UI.

**The acid test for every unit:** "After this unit lands, what can the user (or QA) actually do that they couldn't before?" If the answer is "nothing observable," the unit is horizontal — combine it with the next, or push the layer-work down inside the first vertical slice that needs it.

**Allowed exceptions** (must be explicitly justified in the plan):

- Pure infrastructure prerequisites with zero user-facing surface (new package scaffold, worker process setup) — at most one thin unit before the first feature slice.
- Schema-only refactors with no behavior change.

When designing units, prefer "make the thin happy path work end-to-end first, then thicken it" over "build each layer fully before moving up the stack."

### Word caps by agent role

- **Research subagent, chat-only (default)** → ≤300 words in chat. The reply IS the artifact.
- **Research subagent using disk fallback** (`general-purpose`) → ≤50 words in chat (path + one-line summary + top 5 file paths). The disk file is unbounded.
- **Specialist writing draft to disk** → 200–400 words in chat.
- **Reviewer editing draft in place** → 300–500 words in chat.
- **Agent whose output is needed in-context** (rare in this skill) → no aggressive cap; 800–1500 is fine.

The goal isn't terseness — it's avoiding duplication. If it's in a file, don't also paste it in chat. If it's not in a file, distill it to signal.

---

## Naming convention

Plan slugs use kebab-case, descriptive names:

- `add-search-feature`
- `migrate-storage-layer`
- `refactor-payment-flow`

For sequential output, the file is `plans/<plan-slug>.md`. For issues output, the directory is `plans/<plan-slug>/`. Never both for the same slug.

---

## Reviewer Handoff Prompt

**Why this exists:** long implementation sessions burn context before the reviewer even starts. The handoff prompt lets the orchestrator `/clear` the session and re-enter with a clean slate — the reviewer sees only what it needs, not your full implementation transcript.

**Sequential workflow** (per phase):

1. Finish implementation work for the phase.
2. Tick every completed checkbox in the phase's Steps and Verification blocks in the plan file.
3. Emit the handoff prompt as the **final message of the turn**, in a fenced code block so the user can copy/paste verbatim.
4. User runs `/clear` and pastes the prompt into a fresh session.

**Issues workflow** (per card):

1. Finish implementation for the card in its session.
2. Update the card's frontmatter and BOARD.md to reflect Done state.
3. Emit the handoff prompt as the final message of the session, scoped to that card's commit.
4. Orchestrator opens a review session and pastes the prompt.

**Required contents of the handoff prompt** (both shapes):

- Absolute path to the plan file (sequential) or card file (issues)
- Phase number + name (sequential) or card id + title (issues)
- Commit SHA
- Files touched in this unit
- Focus areas — copy from the unit's review focus annotation
- Success criteria / acceptance criteria
- Explicit instruction: _read the plan file (or card file) and diff before writing the review_

**Template (fill fields, then emit in a fenced code block):**

    Run the code-reviewer agent on <Phase|Card> <id> of <plan-slug>.

    Plan: <absolute path to plan file or card file>
    Unit: <Phase N — name | Card C0X — title>
    Branch/commit: <branch> @ <sha>

    Files changed:
    - <path/to/file-1>
    - <path/to/file-2>

    Focus: <focus areas>

    Success / acceptance criteria: <copied from unit>

    Read the plan/card file and the diff before writing the review.
    Report back with: findings (blocking vs. nits), any plan or card fields that need updating, and a green/yellow/red verdict.

**Final-verification handoff** (both shapes): same template, scoped to the entire change end-to-end. List all phases / cards reviewed individually; instruct the reviewer to look for cross-unit regressions and CLAUDE.md invariant violations.

---

## Rules

1. **Research before design** — never skip Phase 1. Research subagents run first; the main thread never calls MCP tools or runs raw codebase searches itself during planning.
   1a. **Grill by default** — Phase 1.5 always runs. The only valid skip is when every Phase 1 subagent's `## Open Questions` block came back explicitly empty AND the user's original prompt left no scope/permission/UX/success-criteria decision implicit. If unsure, grill. Designing on top of unresolved assumptions throws away the plan.
2. **Shape decision is mandatory and explicit** — Phase 1.7 always runs and produces a recorded shape (`sequential` or `issues`). Never skip and let the specialist guess.
3. **Right agent for the job** — always route to the specialized agent when one fits. Only handle directly when no agent matches.
4. **The plan is the deliverable, not execution** — this skill produces a plan file or directory. The user/orchestrator initiates execution separately.
5. **Phases / cards map to commits** — each unit should be a single, coherent commit. If a unit needs multiple commits, split it.
6. **Units must be verifiable** — every unit needs concrete verification (tests, manual check that supplements tests). "Looks good" is not verification.
7. **Vertical slices, not horizontal layers** — applies to both shapes. See the "Phase shape" section.
8. **Verification is mandatory** — code-reviewer agent checks each unit individually AND a final verification covers the whole change.
   8a. **Reviewer handoff uses fresh context** — emit the handoff prompt as the final message of the implementation turn; orchestrator `/clear`s and pastes into a new session.
9. **Format-spec compliance** — the specialist must read and follow either `.claude/skills/plan-sequential/SKILL.md` or `.claude/skills/plan-issues/SKILL.md` exactly. The format skills are the source of truth for output structure; this skill is the source of truth for workflow.
10. **Follow CLAUDE.md** — all invariants, tool requirements, naming conventions, and patterns from CLAUDE.md apply. The plan must reference them where relevant.
11. **No execution** — this skill produces a plan. Execution is a separate step the user initiates.

---

## Common Pitfalls

- **Calling project-specific tools from the main thread** — defeats the whole point. Tool responses are large; they pollute context for the rest of the session. Always bake tool calls into research-subagent prompts.
- **Designing on top of unresolved ambiguity** — Phase 1.5 grills by default. Skipping it because research "felt complete" is the most common way plans go off the rails. Only skip when every subagent's `## Open Questions` block is explicitly empty.
- **Burying open questions in research prose** — every Phase 1 subagent must emit a separate `## Open Questions` block at the end of its reply (empty allowed, but the section header must be present). Open questions hidden inside the distillation get missed.
- **Skipping shape decision** — handing the specialist research findings without telling it `shape: sequential` or `shape: issues` produces inconsistent output. Phase 1.7 is mandatory.
- **Recommending issues when work isn't actually parallel** — if cards are mostly serial chains because everything depends on one big foundation card, sequential is better. Issues only pays off when 3+ branches can run independently.
- **Asking the user things the codebase already answers** — `grill-me` is for decisions only the user can make. The skill's contract enforces this.
- **Telling `Explore` to write to disk** — `Explore` lacks `Write/Edit/NotebookEdit`. Use `general-purpose` for any subagent that may use the disk fallback.
- **Horizontal layering** — units that map to architectural layers instead of feature slices. See the acid test in the "Phase shape" section.
- **Monolith units** — if a unit touches more than 3–4 files, it's probably too big. Split it.
- **Unverifiable units** — every unit must include concrete verification (tests, etc.).
- **Wrong agent** — sending a DB schema task to the frontend architect wastes effort.
- **Skipping revision** — Phase 3 catches real issues. Don't skip it.
- **Dumping research/drafts into chat** — blows the main context window. Subagents distill to ≤300-word chat replies (or use disk fallback for genuine overflow). Drafts go to disk, never inline.
- **Writing an `index.md` for `.research/`** — chat history of subagent replies already serves this purpose.
- **Using disk fallback when chat distillation would have worked** — `.research/<slug>/` is opt-in, for genuine overflow only.
