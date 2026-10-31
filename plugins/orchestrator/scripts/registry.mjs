#!/usr/bin/env node
// Registry CLI: validation, routing (candidates/route), fallback, escalation, update diff.
// All model knowledge comes from models.yaml; all routing tables from routing.md.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadRegistry, loadMatrix, findModel, isExcluded, effortRank, tierRank, clampEffort, computeUnits,
  allPoolStatus, poolStatus, modelCooldown, parseArgs, out, fail, runProcess, cliCommand, REGISTRY_PATH,
  repoRoot, readProjectPrefs, writeProjectPref, cliPath, enabledFamilies, PLUGIN_DIR, readJson, snapshotFile,
} from './lib/common.mjs';
import { effectiveSensitivity, familyAllowed } from './lib/privacy.mjs';
import { statusMarkdown } from './usage.mjs';
import { syncCodexLimits } from './lib/codex-limits.mjs';

const VALID_STATUS = ['active', 'unverified', 'requires_approval', 'deprecated'];
const PLUGIN_PREFIX = 'orchestrator:';
const TRAINING = [true, false, 'unknown', 'user_setting'];
const CODE_TYPES = ['implement', 'refactor', 'debug', 'test', 'mechanical'];

// ---------------------------------------------------------------- validate
export function validate(reg) {
  const errors = [];
  const warnings = [];
  const meta = reg.meta || {};
  for (const k of ['verified_at', 'stale_after_days', 'effort_order', 'effort_cost', 'tier_order', 'task_types']) {
    if (meta[k] === undefined || meta[k] === null) errors.push(`meta.${k} missing`);
  }
  const adapters = new Set();
  for (const [fid, f] of Object.entries(reg.families || {})) {
    if (!['primary', 'secondary'].includes(f.role)) errors.push(`families.${fid}.role must be primary|secondary`);
    if (!f.adapter?.id) errors.push(`families.${fid}.adapter.id missing`);
    else adapters.add(f.adapter.id);
    if (f.adapter?.id !== 'claude-agent' && !f.adapter?.script) errors.push(`families.${fid}.adapter.script missing`);
    if (f.adapter?.script && !fs.existsSync(path.join(PLUGIN_DIR, 'scripts', f.adapter.script))) errors.push(`families.${fid}.adapter.script ${f.adapter.script} not found in scripts/`);
    if (!f.cli?.bin) errors.push(`families.${fid}.cli.bin missing`);
    if (!f.plans || !Object.keys(f.plans).length) errors.push(`families.${fid}.plans missing`);
    else if (!f.plans[f.default_plan]) errors.push(`families.${fid}.default_plan "${f.default_plan}" not in plans`);
    for (const [pid, tpl] of Object.entries(f.plans || {})) {
      const at = `families.${fid}.plans.${pid}`;
      const p = { ...(f.plan_defaults || {}), ...tpl };
      const t = p.thresholds || {};
      if (!tpl.label || !tpl.tier) errors.push(`${at}.label/tier missing`);
      if (!(t.prefer_others < t.low_effort_confirm && t.low_effort_confirm <= t.cooldown)) errors.push(`${at}.thresholds must be ascending`);
      if (!Array.isArray(p.windows) || !p.windows.length) errors.push(`${at}.windows missing`);
      if (!['statusline', 'app-server', 'estimate', 'manual'].includes(p.measurement)) errors.push(`${at}.measurement invalid`);
      if (!p.verified_at) errors.push(`${at}.verified_at missing`);
      if (!tpl.sources?.length) errors.push(`${at}.sources missing`);
      const d = tpl.data_policy;
      if (!d || !TRAINING.includes(d.training_on_data) || typeof d.sensitive_ok !== 'boolean' || !d.source || !d.checked) errors.push(`${at}.data_policy needs training_on_data, sensitive_ok (bool), source, checked`);
      else if (d.training_on_data !== false && d.sensitive_ok === true) warnings.push(`${at}: sensitive_ok=true although training_on_data is ${d.training_on_data}`);
    }
    if (!f.data_policy_default || f.data_policy_default.sensitive_ok !== false) errors.push(`families.${fid}.data_policy_default must exist with sensitive_ok: false (conservative)`);
  }
  if (!reg.families?.[meta.main_family]) errors.push(`meta.main_family "${meta.main_family}" is not a family`);
  for (const [id, m] of Object.entries(reg.models || {})) {
    const at = `models.${id}`;
    if (!reg.families?.[m.family]) errors.push(`${at}.family "${m.family}" unknown`);
    if (!meta.tier_order?.includes(m.tier)) errors.push(`${at}.tier "${m.tier}" invalid`);
    if (!VALID_STATUS.includes(m.status)) errors.push(`${at}.status "${m.status}" invalid`);
    if (!adapters.has(m.invoke)) errors.push(`${at}.invoke "${m.invoke}" is not an adapter of any family`);
    else if (reg.families?.[m.family]?.adapter?.id !== m.invoke) errors.push(`${at}.invoke "${m.invoke}" does not match the adapter of family ${m.family}`);
    if (m.invoke === 'claude-agent' && !m.agent_model) errors.push(`${at}.agent_model missing`);
    if (m.invoke !== 'claude-agent' && !m.cli_model) errors.push(`${at}.cli_model missing`);
    const lv = m.effort?.levels || [];
    if (!lv.length) errors.push(`${at}.effort.levels missing`);
    for (const l of lv) if (!meta.effort_order?.includes(l)) errors.push(`${at}.effort level "${l}" not in meta.effort_order`);
    if (!lv.includes(m.effort?.default)) errors.push(`${at}.effort.default not in levels`);
    for (const tt of meta.task_types || []) {
      const v = m.suitability?.[tt];
      if (!Number.isInteger(v) || v < 1 || v > 5) errors.push(`${at}.suitability.${tt} must be integer 1-5`);
    }
    if (typeof m.base_cost_weight !== 'number') errors.push(`${at}.base_cost_weight must be a number`);
    if (!m.verified_at) errors.push(`${at}.verified_at missing`);
    if (!m.sources?.length) errors.push(`${at}.sources missing`);
    if (isExcluded(reg, id) || isExcluded(reg, m.cli_model || m.agent_model || id)) errors.push(`${at} is also listed in excluded_models`);
    if (m.status === 'unverified') warnings.push(`${at} is unverified (smoke test pending)`);
  }
  try {
    const tier = loadMatrix('tier');
    const bounds = loadMatrix('tier_bounds');
    const effort = loadMatrix('effort');
    for (const row of Object.values(tier)) for (const v of Object.values(row)) if (!meta.tier_order.includes(v)) errors.push(`routing tier matrix value "${v}" invalid`);
    for (const tt of meta.task_types) {
      if (!effort[tt]) errors.push(`routing effort matrix missing row ${tt}`);
      else for (const v of Object.values(effort[tt])) if (!meta.effort_order.includes(v)) errors.push(`routing effort value "${v}" invalid`);
      if (!bounds[tt]) errors.push(`routing tier_bounds missing row ${tt}`);
    }
  } catch (e) {
    errors.push(`routing.md: ${e.message}`);
  }
  for (const [tt, agent] of Object.entries(meta.subagent_for_type || {})) if (!fs.existsSync(path.join(PLUGIN_DIR, 'agents', `${agent}.md`))) errors.push(`meta.subagent_for_type.${tt}: agents/${agent}.md not found`);
  for (const tt of meta.task_types || []) if (!meta.subagent_for_type?.[tt]) errors.push(`meta.subagent_for_type.${tt} missing`);
  for (const fid of Object.keys(reg.families || {})) {
    if (!Object.values(reg.models || {}).some((m) => m.family === fid && m.status === 'active')) warnings.push(`family ${fid} has no active model`);
  }
  return { ok: errors.length === 0, errors, warnings, models: Object.keys(reg.models || {}).length };
}

