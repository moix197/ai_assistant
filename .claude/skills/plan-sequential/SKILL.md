---
name: plan-sequential
description: Internal format spec for sequential phased plans. Loaded on demand by `write-prd` and `execute-prd`; not user-invoked.
---

# plan-sequential — Output format spec

This skill is a **format library**, not an entry point. The `write-prd` skill
reads this file when the user (and Claude) chose `shape: sequential` in Phase
1.7. The specialist agent in Phase 2 follows this spec to produce the draft.

---

## File location

Single file at `plans/<plan-slug>.md` (final). During Phase 2/3 it's at
`plans/<plan-slug>.draft.md`; Phase 4 of `write-prd` renames it.

Slug is kebab-case, descriptive: `add-search-feature`,
`migrate-storage-layer`, `refactor-payment-flow`.

---

## Plan document structure

Every sequential plan file must follow this structure:

```markdown
# Plan: [Title]

**Created:** [date]
**Branch:** [suggested branch name]
**Status:** not started | in progress | done

## Context

Why this change is being made — the problem, what prompted it, intended outcome.

## Risk: [low | medium | high | ultra-high]

Overall risk assessment for the entire plan.

## Dependencies & Risks

- Known risks or things that could go wrong
- External dependencies
- Order-sensitive operations

## Phases

### Phase 0: Create worktree

**This phase is always first. No exceptions.**

Create a git worktree for this plan's branch. Always confirm worktree
creation with the user before running.

**Steps:**

- [ ] Confirm branch name and base ref with the user
- [ ] Run `git worktree add ../<branch-folder> -b <branch> <base-ref>`
- [ ] Verify worktree is active and on the correct branch (`git worktree list`)

---

### Phase 1: [Short description]

**Risk:** [low | medium | high | ultra-high]
**Mode:** afk | hil  <!-- afk = subagent can execute autonomously; hil = orchestrator must do or approve manually (UI testing, design decisions, deploy steps). Default: afk. Consumed by /execute-prd. -->
**Type:** backend | frontend | typescript | security | docs | ux | config | test | mixed  <!-- routes execution to a specialist subagent via /execute-prd. Default: mixed (general-purpose) when no specialist clearly fits. -->
**Success criteria:** [What "done" looks like for this phase — must be a user-visible / QA-exercisable outcome (e.g., "user can submit form X and see result Y"), not a layer-built statement (e.g., "schema fields added", "API route exists"). See "Phase shape" rule.]
**Commit message:** `[conventional commit message]`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `path/to/file.ts` | description of changes |
| create | `path/to/new-file.ts` | description of contents |
| delete | `path/to/old-file.ts` | why it's removed |

**Steps:**

- [ ] Step 1
- [ ] Step 2
- [ ] ...

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `src/__tests__/<feature>.test.ts` | unit/integration coverage for [behavior] |
| modify | `src/__tests__/<existing>.test.ts` | new cases for [behavior] |

If this phase has no testable logic, replace the table with: `No automated tests — justified because: [reason]`. Acceptable reasons: pure config registration with explicit validation coverage, pure README/docs change, pure scaffolding with no behavior. "It's hard to test" is **not** an acceptable reason.

Tests live alongside the code they exercise. Extract testable logic into a shared package (or the appropriate module) when the phase touches an app/route that has no test harness, and test it there.

**Verification:**

- [ ] Automated tests for this phase pass: <the project's test command>
- [ ] [Any additional verification — expected output, manual check that supplements tests]

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file (mark implementation-done _before_ handing off to reviewer — reviewer should see an up-to-date plan)
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn — see `write-prd` SKILL.md "Reviewer Handoff Prompt" section
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file (steps, file table, success criteria, tests table, or assumptions updated as needed — do this in the same turn as the code change, not deferred)
- [ ] Tests for this phase written and passing (see Tests subsection above) — or no-tests justification accepted
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `[commit message]`
- [ ] Phase marked complete

---

### Phase 2: [Short description]

[same structure as above]

---

### Phase N: Final Verification

**This phase runs after all other phases are complete.**
**Mode:** hil  <!-- always hil: orchestrator manually verifies end-to-end. /execute-prd will not dispatch a subagent for this phase. -->

**Overall success criteria:**

- [What "done" looks like for the entire plan — the end-state the user should be able to see, test, and confirm]

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review have been reflected back into this plan file
- [ ] All tests pass
- [ ] No CLAUDE.md invariants violated
- [ ] Feature tested manually (golden path + edge cases)
- [ ] Overall success criteria met
- [ ] All phase checkboxes above are ticked

## Documentation

Map each change to where its documentation belongs:

| Change        | Documentation location                         |
| ------------- | ---------------------------------------------- |
| [description] | `<path/to/README.md>` |

Documentation is added as a step within each relevant phase, not as a separate phase.

## Knowledge Base Impact

Identify the `.ai/` knowledge-base changes this plan requires. Decision-oriented only — capture *why*, constraints, and the map; never restate code.

| `.ai/` artifact       | Action          | What it captures                |
| --------------------- | --------------- | ------------------------------- |
| `index.md`            | update          | new module → path row           |
| `decisions/<slug>.md` | create          | the why + rejected alternatives |
| `<existing>`          | retire/outdated | now superseded by this change   |

If this plan introduces no new concept, module, flow, or decision, write `_None — no knowledge-base impact._`. Keeping `.ai/` current is part of "done" — `execute-prd` syncs it at closeout via the `sync-knowledge` skill, which owns the rules.

## Tests

Map each piece of testable logic introduced by this plan to the test file that covers it. Tests live alongside the code they exercise.

| Phase   | Logic under test         | Test file                                          |
| ------- | ------------------------ | -------------------------------------------------- |
| Phase 1 | [behavior / function]    | `src/__tests__/<feature>.test.ts`   |
| Phase N | …                        | …                                                  |

If a phase has no testable logic, list it here with the same justification used in the phase body. Manual-only verification is **not** acceptable when testable logic exists — extract it to a module and test it there.

Tests are written as a step within each relevant phase, not as a separate phase.

## Human Summary

<!-- This section is for humans only — Claude should write it but not use it for execution. -->

Plain-language overview of the entire plan:

- **What** we're building/changing and **why**
- How the phases connect — what each one accomplishes in simple terms
- What the end result looks like when everything is done
- Any important trade-offs or decisions made during planning
```

