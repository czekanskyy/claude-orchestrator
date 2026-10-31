#!/usr/bin/env node
// Repo hygiene scan for a public project: no personal paths, emails or key-like strings in tracked files.
// Zero model tokens, read-only. Run before every push:  node plugins/orchestrator/scripts/hygiene.mjs [--deny "word,word"] [--root DIR]
// --deny adds private identifiers (your name, e-mail, company) that must not appear; they are never stored in the repo.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, out } from './lib/common.mjs';
import { SECRET_VALUE } from './lib/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = [
  { id: 'windows-user-path', re: /[A-Za-z]:\\+Users\\+(?!<|%|\$|Public\b|\*|\.\.\.|you\b|user\b|name\b|alice\b|bob\b)[^\\\s"'`<>]+/g },
  { id: 'posix-user-path', re: /(?:\/Users|\/home)\/(?!<|\$|\*|you\b|user\b|name\b|runner\b|me\b|alice\b|bob\b)[A-Za-z0-9._-]{2,}/g },
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, allow: /^(noreply@|.*@example\.(com|org|invalid)$|.*@users\.noreply\.github\.com$|git@github\.com$|token@github\.com$)/ },
  // Test fixtures and the secret-detection regexes themselves contain key-like strings by design.
  { id: 'secret', re: new RegExp(SECRET_VALUE.source, 'g'), skip: /(^|\/)(selftest[\w-]*\.mjs|lib\/common\.mjs|lib\/config\.mjs|hygiene\.mjs)$/ },
  { id: 'aws-key', re: /AKIA[0-9A-Z]{16}/g },
  { id: 'bearer', re: /Bearer\s+[A-Za-z0-9._-]{24,}/g },
];
const BINARY = /\.(png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf)$/i;

export function scanText(text, file, deny = []) {
  const found = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const r of RULES) {
      if (r.skip?.test(file)) continue;
      for (const m of line.matchAll(r.re)) {
        if (r.allow?.test(m[0])) continue;
        found.push({ file, line: i + 1, rule: r.id, match: m[0].slice(0, 40) });
      }
    }
    for (const d of deny) if (d && line.toLowerCase().includes(d.toLowerCase())) found.push({ file, line: i + 1, rule: 'denied-word', match: d });
  });
  return found;
}

export function scanRepo(root, { deny = [] } = {}) {
  const ls = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (ls.status !== 0) return { skipped: true, reason: 'not a git checkout', findings: [] };
  const findings = [];
  const files = ls.stdout.split('\n').filter(Boolean);
  for (const f of files) {
    if (BINARY.test(f) || !fs.existsSync(path.join(root, f))) continue;
    findings.push(...scanText(fs.readFileSync(path.join(root, f), 'utf8'), f.replace(/\\/g, '/'), deny));
  }
  return { skipped: false, files: files.length, findings };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = parseArgs(process.argv.slice(2));
  const r = scanRepo(path.resolve(a.root || path.join(HERE, '..', '..', '..')), { deny: a.deny ? String(a.deny).split(',') : [] });
  out({ ok: r.findings.length === 0, ...r }, r.findings.length ? 1 : 0);
}
