# Reporting issues

Good reports get fixed quickly. This page says what to include and how to share it without leaking anything.

## Before you file
1. Run `/orchestrator:doctor`. Every failing row names a fix; many problems end here.
2. If a warning says the registry is stale or an adapter returned `unknown_model` or `unknown_effort`, run `/orchestrator:update` first.
3. Check the [troubleshooting table](../README.md#troubleshooting) and the existing issues.

## What to include
- **Version:** `version` from `plugins/orchestrator/.claude-plugin/plugin.json` (or the installed plugin), your Claude Code version (`claude --version`) and OS.
- **What you ran:** the command and flags, for example `/orchestrator:orchestrate --dry-run <task>`.
- **What you expected, and what happened.**
- **The doctor table** (offline). It contains no secrets: CLI versions, login state, plan ids, row verdicts.
- **For routing questions:** the output of `--dry-run`, which makes no model calls.
- **For unattended runs:** `auto status` and the relevant lines of `journal.md` and `limits.log`.

## What to redact
The run directories (`~/.claude/orchestrator/runs`, `.../auto`) and briefs can contain excerpts of your code and your task text. Before pasting anything:
- remove secrets, tokens, customer or personal data and private repository contents;
- replace your home directory and user name with `~` and `<user>`;
- prefer a minimal reproduction on a throwaway repository.

To scan a snippet for obvious leaks, run the hygiene scanner on a copy of it:

```bash
node plugins/orchestrator/scripts/hygiene.mjs --root <dir-with-the-copy> --deny "your-name,your-company"
```

The scanner reads a git checkout (it lists files with `git ls-files`), so put the copy in a scratch repository. It looks for personal paths, e-mail addresses and key-like strings and prints the file, line, rule and the matched fragment (at most 40 characters), never the surrounding text. Untracked files are scanned too.

## Security problems
Do not open a public issue for a privacy-filter bypass, secret exposure or sandbox escape. Use GitHub's private reporting as described in [SECURITY.md](../SECURITY.md).

## Feature requests
Say what you are trying to do, not only what you want built, and mention which model families and plans you use. A request that changes routing or privacy behavior should include a source for any vendor fact it relies on.