// ---------------------------------------------------------------- routing core
export function requiredTier(reg, type, complexity, risk) {
  const tier = loadMatrix('tier')[complexity]?.[risk];
  if (!tier) throw new Error(`no tier for complexity=${complexity} risk=${risk}`);
  const b = loadMatrix('tier_bounds')[type];
  if (!b) throw new Error(`unknown task type ${type}`);
  let r = tierRank(reg, tier);
  r = Math.max(r, tierRank(reg, b.min));
  r = Math.min(r, tierRank(reg, b.max));
  return reg.meta.tier_order[r];
}

export function baseEffort(reg, type, complexity, risk) {
  let e = loadMatrix('effort')[type]?.[complexity];
  if (!e) throw new Error(`no effort for type=${type} complexity=${complexity}`);
  if (risk === 'high') {
    const order = reg.meta.effort_order;
    e = order[Math.min(effortRank(reg, e) + 1, effortRank(reg, reg.meta.auto_effort_ceiling))];
  }
  return e;
}

function poolsById(reg, poolsOverride) {
  const list = poolsOverride || allPoolStatus(reg);
  return Object.fromEntries(list.map((p) => [p.pool, p]));
}

// ctx: {type, complexity, risk, role: author|reviewer|extra_review, excludeFamilies[], onlyFamilies[],
//       allowUnverified, allowDowngrade, tierOverride, effortOverride, pools}
export function candidates(reg, ctx) {
  const pools = ctx.pools || poolsById(reg);
  const reqTier = ctx.tierOverride || requiredTier(reg, ctx.type, ctx.complexity, ctx.risk);
  const reqRank = tierRank(reg, reqTier);
  const effort0 = ctx.effortOverride || baseEffort(reg, ctx.type, ctx.complexity, ctx.risk);
  const level = ctx.sensitivity || reg.meta.default_sensitivity || 'internal';
  const primaries = primaryFamilies(reg);
  const primaryPct = Object.fromEntries(primaries.map((f) => [f, pools[reg.families[f].pool]?.pct ?? 0]));
  const primariesConstrained = primaries.every((f) => ['constrained', 'cooldown'].includes(pools[reg.families[f].pool]?.level));
  const minSuit = ctx.minSuitability ?? 3;
  const result = [];
  const rejected = [];

  for (const m of Object.values(reg.models)) {
    const fam = reg.families[m.family];
    const pool = pools[m.pool];
    const reject = (why) => rejected.push({ model: m.id, why });
    if (!fam.enabled) { reject('family not enabled in config'); continue; }
    const priv = familyAllowed(reg, m.family, level);
    if (!priv.ok) { reject(priv.reason); continue; }
    if (ctx.excludeFamilies?.includes(m.family)) { reject('family excluded (cross-check)'); continue; }
    if (ctx.onlyFamilies && !ctx.onlyFamilies.includes(m.family)) { reject('family not requested'); continue; }
    if (m.status === 'deprecated') { reject('deprecated'); continue; }
    if (m.status === 'requires_approval' && !ctx.allowApproval) { reject('requires approval'); continue; }
    if (m.status === 'unverified' && !ctx.allowUnverified) { reject('unverified (smoke test pending)'); continue; }
    if (!pool || pool.level === 'cooldown') { reject(`pool ${m.pool} in cooldown`); continue; }
    if (pool.model_cooldowns?.[m.id] || modelCooldown(m.pool, m.id)) { reject('model cooldown'); continue; }
    const suit = m.suitability[ctx.type];
    if (suit < minSuit) { reject(`suitability ${suit} < ${minSuit}`); continue; }
    const mRank = tierRank(reg, m.tier);
    const reasons = [];
    let score = suit * 10;
    if (mRank === reqRank) reasons.push(`tier ${m.tier} = required`);
    else if (mRank === reqRank + 1) { score -= 8; reasons.push(`tier ${m.tier} > required ${reqTier} (overkill)`); }
    else if (mRank === reqRank - 1 && ctx.allowDowngrade) { score -= 10; reasons.push(`tier ${m.tier} < required ${reqTier} (fallback downgrade)`); }
    else { reject(`tier ${m.tier} vs required ${reqTier}`); continue; }

    let effort = clampEffort(reg, m, effort0);
    let needsApproval = false;
    if (pool.level === 'constrained') {
      effort = [...m.effort.levels].sort((a, b) => effortRank(reg, a) - effortRank(reg, b))[0];
      needsApproval = true;
      score -= 40;
      reasons.push(`pool ${pool.pct}% >= low_effort_confirm: lowest effort + user approval`);
    } else if (pool.level === 'busy') {
      score -= 15;
      reasons.push(`pool ${pool.pct}% >= prefer_others`);
    }
    if (reg.meta.approval_efforts.includes(effort)) needsApproval = true;
    const units = computeUnits(reg, m, effort);
    score -= units * 3;
    if (priv.soft) { score -= 15; reasons.push(`privacy: internal data, ${m.family} may train on it (sensitive_ok=false)`); }

    if (fam.role === 'primary') {
      const others = primaries.filter((f) => f !== m.family).map((f) => primaryPct[f]);
      if (others.length) {
        const minOther = Math.min(...others);
        const maxOther = Math.max(...others);
        if (pool.pct < minOther - 10) { score += 12; reasons.push(`balance: ${m.pool} ${pool.pct}% < other primary ${minOther}%`); }
        else if (pool.pct > maxOther + 10) { score -= 12; reasons.push(`balance: ${m.pool} ${pool.pct}% > other primary ${maxOther}%`); }
      }
    } else if (ctx.role === 'extra_review') {
      reasons.push('secondary family: extra review round');
    } else if (primariesConstrained) {
      reasons.push('secondary family: primary pools constrained (coding fallback)');
    } else if (reqTier === reg.meta.tier_order[0] && pool.level === 'ok') {
      score -= 5;
      reasons.push('secondary family: simple (light-tier) task');
    } else {
      score -= 30;
      reasons.push('secondary family: not preferred for this task');
    }
    const main = reg.meta.main_family;
    if (ctx.contextHeavy && main && m.family !== main) { score += 10; reasons.push('context-heavy: runs outside the main session\'s pool and context'); }
    if (ctx.interactive && main && m.family === main) { score += 10; reasons.push('interactive: stays with the main family'); }
    const requiresJustification = m.tier === reg.meta.tier_order[reg.meta.tier_order.length - 1];
    result.push({
      model: m.id, family: m.family, pool: m.pool, invoke: m.invoke,
      call_as: m.invoke === 'claude-agent' ? m.agent_model : m.cli_model,
      tier: m.tier, required_tier: reqTier, effort, base_effort: effort0, suitability: suit,
      units, pool_pct: pool.pct, pool_level: pool.level, score: +score.toFixed(2),
      needs_approval: needsApproval, requires_justification: requiresJustification,
      status: m.status, reasons, dispatch: dispatchFor(reg, m, ctx.type, effort, ctx.lens),
    });
  }
  result.sort((a, b) => b.score - a.score || a.units - b.units);
  return { required_tier: reqTier, base_effort: effort0, candidates: result, rejected };
}

