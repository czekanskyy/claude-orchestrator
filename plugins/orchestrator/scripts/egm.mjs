#!/usr/bin/env node
// Backend of the EGM mode (references/egm-flow.md). Zero model tokens: it plans the phases, writes the briefs the agents read,
// keeps the state of one EGM pass in <run>/egm/ and renders the compact report lines. The skill only dispatches and relays.
//   status [--md]                                   plugin present / version / parts reachable / other harnesses
//   plan --run D [--review r] [--sensitivity s]     estimate + add the design and review rows to the run ledger, write D/egm/plan.json
//   brief --run D --phase design [--spec FILE]      write the Elephant's design brief
//   brief --run D --phase resolve --stage N | --final [--answers-file F]   write the Elephant's resolve brief for a stage (or the owner's answers)
//   brief --run D --phase review --stage N          write the reviewer / synthesizer briefs of a stage (needs D/egm/design.md)
//   brief --run D --phase drift [--base REF]        add the drift row and write its brief
//   save --run D --name FILE                        stdin -> D/egm/reports/FILE
//   record --run D [--stage N --blocker a --major b --nit c --not-run x,y --applied n --contested n --escalated n] [--phase P] [--files-listed n] [--approved true|false] [--drift-items n --drift-fixed n]
//   state --run D | report-lines --run D | ranges --run D
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadRegistry, parseArgs, out, fail } from './lib/common.mjs';
import { persona } from './lib/render.mjs';
import {
  egmStatus, locateEgm, estimateEgm, readEgmSettings, REVIEW_STAGES, PRESETS, egmPaths, buildBrief, pointer, splitRanges, readState, writeState, crossFamilyPrompt,
  EGM_INSTALL_HINT,
} from './lib/egm.mjs';

const ledgerFile = (dir) => path.join(dir, 'ledger.json');
const loadLedger = (dir) => JSON.parse(fs.readFileSync(ledgerFile(dir), 'utf8'));
const saveLedger = (dir, l) => fs.writeFileSync(ledgerFile(dir), `${JSON.stringify(l, null, 2)}\n`);
const needRun = (a) => { if (!a.run || !fs.existsSync(ledgerFile(a.run))) fail('--run <dir> with a ledger.json is required'); return a.run; };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const num = (v) => Number(v || 0);

function addRow(ledger, step, dispatch) {
  const n = ledger.counters[step.role] || 0;
  ledger.counters[step.role] = n + 1;
  const offset = Math.max(0, ...ledger.rows.map((r) => r.wave));
  ledger.rows.push({ id: step.id, wave: step.wave_abs ?? offset + 1, stage: step.stage, role: step.role, agent: persona(step.role, n), model: step.model, effort: step.effort, title: step.title, dispatch, status: 'pending', note: '' });
}

export function planEgm(reg, runDir, { review, sensitivity, pools } = {}) {
  const settings = readEgmSettings(reg);
  const rv = review || settings.review;
  const cross = settings.goldfish === 'cross';
  const est = estimateEgm(reg, { review: rv, crossFamily: cross, sensitivity: sensitivity || reg.meta.default_sensitivity || 'internal', pools });
  if (!est.ok) return { ok: false, estimate: est, error: est.errors?.[0] || est.error };
  const p = egmPaths(runDir);
  const ledger = loadLedger(runDir);
  const base = Math.max(0, ...ledger.rows.map((r) => r.wave));
  const rows = est.steps.filter((s) => !s.hidden && s.phase !== 'drift' && !ledger.rows.some((r) => r.id === s.id));
  for (const s of rows) {
    const brief = path.join(p.briefs, `${s.id}.md`);
    // nested reviewers are spawned by their synthesizer: no dispatch of their own, the row only shows them in the tables
    const dispatch = s.nested ? null : s.via === 'adapter' ? { ...s.dispatch, mode: 'review', prompt_file: brief } : { ...s.dispatch, prompt: pointer(brief) };
    addRow(ledger, { ...s, wave_abs: base + s.wave }, dispatch);
  }
  saveLedger(runDir, ledger);
  const state = { version: 1, started: new Date().toISOString(), review: rv, goldfish: cross ? 'cross' : 'claude', phase: 'design', stages: {}, rounds: 0, base_wave: base, escalated: [], design_approved: null, agents: est.agents, units: est.units };
  fs.mkdirSync(p.reports, { recursive: true });
  fs.mkdirSync(p.briefs, { recursive: true });
  write(p.plan, `${JSON.stringify({ review: rv, estimate: est }, null, 2)}\n`);
  writeState(runDir, state);
  return { ok: true, rows: rows.length, review: rv, goldfish: state.goldfish, estimate: { summary: est.summary, agents: est.agents, units: est.units, notes: est.notes }, design_file: p.design, artifact_dir: p.dir };
}

