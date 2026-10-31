#!/usr/bin/env node
// Self-tests. No real model calls and none of the user's state: isolated ORCH_HOME/ORCH_CONFIG, --simulate and a mock agy.
// Usage: node selftest.mjs [all|dryrun|fallback|escalate|update-detect|resume|overlay|accounts|gemini|privacy|config|doctor|update|migrate|guard|triage|flow|render] [--verbose]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-selftest-'));
process.env.ORCH_HOME = path.join(TMP, 'state');
process.env.ORCH_NO_OVERLAY = '1'; // deterministic: ignore any .claude/orchestrator.yaml around the cwd
process.env.ORCH_SELFTEST = '1'; // lets the resume guard see simulated runs
process.env.ORCH_CLAUDE_ACCOUNT_FILE = path.join(TMP, 'no-account.json'); // default Claude pool unless a test sets one
process.env.ORCH_PROJECT = TMP; // no repo prefs from the real cwd
process.env.ORCH_CONFIG = path.join(TMP, 'config.yaml'); // fixture config: every family enabled, catalog privacy policy
process.env.ORCH_AGY_BIN = path.join(HERE, 'fixtures', 'mock-agy.mjs');
const cfgLib = await import(pathToFileURL(path.join(HERE, 'lib', 'config.mjs')).href);
const FIXTURE_CONFIG = {
  schema_version: cfgLib.CONFIG_SCHEMA_VERSION,
  main_family: 'claude',
  families: {
    claude: { enabled: true, plans: ['claude_team', 'claude_pro'] },
    gpt: { enabled: true, plans: ['chatgpt_business'] },
    grok: { enabled: true, plans: ['grok_supergrok'] },
    gemini: { enabled: true, plans: ['gemini_ai_pro'] },
  },
};
fs.writeFileSync(process.env.ORCH_CONFIG, cfgLib.serializeConfig(FIXTURE_CONFIG));
const common = await import(pathToFileURL(path.join(HERE, 'lib', 'common.mjs')).href);
const registry = await import(pathToFileURL(path.join(HERE, 'registry.mjs')).href);
const { statusMarkdown } = await import(pathToFileURL(path.join(HERE, 'usage.mjs')).href);

const which = process.argv[2] || 'all';
const verbose = process.argv.includes('--verbose');
const results = [];
const check = (scenario, name, cond, detail = '') => {
  results.push({ scenario, name, pass: !!cond, detail });
  return cond;
};
const log = (...x) => console.log(...x);

function runAdapter(script, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  try { return JSON.parse(r.stdout); } catch { return { parse_error: r.stdout + r.stderr }; }
}

const brief = path.join(TMP, 'brief.md');
fs.writeFileSync(brief, 'Reply with exactly: OK\n');

// ---------------------------------------------------------------- 3. dry run of a full plan
function dryrun() {
  const reg = common.loadRegistry();
  const tasks = [
    { id: 'T1', title: 'Endpoint contract + validation schema', type: 'plan', complexity: 'S', risk: 'med' },
    { id: 'T2', title: 'Implement POST /items with validation', type: 'implement', complexity: 'M', risk: 'med', deps: ['T1'], files: ['src/routes/items.ts'] },
    { id: 'T3', title: 'Unit + integration tests for /items', type: 'test', complexity: 'M', risk: 'low', deps: ['T1'], files: ['test/items.test.ts'] },
    { id: 'T4', title: 'Auth guard + input sanitization on /items', type: 'implement', complexity: 'S', risk: 'high', deps: ['T2'], files: ['src/middleware/auth.ts'] },
  ];
  const pools = [
    { pool: 'claude_team', family: 'claude', plan: 'Claude Team', measurement: 'statusline', pct: 35, level: 'ok', windows: [{ id: '5h', pct: 35, source: 'statusline' }], model_cooldowns: {}, exact: true },
    { pool: 'chatgpt_business', family: 'gpt', plan: 'ChatGPT Business', measurement: 'estimate', pct: 10, level: 'ok', windows: [{ id: '5h', pct: 10, source: 'estimate' }], model_cooldowns: {} },
    { pool: 'grok_supergrok', family: 'grok', plan: 'SuperGrok', measurement: 'manual', pct: 5, level: 'ok', windows: [{ id: '7d', pct: 5, source: 'manual+estimate' }], model_cooldowns: {} },
  ];
  const r = registry.route(reg, tasks, { pools: Object.fromEntries(pools.map((p) => [p.pool, p])) });
  log('\n=== [3] DRY RUN: "add an endpoint with validation and tests" ===');
  log('Pools before:\n' + statusMarkdown(pools));
  log('\n' + registry.routeMarkdown(r));
  log(`\nUnits by family: ${JSON.stringify(r.units_by_family)}  Projected: ${JSON.stringify(r.projected_pools)}`);
  const authors = r.assignments.filter((a) => a.kind === 'author');
  check('dryrun', 'every subtask has model + effort', authors.every((a) => a.model && a.effort));
  for (const a of authors) {
    const xr = r.assignments.find((x) => x.kind === 'cross_review' && x.reviews === a.id);
    check('dryrun', `${a.id} cross-reviewed by another family`, xr && xr.family !== a.family && reg.families[xr.family].role === 'primary', xr ? `${a.family} -> ${xr.family}` : 'missing');
  }
  const t4x = r.assignments.find((x) => x.kind === 'extra_review' && x.reviews === 'T4');
  check('dryrun', 'high-risk T4 gets a Grok extra review', t4x && t4x.family === 'grok', t4x?.model);
  const t4 = authors.find((a) => a.id === 'T4');
  check('dryrun', 'high-risk T4: author stays standard tier (heavy models never write code)', t4?.tier === 'standard', t4?.model);
  const t4xr = r.assignments.find((x) => x.kind === 'cross_review' && x.reviews === 'T4');
  check('dryrun', 'high-risk T4: heavy cross-review with security lens + justification flag', t4xr?.tier === 'heavy' && t4xr.lens === 'security' && t4xr.requires_justification, t4xr?.model);
  const t1 = r.assignments.find((x) => x.id === 'T1');
  check('dryrun', 'S/med plan written inline by the main session (no agent, no critique)', t1?.kind === 'inline' && !r.assignments.some((x) => x.reviews === 'T1'));
  const u = r.units_by_family;
  const ratio = (u.claude || 0) / ((u.claude || 0) + (u.gpt || 0));
  check('dryrun', 'primary families share the work (Claude share 30-70% of units)', ratio >= 0.3 && ratio <= 0.7, JSON.stringify(u));
  check('dryrun', 'imbalanced start: authors lean to the less-used pool (GPT)', authors.filter((a) => a.family === 'gpt').length >= authors.filter((a) => a.family === 'claude').length);
  const even = pools.map((p) => (p.family === 'grok' ? p : { ...p, pct: 20, windows: [{ ...p.windows[0], pct: 20 }] }));
  const r2 = registry.route(reg, tasks.concat([
    { id: 'T5', title: 'Refactor validation helpers', type: 'refactor', complexity: 'M', risk: 'low' },
    { id: 'T6', title: 'Debug flaky DB test', type: 'debug', complexity: 'M', risk: 'med' },
    { id: 'T7', title: 'Add tracker row (text given)', type: 'mechanical', complexity: 'S', risk: 'low', dictated: true },
  ]), { pools: Object.fromEntries(even.map((p) => [p.pool, p])) });
  const t7 = r2.assignments.find((x) => x.id === 'T7');
  check('dryrun', 'dictated low-risk mechanical edit is exempt from cross-review', t7?.verification && !r2.assignments.some((x) => x.reviews === 'T7'));
  const evenPools = Object.fromEntries(even.map((p) => [p.pool, p]));
  const ch = registry.candidates(reg, { type: 'implement', complexity: 'M', risk: 'med', contextHeavy: true, pools: evenPools }).candidates[0];
  const ia = registry.candidates(reg, { type: 'implement', complexity: 'M', risk: 'med', interactive: true, pools: evenPools }).candidates[0];
  log(`context_heavy -> ${ch?.model}; interactive -> ${ia?.model}`);
  check('dryrun', 'context-heavy work leans outside the main family', ch && ch.family !== reg.meta.main_family);
  check('dryrun', 'interactive work stays with the main family', ia && ia.family === reg.meta.main_family);
  const fams2 = new Set(r2.assignments.filter((a) => a.kind === 'author').map((a) => a.family));
  log(`\nEven start (20%/20%), 6 subtasks -> author families: ${[...fams2].join(', ')}; units ${JSON.stringify(r2.units_by_family)}`);
  check('dryrun', 'even start: both primary families author code', fams2.has('claude') && fams2.has('gpt'));
  check('dryrun', 'efforts differ by task (not all max)', new Set(r.assignments.map((a) => a.effort)).size > 1 && !r.assignments.some((a) => reg.meta.approval_efforts.includes(a.effort)));
}