function primaryFamilies(reg) {
  return Object.entries(reg.families).filter(([, f]) => f.enabled && f.role === 'primary').map(([id]) => id);
}

function secondaryFamilies(reg) {
  return Object.entries(reg.families).filter(([, f]) => f.enabled && f.role === 'secondary').map(([id]) => id);
}

// How the main session dispatches a routed model: plugin subagent (Agent tool) or the family's adapter script.
export function dispatchFor(reg, m, type, effort, lens) {
  const fam = reg.families[m.family];
  if (m.invoke === 'claude-agent') {
    const agent = lens === 'security' && type === 'review' ? reg.meta.security_review_agent : reg.meta.subagent_for_type[type];
    return { via: 'agent', subagent_type: `${PLUGIN_PREFIX}${agent}`, model: m.agent_model, effort };
  }
  return { via: 'adapter', script: fam.adapter.script, model: m.cli_model, effort };
}

function budgetPctPerUnit(reg, poolId) {
  const b = reg.pools[poolId].estimate_budget_units || {};
  const vals = Object.entries(b).filter(([k]) => k !== 'estimate').map(([, v]) => Number(v)).filter(Boolean);
  return vals.length ? 100 / Math.min(...vals) : 0;
}

// Route a whole plan: assign author models with projected pool balancing, then append cross-checks.
export function route(reg, tasks, { pools } = {}) {
  const projected = JSON.parse(JSON.stringify(pools || poolsById(reg)));
  const assignments = [];
  const bump = (c) => {
    const p = projected[c.pool];
    p.pct = +(p.pct + c.units * budgetPctPerUnit(reg, c.pool)).toFixed(1);
    const t = reg.pools[c.pool].thresholds;
    if (p.pct >= t.cooldown) p.level = 'cooldown';
    else if (p.pct >= t.low_effort_confirm) p.level = 'constrained';
    else if (p.pct >= t.prefer_others) p.level = 'busy';
  };
  const pick = (ctx) => {
    let r = candidates(reg, { ...ctx, pools: projected });
    if (!r.candidates.length) r = candidates(reg, { ...ctx, pools: projected, allowDowngrade: true, allowUnverified: true });
    return r;
  };
  const prim = primaryFamilies(reg);
  const sec = secondaryFamilies(reg);

  const main = reg.meta.main_family;
  for (const t of tasks) {
    // Small, non-critical plans are written by the main session itself: no agent spin-up, no critique.
    if (t.type === 'plan' && t.complexity !== 'L' && t.risk !== 'high') {
      assignments.push({ ...t, kind: 'inline', model: 'main-session', family: main, effort: '(session)', units: 0, reasons: ['S/M plan below high risk: written inline by the main session, no critique'] });
      continue;
    }
    const sens = effectiveSensitivity(reg, t);
    const blocked = enabledFamilies(reg).filter((f) => !familyAllowed(reg, f, sens.level).ok);
    const privacyNotes = sens.level === 'sensitive' && blocked.length ? [`privacy: sensitive${sens.reasons.length ? ` (${sens.reasons.join('; ')})` : ''} -> restricted to families with sensitive_ok; excluded: ${blocked.join(', ')}`] : [];
    const lens = t.risk === 'high' ? 'security' : 'general';
    const r = pick({ type: t.type, complexity: t.complexity, risk: t.risk, role: 'author', onlyFamilies: t.family ? [t.family] : undefined, contextHeavy: t.context_heavy, interactive: t.interactive, sensitivity: sens.level, lens: t.type === 'review' ? lens : undefined });
    const c = r.candidates[0];
    if (!c) { assignments.push({ ...t, kind: 'author', sensitivity: sens.level, privacy_notes: privacyNotes, error: 'no candidate (fail closed)', rejected: r.rejected }); continue; }
    bump(c);
    assignments.push({ ...t, kind: 'author', sensitivity: sens.level, privacy_notes: privacyNotes, ...c });
    const producesCode = t.produces_code ?? CODE_TYPES.includes(t.type);
    // Review by risk: dictated text, low-risk mechanical edits and trivial (S, low-risk) code changes are verified by checks + diff skim.
    const trivial = t.risk === 'low' && t.complexity === 'S' && CODE_TYPES.includes(t.type);
    const exempt = t.dictated || (t.type === 'mechanical' && t.risk === 'low') || trivial;
    if (exempt) {
      assignments[assignments.length - 1].verification = `exempt from cross-review (${t.dictated ? 'dictated' : trivial ? 'trivial: S, low risk' : 'mechanical, low risk'}): verify by checks + diff skim`;
      continue;
    }
    if (producesCode || t.type === 'plan') {
      const rr = pick({ type: 'review', complexity: t.complexity, risk: t.risk, role: 'reviewer', excludeFamilies: [c.family], onlyFamilies: prim.filter((f) => f !== c.family), sensitivity: sens.level, lens });
      const rc = rr.candidates[0];
      if (!rc) assignments[assignments.length - 1].cross_review_gap = `no other primary family may see ${sens.level} data: verify by checks + diff skim and tell the user the critical check is single-family`;
      if (rc) { bump(rc); assignments.push({ id: `${t.id}-xr`, title: `Cross-review${lens === 'security' ? ' (security lens)' : ''}: ${t.title}`, type: 'review', complexity: t.complexity, risk: t.risk, deps: [t.id], kind: 'cross_review', lens, reviews: t.id, author_family: c.family, sensitivity: sens.level, ...rc }); }
      if (t.risk === 'high') {
        const er = pick({ type: 'review', complexity: t.complexity, risk: t.risk, role: 'extra_review', excludeFamilies: [c.family], onlyFamilies: sec, sensitivity: sens.level, lens });
        const ec = er.candidates[0];
        if (ec) { bump(ec); assignments.push({ id: `${t.id}-xr2`, title: `Extra review: ${t.title}`, type: 'review', complexity: t.complexity, risk: t.risk, deps: [t.id], kind: 'extra_review', lens, reviews: t.id, author_family: c.family, sensitivity: sens.level, ...ec }); }
      }
    }
  }
  const byFamily = {};
  for (const a of assignments) if (a.family) byFamily[a.family] = +((byFamily[a.family] || 0) + a.units).toFixed(2);
  return { assignments, units_by_family: byFamily, projected_pools: Object.values(projected).map((p) => ({ pool: p.pool, pct: p.pct, level: p.level })) };
}

