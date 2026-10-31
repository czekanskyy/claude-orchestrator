# Changelog: orchestrator registry

## Unreleased: `/orchestrator:init` (per-repo profile)
- New skill `init` (user-triggered only: `disable-model-invocation`): one-time setup of an existing, non-empty repo. `scripts/repo-scan.mjs` (read-only, zero tokens, one compact JSON, secret files by name only), `scripts/init.mjs` (`plan`, `dry-run`, `apply`, `show`, `status`, `rules`), Polish interview (≤ 4 questions per call, ≤ 3 rounds, only real conflicts, recommendation = the repo's rule). `--refresh` re-asks only what changed; `--dry-run` writes nothing.
- Profile stored user-local in `~/.claude/orchestrator/repos/` keyed by repo identity (remote, else path); optional shareable `repo_profile:` block in `<repo>/.claude/orchestrator.yaml` (separate question, never committed). v2 `projects.yaml` untouched; the orchestrator choice still lives there. A fingerprint of the source docs detects staleness.
- Consumption: preflight prints a `Repo rules:` block (or one line suggesting init); commit policy/format/attribution, docs duties, verification commands and definition of done reach briefs, runner checks and the final report; critical paths force `risk: high` (router) and flag triage; the repo sensitivity default is the privacy baseline; EGM setting reaches `egm_gate`. Precedence: profile > repo rules > defaults (`references/repo-init.md`).
- Doctor: `repo profile` row (missing / ok / stale / invalid) and `repo profile vs config` conflicts. Fix: triage no longer hardcodes `internal` as the baseline sensitivity.

## 2026-10-31: v3.1.0 (workflow: triage, prompt-creator, personas, silence, low-trust review)
- Triage first: `scripts/triage.mjs` proposes simple / complex / huge, `sensitivity` and `critical` from deterministic signals (zero tokens); the model keeps the judgment. Rubric and split criteria: `routing.md` §1, §10, §11.
- New task type `spec` and agent `prompt-creator` (complex path). The router picks the tier: light models score `spec: 2`, below the floor of 3, so it resolves to a standard model at medium effort. Read-only repo access plus doc lookup; batched Q&A through the orchestrator (subagents have no AskUserQuestion: `questions[]`, then SendMessage resume, max 3 rounds); writes `runs/<run>/prompt.md`.
- Huge path: split into self-contained `part-N.md` (`templates/split.md`, `run.mjs lint-prompt --part`); the main thread keeps only the ledger.
- `scripts/run.mjs`: run directory + ledger (waves, deterministic personas, status, decisions, fallbacks, reviews), assignment and status tables, final report (35-line cap, pools and commits auto-filled), prompt lint. `scripts/dryrun.mjs`: path + personas + tables with zero model calls. New templates: `assignment`, `status`, `review`, `split`; `report` rewritten.
- Silence policy in SKILL.md: only the assignment table, status tables, questions, blockers and the final report reach the user.
- Review: low context (brief + criteria + diff only), low trust (fallible-author preamble; `file:line`, failure scenario, confidence; capped findings; `Checked:` list), disputed findings settled by a cheap runnable check, trivial S/low-risk changes exempt, max two fix rounds. See `references/review.md`.
- `scripts/egm-gate.mjs`: the `egm_gate` extension point between prompt-ready and planning (placeholder: always not-critical).

## 2026-10-31: v3.0.0 (plugin, config, privacy, Gemini)
- Packaged as the single plugin `orchestrator` (marketplace `czekanskyy-tools`): skills `orchestrate`, `configure`, `doctor`, `update`; agents `orchestrator:orch-*`. v2 skills and agents are replaced (backup in `~/.claude/orchestrator/backup-v2-<date>`).
- Registry schema 2: families → plans catalog with `data_policy` (training_on_data, sensitive_ok, source, checked). Plan ids equal the v2 pool ids, so history survives. User choices live in `~/.claude/orchestrator/config.yaml` (no secrets); without it only the main family is enabled and nothing sensitive leaves it.
- Privacy: task `sensitivity` none|internal|sensitive; sensitive tasks only to `sensitive_ok` families (router + adapters), sensitive globs escalate, fail closed, `cross_review_gap` when no other family may see the data.
- New family: Gemini through the Antigravity CLI (`agy`), `run-gemini.mjs`; `gemini-3.8-flash` was promoted to `active` after `doctor --live` answered through agy 1.4.12 (2026-10-31). Consumer Gemini plans have no training opt-out: `sensitive_ok: false`.
- Codex pool usage is read at zero model tokens from `codex app-server` (`account/rateLimits/read`); see `docs/research-connectivity.md`.
- New commands: `/orchestrator:configure` (wizard), `/orchestrator:doctor` (offline table, `--live`), `/orchestrator:update` (sourced diff, approval, never touches config).
- `scribe` agent folded into `orch-mechanic` (identical role and tier). v2 behavior kept: per-repo global|project choice, overlay, role-bounded tiers, effort matrix, pool balancing, escalation ladder, mandatory cross-family review, session resume.

## 2026-10-27: initial version
- Registry: Claude (haiku/sonnet/opus 5.5), GPT (gpt-6-luna, gpt-6.1-terra [unverified], gpt-6.1-sol, gpt-6-astra), Grok (grok-4.7 [unverified], grok-4.6, grok-4.5).
- Excluded: Fable (not available on the user's Pro plan), gpt-daybreak-* / codex-auto-review (hidden variants).
- Pools: Claude Pro (exact via statusline), ChatGPT Plus (estimates; official 5h ranges), SuperGrok legacy (estimates/manual).
- Codex adapter built on codex-plugin-cc 1.0.6 (codex-companion), with a `codex exec` fallback. Own Grok adapter (the plugin always uses --always-approve).
- Sources: see `references/*.md` (checked 2026-10-27).

## 2026-10-27: post-login corrections (live catalogs + smoke tests)
- `codex debug models` (live): gpt-6.1-sol context 272k → 500k, default effort low → medium. gpt-6.1-terra confirmed (levels low…ultra, default low, 500k) → active.
- `grok models` (grok.com login): grok-4.7 is the default → active. New model grok-4.7-build-fast (light tier, only effort low verified, parameters estimated).
- Smoke tests "Reply with exactly: OK" at effort low: gpt-6-luna, gpt-6.1-terra, grok-4.6, grok-4.7, grok-4.7-build-fast: all OK.

## 2026-10-28: real plans + orchestrator choice per repo
- Claude: pool `claude_team` (Team Standard, default) + `claude_pro` (personal Pro, alt for fallback/hobby). The active pool is detected from the Claude Code login (`~/.claude.json` oauthAccount.organizationType → `pools.*.account_match`). The statusline snapshots the active pool. Fallback suggests an account switch when Team runs out (user action).
- GPT: `chatgpt_plus` → `chatgpt_business` (Business Standard, the only GPT plan; same 5h ranges). The usage log was migrated.
- `registry.mjs preflight` (one call: repo, subscription, orchestrator choice, staleness, pools, warnings) and `project-pref` (user-local per-repo `orchestrator: global|project|ask`, `claude_pool`) in `~/.claude/orchestrator/projects.yaml`, outside the repo.
- SKILL: `--use global|project`. In repos with their own orchestrator the saved choice decides; the repo's own rules still apply under the global one.

## 2026-10-28: best of v1 (body-work.pl orchestrator) merged in
- Tier by role: workers (implement/refactor/test/debug/mechanical/research) max standard tier; heavy only for review/plan or escalation.
- Escalation ladder: effort +1 → other primary family (same tier) → heavy (justified) → stop.
- Context economy: `context_heavy` → outside the main family, `interactive` → main family (new `meta.main_family`).
- S/M plans below high risk are written inline (no planner, no critique). Dictated / low-risk mechanical edits are exempt from cross-review.
- Risk high → cross-review with a security lens (`orch-security-reviewer`). Max two fix rounds, disagreements on high risk go to the user.
- New agents: `orch-runner` (checks out of the main context), `orch-debugger`, `orch-security-reviewer`. Reports ≤ 15 lines. Adapter `text` default 4000 chars.
- Session resume for fix rounds: `run-codex --resume-of` (guarded), `run-grok --resume-session`. Grok denies lockfile/minified reads.
- Per-repo overlay `<repo>/.claude/orchestrator.yaml` (deep-merged; families.*.pool repoints a family's models); statusline snapshots the overlay's Claude pool.
- See `references/lineage.md`.

## 2026-10-27: Grok family trimmed (user request)
- Removed grok-4.7-build-fast, grok-4.6 and grok-4.5 from `models`. Added them to `excluded_models` (grok-non-4.7) so orchestrator-update does not propose them again.
- Only grok-4.7 remains in the Grok family (coding fallback, extra review, simple tasks via tier overkill).

## 2026-10-28: orchestrator-update (no model changes)
- Live `codex debug models` and `grok models` match the registry (diff: no differences). Codex plugin 1.0.6 and Grok Build plugin 0.2.1 unchanged; `VALID_REASONING_EFFORTS` in codex-companion still equals `PLUGIN_EFFORTS`. codex-cli 0.164.0, grok 1.0.70.
- Claude: aliases opus/sonnet/haiku resolve to 5.5, effort levels low..max, 1M context confirmed. Sources: code.claude.com model-config, sub-agents, platform.claude.com models overview. Opus 5.5 / Sonnet 5.5 price ratio 2x matches `base_cost_weight`.
- GPT: Codex 5h ranges unchanged (Astra 5-45, 6.1 Sol 15-160, 6.1 Terra 35-285, Luna 350-3000). Source: learn.chatgpt.com/docs/pricing.
- Grok: grok-4.7 efforts low..xhigh, default high, 500k context confirmed. x.ai/pricing returned 403, so `grok_supergrok` pool left at its previous verified_at.
- Only `verified_at` bumped (registry stays unmodified otherwise).
- Open notes (not applied): Sonnet 5.5 default effort is medium in Claude Code but high on the API; Haiku 5.5 API price is about 1/20 of Sonnet while `base_cost_weight` is 0.25 (estimate); Codex Fast = 2.5x and Ultrafast = 8x usage multipliers (Astra, 6.1 Sol), not modelled.
