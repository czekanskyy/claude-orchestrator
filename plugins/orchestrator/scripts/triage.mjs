#!/usr/bin/env node
// Deterministic triage PROPOSAL: class simple|complex|huge, sensitivity, critical. Zero model tokens.
// Judgment stays with the orchestrator: on confidence "low" (mixed signals) it decides, and it may override anything.
// Usage: node triage.mjs (--text "..." | --file prompt.txt) [--run <slug>]   (--run also creates the run directory)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadRegistry, parseArgs, fail } from './lib/common.mjs';
import { scanTextForSensitivePaths, scanTextForGlobs } from './lib/privacy.mjs';
import { initRun } from './run.mjs';

// Stems are matched as word prefixes so Polish inflections count (kolor, koloru, kolorze).
const SIMPLE = ['typo', 'literówk', 'kolor', 'color', 'colour', 'padding', 'margin', 'margines', 'odstęp', 'spacing', 'font', 'czcionk', 'label', 'etykiet', 'tooltip', 'placeholder', 'rename', 'zmień nazw', 'zmien nazw', 'ikon', 'icon', 'wyrównaj', 'align', 'border', 'ramk', 'shadow', 'cień', 'radius', 'zaokrągl', 'wording', 'napis', 'treść komunikat', 'button text', 'tekst przycisk'];
const COMPLEX = ['architect', 'architektur', 'migrat', 'migrac', 'schema', 'schemat', 'integrat', 'integracj', 'redesign', 'przeprojektuj', 'zaprojektuj', 'refactor', 'refaktor', 'new module', 'nowy moduł', 'nowego modułu', 'race condition', 'root cause', 'przyczyn', 'flaky', 'intermittent', 'investigate', 'zbadaj', 'performance', 'wydajno', 'authenticat', 'uwierzytel', 'authoriz', 'autoryzac', 'payment', 'płatno', 'billing', 'websocket', 'concurren', 'współbieżn'];
const HUGE = ['entire codebase', 'whole codebase', 'whole repo', 'entire repo', 'across the repo', 'every module', 'all modules', 'from scratch', 'rewrite', 'full migration', 'multi-phase', 'phase 1', 'roadmap', 'cały projekt', 'całą aplikac', 'całe repo', 'wszystkie moduł', 'od zera', 'przepisz', 'etap 1', 'faza 1', 'w całym repo'];
const AMBIGUOUS = ['nie wiem', 'nie jestem pewn', 'czy lepiej', 'czy warto', 'not certain', 'wondering', 'jakoś', 'jakos', 'not sure', 'maybe', 'tbd', 'do ustalenia', 'ewentualnie', 'or something', 'best way', 'jak najlepiej', 'which approach', 'zaproponuj', 'propose', 'what do you think', 'co sądzisz'];
const CRITICAL = ['auth', 'uwierzytel', 'autoryz', 'login', 'logowan', 'hasł', 'password', 'role', 'uprawnien', 'permission', 'payment', 'płatno', 'billing', 'stripe', 'migrat', 'schema', 'schemat', 'drop table', 'delete data', 'usuwanie danych', 'production', 'produkcj', 'deploy', 'wdroż', 'secret', 'sekret', 'token', 'api key', 'klucz', 'encrypt', 'szyfrow', 'gdpr', 'rodo', 'race condition', 'concurren', 'współbieżn', 'security', 'bezpiecze', 'ci/cd', 'public api', 'breaking change'];
const SENSITIVE = ['password', 'hasł', 'secret', 'sekret', 'token', 'api key', 'apikey', 'credential', 'klucz api', 'private key', 'klucz prywatn', '.env', 'customer data', 'dane klient', 'personal data', 'dane osobow', 'pii', 'pesel', 'rodo', 'gdpr', 'confidential', 'poufn', 'production database', 'baza produkcyjn', 'prod db', 'patient', 'pacjent'];
const DOCS = ['readme', 'documentation', 'dokumentac', 'changelog', 'license', 'licencj', 'comment', 'komentarz'];
const DOC_FILE = /\.(md|txt|rst)$/i;

const stemRe = (s) => new RegExp(`(?<![\\p{L}\\p{N}_])${s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`, 'iu');
export const hits = (text, list) => list.filter((s) => stemRe(s).test(text));

export function features(text) {
  const t = String(text || '');
  const files = [...new Set((t.match(/(?:[\w.-]+[\\/])+[\w.-]+|[\w-]+\.[a-z][a-z0-9]{0,4}\b/gi) || []).filter((f) => !/^\d|^https?:|^www\./i.test(f) && !/^(e\.g|i\.e|etc)\./i.test(f)))];
  return {
    words: t.split(/\s+/).filter(Boolean).length,
    items: (t.match(/^\s*(?:[-*•]|\d+[.)]|\[[ x]\])\s+\S/gm) || []).length,
    files,
    simple: hits(t, SIMPLE), complex: hits(t, COMPLEX), huge: hits(t, HUGE),
    ambiguity: hits(t, AMBIGUOUS).length + (t.match(/\?/g) || []).length,
    critical: hits(t, CRITICAL), sensitive: hits(t, SENSITIVE), docs: hits(t, DOCS),
  };
}

