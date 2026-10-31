#!/usr/bin/env node
// --dry-run: triage + path + egm_gate + personas + assignment tables, with ZERO model calls.
// Without --tasks the post-spec/post-split plan is only described (it needs the model); with --tasks (a plan like
// fixtures/plan.json) it is routed and shown per wave.
// Usage: node dryrun.mjs (--text "..." | --file F) [--tasks plan.json]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadRegistry, parseArgs, fail } from './lib/common.mjs';
import { route } from './registry.mjs';
import { triage } from './triage.mjs';
import { egmGate } from './egm-gate.mjs';
import { addRoute, assignmentTable } from './lib/render.mjs';

export function dryRun(reg, text, { tasks, pools } = {}) {
  const t = triage(text, reg);
  const gate = egmGate({ critical: t.critical });
  const ledger = { rows: [], counters: {} };
  const blocks = [];
  const showWaves = (r, label) => {
    const before = ledger.rows.length;
    addRoute(ledger, r, reg);
    const fresh = ledger.rows.slice(before);
    for (const w of [...new Set(fresh.map((x) => x.wave))].sort((x, y) => x - y)) blocks.push({ label: `${label} wave ${w}`, table: assignmentTable(fresh.filter((x) => x.wave === w)) });
  };
  const sens = t.sensitivity;
  const withSens = (list) => list.map((x) => ({ sensitivity: sens, ...x }));
  const flow = { simple: 'triage → inline plan → egm_gate → route → dispatch', complex: 'triage → prompt-creator (spec) → egm_gate → plan → route → dispatch', huge: 'triage → split into parts → egm_gate → plan per part → route → dispatch' }[t.class];

  if (t.class === 'complex') {
    showWaves(route(reg, [{ id: 'S1', title: 'Write the prompt for this request', type: 'spec', complexity: 'M', risk: 'low', family: 'claude', sensitivity: sens }], { pools }), 'Spec');
  }
  if (t.class === 'huge') blocks.push({ label: 'Split', table: '(the orchestrator splits the request into self-contained part prompts itself: no agent, no model call here)' });
  if (tasks) showWaves(route(reg, withSens(tasks), { pools }), t.class === 'complex' ? 'After prompt.md:' : 'Work');
  else if (t.class === 'simple') {
    const title = text.trim().replace(/\s+/g, ' ').slice(0, 50);
    showWaves(route(reg, withSens([{ id: 'T1', title, type: 'implement', complexity: 'S', risk: t.risk_hint }]), { pools }), 'Plan (inline, 1 package)');
    if (t.risk_hint === 'low') blocks.push({ label: 'Note', table: 'low risk and small: the orchestrator may do this itself instead of dispatching (a worker costs a full context load)' });
  } else blocks.push({ label: 'Plan', table: '(planned after the prompt exists: needs the model, so not shown in a dry run)' });

  const text_ = [
    `Path: ${t.class} (confidence ${t.confidence}) · sensitivity ${t.sensitivity} · critical ${t.critical} · risk hint ${t.risk_hint}`,
    `Reasons: ${t.reasons.join('; ')}`,
    `Flow: ${flow}`,
    `egm_gate: ${gate.action} (critical=${gate.critical}, triage flag=${gate.candidate})`,
    ...blocks.flatMap((b) => ['', `${b.label}`, b.table]),
    '', 'Model calls: 0',
  ].join('\n');
  return { triage: t, gate, path: t.class, personas: ledger.rows.map((r) => r.agent), rows: ledger.rows, text: text_, model_calls: 0 };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = parseArgs(process.argv.slice(2));
  const text = a.file ? fs.readFileSync(a.file, 'utf8') : a.text;
  if (!text) fail('usage: dryrun.mjs (--text "..." | --file F) [--tasks plan.json]');
  const tasks = a.tasks ? JSON.parse(fs.readFileSync(a.tasks, 'utf8')) : undefined;
  process.stdout.write(`${dryRun(loadRegistry(), text, { tasks: tasks?.tasks || tasks }).text}\n`);
}
