# Orchestration plan: {{task_title}}

**Triage:** size {{S|M|L}}, risk {{low|med|high}} → {{inline|single-cross-check|full}}, because {{one sentence}}.
**Pools before start:** {{usage.mjs status --md}}

## Ledger (keep current; it is the user's view of who did what)
| # | Package | Type C/R | Owner (model · effort) | Cross-check | Status |
|---|---|---|---|---|---|
| T1 | {{title}} | implement M/med | {{model · effort}} | {{reviewer model · effort / exempt}} | ⏳ planned / 🔄 in progress / ✅ ok / 🔁 fixing (round n) / ❌ failed |

<!-- Source: registry.mjs route --tasks <file> --md -->

## Justifications and approvals
- {{id}}: {{why the heavy tier is needed, one sentence}}
- Approval needed: {{none | list}}

## Order
1. Parallel group A: {{ids}} (disjoint files)
2. Then: {{ids}}
3. Cross-reviews → fixes (max 2 rounds) → orch-runner checks

## Done when
- Checks: {{tests / type check / lint / build}}
- Criteria: {{list}}
