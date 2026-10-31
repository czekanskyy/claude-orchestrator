# Adapter and script contracts

All scripts: `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs" …` (the variable is substituted in skills/agents; scripts find the plugin from their own location). Node ≥ 18, no npm dependencies, Windows and POSIX.
State (outside the plugin): `~/.claude/orchestrator/` = `config.yaml` (user choices), `projects.yaml`, `usage.jsonl`, `pools/*.json`, `runs/<run-id>/`, `repos/<name>-<hash>.yaml` (per-repo profiles, `/orchestrator:init`), `backup-v2-<date>/`. Overrides: `ORCH_HOME`, `ORCH_CONFIG` (config file), `ORCH_REGISTRY` (tests), `ORCH_AGY_BIN` (Gemini CLI path).

## run-codex.mjs / run-grok.mjs / run-gemini.mjs
| flag | meaning |
|---|---|
| `--model <id>` | registry id or CLI name (validated against models.yaml) |
| `--effort <lvl>` | must be in the model's `effort.levels`; `meta.approval_efforts` need `--approved` |
| `--mode review\|research\|implement` | review/research = read-only; implement = writes limited to `--cwd` |
| `--prompt-file <f>` | the brief (scanned for secrets → `secret_detected`) |
| `--cwd <dir>` | repository root |
| `--timeout <s>` | default 600 (review/research), 1200 (implement); kills the process tree |
| `--sensitivity none\|internal\|sensitive`, `--file <path>` (repeatable) | privacy gate: refused with `privacy_blocked` when the family's `sensitive_ok` is false and the task (or a listed file matching the sensitive globs) is sensitive. Pass every file the worker will see |
| `--task-type/--complexity/--risk` | used for the `fallback_hint` calculation |
| `--dry-run` | prints the exact command, runs nothing, logs nothing |
| `--simulate ok\|rate_limit\|rate_limit_model\|timeout\|cli_error\|auth\|unknown_model` | test without calling the CLI (logs `simulated`) |
| `--allow-unverified` | allows `status: unverified` models (smoke tests) |
| `--max-text <n>` | cap on `text` in JSON (default 6000; full text in `run_dir/last.txt`) |
| codex: `--engine plugin\|exec`, `--review-diff [--scope auto\|working-tree\|branch] [--base REF]` | plugin = codex-companion (default); exec = `codex exec`; review-diff = `adversarial-review` |
| grok: `--allow-cmd "<cmd>"` (repeatable), `--max-turns N` | allowed shell commands in implement mode |
| codex: `--resume-of <run_id>` | fix round on the worker's own thread (`--resume-last`), only if that run is the latest Codex task in this cwd; otherwise fresh + warning |
| grok: `--resume-session <session_id>` | fix round on an exact Grok session (`-r <id>`) |
| gemini: `--resume-session <conversation_id>`, `--allow-cmd "<cmd>"` (repeatable) | `agy --conversation <id>`; allowed shell commands go to a session-only `--settings` file in implement mode (`agy -p … --output-format json --mode plan\|accept-edits`) |

### Result (stdout, a single JSON object; exit 0 = ok, 1 = error)
```json
{ "ok": true, "invoke": "codex", "run_id": "...", "mode": "implement", "model": "gpt-6.1-sol", "effort": "medium",
  "family": "gpt", "pool": "chatgpt_business", "engine": "plugin@1.0.6", "exit_code": 0, "duration_ms": 81234,
  "timed_out": false, "error_kind": null, "error": null, "limit": null, "text": "...",
  "usage": { "input": 0, "output": 0, "total": 0, "units": 1.6, "estimated": true },
  "session_id": "...", "touched_files": [], "run_dir": "...",
  "fallback_hint": { "step": "other_primary_family", "model": "...", "effort": "..." } }
```
`error_kind`: `rate_limit` (sets a pool or model cooldown), `timeout`, `auth`, `unknown_model`, `unknown_effort`, `cli_error`, `pool_cooldown`, `secret_detected`, `approval_required`, `unverified_model`, `bad_args`, `cli_missing`, `family_disabled` (not in config.yaml), `privacy_blocked`.

## registry.mjs
`validate`, `stale-check`, `list`, `get <m>`, `matrix`,
`candidates --type --complexity --risk [--role] [--exclude-family] [--only-family] [--allow-unverified]`,
`route --tasks tasks.json [--md]` (tasks: `[{id,title,type,complexity,risk,deps,files,produces_code,context_heavy,interactive,dictated}]`),
`candidates … [--context-heavy] [--interactive]`. Per-repo overlay: `<repo>/.claude/orchestrator.yaml` (disable: `ORCH_NO_OVERLAY=1`, search start: `ORCH_PROJECT`).
`fallback --model --effort --error <kind> [--scope model|pool]`, `escalate --model --effort --failures N`,
`observe [--out f]` (codex, grok, gemini catalogs), `diff --observed f [--md]`. Tasks take `sensitivity`; `candidates`/`fallback`/`escalate` take `--sensitivity`.
Simulating pool states: `ORCH_POOLS_OVERRIDE='{"chatgpt_business":{"pct":90},"claude_team":{"cooldown":true}}'`.

