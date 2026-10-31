# Orchestrator v3 — research: connectivity and usage readout

Research date: 2026-10-31. Bounded pass (~25 sources). Confidence: **H** official doc or verified locally
with a cheap command, **M** official but partial, or one reliable secondary source, **L** forum/blog/single source.
"Verified locally" means a zero-model-token command was run on the development machine
(Windows 11, claude 2.1.312, codex 0.164, grok CLI, agy 1.4.7).

## A. How to drive other agent families from Claude Code

### Criteria
Windows reliability · tokens added to the main context · session resume · sandbox/approval safety ·
structured output · cost.

### Findings

| # | Option | Evidence | Conf. |
|---|--------|----------|-------|
| A1 | **Codex via `codex-companion` (official `codex-plugin-cc`)** — wraps the Codex app server using the global `codex` binary and its auth; task, adversarial-review, resume. | codex-plugin-cc README (github.com/openai/codex-plugin-cc); v2 ran it in production. README has no Windows section; no known blocker. | M |
| A2 | **`codex exec --json`** — JSONL events (`thread.started`, `turn.completed` with `usage`, `turn.failed`), `-o` last-message file, `--output-schema`, `exec resume <id>`, sandbox default read-only, `--ephemeral`. | learn.chatgpt.com/docs (Codex CLI reference, non-interactive); flags checked against `codex exec --help` locally. | H |
| A3 | `codex mcp-server` as a Claude Code MCP server | **Does not exist in codex 0.164** (`codex --help` lists only `mcp` for managing external servers). The "replaced by app-server" claim has one third-party source. | H (absent), L (why) |
| A4 | `codex app-server` (JSON-RPC over stdio, experimental) | `codex app-server generate-json-schema` lists `thread/resume`, `account/rateLimits/read`, `account/usage/read`, `account/read`. Docs call it experimental and recommend the SDK for CI. | H |
| A5 | **Grok headless** `grok --prompt-file … --output-format json -r <id> --permission-mode dontAsk --allow/--deny …` | `~/.grok/docs/user-guide` (shipped with the CLI). Unapproved tools are refused with exit 0 — adapter must detect refusals from the JSON. Sandbox is not enforced on Windows → rely on allow/deny rules. | H |
| A6 | `grok-build` plugin (bridge) | Always runs with `--always-approve` (read from the installed plugin) → weaker safety than A5 with explicit rules. | M |
| A7 | `grok agent` (ACP) | ACP = JSON-RPC over stdio, editor↔agent, "early" maturity (agentclientprotocol.com). Needs a long-lived client; no benefit for one-shot workers. | M |
| A8 | **Gemini family via Antigravity CLI `agy`** (successor for consumer access) | Official headless doc (antigravity.google/docs/cli/headless): `-p`, `--output-format json`, `--model`, `--effort`, `--conversation <id>`, `--mode plan\|auto\|accept-edits`, `--print-timeout`, `--sandbox`; JSON envelope has `status`, `response`, `conversation_id`, `usage{…}`. Installed and logged in locally; `agy models` works with zero tokens. | H |
| A9 | Gemini CLI (`gemini`) | Repo says consumer access (free, Google AI Pro/Ultra) **moved to Antigravity CLI on 2026-06-18**; Gemini CLI now targets Code Assist Standard/Enterprise and API keys. Same flags (`-p`, `--output-format json`). | H |
| A10 | Claude Code SDK/headless (`claude -p`) for a Claude worker | Not needed: native `Agent` tool with `model`+`effort` per call (CC ≥ 2.1.292) is cheaper and resumable via `SendMessage`. | H |
| A11 | MCP servers for workers | Every MCP server adds tool schemas to the main context for the whole session; one-shot CLI adapters add **zero** persistent tokens (only the JSON result). | M |

### Decisions vs v2

| Decision | Choice | Why |
|---|---|---|
| Codex worker | **Keep v2**: `codex-companion` default, `codex exec` fallback. Add stdin closed + sanitized env for `exec`. | No evidence that the app-server/SDK route is better for one-shot workers; companion handles resume and review natively. |
| Grok worker | **Keep v2** own adapter. | Official plugin forces `--always-approve`; own adapter keeps explicit allow/deny and secret deny rules. |
| Gemini worker | **New**: `run-gemini.mjs` over `agy -p … --output-format json`, stdin closed, prompt last. | Only supported consumer route; documented JSON envelope with usage and `conversation_id`. |
| Claude worker | **Keep v2**: plugin agents `orchestrator:orch-*` through `Agent` with per-call `model` + `effort`. | Zero extra tooling; confirmed per-call overrides. |
| MCP / ACP / SDK | **Not adopted.** | Persistent context cost (A11) or no benefit for one-shot workers (A7). |
| Registry `invoke` | Becomes adapter id from the registry (`claude-agent`, `codex`, `grok`, `gemini`), not a hardcoded list. | Family-agnostic requirement. |

### Risks and uncertainty (flagged)

1. **agy on consumer plans — ToS.** A Google forum thread (2026-10-27) says the current FAQ calls wrapping `agy`
   in another app unsupported on consumer plans; a reply says it is supported. The FAQ URL
   (`antigravity.google/docs/cli/faq`) returned 404. **Unresolved, L.** The adapter prints a one-time notice and
   the doctor shows ⚠️ for the Gemini family on a consumer plan.
2. **agy on Windows without a TTY.** GitHub issue google-antigravity/antigravity-cli #76 (closed 2026-07-12):
   stdout dropped when piped. Fixed in ≥1.1.1 per the issue; workaround is closing stdin. Live check on 1.4.7 is
   done by `doctor --live`. **M.**