// ---------------------------------------------------------------- 4. simulated limit → fallback
function fallback() {
  log('\n=== [4] SIMULATED LIMIT -> FALLBACK ===');
  const common4 = ['--mode', 'implement', '--prompt-file', brief, '--cwd', TMP, '--task-type', 'implement', '--complexity', 'M', '--risk', 'med'];
  const t = runAdapter('run-codex.mjs', ['--model', 'gpt-6.1-sol', '--effort', 'high', ...common4, '--simulate', 'timeout']);
  log(`timeout      -> ${t.error_kind}; next: ${JSON.stringify(t.fallback_hint)}`);
  check('fallback', 'timeout -> lower effort on the same model first', t.error_kind === 'timeout' && t.fallback_hint?.step === 'lower_effort' && t.fallback_hint.effort === 'medium');

  const mlim = runAdapter('run-codex.mjs', ['--model', 'gpt-6-astra', '--effort', 'medium', ...common4, '--simulate', 'rate_limit_model']);
  log(`model limit  -> ${mlim.error_kind} (${mlim.limit?.scope}); next: ${JSON.stringify(mlim.fallback_hint)}`);
  check('fallback', 'model-scoped limit -> cheaper model in the same family', mlim.limit?.scope === 'model' && mlim.fallback_hint?.step === 'cheaper_model_same_family' && mlim.fallback_hint.family === 'gpt');

  const p = runAdapter('run-codex.mjs', ['--model', 'gpt-6.1-sol', '--effort', 'medium', ...common4, '--simulate', 'rate_limit']);
  log(`pool limit   -> ${p.error_kind} (${p.limit?.scope}); next: ${JSON.stringify(p.fallback_hint)}`);
  check('fallback', 'pool limit detected', p.error_kind === 'rate_limit' && p.limit?.scope === 'pool');
  check('fallback', 'pool limit -> other family', p.fallback_hint && p.fallback_hint.family !== 'gpt', p.fallback_hint?.model);
  const st = common.poolStatus(common.loadRegistry(), 'chatgpt_business');
  check('fallback', 'cooldown set on chatgpt_business', st.level === 'cooldown', st.cooldown_until);

  const again = runAdapter('run-codex.mjs', ['--model', 'gpt-6-luna', '--effort', 'low', ...common4]);
  log(`next call    -> ${again.error_kind}; next: ${JSON.stringify(again.fallback_hint)}`);
  check('fallback', 'adapter refuses calls into a cooled-down pool (no CLI call)', again.error_kind === 'pool_cooldown' && again.fallback_hint?.family !== 'gpt');

  const both = runAdapter('run-grok.mjs', ['--model', 'grok-4.7', '--effort', 'low', ...common4, '--simulate', 'rate_limit'], { ORCH_POOLS_OVERRIDE: JSON.stringify({ claude_team: { cooldown: true }, claude_pro: { cooldown: true }, gemini_ai_pro: { cooldown: true } }) });
  log(`grok limit with every other pool down -> next: ${JSON.stringify(both.fallback_hint)}`);
  check('fallback', 'all pools exhausted -> stop', both.fallback_hint?.step === 'stop');
  log(`usage.jsonl rows: ${common.readUsage().length}`);
}

// ---------------------------------------------------------------- 5. failed verification → escalation
function escalate() {
  log('\n=== [5] FAILED VERIFICATION -> ESCALATION ===');
  const reg = common.loadRegistry();
  for (const p of Object.keys(reg.pools)) common.clearCooldown(p); // isolate from the fallback scenario
  const ctx = { type: 'implement', complexity: 'M', risk: 'med' };
  const e1 = registry.escalate(reg, { model: 'gpt-6.1-sol', effort: 'medium', failures: 1, ...ctx });
  log(`1st failure: ${JSON.stringify(e1)}`);
  check('escalate', '1st failure -> effort +1 level only (medium -> high)', e1.action === 'raise_effort' && e1.effort === 'high' && e1.model === 'gpt-6.1-sol');
  const e1b = registry.escalate(reg, { model: 'claude-sonnet', effort: 'high', failures: 1, ...ctx });
  check('escalate', 'high -> xhigh (escalation ceiling), never max', e1b.action === 'raise_effort' && e1b.effort === 'xhigh', JSON.stringify(e1b));
  const e2 = registry.escalate(reg, { model: 'gpt-6.1-sol', effort: 'high', failures: 2, ...ctx });
  log(`2nd failure: ${JSON.stringify(e2)}`);
  check('escalate', '2nd failure -> other primary family at the same tier (fresh eyes)', e2.action === 'switch_family' && e2.family === 'claude' && e2.model === 'claude-sonnet', JSON.stringify(e2));
  const e3 = registry.escalate(reg, { model: 'claude-sonnet', effort: 'high', failures: 3, ...ctx });
  log(`3rd failure: ${JSON.stringify(e3)}`);
  check('escalate', '3rd failure -> heavy tier with justification, base effort', e3.action === 'raise_tier' && findTier(reg, e3.model) === 'heavy' && e3.requires_justification && e3.effort === 'medium');
  const e4 = registry.escalate(reg, { model: 'gpt-6-astra', effort: 'high', failures: 4, ...ctx });
  check('escalate', '4th failure -> stop and report', e4.action === 'stop_and_report');
}

