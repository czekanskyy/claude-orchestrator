# Lineage: what v2 took from v1 (body-work.pl)

v1 = `C:\Users\Dominik\Dev\body-work.pl\.claude` (`orchestrate` skill + `docs/orchestration.md` + `docs/runbooks/delegate-to-codex.md` + 7 agents), Claude + Codex only, repo-specific. Analyzed 2026-10-28.

| v1 idea | Where it lives in v2 |
|---|---|
| Tier by role: heavy plans/judges, middle builds, light runs and transcribes | `routing.md` §3 `tier_bounds`: workers max standard, review/plan up to heavy |
| Escalate effort before model; no silent jump to Opus | `registry.mjs escalate`: effort +1 → other family → heavy (justified) → stop |
| Sonnet vs Sol: repo-reading work outside, iterative work inside, otherwise alternate | `context_heavy` / `interactive` flags + pool balancing (`candidates`) |
| S/M normal plans inline, planner only for L/critical | `route`: kind `inline` for S/M plans below high risk |
| Cross-check exemptions: dictated edits, runner output | `route`: `dictated` / low-risk mechanical → checks + diff skim |
| Max two fix-and-review rounds; critical disagreement → user | `routing.md` §6, SKILL §5 |
| Scope check, never revert another package's files | reviewer agent, SKILL §4 |
| `runner` (Haiku, low) keeps check output out of the orchestrator | `orch-runner` agent |
| `debugger` (root cause first, failing test) | `orch-debugger` agent |
| `security-reviewer` for critical work | `orch-security-reviewer` (risk high → security lens) |
| Reports ≤ 15 lines, review verdict + findings only | agents, `templates/brief.md`, adapter `--max-text` 4000 |
| Ledger table kept current | `templates/plan.md`, SKILL §2 |
| `--resume` only for the worker's own latest run | `run-codex --resume-of` (guarded), `run-grok --resume-session` |
| Deny reading lockfiles / generated files | `run-grok` TOKEN_DENY, brief template |
| Workers never commit/push/switch branches | agents, brief template |
| Repo docs are the procedure (project rules win) | SKILL §0 + `.claude/orchestrator.yaml` overlay |
| Always pass `--model`/`--effort` (untrusted repo falls back to the user's Codex default) | adapters always pass both |

Kept from v2 (absent in v1): machine-readable registry and routing, pool tracking (exact Claude via statusline), automatic cooldown + fallback ladder, Grok as a third pool, secret scanning and sandboxed adapters, `/orchestrator:update`. New in v3: family-agnostic registry, config + privacy model (`data_policy`, task sensitivity, fail-closed routing), Gemini worker (`run-gemini.mjs`), `/orchestrator:configure|doctor|update`, plugin packaging. `scribe` was folded into `orch-mechanic` (same job: dictated text and mechanical edits, same light tier, same cross-review exemption).
