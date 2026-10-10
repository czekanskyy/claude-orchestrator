---
name: orchestrate
description: Runs a task as the orchestrator - classify it, plan it, split it into work packages, hand each to the right Claude subagent or Codex worker with the right model and effort, cross-check every result with the other model family, then integrate and commit. Use for any task bigger than a single small edit, or when the user says "orchestrate", "delegate" or names a model family.
argument-hint: "[task]"
---

**Project override first.** If the current repo has its own orchestration docs (for example
`docs/orchestration.md` and `docs/runbooks/delegate-to-codex.md`) or its own `orchestrate` skill in
`.claude/skills/`, follow those and ignore the rest of this file, using the project's own
subagents from `.claude/agents/`.

Otherwise the Claude workers are this plugin's subagents, `orchestrator:<role>` (for example
`orchestrator:implementer`); the docs below use the bare role names for short.

Otherwise read, in this skill's folder, `roster.md` (who gets what, effort, cross-checks, limits)
and `codex.md` (how to call each worker), and follow them.

The loop, so you can check yourself while reading:

1. **Classify**: size S/M/L and risk normal/critical, in one line to the user.
2. **Plan**: inline for S and M; `planner` for L or critical, then a cross-check of the plan.
3. **Ledger**: one table row per work package, with owner model, effort and cross-checker.
4. **Delegate**: self-contained briefs; parallel only on disjoint files; Codex calls with `--wait`.
5. **Verify**: `runner` runs the checks each brief named.
6. **Cross-check**: the family that did not write it reviews it (dictated `scribe` edits and
   `runner` output are exempt). Two rounds at most.
7. **Finish**: the project's definition of done (its `finish-task` skill or docs, if any), then you
   commit, following the project's git rules. Workers never commit.
8. **Report**: the final ledger, check results, review findings and what was left open.

Task: $ARGUMENTS