export function triage(text, reg = loadRegistry()) {
  const f = features(text);
  const reasons = [];
  const pathHits = scanTextForSensitivePaths(reg, text);
  let cls;
  const complexWhy = [];
  if (f.words >= 450 || f.items >= 8 || f.huge.length) {
    cls = 'huge';
    reasons.push(f.huge.length ? `whole-scope wording: ${f.huge.join(', ')}` : `size: ${f.words} words, ${f.items} list items`);
  } else {
    if (f.words >= 120) complexWhy.push(`${f.words} words`);
    if (f.items >= 3) complexWhy.push(`${f.items} list items`);
    if (f.files.length >= 4) complexWhy.push(`${f.files.length} files named`);
    if (f.complex.length) complexWhy.push(`topic: ${f.complex.join(', ')}`);
    if (f.ambiguity >= 1 || f.questions >= 2 || (f.questions >= 1 && f.words >= 40)) complexWhy.push('open questions in the request');
    if (f.critical.length) complexWhy.push(`touches: ${f.critical.join(', ')}`);
    cls = complexWhy.length ? 'complex' : 'simple';
    reasons.push(...(complexWhy.length ? complexWhy : [f.simple.length ? `small change: ${f.simple.join(', ')}` : `short and concrete (${f.words} words)`]));
  }
  let confidence = 'medium';
  if (cls === 'simple') confidence = f.simple.length && f.words < 60 ? 'high' : 'medium';
  if (cls === 'complex' && f.simple.length && complexWhy.length === 1) confidence = 'low';
  if (cls === 'complex' && complexWhy.length >= 2) confidence = 'high';
  if (cls === 'huge') confidence = f.huge.length >= 2 || f.words >= 450 || f.items >= 8 ? 'high' : 'medium';

  // repo profile: paths the user declared critical force risk high (the class stays as judged above)
  const critHits = scanTextForGlobs(reg.meta.repo_rules?.critical_globs || [], text);
  const critical = f.critical.length > 0 || critHits.length > 0;
  if (critHits.length) reasons.push(`critical path (repo profile): ${critHits.map((h) => h.file).join(', ')}`);
  const docsOnly = f.docs.length > 0 && f.files.every((x) => DOC_FILE.test(x)) && !critical && !f.sensitive.length;
  // the baseline is the effective default (user config, or the repo profile's), not a hardcoded "internal"
  const base = reg.meta.default_sensitivity || 'internal';
  const sensitivity = pathHits.length || f.sensitive.length ? 'sensitive' : docsOnly && base !== 'sensitive' ? 'none' : base;
  const risk_hint = critical ? 'high' : cls === 'simple' ? 'low' : 'med';
  // A spec round (prompt-creator: repo read, questions, a saved prompt) costs minutes. It pays off only when the request
  // leaves something open; a concrete one (files named, no open questions, enough words) is briefed straight from its own text.
  const specNeeded = cls === 'complex' && (f.ambiguity >= 1 || f.files.length === 0 || f.words < 40 || confidence === 'low');
  return {
    class: cls, confidence, sensitivity, critical, risk_hint, reasons, spec_needed: specNeeded,
    critical_paths: critHits.map((h) => h.file),
    sensitivity_why: sensitivity === 'sensitive' ? [...pathHits.map((h) => h.file), ...f.sensitive] : [],
    signals: { words: f.words, items: f.items, files: f.files.length, simple: f.simple.length, complex: f.complex.length, huge: f.huge.length, ambiguity: f.ambiguity, questions: f.questions, critical: f.critical },
    spec_why: cls !== 'complex' ? null : specNeeded ? 'request leaves something open (no files named, open questions, too short or mixed signals)' : 'request is concrete: skip the spec round, plan from the request text',
    note: confidence === 'low' ? 'Mixed signals: decide yourself (routing.md §1).' : 'Proposal only: override when you know better.',
  };
}

async function main(argv) {
  const a = parseArgs(argv);
  const text = a.file ? fs.readFileSync(a.file, 'utf8') : a.text;
  if (!text) return fail('usage: triage.mjs (--text "..." | --file prompt.txt)');
  const r = triage(text);
  if (a.run) r.run = initRun(loadRegistry(), { slug: a.run });
  process.stdout.write(`${JSON.stringify(r)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => fail(e.message));
}
