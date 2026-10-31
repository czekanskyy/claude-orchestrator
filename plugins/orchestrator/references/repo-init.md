# Repo init: `/orchestrator:init`

One-time, user-triggered, per-repository setup for an existing, non-empty repo. It investigates the repo, interviews the user only where the repo's own rules and the orchestrator's defaults conflict or are ambiguous, and stores a compact **profile**. From then on preflight loads a few rule lines (never the source docs) and the workflow acts on them. Priorities: code quality first, token use sensibly minimized.

## Trigger and states
| situation | behavior |
|---|---|
| user runs `/orchestrator:init` (the skill has `disable-model-invocation: true`; the model never starts it) | scan → interview → profile |
| empty repo (no commits and only boilerplate files) | one line, exit |
| profile exists | summary plus an offer of `--refresh` / `--show`; never re-runs on its own |
| `--refresh` | re-scan; only decisions whose repo evidence changed (or are new) are asked again, the rest keep their answers |
| `--show` | stored profile as a Polish summary with freshness |
| `--dry-run` | the proposed profile, the questions and the consequences; writes nothing |
| preflight meets a non-empty repo without a profile | one warning line suggesting `/orchestrator:init`, then conservative defaults where the repo's own rules win |

## Investigation: `scripts/repo-scan.mjs`
One deterministic, read-only, dependency-free script (Windows and POSIX) prints ONE compact JSON (≈ 10 KB for a repo with ~50 policy docs). The model reads that plus only the headings/sections of docs it points to; never whole trees. It never writes (git runs with `--no-optional-locks`, so `status` does not even refresh the index), never walks `node_modules`, and never opens a secret file: every content read goes through one guarded reader that refuses paths matching `meta.sensitive_globs` and the built-in secret patterns, so secret files are reported by **name and tracked-in-git flag only**.

| section | what is verified, not assumed |
|---|---|
| `repo` | default branch (`origin/HEAD`, else `init.defaultBranch`, else first existing of main/master/trunk/develop; marked `verified`), current branch, dirty tree (counts), remotes (credentials stripped), commit count |
| `commits`, `branches` | style from a 60-commit sample (conventional / bracket-tag / ticket / gitmoji / plain, with a confidence), language, merge and PR-merge share, AI trailers in history; branch name patterns with counts |
| `stack` | package manager (lockfile or `packageManager`), test / typecheck / lint / build / dev from manifests, Makefile, pyproject, go/cargo/mvn/gradle/dotnet; each command carries its `source`; commands cited in docs are checked against the manifest (`verified: true/false/null`) |
| `docs` | README, CONTRIBUTING, CLAUDE.md, AGENTS.md, architecture/conventions/decision docs, ADRs, runbooks, changelog, PR template: path, kind, size, key headings; the most prescriptive sentences per topic (commit, push, authorship, branch, protected, docs duty, done, privacy) as `[tags] file:line text`; whether history really touches the changelog / `docs/` |
| `policies` | `.claude/settings.json` git permissions and attribution, CI workflows (verification commands, branch filters), hooks (husky, lefthook, pre-commit, git hooks), CODEOWNERS, PR-template checklist, and `hints` (commit/push rule per docs and per settings, "no AI attribution", docs-named base branch, protected branches, "no PRs from the orchestrator") |
| `orchestrators` | repo-level orchestrator skills/commands (the existing `projectOrchestrators`), agents, skills, orchestration docs, other tools' rule files (`.cursor`, Copilot, aider, `.codex` …) |
| `sensitivity` | secret-like files (name, tracked?), env templates, personal-data directories, data files; existence and paths only |
| `critical_paths` | auth/accounts/sessions/payments/migrations/secrets directories and files, infra/deploy, CI, schema |
| `conflicts` | docs vs git default (base branch), docs vs `settings.json` (commit/push), docs citing commands that do not exist, tracked secret files, own orchestrator, dirty tree |
| `fingerprint` | content hashes of the policy docs the profile is derived from |

