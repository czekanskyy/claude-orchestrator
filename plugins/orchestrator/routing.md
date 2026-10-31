# Routing rules

Load this file only when planning a multi-step task. The tables between `<!-- matrix:* -->` markers are
parsed by `scripts/registry.mjs`. Keep their shape (first column = row key, header = column keys).
Model names never appear here. Models come from `models.yaml` (tier, suitability, effort levels).

Three ideas carry the design:
1. **Tier by role, not by habit.** Heavy models plan and judge, standard models build, light models run checks and transcribe.
2. **Two families check each other.** Different training, different blind spots.
3. **Spare the scarcer budget and the orchestrator's context.** Work goes to the pool with headroom, and context-heavy work goes outside the main session's pool.

## 1. Triage (first step, zero tokens)
`triage.mjs --text "<request>"` proposes `class`, `confidence`, `sensitivity`, `critical`, `risk_hint` from deterministic signals. You keep the judgment: accept it unless `confidence` is `low` (mixed signals) or you know better. Do not read the repo to triage.

| class | when | examples |
|---|---|---|
| simple | small UI fix, tweak, rename, one clearly specified function; nothing to clarify | "Zmień kolor przycisku Zapisz na niebieski" · "Fix the typo in README.md" · "Add a --verbose flag to scripts/build.mjs that prints timings" |
| complex | touches shared modules, persistence, auth, schema or an integration; needs detail or clarification; root cause unknown | "Dodaj logowanie przez Google: schemat, middleware, UI" · "Flaky checkout test: find the root cause and fix it" · "CSV export on the reports page with filters and permissions" |
| huge | must be split: several independent subsystems, a whole-repo sweep, phases, or more than one context can hold | "Przepisz całą aplikację na TypeScript" · "Migrate all 40 routes to the new validation layer, update docs, add e2e tests" · a roadmap of 8+ items |

- `sensitivity` none | internal | sensitive (§5a) is passed to every subtask. `critical` (auth/roles, payments, migrations/schema, data deletion, secrets, production deploy, public API contracts, concurrency) marks an EGM candidate and changes no path.
- Paths: simple → plan inline. complex → `prompt-creator` (§10), then plan from `prompt.md`. huge → split (§11), then plan per part. All paths pass `egm_gate` (placeholder, `scripts/egm-gate.mjs`) before planning.
- Planning outcome for a simple request: ONE package, ≤ 2 files, ≤ ~50 lines, risk low → do it yourself, no delegation (every delegated call costs a full context load). Small but risk ≥ med → yourself + ONE cross-review by the other primary family. More than that → route and dispatch.
- Planning itself: S/M plans below high risk are written **inline by the main session**; L or high-risk plans go to a planner and get a cross-family critique. In doubt on a small task, do not orchestrate.

## 2. Classify every subtask
- `sensitivity`: none | internal | sensitive (§5a). Default `internal`.
- `type`: implement | refactor | debug | test | review | plan | research | mechanical | spec (the prompt-creator, §10)
- `complexity`: S (one file/function, obvious approach) | M (several files in one module) | L (crosses modules, new feature, schema change, unclear root cause)
- `risk`: low | med | high. High = security/auth/roles, payments, data migrations or deletion, schema, public API contracts, concurrency, secrets/env, CI/deploy, scripts that write data. Med = shared modules, persistence, behavior visible to users.
- Optional flags: `context_heavy` (must read a lot of the repo), `interactive` (needs several rounds with the main session or builds on context only the main session has), `dictated` (text whose content is already decided: tracker rows, log lines, given strings).

## 3. Model tier = f(complexity, risk), then bounded by role
<!-- matrix:tier -->
| complexity | low | med | high |
|---|---|---|---|
| S | light | standard | heavy |
| M | standard | standard | heavy |
| L | standard | heavy | heavy |
<!-- /matrix:tier -->

Role bounds (applied after the matrix). Heavy models never write bulk code: a risky implementation gets
a standard author at higher effort and a heavy reviewer.
<!-- matrix:tier_bounds -->
| type | min | max |
|---|---|---|
| mechanical | light | standard |
| test | light | standard |
| research | light | standard |
| implement | light | standard |
| refactor | light | standard |
| debug | standard | standard |
| review | standard | heavy |
| plan | standard | heavy |
| spec | light | standard |
<!-- /matrix:tier_bounds -->

Heavy tier always needs a one-sentence justification in the plan. If its pool is ≥ the
`low_effort_confirm` threshold, ask the user first. Escalation (§7) may lift a worker to heavy, with a justification.

