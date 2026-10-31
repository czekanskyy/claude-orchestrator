// Autonomous mode, engine scenarios part 2: crashes at random points, kill switch, takeover/abort, corrupt state, lock,
// decision protocol, undo/review/merge, contract guards, loop protection, hangs and external failures.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function moreScenarios(H) {
  const { check, S, TMP, HERE, core, con, eng, rep, dec, mkRepo, setupRun, mkClock, mkWorld, mkEngine, st, decisions, autoCommits, setLimits, sh, T0, H: HOUR, PLAN, readLog, claudeWork, merge } = H;
  const only = { families: { allow: ['claude'] } };
  const node = (script, args) => { const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: 'utf8', env: process.env }); let json = null; try { json = JSON.parse(r.stdout); } catch { /* text output */ } return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }; };
  const treeClean = (run) => sh(run.paths.worktree, 'status', '--porcelain').stdout.trim() === '';
  const writeThen = (rel, text, final = { status: 'done', summary: 'x', files: [], decisions: [] }) => async (spec, h) => { fs.mkdirSync(path.dirname(path.join(spec.cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(spec.cwd, rel), text); return h.tick(spec, final); };

  // ---------------------------------------------------------------- 5. crash at random points -> restart -> resume without loss
  {
    const runCase = async (idx) => {
      const repo = mkRepo();
      const run = await setupRun(repo, `crash${idx}`, only);
      const clock = mkClock(); const world = mkWorld(run, clock);
      const counter = { n: 0 };
      const cp = (name) => { counter.n++; if (idx > 0 && counter.n === idx) throw new eng.CrashForTest(name); };
      let crashed = null;
      try { await mkEngine(run, clock, world, { crashPoint: cp }).run(); } catch (e) { if (!(e instanceof eng.CrashForTest)) throw e; crashed = e.message; }
      let r = null;
      for (let i = 0; i < 3 && r?.status !== 'completed'; i++) r = await mkEngine(run, clock, world).run();
      return { run, world, crashed, r, total: counter.n };
    };
    const base = await runCase(0);
    const total = base.total;
    const idxs = total <= 26 ? Array.from({ length: total }, (_, i) => i + 1) : [...new Set([1, 2, 3, ...Array.from({ length: 18 }, (_, i) => Math.round(((i + 1) * total) / 19)), total - 1, total])];
    const bad = [];
    for (const idx of idxs) {
      const { run, world, crashed, r } = await runCase(idx);
      const s = st(run);
      const ids = decisions(run).map((d) => d.id);
      const problems = [];
      if (r?.status !== 'completed') problems.push(`status ${r?.status}`);
      if (!s.tasks.every((t) => t.status === 'done')) problems.push(`tasks ${s.tasks.map((t) => t.id + t.status)}`);
      if (autoCommits(run).length !== 2) problems.push(`commits ${autoCommits(run).length}`);
      if (!treeClean(run)) problems.push('dirty tree');
      if (new Set(ids).size !== ids.length) problems.push('duplicate decision ids');
      if (!/^done T[12]/.test(readLog(path.join(run.paths.worktree, 'src', 'T1.txt'))) || !fs.existsSync(path.join(run.paths.worktree, 'src', 'T2.txt'))) problems.push('file content');
      if (claudeWork(world).length > 5) problems.push(`too many worker calls ${claudeWork(world).length}`);
      if (!crashed) problems.push('crash point never reached');
      if (problems.length) bad.push(`#${idx}(${crashed}): ${problems.join(', ')}`);
    }
    check(S, `crash at ${idxs.length} different points of a 2-task run (of ${total} crash points) -> restart -> resumed without loss or duplicates`, bad.length === 0 && total >= 15, bad.join(' | ') || `points=${total}`);
  }

  // ---------------------------------------------------------------- 6. kill switch: PAUSE / STOP / continue
  {
    const repo = mkRepo(); const run = await setupRun(repo, 'pause', only); const clock = mkClock(); const world = mkWorld(run, clock);
    core.setControl(run.paths, 'PAUSE');
    clock.onSleep = async (k) => { if (k.sleeps.length === 6) core.setControl(run.paths, 'PAUSE', false); };
    const r = await mkEngine(run, clock, world).run();
    check(S, 'PAUSE file: the run idles (zero tokens, no worker call) until the file is removed, then completes', r.status === 'completed' && world.calls[0].at >= T0 + 5000 * 5 && /PAUSE: idle/.test(readLog(run.paths.journal)) && world.calls.length > 0);
  }
  {
    const repo = mkRepo(); const run = await setupRun(repo, 'stop', only); const clock = mkClock(); const world = mkWorld(run, clock);
    world.script.push({ match: (s) => s.label === 'T1', act: async (spec, h) => { core.setControl(run.paths, 'STOP'); h.work(spec, 'T1'); return h.tick(spec, { status: 'done', summary: 'a', files: [], decisions: [] }); } });
    const r1 = await mkEngine(run, clock, world).run();
    const s1 = st(run);
    check(S, 'STOP file: the run stops SAFELY at a checkpoint (T1 committed, T2 untouched, clean tree, status stopped)', r1.status === 'stopped' && s1.tasks[0].status === 'done' && s1.tasks[1].status === 'pending' && treeClean(run) && autoCommits(run).length === 1 && s1.status === 'stopped' && world.calls.filter((c) => c.label === 'T2').length === 0, JSON.stringify({ r1, st: s1.tasks.map((t) => t.status) }));
    check(S, 'a stopped run still owns its repo (a second run is blocked until continue/abort)', core.autoRunFor(repo).state === 'active');
    core.setControl(run.paths, 'STOP', false);
    const r2 = await mkEngine(run, clock, world).run();
    check(S, 'continue after STOP finishes the remaining work from the checkpoint (T1 is not redone)', r2.status === 'completed' && autoCommits(run).length === 2 && world.calls.filter((c) => c.label === 'T1').length === 1);
  }

  // ---------------------------------------------------------------- 7. takeover and abort
  {
    const repo = mkRepo(); const run = await setupRun(repo, 'takeover', only); const clock = mkClock(); const world = mkWorld(run, clock);
    world.script.push({ match: (s) => s.label === 'T2', act: async (spec) => { fs.writeFileSync(path.join(spec.cwd, 'src', 'T2.partial'), 'half\n'); core.setControl(run.paths, 'TAKEOVER'); await new Promise((res) => { if (spec.signal.aborted) res(); else spec.signal.addEventListener('abort', res, { once: true }); }); return { kind: 'aborted', session_id: spec.sessionId, seen_session: true, usage: { total: 0, fresh: 0 } }; } });
    const r = await mkEngine(run, clock, world, { pollMs: 20 }).run();
    const s = st(run);
    const t1sha = s.tasks[0].checkpoint.sha;
    check(S, 'takeover mid-task: the worker is ended cleanly, partial work snapshotted, tree reset to the last checkpoint', r.status === 'handed_over' && s.status === 'handed_over' && s.mode === 'interactive' && treeClean(run) && sh(run.paths.worktree, 'rev-parse', 'HEAD').stdout.trim() === t1sha && sh(repo, 'rev-parse', '--verify', `refs/auto/${run.id}/wip/T2`).status === 0 && !fs.existsSync(path.join(run.paths.worktree, 'src', 'T2.partial')), JSON.stringify({ r, head: sh(run.paths.worktree, 'status', '--porcelain').stdout }));
    const ho = readLog(run.paths.handoff);
    check(S, 'hand-off file gives the interactive orchestrator the compact ledger: worktree, branch, last checkpoint, pending T2, decisions, journal', /Handoff: autonomous run/.test(ho) && ho.includes(run.paths.worktree) && /\| T2 .* \| pending/.test(ho) && /\| T1 .* \| done/.test(ho) && /## Journal/.test(ho) && /NORMAL orchestrator mode/.test(ho));
    check(S, 'takeover releases the repo (no active run, control file consumed) and notifies generically', core.autoRunFor(repo).state === 'none' && !fs.existsSync(run.paths.ctl.TAKEOVER) && world.notified.includes('handed_over'));
    const again = await mkEngine(run, clock, world).run();
    check(S, 'a handed-over run is never restarted by a stray supervisor', again.status === 'handed_over' && world.calls.filter((c) => c.label === 'T2').length === 1);
  }
  {
    const repo = mkRepo(); const run = await setupRun(repo, 'abort', only); const clock = mkClock(); const world = mkWorld(run, clock);
    world.script.push({ match: (s) => s.label === 'T2', act: async (spec) => { fs.writeFileSync(path.join(spec.cwd, 'src', 'T2.partial'), 'half\n'); core.setControl(run.paths, 'ABORT'); await new Promise((res) => { if (spec.signal.aborted) res(); else spec.signal.addEventListener('abort', res, { once: true }); }); return { kind: 'aborted', session_id: spec.sessionId, seen_session: true, usage: { total: 0, fresh: 0 } }; } });
    const r = await mkEngine(run, clock, world, { pollMs: 20 }).run();
    check(S, 'abort: ends at once, keeps every checkpoint and the partial work (snapshot ref), writes the report', r.status === 'aborted' && autoCommits(run).length === 1 && sh(repo, 'rev-parse', '--verify', `refs/auto/${run.id}/wip/T2`).status === 0 && /Autonomiczny przebieg/.test(readLog(run.paths.report)) && core.autoRunFor(repo).state === 'none');
  }

  // ---------------------------------------------------------------- 8. corrupted or missing state
  {
    const mk = async (slug) => {
      const repo = mkRepo(); const run = await setupRun(repo, slug, only); const clock = mkClock(); const world = mkWorld(run, clock);
      world.script.push({ match: (s) => s.label === 'T1', act: async (spec, h) => { core.setControl(run.paths, 'STOP'); h.work(spec, 'T1'); return h.tick(spec, { status: 'done', summary: 'a', files: [], decisions: [] }); } });
      await mkEngine(run, clock, world).run();
      core.setControl(run.paths, 'STOP', false);
      return { repo, run, clock, world };
    };
    let x = await mk('corrupt');
    fs.writeFileSync(x.run.paths.state, '{"run_id":"cut off mid-write","tasks":[');
    const r1 = await mkEngine(x.run, x.clock, x.world).run();
    check(S, 'corrupted state.json: the previous generation (state.json.bak) is used, the run continues and completes', r1.status === 'completed' && /recovered from state\.json\.bak/.test(readLog(x.run.paths.journal)) && autoCommits(x.run).length === 2, JSON.stringify(r1));
    x = await mk('missing');
    fs.unlinkSync(x.run.paths.state); fs.unlinkSync(x.run.paths.stateBak);
    const r2 = await mkEngine(x.run, x.clock, x.world).run();
    check(S, 'state.json and .bak both gone: the state is rebuilt from contract + plan.json + checkpoint tags; T1 is not redone', r2.status === 'completed' && /state rebuilt from the contract/.test(readLog(x.run.paths.journal)) && x.world.calls.filter((c) => c.label === 'T1').length === 1 && autoCommits(x.run).length === 2, JSON.stringify({ r2, t1: x.world.calls.filter((c) => c.label === 'T1').length }));
  }

  // ---------------------------------------------------------------- 9. single-instance lock
  {
    const p = core.runPaths(path.join(TMP, 'lockrun'));
    fs.mkdirSync(p.dir, { recursive: true });
    const alive = (pid) => [111, 222].includes(pid);
    const a1 = core.acquireLock(p, { pid: 111, alive, now: T0 });
    core.writeHeartbeat(p, {}, T0);
    const a2 = core.acquireLock(p, { pid: 222, alive, now: T0 + 1000 });
    check(S, 'duplicate run: a second supervisor is refused while the first is alive with a fresh heartbeat', a1.ok && !a2.ok && a2.holder.pid === 111, JSON.stringify(a2));
    const a3 = core.acquireLock(p, { pid: 222, alive, now: T0 + 20 * 60000 });
    check(S, 'a lock whose heartbeat went stale (hung supervisor) is taken over', a3.ok && JSON.parse(fs.readFileSync(p.lock, 'utf8')).pid === 222);
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(p.lock, JSON.stringify({ pid: Number(dead.stdout), token: 'x', started: new Date().toISOString() }));
    const a4 = core.acquireLock(p, { pid: 333, now: Date.now() });
    check(S, 'a lock left by a dead process (crash) is taken over', a4.ok);
    core.releaseLock(p, 333);
    const repo = mkRepo(); const run = await setupRun(repo, 'locked', only); const clock = mkClock(); const world = mkWorld(run, clock);
    fs.writeFileSync(run.paths.lock, JSON.stringify({ pid: process.ppid, token: 'other', started: new Date(clock.t).toISOString() }));
    core.writeHeartbeat(run.paths, {}, clock.t);
    const r = await mkEngine(run, clock, world).run();
    check(S, 'engine.run() on a run another live supervisor owns does nothing (no worker call, state untouched)', r.status === 'locked' && world.calls.length === 0 && st(run).status === 'created');
  }

  // ---------------------------------------------------------------- 10. decision protocol
  {
    const c = con.defaultContract({ irreversible_allowed: [] });
    const cl = (d, contract = c) => dec.classifyDecision(d, contract);
    check(S, 'decision: reversible + confident -> decide and log', cl({ reversibility: 'reversible', confidence: 0.9, chosen: 'a' }).route === 'decide');
    check(S, 'decision: reversible but uncertain -> independent second opinion', cl({ reversibility: 'reversible', confidence: 0.5, chosen: 'a' }).route === 'second_opinion');
    check(S, 'decision: irreversible/external-effect (deploy, data deletion, push, migration...) -> parked unless the contract allows', ['deploy', 'data_deletion', 'push', 'migration_nonlocal', 'secrets', 'ci_auth_payments', 'major_dependency', 'force_operation'].every((k) => cl({ category: k, confidence: 1, chosen: 'a' }).route === 'park_forbidden') && cl({ reversibility: 'irreversible', confidence: 1, chosen: 'a' }).route === 'park_forbidden');
    check(S, 'decision: an allowed irreversible category still needs an independent check; push can never be allowed', cl({ category: 'deploy', confidence: 1, chosen: 'a' }, { irreversible_allowed: ['deploy'] }).route === 'second_opinion' && !con.validateContract({ ...con.defaultContract(), goal: 'long enough goal text', definition_of_done: ['x'], verify: { test: 'x' }, irreversible_allowed: ['push'] }).ok);
    const opts = [{ id: 'a', label: 'A', safest: true, reversible: true, files: ['x'] }, { id: 'b', label: 'B', reversible: true, files: ['x', 'y'] }];
    const base = { question: 'Q?', options: opts, chosen: 'b', confidence: 0.4, reversibility: 'reversible' };
    const agree = await dec.resolveDecision(base, { contract: c, secondOpinion: async () => ({ available: true, choice: 'b', confidence: 0.85, family: 'gpt' }) });
    const disagree = await dec.resolveDecision(base, { contract: c, secondOpinion: async () => ({ available: true, choice: 'a', confidence: 0.9, family: 'gpt' }) });
    const nobody = await dec.resolveDecision(base, { contract: c, secondOpinion: async () => ({ available: false }) });
    const noSafe = await dec.resolveDecision({ ...base, options: [{ id: 'b', label: 'B', reversible: false }] }, { contract: c, secondOpinion: async () => ({ available: false }) });
    check(S, 'second opinion agrees -> decided, confidence raised, opinion recorded', agree.outcome === 'decided' && agree.chosen === 'b' && agree.rule === 'second_opinion_agrees' && agree.second_opinion.agrees === true && agree.confidence >= 0.8);
    check(S, 'second opinion disagrees -> still uncertain -> the safest minimal option is taken', disagree.outcome === 'decided' && disagree.chosen === 'a' && disagree.rule === 'safest_minimal' && disagree.second_opinion.agrees === false);
    check(S, 'no second opinion available (privacy/limits) -> safest minimal option; with no safe option only that task is parked', nobody.chosen === 'a' && nobody.rule === 'safest_minimal' && noSafe.outcome === 'parked');
    check(S, 'safest option falls back to the reversible option touching the fewest files', dec.safestOption([{ id: 'b', files: ['1', '2'] }, { id: 'c', files: ['1'] }, { id: 'd', reversible: false, files: [] }]).id === 'c');

    // engine level: privacy for the second opinion, redo with the safest option, forbidden action parks the task
    const repo = mkRepo(); const run = await setupRun(repo, 'dec-eng'); const clock = mkClock(); const world = mkWorld(run, clock);
    const e = mkEngine(run, clock, world); e.load();
    const task = { id: 'X', decisions: [], sensitivity: 'none', last_family: 'claude' };
    world.secondOpinion = { choice: 'b', confidence: 0.9 };
    const so1 = await e.recordDecision(task, { ...base, source: 'worker' });
    check(S, 'engine: second opinion comes from a DIFFERENT family with zero repo context and is logged', so1.second_opinion?.family && so1.second_opinion.family !== 'claude' && so1.rule === 'second_opinion_agrees' && world.adapter.some((a) => a.mode === 'research' && /Question: Q\?/.test(a.prompt) && !/src\//.test(a.prompt)), JSON.stringify(so1.second_opinion));
    const run2 = await setupRun(mkRepo(), 'dec-priv', { sensitivity: 'sensitive' }); const w2 = mkWorld(run2, clock);
    setLimits(run2, (l) => { l.gpt = { five_hour: null, seven_day: null, blocked_until: T0 + 90 * HOUR, blocked_reason: 'limit', blocked_estimated: false, block_attempts: 1 }; });
    const e2 = mkEngine(run2, clock, w2); e2.load();
    const so2 = await e2.recordDecision({ id: 'X', decisions: [], sensitivity: 'none', last_family: 'claude' }, { ...base, source: 'worker' });
    check(S, 'engine: sensitive run + the only sensitive_ok reviewer blocked -> NO second opinion is sent to grok/gemini; safest option is used', so2.second_opinion?.family === null && so2.rule === 'safest_minimal' && w2.adapter.length === 0, JSON.stringify(so2.second_opinion));

    // worker reports an uncertain decision -> settles to the safest option -> the task is redone with that decision
    const repo3 = mkRepo(); const run3 = await setupRun(repo3, 'dec-redo', only); const w3 = mkWorld(run3, mkClock());
    const clock3 = mkClock(); const w3b = mkWorld(run3, clock3);
    w3b.script.push({ match: (s) => s.label === 'T1', act: async (spec, h) => { h.work(spec, 'T1'); return h.tick(spec, { status: 'done', summary: '', files: [], decisions: [{ question: 'Which naming style?', options: opts, chosen: 'b', confidence: 0.4, reasoning: 'meh', reversibility: 'reversible', files: ['src/T1.txt'] }] }); } });
    const r3 = await mkEngine(run3, clock3, w3b).run();
    const t1calls = w3b.calls.filter((c) => c.label === 'T1');
    check(S, 'worker\'s uncertain choice -> settled to the safest option -> task redone ONCE with "Decisions already taken"; the decision is logged', r3.status === 'completed' && t1calls.length === 2 && /Which naming style\? -> A/.test(t1calls[1].prompt) && decisions(run3).some((d) => d.rule === 'safest_minimal' && d.chosen === 'a' && d.worker_choice === 'b'), JSON.stringify({ r3, n: t1calls.length }));
    void w3;
    const repo4 = mkRepo(); const run4 = await setupRun(repo4, 'dec-park', only); const clock4 = mkClock(); const w4 = mkWorld(run4, clock4);
    w4.script.push({ match: (s) => s.label === 'T1', act: async (spec, h) => { h.work(spec, 'T1'); return h.tick(spec, { status: 'done', summary: '', files: [], decisions: [{ question: 'Deploy the migration to production now?', options: [{ id: 'go', label: 'deploy', reversible: false }, { id: 'skip', label: 'skip', safest: true, reversible: true }], chosen: 'go', confidence: 1, reasoning: 'ready', reversibility: 'irreversible', category: 'deploy', files: [] }] }); } });
    const r4 = await mkEngine(run4, clock4, w4).run();
    const s4 = st(run4);
    check(S, 'worker wants an irreversible action -> that task is parked and rolled back, dependents parked, the run ends "blocked" with a notification', r4.status === 'blocked' && s4.tasks[0].status === 'parked' && s4.tasks[1].status === 'parked' && /decision needs a human/.test(s4.tasks[0].parked_reason) && !fs.existsSync(path.join(run4.paths.worktree, 'src', 'T1.txt')) && treeClean(run4) && w4.notified.includes('blocked') && /T1/.test(readLog(run4.paths.parked)) && decisions(run4).some((d) => d.outcome === 'parked' && d.category === 'deploy'), JSON.stringify({ r4, reasons: s4.tasks.map((t) => t.parked_reason) }));
  }

  // a real worker once returned a decision entry without a question: it must not park the task
  {
    const repo = mkRepo(); const run = await setupRun(repo, 'bad-decision', only); const clock = mkClock(); const world = mkWorld(run, clock);
    world.script.push({ match: (s) => s.label === 'T1', act: async (spec, h) => { h.work(spec, 'T1'); return h.tick(spec, { status: 'done', summary: '', files: [], decisions: [{ confidence: 0.9 }, null, { question: '', chosen: 'a' }] }); } });
    const r = await mkEngine(run, clock, world).run();
    check(S, 'a malformed worker decision entry (no question) is ignored and noted, it does not park the task; the raw final is kept for debugging', r.status === 'completed' && /ignored a malformed decision/.test(readLog(run.paths.journal)) && fs.existsSync(path.join(run.paths.tasks, 'T1-final.json')));
  }

  // ---------------------------------------------------------------- 11. review fix rounds
  {
    const repo = mkRepo(); const run = await setupRun(repo, 'rev-fix'); const clock = mkClock(); const world = mkWorld(run, clock);
    world.reviewFindings = [{ where: 'src/T2.txt:1', severity: 'high', confidence: 'high', scenario: 'beta file lacks the marker' }];
    world.script.push({ match: (s) => s.label === 'T2-fix1', act: async (spec, h) => { fs.appendFileSync(path.join(spec.cwd, 'src', 'T2.txt'), 'fixed\n'); return h.tick(spec, { status: 'done', summary: 'fixed', files: [], decisions: [] }); } });
    const r = await mkEngine(run, clock, world).run();
    const s = st(run);
    check(S, 'review: a high finding goes back to the author (round 1), the fix is re-verified and re-reviewed (round 2) before the checkpoint', r.status === 'completed' && s.reviews.filter((x) => x.task === 'T2' && x.lens === 'general').length === 2 && s.reviews.find((x) => x.task === 'T2' && x.round === 1).high === 1 && s.reviews.find((x) => x.task === 'T2' && x.round === 1).fixed === 1 && /fixed/.test(readLog(path.join(run.paths.worktree, 'src', 'T2.txt'))), JSON.stringify(s.reviews));
    const repo2 = mkRepo(); const run2 = await setupRun(repo2, 'rev-park'); const clock2 = mkClock(); const w2 = mkWorld(run2, clock2);
    w2.reviewAlways = [{ where: 'src/T2.txt:1', severity: 'high', confidence: 'high', scenario: 'never satisfiable' }];
    w2.script.push({ match: (s) => /^T2-fix\d$/.test(s.label || ''), once: false, act: async (spec, h) => h.tick(spec, { status: 'done', summary: 'tried', files: [], decisions: [] }) });
    const r2 = await mkEngine(run2, clock2, w2).run();
    const s2 = st(run2);
    check(S, 'review: high findings still open after two fix rounds -> the task is parked (not shipped), rejected work kept in a ref, the run goes on', r2.status === 'blocked' && s2.tasks[1].status === 'parked' && /high finding/.test(s2.tasks[1].parked_reason) && sh(repo2, 'rev-parse', '--verify', `refs/auto/${run2.id}/parked/T2`).status === 0 && !fs.existsSync(path.join(run2.paths.worktree, 'src', 'T2.txt')) && s2.tasks[0].status === 'done');
  }

  // ---------------------------------------------------------------- 12. diff guard: contract limits are enforced on the diff
  {
    const guardPlan = () => ({ ...PLAN(), decisions: [], tasks: [
      { id: 'T1', title: 'Touch something forbidden', type: 'implement', complexity: 'S', risk: 'low', deps: [], files: [], criteria: [] },
      { id: 'T2', title: 'Independent change', type: 'implement', complexity: 'S', risk: 'low', deps: [], files: [], criteria: [] },
      { id: 'T3', title: 'Depends on T1', type: 'implement', complexity: 'S', risk: 'low', deps: ['T1'], files: [], criteria: [] },
    ] });
    const cases = [
      ['ci', {}, '.github/workflows/ci.yml', 'name: x\n', /CI\/CD configuration/],
      ['protected', { protected_paths: ['config/**'] }, 'config/app.txt', 'x\n', /protected path/],
      ['deps', {}, 'package.json', JSON.stringify({ name: 'x', dependencies: { 'left-pad': '^1.3.0' } }), /dependencies are frozen/],
      ['secret', {}, 'deploy/.env', 'A=1\n', /secret\/credential file/],
    ];
    const results = [];
    for (const [slug, over, rel, body, rx] of cases) {
      const repo = mkRepo(); const run = await setupRun(repo, `guard-${slug}`, { ...only, ...over }); const clock = mkClock(); const world = mkWorld(run, clock);
      world.plan = guardPlan();
      world.script.push({ match: (s) => s.label === 'T1', act: writeThen(rel, body) });
      const r = await mkEngine(run, clock, world).run();
      const s = st(run);
      const ok = r.status === 'blocked' && s.tasks[0].status === 'parked' && rx.test(s.tasks[0].parked_reason) && s.tasks[1].status === 'done' && s.tasks[2].status === 'parked' && !fs.existsSync(path.join(run.paths.worktree, rel)) && treeClean(run) && sh(repo, 'rev-parse', '--verify', `refs/auto/${run.id}/parked/T1`).status === 0 && decisions(run).some((d) => d.source === 'guard' && d.outcome === 'parked');
      results.push(ok ? null : `${slug}: ${r.status} ${s.tasks.map((t) => t.status)} ${s.tasks[0].parked_reason}`);
    }
    check(S, 'diff guard: CI change / protected path / frozen dependencies / secret file -> that task is rolled back and parked, independent work continues, dependents are parked', results.every((x) => !x), results.filter(Boolean).join(' | '));
    const repo = mkRepo(); const run = await setupRun(repo, 'guard-allowed', { ...only, irreversible_allowed: ['ci_auth_payments'] }); const clock = mkClock(); const world = mkWorld(run, clock);
    world.plan = guardPlan();
    world.script.push({ match: (s) => s.label === 'T1', act: writeThen('.github/workflows/ci.yml', 'name: x\n') });
    const r = await mkEngine(run, clock, world).run();
    check(S, 'diff guard: the same CI change passes when the contract explicitly allows ci_auth_payments', r.status === 'completed');
    const g = dec.guardDiff([{ path: 'package.json', status: 'M' }], { dependencies: 'patch_minor' }, { readOld: () => JSON.stringify({ dependencies: { a: '^1.2.0', b: '^2.0.0' } }), readNew: () => JSON.stringify({ dependencies: { a: '^1.3.0', b: '^3.0.0' } }) });
    const g2 = dec.guardDiff([{ path: 'package.json', status: 'M' }], { dependencies: 'patch_minor' }, { readOld: () => JSON.stringify({ dependencies: { a: '^1.2.0' } }), readNew: () => JSON.stringify({ dependencies: { a: '^1.9.0' } }) });
    const many = dec.guardDiff(Array.from({ length: 16 }, (_, i) => ({ path: `f${i}`, status: 'D' })), {});
    check(S, 'diff guard: patch_minor allows a minor bump but flags a major one; a mass delete (>= 15 files) is flagged', !g.ok && /b major/.test(g.violations[0].detail) && g2.ok && !many.ok && many.violations[0].rule === 'mass_delete');
  }

  // ---------------------------------------------------------------- 13. loop protection
  {
    const lp = () => ({ ...PLAN(), decisions: [], tasks: [
      { id: 'T1', title: 'Always fails', type: 'implement', complexity: 'S', risk: 'low', deps: [], files: [], criteria: [] },
      { id: 'T2', title: 'Depends on T1', type: 'implement', complexity: 'S', risk: 'low', deps: ['T1'], files: [], criteria: [] },
      { id: 'T3', title: 'Independent', type: 'implement', complexity: 'S', risk: 'low', deps: [], files: [], criteria: [] },
    ] });
    const repo = mkRepo(); const run = await setupRun(repo, 'loop', only); const clock = mkClock(); const world = mkWorld(run, clock);
    world.plan = lp();
    world.script.push({ match: (s) => s.label === 'T1', once: false, act: writeThen('src/T1.txt', 'BAD\n') });
    const r = await mkEngine(run, clock, world).run();
    const s = st(run);
    const calls = world.calls.filter((c) => c.label === 'T1').length;
    check(S, 'loop protection: a task failing verification is retried at most task_attempts (3) times with escalation, then parked; the rest goes on', r.status === 'blocked' && calls === 3 && s.tasks[0].status === 'parked' && s.tasks[0].attempts === 3 && s.tasks[1].status === 'parked' && s.tasks[2].status === 'done' && treeClean(run) && s.events.escalations >= 1, JSON.stringify({ r, calls, st: s.tasks.map((t) => [t.id, t.status, t.attempts]) }));
    check(S, 'the failing evidence is passed to the next attempt and the parked reason names the check', world.calls.filter((c) => c.label === 'T1')[1].prompt.includes('BAD content') && /verification failed 3x/.test(s.tasks[0].parked_reason));
    const repo2 = mkRepo(); const run2 = await setupRun(repo2, 'noprog', { ...only, budgets: { no_progress_min: 10 } }); const clock2 = mkClock(); const w2 = mkWorld(run2, clock2);
    w2.plan = lp();
    w2.script.push({ match: (s) => s.label === 'T1', once: false, act: async (spec, h) => { clock2.t += 6 * 60000; fs.writeFileSync(path.join(spec.cwd, 'src', 'T1.txt'), 'BAD\n'); return h.tick(spec, { status: 'done', summary: '', files: [], decisions: [] }); } });
    await mkEngine(run2, clock2, w2).run();
    check(S, 'no-progress timeout: a task that burns its time budget without a checkpoint is parked before the attempt budget', st(run2).tasks[0].status === 'parked' && /no progress within the time budget/.test(st(run2).tasks[0].parked_reason) && w2.calls.filter((c) => c.label === 'T1').length === 2);
  }

  // ---------------------------------------------------------------- 14. hangs, network, login, overload, overage
  {
    const repo = mkRepo(); const run = await setupRun(repo, 'hang', only); const clock = mkClock(); const world = mkWorld(run, clock);
    world.script.push({ match: (s) => s.label === 'T1', act: async (spec) => ({ kind: 'hang', note: 'no output for 20 min', session_id: spec.sessionId, seen_session: true, usage: { total: 0, fresh: 0 } }) });
    const r = await mkEngine(run, clock, world).run();
    check(S, 'hung worker (no output): killed, rolled back, counted as one attempt, retried and the run completes', r.status === 'completed' && st(run).tasks[0].attempts === 1 && world.calls.filter((c) => c.label === 'T1').length === 2);
  }
  {
    const repo = mkRepo(); const run = await setupRun(repo, 'net', only); const clock = mkClock(); const world = mkWorld(run, clock);
    world.net = false;
    world.script.push({ match: (s) => s.label === 'T1', act: async (spec, h) => { fs.writeFileSync(path.join(spec.cwd, 'src', 'T1.partial'), 'x'); return { kind: 'network', session_id: spec.sessionId, seen_session: true, usage: { total: 0, fresh: 0 } }; } });
    clock.onSleep = async (k) => { if (k.t >= T0 + 25 * 60000) world.net = true; };
    const r = await mkEngine(run, clock, world).run();
    const log = readLog(run.paths.limits);
    check(S, 'network down: the run goes WAITING (zero-token probes, notification), never exits, then resumes the same session and completes', r.status === 'completed' && /WAIT kind=external/.test(log) && world.notified.includes('waiting_external') && world.calls.filter((c) => c.label === 'T1').length === 2 && world.calls.filter((c) => c.label === 'T1')[1].resume === true && st(run).tasks[0].attempts === 0, log);
  }
  {
    const repo = mkRepo(); const run = await setupRun(repo, 'auth', only); const clock = mkClock(); const world = mkWorld(run, clock);
    world.auth = { ok: false };
    world.script.push({ match: (s) => s.label === 'T1', act: async (spec) => ({ kind: 'auth', session_id: spec.sessionId, seen_session: false, usage: { total: 0, fresh: 0 } }) });
    clock.onSleep = async (k) => { if (k.t >= T0 + 40 * 60000) world.auth = { ok: true }; };
    const r = await mkEngine(run, clock, world).run();
    check(S, 'Claude login lost: the run waits for the login (zero-token `auth status` probes) and continues once it is back', r.status === 'completed' && /WAIT kind=external reason="Claude login required"/.test(readLog(run.paths.limits)) && world.calls.filter((c) => c.label === 'T1').length === 2);
  }
  {
    const repo = mkRepo(); const run = await setupRun(repo, 'overage', only); const clock = mkClock(); const world = mkWorld(run, clock);
    world.script.push({ match: (s) => s.label === 'T1', act: async (spec) => ({ kind: 'limit', retry_at: clock.t + 2 * HOUR, estimated: false, scope: 'five_hour', overage: true, session_id: spec.sessionId, seen_session: true, usage: { total: 10, fresh: 10 }, windows: { windows: { five_hour: { pct: 100, resets_at: clock.t + 2 * HOUR } }, overage: { using: true } } }) });
    await mkEngine(run, clock, world).run();
    check(S, 'extra-usage (overage) is never used: a tick that reports it is treated as a hard limit and logged', /OVERAGE-REFUSED/.test(readLog(run.paths.limits)) && st(run).limits.claude.overage_seen === true);
    const repo2 = mkRepo(); const run2 = await setupRun(repo2, 'unknown-reset', only); const clock2 = mkClock(); const w2 = mkWorld(run2, clock2);
    w2.script.push({ match: (s) => s.label === 'T1', act: async (spec) => ({ kind: 'limit', retry_at: null, estimated: true, scope: null, session_id: spec.sessionId, seen_session: true, usage: { total: 0, fresh: 0 } }) });
    const r2 = await mkEngine(run2, clock2, w2).run();
    const t1 = w2.calls.filter((c) => c.label === 'T1');
    check(S, 'limit with an UNKNOWN reset time: probes again after a backoff (10 min first), marked as estimated, and completes', r2.status === 'completed' && t1.length === 2 && t1[1].at - t1[0].at >= 10 * 60000 && t1[1].at - t1[0].at < 15 * 60000 && /unknown: probing with backoff/.test(readLog(run2.paths.limits)));
  }

  // ---------------------------------------------------------------- 15. undo, review, merge, cleanup (CLI on a finished run)
  {
    const repo = mkRepo(); const mainBefore = sh(repo, 'rev-parse', 'main').stdout.trim();
    const run = await setupRun(repo, 'cli', only); const clock = mkClock(); const world = mkWorld(run, clock);
    world.plan = { ...PLAN(), decisions: [] };
    for (const id of ['T1', 'T2']) world.script.push({ match: (s) => s.label === id, act: async (spec, h) => { h.work(spec, id); return h.tick(spec, { status: 'done', summary: '', files: [], decisions: [{ question: `Layout for ${id}?`, options: [{ id: 'a', label: 'A', safest: true, reversible: true }], chosen: 'a', confidence: 0.95, reasoning: 'r', reversibility: 'reversible', files: [`src/${id}.txt`] }] }); } });
    await mkEngine(run, clock, world).run();
    const ds = decisions(run).filter((d) => d.task);
    const undo2 = ds.find((d) => d.task === 'T2').undo;
    const u = spawnSync(undo2, { shell: true, cwd: repo, encoding: 'utf8' });
    check(S, 'a decision\'s undo command is ready to run and really reverts that task on the auto branch (T2 gone, T1 intact, checks still pass)', u.status === 0 && !fs.existsSync(path.join(run.paths.worktree, 'src', 'T2.txt')) && fs.existsSync(path.join(run.paths.worktree, 'src', 'T1.txt')) && spawnSync(process.execPath, ['check.mjs'], { cwd: run.paths.worktree }).status === 0 && sh(repo, 'rev-parse', 'main').stdout.trim() === mainBefore, u.stderr);
    sh(run.paths.worktree, 'reset', '--hard', st(run).tasks[1].checkpoint.sha);
    const list = node('auto.mjs', ['review', 'list', '--run', run.id]);
    check(S, 'review list: per-item (task) entries with sha, files and decisions', list.json?.items?.length === 2 && list.json.items[0].decisions.length === 1 && list.json.items[0].sha.length === 8, list.stdout.slice(0, 300));
    const rv = node('auto.mjs', ['review', 'revert', '--run', run.id, '--id', ds.find((d) => d.task === 'T2').id]);
    check(S, 'review revert (by decision id) reverts the task on the auto/* branch only and records it', rv.json?.ok && rv.json.reverted === 'T2' && !fs.existsSync(path.join(run.paths.worktree, 'src', 'T2.txt')) && sh(repo, 'rev-parse', 'main').stdout.trim() === mainBefore && decisions(run).some((d) => d.outcome === 'reverted'), rv.stdout + rv.stderr);
    const noYes = node('auto.mjs', ['merge', '--run', run.id, '--into', 'main']);
    check(S, 'merge without an explicit yes is refused', noYes.code !== 0 && /explicit yes/.test(noYes.stdout) && sh(repo, 'rev-parse', 'main').stdout.trim() === mainBefore);
    const wrongBranch = (() => { sh(repo, 'checkout', '-q', '-b', 'other'); const r = node('auto.mjs', ['merge', '--run', run.id, '--into', 'main', '--yes']); sh(repo, 'checkout', '-q', 'main'); return r; })();
    check(S, 'merge refuses when the repo is not on the target branch (the orchestrator never switches your branch)', wrongBranch.code !== 0 && /not "main"/.test(wrongBranch.json?.error || '') && sh(repo, 'rev-parse', 'main').stdout.trim() === mainBefore, wrongBranch.stdout + wrongBranch.stderr);
    const mg = node('auto.mjs', ['merge', '--run', run.id, '--into', 'main', '--yes']);
    check(S, 'merge with the explicit yes + matching branch merges the auto branch (no push)', mg.json?.ok && fs.existsSync(path.join(repo, 'src', 'T1.txt')) && !fs.existsSync(path.join(repo, 'src', 'T2.txt')) && sh(repo, 'rev-parse', 'main').stdout.trim() !== mainBefore, mg.stdout + mg.stderr);
    const cl = node('auto.mjs', ['cleanup', '--run', run.id, '--yes']);
    check(S, 'cleanup removes worktree, branch, tags and snapshot refs (run directory and report stay)', cl.json?.ok && !fs.existsSync(run.paths.worktree) && sh(repo, 'rev-parse', '--verify', '-q', `auto/${run.id}`).status !== 0 && sh(repo, 'tag', '--list', `auto/${run.id}/*`).stdout.trim() === '' && fs.existsSync(run.paths.report), cl.stdout + cl.stderr);
  }
  {
    // control CLI on a run whose supervisor is gone (laptop slept, machine rebooted)
    const repo = mkRepo(); const run = await setupRun(repo, 'cli-ctl', only); const clock = mkClock(); const world = mkWorld(run, clock);
    world.script.push({ match: (s) => s.label === 'T1', act: async (spec, h) => { core.setControl(run.paths, 'STOP'); h.work(spec, 'T1'); return h.tick(spec, { status: 'done', summary: '', files: [], decisions: [] }); } });
    await mkEngine(run, clock, world).run();
    const before = fs.readFileSync(run.paths.state, 'utf8');
    const stt = node('auto.mjs', ['status', '--run', run.id]);
    const rp = node('auto.mjs', ['report', '--run', run.id]);
    check(S, 'status and report are read-only: they print Polish text and leave state.json byte-identical', /stopped|zatrzymany/.test(stt.stdout) && /Autonomiczny przebieg/.test(rp.stdout) && fs.readFileSync(run.paths.state, 'utf8') === before);
    const tk = node('auto.mjs', ['takeover', '--run', run.id]);
    check(S, 'takeover works even when the supervisor is dead (done offline): hand-off written, mode switched', tk.json?.ok && st(run).status === 'handed_over' && fs.existsSync(run.paths.handoff), tk.stdout + tk.stderr);
    const repo2 = mkRepo(); const run2 = await setupRun(repo2, 'cli-abort', only);
    const ab = node('auto.mjs', ['abort', '--run', run2.id]);
    check(S, 'abort works offline too and leaves the worktree and branch intact', ab.json?.ok && st(run2).status === 'aborted' && fs.existsSync(run2.paths.worktree));
    const noGo = node('auto.mjs', ['start', '--run', run2.id]);
    check(S, 'start without --go is refused: nothing starts without the explicit GO', noGo.code !== 0 && /GO/.test(noGo.stdout));
  }
  void merge; void rep;
}
