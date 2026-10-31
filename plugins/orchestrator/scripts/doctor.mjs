#!/usr/bin/env node
// Backend of /orchestrator:doctor. Offline by default: zero model tokens, one compact table.
//   node doctor.mjs [--live] [--claude-live ok|fail:<reason>] [--claude-tokens N] [--json]
// --live adds one trivial call per enabled non-Claude family (cheapest model, lowest effort, read-only mode, tmp cwd).
// The Claude subagent dispatch cannot come from a script: the doctor skill runs it and passes the outcome in --claude-live.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRegistry, enabledFamilies, allPoolStatus, parseArgs, runProcess, effortRank, PLUGIN_DIR } from './lib/common.mjs';
import { syncCodexLimits } from './lib/codex-limits.mjs';
import { readConfig, validateConfig, serializeConfig, CONFIG_SCHEMA_VERSION } from './lib/config.mjs';
import { cliInfo, authCheck } from './lib/health.mjs';
import { validate, staleCheck, route } from './registry.mjs';
import { statusMarkdown } from './usage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const rows = [];
const add = (area, status, detail, fix = '') => rows.push({ area, status, detail, fix });
const ICON = { ok: '✅', warn: '⚠️', fail: '❌' };

// Cheapest usable model of a family and its lowest effort (used by the adapter self-test and by --live).
export function cheapestModel(reg, fid) {
  const ms = Object.values(reg.models).filter((m) => m.family === fid && ['active', 'unverified'].includes(m.status));
  ms.sort((a, b) => (a.base_cost_weight ?? 9) - (b.base_cost_weight ?? 9));
  const m = ms[0];
  if (!m) return null;
  const effort = [...m.effort.levels].sort((a, b) => effortRank(reg, a) - effortRank(reg, b))[0];
  return { model: m, effort };
}

function runScript(script, args, env) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180000 });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, error_kind: 'unparseable', error: (r.stdout + r.stderr).slice(0, 300) }; }
}

// ---------------------------------------------------------------- offline checks
function checkConfig(reg) {
  const { config, error } = readConfig();
  if (error) return add('config', 'fail', error, 'fix or delete config.yaml, then /orchestrator:configure');
  if (!config) return add('config', 'warn', `no config.yaml: conservative defaults (only ${reg.meta.main_family}, no sensitive data out)`, '/orchestrator:configure');
  const v = validateConfig(config, loadRegistry(undefined, { config: null }).families);
  if (!v.ok) return add('config', 'fail', v.errors.slice(0, 2).join('; '), '/orchestrator:configure (or edit config.yaml)');
  add('config', v.warnings.length ? 'warn' : 'ok', `schema ${CONFIG_SCHEMA_VERSION}, ${enabledFamilies(reg).length} families${v.warnings.length ? `; ${v.warnings[0]}` : ''}`);
}

function checkRegistry(reg) {
  const v = validate(reg);
  if (!v.ok) return add('registry', 'fail', v.errors.slice(0, 2).join('; '), 'repair models.yaml or /orchestrator:update');
  const st = staleCheck(reg);
  add('registry', st.stale ? 'warn' : 'ok', `${v.models} models, verified ${st.verified_at} (${st.age_days} d)${v.warnings.length ? `, ${v.warnings.length} warnings` : ''}`, st.stale ? '/orchestrator:update' : '');
  const planStale = [];
  for (const f of enabledFamilies(reg)) {
    for (const id of reg.families[f].configured_plans) {
      const c = reg.families[f].plans?.[id]?.data_policy?.checked;
      if (c && (Date.now() - Date.parse(c)) / 86400000 > reg.meta.stale_after_days) planStale.push(id);
    }
  }
  if (planStale.length) add('privacy terms', 'warn', `data-policy check older than ${reg.meta.stale_after_days} d: ${planStale.join(', ')}`, '/orchestrator:update');
}

