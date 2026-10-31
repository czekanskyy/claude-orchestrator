# OpenAI / Codex CLI — research notes

Checked: 2026-10-27. Local CLI: `codex-cli 0.164.0` (`codex` on PATH). Status: **not logged in** (`codex login status` → "Not logged in").

## Models (bundled catalog `codex debug models --bundled`) [official, local]
| slug | visible | default effort | effort levels | context | description |
|---|---|---|---|---|---|
| gpt-6.1-sol | list | low | low/medium/high/xhigh/max/ultra | 272k | "Latest workhorse model for coding and everyday work" (priority 1) |
| gpt-6-astra | list | low | low/medium/high/xhigh/max/ultra | 272k | "Frontier intelligence for the most demanding work" |
| gpt-6-sol | list | medium | low…max/ultra | 272k | previous-generation workhorse |
| gpt-6-luna | list | medium | low/medium/high/xhigh/max | 272k | "Fast and affordable model for easier tasks" |
| gpt-5.6-sol / -terra / -luna | list | low/medium | … | 272k | older generation |
| gpt-5.5 | list | medium | low/medium/high/xhigh | 272k | legacy |
| codex-auto-review, gpt-daybreak-* | hide | — | — | — | internal / cyber variants (ignored) |

- `ultra` = "Maximum reasoning with automatic task delegation". It spawns its own subagents, so it is **never** used by the orchestrator without approval.
- The bundled catalog may differ from the server catalog after login (e.g. **GPT-6.1 Terra** is on the pricing page but not in the bundled catalog). After `codex login`, run `codex debug models` (without `--bundled`) and update the registry.
- Speed tier `fast` ("2x speed, increased usage"; per the pricing page it uses 2.5x of the included allowance). The orchestrator does not use it.

> **User's plan (2026-10-28): ChatGPT Business, Standard seat only (no personal Plus).** The pricing page lists the 5h ranges below for "Plus and Standard Business", so the same estimates apply (pool `chatgpt_business`).

## Plus plan in Codex [official]
Source: https://learn.chatgpt.com/docs/pricing (formerly developers.openai.com/codex/pricing)

- Plus $20/mo. Codex in CLI, IDE, web and iOS. Plus models: **GPT-6.1 Sol, GPT-6 Luna, GPT-6.1 Terra** (plus Astra / 6 Sol in the limits table).
- **Local messages per 5h (Plus), estimates, "not fixed":**
  | model | 5h range |
  |---|---|
  | GPT-6 Astra | 5–45 |
  | GPT-6.1 Sol | 15–160 |
  | GPT-6 Sol | 15–150 |
  | GPT-6.1 Terra | 35–285 |
  | GPT-6 Luna | 350–3,000 |
- "Weekly limits may also apply." Weekly values: **[unknown]**.
- "Model choice, context, reasoning, tool use, retrieval, and caching all affect usage." There is no official per-effort multiplier: **[unknown]**. Credit rates per 1M tokens (in/cached/out) are a good relative weight: 6.1 Sol 50/2.5/250, 6 Sol 50/5/250, 6.1 Terra 25/1.25/125, 6 Luna 2.5/0.25/12.5.
- **[3rd-party]** Starting 2026-08-25 the 5h limit applies on Plus again, alongside the weekly limit (ithinkdiff.com).
- Checking usage: `/status` in the interactive CLI and https://chatgpt.com/codex/settings/usage. There is no documented non-interactive command. **To verify after login:** whether `codex exec --json` returns rate-limit fields (the session files `~/.codex/sessions/**/*.jsonl` probably contain `token_count` events with `rate_limits`: **[unverified]**).

## Non-interactive mode [official, `codex exec --help` 0.164.0]
- `codex exec [OPTIONS] [PROMPT]`, or a prompt from stdin (`-`).
- `-m/--model <slug>`.
- Effort per call: `-c model_reasoning_effort="<level>"` (a TOML override of the `model_reasoning_effort` key). Values per model come from the catalog.
- `-s/--sandbox read-only | workspace-write | danger-full-access`.
- Approvals: `-a/--ask-for-approval on-request|never` (documented for the CLI). In exec, `--approve-for-me` conflicts with `--sandbox`. **Forbidden without approval:** `--dangerously-bypass-approvals-and-sandbox` / `--yolo`, `danger-full-access`.
- `-C/--cd <dir>`, `--add-dir`, `--skip-git-repo-check` (needed outside a git repo), `--ephemeral` (does not save the session), `--ignore-user-config`, `--worktree`.
- Output: `--json` (JSONL events on stdout), `-o/--output-last-message <file>`, `--output-schema <file>`.
- Exit codes for `exec`: **[undocumented]**. The wrapper treats non-zero exit and/or an error event as failure.
- Windows: the sandbox on Windows needs to be verified with a smoke test (**[unverified]**).