## 4. Effort = f(type, complexity), chosen independently of the model
<!-- matrix:effort -->
| type | S | M | L |
|---|---|---|---|
| mechanical | low | low | medium |
| test | low | medium | medium |
| research | low | medium | high |
| implement | low | medium | high |
| refactor | low | medium | high |
| review | low | medium | high |
| debug | medium | high | high |
| plan | medium | high | high |
| spec | medium | medium | high |
<!-- /matrix:effort -->

- risk high → +1 level, capped at `meta.auto_effort_ceiling`.
- The level is clamped to the model's `effort.levels` (nearest supported level, rounding up).
- **Raise effort before switching model**: tuning effort is usually the cheaper lever.
- Above the auto ceiling only through escalation (§7). `meta.approval_efforts` never run without user approval.

## 5. Family choice, load balancing and context economy
- Primary families (`families.*.role: primary`) share the work roughly evenly by **normalized pool consumption**. Among candidates with the required tier and suitability ≥ 3, prefer the family whose pool % is lower when the gap is > 10 pp (hysteresis). Otherwise prefer higher suitability, then lower cost.
- `context_heavy` subtasks lean to a family outside `meta.main_family`: the external CLI's context and tokens are not the main session's.
- `interactive` subtasks lean to `meta.main_family`: back-and-forth with an external CLI costs more than it saves.
- Secondary families (`role: secondary`, today Grok and Gemini) are chosen only when: (a) every primary pool is ≥ `low_effort_confirm` or in cooldown (coding fallback), (b) the subtask is light tier and that family has headroom, or (c) as an extra review round (§6).
- Pool thresholds: ≥ `prefer_others` → score penalty. ≥ `low_effort_confirm` → only low effort + user approval. ≥ `cooldown` or a limit message → excluded until reset.
- Parallelism: at most `pools.*.max_parallel` concurrent agents per pool. Writers touching the same files never run concurrently (separate git worktrees, otherwise sequential). Schema/migrations have exactly one writer.

