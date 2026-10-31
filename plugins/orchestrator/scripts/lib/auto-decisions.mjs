// Autonomous mode: the decision protocol. Nobody answers questions overnight, so every choice is classified by
// reversibility and confidence, logged with a ready-to-run undo, and irreversible or external-effect actions are
// refused unless the contract allows them. Pure logic + injected second-opinion function (the engine wires models).
import { matchGlobList } from './privacy.mjs';

export const IRREVERSIBLE = ['push', 'deploy', 'data_deletion', 'migration_nonlocal', 'secrets', 'ci_auth_payments', 'major_dependency', 'force_operation'];
export const CONFIDENT = 0.75;

// d: { question, options: [{id, label, safest?, reversible?, files?}], chosen, confidence, reversibility, category }
// -> { route: 'decide'|'second_opinion'|'park_forbidden', reason }
export function classifyDecision(d, contract = {}) {
  const category = d.category && IRREVERSIBLE.includes(d.category) ? d.category : null;
  const irreversible = d.reversibility === 'irreversible' || !!category;
  if (irreversible) {
    const allowed = category && (contract.irreversible_allowed || []).includes(category);
    if (!allowed) return { route: 'park_forbidden', reason: `irreversible or external-effect action${category ? ` (${category})` : ''} is not allowed by the contract` };
    return { route: 'second_opinion', allowed: true, reason: 'irreversible but allowed by the contract: needs an independent check' };
  }
  const confidence = Number(d.confidence);
  if (!irreversible && Number.isFinite(confidence) && confidence >= CONFIDENT && d.chosen) return { route: 'decide', reason: `reversible and confident (${confidence})` };
  return { route: 'second_opinion', reason: `uncertain (confidence ${Number.isFinite(confidence) ? confidence : 'missing'})` };
}

// The safest minimal option: marked `safest`, else the reversible option touching the fewest files, else null.
export function safestOption(options = []) {
  const marked = options.find((o) => o.safest);
  if (marked) return marked;
  const rev = options.filter((o) => o.reversible !== false);
  if (!rev.length) return null;
  return [...rev].sort((a, b) => (a.files?.length ?? 99) - (b.files?.length ?? 99))[0];
}

// ctx: { contract, secondOpinion(question, options) -> {available, choice, confidence, reasoning, family} | null, now() }
// -> a complete decision record (minus id/time, added by the log).
export async function resolveDecision(d, ctx = {}) {
  const cls = classifyDecision(d, ctx.contract);
  const base = { question: d.question, options: d.options || [], chosen: d.chosen ?? null, confidence: Number(d.confidence) || 0, reasoning: d.reasoning || '', second_opinion: null, reversibility: d.reversibility || 'reversible', category: d.category || null, files: d.files || [], source: d.source || 'worker', rule: cls.route, rule_reason: cls.reason };
  if (cls.route === 'decide') return { ...base, outcome: 'decided' };
  if (cls.route === 'park_forbidden') return { ...base, chosen: null, outcome: 'parked' };

  let so = null;
  try { so = ctx.secondOpinion ? await ctx.secondOpinion(d.question, d.options || [], d) : null; } catch { so = null; }
  if (so?.available && so.choice) {
    base.second_opinion = { family: so.family || null, choice: so.choice, confidence: Number(so.confidence) || 0, reasoning: String(so.reasoning || '').slice(0, 400), agrees: so.choice === d.chosen };
    if (so.choice === d.chosen && (!(d.reversibility === 'irreversible' || d.category) || cls.allowed)) return { ...base, confidence: Math.max(base.confidence, Math.min(0.9, Number(so.confidence) || 0)), outcome: 'decided', rule: 'second_opinion_agrees' };
  } else base.second_opinion = { family: null, choice: null, confidence: 0, reasoning: 'no independent second opinion available (privacy or limits)', agrees: null };
  if (d.reversibility === 'irreversible' || d.category) return { ...base, chosen: null, outcome: 'parked', rule: 'irreversible_unconfirmed' }; // allowed by the contract but not confirmed independently
  const safe = safestOption(d.options);
  if (safe) return { ...base, chosen: safe.id, outcome: 'decided', rule: 'safest_minimal', rule_reason: `${cls.reason}; second opinion ${base.second_opinion.agrees === false ? 'disagrees' : 'unavailable'}: taking the safest minimal option` };
  return { ...base, chosen: null, outcome: 'parked', rule: 'no_safe_option' };
}

// Ready-to-run undo for a task checkpoint (reverts that one commit on the auto branch).
export const undoCommand = (worktree, sha) => (sha ? `git -C "${worktree}" revert --no-edit ${sha}` : null);

