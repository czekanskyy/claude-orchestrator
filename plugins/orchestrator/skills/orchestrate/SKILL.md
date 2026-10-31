---
name: orchestrate
description: Multi-model orchestration across Claude subagents, GPT (Codex CLI), Grok (Grok Build CLI) and Gemini (Antigravity CLI) under tight subscription limits and a per-family privacy policy. Triages a task, plans subtasks, routes each to a model AND an effort level from the registry, keeps sensitive work away from families that may train on it, runs mandatory cross-family reviews, verifies, and reports pool usage in Polish. Use when the user invokes /orchestrator:orchestrate, or explicitly asks to orchestrate, split work across Claude/GPT/Grok/Gemini, or get a multi-model plan. In a repo that ships its own orchestrator, also use it for a plain "orchestrate" request: its preflight applies the user's per-repo choice between the two. Do not use for ordinary single-model coding requests.
argument-hint: "[--dry-run] [--use global|project] <task description>"
---

# Orchestrator

Scripts: `node "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs"`, run from the repo root. Plugin files below are `${CLAUDE_PLUGIN_ROOT}/…` (`P/`).
Sources of truth: `P/models.yaml` (vendor facts: families, plans, models), the user's `~/.claude/orchestrator/config.yaml` (which families/plans they have, privacy overrides), and `<repo>/.claude/orchestrator.yaml` when present (per-repo overlay). Never hardcode model names, plans or effort levels: take them from `registry.mjs` output.
You plan, route, verify and integrate. You do not type bulk code. Reports to the user: **Polish**, concise. Everything else: English.

## 0. Preflight (once per session, one call)
`registry.mjs preflight --md` → repo, active Claude subscription (detected from the login), enabled families, orchestrator choice, registry staleness, pool table (Claude and Codex exact, others `~` estimates), warnings. Relay warnings in one line each: config missing → tell the user to run `/orchestrator:configure` once (meanwhile only the main family is used and nothing sensitive leaves it); stale → `/orchestrator:update`; subscription mismatch or a nearly empty main pool → suggest switching accounts, never switch for the user.

