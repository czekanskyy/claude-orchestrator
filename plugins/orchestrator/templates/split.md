<!-- One part of a huge request, saved as <run_dir>/part-N.md and used as the --prompt-file / brief source of its workers. Self-contained: no reference to the conversation or to other parts except through Expects. -->
## Goal
{{one deliverable, 1-3 sentences}}

## Expects
{{what earlier parts left in the repo: files, interfaces, passing checks; "nothing: first part"}}

## Context
{{only what the worker cannot cheaply discover: paths, conventions, pointers to CLAUDE.md}}

## Scope and constraints
{{files it may edit (≤ ~5), what is out of scope; workers do not commit or push}}

## Done criteria and verification
{{numbered, testable criteria + the exact commands}}

## Autonomy and reporting
Pick sensible defaults when something is ambiguous. Report in ≤ 15 lines: files changed, checks run and results, assumptions, anything unresolved. Leave decisions a later part needs in {{run_dir}}/handoff/part-N.md.
