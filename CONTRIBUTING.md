# Contributing

Thanks for helping. This project routes work and data between model vendors, so the bar for changes that touch routing, privacy or permissions is deliberately high. Everything else is easy: small, tested, sourced.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Getting started
```bash
git clone https://github.com/czekanskyy/claude-orchestrator
cd claude-orchestrator
node plugins/orchestrator/scripts/selftest.mjs        # everything, zero model calls (a few minutes)
node plugins/orchestrator/scripts/selftest.mjs egm    # one scenario
node plugins/orchestrator/scripts/hygiene.mjs         # personal paths, e-mails, key-like strings
```
The selftests use temporary git repos, a simulated clock, mock CLIs and a fake EGM plugin tree. They never call a model and never touch `~/.claude/orchestrator` (they point `ORCH_HOME` at a temp directory). Node is the only requirement; there is no build step and no dependency to install.

To try your checkout inside Claude Code, add it as a local marketplace: `claude plugin marketplace add <path-to-your-clone>`, install `orchestrator@czekanskyy-tools`, then run `/orchestrator:doctor`.

Read [docs/architecture.md](docs/architecture.md) first; it lists the invariants you must not break.

## Ground rules
- **Skills decide, scripts compute.** Put deterministic logic in a script with a JSON contract and a selftest; keep `SKILL.md` files short. `orchestrate/SKILL.md` has a size cap enforced by a selftest on purpose.
- **Zero dependencies.** Plain Node ES modules.
- **Match the surrounding code:** naming, comment density, idiom. Comments say why, not what.
- **English** for code, comments, docs, commit messages and script output. User-facing strings (tables, questions, reports) are currently Polish; a localization layer would be a welcome, separately discussed change.
- **No personal data in the repo:** no user paths, e-mails, tokens, account identifiers or real run logs. `hygiene.mjs` must be clean (and a selftest runs it).
- **Never weaken a floor** without a discussion first: sensitive data only to `sensitive_ok` families (fail closed), push needs an explicit yes, workers never commit, EGM and unattended runs need consent, `config.yaml` holds no secrets.

## Changing code
1. Open an issue first for anything beyond a small fix, so the approach can be agreed.
2. Add or adjust selftests with the change: a failing test first when fixing a bug.
3. Run the full selftest and the hygiene scan before pushing.
4. Update the docs the change touches (README, `references/`, the relevant `SKILL.md`) and add a line to [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.
5. Keep commits focused. Describe the why in the message.

## Changing the registry (`models.yaml`)
Vendor facts must be sourced and dated: a URL, the date checked, and a confidence level when the source is weak. Prefer `/orchestrator:update` or `doctor --live` evidence over memory. A model not yet confirmed to answer through its CLI is `unverified`. A changed data policy needs a primary source (the vendor's own terms or help page), because it decides what may leave a machine.

## Adding a model family
See *Extension points* in [docs/architecture.md](docs/architecture.md). In short: registry entry with plans and data policies, an adapter honoring the shared JSON contract and privacy gate, research notes with sources, selftests and `doctor` rows.

## Pull requests
Use the template. Include what changed and why, how you tested it, and any privacy or permission impact. Small PRs get reviewed faster.

## Releasing (maintainers)
1. Selftest and hygiene clean on `main`.
2. Bump `version` in `plugins/orchestrator/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`; move the *Unreleased* changelog entries under the new version and date.
3. Commit, tag `vX.Y.Z`, push the commit and the tag.
4. In a clean directory: clone, run the selftest, `claude plugin validate` the plugin and the marketplace.
