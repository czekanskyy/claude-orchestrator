# Routing rules

Load this file only when planning a multi-step task. The tables between `<!-- matrix:* -->` markers are
parsed by `scripts/registry.mjs`. Keep their shape (first column = row key, header = column keys).
Model names never appear here. Models come from `models.yaml` (tier, suitability, effort levels).

Three ideas carry the design:
1. **Tier by role, not by habit.** Heavy models plan and judge, standard models build, light models run checks and transcribe.
2. **Two families check each other.** Different training, different blind spots.
3. **Spare the scarcer budget and the orchestrator's context.** Work goes to the pool with headroom, and context-heavy work goes outside the main session's pool.

## 1. Triage: orchestrate or not
Do it yourself (main session, no delegation) when ALL hold:
- ≤ 2 files and ≤ ~50 changed lines, or a question/explanation/read-only lookup
- one clear step, no independent sub-streams
- risk = low

Single cross-check only (main session implements, ONE review by the other primary family at low/medium effort):
- small change (as above) but risk ≥ med

Full orchestration when ANY holds:
- ≥ 3 subtasks, or ≥ 2 independent streams that can run in parallel
- complexity L, or risk high
- the user explicitly asks for orchestration / a multi-model plan

Planning itself: S/M plans with risk below high are written **inline by the main session** (no planner agent).
L or high-risk plans go to a planner and get a cross-family critique.
Every delegated call costs a full context load. When in doubt on a small task, do not orchestrate.

## 2. Classify every subtask
- `sensitivity`: none | internal | sensitive (§5a). Default `internal`.
- `type`: implement | refactor | debug | test | review | plan | research | mechanical
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

## 6. Cross-model checks
- Any code produced by family X is reviewed by the **other primary family** (never by X).
- Risk high → the cross-review uses a **security lens** (Claude side: `orch-security-reviewer`), plus an extra review round by a secondary family (when its privacy policy allows the data).
- L or high-risk plans are critiqued by the other primary family before implementation. Inline S/M plans are not.
- **Exempt** (nothing to judge): `dictated` edits and low-risk mechanical changes. They are verified by checks and a diff skim instead.
- The reviewer gets the brief, the acceptance criteria and the diff/files, never the author's reasoning.
- **Scope is a finding**: a change outside the files the brief allowed. Check the ledger first (it may be another package's), and never revert another package's files.
- Every finding is fixed or answered with a reason before commit. **At most two fix-and-review rounds**, then the main session decides or asks the user.
- The families disagree on a high-risk point → the user decides, shown both arguments.
- The main session reads review summaries, not full diffs, unless a finding is disputed.

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
