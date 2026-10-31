---
name: update
description: Updates the orchestrator's vendor-fact registry (/orchestrator:update) for the families the user has configured only: models, effort levels, plan limits and tiers, CLI flags, vendor plugin versions, and training/retention terms, after showing a sourced diff and getting approval. Updates models.yaml, the plan catalog, CHANGELOG and the staleness date; never touches the user's config.yaml. Use when the user runs /orchestrator:update, when preflight or doctor says the registry is older than 30 days, or when an adapter returns unknown_model/unknown_effort.
argument-hint: "[--check-only]"
---

# Orchestrator update

Scripts in `${CLAUDE_PLUGIN_ROOT}/scripts`. Report to the user in **Polish**. Nothing is written before the user approves the diff. `~/.claude/orchestrator/config.yaml` is the user's and is never edited here. Never delete a model: mark it `status: deprecated`. Skip anything in `excluded_models` unless the user says otherwise.

## 1. Gather (cheap first)
1. `update.mjs scan --out <scratch>/scan.json` → configured families only; per family the plans and models with their source URLs, the zero-token CLI observations (Codex catalog, `grok models`, `agy models`, versions), the registry diff against them, the staleness date. Families the user did not configure are skipped entirely: do not research them.
2. Vendor plugin versions: `~/.claude/plugins/installed_plugins.json` (`codex@openai-codex`, `grok-build@xai-grok-build`). If the Codex plugin changed, grep its `codex-companion.mjs` for `VALID_REASONING_EFFORTS` and the `task` flags and compare with `PLUGIN_EFFORTS` in `run-codex.mjs`.
3. Official docs for each configured family (WebFetch the `sources` from the scan; WebSearch only when a page moved). Check the whole `checklist` from the scan: models (new, removed, renamed, effort levels, context), plan tiers and 5h/weekly limits, CLI flags the adapters use, and **training/retention terms for each configured plan**. Where the terms are unclear or became worse, the safe reading wins: `sensitive_ok: false`. Cite the page, never copy long passages.
4. Add Claude results to the scan data the same way as the other families (alias ids `haiku`, `sonnet`, `opus`).

## 2. Diff
`registry.mjs diff --observed <scratch>/scan.json …` is already in the scan's `diff_markdown`. Add your own findings. Show the user ONE list in Polish: **new**, **changed** (effort, context, defaults), **not seen** (proposed `deprecated`), **plans/limits**, **privacy terms** (per plan: before → after, `sensitive_ok` impact), **CLI flags / plugins**. Every row has a source link and the date checked; uncertain facts are marked "unknown/estimate". Then ask (AskUserQuestion: apply all / select / cancel). `--check-only` → stop here.

## 3. Apply (only after approval)
- Edit `${CLAUDE_PLUGIN_ROOT}/models.yaml`: new models get `status: unverified` and every field (tier, suitability 1–5 per task type, effort levels/default, `base_cost_weight`, `verified_at`, sources); changed ones update the fields; gone ones `status: deprecated` + `deprecated_reason`. Plan catalog: limits notes, tiers, `data_policy` (`training_on_data`, `sensitive_ok`, `source`, `checked`). Also, when needed: `routing.md`, the adapter scripts (flags, `PLUGIN_EFFORTS`), `agents/orch-*.md` defaults, `references/*.md`.
- `registry.mjs validate` must report `ok: true`.
- `update.mjs stamp --approved --plans <plan ids you re-checked> --note "<bullets: what changed, sources>"` sets `meta.verified_at`, refreshes those plans' `checked` dates and appends the CHANGELOG entry.
- If `${CLAUDE_PLUGIN_ROOT}` is under `~/.claude/plugins/cache`, tell the user the edit lives in the plugin cache and is replaced by the next plugin update: the same diff belongs in the source repo (`czekanskyy/claude-orchestrator`), then `claude plugin update orchestrator@czekanskyy-tools`.

## 4. Smoke test (new/changed models only, lowest effort, minimal cost)
Brief file: `Reply with exactly: OK`. GPT: `run-codex.mjs --model <id> --effort <lowest> --mode review --prompt-file <f> --cwd <scratch> --timeout 120 --allow-unverified`. Grok: `run-grok.mjs … --max-turns 1 --allow-unverified`. Gemini: `run-gemini.mjs --model <id> --effort <lowest> --mode research … --allow-unverified --sensitivity none`. Claude: Agent tool `orchestrator:orch-researcher` with `model` = alias and the lowest `effort`. Pass → `status: active`. Fail → keep `unverified` and tell the user why (login, CLI update).
Report (Polish): what changed, smoke results, privacy-term changes, what is left for the user.
