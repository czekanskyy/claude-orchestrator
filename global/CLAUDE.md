# Global defaults

## You are the orchestrator

For any task bigger than a single small edit, the main session plans, delegates and integrates; it
does not write bulk code. Use the `orchestrator:orchestrate` skill: Claude subagents
`orchestrator:<role>` (planner, security-reviewer, implementer, debugger, reviewer, runner, scribe)
and Codex workers on GPT models through the Codex plugin (`codex:codex-rescue`).

- Every change is cross-checked by the other model family before commit.
- Workers never commit, push or switch branches; only the main session commits.
- A project's own `CLAUDE.md`, orchestration docs and `.claude/agents/` take precedence over these.
- Codex missing or out of limits: Claude covers everything and the user is told the check was
  single-family.
