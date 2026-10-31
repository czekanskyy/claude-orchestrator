---
name: orchestrate
description: Multi-model orchestration across Claude subagents, GPT (Codex CLI), Grok (Grok Build CLI) and Gemini (Antigravity CLI) under tight subscription limits and a per-family privacy policy. Triages a request (simple / complex / huge), turns complex ones into a vetted prompt via the prompt-creator agent, splits huge ones, plans and routes each subtask to a model AND an effort level from the registry, keeps sensitive work away from families that may train on it, runs low-trust cross-family reviews, verifies, and reports in Polish. Use when the user invokes /orchestrator:orchestrate, or explicitly asks to orchestrate, split work across Claude/GPT/Grok/Gemini, or get a multi-model plan. In a repo that ships its own orchestrator, also use it for a plain "orchestrate" request: its preflight applies the user's per-repo choice between the two. Do not use for ordinary single-model coding requests.
argument-hint: "[--dry-run] [--use global|project] <task description>"
---

# Orchestrator

Scripts: `node "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs"`, run from the repo root. Plugin files `${CLAUDE_PLUGIN_ROOT}/…` are `P/…`; `D` is the run directory.
Sources of truth: `P/models.yaml`, the user's `~/.claude/orchestrator/config.yaml`, and `<repo>/.claude/orchestrator.yaml` when present. Never hardcode model names, plans or efforts: take them from `registry.mjs` output.
You plan, route, verify, integrate and commit; you do not type bulk code. Anything user-facing is **Polish**; everything else English.

## Silence policy (strict)
The user hears from you ONLY in: (a) the assignment table, (b) status tables, (c) questions that need them, (d) errors and blockers, (e) the final report. No "calling agent X", no restated plans or triage, no recap of tool output, no explaining what you skipped. Tool output is invisible to the user: copy tables from `run.mjs` verbatim. Workers answer in ≤ 15 lines.

## 0. Preflight (once per session)
`registry.mjs preflight --md`. Warnings count as (d), one line each: config missing → `/orchestrator:configure`; stale → `/orchestrator:update`; subscription mismatch or a nearly empty main pool → suggest switching accounts, never switch for them.
**Which orchestrator** (only when the repo ships its own): `--use global|project` wins; else `orchestrator.choice`: `project` → invoke the project skill and stop; `global` → continue; `ask` → AskUserQuestion (save with `registry.mjs project-pref --orchestrator <choice>` if wanted). Running global there, the repo's own rules (branching, commits, checks, critical paths, definition of done) still win.

## 1. Triage and path
`triage.mjs --text "<request>" --run <slug>` → `class`, `confidence`, `sensitivity`, `critical`, `risk_hint`, and `run.dir` = `D` (the run directory and ledger). Accept the class unless confidence is `low` or you know better (rubric: `P/routing.md` §1). Every path, also one you do yourself, ends with the report (§7).
- **simple** → plan inline (§2).
- **complex** → route a `spec` task (`family: claude`) and dispatch `orchestrator:prompt-creator` (`P/routing.md` §10). It returns `questions[]` → ask them in ONE AskUserQuestion → resume the SAME agent with SendMessage (≤ 3 rounds). On `ready`: `run.mjs lint-prompt D/prompt.md`; then continue as simple with `D/prompt.md` as the source of every brief.
- **huge** → split into `D/part-N.md` (`P/routing.md` §11, `P/templates/split.md`), lint each with `--part`. Each part runs like a simple request in its own subagent(s) with fresh context; handoff through the repo and `D/handoff/`. You keep only the ledger.
- `egm_gate`: `egm-gate.mjs --class <c> --critical <bool>` before planning. `action: continue` → go on (placeholder; the EGM mode plugs in here).
- `--dry-run`: `dryrun.mjs --text "<request>"` (add `--tasks` for a sample plan), show its output, stop. No model calls.

