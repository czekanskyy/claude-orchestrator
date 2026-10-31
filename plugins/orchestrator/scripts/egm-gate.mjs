#!/usr/bin/env node
// EXTENSION POINT `egm_gate`: runs after the prompt is ready (simple: the user's request; complex: prompt.md;
// huge: after the split) and BEFORE planning. Today it is a placeholder that always answers "not critical".
// The EGM mode replaces the body of egmGate(): when it returns action "egm", SKILL.md hands the prompt to that
// mode instead of planning. Contract: input {class, critical (triage flag), prompt_file?}; output {gate, critical, action}.
// Autonomous runs call it per critical task with the contract's pre-consent (`consent`); EGM itself is still not implemented.
// Usage: node egm-gate.mjs [--class simple|complex|huge] [--critical true|false] [--prompt-file F] [--contract contract.yaml]
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { parseArgs, out, loadRegistry } from './lib/common.mjs';
import { parseYaml } from './lib/yaml-lite.mjs';

// setting: the repo profile's EGM choice (ask | off); the gate itself is still a placeholder.
// contract: an autonomous run's contract; its `egm.allow` is the user's pre-consent for critical subtasks (nobody can be asked later).
export function egmGate({ critical = false, setting = 'ask', contract = null } = {}) {
  const consent = contract ? contract.egm?.allow === true : null;
  const note = setting === 'off' ? 'EGM is off for this repo (repo profile)' : contract && critical && !consent ? 'autonomous run without EGM pre-consent: EGM is not used' : 'EGM not implemented: always not-critical';
  return { gate: 'egm_gate', critical: false, candidate: !!critical, setting, consent, action: 'continue', note };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = parseArgs(process.argv.slice(2));
  const contract = a.contract ? parseYaml(fs.readFileSync(a.contract, 'utf8')) : null;
  out(egmGate({ class: a.class, critical: a.critical === 'true', promptFile: a['prompt-file'], setting: loadRegistry().meta.repo_rules?.egm, contract }));
}
