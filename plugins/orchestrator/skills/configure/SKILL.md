---
name: configure
description: Guided setup of the orchestrator for this user (/orchestrator:configure): which model families they use (Claude, GPT/Codex, Grok, Gemini), which subscription plan per family, what each family may see (privacy: sensitive data only to families that do not train on it), which family runs the main session, and the per-repo orchestrator default. Writes ~/.claude/orchestrator/config.yaml. Use when the user runs /orchestrator:configure, asks to set up or change the orchestrator's families, plans or privacy, or when preflight says the orchestrator is not configured. `--show` prints the current setup.
argument-hint: "[--show]"
---

# Orchestrator configure

Scripts: `node "${CLAUDE_PLUGIN_ROOT}/scripts/configure.mjs" <cmd>`. Report to the user in **Polish**. Never ask for, read or store credentials, tokens or API keys: logins stay in each vendor's CLI. The script only calls the CLIs' own status commands (no model tokens).

`--show` → `configure.mjs show --md`, print it, stop.

## 1. Detect
`configure.mjs detect` (≈5 s). Per family it returns: CLI found/version, login state, `detected_plan` (when the CLI exposes it), catalog `plans` (id, label, `sensitive_ok`, `training_on_data`, limits), `preselect` (installed and logged in), `current` (what config.yaml already says). Everything is generic over the families it returns: never assume a fixed list.

## 2. Ask (AskUserQuestion; at most 4 questions per call; every question's default is the CURRENT value, else the detected one)
Round A — families. One multiSelect question per ≤4 families (e.g. "Which of these do you use?"). Options labelled with state: "GPT (Codex) — installed, logged in (detected)", "Gemini — not installed". Put current/detected ones first, mark them "(Recommended)". A family that is not installed can still be chosen (the doctor will flag it).
Round B — plans, one question per chosen family: options = current plans, the detected plan, then the catalog plan ids in tier order (max 4 options; "Other" is added automatically: a free-text plan id is accepted and treated as a custom plan with conservative defaults, with a warning). Use multiSelect for a family where the user may hold several plans (e.g. a work plan plus a personal one); the first selected plan is the default. Option descriptions: the plan's `limits` and training/privacy note.
Round C — privacy, one question per chosen family: "May sensitive data (credentials, customer or personal data, production configs) go to <family> on <plan>?" Quote the catalog fact: "Catalog: trains on data = <x>, source <url>". Options: "Follow the catalog (sensitive: <yes|no>) (Recommended)", "Allow sensitive data (I opted out of training or have a business agreement)", "Never allow sensitive data". An unknown policy defaults to "no". Skip the question only for families whose catalog says `training_on_data: false` and `sensitive_ok: true`; just report them.
Round D — main session and repos. Main family: ask only when more than one primary family was chosen (default: current, else the default from `detect`). Per-repo orchestrator default (`global` = this orchestrator, `project` = the repo's own, `ask`): ask only when `repo.project_orchestrators` is non-empty or the user wants a default; default `ask`.

## 3. Apply
Write the answers as JSON to a scratch file and run `configure.mjs apply --answers <file>`:
`{"main_family":"…","families":{"<f>":{"enabled":true,"plans":["…"],"data_policy":{"sensitive_ok":false}}},"defaults":{"orchestrator":"ask"}}` — add `data_policy` only for non-catalog choices (`sensitive_ok` true/false), and `"enabled": false` for families the user dropped. Omitted families and keys keep their values, so the command is idempotent. A schema or secret error means nothing was written: fix the answers and retry.
Then print `configure.mjs show --md` and, in Polish: what was saved, which families can receive sensitive data and which cannot, one next step (`/orchestrator:doctor`).
Per-repo setup is separate: `/orchestrator:init` (once per non-empty repo; it settles that repo's rules vs these defaults).
