## What and why

## How it was tested
- [ ] `node plugins/orchestrator/scripts/selftest.mjs` passes
- [ ] `node plugins/orchestrator/scripts/hygiene.mjs` is clean
- [ ] new behavior has a selftest

## Impact
- [ ] No change to what may leave the machine, or the change is described below
- [ ] No weakening of a floor (sensitive-data filter, push consent, EGM/auto consent, workers never commit)
- [ ] Docs and CHANGELOG updated
- [ ] Vendor facts changed in `models.yaml` carry a source URL and a check date

## Notes
