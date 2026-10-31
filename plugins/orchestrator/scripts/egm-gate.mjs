#!/usr/bin/env node
// EXTENSION POINT `egm_gate`: runs after the prompt is ready (simple: the user's request; complex: prompt.md;
// huge: after the split) and BEFORE planning. Today it is a placeholder that always answers "not critical".
// The EGM mode replaces the body of egmGate(): when it returns action "egm", SKILL.md hands the prompt to that
// mode instead of planning. Contract: input {class, critical (triage flag), prompt_file?}; output {gate, critical, action}.
// Usage: node egm-gate.mjs [--class simple|complex|huge] [--critical true|false] [--prompt-file F]
import { pathToFileURL } from 'node:url';
import { parseArgs, out } from './lib/common.mjs';

export function egmGate({ critical = false } = {}) {
  return { gate: 'egm_gate', critical: false, candidate: !!critical, action: 'continue', note: 'EGM not implemented: always not-critical' };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = parseArgs(process.argv.slice(2));
  out(egmGate({ class: a.class, critical: a.critical === 'true', promptFile: a['prompt-file'] }));
}
