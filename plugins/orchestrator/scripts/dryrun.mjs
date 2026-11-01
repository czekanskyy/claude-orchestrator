#!/usr/bin/env node
// --dry-run: triage + path + egm_gate + agent labels + breakdown and assignment tables, with ZERO model calls.
// Without --tasks the post-spec/post-split plan is only described (it needs the model); with --tasks (a plan like
// fixtures/plan.json) it is routed and shown per wave.
// Usage: node dryrun.mjs (--text "..." | --file F) [--tasks plan.json] [--egm]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadRegistry, parseArgs, fail } from './lib/common.mjs';
import { route } from './registry.mjs';
import { triage } from './triage.mjs';
import { egmGate } from './egm-gate.mjs';
import { addRoute, assignmentTable, breakdownTable, persona } from './lib/render.mjs';
import { egmStatus, estimateEgm } from './lib/egm.mjs';

// The EGM phases the gate would run after a yes, as an assignment table (personas and models come from the same router).
function egmPhaseTable(gate) {
  const steps = (gate.estimate_full?.steps || []).filter((s) => !s.hidden && s.phase !== 'drift');
  const counters = {};
  const rows = steps.map((s) => { const n = counters[s.role] || 0; counters[s.role] = n + 1; return { agent: persona(s.role, n), model: s.model, effort: s.effort, id: s.id, title: s.title }; });
  return assignmentTable(rows);
}

export function dryRun(reg, text, { tasks, pools, explicit = false, status } = {}) {
  const t = triage(text, reg);
  const gate = egmGate({ class: t.class, critical: t.critical, text, repoCriticalHits: t.critical_paths, riskHint: t.risk_hint, reg, explicit, pools, sensitivity: t.sensitivity, status: status || egmStatus() });
  if (['ask', 'egm'].includes(gate.action)) gate.estimate_full = estimateEgm(reg, { review: gate.settings.review, crossFamily: gate.settings.goldfish === 'cross', sensitivity: t.sensitivity, pools });
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
    `egm_gate: ${gate.action} (critical=${gate.critical}${gate.rubric.categories.length ? ` [${gate.rubric.categories.join(', ')}]` : ''}, triage flag=${gate.candidate}, mode=${gate.settings.mode}, repo setting=${gate.setting}) ${gate.note}`,
    ...(gate.action === 'ask' ? ['', 'EGM proposal (nothing starts without a yes)', `Cost: ${gate.estimate.summary}`, `Question: ${gate.question.question}`, `Options: ${gate.question.options.map((o) => o.label).join(' / ')}`] : []),
    ...(['ask', 'egm'].includes(gate.action) && gate.estimate_full?.ok ? ['', `EGM phases if accepted (${gate.settings.review} review): design → Goldfish review stages with Elephant resolve after each → your approval → implementation by routed workers → drift check`, egmPhaseTable(gate), '(implementation workers are planned from the approved design and cost the same as in the normal flow; resolve turns resume the Elephant)'] : []),
    ...(new Set(ledger.rows.map((r) => r.wave)).size > 1 ? ['', 'Breakdown (shown to the user with the first wave)', breakdownTable(ledger.rows)] : []),
    ...blocks.flatMap((b) => ['', `${b.label}`, b.table]),
    '', 'Model calls: 0',
  ].join('\n');
  return { triage: t, gate, path: t.class, personas: ledger.rows.map((r) => r.agent), rows: ledger.rows, text: text_, model_calls: 0 };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = parseArgs(process.argv.slice(2), { flags: ['egm'] });
  const text = a.file ? fs.readFileSync(a.file, 'utf8') : a.text;
  if (!text) fail('usage: dryrun.mjs (--text "..." | --file F) [--tasks plan.json] [--egm]');
  const tasks = a.tasks ? JSON.parse(fs.readFileSync(a.tasks, 'utf8')) : undefined;
  process.stdout.write(`${dryRun(loadRegistry(), text, { tasks: tasks?.tasks || tasks, explicit: !!a.egm }).text}\n`);
}
