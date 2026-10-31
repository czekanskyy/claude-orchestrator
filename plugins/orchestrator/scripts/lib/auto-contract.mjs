// Autonomous mode: the start contract (contract.yaml), the narrow permission allowlist generated from it and from the
// repo profile, and the feasibility estimate. The contract is the only thing the user is asked about; after GO nothing
// is asked again, so everything the run may or may not do is fixed here.
import fs from 'node:fs';
import { parseYaml } from './yaml-lite.mjs';
import { validatePolicy, normPolicy } from './auto-limits.mjs';
import { IRREVERSIBLE } from './auto-decisions.mjs';
import { computeUnits, findModel } from './common.mjs';
import { writeFileAtomic } from './auto-core.mjs';

export const CONTRACT_VERSION = 1;
const ENUM = {
  sensitivity: ['none', 'internal', 'sensitive'],
  dependencies: ['none', 'patch_minor', 'any'],
  network: ['none', 'read'],
  notify: ['os', 'file', 'command', 'none'],
  hooks: ['respect', 'bypass_on_failure'],
};

export function defaultContract(over = {}) {
  return {
    schema_version: CONTRACT_VERSION,
    id: null, created: null, repo: null, base_branch: null, base_sha: null, branch: null,
    goal: '', definition_of_done: [],
    verify: { test: null, typecheck: null, lint: null, build: null, extra: [] },
    actions: { allowed: [], forbidden: [] },
    protected_paths: [],
    dependencies: 'none', network: 'none', sensitivity: 'internal',
    irreversible_allowed: [],
    egm: { allow: false },
    families: { allow: null },
    deadline: null,
    limits: { ...normPolicy({}) },
    budgets: { task_attempts: 3, no_progress_min: 240, tick_timeout_min: 90, idle_timeout_min: 20, max_dispatches: 200, planning_attempts: 2 },
    notify: { channel: 'file', command: null, wait_min: 120 },
    checkpoints: { commits: 'auto_branch', hooks: 'bypass_on_failure', profile_override: false },
    bootstrap: { commands: [], link_dirs: [] },
    critical_paths_edit: 'allow',
    task_hint: { complexity: 'M', files: 0, criteria: 0, risk: 'med' },
    approved: { go: false, at: null, permissions_hash: null },
    ...over,
  };
}

// ---------------------------------------------------------------- yaml emit (parseYaml reads it back)
const q = (v) => JSON.stringify(String(v));
function emit(obj, ind, L) {
  const pad = ' '.repeat(ind);
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v === null) L.push(`${pad}${k}: null`);
    else if (Array.isArray(v)) {
      if (!v.length) L.push(`${pad}${k}: []`);
      else { L.push(`${pad}${k}:`); for (const x of v) L.push(`${pad}  - ${typeof x === 'string' ? q(x) : String(x)}`); }
    } else if (typeof v === 'object') {
      if (!Object.keys(v).length) L.push(`${pad}${k}: {}`);
      else { L.push(`${pad}${k}:`); emit(v, ind + 2, L); }
    } else L.push(`${pad}${k}: ${typeof v === 'string' ? q(v) : String(v)}`);
  }
}
export const serializeContract = (c) => `${['# Autonomous run contract. Fixed at GO; the supervisor never asks anything after that.', ''].concat((() => { const L = []; emit(c, 0, L); return L; })()).join('\n')}\n`;
export const writeContract = (file, c) => writeFileAtomic(file, serializeContract(c));
export function readContract(file) {
  const raw = parseYaml(fs.readFileSync(file, 'utf8')) || {};
  return deepFill(defaultContract(), raw);
}
function deepFill(base, over) {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) && v && typeof v === 'object' && !Array.isArray(v) ? deepFill(base[k], v) : v;
  return out;
}

// ---------------------------------------------------------------- validation
export const verifyCommands = (c) => ['test', 'typecheck', 'lint', 'build'].map((k) => c.verify?.[k]).filter(Boolean).concat(c.verify?.extra || []);