`--full` also prints the per-file fingerprint map; `--pretty` indents.

## Interview
`init.mjs plan` returns Polish questions built from the scan: one per real decision, "repo rule vs orchestrator default vs merge", recommendation first (the repo's rule is the default recommendation). A decision is **not asked** when the repo is silent, when its rule equals the default, or (on `--refresh`) when its evidence did not change. At most 4 questions per AskUserQuestion call and 3 rounds. "Merge" is offered only when it settles differently from "repo wins".

| id | decision | repo-derived value | orchestrator default |
|---|---|---|---|
| `orchestrator` | which orchestrator drives this repo (asked only if the repo ships its own) | `project` | `global` (merge = `ask`) |
| `commit` | who commits, format, attribution; push is never decided here beyond `ask`/`never` | policy from docs/settings, format from history, `attribution: none` from docs/settings | orchestrator commits at checkpoints, `attribution: default`, `push: ask` |
| `branching` | base, naming pattern, protected branches, PRs | docs-named base (verified to exist), history patterns, "never commit to X", "no PRs" | work on the current branch, PRs only on request |
| `docs_duties` | duties added to EVERY task's done criteria | imperative doc sentences + changelog/docs touched in recent history | none |
| `verify` | verification commands and definition of done | CI commands (else docs-cited, verified), `done` sentences, PR checklist | every detected manifest command |
| `critical_paths` | globs that force `risk: high` and the security-lens review | detected globs | none (triage keywords only) |
| `sensitivity` | per-repo data sensitivity default (and therefore which families may see tasks by default) + extra sensitive paths | `sensitive` only on strong evidence (tracked secret, personal-data dirs, data files), else `internal` | the user's global default |
| `egm` | `ask` / `off` for the `egm_gate` (asked only when critical paths exist) | n/a | `ask` |

The model may refine a repo-derived **list** (docs duties, definition of done) into short imperative lines from the doc sections it read and pass it as `_repo.<id>` in the answers; the user's choice then applies to that refined value.

## Precedence
1. The user's explicit request in the current turn.
2. **Profile decision** (settled by the user in init; the local profile beats the shared block per decision).
3. **The repo's own rules** (docs, settings): in force without a profile, and for anything the profile does not decide.
4. **Orchestrator defaults** (this plugin).

Fixed floors nothing overrides: sensitive data never goes to a family without `sensitive_ok` (the profile sets only the repo's default sensitivity, never a family's policy); push needs an explicit yes (`commit.push: never` forbids it outright); workers never commit, push or switch branches; no secret is read. A profile that arrives only through the repo's own file (`shared`) may tighten privacy, never loosen it.

How an answer settles a decision (`settle` in `lib/repo-profile.mjs`): `repo` = the repo's defined fields win, silence falls back to the default; `default` = the orchestrator default; `merge` = the stricter value of an ordered field, the union of lists, the repo's value otherwise; `custom` = the user's own value. Orders, weakest first: `commit.policy` orchestrator < ask < forbidden; `commit.push` ask < never; `commit.attribution` default < none; `branching.action` current_branch < follow_repo < ask; `branching.pr` ask < never; `sensitivity.default` none < internal < sensitive; `egm` off < ask.

## Storage
- **User-local (default):** `~/.claude/orchestrator/repos/<name>-<hash>.yaml`, keyed by repo identity: the `origin` remote normalized to `host/owner/repo` (credentials stripped; `git@h:o/r.git` and `https://h/o/r.git` match), else the normalized path. `aliases` hold the other identities, so the same repo matches on another machine (copy the file or use the shared block) and after a remote is added. v2 data is untouched: `projects.yaml` stays as it was and still carries `orchestrator: global|project|ask` and `claude_pool`; init writes only the orchestrator choice there, and only when the repo ships its own orchestrator.
- **Shareable (separate explicit question):** the `repo_profile:` block of `<repo>/.claude/orchestrator.yaml` with `commit`, `branching`, `docs_duties`, `verify`, `critical_paths`, `sensitivity` and the fingerprint (not the orchestrator choice or EGM, which are personal). Only that block is replaced; other lines of the file stay byte for byte. Init never creates or modifies any other repo file and never commits or stages.
- Atomic writes, previous file kept as `.bak`, schema validation (unknown keys, enums, secret-like keys or values are refused).

```yaml
schema_version: 1
identity: "github.com/owner/repo"
aliases: ["c:/users/me/dev/repo"]
updated: "2026-10-31"
fingerprint: { hash: "…", sources: { "CLAUDE.md": "<hash12>", … } }
decisions:
  orchestrator: "project"            # global | project | ask
  commit: { policy: "orchestrator", granularity: "checkpoint", attribution: "none", push: "ask", format: "[<TAG>] <summary>" }
  branching: { action: "follow_repo", base: "test", pattern: "eNN/<topic>", protected: ["main", "test"], pr: "never" }
  docs_duties: ["Add new files to docs/map/<domain>.md"]
  verify: { test: "pnpm test", typecheck: "pnpm typecheck", lint: "pnpm lint", build: "pnpm build", extra: ["pnpm check:docs"], done_when: ["…"] }
  critical_paths: ["src/migrations/**", ".github/workflows/**"]
  sensitivity: { default: "internal", globs: [] }
  egm: "ask"                         # ask | off
choices: { commit: "repo", … }       # how each decision was settled (repo | default | merge | custom | auto:*)
evidence: { commit: "<hash8>", … }   # hash of the repo-derived value each decision rested on (refresh asks again only when it changes)
```

## Staleness
The fingerprint hashes the policy-bearing files the profile was derived from (rule files, CONTRIBUTING, PR template, CI workflows, `.claude/settings.json`, policy-named docs and skills, `package.json` scripts, Makefile; at most 60). Preflight and doctor recompute it from directory listings plus those files (no tree walk): changed, removed and newly added policy docs make the profile `stale` → `/orchestrator:init --refresh`. The changelog is not part of it.

## Consumption
| profile field | effect |
|---|---|
| `orchestrator` | written to `projects.yaml`; the existing preflight switch (`global` / `project` / `ask`) applies it |
| `commit` | `policy: forbidden` → the orchestrator does not commit, the final report says so; `ask` → only after a yes; `format` and `attribution: none` (no AI/tool lines or trailers) apply to every commit; push needs an explicit yes |
| `docs_duties`, `verify.done_when` | added to every brief's "Done when" and to the definition of done |
| `verify` | the runner's check list and the briefs' "Allowed commands" |
| `critical_paths` | triage flags a request naming such a path (`critical`, `risk_hint: high`); the router raises any task whose `files` hit one to `risk: high` (security-lens review follows) |
| `sensitivity` | the repo's default sensitivity: triage's baseline and the router's default; extra globs join `meta.sensitive_globs` → privacy filter |
| `egm` | passed to `egm_gate` (`setting`), which is still a placeholder |
| `branching` | rule lines in the preflight block (base, pattern, protected branches, PR policy) |

## Health
`/orchestrator:doctor` (offline) has a `repo profile` row for the current repo: missing (warning), ok, stale (warning, with the changed docs) or invalid (error), and a `repo profile vs config` row for conflicts with the global setup (sensitivity `sensitive` with no `sensitive_ok` family, an orchestrator choice the repo no longer supports, a drifted `projects.yaml` preference).

## Scripts
`scripts/repo-scan.mjs` (scan), `scripts/init.mjs` (`plan`, `dry-run`, `apply`, `show`, `status`, `rules`), `scripts/lib/repo-facts.mjs` (git, identity, guarded io, policy-doc discovery, fingerprint), `scripts/lib/repo-profile.mjs` (profile, precedence, storage, rules), `scripts/lib/repo-questions.mjs` (proposal and Polish questions). Tests: `selftest.mjs init`.
