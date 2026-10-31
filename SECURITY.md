# Security policy

## Supported versions
Only the latest release (the newest `v3.x` tag on `main`) receives fixes.

## Reporting a vulnerability
Please do **not** open a public issue. Use GitHub's private reporting: **Security → Report a vulnerability** on <https://github.com/czekanskyy/claude-orchestrator/security/advisories/new>. Include the version (`plugin.json`), what you did, what you expected, and what happened. Do not include real credentials, customer data or private repository contents; redact them.

You can expect an acknowledgement within a few days. Fixes are released as a patch version with a note in the [changelog](CHANGELOG.md).

## What counts as a vulnerability here
This project drives other tools (Claude Code, Codex, Grok Build, Antigravity) and passes prompts and code between model families, so the interesting failures are about *what leaves the machine* and *what a worker may do*:

- **Privacy-filter bypass:** a task marked `sensitive` reaching a model family whose `sensitive_ok` is false (routing, adapters, cross-family review, EGM cross-family Goldfish, autonomous reroutes).
- **Secret exposure:** a secret file or value being read, logged, stored in `config.yaml`, the run ledger, a brief or a report.
- **Sandbox or permission escape:** a worker committing, pushing, switching branches, running commands outside its allowlist, or an autonomous run touching the user's checkout beyond `git worktree add` and an explicitly confirmed merge.
- **Prompt injection that changes behavior:** content read from a file, web page or tool output being followed as an instruction.
- **Unsafe defaults** in the files the plugin writes (`config.yaml`, repo profiles, run directories).

Bugs that only make a run fail, wait or produce a worse plan are ordinary issues.

## Design floors you can rely on
Sensitive data only goes to families that do not train on it (fail closed); push always needs an explicit yes; workers never commit; the user's `config.yaml` stores no secrets and rejects secret-looking keys and values; EGM and autonomous runs never start without consent. Details: [docs/privacy.md](docs/privacy.md).