export function routeMarkdown(r) {
  const rows = r.assignments.map((a) => `| ${a.id} | ${a.kind} | ${a.type} ${a.complexity}/${a.risk} | ${a.model ?? '—'} (${a.family ?? '—'}) | ${a.effort ?? '—'} | ${a.units ?? '—'} | ${a.error ?? a.reasons?.join('; ')}${a.privacy_notes?.length ? ` — ${a.privacy_notes.join('; ')}` : ''}${a.cross_review_gap ? ` — ${a.cross_review_gap}` : ''}${a.verification ? ` — ${a.verification}` : ''}${a.requires_justification ? ' — HEAVY: justify' : ''}${a.needs_approval ? ' — NEEDS APPROVAL' : ''} |`);
  return ['| id | kind | type C/R | model (family) | effort | units | rationale |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
}

// ---------------------------------------------------------------- fallback & escalation
export function fallback(reg, { model, effort, error, scope, type = 'implement', complexity = 'M', risk = 'med', pools, sensitivity }) {
  const m = findModel(reg, model);
  if (!m) throw new Error(`unknown model ${model}`);
  const P = pools || poolsById(reg);
  const steps = [];
  const sortedLevels = [...m.effort.levels].sort((a, b) => effortRank(reg, a) - effortRank(reg, b));
  const lowerEffort = () => {
    const i = sortedLevels.indexOf(clampEffort(reg, m, effort));
    if (i > 0 && P[m.pool]?.level !== 'cooldown') steps.push({ step: 'lower_effort', model: m.id, family: m.family, effort: sortedLevels[i - 1], reason: `effort ${effort} -> ${sortedLevels[i - 1]} on the same model` });
  };
  const cheaperSameFamily = () => {
    if (P[m.pool]?.level === 'cooldown') return;
    const alts = Object.values(reg.models)
      .filter((x) => x.family === m.family && x.id !== m.id && x.status === 'active' && x.base_cost_weight < m.base_cost_weight && x.suitability[type] >= 2 && !modelCooldown(x.pool, x.id))
      .sort((a, b) => b.suitability[type] - a.suitability[type] || a.base_cost_weight - b.base_cost_weight);
    if (alts[0]) steps.push({ step: 'cheaper_model_same_family', model: alts[0].id, family: m.family, effort: clampEffort(reg, alts[0], effort), reason: `${m.id} -> cheaper ${alts[0].id} (same pool ${m.pool})` });
  };
  const otherFamily = (families, label) => {
    const r = candidates(reg, { type, complexity, risk, role: label === 'secondary_family' ? 'author' : 'author', onlyFamilies: families, excludeFamilies: [m.family], allowDowngrade: true, pools: P, sensitivity });
    const c = r.candidates[0];
    if (c) steps.push({ step: label, model: c.model, family: c.family, effort: c.effort, reason: `switch pool ${m.pool} -> ${c.pool}`, needs_approval: c.needs_approval });
  };
  const prim = primaryFamilies(reg).filter((f) => f !== m.family);
  const sec = secondaryFamilies(reg).filter((f) => f !== m.family);
  switch (error) {
    case 'timeout':
      lowerEffort(); cheaperSameFamily(); otherFamily(prim, 'other_primary_family'); otherFamily(sec, 'secondary_family'); break;
    case 'rate_limit':
      if (scope === 'model') cheaperSameFamily();
      otherFamily(prim, 'other_primary_family'); otherFamily(sec, 'secondary_family'); break;
    case 'pool_cooldown':
      otherFamily(prim, 'other_primary_family'); otherFamily(sec, 'secondary_family'); break;
    case 'unknown_model': case 'unknown_effort':
      otherFamily(prim, 'other_primary_family'); otherFamily(sec, 'secondary_family');
      steps.push({ step: 'suggest_update', reason: 'run /orchestrator:update: CLI reported an unknown model/effort' }); break;
    default: // cli_error, auth, other
      otherFamily(prim, 'other_primary_family'); otherFamily(sec, 'secondary_family');
  }
  // The main family may have other subscriptions (e.g. Team → personal Pro). Switching is a user action
  // (org switch in the app or /login), so it is suggested alongside the automatic ladder, never taken.
  let suggest = null;
  const fam = reg.families[m.family];
  if ((error === 'pool_cooldown' || (error === 'rate_limit' && scope !== 'model')) && fam.alt_pools?.length) {
    const alt = fam.alt_pools.filter((p) => p !== m.pool && reg.pools[p]).map((p) => poolStatus(reg, p)).find((s) => s.level !== 'cooldown');
    if (alt) suggest = { to_pool: alt.pool, plan: reg.pools[alt.pool].plan, last_known_pct: alt.pct, reason: `${reg.pools[m.pool].plan} exhausted: the user can switch this session to ${reg.pools[alt.pool].plan} (org switch / /login), then re-run preflight` };
  }
  return { from: { model: m.id, family: m.family, effort }, error, scope: scope || null, next: steps[0] || { step: 'stop', reason: 'no viable fallback; report to user' }, ladder: steps, suggest_account_switch: suggest };
}

// ---------------------------------------------------------------- project awareness
// Repo-local orchestrators (e.g. a team's own `orchestrate` skill). Their rules apply to the repo either way;
// which orchestrator runs is a per-user preference stored outside the repo (projects.yaml).
export function projectOrchestrators(root) {
  if (!root) return [];
  const found = [];
  const skillsDir = path.join(root, '.claude', 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir)) {
      const f = path.join(skillsDir, d, 'SKILL.md');
      if (!fs.existsSync(f)) continue;
      const name = (fs.readFileSync(f, 'utf8').match(/^name:\s*(.+)$/m) || [])[1]?.trim() || d;
      if (/orchestrat/i.test(name)) found.push({ kind: 'skill', name, invoke: `/${name}`, path: f });
    }
  }
  const cmdDir = path.join(root, '.claude', 'commands');
  if (fs.existsSync(cmdDir)) {
    for (const f of fs.readdirSync(cmdDir)) if (/orchestrat/i.test(f)) found.push({ kind: 'command', name: f.replace(/\.md$/, ''), invoke: `/${f.replace(/\.md$/, '')}`, path: path.join(cmdDir, f) });
  }
  return found;
}