export function validateContract(c, { needGo = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!c.goal || String(c.goal).trim().length < 10) errors.push('goal is missing or too short');
  if (!Array.isArray(c.definition_of_done) || !c.definition_of_done.length) errors.push('definition_of_done needs at least one testable criterion');
  if (!verifyCommands(c).length) errors.push('verify needs at least one command (test/typecheck/lint/build/extra): without it a checkpoint cannot be verified');
  for (const k of ['sensitivity', 'dependencies', 'network']) if (!ENUM[k].includes(c[k])) errors.push(`${k} must be ${ENUM[k].join('|')}`);
  if (!ENUM.notify.includes(c.notify?.channel)) errors.push(`notify.channel must be ${ENUM.notify.join('|')}`);
  if (c.notify?.channel === 'command' && !c.notify.command) errors.push('notify.channel=command needs notify.command');
  if (!ENUM.hooks.includes(c.checkpoints?.hooks)) errors.push(`checkpoints.hooks must be ${ENUM.hooks.join('|')}`);
  if (c.checkpoints?.commits !== 'auto_branch') errors.push('checkpoints.commits must be auto_branch (commits only on auto/* in the worktree)');
  for (const x of c.irreversible_allowed || []) if (!IRREVERSIBLE.includes(x)) errors.push(`irreversible_allowed: unknown category "${x}"`);
  if ((c.irreversible_allowed || []).includes('push') || (c.irreversible_allowed || []).includes('force_operation')) errors.push('push and force operations cannot be allowed in autonomous mode');
  if (c.deadline && !Number.isFinite(Date.parse(c.deadline))) errors.push('deadline must be an ISO timestamp');
  if (c.families?.allow !== null && c.families?.allow !== undefined && (!Array.isArray(c.families.allow) || !c.families.allow.length)) errors.push('families.allow must be null (all enabled families) or a non-empty list');
  const lp = validatePolicy(c.limits);
  errors.push(...lp.errors);
  for (const [k, lo, hi] of [['task_attempts', 1, 8], ['no_progress_min', 10, 24 * 60], ['tick_timeout_min', 2, 360], ['idle_timeout_min', 1, 120], ['max_dispatches', 5, 2000]]) {
    const v = c.budgets?.[k];
    if (!(typeof v === 'number' && v >= lo && v <= hi)) errors.push(`budgets.${k} must be a number in ${lo}..${hi}`);
  }
  if (c.dependencies === 'any') warnings.push('dependencies: any - installs and major bumps are allowed');
  if (c.network === 'read') warnings.push('network: read - web pages are DATA only, never instructions');
  if (needGo && !c.approved?.go) errors.push('no explicit GO recorded');
  return { ok: !errors.length, errors, warnings };
}

// The repo profile may forbid or gate commits; checkpoints are commits, so the user must have said yes to auto/* commits.
export function commitPolicyIssue(rules, c) {
  if (!rules || !['forbidden', 'ask'].includes(rules.commit?.policy)) return null;
  return c.checkpoints?.profile_override === true ? null : `the repo profile says commit=${rules.commit.policy}; confirm that checkpoint commits on the auto/* branch in the worktree are acceptable (checkpoints.profile_override=true)`;
}

