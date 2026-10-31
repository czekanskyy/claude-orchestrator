---
name: init
description: One-time, user-triggered setup of the orchestrator for the CURRENT repository (/orchestrator:init): investigates the repo (git state, commit and branch conventions, stack and real commands, docs and policies, other orchestrators, sensitivity signals), interviews the user where the repo's own rules and the orchestrator's defaults conflict, and stores a compact profile so the orchestrator works in this repo without friction. For a non-empty repo; `--refresh` re-derives a stale profile, `--show` prints it, `--dry-run` prints the proposal and writes nothing.
argument-hint: "[--refresh] [--show] [--dry-run]"
disable-model-invocation: true
---

# Orchestrator init

User-triggered only. Scripts: `node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" <cmd>`, run from the repo root. Everything the user reads is **Polish**; files, code and comments English. Never read secret files (the scan lists names only), never commit or stage, never touch other repos. Full description, schema and precedence: `${CLAUDE_PLUGIN_ROOT}/references/repo-init.md`.

## Flow
1. `--show` → `init.mjs show`, print it, stop. `--dry-run` → `init.mjs dry-run`, print it, stop (writes nothing).
2. `init.mjs plan [--refresh]` (≈3 s, zero tokens, one compact JSON line). `state`:
   - `empty` → say its `message` in one line, stop.
   - `exists` → print `summary`, offer `--refresh` or `--show` in one line, stop. Never re-run on your own.
   - `ready` → continue.
3. Read `scan` (one compact JSON). Open only headings/sections of docs it points to, and only when a question needs it: never whole trees, never `docs/prd`-like bulk, never a secret file. Where `questions[].options` quote a raw doc sentence, you may rewrite a repo-derived list (docs duties, definition of done) into ≤ 5 short imperative lines; pass it as `_repo.<id>` in the answers.
4. Interview: AskUserQuestion with the `questions` exactly as given (they are Polish, recommendation first), ≤ 4 per call, in the order of `rounds` (≤ 3 rounds). Do not ask anything in `skipped` and invent no questions. Free text ("Other") becomes `{"choice":"custom","value":…}`.
5. Answers file (scratch, outside the repo): `{"<id>":"repo"|"default"|"merge"|{"choice":"custom","value":…},"_repo":{"<id>":…}}`; use each chosen option's `choice` (and `value`). Print `init.mjs apply --answers <f> --dry-run` result as a short Polish summary, then ask `share_question` as its own AskUserQuestion (local only vs also `<repo>/.claude/orchestrator.yaml`).
6. `init.mjs apply --answers <f> [--share]`. Report in Polish: where the profile is stored, what was decided (one line per decision), what the preflight will do from now on, and that nothing was committed (a repo-side file, if written, is for the user to review and commit).

Precedence from then on: profile decision > the repo's own rules > orchestrator defaults; push always needs an explicit yes.
