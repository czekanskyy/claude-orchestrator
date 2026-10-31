## Status report: {{task_title}}

**Result:** {{✅ done | ⚠️ partial | ❌ stopped}}, {{one sentence}}

### What was done
| subtask | who (model · effort) | result |
|---|---|---|
| {{id: title}} | {{model}} · {{effort}} | {{ok / fixed after review / failed}} |

### Verification
- {{tests: X/Y passed · lint: ok · build: ok · diff: N files}}

### Cross-reviews
- {{reviewer model}} → {{author family}}: {{number of findings, what was fixed}}

### Problems and fallbacks
- {{e.g. "Fallback: gpt-6.1-sol → claude-sonnet (Plus limit, cooldown until 18:20)"}} / none

### Pool state
{{usage.mjs status --md}}
<!-- ~ = estimate; Claude is exact (statusline) -->

### Next steps
- {{what's left / what needs a decision}}
