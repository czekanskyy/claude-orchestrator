// Repository facts shared by repo-scan.mjs (init) and the profile checks (preflight, doctor): read-only git access,
// repo identity, guarded file reads, policy-document discovery and the fingerprint used to detect a stale profile.
// Standalone (no registry): imported by common.mjs through repo-profile.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const sha = (s, n = 12) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);
export const norm = (p) => String(p).replace(/\\/g, '/');
export const normPath = (p) => norm(path.resolve(p)).replace(/\/$/, '').toLowerCase();

// Read-only git: --no-optional-locks keeps `git status` from refreshing (writing) the index.
export function git(root, args, { max = 32 * 1024 * 1024 } = {}) {
  const r = spawnSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', maxBuffer: max, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  return r.status === 0 ? r.stdout : null;
}

// ---------------------------------------------------------------- identity
// github.com/owner/repo for git@github.com:Owner/Repo.git and https://user:token@github.com/Owner/Repo.git alike; credentials are dropped.
export function normalizeRemote(url) {
  let u = String(url || '').trim();
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
  u = u.replace(/^([^/:]+):(?!\d+\/)/, '$1/');
  return u.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

export function remoteList(root) {
  const out = git(root, ['remote', '-v']);
  const seen = new Set();
  const list = [];
  for (const line of (out || '').split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/);
    if (!m) continue;
    const url = m[2].replace(/\/\/[^@/]+@/, '//');
    if (!seen.has(`${m[1]} ${url}`)) { seen.add(`${m[1]} ${url}`); list.push({ name: m[1], url }); }
  }
  return list;
}

// Identity of a repo: its remote (origin first) so the same repo matches on another machine, else the normalized path.
export function repoIdentity(root) {
  const remotes = remoteList(root);
  const ids = remotes.map((r) => normalizeRemote(r.url)).filter(Boolean);
  const origin = remotes.find((r) => r.name === 'origin');
  const primary = origin ? normalizeRemote(origin.url) : ids[0];
  const pathId = normPath(root);
  return { id: primary || pathId, kind: primary ? 'remote' : 'path', path: pathId, candidates: [...new Set([...(primary ? [primary] : []), ...ids, pathId])], remotes };
}

// ---------------------------------------------------------------- guarded io
const MAX_READ = 512 * 1024;
const SECRET_PATH = /(^|\/)(\.env(\.|$)|[^/]*\.(pem|key|p12|pfx|kdbx)$|id_(rsa|ed25519)|\.npmrc$|\.netrc$|credentials|secrets\/|service-account)/i;
export const DEFAULT_DENY = (rel) => SECRET_PATH.test(norm(rel));

// Every content read of a repo goes through io.read: paths matching `deny` (secret files) are refused, never opened.
export function fsIo(root, { deny = DEFAULT_DENY, onRead } = {}) {
  const abs = (rel) => path.join(root, rel);
  return {
    root,
    exists: (rel) => fs.existsSync(abs(rel)),
    list: (rel = '') => {
      try { return fs.readdirSync(abs(rel), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })); } catch { return []; }
    },
    size: (rel) => { try { return fs.statSync(abs(rel)).size; } catch { return null; } },
    read: (rel, max = MAX_READ) => {
      const p = norm(rel);
      if (deny(p)) return null;
      onRead?.(p);
      let fd;
      try {
        fd = fs.openSync(abs(rel), 'r');
        const buf = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.toString('utf8');
      } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
    },
  };
}

// ---------------------------------------------------------------- policy documents
export const MAX_FP_FILES = 60;
const ROOT_DOC = /^(README|CONTRIBUTING|ARCHITECTURE|DEVELOPMENT|HACKING|CONVENTIONS|SECURITY|CLAUDE|AGENTS|GEMINI|CODEOWNERS|CHANGELOG|HISTORY|CHANGES)(\.[A-Za-z]+)?$/i;
const RULE_FILES = ['.cursorrules', '.windsurfrules', '.clinerules', '.aider.conf.yml', 'Makefile'];
const POLICY_NAME = /orchestrat|convention|contribut|workflow|process|policy|guideline|standard|decision|architecture|stack|environment|deploy|release|security|testing|parallel|agents|(^|\/)map\.md$|onboarding|runbook|branch|commit/i;
const POLICY_SUBDIR = /^(adr|adrs|decisions?|rfcs?|runbooks?|architecture|process|policies|policy|workflows?)$/i;
const SKILL_NAME = /orchestrat|finish|done|commit|release|merge|review|deploy|workflow|git|branch|\bpr\b|parallel|worktree|sync/i;
const DOC_EXT = /\.(md|mdx|rst|txt)$/i;

