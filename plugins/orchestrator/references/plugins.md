# Codex and Grok Build plugins for Claude Code: analysis (2026-10-27)

## openai/codex-plugin-cc (`codex@openai-codex` 1.0.6)
- Runtime: `scripts/codex-companion.mjs` (Codex app-server, broker, job tracking, resume).
- `task [--write] [--model] [--effort none|minimal|low|medium|high|xhigh] [--prompt-file] [--json] [--fresh|--resume-last] [--background]`, where `--write` → `workspace-write`, otherwise `read-only`, approval `never`.
- `review` (native, git diff), `adversarial-review [--base] [--scope] [focus]` → JSON matching `schemas/review-output.schema.json`. **No effort for reviews.**
- Subagent `codex:codex-rescue` (model: sonnet, "Proactively use…") is a forwarder costing a Sonnet turn → **not used** by the orchestrator.
- Optional Stop hook "review gate" (`/codex:setup --enable-review-gate`): **keep it off** (it burns the Plus limit on every Stop).
- **Orchestrator usage:** `run-codex.mjs` calls `codex-companion.mjs task|adversarial-review --json` directly and falls back to `codex exec` (plugin missing, effort > xhigh, `--engine exec`).

## xai-org/grok-build-plugin-cc (`grok-build@xai-grok-build` 0.2.1)
- Runtime: `scripts/grok-bridge.mjs` → `grok -p … --always-approve [--sandbox read-only]`.
- **Problem:** always `--always-approve`. In `--write` mode there is no sandbox, and on Windows `--sandbox read-only` is not enforced, so read-only runs are effectively full auto-approve. Effort only low/medium/high.
- Subagent `grok-build:grok-delegate` (sonnet, "Proactively use…"): same cost as above.
- **Orchestrator usage:** none. `run-grok.mjs` calls `grok` directly with `dontAsk` + allowlists. The plugin's slash commands (`/grok-build:review` etc.) remain for manual use, at your own risk.

## Updates
`/orchestrator:update` checks the plugin versions (`~/.claude/plugins/installed_plugins.json`) and whether the companion's interface changed (`VALID_REASONING_EFFORTS`, `task` flags). A change means updating `run-codex.mjs` (`PLUGIN_EFFORTS`) and this file.