3. **Codex on Windows.** `codex doctor` locally warns that Microsoft Defender may interfere and that 0.166.0 is
   available. Third-party issues report a missing `codex-windows-sandbox-setup.exe` / PATH mismatch (status
   unverified). Adapter reports `cli_missing`/`cli_error` with the hint to run `codex doctor`. **L.**
4. **app-server is experimental.** The rate-limit probe (B1) is optional and always falls back to the estimate.
5. `agy` permission denials exit 0 with a stderr notice — adapter treats `status != SUCCESS` and a denial notice
   as a failure signal.

## B. Reading usage / limits per family

Rule: official interface only; never read or print OAuth tokens or credential files. **No credential file is
read by v3.** Each interface below uses the CLI's own auth. One flagged exception to "no local file": the Claude plan is detected from `organizationType`/`organizationName` in `~/.claude.json` (`oauthAccount`), which is account metadata; the tokens next to it are never parsed or printed.

| # | Family | Interface | Verified | Used by v3 | Conf. |
|---|---|---|---|---|---|
| B1 | **Codex/GPT** | `codex app-server` → `initialize` + `initialized` + `account/rateLimits/read`. Returns `primary` (5 h window, 300 min, `usedPercent`, `resetsAt`), `secondary` (weekly), `planType`, `credits`, `rateLimitReachedType`. | **Yes, locally, zero model tokens** (plan `team`, 5 h 50 %, weekly 45 %). | Measurement `app-server`; estimate as fallback. Replaces v2 pure estimate. Experimental → cached, short timeout. | H |
| B2 | **Claude** | Statusline JSON on stdin: `rate_limits.five_hour` / `seven_day` (`used_percentage`, `resets_at`). | v2 production | Measurement `statusline` (v2 unchanged, snapshot per account). | H |
| B3 | **Grok** | `/usage` is interactive only. `grok usage <session-id>` prints persisted per-session tokens/cost, not account allowance. | Doc read | Measurement `estimate`/`manual`. | H |
| B4 | **Gemini (agy)** | `agy -p` JSON envelope gives per-call `usage`. No documented non-interactive account-quota command found. Quotas refresh every 5 h; AI credits are purchasable (blog.google rate-limits post; support.google.com/googleone/answer/16286513). | `agy --help`, `agy models` | Measurement `estimate`/`manual`; per-call usage logged. | M |

## C. Privacy and plan catalog sources

| Family | Fact | Source | Conf. |
|---|---|---|---|
| Anthropic | Consumer (Free/Pro/Max): training choice since 2025-08-28; 5 y retention if allowed, 30 days if not. Commercial (Team/Enterprise/API): not trained on unless opted in; 30 days. | docs.claude.com/en/docs/claude-code/data-usage | H |
| Anthropic plans | Pro; Max 5x/20x; Team Standard/Premium seats. Multipliers are relative estimates, not fixed counts; secondary sources disagree on Premium price. | official pricing (no fixed counts); secondary blogs | M/L |
| OpenAI | Business/Enterprise: no training by default, including Codex. Plus/Pro/Free: training on by default, opt-out "Improve the model for everyone". | help.openai.com/en/articles/8983130 | H |
| OpenAI plans | Plus and Business share 5 h ranges; Pro has no 5 h limit; Business billed per seat. | learn.chatgpt.com/docs/pricing | H |
| xAI | Chat data: training on by default, opt-out "Improve the Model" in app/grok.com Data Controls; going forward only; feedback may still be used. xAI's own policy page returned 403. | X Help Center + third-party guides | L/M |
| Google (agy, consumer) | Free/Pro/Ultra personal: training on by default per forums; only an "Enable telemetry" toggle is visible, effect on training unclear. Workspace contractually protected. | discuss.ai.google.dev threads (several) | **L** |

Conservative defaults used in `models.yaml`: Claude commercial and OpenAI Business `sensitive_ok: true`;
Claude consumer, Grok and Gemini consumer `sensitive_ok: false`. Any unknown tier ⇒ `sensitive_ok: false`.
Users can override per family in `config.yaml`.

## D. Plugin-format facts (verified from official docs + `claude plugin validate --help`)

- Manifest `.claude-plugin/plugin.json`; components at plugin root: `skills/<n>/SKILL.md`, `commands/*.md`,
  `agents/*.md`, `hooks/`, `.mcp.json`, `bin/`. Everything is namespaced `plugin:name`.
- `${CLAUDE_PLUGIN_ROOT}` is substituted in skill/command/agent Markdown, **not** exported to Bash tool
  environments → scripts locate themselves with `import.meta.url`; commands pass the root as an argument.
- Version changes the install path, so mutable state lives in `~/.claude/orchestrator/`.
- Plugin agents ignore `hooks`, `mcpServers`, `permissionMode`.
- Agent tool takes `model` (family alias) and `effort` per call; `SendMessage` resumes a subagent.
- Authoritative check: `claude plugin validate <dir> [--strict]`.

## E. Decision summary

1. Keep v2 adapters for Codex, Grok and Claude; add `agy`-based Gemini adapter.
2. Use official, token-free usage readout where it exists (Claude statusline, Codex app-server); estimates elsewhere.
3. No MCP/ACP/SDK transports: no benefit for one-shot workers, persistent context cost.
4. Privacy is a first-class routing constraint with fail-closed defaults; Google consumer and xAI default to
   "do not send sensitive data".
5. Revisit when: ToS for `agy` wrapping is clarified, Codex `app-server` leaves experimental, xAI publishes an
   accessible policy page.