## 5a. Privacy (before everything else in §5)
Each family has a `data_policy` (does the plan train on your data, may it see `sensitive` material), from the `models.yaml` catalog and overridable in `~/.claude/orchestrator/config.yaml`. An unknown or unverified policy counts as `sensitive_ok: false`.
- `sensitivity: sensitive` (credentials, customer/personal data, production configs, anything the user called confidential): **hard filter**. Only families with `sensitive_ok` are candidates, for authors AND reviewers, in fallback and escalation too. Nothing left → fail closed: the main session does it or asks the user. No pool state or fallback ever overrides this.
- `internal` (ordinary private code): allowed everywhere, but a family that may train on it gets a score penalty.
- `none`: no restriction.
- The router escalates a task to `sensitive` itself when its `files` or brief paths match `meta.sensitive_globs` (plus the user's `privacy.sensitive_globs`). Adapters check again (`privacy_blocked`), so a mis-routed call is refused, not sent.
- No other family may review a sensitive change → `cross_review_gap`: checks plus a diff skim, reported to the user as single-family.

## 6. Cross-model checks (low-trust, low-context)
Apply by risk, not by habit: more scrutiny where a miss is expensive, none where there is nothing to judge.
- Code by family X is reviewed by the **other primary family**. Risk high → security lens (`orch-security-reviewer`) plus an extra round by a secondary family when privacy allows. L or high-risk plans are critiqued by the other primary family before implementation; inline S/M plans are not.
- **Exempt** (checks + diff skim only): `dictated` edits, low-risk mechanical changes, trivial changes (S, low risk).
- **Low context**: a reviewer or verifier gets only the brief, the acceptance criteria and the diff/files (a plan review: only the plan and the criteria, like a naive reader). Never the author's reasoning, history or earlier findings.
- **Low trust**: the preamble (`templates/review.md`, built into the reviewer agents) says the work comes from a fallible model of another family, defects are assumed present and hunted. Each finding needs `file:line`, a failure scenario and a confidence; "no findings" is valid only with a `Checked:` list; at most 5 findings by severity; style nits are out unless the repo's rules demand them.
- **Disputed or doubtful findings** (low confidence, or the author's side contradicts them): settle with a cheap runnable check first (a test, a one-line script, `git grep`, a type check via `orch-runner`) before any extra model round. A finding the check refutes is dropped and counted as rejected.
- Scope is a finding: a change outside the files the brief allowed. Check the ledger first (it may be another package's), and never revert another package's files.
- Fixes go back to the author (session resumed). **At most two fix-and-review rounds**, then the main session decides or asks the user. After the first round only `high`/`med` severity findings with `high`/`med` confidence count; the second round is limited to re-checking the fixes. Families disagree on a high-risk point → the user decides, shown both arguments.
- Guard against over-caution and token blow-up: reviewer prompts stay short (brief template, no pasted history), outputs are capped (≤ 15 lines), reviewer effort follows the effort matrix (raise it for high risk, never by default), and the main session reads summaries, not full diffs, unless a finding is disputed.
- Details and the reviewer brief: `references/review.md`.

## 7. Verification failure → escalation (one step at a time)
1. Failure 1: same model, effort +1 level (up to `meta.escalation_effort_ceiling`).
2. Failure 2: the **other primary family** at the same tier (fresh eyes, different blind spots). Paste the failing evidence into the brief.
3. Failure 3: tier +1 (heavy) with a justification, family with the lower pool.
4. After that: stop, re-plan or report to the user with the failing evidence.
Never jump straight to the maximum effort or the heaviest model.

## 8. Errors → fallback ladder
| error | ladder |
|---|---|
| timeout | effort −1 → cheaper model same family → other primary family → secondary family |
| rate limit (model-scoped) | cheaper model same family → other primary family → secondary |
| rate limit (pool-scoped) / pool cooldown | other primary family → secondary |
| privacy_blocked | never override: the hinted family that is allowed to see the data, else stop |
| cli_error / auth | other primary family → secondary (and tell the user to run login) |
| unknown_model / unknown_effort | other family now + suggest `/orchestrator:update` |
Each step goes in the report (`Fallback:` line) and the ledger. `registry.mjs fallback` computes the next step.
A critical check that ends up single-family is reported as such.

## 9. Briefs and reports
Self-contained, ≤ ~40 lines (`templates/brief.md`): goal, scope (files it may edit), constraints, done criteria, report format.
No secrets, no `.env` contents, no conversation history. Workers never commit, push, switch branches or install dependencies: the main session commits after the cross-check.
Reports from workers are ≤ 15 lines (reviews: verdict + findings only). The main session never opens a large file a subagent could summarise, and test/build output goes through `orch-runner`.
Fix rounds reuse the worker's session (`--resume-of` / `--resume-session`) instead of re-sending context.

## 10. Spec path (complex): `prompt-creator`
Routed like any subtask as type `spec` (family claude, complexity M, risk low): the router picks the cheapest tier that clears the suitability floor. Light-tier models score `spec: 2`, below the floor of 3 (a spec needs repo reading and judgment), so today it resolves to a standard model at medium effort; `tier_bounds` caps it at standard because a spec is not an architecture decision. Heavy tier only on escalation, with justification.
- Brief: the user's request verbatim, `run_dir`, repo, triage flags, `rounds_used`, earlier answers. Output: `prompt.md` in the run directory plus a JSON summary.
- Subagents cannot use AskUserQuestion. Protocol: the agent returns `{"status":"questions",…}` (≤ 4 questions, 2-4 options each, recommended first) → you ask the user with ONE AskUserQuestion call → resume the SAME agent with SendMessage (the answers, `rounds_used`) → repeat, at most 3 rounds, then it decides and lists assumptions.
- The agent saves through `run.mjs save-prompt` (stdin → `prompt.md`, linted on write), so it needs no Write tool and no permission prompt outside the repo. Use the summary's `files`, `complexity`, `risk` and `criteria` to plan; read `prompt.md` only if you must. Planning then continues exactly like the simple path, with `prompt.md` as the brief source for every package.

## 11. Split path (huge)
Split when ANY holds: more than one independent subsystem or deliverable; the work touches more than ~10 files or ~500 changed lines; the request has phases or an order; 8+ list items; it needs a whole-repo read.
- A part is ONE deliverable that can be verified alone, ≤ ~5 files / ~300 lines. Write each as `<run_dir>/part-N.md` from `templates/split.md`, then `run.mjs lint-prompt part-N.md --part`.
- Each part states what it expects from earlier parts (`## Expects`: files, interfaces, test status in the repo). Handoff goes through the repo and `<run_dir>/handoff/*.md` (decisions a later part needs), never through conversation.
- Order by dependency; independent parts may run in parallel only on disjoint files. Each part gets its own subagent(s) with fresh context, planned and routed like a simple request (§1-§5), and is committed at its checkpoint.
- The main thread keeps only the ledger: one row per part, one-line results. Worker outputs and diffs stay in their runs; a part that turns out complex goes through §10 first.