// Exact Codex usage is pulled on demand (zero model tokens); a snapshot younger than 5 minutes is reused.
async function refreshCodexLimits(reg) {
  const fam = reg.families.gpt;
  if (!fam?.enabled || fam.pool && reg.pools[fam.pool]?.measurement !== 'app-server') return;
  const snap = readJson(snapshotFile(fam.pool));
  if (snap && Date.now() - Date.parse(snap.updated_at) < 5 * 60000) return;
  await syncCodexLimits(reg);
}

export function preflight(reg) {
  const main = reg.meta.main_pool || {};
  const root = main.repo ?? repoRoot();
  const prefs = readProjectPrefs(root);
  const project = projectOrchestrators(root);
  const choice = project.length ? (prefs.orchestrator || 'ask') : 'global';
  const warnings = [];
  if (main.mismatch) warnings.push(`This repo expects ${reg.pools[main.expected].plan}, but the session is on ${reg.pools[main.pool].plan} (${main.source}). Switch accounts, or update the preference.`);
  const pools = allPoolStatus(reg);
  const active = pools.find((p) => p.pool === main.pool);
  if (active && ['constrained', 'cooldown'].includes(active.level)) {
    const alt = (reg.families[reg.meta.main_family].alt_pools || []).map((p) => pools.find((x) => x.pool === p)).find((s) => s && s.level !== 'cooldown');
    if (alt) warnings.push(`${reg.pools[main.pool].plan} at ${active.pct}%: consider switching the session to ${reg.pools[alt.pool].plan} (last known ${alt.pct}%).`);
  }
  const cfg = reg.meta.config || {};
  const notice = cfg.error ? `config.yaml is invalid (${cfg.error}): using conservative defaults. Run /orchestrator:configure.`
    : !cfg.present ? 'Not configured yet: run /orchestrator:configure once (until then only the main family is used, conservative privacy).' : null;
  if (notice) warnings.unshift(notice);
  const privacy = Object.fromEntries(enabledFamilies(reg).map((f) => [f, { sensitive_ok: reg.families[f].data_policy.sensitive_ok, training_on_data: reg.families[f].data_policy.training_on_data }]));
  const noSensitive = Object.entries(privacy).filter(([, p]) => !p.sensitive_ok).map(([f]) => f);
  if (noSensitive.length) warnings.push(`Privacy: no sensitive data to ${noSensitive.join(', ')} (sensitive tasks are routed elsewhere).`);
  return {
    repo: root, overlay: reg.meta.overlay || null,
    config: { present: !!cfg.present, file: cfg.file, notice }, privacy, families: enabledFamilies(reg),
    claude: { active_pool: main.pool, source: main.source, account_type: main.account_type, expected_pool: main.expected },
    orchestrator: { choice, project_orchestrators: project.map(({ name, invoke, path: p }) => ({ name, invoke, path: p })), how_to_change: 'registry.mjs project-pref --orchestrator global|project|ask' },
    stale: staleCheck(reg), pools, warnings,
  };
}

