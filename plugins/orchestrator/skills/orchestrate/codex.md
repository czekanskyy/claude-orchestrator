# Runbook: delegate a work package

Who gets what: `roster.md`. This file covers the mechanics.

## 0. One-time setup per machine

1. Codex CLI installed and logged in (`codex login`), then the plugin for Claude Code and its check:

```
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/codex:setup
```

2. Leave the stop-time review gate **off** (`/codex:setup --disable-review-gate`).
3. Optional, per repo: trust it in `~/.codex/config.toml` so a project `.codex/config.toml` is read.
   Workers started by the orchestrator always pass `--model` and `--effort`, so they do not need it.

```toml
[projects.'C:\path\to\repo']
trust_level = "trusted"
```

## 1. Write the brief

```
Goal: <one sentence, what changes for the user or the code>
Scope: you may edit only <files or folders>. Read anything.
Constraints: follow the repo's AGENTS.md / CLAUDE.md. Do not commit, push or switch branches.
  No new dependencies. No AI or tool names in code, comments or docs. <task-specific rules>
Done when: <observable criteria, the checks that must pass>
Report, in 15 lines or fewer: files changed, checks run and their result, anything unresolved.
```

## 2. Call a Claude subagent

Agent tool, `subagent_type` set to `orchestrator:<role>`, where the role is one of `planner`,
`security-reviewer`, `implementer`, `debugger`, `reviewer`, `runner`, `scribe` (for example
`orchestrator:implementer`). This guide uses the bare role names for short. Model and effort come
from the agent file. Independent
packages on disjoint files go out in one message so they run in parallel.

## 3. Call a Codex worker

Agent tool with `subagent_type: "codex:codex-rescue"`. It forwards the flags to the Codex runtime and
returns Codex's output unchanged. Flags first, then the brief:

| Purpose | Prompt starts with | Writes? |
|---|---|---|
| Implement a package (Sol) | `--fresh --wait --model gpt-6.1-sol --effort medium` | yes |
| Hard or second implementation (Sol) | `--fresh --wait --model gpt-6.1-sol --effort high` | yes |
| Cross-check a Claude diff (Sol) | `--fresh --wait --model gpt-6.1-sol --effort high` + "Read-only review, do not edit any file." | no |
| Diagnose a bug (Sol) | `--fresh --wait --model gpt-6.1-sol --effort high` + "Read-only diagnosis, do not edit any file." | no |
| Critical plan or security check (Astra) | `--fresh --wait --model gpt-6-astra --effort high` + "Read-only review, do not edit any file." | no |
| Bulk mechanical edit, extraction (Luna) | `--fresh --wait --model gpt-6-luna --effort low` | yes, unless told read-only |
| Fix the findings of its own last run | `--resume --wait --model <same> --effort <same>` | yes |

- **Read-only is a sentence in the brief**, not a flag: without it the forwarder adds `--write`.
- **Always `--wait`.** The orchestrator cannot call `/codex:status` or `/codex:result` (reserved for
  the user), so a job left in Codex's background is a result it never sees. Run the Agent call itself
  in the background instead when there is other work.
- **Always `--fresh` for a new package.** `--resume` picks the session's latest Codex thread; use it
  only when no other Codex package has run since.
- **Never call `Skill(codex:rescue)`** from the orchestrator: it re-enters the command and hangs.

A review brief names the diff, for example: "Review `git diff origin/<base>...HEAD` against the
brief below. List findings as file:line, severity, one sentence each."

## 4. Reviews the user starts

Only the user can start these; the orchestrator asks for one in one line:

```
/codex:review --wait --base origin/<base>
/codex:adversarial-review --wait --base origin/<base> <what to challenge>
```

## 5. Take the result back

1. `runner` reports `git status --short` and `git diff --stat`. A change outside the brief's scope
   may belong to another package running in parallel: check the ledger first, and never revert
   another package's files.
2. `runner` runs the checks the brief named.
3. The other family reviews (`reviewer` for Codex work, Sol for Claude work).
4. The orchestrator updates the ledger row.

## 6. When Codex refuses or runs out

- Usage-limit message, or no output: take the fallback in `roster.md` and tell the user.
- Codex not installed or not logged in: ask the user to run `/codex:setup`; meanwhile Claude covers
  the package and the cross-check is marked single-family.
