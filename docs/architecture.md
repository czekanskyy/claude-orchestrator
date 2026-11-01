# Architecture

A map for contributors. The user-facing description is in the [README](../README.md); the privacy rules are in [privacy.md](privacy.md).

## Principle
**Skills decide, scripts compute.** Anything deterministic (triage signals, routing, privacy filtering, pool arithmetic, rendering tables and reports, health checks) is a dependency-free Node script that prints compact JSON, so it costs zero model tokens and is testable. The model-facing skills (`SKILL.md`) hold only the procedure and the judgment calls, and refer to scripts and `references/` for detail. Vendor facts live in one registry, never in code or prompts.

## Layout
```text
.claude-plugin/marketplace.json        marketplace "czekanskyy-tools" -> the plugin below
plugins/orchestrator/
  .claude-plugin/plugin.json           manifest (version is the release version)
  models.yaml                          registry: families, plans (limits, data policy), models, efforts, pools, tested EGM plugin
  routing.md                           routing matrices and the triage / split rubrics (parsed by scripts)
  skills/                              orchestrate, configure, doctor, update, init, auto  (SKILL.md procedures)
  agents/                              orch-* workers, prompt-creator, egm-elephant
  templates/                           assignment, status, brief, review, split, plan, report
  references/                          sourced research and design notes (anthropic, openai-codex, xai-grok, google-gemini, egm, ...)
  scripts/                             CLIs and the selftests
    lib/                               shared libraries (common, config, privacy, render, egm, auto-*, ...)
global/CLAUDE.md                       optional global instruction for the main session
docs/                                  this documentation
```

## Data flow of a normal run
1. `registry.mjs preflight` merges `models.yaml`, the user's `config.yaml` and the repo profile, and reports warnings.
2. `triage.mjs` classifies the request (simple, complex, huge) and proposes sensitivity and criticality from word and glob signals. `run.mjs init` opens the run directory and ledger.
3. Complex: the `prompt-creator` agent writes `prompt.md`; `run.mjs save-prompt` lints it. Huge: split into `part-N.md`.
4. `egm-gate.mjs` decides `continue | ask | egm | unavailable | stop` from the rubric, the setting and the consent. Only `egm` leads to the EGM runbook (`references/egm-flow.md`).
5. `registry.mjs route` takes a task list and returns, per task, a model, effort and cross-review, after the privacy filter, the role-bounded tier, the effort matrix and live pool balance.
6. `run.mjs assign` renders the assignment table and the dispatch list. Claude agents are spawned natively; `run-codex.mjs`, `run-grok.mjs` and `run-gemini.mjs` wrap the other CLIs behind one JSON contract (`lib/adapter.mjs`, `references/cli-contracts.md`).
7. The runner agent executes the verification commands; `registry.mjs escalate` decides what a failure means; `run.mjs report` renders the final report from the ledger.

## Key modules
| Module | Responsibility |
|---|---|
| `lib/common.mjs` | registry and config loading, overlay, pool status, process helpers, sanitized environment |
| `lib/config.mjs` | `config.yaml` schema, validation, secret rejection, atomic writes |
| `lib/privacy.mjs` | effective sensitivity, family allowance, glob matching |
| `registry.mjs` | `candidates()`, `route()`, `escalate`, `preflight`, `update` diff |
| `lib/render.mjs` | tables (breakdown, assignment, status), role labels, per-task report, final report |
| `lib/egm.mjs`, `egm-gate.mjs`, `egm.mjs` | locate and fingerprint the EGM plugin, the `critical` rubric, cost estimate, briefs, phase state |
| `lib/auto-*.mjs`, `auto.mjs`, `auto-supervisor.mjs` | the unattended engine: contract, core (git guard, state), limits, decisions, worker, report, EGM phases |
| `lib/repo-*.mjs`, `init.mjs`, `repo-scan.mjs` | the per-repo profile |
| `doctor.mjs`, `update.mjs`, `configure.mjs`, `usage.mjs` | health, registry maintenance, setup, usage and pool readouts |
| `hygiene.mjs` | release scan: personal paths, e-mails, key-like strings |

## Invariants worth protecting
- A sensitive task never reaches a family whose policy is not `sensitive_ok`; the router and every adapter check independently, and unknown means no.
- Workers never commit, push or switch branches. Push needs an explicit user yes. The unattended engine's git wrapper refuses push, fetch, pull, clone, remote and config.
- `config.yaml` is written only by `configure`, atomically, and never holds secrets. `update` never touches it, nor repo profiles.
- EGM starts only with `--egm`, an explicit yes, or an unattended contract's pre-consent; a missing plugin degrades to the normal flow.
- The orchestrator reads EGM's own skills and personas at run time instead of copying them.
- User-facing text is Polish; scripts, files, code and comments are English.
- State lives under `~/.claude/orchestrator/` (or `ORCH_HOME`), never inside the plugin or a repo.

## Tests
`node plugins/orchestrator/scripts/selftest.mjs [scenario|all]` runs everything with fakes: temporary git repos, a simulated clock, mock CLIs and a fake EGM plugin tree (`ORCH_EGM_DIR`). It makes no model calls and touches none of your state (`ORCH_HOME` points to a temp directory). Scenario names are listed in the file header. `scripts/auto-smoke.mjs` is an optional end-to-end smoke of the unattended mode.

## Extension points
- **A new model family:** add it to `models.yaml` (CLI, plans with data policy, models, efforts), add an adapter next to `run-gemini.mjs` that honors the JSON contract and privacy gate, add research notes under `references/`, and extend the selftests and `doctor`.
- **A new plan or model:** registry only, with a source URL and a check date; `/orchestrator:update` is the normal path.
- **Notification channels, repo-rule detectors, rubric categories:** see the corresponding library; each has fixtures under `scripts/fixtures/`.
