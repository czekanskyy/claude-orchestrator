#!/usr/bin/env node
// Run state and user-facing rendering, at zero model tokens: run directory + ledger, assignment table per wave,
// status table, final report (with line cap and auto-filled pools/commits), prompt lint.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadRegistry, allPoolStatus, readUsage, parseArgs, out, fail, STATE_DIR, repoRoot } from './lib/common.mjs';
import { addRoute, assignmentTable, statusTable, renderReport, lintPrompt, persona, STATUS } from './lib/render.mjs';

const USAGE = `run.mjs <command>
  init [--slug S] [--repo DIR]                       create runs/<ts>-run-<slug>/ with ledger.json (pool + git baseline)
  plan --run DIR --route route.json                  add routed assignments to the ledger (waves, personas)
  add --run DIR --id I --stage S --role R --model M --effort E --title T [--wave N]   a row not produced by the router
  assign --run DIR [--wave N] [--json]               assignment table of the next pending wave; marks it 🔄
  set --run DIR <id> --status done|progress|pending|attention|failed [--note TEXT]
  status --run DIR [--summary TEXT]...               status table (+ at most 3 summary lines)
  report --run DIR --data report.json [--strict]     final report (Polish, ≤ 35 lines); pools and commits auto-filled
  note --run DIR --kind decision|fallback TEXT         record a decision made on the user's behalf / a fallback (feeds the report)
  review --run DIR --by X --of Y [--high N --med N --low N --fixed N --rejected N --note T]   record one cross-review (feeds the report)
  save-prompt --run DIR [--part N]                   read the prompt from stdin, write prompt.md (or part-N.md), lint it, print the verdict
  lint-prompt FILE [--part]                          prompt.md / split part: sections present and self-contained`;

const ledgerFile = (dir) => path.join(dir, 'ledger.json');
const load = (dir) => JSON.parse(fs.readFileSync(ledgerFile(dir), 'utf8'));
const save = (dir, l) => fs.writeFileSync(ledgerFile(dir), `${JSON.stringify(l, null, 2)}\n`);
const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

export function initRun(reg, { slug = 'task', repo } = {}) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const dir = path.join(STATE_DIR, 'runs', `${ts}-run-${slug.replace(/[^\w-]+/g, '-').slice(0, 24)}`);
  fs.mkdirSync(dir, { recursive: true });
  const root = repo || repoRoot() || process.cwd();
  const ledger = {
    run: path.basename(dir), dir, created: new Date().toISOString(), repo: root, head: git(root, 'rev-parse', 'HEAD'),
    pools0: Object.fromEntries(allPoolStatus(reg).map((p) => [p.pool, p.pct])), counters: {}, rows: [], decisions: [], fallbacks: [], reviews: [],
  };
  save(dir, ledger);
  return { run: ledger.run, dir, prompt_file: path.join(dir, 'prompt.md') };
}

