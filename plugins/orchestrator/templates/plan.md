<!-- Internal plan file (not shown to the user): <run_dir>/plan.json, input of `registry.mjs route --tasks`. The user sees only the assignment and status tables. -->
{ "tasks": [
  { "id": "T1", "title": "{{package title}}", "type": "implement|refactor|debug|test|research|mechanical|review|plan",
    "complexity": "S|M|L", "risk": "low|med|high", "sensitivity": "none|internal|sensitive (from triage)",
    "deps": [], "files": ["{{paths the worker may edit}}"], "dictated": false, "context_heavy": false, "interactive": false }
] }
<!-- Then: registry.mjs route --tasks plan.json > route.json · run.mjs plan --run D --route route.json · run.mjs assign --run D --json -->
<!-- Heavy tier needs a one-sentence justification: record it with `run.mjs note --kind decision`. needs_approval or a pool over low_effort_confirm: ask before dispatch. -->
