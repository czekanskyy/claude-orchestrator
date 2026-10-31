# xAI / Grok Build CLI — research notes

Checked: 2026-10-27. Local CLI: `grok 1.0.70` (`~/.grok/bin/grok`). Status: **not logged in** ("You are not authenticated"). Bundled docs: `~/.grok/docs/user-guide/*.md`.

## Is there an official CLI? Yes [official]
**Grok Build** (`grok`) is xAI's official coding agent. Install via `irm https://x.ai/cli/install.ps1 | iex`. The official page says it is "now powered by Grok 4.7" (https://x.ai/build). No third-party alternative is needed. Grok Build has a full headless mode (`-p`, `--output-format json`) and flags compatible with Claude Code (`--permission-mode`, `--allow/--deny`, `--tools`).

## Plans (since 2026-10-12: "The X Subscription") [official]
Source: https://x.ai/pricing

| Plan | Price/mo | AI pool | Grok Build | Notes |
|---|---|---|---|---|
| Free | $0 | limited | limited | |
| **Plus** | **$8** | "Basic" (1x) | ✅ | Chat, Voice, Imagine, Build, API access, Cursor |
| Premium | $30 | 4x Plus | ✅ | + "Latest Grok models", Grok Bot, code reviews, cloud agents |
| Super | $100 | 15x Plus | ✅ | priority at peak times |
| Ultra | $200 | 50x Plus | ✅ | |

- **The user's plan: legacy SuperGrok** (bought before 2026-10-12, kept). Its pool size and window are unknown; the registry assumes a weekly pool (estimate).
- There is **no ~$20 plan**. The cheapest paid plan with Build is **Plus $8**. **Premium $30** adds "Latest Grok models", so on Plus the newest model (grok-4.7) **may be unavailable [unknown]**.
- The pool is **weekly**, shared across Grok (Chat/Imagine/Voice/Build/Bot) and Cursor. "Usage costs vary by product". Remaining usage is visible in grok.com settings. After it runs out: top-ups or wait for the refresh.
- Pool size in tokens or messages: **[unknown]** (xAI publishes only multipliers relative to Plus).
- API usage (XAI_API_KEY) is billed separately and does **not** draw from the pool. The orchestrator uses only OAuth login, never an API key.
- **[3rd-party]**: before 2026-10-12 Build was part of SuperGrok ($30) / X Premium+ and old plans were kept for existing subscribers. If you have a legacy plan (e.g. SuperGrok Lite), its limits are different.

## Models [official]
Sources: https://docs.x.ai/docs/models , https://docs.x.ai/developers/model-capabilities/text/reasoning , `grok models`

| id | context | reasoning_effort | API price in/out per MTok | notes |
|---|---|---|---|---|
| grok-4.7 | 500k | low/medium/high/xhigh (default high) | $2 / $6 (≥200k prompt: $4 / $12; cached $0.50) | "frontier model for coding, agentic tasks, and knowledge work". Text+image → text, function calling, structured outputs, Batch API (−20%). API: 150 rps, 50M TPM (does not apply to the subscription). Model card pasted by the user on 2026-10-27 matches docs.x.ai. Missing from the local CLI 1.0.70 list (`grok update` needed; availability on the legacy SuperGrok plan unknown) |
| grok-4.6 | 500k | low/medium/high/xhigh | $2 / $6 | **local CLI default** |
| grok-4.5 | 500k | low/medium/high (xhigh→high) | $2 / $6 | in the CLI list |
| grok-build-0.1 | 256k | [unknown] | $1 / $2 | code model, no description |
| grok-4.3, grok-4.20-* | 1M | — | $1.25 / $2.50 | not in the Build list |

- "Reasoning cannot be disabled." API default effort: **high**. The CLI accepts `--reasoning-effort/--effort none|minimal|low|medium|high|xhigh|max`, but each model accepts only its own menu. `/effort` in the TUI lists `low, medium, high, xhigh`.
- Reasoning tokens count toward consumption. No effort multiplier for the pool: **[unknown]**.
- Benchmarks **[3rd-party / vendor]**: Grok 4.7 DeepSWE 71.0% (vs 65.2% for 4.6), SWE-Together 64.7% (4th, behind Fable 5.1/Fable 5/Opus 5.5). It uses about 2x the tokens of 4.6. (snorkel.ai, apidog.com, androidheadlines.com)

## Headless [official, `~/.grok/docs/user-guide/14-headless-mode.md`]
- `grok -p "<prompt>"` or `--prompt-file <path>`; `-m <model>`; `--reasoning-effort <lvl>`; `--cwd <dir>`; `--max-turns N`.
- `--output-format json` returns `{text, stopReason, sessionId, cwd, num_turns, usage{input_tokens, cache_read_input_tokens, output_tokens, reasoning_tokens, total_tokens}, modelUsage}`. On error it returns `{"type":"error","message":...}` and a non-zero exit code. With OAuth, cost is often missing ("Absence means unreported").
- Permissions: `--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan`; `--tools` (allowlist, e.g. `read_file,grep,list_dir`); `--disallowed-tools` (e.g. `run_terminal_cmd,search_replace,write,Agent`); `--allow/--deny "Edit(.env)"`, `"Read(**/.env*)"`. **Forbidden without approval:** `--always-approve`, `--yolo`, `bypassPermissions`.
- `--no-subagents` limits Grok's internal fan-out, which saves pool.
- `grok usage` shows tokens per session only, not the plan pool. The pool can only be checked in grok.com settings: **no programmatic access**.

## Sandbox — Windows limitation [official]
Source: `18-sandbox.md`. `--sandbox read-only|workspace|strict|devbox` is enforced **only on Linux (Landlock) and macOS (Seatbelt)**. Elsewhere Grok "logs a warning and continues without enforcement". **On Windows the sandbox does not work**, so isolation has to come from permission flags: a tool allowlist, edit/shell denial, and `--deny Read(.env*)`. Alternative: WSL (not installed).
