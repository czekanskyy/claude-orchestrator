// Per-repository profile written by /orchestrator:init: the decisions that settle repo rules vs orchestrator defaults.
// Stored user-local in ~/.claude/orchestrator/repos/<name>-<hash>.yaml (keyed by repo identity), optionally also as the
// shareable `repo_profile:` block of <repo>/.claude/orchestrator.yaml. Precedence: profile decision > repo's own rules >
// orchestrator defaults (references/repo-init.md). Standalone: imported by common.mjs, so no registry import here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseYaml } from './yaml-lite.mjs';
import { SECRET_KEY, SECRET_VALUE } from './config.mjs';
import { repoIdentity, fsIo, computeFingerprint, diffFingerprint, git, sha } from './repo-facts.mjs';

export const PROFILE_SCHEMA_VERSION = 1;
export const profilesDir = () => path.join(process.env.ORCH_HOME || path.join(os.homedir(), '.claude', 'orchestrator'), 'repos');
// Decisions that describe the repo and may travel with it; the orchestrator choice and EGM stay personal.
export const SHAREABLE = ['commit', 'branching', 'docs_duties', 'verify', 'critical_paths', 'sensitivity'];
export const DECISION_KEYS = ['orchestrator', 'commit', 'branching', 'docs_duties', 'verify', 'critical_paths', 'sensitivity', 'egm'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const defined = (v) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length) && !(isObj(v) && !Object.keys(v).length);
const union = (...lists) => [...new Set(lists.flat().filter((x) => x !== undefined && x !== null))];

// ---------------------------------------------------------------- orchestrator defaults and precedence
export function orchestratorDefaults({ sensitivity = 'internal' } = {}) {
  return {
    orchestrator: 'global',
    commit: { policy: 'orchestrator', granularity: 'checkpoint', attribution: 'default', push: 'ask' },
    branching: { action: 'current_branch', pr: 'ask' },
    docs_duties: [],
    verify: { extra: [], done_when: [] },
    critical_paths: [],
    sensitivity: { default: sensitivity, globs: [] },
    egm: 'ask',
  };
}

// "Stricter" order per field, weakest first: what `merge` picks when both sides have a value.
export const STRICT = {
  'commit.policy': ['orchestrator', 'ask', 'forbidden'],
  'commit.push': ['ask', 'never'],
  'commit.attribution': ['default', 'none'],
  'branching.action': ['current_branch', 'follow_repo', 'ask'],
  'branching.pr': ['ask', 'never'],
  'sensitivity.default': ['none', 'internal', 'sensitive'],
  egm: ['off', 'ask'],
};

// repo's defined fields over the defaults (what the repo says wins, silence falls back to the default)
function overlay(def, repo) {
  if (!isObj(def) || !isObj(repo)) return defined(repo) ? clone(repo) : clone(def);
  const out = clone(def);
  for (const [k, v] of Object.entries(repo)) if (defined(v)) out[k] = isObj(v) && isObj(out[k]) ? overlay(out[k], v) : clone(v);
  return out;
}

// both sides count: the stricter of an ordered field, the union of lists, repo's value for the rest
function stricter(def, repo, p) {
  if (isObj(def) && isObj(repo)) {
    const out = clone(def);
    for (const [k, v] of Object.entries(repo)) out[k] = k in def ? stricter(def[k], v, p ? `${p}.${k}` : k) : clone(v);
    return out;
  }
  if (Array.isArray(def) || Array.isArray(repo)) return union(repo || [], def || []);
  if (!defined(repo)) return clone(def);
  if (!defined(def)) return clone(repo);
  const order = STRICT[p];
  return order ? (order.indexOf(repo) >= order.indexOf(def) ? repo : def) : repo;
}

