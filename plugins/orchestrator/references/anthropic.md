# Anthropic / Claude Code — research notes

Checked: 2026-10-27. Status markers: **[official]** = vendor docs, **[3rd-party]** = unofficial, **[unknown]** = not published / not verifiable, **[estimate]** = our own assumption.

## Models (API) [official]
Source: https://platform.claude.com/docs/en/about-claude/models/overview

| Model | API ID | Context | Max out | Latency | API price in/out per MTok | Thinking | API default effort | Intended use |
|---|---|---|---|---|---|---|---|---|
| Fable 5.1 | claude-fable-5-1 | 1M | 128K | slower | $10 / $50 | adaptive, always on | high | demanding reasoning, long-horizon agentic work |
| Opus 5.5 | claude-opus-5-5 | 1M | 128K | moderate | $4 / $20 | adaptive, always on | medium | long-running agentic coding, knowledge work |
| Sonnet 5.5 | claude-sonnet-5-5 | 1M | 128K | fast | $2 / $10 | adaptive (cannot be disabled in CC) | high | best speed/intelligence balance |
| Haiku 5.5 | claude-haiku-5-5 | 1M | 128K | fastest | from $0.10 / $0.50 | adaptive | medium | high-volume, latency-sensitive, classification/extraction |

Legacy still available: Fable 5, Opus 5, Opus 4.8/4.7/4.6/4.5, Sonnet 5, Sonnet 4.6, Haiku 4.5.

Note: the 1M context window is the API figure. In Claude Code on Pro, 1M context for some models (e.g. `opus[1m]` on Opus 4.6) needs usage credits. Pro access to 1M context on the 5.5 family: **[unknown]**. Assume the Claude Code default auto-compact window applies.

## Claude Code aliases and effort [official]
Source: https://code.claude.com/docs/en/model-config

- Aliases: `fable`, `opus`, `sonnet`, `haiku`, `best`, `opusplan`, `sonnet[1m]`, `opus[1m]`, `default`. On the Anthropic API: opus→Opus 5.5, sonnet→Sonnet 5.5, haiku→Haiku 5.5, fable→Fable 5.1.
- Effort levels: `low | medium | high | xhigh | max` for the Fable 5.x, Opus 5.5/5, Sonnet 5.5/5, Haiku 5.5, Opus 4.8/4.7 families. Opus/Sonnet 4.6 support `low|medium|high|max`. An unsupported level falls back to the highest supported level below it.
- Claude Code defaults: `high` everywhere, except Opus 5.5, Sonnet 5.5 and Haiku 5.5, which default to `medium`, and Opus 4.7, which defaults to `xhigh`. The API default differs (see table above).
- Session: `--effort`, `/effort`, `CLAUDE_CODE_EFFORT_LEVEL` (overrides everything, including subagents), `effortLevel` setting (`max` is not allowed there).
- Thinking cannot be turned off on Opus/Sonnet/Haiku 5.5 or Fable. Effort is the only lever.
- `ultracode` is a separate setting, not an effort level.

## Subagents [official]
Source: https://code.claude.com/docs/en/sub-agents

- Location: `~/.claude/agents/*.md` (user level, priority 4).
- Frontmatter: `name`, `description` (required); `tools`, `disallowedTools`, `model` (`sonnet|opus|haiku|fable|<full id>|inherit`), `effort` (`low|medium|high|xhigh|max`), `permissionMode`, `isolation: worktree`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `omitClaudeMd`, `color`, `autoCompactWindow`.
- **Per-invocation override:** the Agent tool takes `model` (highest priority) and `effort` (v2.1.292+, non-fork subagents). `CLAUDE_CODE_EFFORT_LEVEL` beats both. Effort variants like `implementer-low` are therefore **not needed**: one agent per role plus an override at call time is enough.
- No per-subagent thinking toggle. Subagents inherit the main session's setting.
- If the main session runs in `bypassPermissions`, `acceptEdits` or `auto`, the subagent's `permissionMode` is ignored.
- `isolation: worktree` requires git and creates a worktree branched from the default branch.

## Pro plan in Claude Code
Sources: https://support.claude.com/en/articles/11145838 , https://code.claude.com/docs/en/costs , https://code.claude.com/docs/en/model-config

- **[official]** Pro has a **5-hour session limit and a weekly limit**, shared between claude.ai and Claude Code. "Usage credits" (billed at API rates) are an option. Wrap-up allowance: once per week on Pro.
- **[official]** The Claude Code default model on Pro is **Opus 5.5** (from v2.1.280). So Pro **does** have Opus 5.5 in Claude Code.
- **[official]** Fable is not the default on any plan, so it must be selected explicitly. "Fable usage can bill to usage credits depending on plan and seat tier". Max has a separate weekly Fable limit.
- **[user, 2026-10-27]** Fable is **not available on the user's subscription**. It goes in `excluded_models` in models.yaml, and the orchestrator and `/orchestrator:update` skip it.
- **[official]** Model-specific messages exist ("You've hit your Opus limit"). After one of these, switching to another model family keeps you working. "Session/weekly limit" messages apply to all models.
- **[official]** Thinking tokens count as output tokens, so higher effort means more usage. The docs give **no multiplier**. **[estimate]**: see `models.yaml`.
- **[official]** Subagents draw from the same pool ("The subagent's own requests still draw on your usage").
- **[3rd-party / unknown]** Number of prompts per 5h on Pro: estimates range from 10 to 45. Anthropic does not publish the numbers.
- Numeric Pro limits in tokens or messages: **[unknown]**.

## Measuring Claude pool usage [official]
Source: https://code.claude.com/docs/en/statusline

The statusline script receives JSON with `rate_limits.five_hour.used_percentage`, `rate_limits.five_hour.resets_at`, `rate_limits.seven_day.used_percentage` and `rate_limits.seven_day.resets_at` (Pro/Max only, after the first response in a session). This is the only **exact** Claude pool measurement available to scripts. Plan: a statusline script writes a snapshot to `~/.claude/orchestrator/pools/claude.json`.
`/usage` and `/status` are interactive only.

## Skills [official]
Skills live in `~/.claude/skills/<name>/SKILL.md` and can carry an `effort` field in frontmatter (it overrides the session while the skill is active). Progressive disclosure: references are loaded on demand.