function checkAgents(reg) {
  const dir = path.join(PLUGIN_DIR, 'agents');
  const bad = [];
  const names = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const head = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n---/)[0];
    const name = (head.match(/^name:\s*(\S+)/m) || [])[1];
    if (!name || !/^description:/m.test(head)) bad.push(f); else names.push(name);
  }
  const need = [...new Set([...Object.values(reg.meta.subagent_for_type), reg.meta.security_review_agent])];
  const missing = need.filter((n) => !names.includes(n));
  if (bad.length || missing.length) return add('agents', 'fail', `${bad.length ? `bad frontmatter: ${bad.join(', ')}; ` : ''}${missing.length ? `missing: ${missing.join(', ')}` : ''}`, 'reinstall the plugin');
  add('agents', 'ok', `${names.length} plugin agents (orchestrator:${names[0]} …) resolve for all task types`);
}

async function checkInstall() {
  const r = await runProcess(process.platform === 'win32' ? 'claude.exe' : 'claude', ['plugin', 'list'], { timeoutMs: 30000 });
  if (r.spawnError || (r.code !== 0 && !r.stdout)) return add('plugin install', 'warn', 'could not run `claude plugin list`', 'check the claude CLI');
  const line = r.stdout.split(/\r?\n/).find((l) => /orchestrator@/.test(l));
  if (!line) return add('plugin install', 'warn', 'orchestrator is not installed as a plugin (running from a checkout)', 'claude plugin install orchestrator@czekanskyy-tools --scope user');
  add('plugin install', 'ok', line.replace(/^\W+/, '').trim().slice(0, 80));
}

async function checkFamilies(reg) {
  for (const f of enabledFamilies(reg)) {
    const cli = await cliInfo(reg, f);
    if (!cli.found && reg.families[f].cli?.auth !== 'account-file') {
      add(`${f} cli`, 'fail', `${cli.bin || 'CLI'} not found on PATH`, `install the ${reg.families[f].label} CLI or disable it in /orchestrator:configure`);
      continue;
    }
    add(`${f} cli`, cli.version ? 'ok' : 'warn', cli.version || 'installed, version unreadable');
    const auth = await authCheck(reg, f);
    add(`${f} auth`, auth.status === 'ok' ? 'ok' : auth.status === 'fail' ? 'fail' : 'warn', auth.note, auth.status !== 'ok' ? `log in: ${f === 'gpt' ? 'codex login' : f === 'gemini' ? 'run agy once and sign in' : f === 'grok' ? 'grok login' : 'claude then /login'}${auth.status === 'fail' ? '' : ' (login could not be confirmed)'}` : '');
  }
}

// Exact Codex usage readout (zero tokens); the pool table below uses it when the call works.
async function checkLimits(reg) {
  if (!reg.families.gpt?.enabled) return;
  const r = await syncCodexLimits(reg);
  if (r.ok) add('gpt limits', 'ok', `codex app-server: 5h ${r.five_hour_pct}% · 7d ${r.seven_day_pct}% (plan ${r.plan_type})`);
  else add('gpt limits', 'warn', `exact readout unavailable (${r.error}): estimate used`, 'codex login; experimental interface may have changed');
}

