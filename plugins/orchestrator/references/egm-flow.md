# EGM mode: runbook for the orchestrating session

Entered only when `egm_gate` returned `action: egm` (consent: the user's yes, `--egm`, or an autonomous contract's pre-consent). Background and sources: [egm.md](egm.md). `P` = plugin root, `D` = run directory, `E` = `node "P/scripts/egm.mjs"`. The silence policy of SKILL.md applies unchanged: tables come from `run.mjs assign`/`status`, everything else is a question, a blocker or the final report. **Keep your own context lean**: never read a Goldfish report, never paste one; agents get a one-line pointer to a brief file, the Elephant reads the reports itself, you only see counts.

## 0. The gate
`egm-gate.mjs --class <c> --text-file <prompt.md | request.md> [--critical <bool from triage>] [--egm] --run D`, run once after the prompt is ready and before planning (huge: after the split).
- `continue`: normal flow. If `note` says the EGM plugin is missing or incomplete, show it as one (d) line with the install hint, once.
- `ask`: AskUserQuestion with `.question` exactly as given (run EGM / normal flow / cancel). Never start EGM without the yes. Then rerun the same command with `--answer run|normal|cancel` (this records the decision in the ledger).
- `unavailable`: the user asked for `--egm` but the plugin is missing: show `.question`; normal flow or stop.
- `egm`: continue here. `stop`: write the report (`stopped`).
- Settings: `egm: ask|off` in `config.yaml` and in the repo profile (off wins); `--egm` (the user's own request) overrides `off`. Autonomous runs never ask: only `egm.allow` in the contract counts (`references/autonomous.md`).

## 1. Plan the pass
Spec file: `D/prompt.md` (complex); otherwise write the user's request verbatim to `D/request.md` (huge: the whole request, the parts stay in `D/part-N.md` for the implementation phase). Then `E plan --run D [--sensitivity <triage>]`: estimates again, adds the design and review rows (personas 🐘 Elephant, 🐟 Goldfish, 🧩 synthesizer) to the ledger in waves, creates `D/egm/` (briefs, reports, `state.json`). Record the choices that were made for the user (`run.mjs note --kind decision`): review preset, Goldfish family, any pool warning.

## 2. Design (Elephant)
`E brief --run D --phase design`, then `run.mjs assign --run D --json`: your reply is its `.show` verbatim before the dispatch call. Dispatch the row exactly as given (`subagent_type orchestrator:egm-elephant`, `model`, `effort`, `description`, `prompt`). Keep the agent id: all later Elephant work resumes it with SendMessage.
- Reply `status: questions`: these are architecture decisions that have more than one defensible answer. EGM rule 13 stays: ask the user ONE AskUserQuestion (≤ 4 questions, ≤ 3 options each, each option states mechanism, trade-offs and when it fails); **no recommendation, no default, never choose for them**; if they say "you pick", restate the trade-offs and ask again. Resume the Elephant with the answers verbatim (SendMessage, same agent). At most 3 rounds, then stop and report (a design cannot continue without the owner's decisions).
- Reply `status: drafted`: `E record --run D --phase review --files-listed <n>`; `run.mjs set EG-design --status done`.

## 3. Goldfish review, stage by stage (preset from `E plan`)
For each stage N in order (never parallel across stages): `E brief --run D --phase review --stage N`, `run.mjs assign --run D --json`, dispatch only the items that carry `subagent_type` or `script` (nested reviewers have none: their synthesizer spawns them; mark them done when it reports).
- Stages 5, 7, 8, 9: dispatch the synthesizer. Its reply JSON gives `report`, per-reviewer `completed|not run`, and counts.
- Stage 6 (comprehension): dispatch the reviewer directly (the paraphrase must reach the author); pipe its reply to `E save --run D --name comprehension_report.md`; read the `Findings:` line.
- Stage 7 with `egm.goldfish: cross` and a cross-family row: also run the adapter row (`<script> --model --effort --mode review --prompt-file <dispatch.prompt_file> --cwd <repo> --task-type review --complexity M --risk med --sensitivity <triage> --file D/egm/design.md`), save its text with `E save --name critic_xfamily_report.md`. The privacy filter already decided the family; `privacy_blocked` is never overridden, fall back to Claude Goldfish only.
- A reviewer that is `not run` is recorded (`--not-run name`) and the stage is **not** clean; say so in the report.
- Then `E record --run D --stage N --blocker a --major b --nit c [--not-run x]`. If blockers + majors > 0 (or a cross-family report exists): `E brief --run D --phase resolve --stage N` and SendMessage the Elephant the printed `message`. Its reply gives `applied`, `contested`, `escalated[]`, `blockers_open`; record them (`--applied --contested --escalated`). Resolve before the next stage starts. No re-audit rounds by default (the official uninterrupted flow runs each stage once); `blockers_open > 0` after a resolve is shown at the approval gate.

## 4. Escalations and the design approval (the human review EGM requires)
1. Escalated findings (facts only the owner knows): one AskUserQuestion, answers go to the Elephant via `E brief --run D --phase resolve --final --answers-file <f>` and SendMessage.
2. One approval question with a ≤ 5-line summary (sections, files in the plan, findings fixed/contested/open, path of `D/egm/design.md`): approve and implement / revise (the user writes what) / stop. Revision: the Elephant applies it (same brief mechanism), at most 2 times, no new review. `E record --run D --approved true|false --phase implement`.
3. Not approved → final report `stopped` with the design path; nothing was implemented.

## 5. Implementation (usual workers)
`D/egm/design.md` is now the source of every brief, as `prompt.md` is in the normal flow. Plan from its "Detailed Implementation Plan" (files, rationale, Verification Plan) per SKILL.md §2: disjoint packages, routed model and effort per task, cross-family reviews as always. Briefs add: "Implement exactly the approved design; if it is wrong or silent where you need it, stop and report instead of improvising: drift is checked." If the repo keeps designs in `docs/designs/` (the folder exists), copy the final design there as part of the change (commit per the repo's commit rule); otherwise it stays in `D/egm/` and the report says where.

## 6. Drift check (Goldfish)
After the implementation passed its checks: `E brief --run D --phase drift` (adds the row), `run.mjs assign`, dispatch `orchestrator:orch-reviewer` with the row's prompt; it follows `egm-drift-report` on a fresh context. Save its reply: `E save --run D --name drift_report.md`; `E record --run D --drift-items <n>`. Items → one fix round through the implementer, re-check, `--drift-fixed <k>`; leftovers go to `not_done` in the report. `E record --run D --phase done`.

## 7. Report
`E report-lines --run D` gives three compact Polish lines (design + approval, Goldfish stages/findings, drift). Put them into `report.json` as `"egm": [...]`; `run.mjs report` renders them in an `### EGM` section. Pools and commits are filled as usual.
