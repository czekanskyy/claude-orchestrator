# Changelog

Release history of the plugin. The registry-level log (model, limit and policy changes, with sources) is [`plugins/orchestrator/CHANGELOG.md`](plugins/orchestrator/CHANGELOG.md); `/orchestrator:update` appends to it.

Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

## 3.1.0 (2026-11-02): detached workers and live progress
### Changed
- **External workers (Codex, Grok, Gemini) run as detached jobs.** The orchestrator no longer blocks on a worker for up to an hour without a word: `--detach` returns at once, `job.mjs wait` reports progress (for Codex the plugin's own job status: commands, edits, phase) every few minutes, and a slow worker is judged by its diff instead of being killed and restarted. Budget 25 min (implement) / 10 min, hard kill at twice that.
- **The plan table is shown right after planning**, also for a single package (`run.mjs plan` prints it), instead of only inside the next wave's output.
- **Less overhead:** triage `spec_needed` lets concrete requests skip the spec round; one verification pass per wave; low/med-risk reviews batched; the next wave starts as soon as its dependencies are verified.
- Role labels for agents and per-task report blocks (from the unreleased 2026-11-01 work) ship in this version.

## 3.0.0 (2026-10-31): first public release
The first tagged release. It consolidates the private development iterations (internally numbered 3.0 to 3.2) into one version.

### Added
- **Multi-family orchestration:** Claude subagents plus GPT (Codex CLI), Grok (Grok Build CLI) and Gemini (Antigravity CLI), routed per subtask to a model and an effort level from a sourced registry, balanced across the 5-hour and weekly pools of your plans.
- **Privacy model:** per-task sensitivity, per-plan data policy, a router filter plus a second gate in every adapter, brief secret scanning, sanitized worker environments, fail-closed defaults. See [docs/privacy.md](docs/privacy.md).
- **Workflow:** deterministic triage into simple, complex and huge; the `prompt-creator` agent for complex requests; splitting of huge ones; silence policy; deterministic personas; low-context, low-trust cross-family review; escalation ladder; compact final report.
- **Commands:** `/orchestrator:orchestrate`, `configure`, `doctor` (offline, `--live`), `update`, `init` (per-repo profile with `--refresh`, `--show`, `--dry-run`) and `auto` (unattended runs).
- **`/orchestrator:auto`:** start contract and explicit GO, external supervisor with watchdog and keep-awake, isolated worktree on `auto/<id>` with checkpoint commits, exact limit tracking for Claude, Codex and Gemini and estimates for Grok, waiting through limits, decision log with undo, morning review, takeover. Never pushes.
- **EGM mode (optional, consent-gated):** the Elephant-Goldfish Model of Google's open-source `egm` plugin for critical tasks, driven from the installed plugin rather than reimplemented. A `critical` rubric and cost estimate, an `egm_gate` that asks (run EGM, normal flow, cancel), the `--egm` flag, the `egm: ask|off` setting, Goldfish review stages, resolve, implementation by routed workers, a Goldfish drift check and an `EGM` section in the report. Unattended runs use it only with contract pre-consent. Graceful degradation when the plugin is absent; `doctor` and `update` check the plugin version and drift.
- **Repository hygiene:** MIT license, security policy, code of conduct, contributing guide, issue and pull request templates, `scripts/hygiene.mjs` release scan.
- **Tests:** a zero-model-call selftest suite (temporary repos, simulated clock, mock CLIs, fake EGM plugin).

### Changed
- Packaged as one plugin (`orchestrator`) in the marketplace `czekanskyy-tools`; replaces the earlier private agent set. A backup of the previous user state is kept in `~/.claude/orchestrator/backup-v2-<date>` by `scripts/migrate.mjs`.
- Documentation is English throughout. User-facing runtime text (tables, questions, reports) is Polish for now.

### Upgrade notes
- Run `/orchestrator:configure`, then `/orchestrator:doctor`. Existing pool ids and usage history carry over.
- `/orchestrator:update` never modifies `config.yaml` or repo profiles.
- Optional: install the EGM plugin (`claude plugin marketplace add google/elephant-goldfish-model && claude plugin install egm@egm`).