// Adapters run on fixtures in an isolated state dir: simulate (all adapters) and a mock agy binary (Gemini).
function checkAdapters(reg) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-doctor-'));
  const cfg = { schema_version: CONFIG_SCHEMA_VERSION, main_family: 'claude', families: Object.fromEntries(Object.keys(reg.families).map((f) => [f, { enabled: true, plans: [reg.families[f].default_plan], data_policy: { sensitive_ok: false } }])) };
  fs.writeFileSync(path.join(tmp, 'config.yaml'), serializeConfig(cfg));
  const brief = path.join(tmp, 'brief.md');
  fs.writeFileSync(brief, 'Reply with exactly: OK\n');
  const env = { ORCH_HOME: path.join(tmp, 'state'), ORCH_CONFIG: path.join(tmp, 'config.yaml'), ORCH_NO_OVERLAY: '1', ORCH_PROJECT: tmp, ORCH_CLAUDE_ACCOUNT_FILE: path.join(tmp, 'none.json'), ORCH_AGY_BIN: path.join(FIXTURES, 'mock-agy.mjs') };
  const base = (m, e, extra = []) => ['--model', m.cli_model || m.id, '--effort', e, '--mode', 'research', '--prompt-file', brief, '--cwd', tmp, '--task-type', 'research', '--allow-unverified', ...extra];
  for (const f of enabledFamilies(reg)) {
    const script = reg.families[f].adapter?.script;
    if (!script) continue; // Claude family: dispatched as subagents, no adapter
    const pick = cheapestModel(reg, f);
    if (!pick) { add(`${f} adapter`, 'fail', 'no active model in registry', '/orchestrator:update'); continue; }
    const args = base(pick.model, pick.effort);
    const sim = runScript(script, [...args, '--simulate', 'ok'], env);
    const dry = runScript(script, [...args, '--dry-run'], env);
    const problems = [];
    if (!sim.ok) problems.push(`simulate: ${sim.error_kind || sim.error}`);
    if (!dry.ok || !dry.command) problems.push(`dry-run: ${dry.error_kind || 'no command'}`);
    if (f === 'gemini' && !problems.length) {
      const live = runScript(script, args, { ...env, MOCK_AGY_MODE: 'ok' });
      const resumed = runScript(script, [...args, '--resume-session', 'doctor-1'], { ...env, MOCK_AGY_MODE: 'ok' });
      const blocked = runScript(script, [...args, '--sensitivity', 'sensitive'], { ...env, MOCK_AGY_MODE: 'ok' });
      if (blocked.error_kind !== 'privacy_blocked') problems.push(`privacy gate did not block a sensitive task (${blocked.error_kind || blocked.sensitivity})`);
      const junk = runScript(script, args, { ...env, MOCK_AGY_MODE: 'garbage' });
      // the error run sets a pool cooldown (intended), so it goes last
      const err = runScript(script, args, { ...env, MOCK_AGY_MODE: 'error' });
      if (!live.ok || !/MOCK OK/.test(live.text || '') || !live.session_id || !live.usage?.total) problems.push('mock run did not parse');
      if (!resumed.ok || resumed.session_id !== 'doctor-1' || !/resumed=true/.test(resumed.text || '')) problems.push('resume failed');
      if (err.ok || err.error_kind !== 'rate_limit') problems.push(`error envelope -> ${err.error_kind}`);
      if (junk.ok || junk.error_kind === 'pool_cooldown') problems.push(`garbage output -> ${junk.ok ? 'accepted' : junk.error_kind}`);
    }
    add(`${f} adapter`, problems.length ? 'fail' : 'ok', problems.length ? problems.join('; ') : `${script}: simulate, dry-run${f === 'gemini' ? ', mock run, resume, error mapping, privacy gate' : ''} pass`, problems.length ? 'reinstall the plugin / report a bug' : '');
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir only */ }
}

// Fixture plan through the real router with the user's effective config: privacy filter + subagent assignment.
function checkRouting(reg) {
  const tasks = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'plan.json'), 'utf8')).tasks;
  const pools = Object.fromEntries(allPoolStatus(reg).map((p) => [p.pool, { ...p, pct: 10, level: 'ok', windows: p.windows.map((w) => ({ ...w, pct: 10 })), cooldown_until: null, model_cooldowns: {} }]));
  const r = route(reg, tasks, { pools });
  const problems = [];
  const sensitive = r.assignments.filter((x) => x.sensitivity === 'sensitive' && x.kind !== 'inline');
  for (const x of sensitive) {
    if (x.error) continue; // fail closed is a valid outcome
    if (reg.families[x.family]?.data_policy.sensitive_ok !== true) problems.push(`${x.id} (sensitive) -> ${x.family}`);
  }
  const agents = r.assignments.filter((x) => x.dispatch?.via === 'agent');
  for (const x of agents) {
    const name = String(x.dispatch.subagent_type).replace(/^orchestrator:/, '');
    if (!fs.existsSync(path.join(PLUGIN_DIR, 'agents', `${name}.md`))) problems.push(`${x.id}: agent ${name} missing`);
  }
  const noDispatch = r.assignments.filter((x) => x.kind !== 'inline' && !x.error && !x.dispatch);
  if (noDispatch.length) problems.push(`no dispatch for ${noDispatch.map((x) => x.id).join(', ')}`);
  const failedClosed = r.assignments.filter((x) => x.error).length;
  add('routing', problems.length ? 'fail' : 'ok', problems.length ? problems.join('; ') : `fixture plan: ${r.assignments.length} assignments, ${sensitive.length} sensitive task(s) only on sensitive_ok families${failedClosed ? `, ${failedClosed} failed closed` : ''}, ${agents.length} subagent dispatches`, problems.length ? 'privacy or agent wiring broken: report a bug' : '');
}