## 2. Plan and route (only when needed)
One package, ≤ 2 files, ≤ ~50 lines, risk low → do it yourself (+ ONE cross-review by the other primary family if risk ≥ med). Otherwise write `D/plan.json` (`P/templates/plan.md`; carry triage `sensitivity`), then `registry.mjs route --tasks D/plan.json > D/route.json` and `run.mjs plan --run D --route D/route.json`. The router assigns model + effort (role-bounded tier, effort matrix, live pool balance, privacy filter), cross-reviews and exemptions. L or high-risk plans go to a planner. Record each choice made for the user with `run.mjs note --run D --kind decision "<text>"` (heavy tier, assumptions from the spec, skipped checks). `needs_approval`, a pool ≥ `low_effort_confirm`, or a `cross_review_gap` → ask (c) before dispatch.

## 3. Dispatch
Per wave: `run.mjs assign --run D --json` → show `.table` verbatim (a), then dispatch everything in `.dispatch` (≤ `max_parallel` per pool, disjoint files only). Briefs: `P/templates/brief.md` (reviews: `P/templates/review.md`), self-contained, ≤ ~40 lines, no secrets, no history.
- `via: agent` → Agent tool with `subagent_type`, `model`, `effort` exactly as given and `description` = the item's `description` (the persona shows in the UI). Then `usage.mjs log --model <m> --effort <e> --task-type <t> --result ok|fail [--tokens N]`.
- `via: adapter` → `<script> --model <m> --effort <e> --mode implement|review|research --prompt-file <f> --cwd <repo> --task-type <t> --complexity <c> --risk <r> --sensitivity <s> [--file <path> …]` (`run-codex|grok|gemini.mjs`; Codex diff review `--review-diff`; every file the worker sees via `--file` for the privacy gate; Grok/Gemini implement: `--allow-cmd` per command). Returns ONE JSON (`ok, error_kind, text, usage, fallback_hint, run_dir, session_id`).
- Fix rounds resume the worker: Codex `--resume-of`, Grok/Gemini `--resume-session`, Claude agents SendMessage.
- Workers never commit, push or switch branches. Never use `codex:codex-rescue`, `grok-build:*` or `Skill(codex:rescue)` here. Never pass `--approved` / `--allow-secrets` without an explicit yes.

## 4. Verify and report progress
Never trust self-reports: send the check list (tests, type check, lint, build, `git status --short`, `git diff --stat`) to `orchestrator:orch-runner`. Failure → `registry.mjs escalate …` and follow `action` (effort +1 → other primary family → heavy tier, justified → stop and report). After each finished task or wave: `run.mjs set --run D <id> --status done|failed|attention --note "<one line>"`, then `run.mjs status --run D [--summary "<line>"]` and show it (b). A summary (≤ 3 lines) only when it adds information.

## 5. Cross-check
Per `P/routing.md` §6 and `P/references/review.md`: reviewers get only brief + criteria + diff (low context) and a suspicious preamble (low trust); capped, `file:line` + failure scenario + confidence. Check disputed findings with a cheap runnable check before another model round. Max two fix rounds. Log each review: `run.mjs review --run D --by <family> --of <family> --high n --med n --low n --fixed n --rejected n`.

## 6. Errors and fallback
Adapter `ok:false` → `fallback_hint` (cooldown- and privacy-aware); log it with `run.mjs note --kind fallback`. `privacy_blocked` is never overridden. Claude agent limit → `usage.mjs cooldown set <pool> [--model <m>]`, then `registry.mjs fallback …`. `suggest_account_switch` → (d), continue on the ladder. `unknown_model|unknown_effort` → suggest `/orchestrator:update`; `auth` → ask them to log in. Blockers are (d).

## 7. Finish (every path, also when you did it yourself)
Run the repo's definition of done. Commit at logical checkpoints (one per part for huge), following the target repo's own commit rules; only you commit. Write `D/report.json` (`title, result: done|partial|stopped, summary, done[], tests[], not_done[]`; decisions, fallbacks, reviews, pools and commits are filled from the ledger and git), run `run.mjs report --run D --data D/report.json --strict`, and send its output unchanged as (e). Over the 35-line cap → shorten the longest lists and rerun.

Details on demand: `P/routing.md`, `P/references/review.md`, `cli-contracts.md`, `safety.md`, `plugins.md`, `lineage.md`, `main-session-model.md`.
