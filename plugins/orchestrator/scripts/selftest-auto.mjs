// Self-tests of the autonomous mode (`selftest.mjs auto`). The real engine runs on temp git repos with a simulated clock,
// fake Claude/adapter workers and fake usage feeds: no model calls, no real waiting, none of the user's state.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CHECK_SRC = `import fs from 'node:fs';
const bad = fs.readdirSync('src').filter((f) => fs.readFileSync('src/' + f, 'utf8').includes('BAD'));
if (bad.length) { console.error('BAD content in ' + bad.join(',')); process.exit(1); }
console.log('checks ok');
`;
const PLAN = () => ({
  status: 'ready', approach: 'two small steps',
  tasks: [
    { id: 'T1', title: 'Add alpha', type: 'implement', complexity: 'S', risk: 'low', deps: [], files: ['src/T1.txt'], criteria: ['alpha exists'] },
    { id: 'T2', title: 'Add beta', type: 'implement', complexity: 'M', risk: 'med', deps: ['T1'], files: ['src/T2.txt'], criteria: ['beta exists'] },
  ],
  decisions: [{ question: 'Which file extension?', options: [{ id: 'a', label: '.txt', reversible: true, safest: true }, { id: 'b', label: '.md', reversible: true }], chosen: 'a', confidence: 0.9, reasoning: 'plain', reversibility: 'reversible', files: [] }],
  parked_upfront: [], risks: [],
});

export async function autoScenario(ctx) {
  const { check, TMP, HERE, common } = ctx;
  const L = (n) => import(pathToFileURL(path.join(HERE, n)).href);
  const core = await L('lib/auto-core.mjs');
  const lim = await L('lib/auto-limits.mjs');
  const dec = await L('lib/auto-decisions.mjs');
  const con = await L('lib/auto-contract.mjs');
  const eng = await L('lib/auto-engine.mjs');
  const rep = await L('lib/auto-report.mjs');
  const sys = await L('lib/auto-system.mjs');
  const wrk = await L('lib/auto-worker.mjs');
  const cli = await L('auto.mjs');
  const S = 'auto';
  const sh = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const T0 = Date.parse('2026-11-01T00:00:00Z');
  const H = 3600000;
  const reg = common.loadRegistry();

  // ---------------------------------------------------------------- harness
  let repoN = 0;
  function mkRepo(extra = {}) {
    const dir = path.join(TMP, 'auto-repos', `r${++repoN}`);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    sh(dir, 'init', '-q', '-b', 'main');
    for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['core.autocrlf', 'false']]) sh(dir, 'config', k, v);
    fs.writeFileSync(path.join(dir, 'src', 'seed.txt'), 'seed\n');
    fs.writeFileSync(path.join(dir, 'check.mjs'), CHECK_SRC);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    for (const [f, t] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); }
    sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'init');
    return dir;
  }
  const merge = (a, b) => { for (const [k, v] of Object.entries(b || {})) { if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') merge(a[k], v); else a[k] = v; } return a; };
  async function setupRun(repo, slug, over = {}) {
    const id = core.newAutoId(slug);
    const c = merge(con.defaultContract({
      id, created: new Date(T0).toISOString(), repo, base_branch: 'main', base_sha: sh(repo, 'rev-parse', 'HEAD').stdout.trim(), branch: `auto/${id}`,
      goal: 'Add two small files under src with the planned content', definition_of_done: ['src/T1.txt and src/T2.txt exist and node check.mjs passes'],
      verify: { test: 'node check.mjs', typecheck: null, lint: null, build: null, extra: [] },
      budgets: { task_attempts: 3, no_progress_min: 240, tick_timeout_min: 90, idle_timeout_min: 20, max_dispatches: 200, planning_attempts: 2 },
      checkpoints: { commits: 'auto_branch', hooks: 'bypass_on_failure', profile_override: false },
    }), over);
    const paths = core.runPaths(core.runDirOf(id));
    fs.mkdirSync(paths.dir, { recursive: true });
    con.writeContract(paths.contract, c);
    fs.writeFileSync(paths.prompt, 'Spec: add two files.');
    const perms = con.buildPermissions(c);
    fs.writeFileSync(paths.permissions, JSON.stringify(perms));
    const m = await cli.materialize(paths, c, perms);
    if (!m.ok) throw new Error(m.error);
    return { c, paths, perms, repo, id };
  }
  const mkClock = (start = T0) => { const k = { t: start, sleeps: [], onSleep: null, now: () => k.t, async sleep(ms) { k.sleeps.push(ms); k.t += ms; await Promise.resolve(); await k.onSleep?.(k); } }; return k; };

  // fake world: scripted worker behaviors + fake usage feed
  function mkWorld(run, clock, o = {}) {
    const w = { calls: [], adapter: [], notified: [], net: true, auth: { ok: true }, script: [], plan: o.plan || PLAN(), feed: null, reviewFindings: [], pct: o.pct || { five_hour: 10, seven_day: 20 }, secondOpinion: o.secondOpinion || { choice: 'a', confidence: 0.9 }, git: null };
    const windows = () => ({ windows: { five_hour: { pct: w.pct.five_hour, resets_at: clock.t + 5 * H }, seven_day: { pct: w.pct.seven_day, resets_at: clock.t + 100 * H } }, overage: { using: false } });
    const tick = (spec, final, extra = {}) => ({ kind: 'ok', text: '', final, session_id: spec.sessionId || 'sess', seen_session: true, usage: { total: 1000, fresh: 400 }, windows: spec.family === 'claude' ? windows() : null, ...extra });
    const work = (spec, label) => {
      const f = path.join(spec.cwd, 'src', `${label}.txt`);
      const partial = path.join(spec.cwd, 'src', `${label}.partial`);
      if (fs.existsSync(partial)) { fs.unlinkSync(partial); fs.writeFileSync(f, `done ${label} resumed\n`); } else fs.writeFileSync(f, `done ${label}\n`);
    };
    const common_ = async (spec, kind, label) => {
      const rule = w.script.find((r) => !r.used && r.match({ ...spec, label, kind }));
      if (rule) { if (rule.once !== false) rule.used = true; const r = await rule.act(spec, { work, tick, clock, label }); if (r) return r; }
      if (kind === 'plan') return tick(spec, w.plan);
      if (kind === 'second') return tick(spec, w.secondOpinion);
      if (kind === 'review') { const f = w.reviewAlways ? w.reviewAlways : w.reviewFindings.splice(0); return tick(spec, { verdict: f.length ? 'FIX' : 'APPROVE', findings: f, checked: ['a', 'b', 'c'] }); }
      work(spec, label);
      return tick(spec, { status: 'done', summary: `did ${label}`, files: [`src/${label}.txt`], decisions: [] });
    };
    w.claude = async (spec) => {
      const label = spec.label || '';
      w.calls.push({ label, resume: !!spec.resume, sessionId: spec.sessionId, model: spec.model, readonly: !!spec.readonly, at: clock.t, cwd: spec.cwd, prompt: spec.prompt });
      const kind = label === 'plan' ? 'plan' : label === 'second-opinion' ? 'second' : /-(general|security)-r\d|^final-/.test(label) ? 'review' : 'work';
      return common_({ ...spec, family: 'claude' }, kind, label);
    };
    w.adapterRun = async (spec) => {
      const label = path.basename(spec.promptFile).replace(/-\d+\.md$/, '');
      const kind = /^plan/.test(label) ? 'plan' : /^second-opinion/.test(label) ? 'second' : spec.mode === 'review' || spec.mode === 'research' ? 'review' : 'work';
      w.adapter.push({ family: spec.family, model: spec.model, mode: spec.mode, taskType: spec.taskType, label, at: clock.t, sensitivity: spec.sensitivity, prompt: fs.readFileSync(spec.promptFile, 'utf8') });
      const r = await common_({ ...spec, family: spec.family, model: spec.model }, kind, label);
      return r;
    };
    return w;
  }

  const criticalPoints = [];
  function mkDeps(run, clock, world, extra = {}) {
    const git = core.createGit({ repo: run.repo, worktree: run.paths.worktree, record: extra.gitLog });
    return {
      reg, now: clock.now, sleep: (ms) => clock.sleep(ms), git, runClaude: world.claude, runAdapter: world.adapterRun, runChecks: wrk.runChecks,
      refreshUsage: async (limits, now) => { await world.feed?.(limits, now); }, notify: (ev) => world.notified.push(ev), netCheck: async () => world.net, authCheck: async () => world.auth,
      killPid: () => {}, crashPoint: extra.crashPoint, pollMs: extra.pollMs,
    };
  }
  const mkEngine = (run, clock, world, extra = {}) => new eng.AutoEngine({ paths: run.paths, deps: mkDeps(run, clock, world, extra), contract: con.readContract(run.paths.contract), rules: null, perms: run.perms });
  const st = (run) => core.loadState(run.paths).state;
  const decisions = (run) => core.readJsonl(run.paths.decisions);
  const autoCommits = (run) => sh(run.paths.worktree, 'log', '--format=%s', `${run.c.base_sha}..HEAD`).stdout.split('\n').filter((l) => l.startsWith('[auto]'));
  const setLimits = (run, fn) => { const s = st(run); fn(s.limits, s); core.saveState(run.paths, s); };
  const claudeWork = (w) => w.calls.filter((c) => /^(T\d+|FIX\d*|RF-\w+)$/.test(c.label));
  const adapterWork = (w) => w.adapter.filter((c) => c.mode === 'implement');
  const readLog = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

  // ---------------------------------------------------------------- 1. happy path
  {
    const repo = mkRepo();
    const mainBefore = sh(repo, 'rev-parse', 'main').stdout.trim();
    const gitLog = [];
    const run = await setupRun(repo, 'happy');
    const clock = mkClock();
    const world = mkWorld(run, clock);
    world.script.push({ match: (s) => s.label === 'T1' || (s.mode === 'implement' && /T1/.test(s.label || '')), act: async (spec, h) => { h.work(spec, 'T1'); return h.tick(spec, { status: 'done', summary: 'alpha', files: ['src/T1.txt'], decisions: [{ question: 'Use a trailing newline?', options: [{ id: 'y', label: 'yes', reversible: true, safest: true }, { id: 'n', label: 'no', reversible: true }], chosen: 'y', confidence: 0.95, reasoning: 'convention', reversibility: 'reversible', files: ['src/T1.txt'] }] }); } });
    const e = mkEngine(run, clock, world, { gitLog });
    const r = await e.run();
    const s = st(run);
    check(S, 'happy path: plan -> two tasks -> final checks/review -> completed', r.status === 'completed' && s.tasks.every((t) => t.status === 'done'), JSON.stringify({ r, tasks: s.tasks.map((t) => [t.id, t.status, t.parked_reason]) }));
    check(S, 'one checkpoint commit and tag per task on auto/<id>, checks passed at each', autoCommits(run).length === 2 && s.tasks.every((t) => t.checkpoint?.sha && sh(repo, 'rev-parse', `auto/${run.id}/${t.id}`).status === 0), autoCommits(run).join('|'));
    check(S, 'the user\'s branch and checkout are untouched (main == base, clean tree), work lives in the worktree', sh(repo, 'rev-parse', 'main').stdout.trim() === mainBefore && sh(repo, 'status', '--porcelain').stdout.trim() === '' && sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim() === 'main' && fs.existsSync(path.join(run.paths.worktree, 'src', 'T2.txt')) && !fs.existsSync(path.join(repo, 'src', 'T2.txt')));
    check(S, 'planning decisions land in decisions.jsonl with id, options, confidence and an undo note', decisions(run).length >= 1 && decisions(run)[0].id === 'D001' && decisions(run)[0].options.length === 2 && 'confidence' in decisions(run)[0] && decisions(run)[0].undo_note, JSON.stringify(decisions(run)[0]));
    const wd = decisions(run).find((d) => d.task === 'T1');
    check(S, 'a worker decision carries the task\'s checkpoint sha and a ready-to-run undo command', wd && wd.sha === s.tasks[0].checkpoint.sha && /revert --no-edit/.test(wd.undo) && wd.undo.includes(wd.sha) && wd.rule === 'decide', JSON.stringify(wd));
    check(S, 'T2 (risk med) was cross-reviewed by a family other than its author, and the whole diff got a final review', s.reviews.some((r) => r.task === 'T2' && r.by !== r.of) && s.reviews.some((r) => r.task === '*' && r.by !== r.of), JSON.stringify(s.reviews));
    check(S, 'completion is notified with a generic event, nothing else was printed or pushed', world.notified.includes('done') && !gitLog.some((c) => c.args.includes('push')) && core.supervisorAlive(run.paths) === false);
    check(S, 'a final report.md exists and is Polish', /Autonomiczny przebieg/.test(readLog(run.paths.report)) && /Co sprawdzić najpierw/.test(readLog(run.paths.report)));
    check(S, 'the active-run registry is released at the end; the finished run is shown as unreviewed', core.autoRunFor(repo).state === 'finished');
  }

  // ---------------------------------------------------------------- 2. limit hit mid-task -> checkpoint -> wait -> resume
  {
    const repo = mkRepo();
    const run = await setupRun(repo, 'limit', { families: { allow: ['claude'] } });
    const clock = mkClock();
    const world = mkWorld(run, clock);
    let limitAt = 0;
    world.script.push({
      match: (s) => s.label === 'T1',
      act: async (spec, h) => { fs.writeFileSync(path.join(spec.cwd, 'src', 'T1.partial'), 'half done\n'); limitAt = clock.t; return { kind: 'limit', retry_at: clock.t + 3 * H, estimated: false, scope: 'five_hour', session_id: spec.sessionId, seen_session: true, usage: { total: 500, fresh: 200 }, windows: { windows: { five_hour: { pct: 100, resets_at: clock.t + 3 * H }, seven_day: { pct: 40, resets_at: clock.t + 90 * H } }, overage: { using: false } } }; },
    });
    const e = mkEngine(run, clock, world);
    const r = await e.run();
    const s = st(run);
    const t1calls = world.calls.filter((c) => c.label === 'T1');
    check(S, 'limit mid-task -> the run waits until the reset plus margin, then resumes the SAME worker session (--resume), and completes', r.status === 'completed' && t1calls.length === 2 && t1calls[1].resume === true && t1calls[1].sessionId === t1calls[0].sessionId && t1calls[1].at >= limitAt + 3 * H + 3 * 60000, JSON.stringify({ r, t1calls, limitAt }));
    check(S, 'during the wait there were zero worker calls (the supervisor only slept)', world.calls.filter((c) => c.at > limitAt && c.at < limitAt + 3 * H).length === 0 && clock.sleeps.length > 5);
    check(S, 'the partial work was snapshotted (refs/auto/<id>/wip/T1) and finished on resume without losing the file', sh(repo, 'rev-parse', '--verify', `refs/auto/${run.id}/wip/T1`).status === 0 && /resumed/.test(readLog(path.join(run.paths.worktree, 'src', 'T1.txt'))) && !fs.existsSync(path.join(run.paths.worktree, 'src', 'T1.partial')));
    check(S, 'limits.log records LIMIT, WAIT and WAKE; the limit is a wait, never a failure (attempts stayed 0)', /LIMIT family=claude/.test(readLog(run.paths.limits)) && /WAIT kind=limit/.test(readLog(run.paths.limits)) && /WAKE/.test(readLog(run.paths.limits)) && s.tasks[0].attempts === 0 && s.tasks[0].failures === 0);
    check(S, 'a long wait raised the generic long_wait notification', world.notified.includes('long_wait'));
  }

  // ---------------------------------------------------------------- 3. soft threshold -> reroute, honoring the privacy filter
  {
    const soft = (run, clock, pct = 82) => setLimits(run, (l) => { l.claude = { five_hour: { pct, resets_at: clock.t + 2 * H, at: clock.t, source: 'exact' }, seven_day: null, blocked_until: null }; });
    const blockFam = (limits, fam, until) => { limits[fam] = { five_hour: null, seven_day: null, blocked_until: until, blocked_reason: 'limit (test)', blocked_estimated: false, block_attempts: 1 }; };
    // A: non-sensitive, claude soft -> new work goes to another family
    {
      const repo = mkRepo(); const run = await setupRun(repo, 'soft-a'); const clock = mkClock(); const world = mkWorld(run, clock);
      soft(run, clock);
      const r = await mkEngine(run, clock, world).run();
      check(S, 'soft threshold (claude 5h 82%) -> NEW work is routed to other allowed families, not to claude', r.status === 'completed' && claudeWork(world).length === 0 && adapterWork(world).length >= 2, JSON.stringify({ r, claude: claudeWork(world).length, adapter: adapterWork(world).map((a) => a.family) }));
    }
    // B: sensitive contract, claude soft, gpt blocked -> stays on claude; grok/gemini (sensitive_ok=false) never see it
    {
      const repo = mkRepo(); const run = await setupRun(repo, 'soft-b', { sensitivity: 'sensitive' }); const clock = mkClock(); const world = mkWorld(run, clock);
      soft(run, clock); setLimits(run, (l) => blockFam(l, 'gpt', clock.t + 30 * H));
      const r = await mkEngine(run, clock, world).run();
      const leaked = world.adapter.filter((a) => ['grok', 'gemini'].includes(a.family));
      check(S, 'sensitive run: claude soft + gpt blocked -> claude keeps the work; grok/gemini (no sensitive_ok) are never called', r.status === 'completed' && claudeWork(world).length >= 2 && leaked.length === 0, JSON.stringify({ r, leaked }));
    }
    // C: sensitive, claude + gpt blocked, grok/gemini free -> the run sleeps instead of leaking
    {
      const repo = mkRepo(); const run = await setupRun(repo, 'soft-c', { sensitivity: 'sensitive' }); const clock = mkClock(); const world = mkWorld(run, clock);
      setLimits(run, (l) => { blockFam(l, 'claude', clock.t + 5 * H); blockFam(l, 'gpt', clock.t + 7 * H); });
      const r = await mkEngine(run, clock, world).run();
      const first = world.calls[0]?.at ?? world.adapter[0]?.at;
      check(S, 'sensitive run with only non-sensitive families free: it sleeps until claude is back (zero leaks)', r.status === 'completed' && first >= T0 + 5 * H && world.adapter.filter((a) => ['grok', 'gemini'].includes(a.family)).length === 0, JSON.stringify({ r, first: first - T0 }));
    }
    // D: same limits, NOT sensitive -> the free secondary families take over immediately
    {
      const repo = mkRepo(); const run = await setupRun(repo, 'soft-d'); const clock = mkClock(); const world = mkWorld(run, clock);
      setLimits(run, (l) => { blockFam(l, 'claude', clock.t + 5 * H); blockFam(l, 'gpt', clock.t + 7 * H); });
      const r = await mkEngine(run, clock, world).run();
      const fams = new Set(adapterWork(world).map((a) => a.family));
      check(S, 'non-sensitive run with claude + gpt blocked continues at once on grok/gemini', r.status === 'completed' && [...fams].every((f) => ['grok', 'gemini'].includes(f)) && fams.size > 0 && (world.adapter[0]?.at ?? 0) < T0 + 2 * H, JSON.stringify({ r, fams: [...fams], first: (world.adapter[0]?.at ?? 0) - T0 }));
    }
  }

  // ---------------------------------------------------------------- 4. every family exhausted: sleep until the earliest reset, never exit
  {
    const repo = mkRepo(); const run = await setupRun(repo, 'allout'); const clock = mkClock(); const world = mkWorld(run, clock);
    setLimits(run, (l) => { for (const [f, h] of [['claude', 5], ['gpt', 4], ['grok', 6], ['gemini', 7]]) l[f] = { five_hour: null, seven_day: null, blocked_until: T0 + h * H, blocked_reason: 'limit (test)', blocked_estimated: false, block_attempts: 1 }; });
    const r = await mkEngine(run, clock, world).run();
    const firstAt = Math.min(...[...world.calls, ...world.adapter].map((c) => c.at));
    check(S, 'all families exhausted -> sleeps until the EARLIEST reset (gpt, +4 h), then continues and completes', r.status === 'completed' && firstAt >= T0 + 4 * H && firstAt < T0 + 4 * H + 2 * H, JSON.stringify({ r, firstAt: (firstAt - T0) / H }));
    check(S, 'the long wait is logged and notified once', /WAIT kind=limit/.test(readLog(run.paths.limits)) && world.notified.filter((n) => n === 'long_wait').length === 1);
  }
  {
    const repo = mkRepo(); const run = await setupRun(repo, 'forever'); const clock = mkClock(); const world = mkWorld(run, clock);
    setLimits(run, (l) => { for (const f of ['claude', 'gpt', 'grok', 'gemini']) l[f] = { five_hour: null, seven_day: null, blocked_until: T0 + 10 * 24 * H, blocked_reason: 'weekly limit (test)', blocked_estimated: false, block_attempts: 1 }; });
    let returned = null;
    clock.onSleep = async (k) => { if (k.sleeps.length === 400) core.setControl(run.paths, 'STOP'); };
    const p = mkEngine(run, clock, world).run().then((x) => { returned = x; return x; });
    const r = await p;
    check(S, 'weekly exhaustion of every family: the run keeps sleeping (hundreds of zero-token wake-ups, no worker call) and only the user\'s STOP ends it', clock.sleeps.length >= 400 && world.calls.length === 0 && world.adapter.length === 0 && r.status === 'stopped' && returned.status === 'stopped', `sleeps=${clock.sleeps.length}`);
    core.setControl(run.paths, 'STOP', false);
  }

  const helpers = { mkRepo, setupRun, mkClock, mkWorld, mkDeps, mkEngine, st, decisions, autoCommits, setLimits, sh, T0, H, PLAN, reg, readLog, claudeWork, adapterWork, merge, S, check, TMP, HERE, common, core, lim, dec, con, eng, rep, sys, wrk, cli };
  await (await import('./selftest-auto-more.mjs')).moreScenarios(helpers);
  await (await import('./selftest-auto-units.mjs')).unitScenarios(helpers);
  await (await import('./selftest-egm.mjs')).egmAutoScenario(helpers);
}