// choice: repo (the repo's rule wins where it has one) | default (orchestrator default) | merge (stricter / union) | custom
export function settle(key, def, repo, choice = 'repo', custom) {
  if (choice === 'custom') return clone(custom);
  if (key === 'orchestrator') return choice === 'default' || repo === undefined ? def : choice === 'merge' && repo !== def ? 'ask' : repo;
  if (choice === 'default' || repo === undefined) return clone(def);
  return choice === 'merge' ? stricter(def, repo, key) : overlay(def, repo);
}

export const evidenceHash = (repo) => sha(JSON.stringify(repo ?? null), 8);

// answers: { <key>: 'repo'|'default'|'merge' | {choice, value} }; an unanswered key keeps its previous value (refresh, unchanged evidence)
// or follows the repo when the repo has a rule, else the default.
export function applyAnswers(proposal, answers = {}) {
  const decisions = {};
  const choices = {};
  const evidence = {};
  for (const [key, d] of Object.entries(proposal.decisions)) {
    let a = answers[key];
    if (a === undefined) {
      // refresh: a decision whose repo evidence did not change since the last init is kept as it was
      if (d.prev && d.prev.evidence === evidenceHash(d.repo)) { decisions[key] = clone(d.prev.value); choices[key] = d.prev.choice || 'kept'; evidence[key] = d.prev.evidence; continue; }
      a = d.repo !== undefined ? 'repo' : 'default';
      choices[key] = `auto:${a}`;
    } else choices[key] = typeof a === 'string' ? a : a.choice;
    const choice = typeof a === 'string' ? a : a.choice;
    if (!['repo', 'default', 'merge', 'custom'].includes(choice)) throw new Error(`${key}: unknown choice "${choice}"`);
    // the model may refine a repo-derived value with what it read (answers._repo); the evidence hash stays the derived one
    decisions[key] = settle(key, d.def, answers._repo?.[key] ?? d.repo, choice, a.value);
    evidence[key] = evidenceHash(d.repo);
  }
  return { decisions, choices, evidence };
}

// ---------------------------------------------------------------- profile object, validation, yaml
export function buildProfile({ identity, fingerprint, decisions, choices, evidence, today = new Date().toISOString().slice(0, 10), aliases }) {
  return {
    schema_version: PROFILE_SCHEMA_VERSION,
    identity: identity.id,
    aliases: aliases || identity.candidates.filter((c) => c !== identity.id),
    updated: today,
    fingerprint: { hash: fingerprint.hash, sources: fingerprint.sources },
    decisions, choices, evidence,
  };
}

const ENUM = {
  orchestrator: ['global', 'project', 'ask'], 'commit.policy': STRICT['commit.policy'], 'commit.granularity': ['checkpoint', 'task', 'single'],
  'commit.attribution': STRICT['commit.attribution'], 'commit.push': STRICT['commit.push'], 'branching.action': STRICT['branching.action'],
  'branching.pr': STRICT['branching.pr'], 'sensitivity.default': STRICT['sensitivity.default'], egm: STRICT.egm,
};

export function validateProfile(p) {
  const errors = [];
  if (!isObj(p)) return { ok: false, errors: ['profile must be a map'] };
  if (p.schema_version !== PROFILE_SCHEMA_VERSION) errors.push(`schema_version must be ${PROFILE_SCHEMA_VERSION}`);
  if (typeof p.identity !== 'string' || !p.identity) errors.push('identity is required');
  const d = p.decisions;
  if (!isObj(d)) errors.push('decisions must be a map');
  else {
    for (const k of Object.keys(d)) if (!DECISION_KEYS.includes(k)) errors.push(`decisions: unknown key "${k}"`);
    const check = (path_, v) => { if (v !== undefined && ENUM[path_] && !ENUM[path_].includes(v)) errors.push(`decisions.${path_} must be ${ENUM[path_].join('|')} (got ${JSON.stringify(v)})`); };
    check('orchestrator', d.orchestrator);
    for (const f of ['policy', 'granularity', 'attribution', 'push']) check(`commit.${f}`, d.commit?.[f]);
    for (const f of ['action', 'pr']) check(`branching.${f}`, d.branching?.[f]);
    check('sensitivity.default', d.sensitivity?.default);
    check('egm', d.egm);
    for (const k of ['docs_duties', 'critical_paths']) if (d[k] !== undefined && (!Array.isArray(d[k]) || d[k].some((x) => typeof x !== 'string'))) errors.push(`decisions.${k} must be a list of strings`);
  }
  const walk = (v, at) => {
    if (typeof v === 'string' && SECRET_VALUE.test(v)) errors.push(`${at}: looks like a secret; a profile must not store secrets`);
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (SECRET_KEY.test(k) && at !== 'fingerprint.sources') errors.push(`${at}.${k}: secret-like key`); walk(x, `${at}.${k}`); }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
  };
  walk({ ...p, fingerprint: undefined }, 'profile');
  return { ok: errors.length === 0, errors };
}

