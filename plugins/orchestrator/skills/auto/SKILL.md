---
name: auto
description: Autonomous (unattended, e.g. overnight) orchestrator run (/orchestrator:auto). Start contract with the user once, then an external supervisor works alone in a dedicated git worktree on branch auto/<id> (checkpoint commits, never a push, narrow generated permission allowlist), waits through usage limits instead of failing, and writes only files until the morning report. Subcommands - start (default), status, report, review, pause, continue, stop, takeover, abort.
argument-hint: "[start|status|report|review|pause|continue|stop|takeover|abort] [task description]"
disable-model-invocation: true
---

# Orchestrator auto

User-triggered only. Backend: `node "${CLAUDE_PLUGIN_ROOT}/scripts/auto.mjs" <cmd>` (JSON on stdout), run from the repo root. Everything the user reads is **Polish**; files, code and comments English. Design, files, limit handling, caveats: `${CLAUDE_PLUGIN_ROOT}/references/autonomous.md` (read it only when a step needs it). While a run is going you print NOTHING about it unprompted; `status` and `report` are read-only.

## Subcommands
- `status` → `auto.mjs status`, print as is. `report` → `auto.mjs report` (works mid-run), print as is, offer `review`.
- `pause` / `continue` / `stop` (safe stop at the next checkpoint) / `abort` (stops now, keeps the branch) → `auto.mjs <cmd>`; one Polish line on the result.
- `takeover` → `auto.mjs takeover` (pauses at the nearest safe checkpoint, ends workers cleanly, writes `handoff.md`), then continue in normal orchestrate mode on the worktree it names, following `handoff.md`.
- `review` → morning review (below). Merging only on the user's explicit yes.

## start (default): the only time you ask anything
1. `auto.mjs prepare` → repo state, profile defaults, privacy, keep-awake, thresholds. A `blocked_by_run` or a dirty tree → say so and stop. Unsupported keep-awake → state the caveat (machine sleep pauses the run).
2. Contract interview with a stricter bar than prompt-creator (dispatch it with the brief `autonomous: true`, see `agents/prompt-creator.md`): AskUserQuestion, ≤ 4 questions per call, ≤ 3 rounds, Polish, recommendation first; nothing the repo profile already settles. Fix: goal, definition of done, verify commands (from `defaults.verify`), allowed actions, protected paths, dependency policy (`none|patch_minor|any`), network (`none|read`), sensitivity, EGM pre-consent, optional deadline, limit thresholds and reserve, notification channel (`os|file|command`), commit-policy confirmation when `needs_commit_override`. Anything irreversible or with an external effect stays forbidden unless the user lists it. Never offer push.
3. Answers file (scratch, outside the repo): contract fields as in `autonomous.md`; `auto.mjs draft --answers <f> [--prompt-file <p>]`. Errors → fix and redraft.
4. Show: the allowlist (`permissions.summary` and the denies that matter), the feasibility estimate (always "szacunek"), warnings. Then `auto.mjs preflight --run <id>` (one live Claude call + `doctor --live`); any failed check → stop.
5. Ask for the explicit **GO** (one question, nothing else bundled). Only on yes: `auto.mjs start --run <id> --go --hash <permissions.hash>`. Confirm in one Polish line: branch, worktree, where `status`/`report` are, how to stop. Then say nothing more.

## review (morning)
`auto.mjs report` first; then `auto.mjs review list` and walk the items with AskUserQuestion (keep / revert, ≤ 4 per call, decisions and checkpoints with their risk first). `auto.mjs review revert --run <id> --id <task or decision id>` per revert (only the `auto/*` branch changes), `review done` at the end. Merging is a separate question: show the merge command from the report; run `auto.mjs merge --run <id> --into <branch> --yes` only after an explicit yes. `cleanup --yes` only when the user asks.