// Ladder (routing.md §7): effort +1 → other primary family, same tier → tier +1 (justified) → stop.
// Each rung falls through to the next when it is not possible (ceiling reached, pool down, no model).
export function escalate(reg, { model, effort, failures = 1, type = 'implement', complexity = 'M', risk = 'med', pools, sensitivity }) {
  const m = findModel(reg, model);
  if (!m) throw new Error(`unknown model ${model}`);
  const ceiling = effortRank(reg, reg.meta.escalation_effort_ceiling);
  const otherPrimary = primaryFamilies(reg).filter((f) => f !== m.family);
  if (failures <= 1) {
    const higher = [...m.effort.levels].sort((a, b) => effortRank(reg, a) - effortRank(reg, b)).find((l) => effortRank(reg, l) > effortRank(reg, effort));
    if (higher && effortRank(reg, higher) <= ceiling && !reg.meta.approval_efforts.includes(higher)) {
      return { action: 'raise_effort', model: m.id, family: m.family, effort: higher, reason: `verification failed once: effort ${effort} -> ${higher} (one level, same model)` };
    }
  }
  if (failures <= 2) {
    const r = candidates(reg, { type, complexity, risk, tierOverride: m.tier, onlyFamilies: otherPrimary, pools, sensitivity });
    const c = r.candidates[0];
    if (c) {
      const eff = clampEffort(reg, findModel(reg, c.model), effortRank(reg, effort) > effortRank(reg, c.effort) && effortRank(reg, effort) <= ceiling ? effort : c.effort);
      return { action: 'switch_family', model: c.model, family: c.family, effort: eff, reason: `verification failed twice: fresh eyes from ${c.family} at tier ${m.tier}; paste the failing evidence into the brief` };
    }
  }
  if (failures <= 3) {
    const nextTier = reg.meta.tier_order[tierRank(reg, m.tier) + 1];
    if (nextTier) {
      const r = candidates(reg, { type, complexity, risk, tierOverride: nextTier, onlyFamilies: primaryFamilies(reg), pools, sensitivity });
      const c = r.candidates[0];
      if (c) {
        const eff = clampEffort(reg, findModel(reg, c.model), baseEffort(reg, type, complexity, risk));
        return { action: 'raise_tier', model: c.model, family: c.family, effort: eff, requires_justification: true, reason: `verification failed ${failures}x: tier ${m.tier} -> ${nextTier} (${c.family}, lower pool), base effort ${eff}; justify in the plan` };
      }
    }
  }
  return { action: 'stop_and_report', reason: `verification failed ${failures}x: stop, re-plan or report the evidence to the user` };
}

// ---------------------------------------------------------------- update support
export function diffRegistry(reg, observed) {
  const added = [];
  const changed = [];
  const missing = [];
  for (const [fam, obs] of Object.entries(observed.families || {})) {
    const seen = new Set();
    for (const o of obs.models || []) {
      if (isExcluded(reg, o.id)) continue;
      const m = findModel(reg, o.id);
      if (!m || m.family !== fam) { added.push({ family: fam, id: o.id, effort_levels: o.effort_levels || null, context_tokens: o.context_tokens || null, source: obs.source }); continue; }
      seen.add(m.id);
      const diffs = {};
      if (o.effort_levels) {
        const a = [...m.effort.levels].sort().join(',');
        const b = [...o.effort_levels].sort().join(',');
        if (a !== b) diffs.effort_levels = { registry: m.effort.levels, observed: o.effort_levels };
      }
      if (o.effort_default && o.effort_default !== m.effort.default && m.invoke !== 'claude-agent') diffs.effort_default = { registry: m.effort.default, observed: o.effort_default };
      if (o.context_tokens && Number(o.context_tokens) !== Number(m.context_tokens)) diffs.context_tokens = { registry: m.context_tokens, observed: o.context_tokens };
      if (m.status === 'unverified') diffs.status = { registry: 'unverified', observed: 'listed by CLI (smoke test, then active)' };
      if (Object.keys(diffs).length) changed.push({ family: fam, id: m.id, diffs, source: obs.source });
    }
    if (obs.complete) {
      for (const m of Object.values(reg.models)) {
        if (m.family === fam && m.status !== 'deprecated' && !seen.has(m.id)) missing.push({ family: fam, id: m.id, proposal: 'mark deprecated (never delete without confirmation)', source: obs.source });
      }
    }
  }
  return { observed_at: observed.observed_at, added, changed, missing, has_changes: !!(added.length || changed.length || missing.length) };
}

