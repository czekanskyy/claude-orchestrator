// Shared helpers: paths, registry loading, usage log, pool state, error classification, secrets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml-lite.mjs';
import { readConfig, CONFIG_FILE, normalizeEgm } from './config.mjs';
import { readRepoProfile, rulesFrom, STRICT } from './repo-profile.mjs';

// Plugin root, derived from this file (${CLAUDE_PLUGIN_ROOT} is not exported to Bash-tool environments).
export const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REGISTRY_PATH = process.env.ORCH_REGISTRY || path.join(PLUGIN_DIR, 'models.yaml');
export const ROUTING_PATH = process.env.ORCH_ROUTING || path.join(PLUGIN_DIR, 'routing.md');
export const STATE_DIR = process.env.ORCH_HOME || path.join(os.homedir(), '.claude', 'orchestrator');
export const USAGE_LOG = path.join(STATE_DIR, 'usage.jsonl');
export const POOLS_DIR = path.join(STATE_DIR, 'pools');
export const RUNS_DIR = path.join(STATE_DIR, 'runs');

// ---------------------------------------------------------------- io
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function out(obj, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  process.exitCode = exitCode;
}

export function fail(message, extra = {}, exitCode = 1) {
  out({ ok: false, error: message, ...extra }, exitCode);
}

// Tiny argv parser: --key value, --flag, repeated keys become arrays when listed in `multi`.
export function parseArgs(argv, { flags = [], multi = [] } = {}) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2));
    let val;
    if (flags.includes(key)) {
      val = eq > 0 ? a.slice(eq + 1) !== 'false' : true;
    } else if (eq > 0) {
      val = a.slice(eq + 1);
    } else {
      val = argv[++i];
      if (val === undefined) throw new Error(`missing value for --${key}`);
    }
    if (multi.includes(key)) (opts[key] ||= []).push(val);
    else opts[key] = val;
  }
  return opts;
}

// ---------------------------------------------------------------- registry
function deepMerge(base, over) {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out;
}

