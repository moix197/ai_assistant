---
name: execute-prd
description: Execute a plan from `plans/` (sequential file or issues BOARD.md). Triggers on "/execute-prd", "execute the plan", "run the plan".
---

# execute-prd Skill

Reads a finalized plan and executes it by dispatching specialized subagents per
unit. The orchestrator (you, the user) stays in the loop: after each unit's
implementation + code-review, the skill reports a one-line verdict and waits
for orchestrator approval before advancing.

The main context stays small because subagents commit their own work; the main
thread sees only ≤150-word implementation reports and ≤200-word review
reports.

---

## Preflight

Before starting any execution loop, the skill performs these checks **in
order**. Bail with a clear instruction if any fails.

1. **Resolve plan path.** Argument is `<plan-slug>` (kebab-case, no extension). Resolve relative to the current working directory's `plans/`.
    - If `plans/<slug>.md` exists → shape is **sequential**.
    - Else if `plans/<slug>/BOARD.md` exists → shape is **issues**.
    - Else → abort: "No plan found at `plans/<slug>.md` or `plans/<slug>/BOARD.md`. Run `/write-prd` first."
    - Capture the **absolute** plan path (sequential: file; issues: directory). Subagents will receive these via prompt — they read plans by absolute path because the main thread's CWD is not the worktree.

2. **Read the plan's declared branch and base ref.** From sequential `**Branch:**` line near the top of `plans/<slug>.md`, or `**Branch:**` line in `plans/<slug>/BOARD.md`. The base ref defaults to the repo's default branch unless the plan specifies otherwise.

3. **Parse flags.** Supported flags:
    - `--concurrency <N>` — issues only. Default 3, hard cap 4. Sequential ignores this (always 1).
    - `--once` — run exactly one batch (issues) or one phase (sequential), then exit. Lets the orchestrator `/clear` between batches to reset context.
    - `--afk-only` — issues only. Skip `mode: hil` cards entirely; process only afk Ready cards in batches. When all afk-Ready cards have completed (Done) or are blocked behind hil deps, exit cleanly with a "hil-pending" report listing the remaining hil cards. Sequential plans ignore this flag (phases are strictly ordered, so a hil phase always blocks subsequent ones regardless).
    - `--card <id>` — issues only. Run only the named card if it's Ready; abort if not.
    - `--phase <n>` — sequential only. Run only that phase if it's the next pending; abort if not.

After preflight, run **Phase 0 / Card C00 — Worktree creation** (next section), then branch into the matching execution loop.

---

## Phase 0 / Card C00 — Worktree creation (always runs first)