export function diffMarkdown(d) {
  const lines = [];
  if (d.added.length) lines.push('### New (not in registry)', ...d.added.map((a) => `- **${a.id}** (${a.family})${a.effort_levels ? ` effort: ${a.effort_levels.join('/')}` : ''}${a.context_tokens ? `, ctx ${a.context_tokens}` : ''}. Source: ${a.source}`));
  if (d.changed.length) lines.push('### Changed', ...d.changed.map((c) => `- **${c.id}**: ${Object.entries(c.diffs).map(([k, v]) => `${k}: ${JSON.stringify(v.registry)} -> ${JSON.stringify(v.observed)}`).join('; ')}. Source: ${c.source}`));
  if (d.missing.length) lines.push('### Not seen in CLI (propose deprecated)', ...d.missing.map((m) => `- **${m.id}** (${m.family}): ${m.proposal}`));
  return lines.join('\n') || 'No differences.';
}

// Zero-token catalog reads from the CLIs of the families the user enabled (docs-only data is the update skill's job).
export async function observe(reg = loadRegistry()) {
  const res = { observed_at: new Date().toISOString(), families: {}, cli: {}, notes: [] };
  const on = new Set(enabledFamilies(reg));
  const cli = (id) => cliCommand(reg.families[id]);
  const run = (c, args, timeoutMs = 60000) => runProcess(c.cmd, [...c.pre, ...args], { timeoutMs });
  if (on.has('gpt')) {
    const c = cli('gpt');
    if (!c) res.notes.push('codex CLI not found');
    else {
      res.cli.codex = (await run(c, ['--version'], 20000)).stdout.trim();
      let r = await run(c, ['debug', 'models']);
      let source = 'codex debug models (live)';
      if (r.code !== 0) {
        r = await run(c, ['debug', 'models', '--bundled']);
        source = 'codex debug models --bundled (live catalog unavailable: not logged in?)';
        res.notes.push('codex live catalog unavailable; used bundled catalog');
      }
      try {
        const j = JSON.parse(r.stdout);
        res.families.gpt = {
          source, complete: true,
          models: j.models.filter((m) => m.visibility === 'list').map((m) => ({ id: m.slug, effort_levels: (m.supported_reasoning_levels || []).map((x) => x.effort), effort_default: m.default_reasoning_level, context_tokens: m.context_window })),
        };
      } catch (e) { res.notes.push(`codex catalog parse failed: ${e.message}`); }
    }
  }
  if (on.has('grok')) {
    const c = cli('grok');
    if (!c) res.notes.push('grok CLI not found');
    else {
      res.cli.grok = (await run(c, ['--version'], 20000)).stdout.trim();
      const r = await run(c, ['models']);
      const ids = [...`${r.stdout}\n${r.stderr}`.matchAll(/^\s*[*-]\s+([a-z0-9][\w.-]+)/gim)].map((x) => x[1]);
      if (ids.length) res.families.grok = { source: 'grok models', complete: !/not authenticated/i.test(r.stdout + r.stderr), models: ids.map((id) => ({ id })) };
      if (/not authenticated/i.test(r.stdout + r.stderr)) res.notes.push('grok not authenticated: list may be partial (complete=false)');
    }
  }
  if (on.has('gemini')) {
    const c = cli('gemini');
    if (!c) res.notes.push('agy (Antigravity CLI) not found');
    else {
      res.cli.agy = (await run(c, ['--version'], 20000)).stdout.trim();
      const r = await run(c, ['models'], 30000);
      // "<id>\t<label>" lines; the effort is a model-id suffix (gemini-3.8-flash-high). agy also lists third-party models: ignored.
      const grouped = {};
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = /^(gemini-[\w.-]+?)(?:-(minimal|low|medium|high|xhigh))?$/.exec(line.split('\t')[0].trim());
        if (m) (grouped[m[1]] ||= []).push(m[2]);
      }
      const models = Object.entries(grouped).map(([id, lv]) => ({ id, effort_levels: lv.every(Boolean) ? lv : null }));
      if (models.length) res.families.gemini = { source: 'agy models', complete: true, models };
      else res.notes.push('agy models returned no Gemini models (not logged in?)');
    }
  }
  res.notes.push('Claude models are not listed by a CLI: verify via docs (model-config, models overview).');
  return res;
}

export function staleCheck(reg, now = Date.now()) {
  const age = Math.floor((now - Date.parse(reg.meta.verified_at)) / 86400000);
  return { verified_at: reg.meta.verified_at, age_days: age, stale: age > reg.meta.stale_after_days, suggest: age > reg.meta.stale_after_days ? 'Run /orchestrator:update (registry older than stale_after_days).' : null };
}