// ---------------------------------------------------------------- 6. update detects a removed model
async function updateDetect() {
  log('\n=== [6] orchestrator-update DETECTS A REMOVED MODEL ===');
  const orig = fs.readFileSync(common.REGISTRY_PATH, 'utf8');
  const reduced = orig.replace(/\n {2}gpt-6-luna:\n[\s\S]*?(?=\n {2}gpt-6\.1-terra:)/, '\n');
  const tmpReg = path.join(TMP, 'models.reduced.yaml');
  fs.writeFileSync(tmpReg, reduced);
  const regReduced = common.loadRegistry(tmpReg);
  check('update-detect', 'reduced registry no longer has gpt-6-luna', !regReduced.models['gpt-6-luna']);
  const full = common.loadRegistry();
  const observed = {
    observed_at: new Date().toISOString(),
    families: {
      gpt: { source: 'fixture (from full registry)', complete: true, models: Object.values(full.models).filter((m) => m.family === 'gpt').map((m) => ({ id: m.cli_model, effort_levels: m.effort.levels, context_tokens: m.context_tokens })) },
    },
  };
  const d = registry.diffRegistry(regReduced, observed);
  log(registry.diffMarkdown(d));
  check('update-detect', 'diff proposes adding gpt-6-luna', d.added.some((x) => x.id === 'gpt-6-luna'));
  check('update-detect', 'excluded models are never proposed', !d.added.some((x) => /fable|daybreak/.test(x.id)));
  if (common.which('codex')) {
    const r = spawnSync('codex', ['debug', 'models', '--bundled'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    try {
      const j = JSON.parse(r.stdout);
      const live = { observed_at: new Date().toISOString(), families: { gpt: { source: 'codex debug models --bundled', complete: true, models: j.models.filter((m) => m.visibility === 'list').map((m) => ({ id: m.slug, effort_levels: m.supported_reasoning_levels.map((x) => x.effort), context_tokens: m.context_window })) } } };
      const dl = registry.diffRegistry(regReduced, live);
      log(`\n(live codex catalog vs reduced registry)\n${registry.diffMarkdown(dl)}`);
      check('update-detect', 'live codex catalog also flags gpt-6-luna', dl.added.some((x) => x.id === 'gpt-6-luna'));
    } catch (e) { log(`live catalog skipped: ${e.message}`); }
  }
}

function findTier(reg, id) { return reg.models[id]?.tier; }

// ---------------------------------------------------------------- v1-derived features
function resume() {
  log('\n=== RESUME GUARD (fix rounds reuse the worker session) ===');
  const base = ['--model', 'gpt-6.1-sol', '--effort', 'medium', '--mode', 'implement', '--prompt-file', brief, '--cwd', TMP];
  const first = runAdapter('run-codex.mjs', [...base, '--simulate', 'ok']);
  const ok = runAdapter('run-codex.mjs', [...base, '--resume-of', first.run_id, '--dry-run']);
  check('resume', 'resume-of the latest Codex task -> --resume-last', ok.resumed === true && /--resume-last/.test(ok.command), ok.command);
  runAdapter('run-codex.mjs', [...base, '--simulate', 'ok']); // another package ran since
  const stale = runAdapter('run-codex.mjs', [...base, '--resume-of', first.run_id, '--dry-run']);
  check('resume', 'stale resume-of -> fresh thread + warning', stale.resumed === false && /--fresh/.test(stale.command) && stale.warnings?.length);
  const g = runAdapter('run-grok.mjs', ['--model', 'grok-4.7', '--effort', 'low', '--mode', 'review', '--prompt-file', brief, '--cwd', TMP, '--resume-session', 'abc-123', '--dry-run']);
  check('resume', 'grok resumes by exact session id', g.resumed === true && /-r abc-123/.test(g.command));
  check('resume', 'grok denies lockfile reads (token economy)', /pnpm-lock\.yaml/.test(g.command));
}

function overlay() {
  log('\n=== PROJECT OVERLAY (.claude/orchestrator.yaml) ===');
  const proj = path.join(TMP, 'proj');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'orchestrator.yaml'), 'families:\n  claude:\n    pool: claude_pro\n');
  const saved = { p: process.env.ORCH_PROJECT, n: process.env.ORCH_NO_OVERLAY };
  process.env.ORCH_PROJECT = path.join(proj, 'src');
  process.env.ORCH_NO_OVERLAY = '0';
  try {
    const reg = common.loadRegistry();
    check('overlay', 'overlay found from a subdirectory', reg.meta.overlay?.endsWith('orchestrator.yaml'));
    check('overlay', 'Claude models repointed to the overlay pool', reg.models['claude-sonnet'].pool === 'claude_pro');
    check('overlay', 'merged registry still validates', registry.validate(reg).ok, JSON.stringify(registry.validate(reg).errors));
    check('overlay', 'other families untouched', reg.models['gpt-6.1-sol'].pool === 'chatgpt_business');
  } finally {
    process.env.ORCH_PROJECT = saved.p;
    process.env.ORCH_NO_OVERLAY = saved.n;
  }
}

