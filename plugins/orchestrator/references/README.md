# Research index (Phase 0)

Checked: 2026-10-27. Files:
- `anthropic.md`: Claude models, effort, subagents, Pro limits, statusline `rate_limits`
- `openai-codex.md`: Codex CLI 0.164.0, model catalog, Plus limits, `codex exec` flags
- `xai-grok.md`: Grok Build 1.0.70, X Subscription plans, models, headless, Windows sandbox
- `google-gemini.md` (v3): Gemini via the Antigravity CLI, privacy and open risks
- `../../../docs/research-connectivity.md` (v3): how each family is reached, usage readouts, privacy facts

The table below is the Phase-0 snapshot of 2026-10-27 (v2). Current state: `/orchestrator:doctor`.

## Local environment (Windows 11, PowerShell 7)
| tool | status |
|---|---|
| codex | 0.164.0, **not logged in** |
| grok | 1.0.70, **not logged in**, possibly outdated (no grok-4.7) |
| node | v26.12.1 ✅, bun ✅ |
| bash / Git Bash / WSL | ❌ none |
| git | ❌ none (no worktrees, no git diff, Codex needs `--skip-git-repo-check`) |
| python | ❌ (Microsoft Store stub only) |
| jq | ❌ |
| `~/.claude/settings.json` | no `statusLine` |

## What is unknown or estimated
- Numeric Pro limits (tokens/messages per 5h and weekly): **unknown**. The statusline gives exact percentages.
- Fable on Pro: pool vs paid credits: **unknown**.
- Codex Plus weekly limit: **unknown**. 5h ranges are official estimates.
- Grok Plus pool size: **unknown** (multipliers only). No programmatic readout.
- Effort cost multipliers for all three families: **unknown**. The weights in `models.yaml` are **estimates**.
- Whether `codex exec --json` returns rate limits: **to verify after login**.
- Grok-4.7 availability on Plus $8 vs Premium $30: **unknown**.