// ---------------------------------------------------------------- live checks
function checkLive(reg, a) {
  // Fixed, reused workspace: a Codex app-server broker may keep a handle on its cwd (Windows), so it is never deleted.
  const tmp = path.join(os.tmpdir(), 'orch-doctor-live');
  fs.mkdirSync(tmp, { recursive: true });
  const brief = path.join(tmp, 'brief.md');
  fs.writeFileSync(brief, 'Reply with exactly: OK\n');
  let tokens = 0;
  for (const f of enabledFamilies(reg)) {
    const script = reg.families[f].adapter?.script;
    if (!script) continue;
    const pick = cheapestModel(reg, f);
    if (!pick) continue;
    const res = runScript(script, ['--model', pick.model.cli_model || pick.model.id, '--effort', pick.effort, '--mode', 'research', '--prompt-file', brief, '--cwd', tmp, '--task-type', 'research', '--allow-unverified', '--sensitivity', 'none', '--timeout', '180'], {});
    tokens += Number(res.usage?.total || 0);
    const good = res.ok && /\bOK\b/i.test(res.text || '');
    add(`${f} live`, good ? 'ok' : res.ok ? 'warn' : 'fail', `${pick.model.id}/${pick.effort}: ${good ? 'answered' : res.ok ? `unexpected answer "${String(res.text).slice(0, 40)}"` : `${res.error_kind}: ${String(res.error || '').split('\n')[0].slice(0, 100)}`}${res.usage?.total ? ` (${res.usage.total} tokens)` : ''}`,
      good ? '' : res.error_kind === 'auth' ? res.suggest || 'log in' : res.error_kind === 'rate_limit' ? 'limit reached: retry later' : 'see run_dir in usage log / run the CLI by hand');
  }
  const cl = a['claude-live'];
  if (reg.families.claude?.enabled) {
    if (cl === 'ok') add('claude live', 'ok', 'orchestrator:orch-runner (haiku, low) answered');
    else if (cl) add('claude live', 'fail', `subagent dispatch failed: ${String(cl).replace(/^fail:/, '')}`, 'claude plugin list; reinstall the plugin');
    else add('claude live', 'warn', 'subagent dispatch not run (use /orchestrator:doctor --live)');
  }
  return tokens;
}

export async function doctor(a = {}) {
  const reg = loadRegistry();
  checkConfig(reg);
  checkRegistry(reg);
  checkAgents(reg);
  await checkInstall();
  await checkFamilies(reg);
  await checkLimits(reg);
  checkAdapters(reg);
  checkRouting(reg);
  const adapterTokens = a.live ? checkLive(reg, a) : 0;
  const claudeTokens = Number(a['claude-tokens'] || 0);
  const pools = allPoolStatus(reg);
  const counts = rows.reduce((o, r) => ({ ...o, [r.status]: (o[r.status] || 0) + 1 }), {});
  return { reg, rows, pools, counts, tokens: { adapters: adapterTokens, claude: claudeTokens, total: adapterTokens + claudeTokens }, live: !!a.live };
}

function render(d) {
  const L = ['| check | | detail | fix |', '|---|---|---|---|'];
  for (const r of d.rows) L.push(`| ${r.area} | ${ICON[r.status]} | ${r.detail.replace(/\|/g, '/')} | ${r.fix.replace(/\|/g, '/')} |`);
  L.push('', statusMarkdown(d.pools), '');
  L.push(`${d.counts.ok || 0} ✅  ${d.counts.warn || 0} ⚠️  ${d.counts.fail || 0} ❌ · model tokens spent: ${d.live ? `≈${d.tokens.total} (adapters ${d.tokens.adapters}, Claude subagent ${d.tokens.claude || 'n/a'}, plus the session's own overhead)` : '0 (offline)'}`);
  return L.join('\n');
}

async function main(argv) {
  const a = parseArgs(argv, { flags: ['live', 'json'] });
  const d = await doctor(a);
  if (a.json) { const { reg, ...rest } = d; process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`); }
  else process.stdout.write(`${render(d)}\n`);
  process.exitCode = d.counts.fail ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.stack}\n`); process.exitCode = 2; });
}
