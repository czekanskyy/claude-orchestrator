// Rendering for everything the user sees: personas, assignment table, status table, final report, prompt lint.
// Formats live in templates/*.md (mustache-lite, below); this file only fills them. Zero model tokens.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_DIR } from './common.mjs';

export const REPORT_LINE_CAP = 35;
export const SUMMARY_LINE_CAP = 3;
export const STATUS = { done: '✅', progress: '🔄', pending: '⏳', attention: '⚠️', failed: '❌' };
const RESULT = { done: ['✅', 'zrobione'], partial: ['⚠️', 'częściowo'], stopped: ['❌', 'zatrzymane'] };

// ---------------------------------------------------------------- templates
// {{key}} scalar · line starting {{#list}} repeats the rest of the line per item ({{.}} for strings)
// · line starting {{^list}} renders only when the list is empty · lines that are only an HTML comment are dropped.
export function renderTemplate(tpl, data) {
  const fill = (s, d, cell) => s.replace(/\{\{([\w.]+)\}\}/g, (_, k) => {
    const v = String(d[k] ?? '');
    return cell ? v.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ') : v;
  });
  const lines = [];
  for (const line of tpl.split(/\r?\n/)) {
    let m;
    if (/^\s*<!--.*-->\s*$/.test(line)) continue;
    if ((m = line.match(/^\{\{#(\w+)\}\}(.*)$/))) {
      for (const item of data[m[1]] || []) lines.push(fill(m[2], typeof item === 'object' ? item : { '.': item }, m[2].trimStart().startsWith('|')));
    } else if ((m = line.match(/^\{\{\^(\w+)\}\}(.*)$/))) {
      if (!(data[m[1]] || []).length) lines.push(fill(m[2], data));
    } else lines.push(fill(line, data));
  }
  return lines.join('\n').replace(/\n+$/, '');
}

export function loadTemplate(name) {
  return fs.readFileSync(path.join(PLUGIN_DIR, 'templates', `${name}.md`), 'utf8');
}

// ---------------------------------------------------------------- personas (deterministic, no model call)
const PERSONAS = {
  implementer: ['🔨', ['Bartek', 'Basia', 'Błażej', 'Bogdan', 'Beata', 'Bruno']],
  mechanic: ['🧰', ['Marek', 'Marta', 'Michał', 'Magda', 'Mikołaj', 'Monika']],
  debugger: ['🐞', ['Darek', 'Dorota', 'Damian', 'Daria', 'Dawid', 'Dagmara']],
  planner: ['🧭', ['Paweł', 'Patrycja', 'Piotr', 'Paulina', 'Przemek', 'Pola']],
  researcher: ['📚', ['Wiktor', 'Wiola', 'Witek', 'Weronika', 'Wojtek', 'Wanda']],
  reviewer: ['🧐', ['Rysiek', 'Renata', 'Radek', 'Róża', 'Robert', 'Roksana']],
  'security-reviewer': ['🛡️', ['Sebastian', 'Sylwia', 'Seweryn', 'Sandra', 'Stefan', 'Szymon']],
  runner: ['🏃', ['Tomek', 'Tola', 'Tymon', 'Teresa', 'Tadek', 'Tosia']],
  'prompt-creator': ['✍️', ['Kuba', 'Kinga', 'Karol', 'Klara', 'Kamil', 'Kalina']],
};

// n = how many agents of this role were already named in the run (0-based).
export function persona(role, n = 0) {
  const [emoji, names] = PERSONAS[role] || ['🤖', ['Agent']];
  const lap = Math.floor(n / names.length);
  return `${emoji} ${names[n % names.length]}${lap ? ` ${lap + 1}` : ''}`;
}

export function roleOf(a, reg) {
  if (a.role) return a.role;
  if (a.kind === 'cross_review' || a.kind === 'extra_review') return a.lens === 'security' ? 'security-reviewer' : 'reviewer';
  return String(reg.meta.subagent_for_type[a.type] || '').replace(/^orch-/, '') || 'implementer';
}

const STAGE = { spec: 'Spec', plan: 'Plan', implement: 'Implement', refactor: 'Implement', mechanical: 'Implement', test: 'Tests', debug: 'Debug', research: 'Research', review: 'Review' };
export const stageOf = (a) => (a.stage || (a.lens === 'security' ? 'Review (security)' : STAGE[a.type]) || 'Task');

// ---------------------------------------------------------------- ledger rows
export function waves(items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const memo = new Map();
  const depth = (i, seen = new Set()) => {
    if (memo.has(i.id)) return memo.get(i.id);
    if (seen.has(i.id)) return 1;
    seen.add(i.id);
    const d = 1 + Math.max(0, ...(i.deps || []).filter((x) => byId.has(x)).map((x) => depth(byId.get(x), seen)));
    memo.set(i.id, d);
    return d;
  };
  return Object.fromEntries(items.map((i) => [i.id, depth(i)]));
}

// route() assignments -> ledger rows with personas. `ledger` supplies counters and the wave offset.
export function addRoute(ledger, route, reg) {
  const items = route.assignments.filter((a) => a.kind !== 'inline');
  const w = waves(items);
  const offset = Math.max(0, ...ledger.rows.map((r) => r.wave));
  for (const a of items) {
    const role = roleOf(a, reg);
    const n = ledger.counters[role] || 0;
    ledger.counters[role] = n + 1;
    ledger.rows.push({
      id: a.id, wave: offset + w[a.id], stage: stageOf(a), role, agent: persona(role, n),
      model: a.model || '—', effort: a.effort || '—', title: a.title, dispatch: a.dispatch || null,
      status: a.error ? 'attention' : 'pending', note: a.error || '',
    });
  }
  return ledger;
}

const clip = (s, n = 64) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function assignmentTable(rows) {
  return renderTemplate(loadTemplate('assignment'), { rows: rows.map((r) => ({ agent: r.agent, model: r.model, effort: r.effort, task: clip(`${r.id} ${r.title}`) })) });
}

export function statusTable(rows, summary = []) {
  const done = rows.filter((r) => r.status === 'done');
  const shown = rows.length > 10 && done.length > 3 ? [{ stage: '…', agent: `${done.length}×`, status: 'done', note: 'zakończone wcześniej' }, ...rows.filter((r) => r.status !== 'done')] : rows;
  const lines = summary.slice(0, SUMMARY_LINE_CAP);
  const table = renderTemplate(loadTemplate('status'), { rows: shown.map((r) => ({ stage: r.stage, agent: r.agent, status: STATUS[r.status] || r.status, note: clip(r.note || '', 80) })) });
  // A blank line is required, or GFM absorbs the summary into the table.
  return lines.length ? `${table}\n\n${lines.map((l) => `- ${l}`).join('\n')}` : table;
}

// ---------------------------------------------------------------- final report
const plural = (n, one, few, many) => (n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many);

export function reviewLine(r) {
  const parts = [`${r.high || 0} wysokich`, `${r.med || 0} średnich`, `${r.low || 0} niskich`].join(' · ');
  const total = (r.high || 0) + (r.med || 0) + (r.low || 0);
  return `${r.id ? `${r.id}: ` : ''}${r.by} → ${r.of}: ${total ? `${total} ${plural(total, 'znalezisko', 'znaleziska', 'znalezisk')} (${parts}); naprawiono ${r.fixed || 0}, odrzucono ${r.rejected || 0}` : 'bez znalezisk'}${r.note ? ` — ${r.note}` : ''}`;
}

export function renderReport(data) {
  const [icon, label] = RESULT[data.result] || RESULT.partial;
  const text = renderTemplate(loadTemplate('report'), { ...data, icon, label, reviews: (data.reviews || []).map((r) => (typeof r === 'string' ? r : reviewLine(r))), fallbacks: [].concat(data.fallbacks || []).join('; ') || 'brak', pool: data.pool || 'brak danych', no_commits: data.no_commits || 'brak' });
  const lines = text.split('\n').length;
  return { text, lines, over_cap: lines > REPORT_LINE_CAP, cap: REPORT_LINE_CAP };
}

// ---------------------------------------------------------------- prompt lint (prompt.md and split parts)
const SECTIONS = [['Goal', /^#+\s*goal/im], ['Context', /^#+\s*context/im], ['Scope', /^#+\s*scope/im], ['Done criteria', /^#+\s*done/im], ['Autonomy and reporting', /^#+\s*autonomy/im]];
const NOT_SELF_CONTAINED = /\b(as discussed|as mentioned (above|earlier)|see above|the previous (session|conversation|message|prompt)|earlier in this (chat|conversation)|as we agreed|jak ustaliliśmy|jak wyżej)\b/i;

export function lintPrompt(text, { part = false } = {}) {
  const problems = [];
  for (const [name, re] of [...SECTIONS, ...(part ? [['Expects', /^#+\s*expects/im]] : [])]) if (!re.test(text)) problems.push(`missing section: ${name}`);
  const bad = text.match(NOT_SELF_CONTAINED);
  if (bad) problems.push(`not self-contained: "${bad[0]}"`);
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 60) problems.push(`too short (${words} words)`);
  if (words > 1500) problems.push(`too long (${words} words): split it`);
  return { ok: !problems.length, problems, words };
}
