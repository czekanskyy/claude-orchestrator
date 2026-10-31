# Privacy model

The orchestrator moves prompts, code and diffs between model vendors on your behalf. This page says what leaves your machine, what the plugin itself stores, and how "this data may not go to that vendor" is enforced.

## What the plugin does and does not do
- **No telemetry, no service.** The plugin has no server and sends nothing to the maintainer. Its scripts make no network calls except one `HEAD` request to `https://api.anthropic.com` that the unattended supervisor uses as a zero-token connectivity probe while waiting out a usage limit.
- **Your data goes only where you configured it.** Work is sent to a vendor only through that vendor's own CLI or the Claude Code `Agent` tool, under the login you set up there: Claude (native subagents), GPT (`codex`), Grok (`grok`), Gemini (`agy`). The vendor's terms for your plan then apply.
- **No credentials are handled.** Logins stay in each vendor's CLI. `configure` and `doctor` run only the CLIs' own status commands and read no token files. `config.yaml` rejects secret-looking keys and values.

## What is stored, and where
| Path | Contents | Leaves the machine? |
|---|---|---|
| `~/.claude/orchestrator/config.yaml` | families, plan ids, privacy choices, defaults | no |
| `~/.claude/orchestrator/repos/` | per-repo profiles (conventions, commands, critical paths) | no |
| `~/.claude/orchestrator/runs/<run>/` | ledger, plan, route, briefs, prompt, report of a run | no |
| `~/.claude/orchestrator/auto/<id>/` | contract, journal, decisions, limits log, report of an unattended run, plus its git worktree | no |
| `~/.claude/orchestrator/usage.jsonl`, `pools/` | model, effort, task type, result, token counts, pool snapshots | no |
| `<repo>/.claude/orchestrator.yaml` | optional shareable repo profile block (written only if you answer yes) | only if you commit it |

Briefs and run directories can contain excerpts of your code and your task text. They stay local, but treat them as sensitive when you share a bug report: see [reporting-issues.md](reporting-issues.md). Set `ORCH_HOME` to relocate the state directory.

## Sensitivity and data policy
Every task has a **sensitivity**:

| Value | Meaning | Where it may go |
|---|---|---|
| `none` | public or throwaway | any enabled family |
| `internal` | ordinary private code | any enabled family |
| `sensitive` | credentials, customer or personal data, production configuration, regulated data | only families whose plan has `sensitive_ok: true` |

Triage proposes the value from deterministic signals (words, file globs); globs in your repo profile escalate it; the repo's default sensitivity is the baseline; you can raise it at any time.

Every family and plan in `models.yaml` carries a **data policy**: `training_on_data` (`true`, `false`, `user_setting`, `unknown`), `sensitive_ok`, a source URL and the date it was checked. As shipped:
- consumer plans where training is on by default or a user setting are `sensitive_ok: false`;
- business and enterprise plans that exclude training by default are `sensitive_ok: true`;
- anything unknown, or an unrecognized plan id, is **not allowed**.

During `/orchestrator:configure` you can follow the catalog, allow sensitive data for a family you have opted out of training for, or never allow it. Your choice overrides the catalog and is stored in `config.yaml`.

## Enforcement
1. **Router:** a hard filter on authors, reviewers, fallbacks, escalations and reroutes. A sensitive task has no route to a disallowed family, whatever the pool situation.
2. **Adapters:** `run-codex`, `run-grok` and `run-gemini` re-check the task's sensitivity and every `--file` they are given (`privacy_blocked`). This is a second, independent gate.
3. **Cross-review gap:** if no other family may see sensitive data, the review is reported as a `cross_review_gap`, never silently sent to a disallowed family.
4. **Secrets:** briefs are scanned for key-like strings and private keys and refused on a hit (`secret_detected`). External CLIs start with `KEY`, `TOKEN`, `SECRET`, `PASSWORD` and `AUTH` variables stripped from their environment. Grok runs with deny rules for `.env*`, key files and `~/.ssh`. Workers never commit or push.
5. **Fail closed:** missing or unreadable policy data means "not allowed".
6. **EGM and unattended runs** inherit all of the above. EGM's cross-family Goldfish are chosen by the same privacy filter, and neither mode starts without consent (see below).

## Consent
- **Push** always needs an explicit yes.
- **EGM mode** starts only with `--egm`, an explicit "run" answer to the gate's question, or the pre-consent field in an unattended contract.
- **Unattended runs** need a start contract and an explicit GO; they never push, never touch your checkout beyond `git worktree add`, and never switch accounts or use overage.
- **Registry updates** are applied only after you approve a sourced diff.

## Known gaps
- Gemini through `agy` has no deny rules for secret files; its barrier is the privacy gate and the brief scan.
- On Windows the Grok kernel sandbox is not enforced and the Codex sandbox is unverified; `read-only` does not hide `.env` from reads. The adapters warn when a `.env` sits in the working directory and the brief forbids reading it, but the real protection is not putting secrets where a worker can read them.
- Data-policy entries are as accurate as their sources. Several are marked low confidence (forum reports, unretrievable vendor pages). `/orchestrator:update` re-checks them; verify against your own contract before allowing sensitive data.
- Anything a vendor CLI itself does (its own telemetry, logging, retention) is governed by that vendor, not by this plugin.

Security issues: [SECURITY.md](../SECURITY.md).