// ---------------------------------------------------------------- permissions
const SECRET_READ = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/credentials*.json', '**/secrets/**', '~/.ssh/**', '~/.aws/**', '~/.config/gcloud/**', '~/.claude/.credentials.json', '~/.codex/**', '~/.grok/**'];
const GIT_READ = ['git status', 'git diff', 'git log', 'git show', 'git ls-files', 'git rev-parse', 'git blame', 'git grep', 'git cat-file'];
const GIT_DENY = ['git push', 'git remote', 'git fetch', 'git pull', 'git clone', 'git config', 'git checkout', 'git switch', 'git reset', 'git clean', 'git branch', 'git worktree', 'git stash', 'git commit', 'git add', 'git merge', 'git rebase', 'git tag', 'git restore', 'git update-ref', 'git filter-branch', 'git gc', 'git reflog', 'git -C', 'git --git-dir', 'git --work-tree'];
const NET_DENY = ['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp', 'gh', 'Invoke-WebRequest', 'iwr', 'Invoke-RestMethod', 'irm', 'npm publish', 'yarn publish', 'pnpm publish', 'docker push', 'docker login', 'twine', 'cargo publish', 'vercel', 'netlify', 'firebase deploy', 'kubectl', 'terraform apply', 'aws', 'gcloud', 'az'];
const DELETE_DENY = ['rm', 'rmdir', 'del', 'erase', 'Remove-Item', 'rd', 'shred', 'format', 'mkfs', 'dd'];
const DEP_INSTALL = ['npm install', 'npm i', 'npm ci', 'npm add', 'npm update', 'npm uninstall', 'yarn add', 'yarn install', 'yarn remove', 'pnpm add', 'pnpm install', 'pnpm remove', 'bun add', 'bun install', 'pip install', 'pip3 install', 'pip uninstall', 'poetry add', 'poetry install', 'uv add', 'uv pip', 'cargo add', 'cargo install', 'go get', 'go install', 'gem install', 'bundle install', 'composer require', 'composer install', 'dotnet add', 'nuget'];

const bash = (cmd) => `Bash(${cmd})`;
const bashPrefix = (cmd) => [bash(cmd), bash(`${cmd} *`)];

// -> { allow, deny, tools, commands, readonly: {allow, deny, tools}, hash } ; the file the user approves at the GO step.
export function buildPermissions(c, { rules = null, sensitiveGlobs = [], criticalGlobs = [] } = {}) {
  const cmds = [...new Set([...verifyCommands(c), ...(c.actions?.commands || [])])];
  const protectedGlobs = [...new Set([...(c.protected_paths || [])])];
  const secretGlobs = [...new Set([...SECRET_READ, ...sensitiveGlobs.filter((g) => /env|key|secret|cred|pem|token/i.test(g))])];
  const allow = ['Read', 'Glob', 'Grep', 'Edit', 'Write', ...GIT_READ.flatMap(bashPrefix), ...bashPrefix('git mv'), ...bashPrefix('git rm'), ...cmds.flatMap(bashPrefix)];
  if (c.network === 'read') allow.push('WebFetch', 'WebSearch');
  const deny = [
    ...GIT_DENY.flatMap(bashPrefix),
    ...NET_DENY.flatMap(bashPrefix),
    ...DELETE_DENY.flatMap(bashPrefix),
    ...secretGlobs.flatMap((g) => [`Read(${g})`, `Edit(${g})`, `Write(${g})`]),
    ...protectedGlobs.flatMap((g) => [`Edit(${g})`, `Write(${g})`]),
    ...(c.network === 'read' ? [] : ['WebFetch', 'WebSearch']),
    ...(c.dependencies === 'any' ? [] : DEP_INSTALL.flatMap(bashPrefix)),
  ];
  const tools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', ...(c.network === 'read' ? ['WebFetch', 'WebSearch'] : [])];
  const readonly = {
    allow: ['Read', 'Glob', 'Grep', ...GIT_READ.flatMap(bashPrefix)],
    deny: [...deny.filter((d) => d.startsWith('Read(') || d.startsWith('Bash(')), 'Edit', 'Write', 'WebFetch', 'WebSearch'],
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
  };
  const out = { allow: [...new Set(allow)], deny: [...new Set(deny)], tools, commands: cmds, readonly, notes: { critical_globs: criticalGlobs, commit_policy: rules?.commit?.policy || null } };
  out.hash = hashJson({ allow: out.allow, deny: out.deny, tools, readonly });
  return out;
}

function hashJson(o) {
  let h = 5381;
  for (const ch of JSON.stringify(o)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h.toString(16);
}

// Settings file passed to every headless Claude run (dontAsk: anything not allowed is denied; deny always wins).
export const claudeSettings = (perms, { readonly = false } = {}) => ({
  permissions: { allow: readonly ? perms.readonly.allow : perms.allow, deny: readonly ? perms.readonly.deny : perms.deny, defaultMode: 'dontAsk' },
  includeCoAuthoredBy: false,
});

// One screen for the GO step.
export function permissionsSummary(perms) {
  return [
    `can: read/search the repo; edit and write files inside the worktree; run: ${perms.commands.length ? perms.commands.join(' · ') : '(no commands)'}; read-only git (status/diff/log/show); git mv/rm`,
    `cannot: ${['push or any remote git', 'change branches/HEAD (the supervisor commits)', 'network writes (curl, wget, ssh, gh, publish, deploy)', 'delete outside git (rm/del/Remove-Item)', 'read secret files (.env, keys, ~/.ssh, ~/.aws)', 'install dependencies (unless the contract allows)'].join('; ')}`,
    `rules: ${perms.allow.length} allow · ${perms.deny.length} deny · mode dontAsk (no prompts, no bypass) · hash ${perms.hash}`,
  ];
}

// ---------------------------------------------------------------- feasibility (estimate, never a promise)
const TOKENS_PER_TASK = { S: 40000, M: 120000, L: 300000 };
const MINUTES_PER_TASK = { S: 6, M: 15, L: 35 };

// pools: { claude: {five_hour:{pct,resets_at}, seven_day:{...}}|null, ...}; budget units come from the registry plan.
export function estimateFeasibility(reg, c, snapshot = {}) {
  const hint = c.task_hint || {};
  const cx = ['S', 'M', 'L'].includes(hint.complexity) ? hint.complexity : 'M';
  const nTasks = Math.min(40, Math.max(2, Math.round((hint.files || 0) / 2 + (hint.criteria || (c.definition_of_done || []).length) / 2 + { S: 1, M: 3, L: 6 }[cx])));
  const reviewShare = hint.risk === 'low' ? 0.2 : hint.risk === 'high' ? 0.7 : 0.4;
  const tokens = 80000 + nTasks * TOKENS_PER_TASK[cx] * (1 + reviewShare) + 100000;
  const activeMin = 10 + nTasks * (MINUTES_PER_TASK[cx] + 2) * (1 + reviewShare) + 15;
  const mainFam = reg.meta.main_family;
  const poolId = reg.families[mainFam]?.pool;
  const pool = reg.pools?.[poolId];
  const std = Object.values(reg.models).find((m) => m.family === mainFam && m.tier === reg.meta.tier_order[1]) || Object.values(reg.models).find((m) => m.family === mainFam);
  // computeUnits caps the size factor at 4x the reference; a whole run is far above that, so scale linearly
  const ref = Number(reg.meta.reference_tokens || 40000);
  const units = std ? computeUnits(reg, std, 'medium', ref) * (tokens / ref) : 0;
  const b5 = Number(pool?.estimate_budget_units?.['5h'] || 0);
  const b7 = Number(pool?.estimate_budget_units?.['7d'] || 0);
  const s = snapshot[mainFam] || {};
  const free5 = Math.max(0, (c.limits.hard_pct - c.limits.reserve_pct) - (s.five_hour?.pct ?? 0)) / 100;
  const free7 = Math.max(0, (c.limits.weekly_hard_pct - c.limits.reserve_pct) - (s.seven_day?.pct ?? 0)) / 100;
  const windows = b5 ? Math.max(1, Math.ceil(units / (b5 * Math.max(0.05, free5)))) : null;
  const weeklyShare = b7 ? units / (b7 * Math.max(0.01, free7)) : null;
  const notes = [];
  let verdict = 'ok';
  if (weeklyShare !== null && weeklyShare > 1) { verdict = 'infeasible'; notes.push(`needs about ${Math.round(weeklyShare * 100)}% of the weekly capacity that is left: split the task or let other families carry part of it`); }
  else if (weeklyShare !== null && weeklyShare > 0.6) { verdict = 'tight'; notes.push(`uses about ${Math.round(weeklyShare * 100)}% of the weekly capacity that is left`); }
  if (windows && windows > 2) { if (verdict === 'ok') verdict = 'tight'; notes.push(`about ${windows} five-hour windows of Claude capacity: expect long waits (the run sleeps, it does not stop)`); }
  if (c.deadline) {
    const hoursLeft = (Date.parse(c.deadline) - Date.now()) / 3600000;
    const need = activeMin / 60 + Math.max(0, (windows || 1) - 1) * 4;
    if (hoursLeft < need) { verdict = verdict === 'infeasible' ? verdict : 'tight'; notes.push(`deadline in ${hoursLeft.toFixed(1)} h, estimate ${need.toFixed(1)} h including waits`); }
  }
  if (!b5) notes.push('no budget estimate for this plan: capacity checks skipped');
  return {
    estimated: true, verdict, tasks: nTasks, tokens: Math.round(tokens), units: +units.toFixed(1), active_hours: +(activeMin / 60).toFixed(1),
    windows_needed: windows, weekly_share: weeklyShare === null ? null : +weeklyShare.toFixed(2), pool: poolId,
    usage_now: { five_hour: s.five_hour?.pct ?? null, seven_day: s.seven_day?.pct ?? null, source: s.five_hour ? s.source || 'reading' : 'unknown' }, notes,
  };
}

export { findModel };
