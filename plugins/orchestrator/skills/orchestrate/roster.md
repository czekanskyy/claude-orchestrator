# Orchestration: Claude and GPT models on one task

The main Claude Code session is the **orchestrator**. It plans, splits the task into work packages,
hands each package to the cheapest model that can do it well, makes the other model family check the
result, and integrates. It does not write bulk code itself. Call mechanics: `codex.md`.

Three ideas carry the whole design:

1. **Tier by difficulty, not by habit.** Heavy models plan and judge, middle models build, light models
   run and transcribe.
2. **Two families check each other.** Claude's output is reviewed by GPT, GPT's by Claude. Different
   training, different blind spots.
3. **Two plans, two budgets.** Work goes to whichever family spares the scarcer limit and the
   orchestrator's context window.

## The roster

| Tier | Claude (subagent `orchestrator:<role>`) | GPT (Codex worker via the Codex plugin) |
|---|---|---|
| Heavy | **orchestrator** (main session): Opus 5.5, `medium` · `planner`, `security-reviewer`: Opus 5.5, `high` | **GPT-6 Astra** `gpt-6-astra`, `high`: critical second opinions only |
| Middle | `implementer`: Sonnet 5.5, `medium` · `debugger`, `reviewer`: Sonnet 5.5, `high` | **GPT-6.1 Sol** `gpt-6.1-sol`, `medium` to build, `high` to review or diagnose |
| Light | `runner`, `scribe`: Haiku 5.5, `low` | **GPT-6 Luna** `gpt-6-luna`, `low`: bulk mechanical work and extraction |

## Step 1: classify the task

State in one line: **size** and **risk**.

- **S**: one file or a mechanical change. **M**: a few files in one module. **L**: crosses modules,
  a new feature, or a schema change.
- **Critical** when it touches any of: access control and roles, login and sessions, routing or
  middleware that decides who sees what, secrets and env, CI and deploy, migrations or the schema,
  uploads, payments, scripts that write data. Everything else is **normal**.

## Step 2: route it

| Work | Primary | Effort | Cross-check by the other family |
|---|---|---|---|
| Plan for an L task, architecture, schema design | `planner` (Opus) | high | Sol review of the plan |
| Plan for a critical task, any size | `planner`, then `security-reviewer` on the plan | high | Astra, read-only |
| Plan for a normal S or M task | orchestrator inline | medium | none |
| Security analysis of a plan or a diff | `security-reviewer` (Opus) | high | Astra, read-only |
| Feature code and its tests | `implementer` (Sonnet) **or** Sol | medium | Sol reviews Sonnet's diff, `reviewer` reviews Sol's |
| Hard bug, flaky test, root cause | `debugger` (Sonnet) | high | stuck after one attempt: Sol `high` read-only diagnosis |
| Second implementation of a contested fix | Sol | high | `reviewer` |
| Bulk mechanical edits across many files, inventories, extraction | Luna | low | `runner` verifies with checks; `reviewer` samples |
| Commands: checks, tests, build, git and gh queries | `runner` (Haiku) | n/a | none |
| Text edits with the text given | `scribe` (Haiku) | n/a | exempt: orchestrator reads the diff |
| Docs that explain how and why | `implementer` | medium | Sol |
| Commit, PR, talking to the user | orchestrator | n/a | n/a |

**Choosing between Sonnet and Sol for code**, in this order:

1. The package needs to read a lot of the repo → **Sol**: its context and tokens are not ours.
2. The package needs several rounds with the orchestrator, or follows a plan just written here → **Sonnet**.
3. Otherwise **alternate**, so both plans drain at a similar pace. The ledger shows the balance.

## Effort rules

- **Default `medium`.** **`high`** for planning, security, debugging, every review, any task crossing
  modules, and the second attempt after a failed check.
- **`xhigh` and `max` only with the user's approval.**
- **Escalate effort before model.** A Sonnet package that fails twice at `high` goes back to the
  orchestrator, which re-plans or hands it to Sol; it does not quietly move to Opus.
- **Codex:** effort is passed per task (`--effort`), up to `xhigh`.

## Step 3: cross-check

**No change is committed until the family that did not write it has reviewed it.** Exempt: `scribe`
edits whose text was dictated, and `runner` output.

- A finding is fixed, or answered with a reason, before commit. Not silently dropped.
- At most **two** fix-and-review rounds. Still red: the orchestrator decides, or asks the user.
- Two families disagree on a **critical** point: the user decides, with both arguments.
- The orchestrator reads review summaries, not full diffs, unless a finding is disputed.

## Step 4: keep a ledger

Every orchestrated task opens with a short table in the reply and keeps it current:

| # | Package | Size/risk | Owner (model, effort) | Cross-check | Status |
|---|---|---|---|---|---|

## Limits

- **Claude:** claude.ai, Claude Code and Desktop share one allowance, and Opus spends it fastest.
- **ChatGPT / Codex:** Astra is the scarcest, Sol the workhorse, Luna has by far the most headroom.

So: **Astra is rationed** to critical plan and security checks, never a worker. **The orchestrator
keeps its context lean**: subagents report in 15 lines or fewer. **Never enable the Codex plugin's
stop-time review gate**: it runs on every stop and drains limits. When a family runs out:

| Out of | Its work goes to |
|---|---|
| Sol | `implementer` / `debugger` / `reviewer` |
| Astra | `security-reviewer` alone, and the user is told the critical check had one family |
| Luna | `scribe`, or `runner` plus Sol for anything that needs judgment |
| Claude allowance | Sol for code, Luna for mechanical work; the orchestrator only integrates |

The orchestrator cannot read either usage meter; in a long session it asks the user to glance at
`/usage` (Claude) and Codex's `/status` at natural checkpoints.

## Working safely with several writers

- Subagents and Codex workers share the current checkout. Parallel writers only on **disjoint
  files**; schema and migrations have **one writer**.
- **Workers never commit, push or switch branches.** The orchestrator commits after the cross-check.
- **Every brief is self-contained:** goal, files it may touch, constraints, done criteria, report
  format. A worker has not seen the conversation.

## Fallbacks

- **Haiku** too weak for a job: give it to `implementer` with a narrow brief instead.
- **Codex not set up**: Claude covers every row, the cross-check becomes `reviewer` against
  `implementer`, and the orchestrator says the check was single-family.