export function poolLine(reg, ledger) {
  const now = allPoolStatus(reg);
  const used = readUsage(Date.parse(ledger.created));
  const touched = new Set(used.map((u) => u.pool));
  const parts = now.filter((p) => touched.has(p.pool) || Math.abs(p.pct - (ledger.pools0[p.pool] ?? p.pct)) >= 0.5).map((p) => {
    const d = +(p.pct - (ledger.pools0[p.pool] ?? p.pct)).toFixed(1);
    return `${p.pool} ${p.pct}%${p.exact ? '' : '~'} (${d >= 0 ? '+' : ''}${d} pp)`;
  });
  const tokens = {};
  for (const u of used) if (u.tokens) tokens[u.family] = (tokens[u.family] || 0) + u.tokens;
  const tk = Object.entries(tokens).map(([f, n]) => `${f} ${(n / 1000).toFixed(1)}k`).join(', ');
  return `${parts.join(' · ') || 'bez zmian'}${tk ? ` · tokeny workerów: ${tk}` : ''}`;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest, { flags: ['json', 'part', 'strict'], multi: ['summary'] });
  const need = () => { if (!a.run || !fs.existsSync(ledgerFile(a.run))) fail('--run <dir> with a ledger.json is required'); return load(a.run); };
  switch (cmd) {
    case 'init': return out(initRun(loadRegistry(), { slug: a.slug, repo: a.repo }));
    case 'plan': {
      const l = need();
      const before = l.rows.length;
      addRoute(l, JSON.parse(fs.readFileSync(a.route, 'utf8')), loadRegistry());
      save(a.run, l);
      return out({ added: l.rows.length - before, waves: Math.max(0, ...l.rows.map((r) => r.wave)) });
    }
    case 'add': {
      const l = need();
      const n = l.counters[a.role] || 0;
      l.counters[a.role] = n + 1;
      l.rows.push({ id: a.id, wave: Number(a.wave || Math.max(1, ...l.rows.map((r) => r.wave)) + 1), stage: a.stage, role: a.role, agent: persona(a.role, n), model: a.model, effort: a.effort, title: a.title, dispatch: null, status: 'pending', note: '' });
      save(a.run, l);
      return out({ added: a.id, agent: l.rows.at(-1).agent });
    }
    case 'assign': {
      const l = need();
      const wave = a.wave ? Number(a.wave) : Math.min(...l.rows.filter((r) => r.status === 'pending').map((r) => r.wave));
      const rows = l.rows.filter((r) => r.wave === wave && r.status === 'pending');
      if (!rows.length) return fail('no pending rows in that wave');
      for (const r of rows) r.status = 'progress';
      save(a.run, l);
      const table = assignmentTable(rows);
      if (!a.json) { process.stdout.write(`${table}\n`); return; }
      return out({ wave, table, dispatch: rows.map((r) => ({ id: r.id, description: `${r.agent}: ${r.id}`, ...r.dispatch })) });
    }
    case 'set': {
      const l = need();
      const row = l.rows.find((r) => r.id === a._[0]);
      if (!row) return fail(`unknown row ${a._[0]}`);
      if (!STATUS[a.status]) return fail(`--status must be one of ${Object.keys(STATUS).join('|')}`);
      row.status = a.status;
      if (a.note !== undefined) row.note = a.note;
      save(a.run, l);
      return out({ id: row.id, status: row.status });
    }
    case 'note': {
      const l = need();
      const key = { decision: 'decisions', fallback: 'fallbacks' }[a.kind];
      if (!key) return fail('--kind must be decision|fallback');
      (l[key] ||= []).push(a._.join(' '));
      save(a.run, l);
      return out({ kind: a.kind, count: l[key].length });
    }
    case 'review': {
      const l = need();
      const n = (k) => Number(a[k] || 0);
      (l.reviews ||= []).push({ by: a.by, of: a.of, high: n('high'), med: n('med'), low: n('low'), fixed: n('fixed'), rejected: n('rejected'), note: a.note || '' });
      save(a.run, l);
      return out({ reviews: l.reviews.length });
    }
    case 'status': {
      process.stdout.write(`${statusTable(need().rows, a.summary || [])}\n`);
      return;
    }
    case 'report': {
      const l = need();
      const data = JSON.parse(fs.readFileSync(a.data, 'utf8'));
      data.pool ||= poolLine(loadRegistry(), l);
      for (const k of ['decisions', 'fallbacks', 'reviews']) data[k] ||= l[k];
      if (!data.commits && l.head) data.commits = (git(l.repo, 'log', '--oneline', `${l.head}..HEAD`) || '').split('\n').filter(Boolean).reverse();
      const r = renderReport(data);
      process.stdout.write(`${r.text}\n`);
      if (r.over_cap) { process.stderr.write(`report is ${r.lines} lines, cap ${r.cap}: shorten the longest lists\n`); if (a.strict) process.exitCode = 1; }
      return;
    }
    case 'save-prompt': {
      const l = need();
      const part = a.part && a.part !== true ? Number(a.part) : null;
      const file = path.join(l.dir, part ? `part-${part}.md` : 'prompt.md');
      const text = fs.readFileSync(0, 'utf8');
      fs.writeFileSync(file, text);
      const r = lintPrompt(text, { part: !!part && part > 1 });
      return out({ file, ...r }, r.ok ? 0 : 1);
    }
    case 'lint-prompt': {
      const r = lintPrompt(fs.readFileSync(a._[0], 'utf8'), { part: a.part });
      return out(r, r.ok ? 0 : 1);
    }
    default: process.stdout.write(`${USAGE}\n`); process.exitCode = cmd ? 1 : 0;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => fail(e.message));
}
