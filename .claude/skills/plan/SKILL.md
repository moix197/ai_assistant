---
name: plan
description: >
    Alias / redirect to the `write-prd` skill. The plan skill has been split into
    `write-prd` (workflow: research, specialist design, revision, shape decision)
    plus two output-format spec skills (`plan-sequential`, `plan-issues`). Use
    `write-prd` directly for new plans. This alias keeps `/plan` working.
---

# plan (alias)

This skill has been replaced by `write-prd` ([`.claude/skills/write-prd/SKILL.md`](../write-prd/SKILL.md)).

The plan skill is split into three:

- **`write-prd`** — workflow orchestrator. Owns research, specialist design,
  revision, and the shape decision (sequential vs issues) that picks the
  output format mid-flow.
- **`plan-sequential`** — output-format spec for single-file phased plans.
- **`plan-issues`** — output-format spec for kanban-style DAG plans (parallel
  sessions execute Ready cards in the same worktree).

## What to do when this alias fires

Tell the user the plan skill has moved, then invoke `/write-prd` with the
same task. Example response:

> The `plan` skill has been refactored into `write-prd` (workflow) +
> `plan-sequential` / `plan-issues` (output formats). Continuing with
> `/write-prd` — it will run research, then ask you mid-flow whether to
> output as sequential phases or as a kanban DAG of independent cards.

Then proceed exactly as `write-prd` SKILL.md describes (Phase 1: Research,
Phase 1.5: Grill-me if needed, Phase 1.7: Shape decision, Phase 2: Design,
Phase 3: Revision, Phase 4: Finalize).
