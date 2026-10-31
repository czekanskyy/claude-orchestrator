---
name: doctor
description: Health check of the orchestrator (/orchestrator:doctor): per-family CLI and login, adapter self-tests on fixtures, config schema, registry sanity and staleness, plugin agents, a routing dry-run with the privacy filter, and the pool table, as one compact table. Offline by default (zero model tokens). `--live` makes exactly one trivial call per configured family plus one minimal Claude subagent dispatch and reports the tokens spent (about 8-10k per external family). Use when the user runs /orchestrator:doctor, asks whether the orchestrator works, or after installing, configuring or updating it.
argument-hint: "[--live]"
---

# Orchestrator doctor

Scripts: `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"`. Report to the user in **Polish**, compact.

## Offline (default)
Run `doctor.mjs` and print its table as is (it includes the optional EGM rows: plugin present/version and reachable skills, drift against the tested version, gate self-check, cost estimate) (✅ ⚠️ ❌ with a fix hint per row, then the pool table and the token line: 0 model tokens). Add at most one line per ❌/⚠️ if the hint needs context, plus one overall verdict. Do not run anything else.

## `--live`
Tell the user it spends roughly 8–10k tokens per external family (mostly the CLI's own overhead) plus a few thousand for the Claude subagent. Then:
1. Dispatch ONE subagent through the Agent tool: `subagent_type: orchestrator:orch-runner`, `model: haiku`, `effort: low`, prompt `Reply with exactly: OK. Run no commands.` Outcome `ok` when the reply is `OK`, else `fail:<short reason>` (an unknown subagent type means the plugin is not installed or loaded). Note the token usage the Agent result reports, if any.
2. Run `doctor.mjs --live --claude-live <ok|fail:reason> [--claude-tokens <n>]`. It adds one row per enabled non-Claude family: cheapest model, lowest effort, read-only mode, temp directory, brief "Reply with exactly: OK".
3. Print the table. Report the approximate tokens from its last line plus the main session's own overhead; say that exact vendor-side accounting is not available.
A failing live row names the cause (`auth`, `rate_limit`, `cli_missing`, other) and the fix. A model marked `unverified` in the registry that answers live can be promoted to `active` by `/orchestrator:update`.
