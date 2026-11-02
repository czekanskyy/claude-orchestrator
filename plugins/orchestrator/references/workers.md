# External workers: detached jobs, waiting, slow workers

Why: a worker run in the foreground blocks the main session until it ends and prints nothing meanwhile (Codex `task --json` has no output before the end). A 50 min task then looks like a hang for 50 min, and a timeout kill throws the work away. So every adapter worker (`run-codex|grok|gemini.mjs`) starts detached.

## Start
`<script> --detach --task "<agent label> <id>" <usual flags>` returns at once with `run_id`, `run_dir`, `progress_file`. A validation error that appears in the first seconds (unknown model, privacy block, missing CLI, cooldown) is returned directly as the usual `ok:false` JSON, so check `status` before waiting. Never run an adapter in the foreground, and never in `run_in_background` while waiting blind.

## Wait (loop until nothing is pending)
`node "${CLAUDE_PLUGIN_ROOT}/scripts/job.mjs" wait --run-id <r1> [--run-id <r2> ...] --max-wait-s 240` as a foreground Bash call (the Bash limit is 10 min; 240 s keeps the user informed). It returns when any job finishes or after the time is up:
- `show`: one Polish line per job (what runs, how long, its last action). Copy it verbatim into your own text message when a job is still pending (progress block, b3), then wait again.
- `jobs[]`: `state` (`running|done|failed|stalled|dead`), `elapsed_s`, `idle_s`, `over_budget`, `progress[]`, `result` (the usual adapter JSON) once finished. A finished job goes to verification (SKILL §4).
- Claude agents of the same wave are dispatched in the same message as the adapter starts. Their Agent calls block the turn, the detached jobs keep running meanwhile.

## Slow or stuck worker
`over_budget` (default 25 min implement, 10 min otherwise; `--budget <s>`), `state: stalled` (no output for 10 min) or `dead` (process gone without a result):
1. Look at `git diff --stat` and `progress[]`.
2. Files still changing, or the progress shows real work → keep waiting, at most until 2× budget (the hard kill, `--timeout <s>`).
3. Idle, looping, or no diff → `job.mjs cancel --run-id <r>` (also cancels Codex's own job), then resume the SAME worker with a narrower brief (`--resume-of` for Codex, `--resume-session` for Grok/Gemini: its context survives) or take the fallback (`run.mjs note --kind fallback`).
4. Work that cannot fit the budget is split, not given a bigger timeout.
Never restart a worker from zero while its diff shows progress.

## Where progress comes from
Codex: the plugin's own job registry (`codex-companion.mjs status --json`, the data behind `/codex:status`), polled every 5 s: phase, commands run, files edited. The job is matched to its run by the first 72 characters of the brief (the plugin titles a job that way), with a claim file in `runs/.codex-claims/` for briefs that open identically. Grok and Gemini: the CLI's stderr (their stdout is one JSON at the end) plus elapsed and idle time.
