# Safety rules (enforced by the adapters + SKILL)

| rule | how it's enforced |
|---|---|
| No "full access without approval" mode | codex: only `read-only` / `workspace-write`; `--yolo` / `danger-full-access` never appear in code. grok: `--permission-mode dontAsk` (deny by default), never `--always-approve` / `bypassPermissions` |
| review/research = read-only | codex `-s read-only` (plugin: no `--write`). grok: `--tools read_file,grep,list_dir[,web_*]` + `--disallowed-tools run_terminal_cmd,search_replace,write,Agent` |
| implement = writes only to the repo | codex `workspace-write` (cwd = repo). grok: `--allow Edit(**)`/`Write(**)` (globs anchored to `--cwd`), shell only through `--allow-cmd` |
| No secrets sent to external models | brief scan (`scanSecrets`) → `secret_detected`. The CLI env has variables with KEY/TOKEN/SECRET/PASSWORD/AUTH removed (including `XAI_API_KEY`, so it never bills the API). grok: `--deny Read/Grep/Edit(**/.env*)`, keys, `~/.ssh`, `~/.codex`, `~/.grok/auth.json`, `Bash(*.env*)`, `printenv` |
| max/ultra effort, approval-only models | `approval_required` without `--approved`. The SKILL forbids passing `--approved` without the user's "yes" |
| Sensitive data stays with families allowed to see it | task `sensitivity` + `data_policy.sensitive_ok`: router hard filter (author, reviewer, fallback, escalation) and a second gate in every adapter (`privacy_blocked`); unknown policy = not allowed; sensitive globs escalate a task automatically |
| No secrets in config | `config.yaml` schema rejects secret-like keys and values; logins stay in each vendor CLI; `doctor`/`configure` read no token files (Claude plan: organization metadata only) |
| User config is never overwritten by update | `/orchestrator:update` edits `models.yaml`/CHANGELOG only, after approval; `config.yaml` writes only through `configure` (atomic, `.bak`) |
| Limits | pool ≥85% → lowest effort + approval; limit message → cooldown; cooldown → the adapter refuses and returns `fallback_hint` |

## Known gaps
- Gemini (`agy`) has no deny rules for secret files; its barrier is the privacy gate and the brief scan.

## Known gaps (Windows)
- The Grok kernel sandbox does not work on Windows (Linux Landlock / macOS Seatbelt only). The barrier is the permission layer (dontAsk + allowlists + deny rules).
- The Codex sandbox on Windows is not verified; `read-only` does not hide `.env` from reads. The adapter warns when `.env` sits in cwd and the brief forbids reading it.
- The Codex plugin passes the environment through to the app-server; the adapter starts it with a sanitized env.