const q = (s) => JSON.stringify(String(s).replace(/\s*\n\s*/g, ' '));
const scalar = (v) => (typeof v === 'string' ? q(v) : v === null ? 'null' : String(v));
function emit(obj, ind, L) {
  const pad = ' '.repeat(ind);
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = /^[A-Za-z_][\w-]*$/.test(k) ? k : q(k);
    if (isObj(v)) {
      if (!Object.keys(v).length) L.push(`${pad}${key}: {}`);
      else { L.push(`${pad}${key}:`); emit(v, ind + 2, L); }
    } else if (Array.isArray(v)) {
      if (!v.length) L.push(`${pad}${key}: []`);
      else { L.push(`${pad}${key}:`); for (const x of v) L.push(`${pad}  - ${scalar(x)}`); }
    } else L.push(`${pad}${key}: ${scalar(v)}`);
  }
}

export function serializeProfile(p) {
  const L = ['# Orchestrator repo profile. Written by /orchestrator:init; safe to edit by hand (re-run `/orchestrator:init --refresh` to re-derive).', '# Never put secrets here. Precedence: profile decision > repo rules > orchestrator defaults.', ''];
  emit(p, 0, L);
  return `${L.join('\n')}\n`;
}

// ---------------------------------------------------------------- storage (user-local)
export function listProfiles() {
  const dir = profilesDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')); } catch { return []; }
  return names.map((n) => {
    const file = path.join(dir, n);
    try { return { file, data: parseYaml(fs.readFileSync(file, 'utf8')) || {} }; } catch (e) { return { file, data: null, error: e.message }; }
  });
}

export function findLocalProfile(identity) {
  const want = new Set(identity.candidates);
  return listProfiles().find((x) => x.data && [x.data.identity, ...(x.data.aliases || [])].some((i) => want.has(String(i)))) || null;
}

export function profileFileFor(identity) {
  const name = (identity.id.split('/').pop() || 'repo').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 40);
  return path.join(profilesDir(), `${name}-${sha(identity.id, 8)}.yaml`);
}

// Atomic; the previous file is kept as .bak. Returns the file written.
export function writeLocalProfile(profile, identity) {
  const v = validateProfile(profile);
  if (!v.ok) throw new Error(`invalid profile: ${v.errors.join('; ')}`);
  const file = findLocalProfile(identity)?.file || profileFileFor(identity);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serializeProfile(profile));
  fs.renameSync(tmp, file);
  return file;
}

// ---------------------------------------------------------------- storage (shareable block in the repo overlay)
export function sharedBlock(profile) {
  const decisions = Object.fromEntries(Object.entries(profile.decisions).filter(([k]) => SHAREABLE.includes(k)));
  return { schema_version: PROFILE_SCHEMA_VERSION, fingerprint: profile.fingerprint, decisions };
}

