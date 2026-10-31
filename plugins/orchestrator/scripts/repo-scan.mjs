#!/usr/bin/env node
// Read-only repository scan behind /orchestrator:init: ONE compact JSON of verified facts (git state, commit and branch
// conventions, stack and real commands, policy docs with their key lines, hooks/CI/CODEOWNERS, other orchestrators,
// sensitivity signals). Zero model tokens, no dependencies. It writes nothing, never opens a secret file (only names are
// listed; every read goes through the guarded io) and never walks node_modules or the whole tree.
// Usage: node repo-scan.mjs [--repo DIR] [--full] [--pretty]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRegistry, parseArgs, repoRoot, fail, scanSecrets } from './lib/common.mjs';
import { matchGlobList, globToRegex } from './lib/privacy.mjs';
import { git, norm, repoIdentity, fsIo, DEFAULT_DENY, discoverPolicyDocs, computeFingerprint } from './lib/repo-facts.mjs';
import { repoIsEmpty } from './lib/repo-profile.mjs';
import { projectOrchestrators } from './registry.mjs';

export const SCAN_VERSION = 1;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv', '__pycache__', 'coverage', '.cache', '.turbo', '.gradle', '.idea', '.vscode', 'bower_components', '.terraform', '.svelte-kit', '.pnpm-store']);
const CODE_EXT = /\.(md|mdx|rst|txt|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|cpp|h|html|css|scss|vue|svelte|sh|ps1|sql|lock)$/i;
const TEMPLATE_ENV = /\.(example|sample|template|dist|defaults?)$/i;
const TEST_DIR = /(^|\/)(tests?|__tests__|fixtures?|seeds?|spec|e2e|mocks?)(\/|$)/i;
const clip = (s, n = 180) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const top = (list, n) => list.slice(0, n);

// ---------------------------------------------------------------- inventory (names only)
function walk(root, maxDepth, maxEntries) {
  const files = [];
  const dirs = [];
  const stack = [['', 0]];
  while (stack.length && files.length + dirs.length < maxEntries) {
    const [rel, depth] = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        dirs.push(p);
        if (depth + 1 < maxDepth) stack.push([p, depth + 1]);
      } else files.push(p);
    }
  }
  return { files, dirs };
}

function inventory(root) {
  const cached = git(root, ['ls-files', '-z', '--cached']);
  const tracked = cached === null ? [] : cached.split('\0').filter(Boolean).slice(0, 200000);
  const untracked = cached === null ? [] : (git(root, ['ls-files', '-z', '--others', '--exclude-standard']) || '').split('\0').filter(Boolean).slice(0, 50000);
  // Ignored secret files (a gitignored .env) are not in git's lists: a shallow name-only walk finds them.
  const walked = walk(root, 3, 8000);
  const dirs = new Set(walked.dirs);
  for (const f of tracked.concat(untracked)) {
    let i = f.lastIndexOf('/');
    while (i > 0) { const d = f.slice(0, i); if (dirs.has(d)) break; dirs.add(d); i = d.lastIndexOf('/'); }
  }
  return { is_git: cached !== null, tracked, untracked, walked: walked.files, dirs: [...dirs], file_count: cached !== null ? tracked.length + untracked.length : walked.files.length };
}

