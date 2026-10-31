# Main (orchestrating) session: model and effort (decision 2026-10-28)

**Decision: Sonnet 5.5 at `high`** (the user's current setting). Do not pin model/effort in SKILL.md frontmatter.
Re-check whenever `/orchestrator:update` sees a new Claude model or new cost data.

## Evidence (Anthropic, SWE-bench Pro subset, 478 problems, Sep 2026, API list prices)
| Model · effort | Solved | Cost per solved task |
|---|---|---|
| Sonnet 5.5 · medium | ≈ 80.6% (7 pts below high) | ≈ 59% of high's cost per task |
| **Sonnet 5.5 · high** (default) | 87.6% | $0.11 |
| Opus 5.5 · low | 87.4% (same within noise) | $0.12 (+7%) |
| Opus 5.5 · medium (default; v1's choice) | 92.8% | $0.22 (2x) |
| Opus 5.5 · high | 95.3% | $0.29 per task |
Source: https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence (checked 2026-10-28). Opus 5.5 at low did about half the output tokens and a third of the cache reads of Sonnet 5.5 at high.

## Why Sonnet high, not Opus
1. **The judgment-heavy parts are already delegated.** Routing is computed by `registry.mjs`, L/high-risk plans go to `orch-planner` (Opus), and high-risk reviews go to `orch-security-reviewer` (Opus) or Astra. The main loop mostly coordinates, which is the workload where Opus low ≈ Sonnet high.
2. **Opus medium = +5 pts for 2x the cost**, and the main session is the largest Claude consumer. The Team pool already hit 98% weekly once.
3. **Separate Opus caps exist on subscriptions** ("You've hit your Opus limit"). An Opus main session would compete with the Opus planner/reviewers for the same cap.
4. **Switching models mid-session invalidates the prompt cache**, and a skill's `model` override lasts only one turn. Per-skill model pinning would re-read the whole context at Opus rates on every switch.
5. **Not medium or low on Sonnet**: Anthropic recommends `high` for harder/longer multistep tool use. At low/medium Sonnet 5.5 checks in before long tasks are done and may skip verification.
6. **Not the advisor tool (Sonnet + Opus advisor)**: in Anthropic's check, Sonnet 5.5 at `high` consulted the Opus advisor on 0 of 20 problems, so it would add nothing.

## When to deviate
- A session that is mostly hard architecture/judgment with little coordination: `/model opus` at `medium` for that session (≈2x cost, +5 pts), ideally on the pool with headroom.
- A long, routine coordination session on a tight pool: Opus 5.5 at `low` is an equal-quality alternative with fewer tokens per step. It is worth an A/B via `/usage` attribution.
- Never `xhigh`/`max` for the main session: Sonnet then starts its own review rounds and subagents (Anthropic: about a third more cost at max).