// Replaces (or appends) only the top-level `repo_profile:` block; every other line of the file is kept as is.
export function mergeSharedText(existing, profile) {
  const eol = existing && existing.includes('\r\n') ? '\r\n' : '\n';
  const L = [];
  emit({ repo_profile: sharedBlock(profile) }, 0, L);
  if (!existing) return `${['# Orchestrator overlay (shareable). `repo_profile` is written by /orchestrator:init; never put secrets here.', ...L].join(eol)}${eol}`;
  const lines = existing.split(/\r?\n/);
  const i = lines.findIndex((l) => /^repo_profile:\s*(#.*)?$/.test(l));
  if (i >= 0) {
    let j = i + 1;
    while (j < lines.length && (lines[j] === '' || /^\s/.test(lines[j]))) j++;
    lines.splice(i, j - i);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return `${[...lines, ...(lines.length ? [''] : []), ...L].join(eol)}${eol}`;
}

export function writeSharedProfile(root, profile) {
  const file = path.join(root, '.claude', 'orchestrator.yaml');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, mergeSharedText(existing, profile));
  return file;
}

// ---------------------------------------------------------------- reading and status
// {source: local|shared|local+shared|none, profile, file}. The local profile wins per decision key over the shared block.
export function readRepoProfile(root, { shared, identity } = {}) {
  if (!root) return { source: 'none', profile: null };
  let local = null;
  if (listProfiles().length) local = findLocalProfile(identity || repoIdentity(root));
  let sh = shared;
  if (sh === undefined && process.env.ORCH_NO_OVERLAY !== '1') {
    const f = path.join(root, '.claude', 'orchestrator.yaml');
    try { sh = fs.existsSync(f) ? parseYaml(fs.readFileSync(f, 'utf8'))?.repo_profile : null; } catch { sh = null; }
  }
  if (local && local.data === null) return { source: 'invalid', profile: null, file: local.file, error: local.error };
  if (!local && !isObj(sh)) return { source: 'none', profile: null };
  const base = local?.data || { schema_version: PROFILE_SCHEMA_VERSION, identity: '(shared)', decisions: {}, fingerprint: sh.fingerprint };
  const decisions = { ...(isObj(sh) ? sh.decisions : {}), ...(local?.data?.decisions || {}) };
  return { source: local && isObj(sh) ? 'local+shared' : local ? 'local' : 'shared', profile: { ...base, decisions }, file: local?.file || null };
}

// Empty = no commits and nothing but boilerplate files: init has nothing to learn from.
export function repoIsEmpty(root) {
  if (git(root, ['rev-parse', '-q', '--verify', 'HEAD']) !== null) return false;
  let names = [];
  try { names = fs.readdirSync(root); } catch { return true; }
  return !names.some((n) => n !== '.git' && !/^(\.gitignore|\.gitattributes|LICENSE.*|\.DS_Store)$/i.test(n));
}

// state: no-repo | empty | none (non-empty repo without a profile) | ok | stale | invalid
export function repoProfileStatus(root, opts = {}) {
  if (!root) return { state: 'no-repo' };
  if (repoIsEmpty(root)) return { state: 'empty', repo: root };
  const found = readRepoProfile(root, opts);
  if (found.source === 'invalid') return { state: 'invalid', repo: root, source: 'local', file: found.file, errors: [found.error] };
  if (!found.profile) return { state: 'none', repo: root };
  const v = validateProfile({ ...found.profile, identity: found.profile.identity || 'x' });
  if (!v.ok) return { state: 'invalid', repo: root, source: found.source, file: found.file, errors: v.errors };
  const io = fsIo(root);
  const cur = computeFingerprint(io);
  const diff = diffFingerprint(found.profile.fingerprint, cur);
  const stale = !!(diff.changed.length || diff.removed.length || diff.added.length);
  return { state: stale ? 'stale' : 'ok', repo: root, source: found.source, file: found.file, profile: found.profile, updated: found.profile.updated || null, diff };
}

// ---------------------------------------------------------------- rules (what the workflow consumes)
export function rulesFrom(profile) {
  if (!profile) return null;
  const d = profile.decisions || {};
  const def = orchestratorDefaults();
  return {
    orchestrator: d.orchestrator || null,
    commit: { ...def.commit, ...(d.commit || {}) },
    branching: { ...def.branching, ...(d.branching || {}) },
    docs_duties: d.docs_duties || [],
    verify: { ...(d.verify || {}) },
    critical_globs: d.critical_paths || [],
    sensitivity: { default: d.sensitivity?.default || null, globs: d.sensitivity?.globs || [] },
    egm: d.egm || def.egm,
  };
}

const cap = (list, n = 8) => (list.length > n ? `${list.slice(0, n).join(', ')} (+${list.length - n} more)` : list.join(', '));

// Compact English block for the main session's context (preflight output): the few lines the workflow acts on.
export function rulesLines(r) {
  if (!r) return [];
  const c = r.commit;
  const L = [];
  L.push(c.policy === 'forbidden' ? 'commit: FORBIDDEN by the repo profile: do not commit, leave changes in the working tree and say so in the final report'
    : `commit: ${c.policy === 'ask' ? 'only after the user says yes' : `orchestrator, ${c.granularity}`}${c.format ? ` · format: ${c.format}` : ''}${c.attribution === 'none' ? ' · NO AI/tool attribution lines or trailers' : ''} · push: ${c.push === 'never' ? 'never' : 'only after an explicit yes'}`);
  const b = r.branching;
  L.push(`branching: ${b.action}${b.base ? ` · base ${b.base}` : ''}${b.pattern ? ` · pattern ${b.pattern}` : ''}${b.protected?.length ? ` · never commit directly to ${cap(b.protected)}` : ''} · PRs: ${b.pr === 'never' ? 'never' : 'only on request'}`);
  if (r.docs_duties.length) L.push(`docs duties (add to EVERY task's done criteria): ${r.docs_duties.map((x) => `[${x}]`).join(' ')}`);
  const v = r.verify;
  const cmds = ['test', 'typecheck', 'lint', 'build'].filter((k) => v[k]).map((k) => `${k}=${v[k]}`).concat(v.extra || []);
  if (cmds.length) L.push(`verify with: ${cmds.join('; ')}`);
  if (v.done_when?.length) L.push(`definition of done: ${v.done_when.map((x) => `[${x}]`).join(' ')}`);
  if (r.critical_globs.length) L.push(`critical paths (risk=high + security-lens review): ${cap(r.critical_globs)}`);
  if (r.sensitivity.default || r.sensitivity.globs.length) L.push(`sensitivity default: ${r.sensitivity.default || '(global)'}${r.sensitivity.globs.length ? ` · extra sensitive paths: ${cap(r.sensitivity.globs, 5)}` : ''}`);
  L.push(`egm: ${r.egm}`);
  return L;
}

// Conflicts between the profile and the user's global setup (doctor): [string].
export function profileConflicts(rules, reg, { project = [], prefs = {} } = {}) {
  const out = [];
  if (!rules) return out;
  const on = Object.entries(reg.families || {}).filter(([, f]) => f.enabled);
  if (rules.sensitivity.default === 'sensitive' && !on.some(([, f]) => f.data_policy?.sensitive_ok === true)) out.push('sensitivity default is "sensitive" but no enabled family has sensitive_ok: every task fails closed (adjust /orchestrator:configure or re-run init)');
  if (rules.orchestrator === 'project' && !project.length) out.push('profile says the repo\'s own orchestrator drives it, but none is present in the repo any more');
  if (rules.orchestrator && project.length && prefs.orchestrator && prefs.orchestrator !== rules.orchestrator) out.push(`profile orchestrator "${rules.orchestrator}" differs from projects.yaml "${prefs.orchestrator}"`);
  if (rules.commit.policy === 'forbidden' && rules.docs_duties.some((x) => /\bcommit\b/i.test(x))) out.push('commits are forbidden but a docs duty mentions committing');
  return out;
}