// ---------------------------------------------------------------- Claude subscriptions + orchestrator choice
function accounts() {
  log('\n=== CLAUDE SUBSCRIPTION DETECTION + PER-REPO CHOICE ===');
  const acctFile = path.join(TMP, 'claude.json');
  const setAcct = (type) => fs.writeFileSync(acctFile, JSON.stringify({ oauthAccount: { organizationType: type, organizationUuid: `uuid-${type}` } }));
  const saved = { a: process.env.ORCH_CLAUDE_ACCOUNT_FILE, p: process.env.ORCH_PROJECT };
  process.env.ORCH_CLAUDE_ACCOUNT_FILE = acctFile;
  const repo = path.join(TMP, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.claude', 'skills', 'orchestrate'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'skills', 'orchestrate', 'SKILL.md'), '---\nname: orchestrate\ndescription: team orchestrator\n---\n');
  process.env.ORCH_PROJECT = repo;
  try {
    check('accounts', 'no login info -> default pool (Team)', common.loadRegistry().families.claude.pool === 'claude_team');
    setAcct('claude_pro');
    let reg = common.loadRegistry();
    check('accounts', 'login organizationType claude_pro -> claude_pro pool', reg.families.claude.pool === 'claude_pro' && reg.models['claude-opus'].pool === 'claude_pro' && reg.meta.main_pool.source === 'login');
    setAcct('claude_team');
    reg = common.loadRegistry();
    check('accounts', 'team login -> claude_team pool', reg.families.claude.pool === 'claude_team');

    let pf = registry.preflight(reg);
    check('accounts', 'project orchestrator detected; no preference -> ask', pf.orchestrator.choice === 'ask' && pf.orchestrator.project_orchestrators[0]?.invoke === '/orchestrate');
    common.writeProjectPref(repo, { orchestrator: 'global', claude_pool: 'claude_pro' });
    reg = common.loadRegistry();
    pf = registry.preflight(reg);
    log(`preflight: choice=${pf.orchestrator.choice}; claude=${pf.claude.active_pool} (expected ${pf.claude.expected_pool}); warnings=${JSON.stringify(pf.warnings)}`);
    check('accounts', 'saved per-repo preference -> global orchestrator', pf.orchestrator.choice === 'global');
    check('accounts', 'hobby repo expects Pro while logged into Team -> mismatch warning', pf.warnings.some((w) => /expects Claude Pro/.test(w)));
    check('accounts', 'preferences live outside the repo (user-local)', !fs.readdirSync(path.join(repo, '.claude')).some((f) => /yaml$/.test(f)) && fs.existsSync(common.PROJECTS_FILE));

    const fb = registry.fallback(reg, { model: 'claude-sonnet', effort: 'medium', error: 'pool_cooldown', type: 'implement', complexity: 'M', risk: 'med', pools: Object.fromEntries(common.allPoolStatus(reg).map((p) => [p.pool, p.pool === 'claude_team' ? { ...p, level: 'cooldown' } : p])) });
    log(`Team exhausted -> next: ${fb.next.model} (${fb.next.family}); suggest: ${fb.suggest_account_switch?.plan}`);
    check('accounts', 'Team exhausted -> other family now + suggest switching to personal Pro', fb.next.family !== 'claude' && fb.suggest_account_switch?.to_pool === 'claude_pro');
  } finally {
    process.env.ORCH_CLAUDE_ACCOUNT_FILE = saved.a;
    process.env.ORCH_PROJECT = saved.p;
  }
}

// ---------------------------------------------------------------- v3: helpers
const PLUGIN = path.dirname(HERE);
const runNode = (script, args, env = {}, cwd = TMP) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd, env: { ...process.env, ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
};
const geminiPick = () => {
  const reg = common.loadRegistry();
  const m = Object.values(reg.models).find((x) => x.family === 'gemini' && x.status !== 'deprecated');
  return { reg, model: m.cli_model || m.id, effort: m.effort.levels[0], pool: reg.families.gemini.pool };
};

// ---------------------------------------------------------------- v3: Gemini adapter against the mock agy
function gemini() {
  log('\n=== GEMINI ADAPTER (mock agy) ===');
  const { model, effort, pool } = geminiPick();
  const mockLog = path.join(TMP, 'agy-argv.log');
  const base = ['--model', model, '--effort', effort, '--mode', 'research', '--prompt-file', brief, '--cwd', TMP, '--task-type', 'research', '--allow-unverified'];
  const run = (mode, extra = []) => runAdapter('run-gemini.mjs', [...base, ...extra], { MOCK_AGY_MODE: mode, MOCK_AGY_LOG: mockLog });

  const dry = runAdapter('run-gemini.mjs', [...base, '--dry-run']);
  check('gemini', 'dry-run prints a headless agy command (json, plan mode, prompt last)', dry.ok && /--output-format json/.test(dry.command) && /--mode plan/.test(dry.command), dry.command);
  const reg = common.loadRegistry();
  const status = Object.values(reg.models).find((x) => x.family === 'gemini').status;
  const unv = runAdapter('run-gemini.mjs', base.filter((x) => x !== '--allow-unverified'), { MOCK_AGY_MODE: 'ok' });
  check('gemini', 'an unverified model needs --allow-unverified (active models run freely)', status === 'unverified' ? unv.error_kind === 'unverified_model' : unv.ok === true, `${status}: ${unv.error_kind}`);

  const ok = run('ok');
  check('gemini', 'ok run: envelope parsed (text, session id, usage)', ok.ok && /MOCK OK/.test(ok.text) && ok.session_id === 'mock-conversation-1' && ok.usage?.total === 1320, JSON.stringify(ok).slice(0, 200));
  check('gemini', 'effort is encoded in the model id (<model>-<effort>)', new RegExp(`--model ${model}-${effort}`).test(fs.readFileSync(mockLog, 'utf8').replace(/[\[\]",]/g, ' ').replace(/\s+/g, ' ')) || fs.readFileSync(mockLog, 'utf8').includes(`${model}-${effort}`));
  const res = run('ok', ['--resume-session', 'abc-1']);
  check('gemini', 'resume-session reuses the conversation', res.ok && res.session_id === 'abc-1' && /resumed=true/.test(res.text));
  const blocked = run('ok', ['--sensitivity', 'sensitive']);
  check('gemini', 'sensitive task is refused by the adapter (privacy_blocked), no CLI call', blocked.error_kind === 'privacy_blocked' && !!blocked.fallback_hint, blocked.error_kind);
  const viaFile = run('ok', ['--sensitivity', 'internal', '--file', '.env.production']);
  check('gemini', 'a sensitive file in --file escalates and is refused', viaFile.error_kind === 'privacy_blocked', viaFile.error_kind);
  const denied = run('denied');
  check('gemini', 'denied permission (exit 0) is surfaced in text', denied.ok && /denied|not allowed/i.test(denied.text), denied.text);
  const junk = run('garbage');
  check('gemini', 'non-JSON output is an error, not a success', !junk.ok && junk.error_kind !== 'pool_cooldown', junk.error_kind);
  const err = run('error');
  check('gemini', 'ERROR envelope with quota text -> rate_limit', !err.ok && err.error_kind === 'rate_limit', err.error_kind);
  const after = run('ok');
  check('gemini', 'rate limit cools the pool down; the next call is refused without a CLI call', after.error_kind === 'pool_cooldown', after.error_kind);
  common.clearCooldown(pool);
}

// ---------------------------------------------------------------- v3: privacy routing
function privacy() {
  log('\n=== PRIVACY ROUTING ===');
  const tasks = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'plan.json'), 'utf8')).tasks;
  const cfg = (sens) => ({ ...FIXTURE_CONFIG, families: Object.fromEntries(Object.entries(FIXTURE_CONFIG.families).map(([f, v]) => [f, { ...v, data_policy: { sensitive_ok: !!sens[f] } }])) });
  const poolsFor = (reg) => Object.fromEntries(common.allPoolStatus(reg).map((p) => [p.pool, { ...p, pct: 10, level: 'ok', cooldown_until: null, model_cooldowns: {}, windows: p.windows.map((w) => ({ ...w, pct: 10 })) }]));
  const routeWith = (sens, t = tasks) => { const reg = common.loadRegistry(undefined, { config: cfg(sens) }); return { reg, r: registry.route(reg, t, { pools: poolsFor(reg) }) }; };
  const sensitiveIds = ['F4', 'F5'];
  const onlyOk = (reg, r) => r.assignments.filter((a) => sensitiveIds.some((id) => a.id === id || a.id.startsWith(`${id}-`)) && a.kind !== 'inline' && !a.error).every((a) => reg.families[a.family].data_policy.sensitive_ok === true);

  // only GPT may see sensitive data
  let { reg, r } = routeWith({ gpt: true });
  check('privacy', 'sensitive F4 (flagged) lands only on a sensitive_ok family', onlyOk(reg, r), JSON.stringify(r.assignments.filter((a) => /^F4/.test(a.id)).map((a) => [a.id, a.family])));
  const f5 = r.assignments.find((a) => a.id === 'F5');
  check('privacy', 'F5 (.env.production, not flagged) is escalated to sensitive by its path', f5?.sensitivity === 'sensitive' && f5.family === 'gpt', `${f5?.sensitivity} ${f5?.family}`);
  const f4x = r.assignments.filter((a) => /^F4-xr/.test(a.id));
  check('privacy', 'F4 cross-review: absent with a cross_review_gap note, or on a sensitive_ok family', f4x.length ? f4x.every((a) => reg.families[a.family].data_policy.sensitive_ok === true) : JSON.stringify(r).includes('cross_review_gap'), JSON.stringify(f4x.map((a) => a.family)));
  const f6 = r.assignments.find((a) => a.id === 'F6');
  check('privacy', 'a none-sensitivity task is not restricted', f6 && f6.sensitivity === 'none' && !f6.error);
  const f2 = r.assignments.find((a) => a.id === 'F2');
  check('privacy', 'internal tasks are still routed (soft preference only)', f2 && !f2.error && f2.sensitivity === 'internal');

  // nobody may see sensitive data: fail closed
  ({ reg, r } = routeWith({}));
  const f4 = r.assignments.find((a) => a.id === 'F4');
  check('privacy', 'no sensitive_ok family: sensitive task fails closed (no candidate)', f4 && !!f4.error && !f4.model, JSON.stringify(f4).slice(0, 160));
  check('privacy', 'fail-closed result never names an external family for F4/F5', r.assignments.filter((a) => /^F[45]/.test(a.id) && a.kind !== 'inline').every((a) => a.error || a.family === undefined), '');

  // unknown policy (custom plan) is conservative
  const reg2 = common.loadRegistry(undefined, { config: { ...FIXTURE_CONFIG, families: { ...FIXTURE_CONFIG.families, gpt: { enabled: true, plans: ['some_future_plan'] } } } });
  check('privacy', 'a custom plan id has no policy -> sensitive_ok=false', reg2.families.gpt.data_policy.sensitive_ok === false);
  const all = common.loadRegistry(undefined, { config: FIXTURE_CONFIG });
  check('privacy', 'consumer Gemini plan: catalog says sensitive_ok=false', all.families.gemini.data_policy.sensitive_ok === false && all.families.gemini.data_policy.training_on_data !== false);
  const noCfg = common.loadRegistry(undefined, { config: null });
  check('privacy', 'without a config only the main family is enabled', Object.values(noCfg.families).filter((f) => f.enabled).length === 1 && noCfg.families[noCfg.meta.main_family].enabled);

  // fallback and escalation keep the filter
  const reg3 = common.loadRegistry(undefined, { config: cfg({ gpt: true }) });
  const fb = registry.fallback(reg3, { model: 'gpt-6.1-sol', effort: 'medium', error: 'rate_limit', type: 'implement', complexity: 'M', risk: 'med', sensitivity: 'sensitive', pools: poolsFor(reg3) });
  check('privacy', 'fallback for a sensitive task never proposes a sensitive_ok=false family', !fb.next || !fb.next.family || reg3.families[fb.next.family].data_policy.sensitive_ok === true, JSON.stringify(fb.next));
  const es = registry.escalate(reg3, { model: 'gpt-6.1-sol', effort: 'high', failures: 2, type: 'implement', complexity: 'M', risk: 'med', sensitivity: 'sensitive', pools: poolsFor(reg3) });
  check('privacy', 'escalation for a sensitive task never switches to a sensitive_ok=false family', es.action !== 'switch_family' || reg3.families[es.family].data_policy.sensitive_ok === true, JSON.stringify(es));

  // adapters enforce the same rule on their own
  const a = runAdapter('run-grok.mjs', ['--model', 'grok-4.7', '--effort', 'low', '--mode', 'review', '--prompt-file', brief, '--cwd', TMP, '--sensitivity', 'sensitive', '--simulate', 'ok']);
  check('privacy', 'run-grok refuses a sensitive task (second gate)', a.error_kind === 'privacy_blocked', a.error_kind);
  const codexArgs = ['--model', 'gpt-6-luna', '--effort', 'low', '--mode', 'review', '--prompt-file', brief, '--cwd', TMP, '--sensitivity', 'sensitive', '--simulate', 'ok'];
  fs.writeFileSync(path.join(TMP, 'deny-config.yaml'), cfgLib.serializeConfig(cfg({})));
  fs.writeFileSync(path.join(TMP, 'sens-config.yaml'), cfgLib.serializeConfig(cfg({ gpt: true })));
  const b1 = runAdapter('run-codex.mjs', codexArgs, { ORCH_CONFIG: path.join(TMP, 'deny-config.yaml') });
  const b2 = runAdapter('run-codex.mjs', codexArgs, { ORCH_CONFIG: path.join(TMP, 'sens-config.yaml') });
  check('privacy', 'run-codex: sensitive refused when the config says no, accepted when it says yes', b1.error_kind === 'privacy_blocked' && b2.ok === true, `${b1.error_kind} / ${b2.error_kind || 'ok'}`);
}

// ---------------------------------------------------------------- v3: config schema
function config() {
  log('\n=== CONFIG SCHEMA ===');
  const reg = common.loadRegistry(undefined, { config: null });
  const v = (c) => cfgLib.validateConfig(c, reg.families);
  check('config', 'fixture config is valid', v(FIXTURE_CONFIG).ok, JSON.stringify(v(FIXTURE_CONFIG).errors));
  check('config', 'serialize -> parse round trip validates', v(JSON.parse(JSON.stringify(cfgLib.readConfig(process.env.ORCH_CONFIG).config))).ok);
  check('config', 'unknown top-level key rejected', !v({ ...FIXTURE_CONFIG, surprise: 1 }).ok);
  check('config', 'unknown family rejected', !v({ ...FIXTURE_CONFIG, families: { nope: { enabled: true } } }).ok);
  check('config', 'unknown family key rejected', !v({ ...FIXTURE_CONFIG, families: { gpt: { enabled: true, wat: 1 } } }).ok);
  check('config', 'main_family must be a known family', !v({ ...FIXTURE_CONFIG, main_family: 'nope' }).ok);
  check('config', 'sensitive_ok must be boolean', !v({ ...FIXTURE_CONFIG, families: { gpt: { enabled: true, data_policy: { sensitive_ok: 'yes' } } } }).ok);
  check('config', 'secret-like key rejected', !v({ ...FIXTURE_CONFIG, families: { gpt: { enabled: true, api_key: 'x' } } }).ok);
  check('config', 'secret-like value rejected', !v({ ...FIXTURE_CONFIG, families: { gpt: { enabled: true, plans: ['sk-abcdefghijklmnopqrstuvwxyz123456'] } } }).ok);
  check('config', 'wrong schema_version rejected', !v({ ...FIXTURE_CONFIG, schema_version: 99 }).ok);

  const home = path.join(TMP, 'cfg-home');
  const env = { ORCH_HOME: home, ORCH_CONFIG: path.join(home, 'config.yaml'), ORCH_NO_OVERLAY: '1' };
  const cfgScript = path.join(HERE, 'configure.mjs');
  const answers = path.join(TMP, 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ main_family: 'claude', families: { claude: { enabled: true, plans: ['claude_team'] }, gemini: { enabled: true, plans: ['gemini_ai_pro'], data_policy: { sensitive_ok: false } } }, defaults: { orchestrator: 'ask' } }));
  const a1 = runNode(cfgScript, ['apply', '--answers', answers], env);
  check('config', 'apply writes a valid config and reports the effective setup', a1.code === 0 && a1.json?.changed === true && fs.existsSync(env.ORCH_CONFIG), a1.stderr || a1.stdout.slice(0, 200));
  const written = fs.readFileSync(env.ORCH_CONFIG, 'utf8');
  check('config', 'config.yaml holds no secrets and no token-like text', !/token|secret|password|api[_-]?key|sk-/i.test(written.replace(/^#.*$/gm, '')));
  const a2 = runNode(cfgScript, ['apply', '--answers', answers], env);
  check('config', 'apply is idempotent (second run: changed=false)', a2.json?.changed === false);
  fs.writeFileSync(answers, JSON.stringify({ families: { gpt: { enabled: true, plans: ['chatgpt_business'] } } }));
  runNode(cfgScript, ['apply', '--answers', answers], env);
  const kept = cfgLib.readConfig(env.ORCH_CONFIG).config;
  check('config', 'partial answers keep earlier families (merge, not replace)', kept.families.claude?.enabled && kept.families.gemini?.enabled && kept.families.gpt?.enabled);
  fs.writeFileSync(answers, JSON.stringify({ families: { gpt: { enabled: true, api_key: 'nope' } } }));
  const before = fs.readFileSync(env.ORCH_CONFIG, 'utf8');
  const bad = runNode(cfgScript, ['apply', '--answers', answers], env);
  check('config', 'invalid answers: exit 1 and the file is untouched', bad.code === 1 && fs.readFileSync(env.ORCH_CONFIG, 'utf8') === before);
  const val = runNode(cfgScript, ['validate'], env);
  check('config', 'validate passes on the written file', val.code === 0 && val.json?.ok === true);
  const det = runNode(cfgScript, ['detect'], { ...env, ORCH_AGY_BIN: path.join(HERE, 'fixtures', 'mock-agy.mjs') });
  check('config', 'detect is generic over the registry (all families, no secrets in output)', det.json && Object.keys(det.json.families).length === Object.keys(reg.families).length && !/token|secret/i.test(det.stdout.replace(/"(sensitive|training)[^"]*"/g, '')), det.stderr.slice(0, 200));
}

// ---------------------------------------------------------------- v3: doctor (offline)
async function doctorOffline() {
  log('\n=== DOCTOR (offline) ===');
  const dr = await import(pathToFileURL(path.join(HERE, 'doctor.mjs')).href);
  const d = await dr.doctor({});
  const areas = d.rows.map((r) => r.area);
  check('doctor', 'runs offline and spends 0 model tokens', d.live === false && d.tokens.total === 0);
  check('doctor', 'no failing row with the fixture config', d.counts.fail === undefined, d.rows.filter((r) => r.status === 'fail').map((r) => `${r.area}: ${r.detail}`).join('; '));
  check('doctor', 'covers config, registry, agents, routing and an adapter per external family', ['config', 'registry', 'agents', 'routing'].every((x) => areas.some((a) => a.startsWith(x))) && ['gpt adapter', 'grok adapter', 'gemini adapter'].every((x) => areas.includes(x)), areas.join(','));
  check('doctor', 'every row carries a status and a detail', d.rows.every((r) => ['ok', 'warn', 'fail'].includes(r.status) && r.detail));
  check('doctor', 'every non-ok row has a fix hint', d.rows.filter((r) => r.status !== 'ok').every((r) => r.fix), d.rows.filter((r) => r.status !== 'ok' && !r.fix).map((r) => r.area).join(', '));
  const cli = runNode(path.join(HERE, 'doctor.mjs'), [], { ORCH_HOME: path.join(TMP, 'doc-home') });
  check('doctor', 'CLI prints one table with a token line', /\| check \|/.test(cli.stdout) && /model tokens spent: 0/.test(cli.stdout), cli.stdout.slice(-200));
}

// ---------------------------------------------------------------- v3: update never touches user config
function update() {
  log('\n=== UPDATE (scan / stamp) ===');
  const copy = path.join(TMP, 'plugin-copy');
  fs.cpSync(PLUGIN, copy, { recursive: true, filter: (s) => !/node_modules|\.git$/.test(s) });
  const script = path.join(copy, 'scripts', 'update.mjs');
  const cfgBefore = fs.readFileSync(process.env.ORCH_CONFIG, 'utf8');
  const modelsBefore = fs.readFileSync(path.join(copy, 'models.yaml'), 'utf8');
  const sc = runNode(script, ['scan', '--out', path.join(TMP, 'scan.json')], { ORCH_REGISTRY: '', ORCH_AGY_BIN: path.join(HERE, 'fixtures', 'mock-agy.mjs') });
  check('update', 'scan lists the configured families only', sc.code === 0 && sc.json?.configured_families?.includes('gemini') && sc.json.sources, sc.stderr.slice(0, 200));
  const dry = runNode(script, ['stamp', '--date', '2030-01-02', '--note', 'x'], { ORCH_REGISTRY: '' });
  check('update', 'stamp without --approved is a dry run (nothing written)', dry.json?.dry_run === true && fs.readFileSync(path.join(copy, 'models.yaml'), 'utf8') === modelsBefore);
  const st = runNode(script, ['stamp', '--approved', '--date', '2030-01-02', '--plans', 'chatgpt_business', '--note', '- selftest entry'], { ORCH_REGISTRY: '' });
  const models = fs.readFileSync(path.join(copy, 'models.yaml'), 'utf8');
  check('update', 'approved stamp bumps meta.verified_at and the plan date', st.code === 0 && /verified_at: "2030-01-02"/.test(models), st.stderr.slice(0, 200));
  check('update', 'approved stamp prepends a CHANGELOG entry', /## Registry update 2030-01-02[\s\S]*selftest entry/.test(fs.readFileSync(path.join(copy, 'CHANGELOG.md'), 'utf8')));
  const v = runNode(path.join(copy, 'scripts', 'registry.mjs'), ['validate'], { ORCH_REGISTRY: '' });
  check('update', 'registry still validates after a stamp', v.json?.ok === true, JSON.stringify(v.json?.errors));
  check('update', "the user's config.yaml is never modified", fs.readFileSync(process.env.ORCH_CONFIG, 'utf8') === cfgBefore);
  check('update', 'the real plugin files were not touched by the test', !/2030-01-02/.test(fs.readFileSync(path.join(PLUGIN, 'models.yaml'), 'utf8')));
}

// ---------------------------------------------------------------- v3: migration (v2 -> v3) on a fake ~/.claude
function migrate() {
  log('\n=== MIGRATE (fake ~/.claude) ===');
  const claude = path.join(TMP, 'fake-claude');
  const env = { CLAUDE_CONFIG_DIR: claude, ORCH_HOME: path.join(claude, 'orchestrator'), ORCH_CONFIG: path.join(claude, 'orchestrator', 'config.yaml') };
  const script = path.join(HERE, 'migrate.mjs');
  fs.mkdirSync(path.join(claude, 'skills', 'orchestrator', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'skills', 'orchestrator-update'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'agents'), { recursive: true });
  fs.mkdirSync(env.ORCH_HOME, { recursive: true });
  fs.writeFileSync(path.join(claude, 'skills', 'orchestrator', 'SKILL.md'), '---\nname: orchestrator\n---\n');
  fs.writeFileSync(path.join(claude, 'skills', 'orchestrator-update', 'SKILL.md'), '---\nname: orchestrator-update\n---\n');
  fs.writeFileSync(path.join(claude, 'agents', 'orch-implementer.md'), 'v2 agent\n');
  fs.writeFileSync(path.join(claude, 'agents', 'orch-edited.md'), 'v2 agent\n');
  fs.writeFileSync(path.join(env.ORCH_HOME, 'usage.jsonl'), `${JSON.stringify({ ts: '2026-10-01T00:00:00Z', model: 'claude-sonnet', pool: 'claude_team' })}\n`);
  fs.writeFileSync(path.join(claude, 'agents', 'unrelated.md'), 'not ours\n');

  const refuse = runNode(script, ['cleanup', '--approved'], env);
  check('migrate', 'cleanup refuses without a backup', refuse.code !== 0 && fs.existsSync(path.join(claude, 'skills', 'orchestrator', 'SKILL.md')));
  const bk = runNode(script, ['backup'], env);
  const bdir = bk.json?.dest || bk.json?.backup;
  check('migrate', 'backup copies v2 skills and agents', bk.code === 0 && bdir && fs.existsSync(path.join(bdir, 'agents', 'orch-implementer.md')), bk.stdout.slice(0, 200));
  const noPlugin = runNode(script, ['cleanup', '--approved'], env);
  check('migrate', 'cleanup refuses while the plugin is not installed', noPlugin.code !== 0 && fs.existsSync(path.join(claude, 'skills', 'orchestrator', 'SKILL.md')));
  const noFlag = runNode(script, ['cleanup'], env);
  check('migrate', 'cleanup needs --approved', noFlag.code !== 0);
  fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'orchestrator@czekanskyy-tools': [{ scope: 'user', installPath: PLUGIN, version: '3.0.0' }] } }));
  fs.writeFileSync(path.join(claude, 'agents', 'orch-edited.md'), 'edited after the backup\n'); // differs from the backup: must survive
  const done = runNode(script, ['cleanup', '--approved'], env);
  check('migrate', 'cleanup removes the v2 skills and the unchanged orch-* agents', done.code === 0 && !fs.existsSync(path.join(claude, 'skills', 'orchestrator', 'SKILL.md')) && !fs.existsSync(path.join(claude, 'skills', 'orchestrator-update')) && !fs.existsSync(path.join(claude, 'agents', 'orch-implementer.md')), done.stderr.slice(0, 200));
  check('migrate', 'an agent edited after the backup, and unrelated agents, are kept', fs.existsSync(path.join(claude, 'agents', 'orch-edited.md')) && fs.existsSync(path.join(claude, 'agents', 'unrelated.md')));
  const shim = path.join(claude, 'skills', 'orchestrator', 'scripts', 'statusline.mjs');
  check('migrate', 'a statusline forwarding shim stays at the old path (no SKILL.md, so not a skill)', fs.existsSync(shim) && !fs.existsSync(path.join(claude, 'skills', 'orchestrator', 'SKILL.md')));
  const vs = runNode(script, ['validate-state'], env);
  check('migrate', 'usage log survives and validates', vs.code === 0 && fs.existsSync(path.join(env.ORCH_HOME, 'usage.jsonl')));
}

// ---------------------------------------------------------------- v3: entry-point guard (importing never starts a CLI)
function guard() {
  log('\n=== ENTRY-POINT GUARD ===');
  const scripts = ['run-codex.mjs', 'run-grok.mjs', 'run-gemini.mjs', 'doctor.mjs', 'update.mjs', 'configure.mjs', 'migrate.mjs', 'registry.mjs', 'usage.mjs', 'triage.mjs', 'run.mjs', 'dryrun.mjs', 'egm-gate.mjs'];
  for (const s of scripts) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(HERE, s)).href)}); console.log('imported')`], { encoding: 'utf8', env: process.env, timeout: 20000 });
    check('guard', `${s}: import has no side effects`, r.status === 0 && r.stdout.trim() === 'imported', (r.stdout + r.stderr).slice(0, 150));
  }
}

// ---------------------------------------------------------------- v3 workflow: triage, personas, tables, report, run ledger
const fx = (n) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8'));
const triageLib = await import(pathToFileURL(path.join(HERE, 'triage.mjs')).href);
const renderLib = await import(pathToFileURL(path.join(HERE, 'lib', 'render.mjs')).href);
const dryLib = await import(pathToFileURL(path.join(HERE, 'dryrun.mjs')).href);
const gateLib = await import(pathToFileURL(path.join(HERE, 'egm-gate.mjs')).href);
const evenPools = () => {
  const reg = common.loadRegistry();
  return Object.fromEntries(common.allPoolStatus(reg).map((p) => [p.pool, { ...p, pct: 20, level: 'ok', windows: [{ ...p.windows[0], pct: 20 }], model_cooldowns: {} }]));
};

function triageScenario() {
  log('\n=== TRIAGE (deterministic, zero tokens) ===');
  const reg = common.loadRegistry();
  const f = fx('triage.json');
  for (const cls of ['simple', 'complex', 'huge']) {
    for (const text of f[cls]) {
      const r = triageLib.triage(text, reg);
      check('triage', `${cls}: "${text.replace(/\s+/g, ' ').slice(0, 48)}"`, r.class === cls, `got ${r.class} (${r.reasons.join('; ')})`);
    }
  }
  for (const text of f.sensitive) check('triage', `sensitive: "${text.slice(0, 40)}"`, triageLib.triage(text, reg).sensitivity === 'sensitive');
  for (const text of f.not_sensitive) check('triage', `not sensitive: "${text.slice(0, 40)}"`, triageLib.triage(text, reg).sensitivity !== 'sensitive');
  for (const text of f.critical) check('triage', `critical: "${text.slice(0, 40)}"`, triageLib.triage(text, reg).critical === true);
  for (const text of f.not_critical) check('triage', `not critical: "${text.slice(0, 40)}"`, triageLib.triage(text, reg).critical === false);
  const mixed = triageLib.triage('Zmień kolor przycisku i zbadaj problem', reg);
  check('triage', 'mixed signals lower the confidence (the model decides)', mixed.class === 'complex' && mixed.confidence === 'low', JSON.stringify(mixed));
  check('triage', 'docs-only change is sensitivity none', triageLib.triage('Fix the typo in README.md', reg).sensitivity === 'none');
  const cli = spawnSync(process.execPath, [path.join(HERE, 'triage.mjs'), '--text', 'Fix the typo in README.md'], { encoding: 'utf8', env: process.env });
  check('triage', 'CLI prints one JSON line', cli.status === 0 && JSON.parse(cli.stdout).class === 'simple');
  const withRun = JSON.parse(spawnSync(process.execPath, [path.join(HERE, 'triage.mjs'), '--text', 'Fix the typo in README.md', '--run', 'st'], { encoding: 'utf8', env: process.env }).stdout);
  check('triage', '--run creates the run directory and ledger in the same call', withRun.run?.dir && fs.existsSync(path.join(withRun.run.dir, 'ledger.json')) && withRun.run.dir.startsWith(TMP));
  const g = gateLib.egmGate({ critical: true });
  check('triage', 'egm_gate placeholder returns not-critical and continue (critical flag kept as candidate)', g.gate === 'egm_gate' && g.critical === false && g.action === 'continue' && g.candidate === true);
}

function flowScenario() {
  log('\n=== FLOW: dry run per class, personas, privacy routing ===');
  const reg = common.loadRegistry();
  const f = fx('triage.json');
  const plans = fx('dryrun-plans.json');
  const pools = evenPools();
  for (const cls of ['simple', 'complex', 'huge']) {
    const prompt = f[cls][0];
    const d = dryLib.dryRun(reg, prompt, { tasks: plans[cls], pools });
    log(`\n--- dry run (${cls}): ${prompt.slice(0, 50)}\n${d.text}`);
    check('flow', `${cls}: dry run chooses the ${cls} path with zero model calls`, d.path === cls && d.model_calls === 0);
    check('flow', `${cls}: assignment table has Agent | Model · effort | Task and rows`, /\| Agent \| Model · effort \| Task \|/.test(d.text) && d.rows.length >= plans[cls].length);
    check('flow', `${cls}: every dispatched row has a persona with an emoji`, d.rows.every((r) => /^\S+ \S+/.test(r.agent) && !/^[\w]/.test(r.agent)));
    check('flow', `${cls}: personas are unique within the run`, new Set(d.rows.map((r) => r.agent)).size === d.rows.length, d.personas.join(', '));
    check('flow', `${cls}: egm_gate continues`, d.gate.action === 'continue' && /egm_gate: continue/.test(d.text));
    const again = dryLib.dryRun(reg, prompt, { tasks: plans[cls], pools });
    check('flow', `${cls}: personas are deterministic`, JSON.stringify(again.personas) === JSON.stringify(d.personas));
  }
  const cx = dryLib.dryRun(reg, f.complex[0], { tasks: plans.complex, pools });
  const spec = cx.rows.find((r) => r.role === 'prompt-creator');
  check('flow', 'complex: wave 1 is the prompt-creator on a registry-chosen Claude standard model', spec && spec.wave === 1 && spec.model === 'claude-sonnet' && spec.dispatch?.subagent_type === 'orchestrator:prompt-creator', JSON.stringify(spec?.dispatch));
  check('flow', 'complex: planned work starts after the spec wave', cx.rows.filter((r) => r.role !== 'prompt-creator').every((r) => r.wave > 1));
  const hg = dryLib.dryRun(reg, f.huge[0], { pools });
  check('flow', "huge: the split is the orchestrator's own step (no agent row)", hg.rows.length === 0 && /Split/.test(hg.text));

  const names = Array.from({ length: 8 }, (_, i) => renderLib.persona('implementer', i));
  check('flow', 'persona counter gives distinct names, then a numeric suffix', new Set(names).size === 8 && /\s2$/.test(names[6]), names.join(', '));

  const sens = triageLib.triage(f.sensitive[0], reg);
  const route = registry.route(reg, [
    { id: 'S1', title: 'Rotate the production password', type: 'implement', complexity: 'S', risk: 'high', sensitivity: sens.sensitivity, files: ['.env.production'] },
  ], { pools });
  const used = route.assignments.filter((a) => a.family);
  const bad = used.filter((a) => !reg.families[a.family].data_policy.sensitive_ok);
  check('flow', 'sensitive example is triaged sensitive', sens.sensitivity === 'sensitive');
  check('flow', 'sensitive example: every author/reviewer family has sensitive_ok (others excluded)', used.length > 0 && bad.length === 0, bad.map((a) => `${a.id}:${a.family}`).join(','));
  const trivial = registry.route(reg, [{ id: 'T9', title: 'Tweak a label', type: 'implement', complexity: 'S', risk: 'low' }], { pools });
  check('flow', 'trivial change (S, low risk) is exempt from cross-review', trivial.assignments.length === 1 && /trivial/.test(trivial.assignments[0].verification || ''));
}

function renderScenario() {
  log('\n=== RENDER: tables, report cap, prompt lint, run ledger ===');
  const reg = common.loadRegistry();
  const rows = [
    { id: 'T1', stage: 'Implement', agent: '🔨 Bartek', model: 'claude-sonnet', effort: 'medium', title: 'Add | pipe', status: 'done', note: 'ok' },
    { id: 'T2', stage: 'Review', agent: '🧐 Rysiek', model: 'gpt-6.1-sol', effort: 'low', title: 'Review T1', status: 'progress', note: '' },
    { id: 'T3', stage: 'Tests', agent: '🔨 Basia', model: 'claude-haiku', effort: 'low', title: 'Tests', status: 'pending', note: '' },
    { id: 'T4', stage: 'Implement', agent: '🔨 Błażej', model: 'claude-sonnet', effort: 'low', title: 'x', status: 'attention', note: 'brak testów' },
    { id: 'T5', stage: 'Implement', agent: '🔨 Bogdan', model: 'claude-sonnet', effort: 'low', title: 'x', status: 'failed', note: 'padł build' },
  ];
  const at = renderLib.assignmentTable(rows);
  check('render', 'assignment table: header, separator, one row per agent, pipes escaped', at.split('\n').length === 2 + rows.length && /\| Agent \| Model · effort \| Task \|/.test(at) && /Add \\\| pipe/.test(at), at);
  const st = renderLib.statusTable(rows, ['a', 'b', 'c', 'd', 'e']);
  check('render', 'status table: all five status icons', ['✅', '🔄', '⏳', '⚠️', '❌'].every((i) => st.includes(i)));
  check('render', 'status table: summary capped at 3 lines', st.split('\n').filter((l) => l.startsWith('- ')).length === 3 && st.includes('|\n\n- a'));

  const data = {
    result: 'done', title: 'Eksport CSV', summary: 'Dodano przycisk i endpoint.',
    done: ['Endpoint /export (Sonnet, medium)', 'Przycisk w UI (Bartek)', 'Testy jednostkowe'],
    tests: ['npm test: 42/42 ✅'], not_done: ['Eksport XLSX (poza zakresem)'],
    decisions: ['Separator „,” i UTF-8', 'Bez nowych zależności'],
    reviews: [{ by: 'GPT', of: 'Claude', high: 1, med: 1, low: 0, fixed: 1, rejected: 1, note: 'jedno obalone testem' }],
    fallbacks: [], pool: 'claude_team 40% (+3 pp)', commits: ['a1b2c3d Add CSV export'],
  };
  const r = renderLib.renderReport(data);
  log(r.text);
  check('render', `report renders within the cap (${r.lines} of ${r.cap} lines)`, !r.over_cap && r.lines <= 35 && r.lines >= 12);
  check('render', 'report has every required block', ['Wynik', 'Co zrobiono', 'Testy', 'Nie zrobiono', 'Decyzje podjęte za Ciebie', 'Review innych modeli', 'Fallbacki', 'Pule', 'Commity'].every((s) => r.text.includes(s)));
  check('render', 'report computes the review line (count, severity, resolution)', /GPT → Claude: 2 znaleziska \(1 wysokich · 1 średnich · 0 niskich\); naprawiono 1, odrzucono 1/.test(r.text));
  const empty = renderLib.renderReport({ result: 'partial', title: 'x', summary: 'y', done: ['a'] });
  check('render', 'empty lists fall back to "brak" / "nic"', /### Nie zrobiono\n- nic/.test(empty.text) && /Fallbacki:\*\* brak/.test(empty.text));
  const big = renderLib.renderReport({ ...data, done: Array.from({ length: 30 }, (_, i) => `krok ${i}`) });
  check('render', 'an oversized report is flagged over_cap', big.over_cap && big.lines > 35);

  const goodPrompt = '## Goal\nAdd CSV export to the reports page.\n\n## Context\nReports live in src/reports; see CLAUDE.md for conventions and the test command npm test. The export must respect the active filters and the existing permission checks of the page.\n\n## Scope and constraints\nEdit only src/reports and test/reports. Workers do not commit.\n\n## Done criteria and verification\n1. The button downloads the filtered rows as UTF-8 CSV.\n2. npm test passes.\n\n## Autonomy and reporting\nPick sensible defaults; report assumptions, what was verified and what is left.\n';
  check('render', 'prompt lint accepts a complete self-contained prompt', renderLib.lintPrompt(goodPrompt).ok, JSON.stringify(renderLib.lintPrompt(goodPrompt)));
  check('render', 'prompt lint rejects missing sections and "as discussed"', !renderLib.lintPrompt('## Goal\nDo it as discussed in the previous session.').ok);
  check('render', 'part lint needs an Expects section', !renderLib.lintPrompt(goodPrompt, { part: true }).ok && renderLib.lintPrompt(goodPrompt.replace('## Context', '## Expects\nnothing: first part\n\n## Context'), { part: true }).ok);

  const repo = path.join(TMP, 'ledger-repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'base');
  const run = (...args) => spawnSync(process.execPath, [path.join(HERE, 'run.mjs'), ...args], { encoding: 'utf8', env: process.env });
  const init = JSON.parse(run('init', '--slug', 'selftest', '--repo', repo).stdout);
  const routeFile = path.join(TMP, 'route.json');
  fs.writeFileSync(routeFile, JSON.stringify(registry.route(reg, fx('dryrun-plans.json').complex, { pools: evenPools() })));
  const plan = JSON.parse(run('plan', '--run', init.dir, '--route', routeFile).stdout);
  check('render', 'run.mjs plan builds waves into the ledger', plan.added >= 3 && plan.waves >= 2, JSON.stringify(plan));
  const w1 = JSON.parse(run('assign', '--run', init.dir, '--json').stdout);
  check('render', 'assign shows the first wave, marks it in progress, gives persona descriptions', w1.wave === 1 && /^\S+ \S+: T1/.test(w1.dispatch[0].description) && w1.dispatch[0].via && w1.table.includes('| Agent |'), JSON.stringify(w1.dispatch[0]));
  check('render', 'assign does not hand out the same rows twice', run('assign', '--run', init.dir, '--wave', '1').status !== 0);
  run('set', '--run', init.dir, 'T1', '--status', 'done', '--note', 'ok');
  const status = run('status', '--run', init.dir, '--summary', 'Fala 1 gotowa').stdout;
  check('render', 'status table reflects set + summary', status.includes('✅') && status.includes('Fala 1 gotowa'));
  run('note', '--run', init.dir, '--kind', 'decision', 'Wybrano', 'JWT'); run('note', '--run', init.dir, '--kind', 'fallback', 'GPT → Claude (limit)');
  run('review', '--run', init.dir, '--by', 'GPT', '--of', 'Claude', '--high', '1', '--fixed', '1');
  fs.writeFileSync(path.join(repo, 'a.txt'), '2'); git('add', '.'); git('commit', '-qm', 'Add feature');
  const repFile = path.join(TMP, 'report.json');
  fs.writeFileSync(repFile, JSON.stringify({ result: 'done', title: 'T', summary: 's', done: ['x'], tests: ['ok'] }));
  const rep = run('report', '--run', init.dir, '--data', repFile, '--strict');
  check('render', 'report fills decisions, fallbacks, reviews, pools and commits from the ledger and git', rep.status === 0 && /Wybrano JWT/.test(rep.stdout) && /GPT → Claude \(limit\)/.test(rep.stdout) && /GPT → Claude: 1 znalezisko/.test(rep.stdout) && /Add feature/.test(rep.stdout) && !/base/.test(rep.stdout) && /\*\*Pule:\*\*/.test(rep.stdout), rep.stdout + rep.stderr);
  const lp = path.join(TMP, 'prompt.md'); fs.writeFileSync(lp, goodPrompt);
  const save = spawnSync(process.execPath, [path.join(HERE, 'run.mjs'), 'save-prompt', '--run', init.dir], { input: goodPrompt, encoding: 'utf8', env: process.env });
  check('render', 'save-prompt writes prompt.md from stdin and lints it', save.status === 0 && fs.readFileSync(path.join(init.dir, 'prompt.md'), 'utf8') === goodPrompt && JSON.parse(save.stdout).ok === true, save.stdout + save.stderr);
  const badSave = spawnSync(process.execPath, [path.join(HERE, 'run.mjs'), 'save-prompt', '--run', init.dir], { input: '## Goal\nAs discussed.', encoding: 'utf8', env: process.env });
  check('render', 'save-prompt reports lint problems (exit 1) so the agent can fix them', badSave.status === 1 && JSON.parse(badSave.stdout).problems.length > 0);
  check('render', 'run.mjs lint-prompt exit codes', run('lint-prompt', lp).status === 0 && run('lint-prompt', brief).status !== 0);
}

const runs = { dryrun, fallback, escalate, 'update-detect': updateDetect, resume, overlay, accounts, gemini, privacy, config, doctor: doctorOffline, update, migrate, guard, triage: triageScenario, flow: flowScenario, render: renderScenario };
for (const [name, fn] of Object.entries(runs)) if (which === 'all' || which === name) await fn();

log('\n=== RESULTS ===');
for (const r of results) log(`${r.pass ? 'PASS' : 'FAIL'}  [${r.scenario}] ${r.name}${(!r.pass || verbose) && r.detail ? `  (${r.detail})` : ''}`);
const failed = results.filter((r) => !r.pass).length;
log(`\n${results.length - failed}/${results.length} passed. Temp state: ${TMP}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