// <repo>/.claude/orchestrator.yaml, searched upward from ORCH_PROJECT or the current directory.
export function findProjectOverlay(start = process.env.ORCH_PROJECT || process.cwd()) {
  if (process.env.ORCH_NO_OVERLAY === '1') return null;
  let dir = path.resolve(start);
  for (;;) {
    const f = path.join(dir, '.claude', 'orchestrator.yaml');
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Registry = models.yaml (vendor facts) + per-repo overlay + user config.yaml (families/plans/privacy).
// The result keeps the v2 shape (families[f].pool, pools, models[m].pool) so routing code is unchanged:
// pools are derived from the plan catalog for the plans the user configured.
// config: undefined = read the user config, null = ignore it (tests), object = use as given.
export function loadRegistry(file = REGISTRY_PATH, { overlay = file === REGISTRY_PATH, config } = {}) {
  let reg = parseYaml(fs.readFileSync(file, 'utf8'));
  const ov = overlay ? findProjectOverlay() : null;
  let overlayCfg = null;
  let sharedProfile = null;
  if (ov) {
    const o = parseYaml(fs.readFileSync(ov, 'utf8')) || {};
    overlayCfg = o.config || null;
    sharedProfile = o.repo_profile || null;
    delete o.config;
    delete o.repo_profile;
    reg = deepMerge(reg, o);
    reg.meta.overlay = ov;
  }
  let cfg = config === undefined ? (file === REGISTRY_PATH ? readConfig() : { config: null }).config : config;
  const cfgError = config === undefined && file === REGISTRY_PATH ? readConfig().error : null;
  if (overlayCfg && cfg) cfg = deepMerge(cfg, overlayCfg);
  else if (overlayCfg) cfg = overlayCfg;
  applyConfig(reg, cfg, cfgError);
  if (overlay) applyRepoProfile(reg, sharedProfile);
  return reg;
}

// The per-repo profile from /orchestrator:init (user-local, plus the shareable block of the overlay): its decisions
// become reg.meta.repo_rules for the workflow, and its sensitivity default beats the user's global default for this repo.
// A profile that only arrives through the repo's own file (shared) may tighten privacy, never loosen it.
export function applyRepoProfile(reg, shared) {
  let found;
  try { found = readRepoProfile(repoRoot(), { shared }); } catch { return; }
  const rules = rulesFrom(found.profile);
  reg.meta.repo_profile = { source: found.source, file: found.file || null };
  if (!rules) return;
  reg.meta.repo_rules = rules;
  const order = STRICT['sensitivity.default'];
  const next = rules.sensitivity.default;
  const current = reg.meta.default_sensitivity || 'internal';
  if (next && (found.source !== 'shared' || order.indexOf(next) > order.indexOf(current))) reg.meta.default_sensitivity = next;
  reg.meta.sensitive_globs = [...new Set([...(reg.meta.sensitive_globs || []), ...rules.sensitivity.globs])];
}

// Planned pools for one family: configured plan ids (first = default); a custom id gets conservative catalog defaults.
function derivePool(fam, familyId, planId) {
  const tpl = fam.plans?.[planId];
  const base = { ...(fam.plan_defaults || {}), ...(tpl || {}) };
  return {
    ...base, family: familyId, plan: tpl?.label || planId, plan_id: planId, custom: !tpl,
    data_policy: tpl?.data_policy || fam.data_policy_default,
    sources: tpl?.sources || [],
    verified_at: tpl?.verified_at || fam.plan_defaults?.verified_at,
  };
}

export function applyConfig(reg, cfg, cfgError = null) {
  const fams = reg.families || {};
  reg.meta.config = { present: !!cfg, file: CONFIG_FILE, error: cfgError };
  if (cfg?.main_family && fams[cfg.main_family]) reg.meta.main_family = cfg.main_family;
  if (cfg?.privacy?.default_sensitivity) reg.meta.default_sensitivity = cfg.privacy.default_sensitivity;
  reg.meta.egm = normalizeEgm(cfg?.egm);
  reg.meta.sensitive_globs = [...new Set([...(reg.meta.sensitive_globs || []), ...(cfg?.privacy?.sensitive_globs || [])])];
  // Without a config only the main family is enabled (conservative); /orchestrator:configure widens it.
  const main = reg.meta.main_family;
  reg.pools = {};
  const acct = detectClaudeAccount();
  for (const [fid, fam] of Object.entries(fams)) {
    const fc = cfg?.families?.[fid];
    fam.enabled = cfg ? !!fc?.enabled : fid === main;
    fam.configured_plans = fc?.plans?.length ? fc.plans : [fam.default_plan];
    if (!fam.enabled) continue;
    const ids = [...fam.configured_plans];
    // A per-repo overlay may pin the family's pool (families.<f>.pool); models.yaml itself never sets one.
    const pinned = fam.pool && fam.plans?.[fam.pool] ? fam.pool : null;
    if (pinned) ids.splice(0, ids.length, pinned, ...ids.filter((x) => x !== pinned));
    // The login decides which of the family's plans is active: add it even if the user did not list it.
    const detected = fid === main ? poolForAccount(fam, acct) : null;
    if (detected && !ids.includes(detected)) ids.push(detected);
    for (const id of ids) reg.pools[id] = derivePool(fam, fid, id);
    fam.pool = ids[0];
    fam.alt_pools = ids.slice(1);
  }
  const claude = resolveMainPool(reg, acct);
  if (claude) {
    reg.meta.main_pool = claude;
    const f = reg.families[reg.meta.main_family];
    f.alt_pools = [f.pool, ...(f.alt_pools || [])].filter((p, i, a) => p !== claude.pool && a.indexOf(p) === i);
    f.pool = claude.pool;
  }
  for (const [fid, fam] of Object.entries(fams)) {
    const over = cfg?.families?.[fid]?.data_policy;
    const base = reg.pools[fam.pool]?.data_policy || fam.data_policy_default || { training_on_data: 'unknown', sensitive_ok: false };
    fam.data_policy = { ...base, ...(over || {}), source: over ? 'config.yaml override' : base.source };
    if (fam.data_policy.sensitive_ok !== true) fam.data_policy.sensitive_ok = false;
  }
  for (const [id, m] of Object.entries(reg.models || {})) {
    m.id = id;
    // All models of a family share the family's active pool.
    m.pool = fams[m.family]?.pool;
  }
}

export const enabledFamilies = (reg) => Object.entries(reg.families).filter(([, f]) => f.enabled).map(([id]) => id);

// ---------------------------------------------------------------- account + per-repo user preferences
// User-local (never committed) per-repo preferences: which orchestrator to use, which Claude pool is expected.
export const PROJECTS_FILE = path.join(STATE_DIR, 'projects.yaml');

export function repoRoot(start = process.env.ORCH_PROJECT || process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.claude', 'skills')) || fs.existsSync(path.join(dir, 'CLAUDE.md'))) {
      return dir === os.homedir() ? null : dir;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const normPath = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

export function readProjectPrefs(root) {
  if (!root) return {};
  try {
    const all = fs.existsSync(PROJECTS_FILE) ? parseYaml(fs.readFileSync(PROJECTS_FILE, 'utf8')) || {} : {};
    const hit = Object.entries(all.projects || {}).find(([k]) => normPath(k) === normPath(root));
    return { ...(readConfig().config?.defaults || {}), ...(all.defaults || {}), ...(hit ? hit[1] : {}) };
  } catch {
    return {};
  }
}

// projects.yaml is a tiny, fully script-owned file, so it is rewritten from scratch (quoted scalars only).
export function writeProjectPref(root, values) {
  let all = {};
  try { all = parseYaml(fs.readFileSync(PROJECTS_FILE, 'utf8')) || {}; } catch { /* new file */ }
  all.projects ||= {};
  const key = Object.keys(all.projects).find((k) => normPath(k) === normPath(root)) || root.replace(/\\/g, '/');
  all.projects[key] = { ...(all.projects[key] || {}), ...values, updated: new Date().toISOString().slice(0, 10) };
  const q = (v) => JSON.stringify(String(v));
  const lines = ['# Per-repo orchestrator preferences (user-local, never committed). Edit via: registry.mjs project-pref', ''];
  if (all.defaults) {
    lines.push('defaults:');
    for (const [k, v] of Object.entries(all.defaults)) lines.push(`  ${k}: ${q(v)}`);
  }
  lines.push('projects:');
  for (const [k, v] of Object.entries(all.projects)) {
    lines.push(`  ${q(k)}:`);
    for (const [kk, vv] of Object.entries(v)) lines.push(`    ${kk}: ${q(vv)}`);
  }
  ensureDir(STATE_DIR);
  fs.writeFileSync(PROJECTS_FILE, `${lines.join('\n')}\n`);
  return all.projects[key];
}

// Which Claude subscription the current Claude Code login uses (no personal data returned).
export function detectClaudeAccount() {
  const file = process.env.ORCH_CLAUDE_ACCOUNT_FILE || path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount;
    if (!a) return null;
    return { organization_type: a.organizationType || null, organization_uuid: a.organizationUuid || null, seat_tier: a.seatTier || null, profile_fetched_at: a.profileFetchedAt ? new Date(a.profileFetchedAt).toISOString() : null };
  } catch {
    return null;
  }
}

// Which catalog plan of a family matches the login (only families with account_match, i.e. Claude).
export function poolForAccount(fam, acct) {
  if (!acct) return null;
  const plans = Object.entries(fam.plans || {}).filter(([, p]) => p.account_match);
  const byUuid = plans.find(([, p]) => (p.account_match.org_uuids || []).includes(acct.organization_uuid));
  if (byUuid) return byUuid[0];
  const t = String(acct.organization_type || '').toLowerCase();
  const byType = plans.find(([, p]) => (p.account_match.org_types || []).some((x) => t === String(x).toLowerCase()))
    || plans.find(([, p]) => (p.account_match.org_types || []).some((x) => t.includes(String(x).toLowerCase())));
  return byType ? byType[0] : null;
}

// Active pool of the main family: env > detected login > per-repo preference > registry default.
// `expected` is what the repo preference asks for; a mismatch means the user should switch accounts.
export function resolveMainPool(reg, acct = detectClaudeAccount()) {
  const fam = reg.meta?.main_family;
  const def = reg.families?.[fam]?.pool;
  if (!fam || !def) return null;
  const root = repoRoot();
  const prefs = readProjectPrefs(root);
  const expected = prefs.claude_pool && reg.pools[prefs.claude_pool] ? prefs.claude_pool : null;
  const detected = poolForAccount(reg.families[fam], acct);
  let pool = def;
  let source = 'default';
  if (process.env.ORCH_CLAUDE_POOL && reg.pools[process.env.ORCH_CLAUDE_POOL]) { pool = process.env.ORCH_CLAUDE_POOL; source = 'env'; }
  else if (detected) { pool = detected; source = 'login'; }
  else if (expected) { pool = expected; source = 'project-pref'; }
  return { pool, source, expected, mismatch: !!(expected && pool !== expected), account_type: acct?.organization_type || null, repo: root };
}

export function findModel(reg, name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  for (const m of Object.values(reg.models)) {
    if ([m.id, m.cli_model, m.agent_model, m.resolves_to].filter(Boolean).map((s) => String(s).toLowerCase()).includes(n)) return m;
  }
  return null;
}

export function isExcluded(reg, name) {
  const n = String(name).toLowerCase();
  return (reg.excluded_models || []).find((x) => x.id === n || (x.match || []).map(String).map((s) => s.toLowerCase()).includes(n)) || null;
}

export function effortRank(reg, effort) {
  return reg.meta.effort_order.indexOf(effort);
}

export function tierRank(reg, tier) {
  return reg.meta.tier_order.indexOf(tier);
}

// Nearest supported level, rounding up (then down if nothing above).
export function clampEffort(reg, model, effort) {
  const levels = model.effort.levels;
  if (levels.includes(effort)) return effort;
  const r = effortRank(reg, effort);
  const sorted = [...levels].sort((a, b) => effortRank(reg, a) - effortRank(reg, b));
  return sorted.find((l) => effortRank(reg, l) >= r) || sorted[sorted.length - 1];
}

export function effortCost(reg, effort) {
  return Number(reg.meta.effort_cost[effort] ?? 1);
}

export function computeUnits(reg, model, effort, tokens) {
  const base = Number(model?.base_cost_weight ?? 1);
  const ref = Number(reg.meta.reference_tokens || 40000);
  const size = tokens ? Math.min(4, Math.max(0.25, tokens / ref)) : 1;
  return +(base * effortCost(reg, effort) * size).toFixed(3);
}

// Markdown tables between <!-- matrix:name --> markers in routing.md.
export function loadMatrix(name, file = ROUTING_PATH) {
  const md = fs.readFileSync(file, 'utf8');
  const m = md.match(new RegExp(`<!-- matrix:${name} -->([\\s\\S]*?)<!-- /matrix:${name} -->`));
  if (!m) throw new Error(`matrix "${name}" not found in ${file}`);
  const rows = m[1].trim().split(/\r?\n/).filter((l) => l.trim().startsWith('|'))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const header = rows[0].slice(1);
  const table = {};
  for (const r of rows.slice(2)) {
    table[r[0]] = Object.fromEntries(header.map((h, i) => [h, r[i + 1]]));
  }
  return table;
}

// ---------------------------------------------------------------- usage log
export function appendUsage(entry) {
  ensureDir(STATE_DIR);
  const row = { ts: new Date().toISOString(), ...entry };
  fs.appendFileSync(USAGE_LOG, `${JSON.stringify(row)}\n`);
  return row;
}

export function readUsage(sinceMs = 0) {
  let text;
  try { text = fs.readFileSync(USAGE_LOG, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (Date.parse(r.ts) >= sinceMs) rows.push(r);
    } catch { /* skip corrupt line */ }
  }
  return rows;
}

// ---------------------------------------------------------------- pool state
const stateFile = (poolId) => path.join(POOLS_DIR, `${poolId}.state.json`);
export const snapshotFile = (poolId) => path.join(POOLS_DIR, `${poolId}.snapshot.json`);

export function readPoolState(poolId) {
  return readJson(stateFile(poolId), {});
}

export function writePoolState(poolId, state) {
  writeJsonAtomic(stateFile(poolId), state);
}

export function setCooldown(reg, poolId, { untilMs, reason, model } = {}) {
  const pool = reg.pools[poolId];
  const until = untilMs || Date.now() + Number(pool?.cooldown_minutes_default || 60) * 60000;
  const st = readPoolState(poolId);
  if (model) {
    st.model_cooldowns = { ...(st.model_cooldowns || {}), [model]: { until: new Date(until).toISOString(), reason } };
  } else {
    st.cooldown_until = new Date(until).toISOString();
    st.cooldown_reason = reason || 'limit';
  }
  writePoolState(poolId, st);
  return st;
}

export function clearCooldown(poolId, model) {
  const st = readPoolState(poolId);
  if (model) delete st.model_cooldowns?.[model];
  else { delete st.cooldown_until; delete st.cooldown_reason; st.model_cooldowns = {}; }
  writePoolState(poolId, st);
  return st;
}

export function setManualPct(poolId, pct, windowId) {
  const st = readPoolState(poolId);
  st.manual = { pct: Number(pct), at: new Date().toISOString(), window: windowId || null };
  writePoolState(poolId, st);
  return st;
}

export function modelCooldown(poolId, modelId, now = Date.now()) {
  const c = readPoolState(poolId).model_cooldowns?.[modelId];
  return c && Date.parse(c.until) > now ? c : null;
}

// Optional overrides for simulations/tests: ORCH_POOLS_OVERRIDE='{"chatgpt_business":{"pct":90}}'
function poolOverride(poolId) {
  try { return JSON.parse(process.env.ORCH_POOLS_OVERRIDE || '{}')[poolId] || null; } catch { return null; }
}

export function poolStatus(reg, poolId, now = Date.now()) {
  const pool = reg.pools[poolId];
  if (!pool) throw new Error(`unknown pool ${poolId}`);
  const st = readPoolState(poolId);
  const budgets = pool.estimate_budget_units || {};
  const windows = [];
  const pulled = ['app-server', 'agy-usage'].includes(pool.measurement);
  let snap = pulled || pool.measurement === 'statusline' ? readJson(snapshotFile(poolId)) : null;
  // app-server / agy-usage snapshots are pulled on demand (usage.mjs sync-limits): stale after 15 minutes, then estimate.
  if (snap && pulled && now - Date.parse(snap.updated_at) > 15 * 60000) snap = null;

  for (const w of pool.windows) {
    const key = w.id === '5h' ? 'five_hour' : w.id === '7d' ? 'seven_day' : w.id;
    const s = snap?.rate_limits?.[key];
    if (s && typeof s.used_percentage === 'number' && (!s.resets_at || s.resets_at * 1000 > now)) {
      windows.push({ id: w.id, pct: +s.used_percentage.toFixed(1), source: pulled ? pool.measurement : 'statusline', resets_at: s.resets_at ? new Date(s.resets_at * 1000).toISOString() : null, snapshot_at: snap.updated_at });
      continue;
    }
    const since = now - w.hours * 3600000;
    const budget = Number(budgets[w.id] || 0);
    let base = 0;
    let from = since;
    let source = 'estimate';
    if (st.manual && Date.parse(st.manual.at) > since && (!st.manual.window || st.manual.window === w.id)) {
      base = st.manual.pct;
      from = Date.parse(st.manual.at);
      source = 'manual+estimate';
    }
    const units = readUsage(from).filter((r) => r.pool === poolId).reduce((a, r) => a + Number(r.units || 0), 0);
    const pct = budget ? base + (units / budget) * 100 : base;
    windows.push({ id: w.id, pct: +pct.toFixed(1), source, units: +units.toFixed(2), budget_units: budget || null });
  }

  const ov = poolOverride(poolId);
  let pct = Math.max(0, ...windows.map((w) => w.pct));
  if (ov?.pct !== undefined) pct = Number(ov.pct);
  let cooldownUntil = st.cooldown_until && Date.parse(st.cooldown_until) > now ? st.cooldown_until : null;
  if (ov?.cooldown) cooldownUntil = new Date(now + 3600000).toISOString();
  const t = pool.thresholds;
  let level = 'ok';
  if (cooldownUntil || pct >= t.cooldown) level = 'cooldown';
  else if (pct >= t.low_effort_confirm) level = 'constrained';
  else if (pct >= t.prefer_others) level = 'busy';
  const modelCooldowns = Object.fromEntries(Object.entries(st.model_cooldowns || {}).filter(([, v]) => Date.parse(v.until) > now));
  return {
    pool: poolId, family: pool.family, plan: pool.plan, measurement: pool.measurement,
    pct: +pct.toFixed(1), level, windows,
    cooldown_until: cooldownUntil, cooldown_reason: cooldownUntil ? st.cooldown_reason || ov?.reason || 'limit' : null,
    model_cooldowns: modelCooldowns,
    exact: windows.some((w) => w.source !== 'estimate' && w.source !== 'manual+estimate'),
  };
}

export function allPoolStatus(reg, now = Date.now()) {
  return Object.keys(reg.pools).map((id) => poolStatus(reg, id, now));
}

// Small cache read by statusline.mjs (which must not scan usage.jsonl on every render).
export function refreshEstimatesCache(reg) {
  try {
    const cache = Object.fromEntries(allPoolStatus(reg).map((p) => [p.pool, {
      pct: p.pct, level: p.level, cooldown_until: p.cooldown_until, label: reg.families[p.family]?.label?.split(' ')[0] || p.family, family: p.family, at: new Date().toISOString(),
    }]));
    writeJsonAtomic(path.join(POOLS_DIR, 'estimates.json'), cache);
  } catch { /* cache is best-effort */ }
}

// ---------------------------------------------------------------- error classification
const LIMIT_PATTERNS = [
  /\b429\b/, /rate[ _-]?limit/i, /usage limit/i, /hit your .{0,30}limit/i, /limit (reached|exceeded)/i,
  /quota/i, /too many requests/i, /out of (usage|credits)/i, /usage (cap|allowance)/i, /try again (at|in|after)/i,
];
const MODEL_SCOPE = /\b(this model|for model|model[- ]specific|opus limit|sonnet limit|haiku limit|astra|sol|luna|terra|grok-\d[\d.]*)\b/i;

export function detectLimit(text, now = Date.now()) {
  const s = String(text || '');
  if (!LIMIT_PATTERNS.some((re) => re.test(s))) return null;
  let retryAt = null;
  const inMin = s.match(/(?:in|after)\s+(\d+)\s*(min|minute|minutes|h|hour|hours)\b/i);
  if (inMin) retryAt = now + Number(inMin[1]) * (/^h/i.test(inMin[2]) ? 3600000 : 60000);
  const at = s.match(/(?:at|until)\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!retryAt && at) {
    const d = new Date(now);
    let h = Number(at[1]) % 12;
    if (!at[3]) h = Number(at[1]);
    else if (/pm/i.test(at[3])) h += 12;
    d.setHours(h, Number(at[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    retryAt = d.getTime();
  }
  const iso = s.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)/);
  if (!retryAt && iso) retryAt = Date.parse(iso[1]) || null;
  return { kind: 'rate_limit', scope: MODEL_SCOPE.test(s) ? 'model' : 'pool', retry_at: retryAt ? new Date(retryAt).toISOString() : null };
}

export function classifyError(text) {
  const s = String(text || '');
  const lim = detectLimit(s);
  if (lim) return { error_kind: 'rate_limit', limit: lim };
  if (/not (authenticated|logged in)|unauthori[sz]ed|\b401\b|please (log ?in|sign in)|login required/i.test(s)) return { error_kind: 'auth' };
  if (/unsupported reasoning effort|invalid (reasoning )?effort|unknown effort|reasoning[_ ]effort.{0,40}(invalid|not supported)/i.test(s)) return { error_kind: 'unknown_effort' };
  if (/unknown model|model .{0,40}(not found|not available|does not exist|unsupported)|invalid model|no such model|model_not_found/i.test(s)) return { error_kind: 'unknown_model' };
  return { error_kind: 'cli_error' };
}

// ---------------------------------------------------------------- secrets
const SECRET_PATTERNS = [
  ['anthropic_key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ['xai_key', /\bxai-[A-Za-z0-9]{20,}/],
  ['aws_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['google_key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['assignment', /^\s*[A-Z0-9_]*(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*['"]?[^\s'"<>{}$]{8,}/m],
];

export function scanSecrets(text) {
  const hits = [];
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) hits.push(name);
  return hits;
}

// Environment for external CLIs: drop anything that looks like a credential, and the xAI API
// key in particular (it would bill API credits instead of the subscription pool).
export function sanitizedEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i.test(k) && !/^(PATH|PATHEXT)$/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------- process
export function which(cmd) {
  const isWin = process.platform === 'win32';
  const r = spawnSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
}

// Path of a family's CLI (registry families.<f>.cli): env override first (tests), then PATH.
export function cliPath(fam) {
  const c = fam?.cli || {};
  const env = c.bin_env && process.env[c.bin_env];
  if (env) return fs.existsSync(env) ? env : null;
  return c.bin ? which(c.bin) : null;
}

// {cmd, pre}: how to spawn the family's CLI. A .mjs/.js override (test mock) runs through node.
export function cliCommand(fam) {
  const bin = cliPath(fam);
  if (!bin) return null;
  return /\.(mjs|cjs|js)$/i.test(bin) ? { cmd: process.execPath, pre: [bin], bin } : { cmd: bin, pre: [], bin };
}

export function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

// Runs a command with a timeout; resolves {code, stdout, stderr, timedOut, durationMs}.
export function runProcess(cmd, args, { cwd, env, input, timeoutMs = 600000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      // .cmd/.bat shims (npm-installed CLIs on Windows) cannot be spawned without a shell.
      const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
      child = shim
        ? spawn(`"${cmd}"`, args.map((x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)), { cwd, env, windowsHide: true, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(cmd, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout, stderr: String(e.message), timedOut, durationMs: 0, spawnError: true });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += `\n${e.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut, durationMs: Date.now() - started, spawnError: code === null && !timedOut && /ENOENT/.test(stderr) });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export function newRunId(prefix) {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${prefix}-${Math.random().toString(36).slice(2, 6)}`;
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars; full text in run_dir]` : s;
}