// ---------------------------------------------------------------- diff guard
const CI_GLOBS = ['.github/workflows/**', '.github/actions/**', '.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile', '.circleci/**', 'bitbucket-pipelines.yml', '.travis.yml'];
const SECRET_GLOBS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/credentials*.json', '**/secrets/**', '**/*.p12', '**/*.pfx'];
const MANIFESTS = ['package.json', 'requirements*.txt', 'pyproject.toml', 'Pipfile', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', '*.csproj'];
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'poetry.lock', 'Pipfile.lock', 'go.sum', 'Cargo.lock', 'Gemfile.lock', 'composer.lock'];
export const MASS_DELETE = 15;

const baseName = (p) => String(p).replace(/\\/g, '/').split('/').pop();
const matchesBase = (p, globs) => matchGlobList(globs.map((g) => `**/${g}`), [p]).length > 0 || matchGlobList(globs, [p]).length > 0;
const major = (v) => { const m = String(v).match(/(\d+)/); return m ? Number(m[1]) : null; };

// Dependency changes of one package.json: [{name, from, to, kind: 'added'|'removed'|'major'|'minor'}]
export function npmDepChanges(oldText, newText) {
  let o = {}; let n = {};
  try { o = JSON.parse(oldText || '{}'); } catch { /* new or broken file */ }
  try { n = JSON.parse(newText || '{}'); } catch { return [{ name: '(package.json)', kind: 'unparseable' }]; }
  const out = [];
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const a = o[k] || {}; const b = n[k] || {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[name] === b[name]) continue;
      if (a[name] === undefined) out.push({ name, from: null, to: b[name], kind: 'added' });
      else if (b[name] === undefined) out.push({ name, from: a[name], to: null, kind: 'removed' });
      else out.push({ name, from: a[name], to: b[name], kind: major(a[name]) !== major(b[name]) ? 'major' : 'minor' });
    }
  }
  return out;
}

// changed: [{path, status: 'A'|'M'|'D'|'R'}]; io: { readOld(path), readNew(path) } (file text or null).
// -> { violations: [{file, rule, category, detail}] }; a violation means the task is rolled back and parked.
export function guardDiff(changed, contract = {}, io = {}, extra = {}) {
  const v = [];
  const allowed = new Set(contract.irreversible_allowed || []);
  const policy = contract.dependencies || 'none';
  for (const c of changed) {
    const p = c.path;
    const prot = matchGlobList(contract.protected_paths || [], [p])[0];
    if (prot) v.push({ file: p, rule: 'protected_path', category: null, detail: `matches protected path ${prot.glob}` });
    if (matchesBase(p, SECRET_GLOBS) && !allowed.has('secrets')) v.push({ file: p, rule: 'secret_file', category: 'secrets', detail: 'secret/credential file touched' });
    if (matchesBase(p, CI_GLOBS) && !allowed.has('ci_auth_payments')) v.push({ file: p, rule: 'ci_config', category: 'ci_auth_payments', detail: 'CI/CD configuration changed' });
    const critical = matchGlobList(extra.critical_globs || [], [p])[0];
    if (critical && contract.critical_paths_edit === 'forbid') v.push({ file: p, rule: 'critical_path', category: null, detail: `critical path ${critical.glob}` });
    const isLock = matchesBase(baseName(p), LOCKFILES);
    if (isLock || matchesBase(baseName(p), MANIFESTS)) {
      if (policy === 'any' || allowed.has('major_dependency')) continue;
      if (baseName(p) === 'package.json') {
        const ch = npmDepChanges(io.readOld?.(p), io.readNew?.(p));
        const bad = ch.filter((x) => (policy === 'none' ? true : x.kind !== 'minor' && x.kind !== 'removed'));
        if (bad.length) v.push({ file: p, rule: 'dependency_change', category: 'major_dependency', detail: `${policy === 'none' ? 'dependencies are frozen' : 'only minor/patch bumps are allowed'}: ${bad.slice(0, 4).map((x) => `${x.name} ${x.kind}`).join(', ')}` });
      } else if (isLock) {
        if (policy === 'none') v.push({ file: p, rule: 'dependency_change', category: 'major_dependency', detail: 'lockfile changed while dependencies are frozen' });
      } else v.push({ file: p, rule: 'dependency_change', category: 'major_dependency', detail: 'dependency manifest changed and its change cannot be classified' });
    }
  }
  const deleted = changed.filter((c) => c.status === 'D');
  if (deleted.length >= MASS_DELETE && !allowed.has('data_deletion')) v.push({ file: `(${deleted.length} files)`, rule: 'mass_delete', category: 'data_deletion', detail: `${deleted.length} files deleted in one task (limit ${MASS_DELETE - 1})` });
  return { ok: !v.length, violations: v };
}
