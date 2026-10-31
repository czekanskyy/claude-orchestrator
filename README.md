# claude-orchestrator

**A multi-model orchestrator for Claude Code.** Your main session plans, routes and verifies; the work itself is done by the cheapest model that is good enough, across Claude, GPT (Codex), Grok and Gemini, under your real subscription limits and your own privacy rules.

```text
request ─► triage ─► [prompt-creator] ─► plan & route ─► workers ─► verify ─► cross-family review ─► report
            simple      complex only        model + effort   Claude / GPT /      tests,      a different model       compact,
            complex                         per subtask      Grok / Gemini       lint        family checks the       one screen
            huge                                                                             diff
```

## Contents
[What it does](#what-it-does) · [Requirements](#requirements) · [Install](#install-on-a-new-machine) · [Commands](#commands) · [How a request flows](#how-a-request-flows) · [Per-repo setup: `init`](#per-repo-setup-orchestratorinit) · [Unattended runs: `auto`](#unattended-runs-orchestratorauto) · [Privacy model](#privacy-model) · [EGM mode](#egm-mode-optional-for-critical-tasks) · [Reports and files](#reports-and-files) · [Updating](#updating) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing)

## What it does
- **Routes every subtask to a model and an effort level** from a sourced registry (`models.yaml`), balancing your plans' 5-hour and weekly pools instead of burning one.
- **Keeps sensitive work away from families that may train on your data.** Each family and plan carries a data policy; a task marked `sensitive` only ever reaches families you allowed to see it, and the run fails closed otherwise.
- **Reviews low-trust and cross-family.** The model that wrote a change never signs it off alone. The reviewer gets only the brief, the criteria and the diff, and must give `file:line` plus a failure scenario.
- **Stays quiet.** You see an assignment table, status tables, questions, blockers and one compact final report. Nothing else.
- **Splits work by size.** Simple requests run directly, complex ones get a vetted, self-contained prompt first, huge ones are split into parts that run in fresh contexts.
- **Optionally runs critical work in EGM mode** (Google's Elephant-Goldfish Model: design, adversarial review, then implementation), only after you say yes.
- **Can work unattended** in an isolated git worktree, waits through usage limits instead of failing, and never pushes.

Out of the box the user-facing text (tables, questions, reports) is **Polish**; scripts, files, code and comments are English. Localizing the text is a welcome contribution (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Requirements
| | |
|---|---|
| **Claude Code** | 2.1.292 or newer (per-call `model` and `effort` on subagents). |
| **Node.js** | A current LTS release or newer. All plugin scripts are dependency-free ES modules. |
| **git** | Required for worktrees (`auto`), diff reviews and `init`. |
| **Other families** | Optional. Install and log in to the CLIs you have a plan for: Codex (`codex login`), Grok Build (`grok`), Antigravity (`agy`). Only configured families are used. |
| **EGM plugin** | Optional, only for [EGM mode](#egm-mode-optional-for-critical-tasks). |

Tested on Windows 11 with Git Bash and PowerShell. Logins stay in each vendor's CLI; the orchestrator never asks for, reads or stores a token.

## Install on a new machine
```text
/plugin marketplace add czekanskyy/claude-orchestrator
/plugin install orchestrator@czekanskyy-tools
/orchestrator:configure
/orchestrator:doctor
```
1. **Add the marketplace and install the plugin.** From a terminal the same is `claude plugin marketplace add czekanskyy/claude-orchestrator` and `claude plugin install orchestrator@czekanskyy-tools`.
2. **`/orchestrator:configure`** is a short wizard: which families you use, which plan per family, what each may see (privacy), which family runs the main session. It writes `~/.claude/orchestrator/config.yaml` (no secrets).
3. **`/orchestrator:doctor`** checks CLIs, logins, adapters, schema and routing offline for zero model tokens. `--live` makes one trivial call per configured family and tells you what it cost.
4. **Optional:** copy [`global/CLAUDE.md`](global/CLAUDE.md) into `~/.claude/CLAUDE.md` so the main session always acts as the orchestrator. A project's own `CLAUDE.md` and orchestration docs take precedence over it.

Without a config, only the main family is enabled and nothing sensitive leaves it. Run `/orchestrator:init` once in each existing repository you want it to know.

## Commands
| Command | What it does |
|---|---|
| `/orchestrator:orchestrate [--dry-run] [--egm] [--use global\|project] <task>` | The main flow. `--dry-run` shows path, personas, routing and cost with zero model calls. |
| `/orchestrator:configure [--show]` | Families, plans, privacy, main family, EGM and `auto` defaults. Idempotent. |
| `/orchestrator:doctor [--live]` | Health check as one table: CLIs, logins, adapters, config, registry age, agents, privacy filter, pools, EGM, repo profile. |
| `/orchestrator:update` | Refreshes the vendor-fact registry (models, efforts, limits, data policies) with a sourced diff and your approval. Never touches your config or repo profiles. |
| `/orchestrator:init [--refresh] [--show] [--dry-run]` | One-time, per-repo profile: conventions, real commands, docs duties, critical paths, sensitivity. |
| `/orchestrator:auto [start\|status\|report\|review\|pause\|continue\|stop\|takeover\|abort]` | Unattended run in an isolated worktree. User-triggered only. |

## How a request flows
1. **Preflight (once per session).** Config present? Registry fresh? Pool nearly empty? Warnings are one line each. In a repo that ships its own orchestrator, your per-repo choice (`global`, `project` or `ask`) decides which one runs.
2. **Triage.** A deterministic, zero-token pass proposes the path, the sensitivity and whether the task is critical; the model keeps the judgment.
3. **Path by size.**

   | Class | What happens |
   |---|---|
   | **simple** | Plan inline (or do it yourself when it is one tiny package), then route, verify, review, report. |
   | **complex** | The `prompt-creator` agent reads the repo and turns the request into one final, self-contained English prompt. It asks you batched questions only for material gaps (at most three rounds). Every later brief is derived from that prompt. |
   | **huge** | Split into self-contained `part-N.md` files, each run like a simple request in fresh subagents. The main thread keeps only the ledger. |

4. **Plan and route.** Each subtask gets a type, complexity, risk and sensitivity. The router picks model and effort (role-bounded tier, effort matrix, live pool balance, privacy filter) and assigns a cross-review.
5. **Dispatch in waves.** Claude subagents run natively; GPT, Grok and Gemini run through small adapters that enforce read-only or repo-scoped writes, secret scanning and the privacy gate. Workers never commit, push or switch branches.
6. **Verify.** A runner agent executes the repo's real checks (tests, type check, lint, build, `git status`); self-reports are never trusted. Failures escalate: more effort, then the other primary family, then a heavy tier with a stated reason.
7. **Review.** A different family, low context, low trust, at most two fix rounds. Trivial low-risk changes are exempt. Disputes are settled by a cheap runnable check.
8. **Report.** One compact report, with pools and commits filled in automatically.

### Personas
Each agent in the tables gets a role emoji and a first name (🔨 implementer, 🧭 planner, 🧐 reviewer, ✍️ spec writer, 🐘 Elephant and 🐟 Goldfish in EGM mode, and so on), so a glance tells you who is doing what. They are assigned deterministically per run and cost nothing. The names are currently Polish.

### Prompt-creator
For complex requests the orchestrator never improvises from your wording. `prompt-creator` is a read-only spec writer (repo access plus doc lookup) that returns one final prompt with goal, scope, constraints, acceptance criteria and checks, and a linter checks that the required sections are present and the prompt stands on its own before anything is dispatched. It is also used with a stricter bar for [`auto`](#unattended-runs-orchestratorauto) contracts.

## Per-repo setup: `/orchestrator:init`
Run once inside an existing, non-empty repository. A read-only scan (git state, commit and branch conventions, stack and real commands, docs and policies, other orchestrators, sensitivity signals; secret files by name only) feeds a short interview in which you only decide **real conflicts** between the repo's own rules and the orchestrator's defaults. The recommended answer is always the repo's rule.

- `--dry-run` prints the proposal and writes nothing. `--show` prints the stored profile. `--refresh` re-derives a stale profile and re-asks only what changed (a fingerprint of the source docs detects staleness).
- The profile lives in `~/.claude/orchestrator/repos/`, keyed by repo identity (remote URL, else path). A separate, optional question writes a shareable `repo_profile:` block to `<repo>/.claude/orchestrator.yaml`; init never commits.
- **Precedence:** profile decision > the repo's own rules > orchestrator defaults. Push always needs an explicit yes.
- **What it feeds:** commit policy, format and attribution; docs duties; verification commands and definition of done (briefs, runner checks, report); critical paths (these force `risk: high`); the repo's default sensitivity (the privacy baseline); the EGM setting.
- `doctor` shows a `repo profile` row (missing, ok, stale, invalid) and flags conflicts with your config. Details: [`references/repo-init.md`](plugins/orchestrator/references/repo-init.md).

## Unattended runs: `/orchestrator:auto`
For work you want done while you are away. It is a contract, not a prompt you fire and forget.

**Launch contract.** You answer at most three short rounds of questions (goal, definition of done, verify commands, allowed and forbidden actions, protected paths, dependency and network policy, sensitivity, EGM pre-consent, optional deadline, limit thresholds, notification channel). The orchestrator then shows the generated permission allowlist, a feasibility estimate and the preflight result, and asks for one explicit **GO**. Nothing irreversible or external is allowed unless you list it, and **push is never offered**.

**Supervisor.** An external supervisor process (guardian plus engine, single-instance lock, heartbeat and watchdog, keep-awake) works in a dedicated worktree on branch `auto/<id>`, with a checkpoint commit and tag after each task whose checks pass. Your own checkout is touched only by `git worktree add` and, on your explicit yes, a merge. Permissions are `dontAsk` with a narrow generated allowlist; bypass-permissions is never used.

**Limit policy.** Claude 5-hour and weekly usage is read exactly, Codex via its app server, Gemini via `agy /usage` (zero tokens); Grok is estimated. Soft and hard thresholds with a reserve apply; at a limit the run **waits for the reset** with zero-token probes instead of failing, reroutes when privacy allows, and never switches accounts or uses overage. External failures wait too.

**Decisions.** Ambiguity is settled by a confidence protocol with a cross-family second opinion. Every decision is logged with an undo command; a diff guard and loop protection stop runaway work, and unresolved tasks are parked, not forced.

**Files and reports.** Everything lives under `~/.claude/orchestrator/auto/<run-id>/`: `contract.yaml`, `journal.md`, `decisions.jsonl`, `parked.md`, `limits.log`, `report.md`, `state.json` and more. While a run is going nothing is printed unprompted; `status` and `report` are read-only and work mid-run. Notifications are generic (`os`, `file` or `command`).

**Review and takeover.** `review` walks the morning report item by item (keep or revert; a revert changes only the `auto/*` branch). Merging is a separate question, asked only after the review, and needs your explicit yes. `takeover` pauses at the next safe checkpoint, writes `handoff.md` and continues in normal mode on the same worktree. `stop` ends at a checkpoint, `abort` stops now and keeps the branch.

Detail: [`references/autonomous.md`](plugins/orchestrator/references/autonomous.md).

## Privacy model
The question the orchestrator asks of every task is: *may this data go to this family?*

- Each task has a **sensitivity**: `none`, `internal` or `sensitive` (credentials, customer or personal data, production configs, regulated data). Triage proposes it, globs in your repo profile escalate it, and you can always raise it.
- Each family and plan in the registry carries a **data policy** (`training_on_data`, `sensitive_ok`, with source URL and check date). Consumer plans default to `sensitive_ok: false`; business and enterprise plans that exclude training default to true. Unknown means not allowed.
- **Two gates:** the router filters authors, reviewers, fallbacks and escalations, and every adapter re-checks (`privacy_blocked`). If no other family may see the data, the review becomes a documented `cross_review_gap` instead of leaking it.
- **Secrets:** briefs are scanned and refused on a hit; external CLIs run with `KEY`, `TOKEN`, `SECRET`, `PASSWORD` and `AUTH` variables removed from the environment; `config.yaml` rejects secret-looking keys and values.
- **Your choice wins.** During `configure` you can follow the catalog, allow sensitive data for a family you opted out of training for, or never allow it.

Full description, what leaves your machine and when, and known gaps: [docs/privacy.md](docs/privacy.md). Known gaps are listed honestly, for example that Gemini via `agy` has no secret-file deny rules and that kernel sandboxes are weaker on Windows.

## EGM mode (optional, for critical tasks)
[EGM](https://github.com/google/elephant-goldfish-model) (Google, Apache-2.0) separates an **Elephant**, which holds the whole design in its context and writes it, from **Goldfish** reviewers, fresh contexts that see only the design document and attack it. The orchestrator drives the real EGM skills and agents from the installed plugin; it does not reimplement them. What it adds is the `critical` rubric, a cost estimate, consent, and routing of the implementation to workers.

**Flow:** gate → consent → design (Elephant) → Goldfish review stages → resolve → implementation by routed workers → Goldfish drift check → report with a compact EGM section.

**Consent is never implied.** EGM starts only when you pass `--egm`, answer *run EGM* to the question the gate asks (after showing a cost estimate), or, for unattended runs, grant pre-consent in the `auto` contract. The config switch `egm: ask|off` (`/orchestrator:configure`, per-repo too) chooses between asking and never; `off` wins unless you pass `--egm` explicitly.

**Cost.** EGM is deliberately heavy: a full pass is about 15 agents on a typical critical task, and the estimate is printed before you decide (dry-run it with `/orchestrator:orchestrate --dry-run --egm <task>`). Use it for what is truly important now: architecture, hard-to-reverse changes, cross-subsystem work, high-risk large tasks.

**Without the plugin** the gate says so in one line and the normal flow continues. Install it with:
```text
claude plugin marketplace add google/elephant-goldfish-model
claude plugin install egm@egm
```
`doctor` reports the plugin, its tested version, drift, and the gate and cost self-checks. Details: [`references/egm.md`](plugins/orchestrator/references/egm.md) and [`references/egm-flow.md`](plugins/orchestrator/references/egm-flow.md).

## Reports and files
| Where | What |
|---|---|
| `~/.claude/orchestrator/config.yaml` | Your families, plans, privacy choices, defaults. No secrets. Written only by `configure`. |
| `~/.claude/orchestrator/repos/` | Per-repo profiles from `init`. |
| `~/.claude/orchestrator/runs/<run>/` | Ledger, plan, route, prompt, `report.json` of a normal run. |
| `~/.claude/orchestrator/auto/<run-id>/` | Everything of an unattended run, including `report.md`. |
| `~/.claude/orchestrator/usage.jsonl`, `pools/` | Local usage log and pool snapshots. |
| `<repo>/.claude/orchestrator.yaml` | Optional shareable repo profile block. |

All of it is outside the plugin and outside your repos, so updates never overwrite it. Set `ORCH_HOME` to relocate it.

The final report is capped at about 35 lines: what was done per task and model, checks, review outcome, decisions made for you, pools and commits, plus an `EGM` section when that mode ran.

## Updating
- **As a user:** `/plugin marketplace update czekanskyy-tools`, then `/plugin update orchestrator@czekanskyy-tools`, then `/orchestrator:doctor`.
- **Vendor facts** (models, efforts, limits, data policies) age. `preflight` and `doctor` warn after 30 days; `/orchestrator:update` researches the families you configured, shows a sourced diff and applies it only after your approval. It never touches `config.yaml` or repo profiles. Edits it makes live in the plugin cache and are replaced by the next plugin update, so land lasting changes in the repository.
- **As a maintainer:** change the repo, run `node plugins/orchestrator/scripts/selftest.mjs` and `node plugins/orchestrator/scripts/hygiene.mjs`, bump `version` in `plugins/orchestrator/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, add a [CHANGELOG](CHANGELOG.md) entry, commit, tag `vX.Y.Z`, push.

## Troubleshooting
| Symptom | Try |
|---|---|
| Anything seems off | `/orchestrator:doctor`; every failing row names its fix. |
| "not configured" warning | `/orchestrator:configure`. |
| "registry stale" | `/orchestrator:update`. |
| A family is skipped | `doctor` shows CLI, login and plan state; `configure --show` shows what is enabled and what may see sensitive data. |
| Sensitive task refused or review marked `cross_review_gap` | Working as designed: no allowed family could take it. Adjust privacy in `configure` if you opted out of training on that plan. |
| `unknown_model` / `unknown_effort` from an adapter | The vendor changed something: `/orchestrator:update`. |
| Pool nearly empty | The orchestrator suggests switching accounts; it never does so itself. |
| EGM was not offered | The task was not critical, `egm: off` is set, or the plugin is missing (the gate says which). |
| `auto` will not start | A dirty tree or another active run; `auto status` names it. Machine sleep pauses a run; `prepare` states the keep-awake caveat. |
| Windows path or shell quirks | Scripts are plain Node; run them from the repo root. Report anything odd with a redacted diagnostic ([docs/reporting-issues.md](docs/reporting-issues.md)). |

Bugs and ideas: see [docs/reporting-issues.md](docs/reporting-issues.md). Security problems: [SECURITY.md](SECURITY.md).

## Contributing
Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the dev loop, the selftests (`node plugins/orchestrator/scripts/selftest.mjs`, zero model calls), the hygiene scan and how to propose registry changes with sources. Architecture overview: [docs/architecture.md](docs/architecture.md). Release history: [CHANGELOG.md](CHANGELOG.md). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License
[MIT](LICENSE).