**Which orchestrator** (only when the repo ships its own, e.g. `/orchestrate`). The choice is a per-user setting outside the repo, so teammates without this plugin keep using the project one:
- `--use global|project` in the arguments wins for this run.
- Otherwise `orchestrator.choice` from preflight: `project` → say so in one line, invoke the project skill (Skill tool) with the task and stop. `global` → continue. `ask` → AskUserQuestion (global = this multi-model orchestrator with pool tracking / project = the team's procedure), then save it with `registry.mjs project-pref --orchestrator <choice>` if the user wants it remembered.
- Running global in such a repo: the repo's own rules still win (branching, commit format, checks, critical paths, definition of done). Read its orchestration doc only for those, not for routing.

Project context: skim the repo's `CLAUDE.md` / `AGENTS.md` headers. Briefs point workers to repo docs by path instead of pasting them.

## 1. Triage
Small (≤2 files, ≤~50 lines, one step) and low risk, or a question → **do it yourself**. Small but risk ≥ med → yourself + ONE cross-review by another primary family. Otherwise (≥3 subtasks, parallel streams, complexity L, risk high, or the user asked) → full orchestration: read `P/routing.md` now. Tell the user in one line: size, risk, path.

## 2. Plan and ledger
1. S/M plans below high risk: write them inline. L or high risk: dispatch the planner (routed like any subtask).
2. **Sensitivity** per subtask: `none` (public/generic), `internal` (default: ordinary private code), `sensitive` (credentials, customer/personal data, production configs, secrets handling, anything the user called confidential). Ask once if unclear and the repo looks like it holds customer data. Briefs and file lists matching the sensitive globs are escalated to `sensitive` by the router automatically. A `sensitive` task may only go to a family whose `data_policy.sensitive_ok` is true; when none can take it the router fails closed and you do it yourself or ask the user.
3. Subtasks as JSON: `id, title, type, complexity, risk, sensitivity, deps, files, produces_code` + optional `context_heavy`, `interactive`, `dictated` (routing.md §2). Save to `~/.claude/orchestrator/runs/plan-<timestamp>.json` and run `registry.mjs route --tasks <file> --md`. It assigns model + effort (role-bounded tier, effort matrix, pool balancing, context economy, privacy filter), appends cross-reviews and exemptions, and gives each assignment its `dispatch` (subagent type or adapter script).
4. Show the **ledger** (`P/templates/plan.md`): one row per package with owner (model · effort), sensitivity, cross-checker and status; `privacy_notes` and any `cross_review_gap` in one line each. Keep it current. Heavy tier → one-sentence justification. `needs_approval`, or a pool ≥ `low_effort_confirm` → **ask before dispatch**.
5. `--dry-run` → stop after the ledger + pool table.

## 3. Dispatch
Briefs from `P/templates/brief.md`: self-contained, ≤ ~40 lines, scoped to files, reports ≤ 15 lines. No secrets, no conversation history. Follow the assignment's `dispatch`:
- `via: agent` → Agent tool with `subagent_type` exactly as given (`orchestrator:orch-implementer|debugger|mechanic|reviewer|security-reviewer|planner|researcher|runner`), and ALWAYS `model` and `effort` from the dispatch (per-subtask model+effort is a hard requirement). Then `usage.mjs log --model <m> --effort <e> --task-type <t> --result ok|fail`.
- `via: adapter` → `<script> --model <m> --effort <e> --mode implement|review|research --prompt-file <f> --cwd <repo> --task-type <t> --complexity <c> --risk <r> --sensitivity <s> [--file <path> …]` with `run-codex.mjs` / `run-grok.mjs` / `run-gemini.mjs` (Codex diff review: `--review-diff`). Pass every file the worker will see with `--file` so the adapter's privacy gate can check it. Grok/Gemini implement mode: `--allow-cmd "<check cmd>"` per allowed command.
- **Fix rounds** reuse the worker's session: Codex `--resume-of <run_id>`, Grok `--resume-session <session_id>`, Gemini `--resume-session <conversation_id>`, Claude agents via SendMessage to the same agent.
Adapters return ONE JSON object (`ok, error_kind, text, usage, fallback_hint, run_dir, session_id`) and log usage. Open `run_dir` only when needed.
Parallel: ≤ `max_parallel` per pool, independent packages on disjoint files only (Claude agents may use `isolation: worktree`); otherwise sequential. Workers never commit, push or switch branches.
Never use `codex:codex-rescue`, `grok-build:*` or `Skill(codex:rescue)` inside orchestration. Never pass `--approved` / `--allow-secrets` without the user's explicit yes.

## 4. Verify (never trust self-reports)
Send the check list (tests, type check, lint, build, `git status --short`, `git diff --stat`) to `orchestrator:orch-runner`, not into your own context. Changes outside a package's scope: check the ledger first, and never revert another package's files.
Failure → `registry.mjs escalate --model <m> --effort <e> --failures <n> --type <t> --complexity <c> --risk <r> --sensitivity <s>` and follow `action`: effort +1 → other primary family → heavy tier (justify) → stop and report.

## 5. Cross-check
Follow the `cross_review` / `extra_review` rows from the route. Exempt rows (dictated, low-risk mechanical) get checks plus a diff skim only. Reviewers get the brief, the criteria and the diff, never the author's reasoning. Read review summaries, not full diffs, unless a finding is disputed. Every finding is fixed or answered. **Max two fix-and-review rounds**, then decide or ask. Families disagree on a high-risk point → the user decides. A `cross_review_gap` (no other family may see the data) → verify by checks + diff skim and tell the user the critical check was single-family.

## 6. Errors and fallback
Adapter `ok:false` → use `fallback_hint` (routing.md §8, cooldown- and privacy-aware). `privacy_blocked` → never override; take the hinted family or stop. Claude agent limit message → `usage.mjs cooldown set <active claude pool> [--model <m>]`, then `registry.mjs fallback --model <m> --effort <e> --error rate_limit --sensitivity <s>`. A `suggest_account_switch` (main pool exhausted, another plan has headroom) → tell the user they can switch the session's account; meanwhile continue on the automatic ladder. `unknown_model`/`unknown_effort` → suggest `/orchestrator:update`. `auth` → ask the user to log in (the adapter's `suggest` names the command). Note every fallback in the ledger.

## 7. Finish and report (Polish)
Run the repo's definition-of-done if it has one, then commit per the repo's rules (only you commit). Report with `P/templates/report.md`: final ledger, check results, review findings and how they were resolved, fallbacks, privacy routing events, pool table (`usage.mjs status --md`), what is left open. Interim updates only on significant events.

Main session model/effort rationale: `P/references/main-session-model.md`. Details on demand: `P/routing.md`, `P/references/cli-contracts.md`, `P/references/safety.md`, `P/references/plugins.md`, `P/references/lineage.md`.
