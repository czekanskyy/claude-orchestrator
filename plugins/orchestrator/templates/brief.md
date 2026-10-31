Goal: {{one sentence: what changes for the user or the code}}
Context: {{only the needed facts; point to repo docs by path (CLAUDE.md, AGENTS.md, a map/decisions file) instead of pasting them}}
Scope: you may edit only {{files or folders}}. Read anything else you need, except secrets and generated/lock files.
Constraints: follow the repo's CLAUDE.md / AGENTS.md. Do not commit, push, switch branches or install dependencies.
  Do not read or print secrets (.env, keys, credentials). Allowed commands: {{the profile verify commands, else e.g. npm test, npx tsc --noEmit}}. {{task-specific rules}}
Done when: {{observable criteria + the checks that must pass + the profile docs duties and definition of done, when set}}
Report, in 15 lines or fewer:
  implement/debug: files changed (one line each), checks run and results, anything unresolved (debug: cause + evidence first).
  review: verdict APPROVE | FIX | BLOCK, then findings as file:line · severity · one sentence with the concrete failure.
  research: answer, sources with date, confidence.
