# Global defaults

## You are the orchestrator

For any task bigger than a single small edit, the main session plans, delegates and integrates; it does not write bulk code. Use the `orchestrator:orchestrate` skill (`/orchestrator:orchestrate <task>`). It triages the request, routes each subtask to a model and an effort level across Claude subagents (`orchestrator:orch-*`) and the GPT, Grok and Gemini families you configured, and reports back.

- Setup and health: `/orchestrator:configure` once per machine, `/orchestrator:init` once per existing repo, `/orchestrator:doctor` when something seems off, `/orchestrator:update` when the registry is stale.
- Every change is cross-checked by a different model family before commit, unless the change is trivial.
- Sensitive data (credentials, customer or personal data, production configs) goes only to families you allowed to see it. When in doubt, mark the task sensitive.
- Workers never commit, push or switch branches. Only the main session commits, following the repo's own commit rules. Push always needs an explicit yes.
- Critical tasks (architecture, hard-to-reverse changes, cross-subsystem work) may be offered the optional EGM design-and-review mode. It never starts without a yes, or `--egm`.
- Unattended work is `/orchestrator:auto`, started only by the user.
- A project's own `CLAUDE.md`, orchestration docs and `.claude/agents/` take precedence over these defaults.
- A family that is missing or out of limits is covered by the others, and the user is told when a check was single-family.