// Models of the plan's steps (the synthesizer brief tells the reviewers which model/effort to run on).
function planStep(runDir, id) {
  const plan = JSON.parse(fs.readFileSync(egmPaths(runDir).plan, 'utf8'));
  return plan.estimate.steps.find((s) => s.id === id);
}

export function writeBriefs(reg, runDir, phase, a = {}) {
  const egm = locateEgm();
  if (!egm.present) throw new Error(`egm plugin not installed (${EGM_INSTALL_HINT})`);
  const p = egmPaths(runDir);
  fs.mkdirSync(p.briefs, { recursive: true });
  const files = [];
  if (phase === 'design') {
    const spec = a.spec || [path.join(runDir, 'prompt.md'), path.join(runDir, 'request.md')].find((f) => fs.existsSync(f));
    if (!spec) throw new Error('no spec: pass --spec or create <run>/prompt.md (complex) or <run>/request.md (simple, the verbatim request)');
    files.push(write(path.join(p.briefs, 'EG-design.md'), buildBrief('design', { egm, runDir, specFile: spec })));
    return { files, design_file: p.design };
  }
  if (phase === 'resolve') {
    const final = !!a.final;
    const stage = REVIEW_STAGES.find((s) => s.stage === num(a.stage));
    if (!final && !stage) throw new Error('--stage N (5-9) or --final');
    const reports = stage ? [path.join(p.reports, stage.report), ...(stage.stage === 7 && fs.existsSync(path.join(p.reports, 'critic_xfamily_report.md')) ? [path.join(p.reports, 'critic_xfamily_report.md')] : [])] : [];
    const answers = a['answers-file'] ? fs.readFileSync(a['answers-file'], 'utf8') : null;
    const name = final ? 'EG-resolve-final.md' : `EG-s${stage.stage}-resolve.md`;
    files.push(write(path.join(p.briefs, name), buildBrief('resolve', { egm, runDir, stage: stage?.stage, reports, final, answers })));
    return { files, message: pointer(files[0]) };
  }
  if (phase === 'review') {
    const stage = REVIEW_STAGES.find((s) => s.stage === num(a.stage));
    if (!stage) throw new Error('--stage N (5-9)');
    if (!fs.existsSync(p.design)) throw new Error(`no design at ${p.design}`);
    const ranges = splitRanges(fs.readFileSync(p.design, 'utf8'));
    const prompts = {};
    const sid = (r) => `EG-s${stage.stage}-${r.replace(/^egm-/, '')}`;
    const first = stage.reviewers[0];
    const modelOf = planStep(runDir, sid(first));
    if (stage.via === 'synthesizer') {
      const synth = { stage_no: stage.stage, synth: true };
      files.push(write(path.join(p.briefs, `EG-s${stage.stage}-syn.md`), buildBrief('review', { egm, runDir, step: synth, ranges, model: modelOf?.dispatch?.model, effort: modelOf?.effort })));
    } else {
      for (const r of stage.reviewers) files.push(write(path.join(p.briefs, `${sid(r)}.md`), buildBrief('review', { egm, runDir, step: { stage_no: stage.stage, reviewer: r }, ranges })));
    }
    if (stage.stage === 7 && readState(runDir)?.goldfish === 'cross') {
      const x = planStep(runDir, 'EG-s7-xfam');
      if (x) files.push(write(path.join(p.briefs, 'EG-s7-xfam.md'), crossFamilyPrompt(egm, { reviewer: 'egm-design', standard: 'feature-spec-standard', designFile: p.design, range: `FeatureRange ${ranges.feature}` })));
    }
    return { files, ranges, report: path.join(p.reports, stage.report), reviewers_in_synth: stage.via === 'synthesizer' };
  }
  if (phase === 'drift') {
    const l = loadLedger(runDir);
    const base = a.base || l.head || 'HEAD';
    const cwd = l.repo || process.cwd();
    const changed = (spawnSync('git', ['diff', '--name-only', base], { cwd, encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean);
    const step = { id: 'EG-drift', role: 'goldfish', stage: 'EGM drift', title: 'Goldfish: drift check, design vs code' };
    const briefFile = path.join(p.briefs, 'EG-drift.md');
    files.push(write(briefFile, buildBrief('drift', { egm, runDir, diffBase: base, changed })));
    if (!l.rows.some((r) => r.id === step.id)) {
      const pick = planStep(runDir, 'EG-drift');
      addRow(l, { ...step, model: pick?.model, effort: pick?.effort }, { ...pick?.dispatch, prompt: pointer(briefFile) });
      saveLedger(runDir, l);
    }
    return { files, changed: changed.length, message: pointer(briefFile) };
  }
  throw new Error('--phase design|resolve|review|drift');
}

export function recordState(runDir, a) {
  const st = readState(runDir);
  if (!st) throw new Error('no EGM state: run `egm.mjs plan` first');
  if (a.stage) {
    const k = String(a.stage);
    const cur = st.stages[k] || {};
    for (const f of ['blocker', 'major', 'nit', 'applied', 'contested', 'escalated', 'declined']) if (a[f] !== undefined) cur[f] = num(a[f]);
    if (a['not-run'] !== undefined) cur.not_run = String(a['not-run']).split(',').filter(Boolean);
    st.stages[k] = cur;
  }
  if (a.phase) st.phase = a.phase;
  if (a['files-listed'] !== undefined) st.files_listed = num(a['files-listed']);
  if (a.rounds !== undefined) st.rounds = num(a.rounds);
  if (a.approved !== undefined) st.design_approved = a.approved === 'true' || a.approved === true;
  if (a['drift-items'] !== undefined) st.drift = { items: num(a['drift-items']), fixed: num(a['drift-fixed']) };
  if (a['blockers-open'] !== undefined) st.blockers_open = num(a['blockers-open']);
  return writeState(runDir, st);
}

// Compact lines for the final report (Polish, like the rest of the report).
export function reportLines(runDir) {
  const st = readState(runDir);
  if (!st) return [];
  const p = egmPaths(runDir);
  const stages = Object.entries(st.stages);
  const sum = (k) => stages.reduce((n, [, s]) => n + (s[k] || 0), 0);
  const notRun = stages.flatMap(([n, s]) => (s.not_run || []).map((r) => `${r}@${n}`));
  const lines = [
    `EGM: projekt ${fs.existsSync(p.design) ? p.design.replace(/\\/g, '/') : 'nie powstał'}${st.files_listed ? `, ${st.files_listed} plików w planie` : ''}; ${st.design_approved === true ? 'zatwierdzony przez Ciebie' : st.design_approved === false ? 'NIE zatwierdzony' : 'bez zatwierdzenia'}.`,
    `Goldfish: ${stages.length}/${(PRESETS[st.review] || []).length} etapów (${st.review}, ${st.goldfish === 'cross' ? 'z inną rodziną' : 'Claude'}); znalezisk ${sum('blocker')} blokerów / ${sum('major')} poważnych / ${sum('nit')} drobnych; naprawiono ${sum('applied')}, zakwestionowano ${sum('contested')}, do Ciebie ${sum('escalated')}${notRun.length ? `; NIE uruchomiono: ${notRun.join(', ')}` : ''}.`,
  ];
  if (st.drift) lines.push(`Dryf (projekt vs kod): ${st.drift.items} ${st.drift.items === 1 ? 'rozbieżność' : 'rozbieżności'}${st.drift.fixed ? `, naprawiono ${st.drift.fixed}` : ''}.`);
  else if (st.phase !== 'done') lines.push('Kontrola dryfu: nie wykonana.');
  return lines;
}

function statusMd(s) {
  if (!s.present) return `EGM plugin: not installed. Install: ${s.install_hint}`;
  const other = Object.entries(s.other_harnesses).filter(([, v]) => v).map(([k]) => k);
  return [`EGM plugin ${s.version || '?'} at ${s.root} (${s.source})`, `Reachable: ${s.ok ? 'all skills, personas and standards' : `MISSING ${s.missing.join(', ')}`}`, `Also installed for: ${other.join(', ') || 'no other harness detected'} (the orchestrator drives the Claude Code installation only)`].join('\n');
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest, { flags: ['md', 'final'] });
  switch (cmd) {
    case 'status': { const s = egmStatus(); if (a.md) { process.stdout.write(`${statusMd(s)}\n`); return; } return out(s); }
    case 'plan': { const r = planEgm(loadRegistry(), needRun(a), { review: a.review, sensitivity: a.sensitivity }); return out(r, r.ok ? 0 : 1); }
    case 'brief': { try { return out({ ok: true, ...writeBriefs(loadRegistry(), needRun(a), a.phase, a) }); } catch (e) { return fail(e.message); } }
    case 'save': {
      const dir = needRun(a);
      if (!a.name) return fail('--name FILE required');
      const file = path.join(egmPaths(dir).reports, path.basename(String(a.name)));
      write(file, fs.readFileSync(0, 'utf8'));
      return out({ ok: true, file });
    }
    case 'record': return out({ ok: true, state: recordState(needRun(a), a) });
    case 'state': return out(readState(needRun(a)) || { error: 'no EGM state' });
    case 'report-lines': return out({ lines: reportLines(needRun(a)) });
    case 'ranges': { const p = egmPaths(needRun(a)); return out(splitRanges(fs.readFileSync(p.design, 'utf8'))); }
    default:
      process.stdout.write('egm.mjs status | plan | brief | save | record | state | report-lines | ranges (see the header of the file)\n');
      process.exitCode = cmd ? 1 : 0;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => fail(e.message));