export function docKind(rel) {
  const p = norm(rel);
  const base = p.split('/').pop();
  if (/^\.claude\/settings(\.local)?\.json$/.test(p)) return 'settings';
  if (/^\.claude\/skills\//.test(p)) return 'skill';
  if (/^\.claude\/commands\//.test(p)) return 'command';
  if (/^\.github\/workflows\/|^\.gitlab-ci|^\.circleci\/|^azure-pipelines|^Jenkinsfile|^bitbucket-pipelines/.test(p)) return 'ci';
  if (/PULL_REQUEST_TEMPLATE/i.test(p)) return 'template';
  if (/^(CLAUDE|AGENTS|GEMINI|CONVENTIONS)(\.|$)/i.test(base) || /^\.(cursorrules|windsurfrules|clinerules)$|^\.cursor\/rules\/|copilot-instructions|^\.aider\.conf/.test(p)) return 'ai-rules';
  if (/^README/i.test(base)) return 'readme';
  if (/^CONTRIBUTING/i.test(base)) return 'contributing';
  if (/^(CHANGELOG|HISTORY|CHANGES)/i.test(base)) return 'changelog';
  if (/^CODEOWNERS$/i.test(base)) return 'codeowners';
  if (/^SECURITY/i.test(base)) return 'security';
  if (/^(ARCHITECTURE|DEVELOPMENT|HACKING)/i.test(base)) return 'arch';
  if (/^Makefile$/.test(base) || p === 'package.json#scripts') return 'build';
  return 'doc';
}

// Policy-bearing files of a repo, found with directory listings only (no content reads, no tree walk):
// { files: [{path, kind, fp, virtual?}], doc_dirs: [{dir, total, listed}] }. fp = part of the fingerprint.
export function discoverPolicyDocs(io) {
  const files = [];
  const add = (rel, extra = {}) => { if (!files.some((f) => f.path === rel)) files.push({ path: rel, kind: docKind(rel), fp: docKind(rel) !== 'changelog', ...extra }); };
  for (const e of io.list('')) {
    if (!e.dir && (ROOT_DOC.test(e.name) || RULE_FILES.includes(e.name))) add(e.name);
  }
  if (io.exists('package.json')) add('package.json#scripts', { virtual: true });
  for (const e of io.list('.github')) {
    if (!e.dir && /^(CONTRIBUTING|CODEOWNERS|copilot-instructions)/i.test(e.name)) add(`.github/${e.name}`);
    if (!e.dir && /^PULL_REQUEST_TEMPLATE/i.test(e.name)) add(`.github/${e.name}`);
    if (e.dir && /^PULL_REQUEST_TEMPLATE$/i.test(e.name)) for (const t of io.list(`.github/${e.name}`)) if (!t.dir) add(`.github/${e.name}/${t.name}`);
  }
  for (const e of io.list('.github/workflows')) if (!e.dir && /\.ya?ml$/i.test(e.name)) add(`.github/workflows/${e.name}`);
  for (const f of ['.gitlab-ci.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', 'Jenkinsfile', '.circleci/config.yml', 'docs/CODEOWNERS']) if (io.exists(f)) add(f);
  if (io.exists('.claude/settings.json')) add('.claude/settings.json');
  for (const e of io.list('.claude/skills')) {
    if (e.dir && SKILL_NAME.test(e.name) && io.exists(`.claude/skills/${e.name}/SKILL.md`)) add(`.claude/skills/${e.name}/SKILL.md`);
  }
  for (const e of io.list('.claude/commands')) if (!e.dir && /\.md$/i.test(e.name) && SKILL_NAME.test(e.name)) add(`.claude/commands/${e.name}`);
  for (const e of io.list('.cursor/rules')) if (!e.dir) add(`.cursor/rules/${e.name}`);
  const docDirs = [];
  for (const d of ['docs', 'doc', 'documentation']) {
    const top = io.list(d);
    if (!top.length) continue;
    let total = 0;
    let listed = 0;
    for (const e of top) {
      if (!e.dir && DOC_EXT.test(e.name)) { total++; if (POLICY_NAME.test(`${d}/${e.name}`)) { add(`${d}/${e.name}`); listed++; } }
      if (e.dir && POLICY_SUBDIR.test(e.name)) {
        for (const s of io.list(`${d}/${e.name}`).filter((x) => !x.dir && DOC_EXT.test(x.name)).slice(0, 20)) { total++; listed++; add(`${d}/${e.name}/${s.name}`); }
      } else if (e.dir) total += io.list(`${d}/${e.name}`).filter((x) => !x.dir && DOC_EXT.test(x.name)).length;
    }
    docDirs.push({ dir: d, total, listed });
  }
  const order = ['ai-rules', 'contributing', 'settings', 'template', 'skill', 'command', 'doc', 'arch', 'ci', 'readme', 'security', 'codeowners', 'build', 'changelog'];
  files.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.path.localeCompare(b.path));
  return { files, doc_dirs: docDirs };
}

// ---------------------------------------------------------------- fingerprint
function fileHash(io, rel) {
  if (rel === 'package.json#scripts') {
    try { return sha(JSON.stringify(JSON.parse(io.read('package.json') || '{}').scripts || {})); } catch { return null; }
  }
  const text = io.read(rel);
  return text === null ? null : sha(text.replace(/\r\n/g, '\n'));
}

// The profile is derived from these files: their content hashes decide whether it is stale.
export function computeFingerprint(io, files = discoverPolicyDocs(io).files) {
  const sources = {};
  for (const f of files.filter((x) => x.fp).slice(0, MAX_FP_FILES)) {
    const h = fileHash(io, f.path);
    if (h) sources[f.path] = h;
  }
  const lines = Object.keys(sources).sort().map((k) => `${k}\0${sources[k]}`);
  return { hash: sha(lines.join('\n'), 16), sources };
}

export function diffFingerprint(stored = {}, current = {}) {
  const a = stored.sources || {};
  const b = current.sources || {};
  return {
    changed: Object.keys(a).filter((k) => k in b && a[k] !== b[k]),
    removed: Object.keys(a).filter((k) => !(k in b)),
    added: Object.keys(b).filter((k) => !(k in a)),
  };
}