The plan declares a branch (e.g., `feature/search`) and a base ref (e.g., the repo's default branch). This step ensures a worktree exists for that branch and captures its absolute path; all subsequent unit work happens inside that worktree, addressed via absolute paths from the main thread.

1. **Detect existing worktree.** Run `git worktree list` (Bash, from main thread's CWD). If a worktree for the plan's branch already exists, capture its absolute path; skip to step 4.

2. **Confirm the create command.** If no worktree exists, build the command:
    ```
    git worktree add ../<branch-folder> -b <plan-branch> <base-ref>
    ```
    Display it to the orchestrator and ask for confirmation (one prompt, default `yes`). Always confirm worktree creation with the user before running.

3. **Run create.** On confirmation, run the command via Bash. On failure (branch already exists with a different base, base ref doesn't exist, etc.), report the git error verbatim and abort.

4. **Capture the worktree absolute path.** Run `git worktree list` again, parse the row matching the plan's branch, store the absolute path as `<worktree>` for use in all subsequent commands and subagent prompts.

5. **Verify the worktree is clean enough.** Run `git -C <worktree> status --porcelain`. If there are uncommitted changes that overlap with any pending unit's `touches`, abort: "Worktree has uncommitted changes that overlap with pending units. Commit or stash before executing." Unrelated uncommitted changes are fine.

6. **Phase 0 / C00 is implicit — no plan-file edit, no commit.** The worktree's existence (verified by `git worktree list` in step 1) IS the signal that Phase 0 / C00 is done. The Phase 0 / C00 section in the plan stays as documentation only; its checkboxes / frontmatter are not touched by `/execute-prd`.
    - For sequential: when looking for "the next pending phase," skip Phase 0 unconditionally — start the search at Phase 1.
    - For issues: when computing the Ready set, treat Card C00 as if it had `status: done` regardless of what its frontmatter says — exclude it from Ready and from the unmet-`depends_on` check (any card with `depends_on: [C00]` is treated as having that dep satisfied).

7. Proceed to the matching execution loop.

**Path handling for the rest of execution:**

- The main thread **never `cd`s** (Bash `cd` doesn't persist across tool calls). It addresses the worktree explicitly via:
    - **Git operations**: `git -C <worktree> <subcommand>` (e.g., `git -C <worktree> status`, `git -C <worktree> log -1`).
    - **File operations**: absolute paths (Read, Edit, Write tools accept absolute paths natively).
    - **Test/build commands**: `cd <worktree> && <test command>` in a single Bash call (cd persists for the chained command).
- **Subagent prompts** include `Working directory: <absolute path to worktree>` and explicit instructions to use the same patterns (`cd <worktree> && ...` for shell, absolute paths for file ops, `git -C <worktree> ...` for git).
- **Plan files live INSIDE the worktree** at `<worktree>/plans/<slug>.md` (sequential) or `<worktree>/plans/<slug>/` (issues). Subagents read AND update them via worktree-internal absolute paths. Plan/BOARD/card updates are committed in the worktree alongside (or amended into) the corresponding code commit.

---

## Sequential execution loop

```
loop:
    read plan, find next pending phase
    if none → "All phases done." stop
    if phase.mode == hil → emit hil-stop report, wait for orchestrator
    else → dispatch implementation subagent
           wait for report
           dispatch code-reviewer subagent
           wait for verdict
           tick checkboxes in plan file
           emit one-line phase report to orchestrator
           wait for orchestrator approval
    if --once → stop after one phase
```

**Finding the next pending phase**:

1. Read `<worktree>/plans/<slug>.md`.
2. Skip Phase 0 unconditionally (worktree creation is implicit — handled by preflight; Phase 0's checkboxes never get ticked, by design).
3. Find the first phase (Phase 1 onward) whose final review checkbox (`- [ ] Phase marked complete`) is unticked.
4. If that phase is the Final-Verification phase, treat it as `Mode: hil` regardless of declared mode.

**hil-stop report** (when `Mode: hil`):

```
Phase <N> — <name> is **hil** (human-in-the-loop).

Required action: <copy the phase's "Steps:" or hil instructions verbatim>

Files in scope: <copy from phase's File changes table>

When done, tick the phase's review checkboxes in plans/<slug>.md and reply
to advance.
```

Then stop. Wait for orchestrator's next message before recomputing.

**Implementation subagent dispatch** (when `Mode: afk`):

Use the Agent tool. `subagent_type` from the unit's `Type` field via the
mapping in this skill's "Subagent → specialist mapping" section.

Prompt template (fill bracketed fields, keep ≤500 words):

```
You are implementing Phase <N> of plan <slug>.

Working directory (worktree): <absolute path to worktree>
Plan file: <worktree>/plans/<slug>.md
CLAUDE.md: <worktree>/CLAUDE.md

Path-handling rules (your shell session is NOT in the worktree):
- File ops (Read/Edit/Write): use absolute paths starting with the worktree path.
- Shell commands (tests, builds): prefix with `cd <worktree> && ...` in a single Bash call.
- Git commands: use `git -C <worktree> <subcommand>` form (e.g., `git -C <worktree> status`).

Your task: <copy the phase's success criteria and steps verbatim>

Files in scope (do not edit anything outside this list — paths are relative to the worktree root, but use absolute paths in tool calls):
<copy the phase's File changes table>

Tests to run:
<copy the phase's Tests table>

Required workflow:
1. Read the plan file (absolute path above) and the phase's full body.
2. Read CLAUDE.md (absolute path above). Use any project-specific MCP tools
   listed there BEFORE reading config, model, or permission files directly.
3. Reuse existing helpers — check existing utility / shared packages in the
   repo before writing new utilities.
4. Implement per the phase's steps. Stay within the file list above; if you
   discover you need to touch a file outside it, STOP and report instead of
   editing.
5. Run the tests via `cd <worktree> && <test command>`. If they pass, proceed;
   if any fail, STOP and report.
6. Commit with: `git -C <worktree> add <touches> && git -C <worktree> commit -m "<copy the phase's Commit message>"`.
7. Reply with (≤150 words):
   - Commit SHA (from `git -C <worktree> log -1 --format=%H`)
   - Files changed (paths only)
   - Tests run + result
   - Any concerns or things the orchestrator should know

Do NOT:
- Edit the plan file or check off any checkboxes (the main thread does that).
- Edit files outside the in-scope list.
- Skip project-specific MCP tools listed in CLAUDE.md.
- Add scope beyond the phase's success criteria.
- Add error handling or fallbacks for things that can't happen.
- Commit secrets or .env files.
- `cd` your shell session permanently (each Bash call starts fresh; chain `cd <worktree> && ...` in each call that needs the worktree CWD).
```

**Code-reviewer dispatch** (after implementation reports success):

```
Review Phase <N> of plan <slug>.

Plan file: <abs path>
Phase: <N> — <name>
Commit SHA: <sha>
Branch: <branch>

Files changed in this phase:
<list>

Focus areas: <copy from phase review section>
Success criteria: <copy from phase header>

Read the plan file and the diff before writing the review.

Reply with (≤200 words):
- Findings: blocking | nits (with file:line refs)
- Verdict: green | yellow | red
- If red: what specifically must change before this phase ships
```

**After both subagents return**:

- Tick the phase's review checkboxes in the plan file (Steps, Verification, Phase review — except the orchestrator-approval and final-commit boxes if those are workflow-only).
- Emit a one-line report: `Phase <N> done. Commit <sha>. Code-review: <verdict>. Tests: <summary>.`
- Wait for orchestrator's reply. Common replies: "ok next" → continue; "fix X" → re-dispatch implementation subagent with fix instructions; "stop" → exit.
- If `--once` was passed, stop after this phase regardless.

---

## Issues execution loop

```
loop:
    read BOARD.md, scan cards/
    compute Ready set (per plan-issues predicate)
    partition into Ready-afk and Ready-hil
    if Ready-afk non-empty:
        take up to N (concurrency) afk cards
        dispatch N implementation subagents IN PARALLEL (single Agent message)
        await all
        dispatch N code-reviewer subagents IN PARALLEL
        await all
        emit per-card one-line reports
        wait for orchestrator approval
    elif Ready-hil non-empty:
        if --afk-only:
            emit "hil-pending" report listing all remaining hil cards
            stop (orchestrator handles them later, then re-invokes without --afk-only)
        else:
            emit hil-stop report for first Ready-hil card
            wait for orchestrator
    else:
        "All cards done (or only Failed/blocked-on-Failed remain)." stop
    if --once → stop after one batch
```

**Computing Ready set**:

A card is **Ready** iff (per [`plan-issues`](../plan-issues/SKILL.md)):
1. `status: ready` in frontmatter
2. Every card in `depends_on` has `status: done`
3. No card with `status: in-progress` shares any path in `touches`

**C00 (worktree creation) is treated as always-done by `/execute-prd`** regardless of what its frontmatter says — exclude C00 from the Ready set, and treat any `depends_on: [C00, …]` as if C00 were already done. The worktree's existence (confirmed in preflight via `git worktree list`) is the source of truth, not the BOARD's view of C00. C00's frontmatter is never edited by `/execute-prd`.

The skill recomputes Ready before every batch.

**Selecting the batch**:

- Sort Ready-afk by: most downstream dependents (unblocks the most), then smallest id.
- Take up to `--concurrency` cards (default 3, hard cap 4).
- The hard cap exists to bound chat growth — never raise it without orchestrator awareness.

**Parallel implementation dispatch**:

Single Agent-tool message with N tool uses, each with `subagent_type` matching that card's `type` field.

Prompt template per card (≤400 words each):

```
You are implementing Card <id> of plan <slug>.

Working directory (worktree): <absolute path to worktree>
Plan README: <absolute path to plans/<slug>/README.md>
BOARD: <absolute path to plans/<slug>/BOARD.md>
Plan README: <worktree>/plans/<slug>/README.md
BOARD: <worktree>/plans/<slug>/BOARD.md
Card file: <worktree>/plans/<slug>/cards/<id>.md
Format spec (read this for the session-pickup protocol):
  <absolute path to .claude/skills/plan-issues/SKILL.md>
CLAUDE.md: <worktree>/CLAUDE.md

Path-handling rules (your shell session is NOT in the worktree):
- File ops (Read/Edit/Write): use absolute paths starting with the worktree path.
- Plan/BOARD/card files live INSIDE the worktree (paths above). Edit them via
  absolute paths, and commit the edits in the worktree along with your code.
- Shell commands (tests, builds): prefix with `cd <worktree> && ...` in a single
  Bash call.
- Git commands: use `git -C <worktree> <subcommand>` form. The same commit that
  carries your code changes (`touches`) also carries the card-frontmatter and
  BOARD.md updates — one commit per card.

Required workflow (follows plan-issues "Session pickup protocol"):
1. Read the card file (absolute path) in full.
2. Mark this card in-progress: update its frontmatter (status: in-progress,
   session: <your session id, e.g., "execagent-<id>">), and update BOARD.md
   to move the card from Ready to In Progress with the session id annotation.
   These edits live in the worktree but stay UNCOMMITTED for now (they'll be
   amended into the success commit at step 7).
3. Use any project-specific MCP tools listed in CLAUDE.md BEFORE reading
   config, model, or permission files directly.
4. Reuse existing helpers — check existing utility / shared packages in the
   repo before writing new utilities.
5. Implement per the card's Acceptance criteria, editing files inside the
   worktree using absolute paths. Stay within `touches`; if you need to touch
   a file outside it, STOP and report instead of editing.
6. Run the tests listed in Acceptance criteria via `cd <worktree> && <test cmd>`.
   If any fail, STOP and report (do NOT commit on failure).
7. On success:
   a. Update card frontmatter (worktree path): status: done, session: null.
      Tick all Acceptance checkboxes. Leave `commit:` empty for now — fill it
      after the commit lands.
   b. Update BOARD.md (worktree path): move card from In Progress to Done;
      recompute Stats.
   c. Stage everything for this card — code (`touches`) + card file +
      BOARD.md: `git -C <worktree> add <each path in touches> <card file> <BOARD>`.
   d. Commit: `git -C <worktree> commit -m "<type>(<scope>): <title> [#<id>]"`.
   e. Capture the commit SHA: `git -C <worktree> log -1 --format=%H`.
   f. Amend the SHA into the card frontmatter: edit the card again to set
      `commit: <sha>`, then `git -C <worktree> add <card file> && git -C <worktree> commit --amend --no-edit`. The history shows one commit per card.
8. Reply with (≤100 words):
   - Commit SHA
   - One-sentence summary of the change
   - Tests run + result

On failure:
- Revert worktree edits inside `touches`: `git -C <worktree> checkout -- <each path in touches>`.
- Update card frontmatter (worktree path): status: failed, session: null,
  commit: null. Append a "Failure notes" section to the card body explaining
  what went wrong.
- Update BOARD.md (worktree path): move card from In Progress to Failed.
- Stage and commit the failure-state update only:
  `git -C <worktree> add <card file> <BOARD> && git -C <worktree> commit -m "chore(plan): mark <id> failed [#<id>]"`.
- Reply with: "FAILED. Card C<id>. Reason: <one sentence>."

Do NOT:
- Edit files outside `touches` (other than the card file and BOARD.md, which
  are explicitly part of this card's commit).
- Skip project-specific MCP tools listed in CLAUDE.md.
- Pick a different card than the one assigned.
```

**Parallel code-reviewer dispatch**:

After all implementation subagents return, fire one `code-reviewer` per
successful commit, in parallel (single Agent message with N tool uses).

Per-card review prompt (≤300 words each):

```
Review Card <id> of plan <slug>.

Card file: <abs path>
Plan README: <abs path>
Commit SHA: <sha>
Branch: <branch>

Files changed: <list from card touches>
Focus areas: <copy from card "Notes for QA">
Acceptance criteria: <copy from card body>

Read the card file and the diff before writing the review.

Reply with (≤200 words):
- Findings: blocking | nits (with file:line refs)
- Verdict: green | yellow | red
- If red: what specifically must change before this card ships
```

**After all reviews return**:

- Emit per-card one-line reports: `C<id>: <title>. Commit <sha>. Code-review: <verdict>.`
- Wait for orchestrator approval. Common replies: "ok continue" → recompute Ready, next batch; "fix C<id>" → re-dispatch that one card with fix instructions; "stop" → exit.
- If `--once` was passed, stop after this batch regardless.

**hil-stop report** (default mode, when only Ready-hil cards remain):

```
Card <id> — <title> is **hil**.

Required action: <copy card's Scope + Notes for QA>

Files in scope: <copy touches>

When done, update the card frontmatter (status: done, commit: <sha if any>)
and BOARD.md (in <worktree>/plans/<slug>/), commit those updates in the worktree,
then reply to advance.
```

**`--afk-only` exit report** (when `--afk-only` is set and only Ready-hil cards remain):

```
afk Ready set is exhausted. <K> hil card(s) remain:
- C<id1>: <title>
- C<id2>: <title>
- ...

Handle these manually inside the worktree (<absolute path>):
1. For each hil card: do the work, update its frontmatter (status: done,
   commit: <sha if any>) and BOARD.md, commit in the worktree.
2. When all hil cards are Done, re-invoke `/execute-prd <slug>` (without
   --afk-only) to run any remaining afk cards unblocked by the hil work,
   then run the closeout sequence.
```

The skill exits cleanly. No further action until the orchestrator re-invokes.

---

## Closeout: Final-Verification → merge-back → worktree cleanup

Runs once both loops report "all units done." Sequential plans reach this when the Final-Verification phase is the last unticked phase; issues plans reach it when every card is Done except Final-Verification.

### Step 1 — Final-Verification (always `hil`)

Emit the end-to-end checklist to the orchestrator:

```
Final Verification — <plan-slug>

This is hil; please run:
- Full test suite: cd <worktree> && <the project's test command>
- Manual smoke test: golden path + the edge cases the plan flagged
- Confirm no CLAUDE.md invariants are violated

When all green, mark Final-Verification Done in the worktree's plan files
and commit, then reply to proceed to merge-back. Reply "stop" to exit
without merging.
```

Wait for orchestrator. They run the checks, mark Final-Verification Done in `<worktree>/plans/<slug>...` and commit, then reply.

### Step 2 — Offer merge-back

Once Final-Verification is Done:

```
Ready to merge <branch> back into <target>.
Planned commands (run from the main checkout, not the worktree):
  git checkout <target>
  git merge <branch>

Confirm? (Y/n)  (default Y)
```

`<target>` is the plan's declared base ref (typically the repo's default branch). Always confirm merge with the user before running. On approval, run the commands via Bash from the main thread.

**On merge conflict** — git will report which files conflict. Emit those details to the orchestrator with this template, then exit:

```
Merge of <branch> into <target> hit conflicts. Resolve in the main checkout:
  # edit conflicting files
  git add <files>
  git commit
Then continue. If you'd rather resolve in the worktree, abort the merge
(`git merge --abort`), switch contexts, and re-run after resolution.

When the merge succeeds, re-invoke `/execute-prd <slug>` to continue the
closeout (worktree cleanup).
```

The skill never resolves conflicts itself or switches branches manually.

### Step 3 — Offer worktree cleanup (only if merge succeeded)

After a successful merge, run `git -C <worktree> status --porcelain`. Then:

- **If clean**, ask:
  ```
  Worktree at <absolute path> is clean. Remove it? (y/N)  (default N)
  ```
  - On explicit yes: run `git worktree remove <absolute path>`. Note that removing the branch is a separate step: `git branch -d <branch>` (only if the orchestrator specifically asks). Report success.
  - On no or anything else: leave the worktree in place, report its path.

- **If not clean**: do NOT offer removal. Report the dirty paths and the worktree path so the orchestrator can decide.

The skill never auto-removes a worktree. Always confirm worktree removal with the user before running.

### Step 4 — Sync the `.ai/` knowledge base

Runs once, after merge-back is confirmed (all code has landed on the target
branch). Keeps the project knowledge base current so future research reads the
map instead of re-deriving the codebase.

- **Skip cleanly** if `.ai/` does not exist, or the plan's `## Knowledge Base
  Impact` section is `_None — no knowledge-base impact._`. Report "KB: no impact"
  and continue.
- Otherwise, read the plan's `## Knowledge Base Impact` section and invoke the
  `sync-knowledge` skill (`.claude/skills/sync-knowledge/SKILL.md`) to create,
  update, or retire the listed `.ai/` files on the merged branch. That skill owns
  the format and the decision-oriented rules — do not reimplement them here.
- Collect the list of `.ai/` files it touched for the Final report.

### Final report

```
Plan <slug> complete.
Branch: <branch>  →  merged into <target> at commit <sha>
Worktree: <path> (kept | removed)
Knowledge base: <.ai/ files synced | no impact>
```

Then exit.

---

## Failure handling

| Situation | Main-thread action |
|---|---|
| Implementation subagent reports failure (proper protocol) | Trust the subagent's revert and frontmatter update. Verify with `git -C <worktree> status` (worktree clean) and `git -C <worktree> log -1` (no orphan commit). Mark phase pending (sequential) — already handled for issues. Report to orchestrator. |
| Implementation subagent crashes / times out | Run `git -C <worktree> status --porcelain`. For any path within the unit's `touches` showing as modified, run `git -C <worktree> checkout -- <path>`. Mark unit failed (issues) or pending (sequential). Report. |
| Subagent edited files outside `touches` | Abort hard. Run `git stash --include-untracked` then `git stash drop` to discard the polluting changes. Mark unit failed. Report — this is a parallel-safety violation. |
| Code-reviewer returns red | Do NOT advance. Report blocking findings to orchestrator. Do not auto-revert (the commit may still be valuable as a checkpoint). Orchestrator decides: re-dispatch with fix, accept-with-followup-card, or `git revert`. |
| Two parallel subagents both claim the same card (race) | Should be impossible — main thread assigns cards from the Ready set in one batch. If observed, abort the loop and report. |

---

## Subagent → specialist mapping

| `type` field | `subagent_type` |
|---|---|
| `backend` | `backend-architect` |
| `frontend` | `nextjs-frontend-architect` |
| `typescript` | `typescript-expert` |
| `security` | `api-security-auditor` |
| `docs` | `api-documenter` |
| `ux` | `ux-design-architect` |
| `config` / `test` / `mixed` / unset / unknown | `general-purpose` |

For code review, always use `code-reviewer`.

---

## Context-budget discipline

The whole point of subagent dispatch is to keep the main thread small. Strict
caps protect that:

- **Implementation reply cap**: ≤150 words (sequential) / ≤100 words (issues
  cards, since the protocol is more constrained).
- **Code-review reply cap**: ≤200 words.
- **Per-card chat footprint**: ~250–300 words after both reports.
- **Per batch at concurrency 3**: ~750–900 words. Stays well under one cache
  window for several batches.
- **`--once` flag** is the escape hatch: run one batch, exit, orchestrator
  `/clear`s, re-invokes for the next batch — full context reset between
  batches.

The main thread NEVER:
- Pastes diffs into chat (use `git log`/`git show` if the orchestrator asks).
- Echoes plan or card bodies (subagents read them from disk).
- Streams subagent intermediate output (only the final reply lands in chat).

---

## Reporting format (to the orchestrator)

After each phase or card cycle, emit exactly this:

**Sequential**:

```
Phase <N> — <name>. Commit `<sha>`. Code-review: <verdict>. Tests: <summary>.
<blocking findings if red, in 1–3 lines>
```

**Issues batch**:

```
Batch <K> ran <M> card(s) at concurrency <N>:
- C<id1>: <title>. Commit `<sha>`. Review: <verdict>.
- C<id2>: <title>. Commit `<sha>`. Review: <verdict>.
- ...
<any blocking findings, one line per affected card>
Ready next: <count> cards. Blocked: <count>. Done: <total>/<total>.
```

Then stop and wait for orchestrator's reply.

---

## Rules

1. **Auto-detect, don't ask** — shape comes from filesystem. No prompt for sequential vs issues.
2. **Phase 0 / C00 is implicit** — `/execute-prd`'s first action is to ensure the worktree exists. If it doesn't, run `git worktree add` (after one user confirmation — always confirm worktree creation with the user before running). Phase 0 / C00 in the plan files is documentation only — `/execute-prd` never ticks Phase 0's checkboxes, never edits C00's frontmatter, never commits a "Phase 0 done" marker. The worktree's existence (verified by `git worktree list`) IS the source of truth. Sequential phase iteration starts at Phase 1; issues Ready computation excludes C00 and treats `depends_on: [C00]` as satisfied. The orchestrator never has to `cd` first; the main thread addresses the worktree via `git -C <worktree>` and absolute paths, and tells subagents the same.
3. **One commit per unit** — enforced by subagent prompts (sequential planned message; issues `[#C<id>]` convention).
4. **`hil` stops the loop** — never dispatch a subagent for a `hil` unit. Report and wait. With `--afk-only` (issues), exit cleanly with a hil-pending report instead of waiting.
5. **Concurrency cap is a hard limit** — default 3, max 4. Override only via flag, never silently.
6. **Code-review always runs** — every successful implementation commit gets a code-reviewer pass. Final-Verification is the orchestrator's pass, not a subagent's.
7. **Orchestrator approval gate** — main thread reports verdict and waits before advancing. The exception: with `--auto` (future flag, not v1) verdicts auto-advance unless red.
8. **Subagents commit their own work** — the main thread never runs `git commit` on subagent output. This is what keeps context small.
9. **Touches violations are hard aborts** — a subagent that edits outside `touches` corrupts parallel safety. Stash-drop the changes, mark failed, report.
10. **Plan files live in the worktree** — `<worktree>/plans/<slug>...`, committed there. Subagents update card frontmatter + BOARD.md and include those updates in the same commit as their code changes (one commit per card). Sequential checkboxes are ticked by the main thread (still in worktree paths) and committed alongside the phase commit.
11. **Closeout is part of the loop** — after all units Done, `/execute-prd` runs Final-Verification (always `hil`) → offers merge-back (one confirmation) → offers worktree cleanup (default NO). Never auto-merges or auto-removes. Always confirm worktree creation / merge / removal with the user before running.
12. **Follow CLAUDE.md** — every dispatched subagent prompt cites CLAUDE.md and any project-specific MCP tools listed there. Non-negotiable.

---

## Common pitfalls

- **Skipping Phase 0 / C00** — never start unit work without ensuring a worktree exists for the plan's branch. The first action of every `/execute-prd` run is the Phase 0 / C00 worktree-creation step (auto-detect via `git worktree list`, create with one user confirmation if missing). Subagents must operate inside that worktree via absolute paths and `git -C <worktree>`.
- **Forgetting `git -C <worktree>` in the main thread** — running `git status` in the main thread checks the main checkout, not the worktree. Always use `git -C <worktree>` for any git command that should target the plan's worktree. Same for subagent prompts.
- **Telling subagents to `cd <worktree>` permanently** — Bash `cd` in a subagent is just as transient as in the main thread. Each Bash call needs its own `cd <worktree> && ...` chain (or `git -C <worktree>` for git commands).
- **Allowing concurrency > 4** — bounds the main context. If the orchestrator wants more parallelism, they can run two `/execute-prd` instances in two sessions in the same worktree (each with concurrency ≤4) — but that's a manual decision, not a flag.
- **Letting subagents tick checkboxes in sequential plans** — duplicates work and risks two writers touching the same plan file. Main thread owns sequential checkboxes; subagents own issues frontmatter+BOARD.md.
- **Skipping code-review** — every commit gets reviewed. If the orchestrator wants to skip review for a trivial fix, they can do so manually after `--once`.
- **Re-dispatching a failed card without orchestrator instruction** — never auto-retry. Failures usually indicate a flawed card spec; orchestrator decides whether to fix the spec or fix the implementation.
- **Pasting subagent intermediate output** — only the final ≤150-word (impl) / ≤200-word (review) reply belongs in main context. Subagent transcripts stay in the subagent.
- **Confusing `hil` with broken** — hil is a deliberate orchestrator handoff, not a failure. Keep the report tone neutral and instructional.
- **Letting the worktree drift** — if a sequential phase commits, then the orchestrator does manual work that adds uncommitted changes inside the worktree, the next phase's subagent sees a dirty worktree. Preflight should re-check `git -C <worktree> status` between phases (specifically, that no pending unit's `touches` overlap with current uncommitted paths).
- **Recomputing Ready while a batch is mid-flight** — only recompute after ALL parallel subagents in the batch return. Recomputing mid-batch can pick a card that overlaps with an in-flight one.