---

## Phase shape: vertical slices, not horizontal layers

Phases must be **vertical slices** — each one delivers a thin, end-to-end piece of the feature that the user (or QA) can exercise on its own. Never **horizontal layers** (Phase 1 = schema, Phase 2 = API, Phase 3 = UI) where nothing is testable until the last phase lands.

**Vertical (correct):**

- Phase 1 — one field works end-to-end: schema field + API route + minimal UI input + display. Testable: user enters the field, sees it stored, sees it back.
- Phase 2 — validation + error states. Testable: user sees error messages on bad input.
- Phase 3 — bulk import + advanced filters. Testable: user uploads a CSV.

**Horizontal (wrong):**

- Phase 1 — add all schema fields and migrations.
- Phase 2 — build all API routes.
- Phase 3 — build the full UI.

**The acid test for every phase:** "After this phase commits, what can the user (or QA) actually do that they couldn't before?" If the answer is "nothing observable," the phase is horizontal — combine it with the next, or push the layer-work down inside the first vertical slice that needs it.

**Allowed exceptions** (must be explicitly justified in the plan):

- Pure infrastructure prerequisites with zero user-facing surface (new package scaffold, worker process setup) — at most one thin phase before the first feature slice.
- Schema-only refactors with no behavior change.

---

## Execution conventions

- **Top-to-bottom**: phases run sequentially. Phase N+1 does not start until Phase N's review checklist is complete and the commit is in place.
- **One commit per phase**. Commit message comes from the phase's `Commit message` field.
- **Two ways to execute** — pick one:
    - **`/execute-prd <slug>`** (subagent-dispatched, recommended for plans with `Mode`/`Type` fields populated). Reads the next pending phase, dispatches the matching specialist subagent, fires `code-reviewer`, reports a verdict, waits for orchestrator approval. Stops on `Mode: hil` phases. See [`.claude/skills/execute-prd/SKILL.md`](../execute-prd/SKILL.md).
    - **Manual** — orchestrator runs phases in the current session, ticks checkboxes by hand, runs reviewer handoff per phase via `/clear` + paste.
- **Reviewer handoff after every phase**: see the "Reviewer Handoff Prompt" section in `write-prd` SKILL.md (used by both execution paths).
- **Tick checkboxes in the plan file** as you go — the file is the source of truth for progress. Reviewer should always read an up-to-date plan. Under `/execute-prd`, the main thread ticks them after each phase; subagents do not edit the plan file.
- **Reflect reviewer-driven changes back into the plan file in the same turn** as the code change. The plan must always reflect the actual implementation.

---

## Format-specific rules

1. **Phase 0 is always worktree creation** — every plan starts with a `git worktree add` step. No exceptions. Always confirm worktree creation with the user before running.
2. **Phases map to commits** — each phase = one commit. If a phase needs multiple commits, split it.
3. **Phases are vertical slices** — see the section above. Two exceptions, both requiring justification: pure infra prereqs, or schema-only refactors.
4. **Tests are per-phase and enumerated** — every phase with testable logic lists concrete test files in its `Tests` subsection AND in the top-level `Tests` mapping table.
5. **Documentation is per-phase** — each phase that changes package behavior includes a documentation step pointing to the relevant README.
6. **Mark progress in the document** — tick checkboxes after executing a phase, before moving on.
7. **Never auto-commit** — orchestrator (user) approval required before each commit.

---

## Common pitfalls

- **Horizontal layering** — phases that map to architectural layers instead of feature slices. Nothing testable until the last phase lands.
- **Monolith phases** — if a phase touches more than 3–4 files, split it.
- **Unverifiable phases** — "update config" with no way to verify is incomplete. Add a test command.
- **Manual-only verification when testable logic exists** — extract the logic to a module and test it there.
- **Missing documentation mapping** — every plan must map changes to README locations.
- **Missing tests mapping** — every plan must include the top-level `Tests` mapping table covering every phase with testable logic.
- **Skipping Phase 0** — never start implementation without creating the worktree first.
- **Skipping reviewer handoff** — every phase ends with a reviewer-handoff prompt; orchestrator clears context before review.