// ---------------------------------------------------------------- git facts
function gitFacts(root, identity) {
  const g = (...a) => (git(root, a) || '').trim();
  const refLines = (prefix) => g('for-each-ref', '--format=%(refname)', prefix).split(/\r?\n/).filter(Boolean).map((r) => r.slice(prefix.length + 1));
  const local = new Set(refLines('refs/heads'));
  // remote branches without the remote name (origin/test -> test); origin/HEAD is not a branch
  const names = [...new Set([...local, ...refLines('refs/remotes').filter((r) => !/\/HEAD$/.test(r)).map((r) => r.replace(/^[^/]+\//, ''))])];
  const originHead = g('symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '');
  const exists = (b) => names.includes(b) || local.has(b);
  const configured = g('config', '--get', 'init.defaultBranch');
  const guess = ['main', 'master', 'trunk', 'develop'].find(exists);
  const def = originHead || (configured && exists(configured) ? configured : guess || null);
  const current = g('symbolic-ref', '-q', '--short', 'HEAD') || null;
  const status = (git(root, ['status', '--porcelain=v1']) || '').split(/\r?\n/).filter(Boolean);
  const commitCount = Number(g('rev-list', '--count', 'HEAD')) || 0;
  const log = (git(root, ['log', '-n', '60', '--format=%P%x1f%s%x1e']) || '').split('\x1e').map((s) => s.trim()).filter(Boolean).map((r) => { const [parents, subject] = r.split('\x1f'); return { merge: (parents || '').trim().split(/\s+/).filter(Boolean).length > 1, subject: subject || '' }; });
  const bodies = (git(root, ['log', '-n', '60', '--format=%B%x1e']) || '');
  const hooksPath = g('config', '--get', 'core.hooksPath');
  const gitHooks = (() => { try { return fs.readdirSync(path.join(root, '.git', 'hooks')).filter((n) => !n.endsWith('.sample')); } catch { return []; } })();
  return {
    default_branch: def ? { name: def, verified: !!originHead || exists(def), via: originHead ? 'origin/HEAD' : configured && exists(configured) ? 'init.defaultBranch' : 'first existing of main/master/trunk/develop' } : null,
    current_branch: current,
    dirty: { total: status.length, modified: status.filter((l) => /^.?M|^M/.test(l)).length, untracked: status.filter((l) => l.startsWith('??')).length, sample: top(status.map((l) => l.slice(3)), 4) },
    commit_count: commitCount,
    remotes: identity.remotes,
    commits: commitStyle(log, bodies),
    branches: branchPatterns(names, def),
    local_hooks_dir: hooksPath || null,
    git_hooks: gitHooks,
    _names: names,
    _log: log,
  };
}

const STYLES = [
  ['conventional', /^(feat|fix|chore|docs|refactor|test|tests|perf|build|ci|style|revert)(\([^)]+\))?!?: /i],
  ['bracket-tag', /^\[[^\]\s]{1,24}\]\s/],
  ['ticket-prefix', /^[A-Z][A-Z0-9]+-\d+[:\s]/],
  ['gitmoji', /^(:\w+:|[\u{1F300}-\u{1FAFF}☀-➿])/u],
  ['issue-ref', /^#\d+\s/],
];
const PL_WORDS = /\b(dodaj|dodano|popraw|poprawk|usuń|usuń|zmień|zmiana|wg|oraz|dla|nie|się|przenieś|aktualizuj|naprawa|wersj)\w*/i;

function commitStyle(log, bodies) {
  const own = log.filter((c) => !c.merge && c.subject);
  const n = own.length;
  if (!n) return { sampled: log.length, style: null };
  const counts = Object.fromEntries(STYLES.map(([k, re]) => [k, own.filter((c) => re.test(c.subject)).length]));
  const [best, bestN] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const style = bestN / n >= 0.6 ? best : 'plain';
  const pl = own.filter((c) => /[ąćęłńóśźż]/i.test(c.subject) || PL_WORDS.test(c.subject)).length / n;
  const tag = style === 'bracket-tag' ? top([...new Set(own.map((c) => (c.subject.match(/^\[([^\]\s]{1,24})\]/) || [])[1]).filter(Boolean))], 3) : undefined;
  const sorted = own.map((c) => c.subject.length).sort((a, b) => a - b);
  return {
    sampled: log.length, style, confidence: +(style === 'plain' ? 1 - bestN / n : bestN / n).toFixed(2), tags: tag,
    language: pl >= 0.5 ? 'pl' : pl <= 0.1 ? 'en' : 'mixed',
    median_len: sorted[Math.floor(n / 2)],
    capitalized: +(own.filter((c) => /^\p{Lu}/u.test(c.subject.replace(/^\[[^\]]*\]\s*/, ''))).length / n).toFixed(2),
    merge_commits: log.filter((c) => c.merge).length,
    pr_merges: log.filter((c) => /^Merge pull request #\d+/.test(c.subject)).length,
    squash_pr_suffix: own.filter((c) => /\(#\d+\)$/.test(c.subject)).length,
    ai_trailers: (bodies.match(/^co-authored-by:.*(claude|copilot|gpt|codex|gemini|cursor|aider|openai|anthropic)/gim) || []).length,
    examples: top(own, 3).map((c) => clip(c.subject, 90)),
  };
}

function branchPatterns(names, def) {
  const counts = new Map();
  const fixed = [];
  for (const n of names) {
    if (!n.includes('/')) { fixed.push(n); continue; }
    const pat = `${n.split('/')[0].replace(/\d+/g, 'NN')}/<topic>`;
    const e = counts.get(pat) || { pattern: pat, n: 0, example: n };
    e.n++;
    counts.set(pat, e);
  }
  return { count: names.length, fixed: top(fixed, 10), patterns: top([...counts.values()].sort((a, b) => b.n - a.n), 5), default: def };
}

// ---------------------------------------------------------------- stack and commands
const ROLES = { test: ['test', 'test:unit', 'unit', 'tests'], typecheck: ['typecheck', 'type-check', 'check:types', 'tsc', 'types'], lint: ['lint', 'lint:ci', 'eslint'], build: ['build'], dev: ['dev', 'develop', 'start:dev', 'serve'], format: ['format:check', 'prettier:check', 'check:format'] };
const NPM_BUILTIN = new Set(['install', 'i', 'ci', 'add', 'remove', 'update', 'exec', 'dlx', 'run', 'test', 'start', 'init', 'publish', 'pack', 'link', 'audit']);

function runCmd(pm, script) {
  if (pm === 'npm') return ['test', 'start'].includes(script) ? `npm ${script}` : `npm run ${script}`;
  if (pm === 'bun') return `bun run ${script}`;
  return `${pm} ${script}`;
}

function detectStack(io, root) {
  const rootNames = new Set(io.list('').map((e) => e.name));
  const manifests = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'Makefile', 'tox.ini'].filter((f) => rootNames.has(f));
  const languages = [];
  const commands = {};
  const checks = [];
  let pm = null;
  const set = (role, cmd, source, inferred = false) => { if (!commands[role]) commands[role] = { cmd, source, ...(inferred ? { inferred: true } : {}) }; };
  const scripts = {};
  if (rootNames.has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(io.read('package.json') || '{}'); } catch { /* unreadable manifest: skip */ }
    Object.assign(scripts, pkg.scripts || {});
    pm = (pkg.packageManager || '').split('@')[0] || (rootNames.has('pnpm-lock.yaml') || rootNames.has('pnpm-workspace.yaml') ? 'pnpm' : rootNames.has('yarn.lock') ? 'yarn' : rootNames.has('bun.lockb') || rootNames.has('bun.lock') ? 'bun' : 'npm');
    languages.push(rootNames.has('tsconfig.json') || pkg.devDependencies?.typescript || pkg.dependencies?.typescript ? 'typescript' : 'javascript');
    for (const [role, names] of Object.entries(ROLES)) {
      const hit = names.find((n) => scripts[n]);
      if (hit) set(role, runCmd(pm, hit), `package.json scripts.${hit}`);
    }
    if (!commands.typecheck && rootNames.has('tsconfig.json') && (pkg.devDependencies?.typescript || pkg.dependencies?.typescript)) set('typecheck', `${pm === 'npm' ? 'npx' : pm === 'bun' ? 'bunx' : `${pm} exec`} tsc --noEmit`, 'tsconfig.json + typescript dependency (inferred)', true);
    for (const n of Object.keys(scripts)) if (/^(check|verify|validate|ci)(:|$)/.test(n)) checks.push({ cmd: runCmd(pm, n), source: `package.json scripts.${n}` });
  }
  if (rootNames.has('Makefile')) {
    const mk = io.read('Makefile') || '';
    const targets = new Set([...mk.matchAll(/^([A-Za-z0-9_][\w.-]*):(?!=)/gm)].map((m) => m[1]));
    for (const role of ['test', 'typecheck', 'lint', 'build']) if (targets.has(role)) set(role, `make ${role}`, `Makefile target ${role}`);
    for (const t of ['check', 'ci', 'verify']) if (targets.has(t)) checks.push({ cmd: `make ${t}`, source: `Makefile target ${t}` });
    languages.push('make');
  }
  if (rootNames.has('pyproject.toml') || rootNames.has('requirements.txt') || rootNames.has('tox.ini')) {
    languages.push('python');
    const py = rootNames.has('pyproject.toml') ? io.read('pyproject.toml') || '' : '';
    if (/\[tool\.pytest|pytest/.test(py) || rootNames.has('tox.ini')) set('test', rootNames.has('tox.ini') ? 'tox' : 'pytest', rootNames.has('tox.ini') ? 'tox.ini' : 'pyproject.toml');
    if (/\[tool\.ruff/.test(py)) set('lint', 'ruff check .', 'pyproject.toml [tool.ruff]');
    if (/\[tool\.mypy/.test(py)) set('typecheck', 'mypy .', 'pyproject.toml [tool.mypy]');
  }
  if (rootNames.has('go.mod')) { languages.push('go'); set('test', 'go test ./...', 'go.mod'); set('lint', 'go vet ./...', 'go.mod'); set('build', 'go build ./...', 'go.mod'); }
  if (rootNames.has('Cargo.toml')) { languages.push('rust'); set('test', 'cargo test', 'Cargo.toml'); set('lint', 'cargo clippy', 'Cargo.toml'); set('build', 'cargo build', 'Cargo.toml'); }
  if (rootNames.has('pom.xml')) { languages.push('java'); set('test', 'mvn test', 'pom.xml'); set('build', 'mvn package', 'pom.xml'); }
  if (rootNames.has('build.gradle') || rootNames.has('build.gradle.kts')) { languages.push('java/kotlin'); set('test', './gradlew test', 'build.gradle'); set('build', './gradlew build', 'build.gradle'); }
  if ([...rootNames].some((n) => /\.(sln|csproj)$/.test(n))) { languages.push('dotnet'); set('test', 'dotnet test', '*.sln/*.csproj'); set('build', 'dotnet build', '*.sln/*.csproj'); }
  return { languages: [...new Set(languages)], package_manager: pm, manifests, commands, checks, _scripts: scripts, _make: rootNames.has('Makefile') };
}

// true: the thing the command names exists; false: it names something that does not; null: cannot tell offline.
function verifyCmd(cmd, stack, io) {
  const m = cmd.match(/^(pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/);
  if (m) {
    if (m[2] in stack._scripts) return true;
    if (NPM_BUILTIN.has(m[2]) || /^(exec|dlx|x)$/.test(m[2])) return null;
    return false;
  }
  const n = cmd.match(/^node\s+(?:--[\w-]+(?:=\S+)?\s+)*(\S+)/);
  if (n && /^-/.test(n[1])) return null;
  if (n && !/^["'{]/.test(n[1])) return io.exists(n[1].replace(/^\.\//, ''));
  const mk = cmd.match(/^make\s+([\w.-]+)/);
  if (mk) return stack._make ? new RegExp(`^${mk[1].replace(/[.]/g, '\\.')}:`, 'm').test(io.read('Makefile') || '') : false;
  return null;
}

// ---------------------------------------------------------------- documents: headings and key sentences
// Topic patterns run per SENTENCE (a block of a doc mixes topics); a sentence may carry several tags.
const TOPICS = {
  commit: /\bcommit(s|ted|ting)?\b|\bcommity\b|zatwierdz/i,
  push: /\bgit push\b|\bpush(es|ed|ing)?\b[^.]{0,30}\b(remote|origin|branch|main|to)\b|\b(never|do not|don't|only|nigdy|nie)\b[^.]{0,30}\bpush\b|\bpush\b[^.]{0,30}\b(forbidden|allowed|only|yes)\b/i,
  authorship: /co-?authored|authorship|attribution|generated with|\bno ai\b|\bai\/tool\b/i,
  branch: /\bbranch(es)?\b|\bgałąź|\bgałęz|pull request|\bPRs?\b|\brebase\b|\bsquash\b|\bmerge[ds]?\s+(in)?to\b/i,
  protected: /(never|do not|don't|must not|nie wolno|nigdy)[^.]{0,50}(edit|touch|modify|by hand|hand|commit to|push to|delete|drop|force|straight)|\bgenerated\b|protected|read[- ]only|ask first|zapytaj/i,
  docs_duty: /\b(update|keep|maintain|add|record|log|document|regenerate|move|write|aktualizuj|dodaj|zapisz)\b[^.]{0,80}\b(docs?|documentation|changelog|readme|map|adr|decisions?|dokumentac\w*|log\.md)\b|\b(docs?|map|changelog|documentation)\b[^.]{0,40}\b(current|up to date|in the same (change|commit|pr))\b/i,
  done: /definition of done|\bdone\b\s*(=|:|when|means)|\bDoD\b|acceptance criteria|before (you )?(merge|commit|finish|call|open)|gotowe|checklist/i,
  privacy: /gdpr|rodo|personal data|dane osobow|\bpii\b|customer data|confidential|poufn/i,
};
const TOPIC_CAP = { commit: 4, push: 3, authorship: 2, branch: 4, protected: 3, docs_duty: 4, done: 3, privacy: 3 };
const PRESCRIPTIVE_SRC = "\\b(never|always|must|only|do not|don't|should|required|forbidden|mandatory|ask first|not allowed|before|every|each)\\b|\\b(nigdy|zawsze|musi|tylko|nie wolno|zakaz|wymagane)\\b";
const prescriptive = (t) => (t.match(new RegExp(PRESCRIPTIVE_SRC, 'gi')) || []).length;
const EVIDENCE_KINDS = new Set(['ai-rules', 'contributing', 'readme', 'arch', 'doc', 'skill', 'command', 'template', 'security']);
const HEADING_KINDS = new Set(['ai-rules', 'contributing', 'readme', 'arch']);
const sentences = (text) => (text.includes(' | ') ? [text] : text.split(/(?<=[.!?])\s+(?=[A-Z`"[(])/).map((s) => s.trim()).filter(Boolean));

function logicalBlocks(text) {
  const blocks = [];
  let cur = null;
  let fence = false;
  let front = false;
  const heads = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (i === 0 && raw.trim() === '---') { front = true; return; }
    if (front) { if (raw.trim() === '---') front = false; return; }
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; cur = null; return; }
    if (fence) return;
    const t = raw.trim();
    if (!t || /^\|[\s:|-]+\|?$/.test(t) || /^---+$/.test(t)) { cur = null; return; }
    const h = t.match(/^#{1,3}\s+(.+)/);
    if (h) heads.push(clip(h[1].replace(/[*`]/g, ''), 40));
    const start = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(t) || !cur;
    const clean = t.replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ');
    if (start) { cur = { line: i + 1, text: clean }; blocks.push(cur); } else cur.text += ` ${clean}`;
  });
  return { blocks, heads };
}

function readDocs(io, files, ctx) {
  const found = [];
  const byTopic = Object.fromEntries(Object.keys(TOPICS).map((k) => [k, []]));
  const cited = new Map();
  let readCount = 0;
  for (const f of files) {
    if (f.virtual) continue;
    const entry = { path: f.path, kind: f.kind, bytes: io.size(f.path) };
    if (EVIDENCE_KINDS.has(f.kind) && readCount < 30 && /\.(md|mdx|rst|txt)$/i.test(f.path)) {
      readCount++;
      const text = io.read(f.path, 100 * 1024) || '';
      const { blocks, heads } = logicalBlocks(text);
      if (heads.length && HEADING_KINDS.has(f.kind)) entry.h = top(heads, 6);
      for (const m of text.matchAll(/`((?:pnpm|npm|yarn|bun|npx|make|node|cargo|go|pytest|python3?|poetry|uv|dotnet|mvn|gradle|\.\/gradlew)\s[^`<>…]{1,70})`/g)) {
        const cmd = m[1].trim().replace(/:\*$/, '');
        const e = cited.get(cmd) || { cmd, files: [] };
        if (!e.files.includes(f.path)) e.files.push(f.path);
        cited.set(cmd, e);
      }
      for (const b of blocks) {
        for (const unit of sentences(b.text)) {
          if (unit.length < 12 || unit.length > 400 || scanSecrets(unit).length) continue;
          // prescriptive wording first; then rule files over other docs, short sentences over long ones, prose over table rows
          const score = prescriptive(unit) + (f.kind === 'ai-rules' ? 2 : 0) + (unit.length <= 140 ? 1 : 0) - (unit.includes(' | ') ? 1 : 0);
          for (const [topic, re] of Object.entries(TOPICS)) {
            if (re.test(unit)) byTopic[topic].push({ file: f.path, line: b.line, text: unit, score, order: found.length });
          }
        }
      }
    }
    found.push(entry);
  }
  // one list: a sentence with several topics appears once, tagged; each topic contributes its most prescriptive sentences
  const items = new Map();
  for (const [topic, list] of Object.entries(byTopic)) {
    list.sort((a, b) => b.score - a.score || a.order - b.order || a.line - b.line);
    for (const e of top(list, TOPIC_CAP[topic])) {
      const k = e.text.toLowerCase();
      if (!items.has(k)) items.set(k, { ...e, tags: [] });
      items.get(k).tags.push(topic);
    }
  }
  const evidence_items = [...items.values()];
  return {
    found, _full: byTopic, evidence_items,
    evidence: evidence_items.map((e) => `[${e.tags.join(',')}] ${e.file}:${e.line} ${clip(e.text, 170)}`),
    cited: top([...cited.values()].filter((c) => !/^(pnpm|npm|yarn|bun)\s+(install|add|i|ci|exec|dlx)\b/.test(c.cmd)).map((c) => ({ cmd: c.cmd, file: c.files[0], n: c.files.length, verified: verifyCmd(c.cmd, ctx.stack, io) })), 12),
  };
}

// ---------------------------------------------------------------- policies
function settingsFacts(io) {
  const raw = io.exists('.claude/settings.json') ? io.read('.claude/settings.json') : null;
  if (!raw) return null;
  let s;
  try { s = JSON.parse(raw); } catch { return { path: '.claude/settings.json', error: 'unparseable' }; }
  const perms = s.permissions || {};
  const verb = (v) => {
    const re = new RegExp(`^Bash\\(git ${v}(:\\*|\\s\\*)?\\)$`);
    const any = new RegExp(`^Bash\\(git ${v}\\b`);
    return (perms.deny || []).some((x) => re.test(x)) ? 'deny' : (perms.ask || []).some((x) => any.test(x)) ? 'ask' : (perms.allow || []).some((x) => any.test(x)) ? 'allow' : null;
  };
  return {
    path: '.claude/settings.json', git_commit: verb('commit'), git_push: verb('push'),
    attribution: s.attribution ? { commit: s.attribution.commit ?? null, pr: s.attribution.pr ?? null } : null,
    include_co_authored_by: s.includeCoAuthoredBy ?? null,
    deny: top((perms.deny || []).map((x) => clip(String(x), 60)), 8),
    hooks: Object.keys(s.hooks || {}),
  };
}

function ciFacts(io, files) {
  const runs = [];
  const branches = new Set();
  const names = [];
  for (const f of files.filter((x) => x.kind === 'ci')) {
    names.push(f.path);
    const lines = (io.read(f.path, 100 * 1024) || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const run = lines[i].match(/^(\s*)-?\s*run:\s*(.*)$/);
      if (run) {
        const v = run[2].trim();
        if (/^[|>][+-]?$/.test(v)) {
          for (let j = i + 1; j < lines.length && (!lines[j].trim() || lines[j].match(/^\s*/)[0].length > run[1].length); j++) if (lines[j].trim() && !lines[j].trim().startsWith('#')) runs.push(lines[j].trim());
        } else if (v) runs.push(/^(["']).*\1$/.test(v) ? v.slice(1, -1) : v);
      }
      const br = lines[i].match(/^\s*branches(?:-ignore)?:\s*\[(.*)\]/);
      if (br) br[1].split(',').forEach((b) => branches.add(b.trim().replace(/^["']|["']$/g, '')));
      else if (/^\s*branches:\s*$/.test(lines[i])) for (let j = i + 1; j < lines.length && /^\s+-\s/.test(lines[j]); j++) branches.add(lines[j].replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, ''));
    }
  }
  const SETUP = /^(pnpm|npm|yarn|bun)\s+(install|i|ci)\b|^pip\s+install|^corepack|^echo|^cd\s|^export\s|^mkdir|^rm\s|^cp\s|^curl|^ssh|^scp|^rsync|^docker\s+(push|login)|^sudo|^git\s|^set\s|^if\s|^fi$|^\$|^source\s|^[A-Z_][A-Z0-9_]*=|^(else|elif|then|do|done|fi)\b|^[{}]$/;
  // multi-line scripts leave continuation fragments (flags, quoted args, `exit`): only lines that start like a command count
  const commands = [...new Set(runs.map((r) => r.trim()).filter((r) => r && !SETUP.test(r) && !/\\$/.test(r) && /^[A-Za-z.]/.test(r) && !/^exit\b/.test(r)))];
  return { files: names, commands: top(commands, 12), branches: top([...branches].filter(Boolean), 8) };
}

const classify = (cmd) => (/\b(test|pytest|vitest|jest|mocha)\b|--test\b/.test(cmd) ? 'test' : /\btsc\b|typecheck|type-check|mypy|pyright/.test(cmd) ? 'typecheck' : /\blint\b|eslint|ruff|clippy|flake8|golangci/.test(cmd) ? 'lint' : /\bbuild\b/.test(cmd) ? 'build' : /\b(check|validate|verify)/.test(cmd) ? 'extra' : null);

function codeowners(io, files) {
  const f = files.find((x) => x.kind === 'codeowners');
  if (!f) return null;
  const rules = (io.read(f.path) || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return { path: f.path, rules: rules.length, patterns: top(rules.map((r) => r.split(/\s+/)[0]), 6) };
}

function prTemplate(io, files) {
  const f = files.find((x) => x.kind === 'template');
  if (!f) return null;
  const items = (io.read(f.path) || '').split(/\r?\n/).filter((l) => /^\s*[-*]\s*\[[ xX]\]/.test(l)).map((l) => clip(l.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, '').trim(), 100));
  return { path: f.path, checklist: top(items, 8) };
}

// What the history proves about documentation duties (a fact, not a claim in a doc).
function historyDuties(root, files) {
  const log = (git(root, ['log', '-n', '30', '--name-only', '--format=%x1e']) || '').split('\x1e').map((s) => s.split(/\r?\n/).filter(Boolean)).filter((c) => c.length);
  const changelog = files.find((f) => f.kind === 'changelog');
  return {
    commits_checked: log.length,
    changelog: changelog ? { path: changelog.path, touched_in: log.filter((c) => c.includes(changelog.path)).length } : null,
    docs_touched_in: log.filter((c) => c.some((p) => /^docs?\//.test(p))).length,
  };
}

// ---------------------------------------------------------------- orchestrators, sensitivity, critical paths
const OTHER_TOOLS = ['.cursor/rules', '.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md', '.aider.conf.yml', 'CONVENTIONS.md', 'GEMINI.md', '.codex', '.continue', '.kilocode', '.roo', '.agents'];

function orchestratorFacts(io, root, files) {
  const names = (dir, ext) => io.list(dir).filter((e) => (ext ? !e.dir && e.name.endsWith(ext) : e.dir)).map((e) => e.name.replace(ext || '', ''));
  return {
    repo_level: projectOrchestrators(root).map((o) => ({ kind: o.kind, name: o.name, invoke: o.invoke, path: norm(path.relative(root, o.path)) })),
    agents: top(names('.claude/agents', '.md'), 20),
    skills: top(names('.claude/skills'), 24),
    commands: top(names('.claude/commands', '.md'), 12),
    docs: files.filter((f) => f.kind === 'doc' && /orchestrat|delegate|parallel|multi-?agent/i.test(f.path)).map((f) => f.path),
    other_tools: OTHER_TOOLS.filter((t) => io.exists(t)),
  };
}

function sensitivityFacts(reg, inv) {
  const names = new Set([...inv.tracked, ...inv.untracked, ...inv.walked]);
  const trackedSet = new Set(inv.tracked);
  const all = [...names];
  const hits = matchGlobList(reg.meta.sensitive_globs || [], all).map((h) => h.file).filter((p) => !CODE_EXT.test(p));
  const secrets = hits.filter((p) => !TEMPLATE_ENV.test(p));
  const templates = hits.filter((p) => TEMPLATE_ENV.test(p));
  const piiDirs = inv.dirs.filter((d) => /(^|\/)(customers?|clients?|patients?|pii|dumps?|backups?|personal|gdpr|rodo)(\/|$)/i.test(d) && !TEST_DIR.test(d));
  const dataFiles = all.filter((p) => /\.(sql|dump|sqlite3?|db|csv)$/i.test(p) && !TEST_DIR.test(p) && !/(^|\/)(migrations?|schema)(\/|$)/i.test(p));
  return {
    secret_files: top(secrets.map((p) => ({ path: p, tracked: trackedSet.has(p) })), 12),
    secret_files_total: secrets.length,
    env_templates: top(templates, 4),
    pii_dirs: top(piiDirs, 6),
    data_files: { total: dataFiles.length, sample: top(dataFiles, 5) },
  };
}

const CRIT_SEG = /^(auth|authn|authz|accounts?|login|logout|sessions?|passkeys?|oauth|sso|security|payments?|billing|stripe|checkout|invoices?|migrations?|secrets?|permissions?|rbac|acl|crypto|encryption)$/i;
const NON_CODE = /\.(md|mdx|json|lock|css|scss|svg|png|jpg|snap)$/i;
const INFRA_SEG =/^(terraform|infra|infrastructure|k8s|helm|deploy|deployment)$/i;

function criticalPaths(inv, io) {
  const out = [];
  const chosen = [];
  const dirs = [...inv.dirs].filter((d) => !SKIP_DIRS.has(d.split('/').pop()) && !TEST_DIR.test(d) && !/^(docs?|documentation)(\/|$)/i.test(d)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const d of dirs) {
    const seg = d.split('/').pop();
    if (chosen.some((c) => d.startsWith(`${c}/`))) continue;
    const why = CRIT_SEG.test(seg) ? 'auth/payments/migrations area' : INFRA_SEG.test(seg) ? 'infrastructure/deploy' : null;
    if (why) { chosen.push(d); out.push({ glob: `${d}/**`, why }); }
  }
  const rootNames = io.list('').map((e) => e.name);
  if (rootNames.some((n) => /^Dockerfile/.test(n))) out.push({ glob: 'Dockerfile*', why: 'container build' });
  if (rootNames.some((n) => /^docker-compose.*\.ya?ml$/.test(n))) out.push({ glob: 'docker-compose*.y*ml', why: 'deploy config' });
  if (inv.dirs.includes('.github/workflows')) out.push({ glob: '.github/workflows/**', why: 'CI/CD' });
  if (rootNames.includes('.gitlab-ci.yml')) out.push({ glob: '.gitlab-ci.yml', why: 'CI/CD' });
  if (inv.tracked.some((p) => /(^|\/)schema\.prisma$/.test(p))) out.push({ glob: '**/schema.prisma', why: 'database schema' });
  // single files named like the sensitive areas (src/lib/auth.ts, src/proxy.ts) that no chosen directory already covers
  const stem = (p) => p.split('/').pop().replace(/\.[^.]+$/, '');
  const fileHits = inv.tracked.filter((p) => !TEST_DIR.test(p) && !/^(docs?|documentation)\//i.test(p) && !NON_CODE.test(p) && (CRIT_SEG.test(stem(p)) || /^(middleware|proxy)$/i.test(stem(p))) && !chosen.some((c) => p.startsWith(`${c}/`))).sort();
  for (const p of top(fileHits, 6)) out.push({ glob: p, why: 'security-relevant file' });
  return top(out, 14);
}

// ---------------------------------------------------------------- conflicts and hints
const RE_ONLY = /only (the )?(orchestrator|lead|main session|maintainers?|humans?|me|owner)\b[^.]{0,40}\bcommit|commits? (are )?(made |done )?only by/i;
const RE_FORBID = (verb) => new RegExp(`\\b(never|do not|don't|must not|nie wolno|nie ${verb}uj)\\b[^.]{0,20}\\b(auto-?)?${verb}\\b(?!\\s+(straight |directly )?(to|on|into)\\b)`, 'i');
const RE_ASK = (verb) => new RegExp(`(ask|confirm|permission|approval)[^.]{0,30}(before|prior to)[^.]{0,20}${verb}|${verb}[^.]{0,30}(only )?(when|if) (asked|requested|told)`, 'i');
const RE_NO_PR = /never through (our )?PRs?|no pull requests|do not open (a )?pr|PRs? (are )?(opened|created) (only )?by (hand|humans|the user)/i;
const RE_NO_AI = /no (ai|tool|llm|claude|assistant)[^.]{0,30}(author|attribution|credit|trailer|co-?author)|never add (a )?co-?authored|do not (add|include)[^.]{0,30}co-?authored/i;

function docHint(blocks, verb) {
  const text = blocks.map((b) => b.text);
  if (verb === 'commit' && text.some((t) => RE_ONLY.test(t))) return 'orchestrator_only';
  if (text.some((t) => RE_FORBID(verb).test(t))) return 'forbidden';
  if (text.some((t) => RE_ASK(verb).test(t))) return 'ask_first';
  return null;
}

function derive(facts) {
  const full = facts._docs._full;
  const names = facts.git._names;
  const settings = facts.policies.settings;
  const commit = { settings: settings?.git_commit ?? null, docs: docHint(full.commit, 'commit') };
  const push = { settings: settings?.git_push ?? null, docs: docHint(full.push, 'push') };
  const noAi = !!(full.authorship.some((b) => RE_NO_AI.test(b.text)) || settings?.attribution?.commit === '' || settings?.include_co_authored_by === false);
  // a rule about branches may not use the word "branch" ("Never commit directly to `main`"): commit and protected sentences count too
  const branchBlocks = [...new Set([...full.branch, ...full.commit, ...full.protected])];
  const base = (() => {
    for (const b of branchBlocks) {
      const m = b.text.match(/`([\w./-]+)`\s+is\s+the\s+(development|dev|integration|base)\s+(base|branch)|(base|target)\s+branch[^`]{0,20}`([\w./-]+)`/i);
      const name = m && (m[1] || m[5]);
      if (name && names.includes(name)) return name;
    }
    return null;
  })();
  const protectedBranches = (() => {
    const set = new Set();
    for (const b of branchBlocks.filter((x) => RE_FORBID('commit').test(x.text) || /never (commit|push)/i.test(x.text))) {
      for (const m of b.text.matchAll(/`([\w./-]+)`/g)) if (names.includes(m[1])) set.add(m[1]);
      for (const m of b.text.matchAll(/\b([\w-]+)\/`?\s+branch/gi)) set.add(`${m[1]}/*`);
    }
    return [...set];
  })();
  const prNever = branchBlocks.some((b) => RE_NO_PR.test(b.text));
  return { commit, push, no_ai_attribution: noAi, docs_base_branch: base, protected_branches: protectedBranches, pr_never: prNever };
}

function conflicts(facts, hints) {
  const out = [];
  const def = facts.git.default_branch?.name;
  if (hints.docs_base_branch && def && hints.docs_base_branch !== def) out.push({ id: 'base_branch', detail: `docs name \`${hints.docs_base_branch}\` as the development base, git default is \`${def}\`` });
  const sc = facts.policies.settings;
  if (sc && hints.commit.docs === 'forbidden' && sc.git_commit === 'allow') out.push({ id: 'commit_vs_settings', detail: 'docs forbid commits but .claude/settings.json allows git commit' });
  if (sc && ['forbidden', 'ask_first'].includes(hints.push.docs || '') && sc.git_push === 'allow') out.push({ id: 'push_vs_settings', detail: `docs say push is ${hints.push.docs} but .claude/settings.json allows git push (the orchestrator pushes only after an explicit yes either way)` });
  const bad = facts.stack.docs_commands.filter((c) => c.verified === false);
  if (bad.length) out.push({ id: 'docs_command_unverified', detail: `docs cite commands that do not exist here: ${bad.map((c) => c.cmd).join('; ')}` });
  const tracked = facts.sensitivity.secret_files.filter((s) => s.tracked);
  if (tracked.length) out.push({ id: 'tracked_secret', detail: `secret-like files are tracked by git: ${tracked.map((s) => s.path).join(', ')}` });
  if (facts.orchestrators.repo_level.length) out.push({ id: 'orchestrator', detail: `the repo ships its own orchestrator: ${facts.orchestrators.repo_level.map((o) => o.invoke).join(', ')}` });
  if (facts.git.dirty.total) out.push({ id: 'dirty_tree', detail: `${facts.git.dirty.total} uncommitted changes exist (init does not touch them)` });
  return out;
}

// ---------------------------------------------------------------- scan
export function scanRepo(root, { reg = loadRegistry(), onRead } = {}) {
  const started = Date.now();
  const identity = repoIdentity(root);
  if (repoIsEmpty(root)) return { scan_version: SCAN_VERSION, root, empty: true, identity: { id: identity.id, kind: identity.kind } };
  const globs = (reg.meta.sensitive_globs || []).map((g) => globToRegex(g));
  const deny = (rel) => DEFAULT_DENY(rel) || globs.some((re) => re.test(norm(rel)));
  const io = fsIo(root, { deny, onRead });
  const inv = inventory(root);
  const disc = discoverPolicyDocs(io);
  const g = gitFacts(root, identity);
  const stack = detectStack(io, root);
  const ctx = { stack };
  const docs = readDocs(io, disc.files, ctx);
  stack.docs_commands = docs.cited;
  const ci = ciFacts(io, disc.files);
  const policies = {
    settings: settingsFacts(io),
    ci: { ...ci, verification: ci.commands.map((c) => ({ cmd: c, role: classify(c) })).filter((c) => c.role) },
    hooks: { husky: io.exists('.husky') ? io.list('.husky').filter((e) => !e.dir && !e.name.startsWith('_')).map((e) => e.name) : [], lefthook: io.exists('lefthook.yml') || io.exists('lefthook.yaml'), pre_commit: io.exists('.pre-commit-config.yaml'), git_hooks: g.git_hooks, hooks_path: g.local_hooks_dir },
    codeowners: codeowners(io, disc.files),
    pr_template: prTemplate(io, disc.files),
    history: historyDuties(root, disc.files),
  };
  const facts = { git: g, stack, policies, sensitivity: sensitivityFacts(reg, inv), orchestrators: orchestratorFacts(io, root, disc.files), _docs: docs };
  const hints = derive(facts);
  const fp = computeFingerprint(io, disc.files);
  const result = {
    scan_version: SCAN_VERSION, root, empty: false,
    identity: { id: identity.id, kind: identity.kind, aliases: identity.candidates.filter((c) => c !== identity.id) },
    repo: { default_branch: g.default_branch, current_branch: g.current_branch, dirty: g.dirty, remotes: g.remotes, commit_count: g.commit_count, files: inv.file_count, is_git: inv.is_git },
    commits: g.commits, branches: g.branches,
    stack: { languages: stack.languages, package_manager: stack.package_manager, manifests: stack.manifests, commands: stack.commands, checks: stack.checks, docs_commands: docs.cited },
    docs: { found: docs.found, dirs: disc.doc_dirs, evidence: docs.evidence, evidence_items: docs.evidence_items, history: policies.history },
    policies: { settings: policies.settings, ci: policies.ci, hooks: policies.hooks, codeowners: policies.codeowners, pr_template: policies.pr_template, hints },
    orchestrators: facts.orchestrators,
    sensitivity: facts.sensitivity,
    critical_paths: criticalPaths(inv, io),
    conflicts: conflicts({ ...facts, stack: { ...stack, docs_commands: docs.cited } }, hints),
    fingerprint: fp,
    took_ms: Date.now() - started,
  };
  return result;
}

// Compact print form: the fingerprint's per-file map is for the profile, not for the model.
export function compactScan(scan) {
  const { fingerprint, ...rest } = scan;
  if (!fingerprint) return rest;
  const { evidence_items, found, ...docs } = rest.docs;
  return {
    ...rest,
    docs: { ...docs, found: found.map((f) => `${f.path} (${f.kind}, ${f.bytes ?? '?'}B)${f.h ? `: ${f.h.join(' / ')}` : ''}`) },
    fingerprint: { hash: fingerprint.hash, files: Object.keys(fingerprint.sources).length },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = parseArgs(process.argv.slice(2), { flags: ['full', 'pretty'] });
  const root = a.repo ? path.resolve(a.repo) : repoRoot();
  if (!root) fail('not inside a repo (pass --repo <path>)');
  else process.stdout.write(`${JSON.stringify(a.full ? scanRepo(root) : compactScan(scanRepo(root)), null, a.pretty ? 2 : 0)}\n`);
}