// ---------------------------------------------------------------- CLI
const USAGE = `registry.mjs <command>
  preflight [--md]                         repo, active Claude subscription, orchestrator choice, staleness, pools
  project-pref [--orchestrator global|project|ask] [--claude-pool <pool>] [--repo DIR]   user-local per-repo preference
  validate | stale-check | list | get <model> | matrix
  candidates --type T --complexity S|M|L --risk low|med|high [--role author|reviewer|extra_review] [--exclude-family F] [--only-family F] [--allow-unverified] [--limit N]
  route --tasks tasks.json [--md]
  fallback --model M --effort E --error timeout|rate_limit|pool_cooldown|cli_error|auth|unknown_model|unknown_effort [--scope model|pool] [--type T --complexity C --risk R]
  escalate --model M --effort E --failures N [--type T --complexity C --risk R]
  observe [--out file.json]
  diff --observed file.json [--md]
Env: ORCH_REGISTRY, ORCH_HOME, ORCH_POOLS_OVERRIDE='{"pool":{"pct":90}}' for simulations.`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest, { flags: ['allow-unverified', 'md', 'json', 'context-heavy', 'interactive'], multi: ['exclude-family', 'only-family'] });
  const reg = loadRegistry();
  switch (cmd) {
    case 'validate': { const v = validate(reg); return out({ registry: REGISTRY_PATH, overlay: reg.meta.overlay || null, ...v }, v.ok ? 0 : 1); }
    case 'stale-check': return out(staleCheck(reg));
    case 'preflight': {
      await refreshCodexLimits(reg);
      const p = preflight(reg);
      if (!a.md) return out(p);
      const lines = [
        `Repo: ${p.repo || '(none)'}${p.overlay ? ` · overlay: ${p.overlay}` : ''}`,
        `Claude: ${reg.pools[p.claude.active_pool].plan} (${p.claude.source}${p.claude.account_type ? `, login: ${p.claude.account_type}` : ''})${p.claude.expected_pool ? ` · repo expects: ${reg.pools[p.claude.expected_pool].plan}` : ''}`,
        `Families: ${p.families.join(', ')} · config: ${p.config.present ? 'ok' : 'missing'}`,
        `Orchestrator: ${p.orchestrator.choice}${p.orchestrator.project_orchestrators.length ? ` (project: ${p.orchestrator.project_orchestrators.map((x) => x.invoke).join(', ')})` : ''}`,
        `Registry: verified ${p.stale.verified_at} (${p.stale.age_days} d)${p.stale.stale ? ' · STALE: run /orchestrator:update' : ''}`,
        '', statusMarkdown(p.pools),
        ...p.warnings.map((w) => `⚠ ${w}`),
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
      return;
    }
    case 'project-pref': {
      const root = a.repo ? path.resolve(a.repo) : repoRoot();
      if (!root) return fail('not inside a repo (no .git / CLAUDE.md / .claude/skills found); pass --repo <path>');
      const values = {};
      if (a.orchestrator) {
        if (!['global', 'project', 'ask'].includes(a.orchestrator)) return fail('--orchestrator must be global|project|ask');
        values.orchestrator = a.orchestrator;
      }
      if (a['claude-pool']) {
        if (!reg.pools[a['claude-pool']] || reg.pools[a['claude-pool']].family !== reg.meta.main_family) return fail(`--claude-pool must be one of: ${Object.entries(reg.pools).filter(([, p]) => p.family === reg.meta.main_family).map(([k]) => k).join(', ')}`);
        values.claude_pool = a['claude-pool'];
      }
      if (!Object.keys(values).length) return out({ repo: root, prefs: readProjectPrefs(root) });
      return out({ repo: root, saved: writeProjectPref(root, values) });
    }
    case 'list': return out(Object.values(reg.models).filter((m) => !a.family || m.family === a.family).map((m) => ({ id: m.id, family: m.family, tier: m.tier, status: m.status, call_as: m.agent_model || m.cli_model, effort: m.effort.levels, default: m.effort.default })));
    case 'get': { const m = findModel(reg, a._[0]); return m ? out(m) : fail(`unknown model ${a._[0]}`, { excluded: isExcluded(reg, a._[0] || '') }); }
    case 'matrix': return out({ tier: loadMatrix('tier'), tier_bounds: loadMatrix('tier_bounds'), effort: loadMatrix('effort') });
    case 'candidates': {
      const r = candidates(reg, { type: a.type, complexity: a.complexity, risk: a.risk, sensitivity: a.sensitivity, role: a.role || 'author', excludeFamilies: a['exclude-family'], onlyFamilies: a['only-family'], allowUnverified: a['allow-unverified'], contextHeavy: a['context-heavy'], interactive: a.interactive });
      return out({ ...r, candidates: r.candidates.slice(0, Number(a.limit || 5)), rejected: a.limit === 'all' ? r.rejected : undefined });
    }
    case 'route': {
      const tasks = JSON.parse(fs.readFileSync(a.tasks, 'utf8'));
      const r = route(reg, tasks.tasks || tasks);
      if (a.md) { process.stdout.write(`${routeMarkdown(r)}\n\nUnits by family: ${JSON.stringify(r.units_by_family)}\nProjected pools: ${JSON.stringify(r.projected_pools)}\n`); return; }
      return out(r);
    }
    case 'fallback': return out(fallback(reg, { model: a.model, effort: a.effort, error: a.error, scope: a.scope, type: a.type, complexity: a.complexity, risk: a.risk, sensitivity: a.sensitivity }));
    case 'escalate': return out(escalate(reg, { model: a.model, effort: a.effort, failures: Number(a.failures || 1), type: a.type, complexity: a.complexity, risk: a.risk, sensitivity: a.sensitivity }));
    case 'observe': { const o = await observe(reg); if (a.out) fs.writeFileSync(a.out, JSON.stringify(o, null, 2)); return out(o); }
    case 'diff': {
      const d = diffRegistry(reg, JSON.parse(fs.readFileSync(a.observed, 'utf8')));
      if (a.md) { process.stdout.write(`${diffMarkdown(d)}\n`); return; }
      return out(d);
    }
    default: process.stdout.write(`${USAGE}\n`); process.exitCode = cmd ? 1 : 0;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => fail(e.message));
}