`preflight [--md]`: repo, enabled families, config present?, privacy summary, active Claude pool (`ORCH_CLAUDE_POOL` > login in `~/.claude.json` `oauthAccount.organizationType` matched by `pools.*.account_match` > per-repo `claude_pool` preference > `families.claude.pool`), orchestrator choice, staleness, pools, warnings.
`project-pref [--orchestrator global|project|ask] [--claude-pool <pool>] [--repo DIR]`: user-local per-repo preferences in `~/.claude/orchestrator/projects.yaml` (never in the repo). Test hooks: `ORCH_CLAUDE_ACCOUNT_FILE`, `ORCH_PROJECT`.

## config / doctor / update / migrate
- `configure.mjs detect | show [--md] | validate | apply --answers FILE|-`: backend of `/orchestrator:configure`; writes `config.yaml` (schema-validated, atomic, `.bak`, no secrets, unknown keys rejected).
- `doctor.mjs [--live] [--json] [--claude-live ok|fail:<why>] [--claude-tokens N]`: offline checks, exit 1 on any ❌. `--live`: one trivial call per enabled non-Claude family.
- `update.mjs scan [--out f] | stamp --approved [--plans a,b] [--note T] [--date D]`: facts for `/orchestrator:update`; `stamp` only edits `meta.verified_at`, plan `checked` dates and CHANGELOG.
- `migrate.mjs plan | backup | validate-state | cleanup --approved`: v2 → v3 (backup first; cleanup removes v2 skills and identical `orch-*` agents, leaves a statusline forwarding shim).
- `usage.mjs sync-limits`: refresh the Codex pool snapshot from `codex app-server` (`account/rateLimits/read`) and the Gemini one from `agy -p /usage` (5h and weekly); zero model tokens each. Output `{gpt, gemini}`, exit 1 only when an enabled family fails.

## repo-scan.mjs / init.mjs (`/orchestrator:init`, details: `repo-init.md`)
`repo-scan.mjs [--repo DIR] [--full] [--pretty]`: read-only scan, ONE compact JSON (repo state, commit/branch conventions, stack commands with source, policy docs with key sentences, hooks/CI/CODEOWNERS, other orchestrators, sensitivity by name only, critical paths, conflicts, fingerprint). Never opens a secret file.
`init.mjs plan [--refresh] | dry-run | apply --answers F|- [--share] [--dry-run] | show | status | rules` (all take `--repo DIR`): `plan` → `state: empty|exists|ready`, highlights, scan, Polish questions in rounds, skipped decisions, share question; `apply` settles answers (`repo|default|merge|custom`, `_repo` refinements) into the profile, writes it user-local and, with `--share`, the `repo_profile` block of `<repo>/.claude/orchestrator.yaml`; never commits. `registry.mjs preflight` adds `repo_profile` (state, rules) and the `Repo rules:` block.
Env: `ORCH_HOME` also relocates `repos/`; `ORCH_NO_OVERLAY=1` also ignores the shared `repo_profile` block.

## usage.mjs
`status [--md]`, `balance [--hours]`, `log --model --effort --task-type --result [--tokens]`,
`set-pool <pool> <pct> [--window]`, `cooldown set|clear <pool> [--minutes] [--model]`.

## statusline.mjs
Wired into `~/.claude/settings.json` → `statusLine`. Saves `rate_limits` to `pools/<active claude pool>.snapshot.json` (Team or personal Pro, per the detected login) and shows `model · ctx · 5h · 7d · GPT~ · Grok~`.

## auto.mjs / auto-supervisor.mjs (`/orchestrator:auto`, details: `autonomous.md`)
All commands print one JSON object (`ok`, …) except `status` / `report` (Polish text). Run state: `~/.claude/orchestrator/auto/<run-id>/`.
`auto.mjs prepare [--repo DIR]` (repo state, profile defaults, privacy, keep-awake) · `draft --answers F [--prompt-file P]` (contract.yaml + permissions.json + feasibility; refused while another run owns the repo) · `preflight --run ID [--skip-doctor]` (clean tree, worktree, one live headless probe, `doctor --live`) · `start --run ID --go --hash H` (worktree + branch `auto/<id>`, detached supervisor; nothing starts without `--go`) · `status | report [--run ID]` · `pause | continue | stop | abort | takeover [--run ID]` (control files; work offline when the supervisor is dead) · `review list | revert --id <task|decision> | done` · `merge --run ID --into BRANCH --yes` · `cleanup --run ID --yes` · `list`.
`auto-supervisor.mjs --run DIR` is the detached guardian (restarts `--engine` children, watchdog, keep-awake); never started by hand. `auto-smoke.mjs [--keep] [--timeout-min N]` = real end-to-end smoke in a throwaway repo (spends a few headless Claude calls). Env: `ORCH_AUTO_WAIT_SCALE`, `ORCH_AUTO_INJECT` (tests only), `ORCH_CLAUDE_BIN`.
