// Autonomous mode: the engine. A state machine over state.json that survives a crash at any instant (every step is
// resumable from disk), never exits because of a usage limit (it checkpoints, sleeps with zero tokens, resumes), and
// keeps a bounded context by giving every worker a self-contained prompt. All side effects go through `deps`
// (clock, git, workers, checks, usage feed, notifications), so the selftest drives the real engine with fakes and a
// simulated clock.
import fs from 'node:fs';
import path from 'node:path';
import {
  AUTO_ROOT, runPaths, saveState, loadState, journal, limitLog, parkNote, appendJsonl, readJsonl, writeHeartbeat, acquireLock, releaseLock,
  readControl, setControl, clearActive, snapshotWorktree, uuid, writeFileAtomic,
} from './auto-core.mjs';
import { enabledFamilies, allPoolStatus, readJson } from './common.mjs';
import { candidates, escalate } from '../registry.mjs';
import { effectiveSensitivity, familyAllowed, matchGlobList } from './privacy.mjs';
import { availability, recordWindows, recordBlock, clearBlock, normPolicy, EXTERNAL_BACKOFF_MIN, feedFromPool } from './auto-limits.mjs';
import { resolveDecision, guardDiff, undoCommand } from './auto-decisions.mjs';
import { verifyCommands, readContract } from './auto-contract.mjs';
import { SYSTEM_RULES, plannerPrompt, taskPrompt, reviewPrompt, secondOpinionPrompt, readAgentBody, extractFinalJson } from './auto-worker.mjs';
import { egmGate } from '../egm-gate.mjs';
import { buildReport, buildHandoff } from './auto-report.mjs';

const SENS = ['none', 'internal', 'sensitive'];
const maxSens = (...a) => a.reduce((m, x) => (SENS.indexOf(x) > SENS.indexOf(m) ? x : m), 'none');
const CODE_TYPES = ['implement', 'refactor', 'debug', 'test', 'mechanical'];
const TASK_TYPES = [...CODE_TYPES, 'research', 'review'];
const CHUNK_MS = 30000;
const EXTERNAL_RENOTIFY_MS = 6 * 3600000;

export class CrashForTest extends Error {}

export function makeInitialState(c, worktree, nowMs) {
  return {
    schema: 1, run_id: c.id, repo: c.repo, branch: c.branch, base_branch: c.base_branch, base_sha: c.base_sha, worktree,
    status: 'created', phase: 'plan', mode: 'autonomous', created_at: new Date(nowMs).toISOString(), reviewed: false,
    tasks: [], plan: null, checkpoint_sha: c.base_sha, inflight: null, limits: {}, wait: null,
    counters: { dispatches: 0, decisions: 0, plan_attempts: 0, final_repairs: 0 }, usage: {}, reviews: [], final: {}, notified: {}, events: { waits: 0, reroutes: 0, escalations: 0 },
  };
}

export class AutoEngine {
  // deps: { reg, now, sleep, git, runClaude, runAdapter, runChecks, refreshUsage, notify, netCheck, authCheck, crashPoint, pollMs, heartbeatMs, killPid }
  constructor({ paths, deps, contract, rules = null, perms }) {
    this.paths = paths; this.deps = deps; this.contract = contract; this.rules = rules; this.perms = perms;
    this.policy = normPolicy(contract.limits);
    this.st = null;
    this.git = deps.git;
    this.cp = (name) => deps.crashPoint?.(name);
  }

  // ------------------------------------------------------------ small helpers
  get wt() { return this.paths.worktree; }
  now() { return this.deps.now(); }
  jr(text) { journal(this.paths, text, new Date(this.now())); }
  save() { saveState(this.paths, this.st); }
  beat(extra = {}) { writeHeartbeat(this.paths, { phase: this.st?.phase, status: this.st?.status, ...extra }, this.now()); }
  task(id) { return this.st.tasks.find((t) => t.id === id); }
  nextDecisionId() { this.st.counters.decisions = (this.st.counters.decisions || 0) + 1; return `D${String(this.st.counters.decisions).padStart(3, '0')}`; }
  setStatus(status, extra = {}) { this.st.status = status; Object.assign(this.st, extra); this.save(); }

  // ------------------------------------------------------------ lifecycle
  initialState() { return makeInitialState(this.contract, this.wt, this.now()); }

  // Rebuild a lost state from the contract, plan.json and checkpoint tags (everything else is re-learned).
  rebuildState() {
    const st = this.initialState();
    const plan = readJson(this.paths.plan, null);
    st.rebuilt = true;
    if (plan?.tasks?.length) {
      st.plan = { approach: plan.approach || '', risks: plan.risks || [] };
      st.tasks = plan.tasks.map((t) => ({ ...t, status: 'pending', attempts: 0, failures: 0, decisions: [], active_ms: 0 }));
      const tags = this.git(this.wt, ['tag', '--list', `auto/${this.contract.id}/*`], { allowFail: true }).out.split(/\r?\n/).filter(Boolean);
      for (const t of st.tasks) {
        const tag = `auto/${this.contract.id}/${t.id}`;
        if (tags.includes(tag)) { t.status = 'done'; t.checkpoint = { sha: this.git(this.wt, ['rev-parse', `${tag}^{commit}`]).out, tag, at: null }; }
      }
      st.phase = 'execute';
      st.checkpoint_sha = this.git(this.wt, ['rev-parse', 'HEAD']).out;
    }
    st.status = 'running';
    return st;
  }

  load() {
    const { state, source, corrupt } = loadState(this.paths);
    if (state) {
      this.st = state;
      if (source === 'backup') this.jr(`state.json was ${corrupt ? 'corrupt' : 'missing'}: recovered from state.json.bak (seq ${state.seq})`);
      return;
    }
    this.st = this.rebuildState();
    this.jr(`state files ${corrupt ? 'corrupt' : 'missing'}: state rebuilt from the contract, plan.json and checkpoint tags (${this.st.tasks.filter((t) => t.status === 'done').length}/${this.st.tasks.length} tasks already checkpointed)`);
    this.save();
  }

  ensureWorktree() {
    if (fs.existsSync(path.join(this.wt, '.git'))) return;
    this.git(this.contract.repo, ['worktree', 'prune'], { allowFail: true });
    this.git(this.contract.repo, ['worktree', 'add', this.wt, this.contract.branch]);
    this.jr('worktree was missing: re-attached to the auto branch');
  }

  // Crash recovery: finish a half-done commit, stop an orphan worker, keep a half-edited tree for a resume.
  async recover() {
    this.ensureWorktree();
    const inf = this.st.inflight;
    if (!inf) return;
    if (inf.pid && this.deps.killPid) this.deps.killPid(inf.pid);
    const t = this.task(inf.task);
    const head = this.git(this.wt, ['rev-parse', 'HEAD']).out;
    if (t && inf.phase === 'committing' && head !== inf.base_sha && this.git(this.wt, ['log', '-1', '--format=%s'], { allowFail: true }).out.startsWith(`[auto] ${t.id}:`)) {
      this.jr(`recovery: the commit of ${t.id} landed before the crash: finishing its bookkeeping`);
      this.completeTask(t, head, inf);
      return;
    }
    if (t && t.status === 'running') {
      // the tree may hold the worker's partial edits: keep them, resume the same session when there is one
      t.status = 'pending';
      if (inf.session_id && inf.kind === 'work') t.resume = { session_id: inf.session_id, family: inf.family, model: inf.model, effort: inf.effort, reason: 'crash', at: this.now() };
      this.jr(`recovery: ${t.id} was in flight (${inf.phase}); ${t.resume ? 'will resume the worker session' : 'will redo the attempt'} on the preserved tree`);
    }
    this.st.inflight = null;
    this.save();
  }

  // ------------------------------------------------------------ main loop
  async run() {
    const lk = acquireLock(this.paths, { now: this.now() });
    if (!lk.ok) return { status: 'locked', reason: lk.reason, holder: lk.holder };
    const timer = this.deps.heartbeatMs ? setInterval(() => this.beat(), this.deps.heartbeatMs) : null;
    try {
      this.load();
      if (this.st.mode === 'interactive' || ['completed', 'blocked', 'aborted', 'handed_over'].includes(this.st.status)) return { status: this.st.status, reason: 'already finished' };
      await this.recover();
      if (this.st.status !== 'paused') this.setStatus(this.st.phase === 'plan' ? 'planning' : 'running');
      this.cp('loop-start');
      for (;;) {
        this.beat();
        const stop = await this.controlGate();
        if (stop) return stop;
        if (this.st.counters.dispatches > this.contract.budgets.max_dispatches) return this.finish('blocked', 'dispatch budget exhausted (loop protection)');
        if (this.st.phase === 'plan') await this.doPlan();
        else if (this.st.phase === 'execute') {
          if (this.deadlinePassed()) { this.deadlineCut(); continue; }
          await this.stepExecute();
        } else if (this.st.phase === 'final') {
          const r = await this.doFinal();
          if (r) return r;
        } else return { status: this.st.status, reason: 'nothing left to do' };
      }
    } finally {
      if (timer) clearInterval(timer);
      releaseLock(this.paths);
    }
  }

  deadlinePassed() { return !!this.contract.deadline && this.now() >= Date.parse(this.contract.deadline); }
  deadlineCut() {
    for (const t of this.st.tasks.filter((x) => ['pending', 'running'].includes(x.status))) this.parkTask(t, 'deadline reached: not started', { rollback: false });
    this.jr('deadline reached: no more work is started; final checks and report follow');
    this.st.phase = 'final'; this.save();
  }

  // STOP / PAUSE / TAKEOVER / ABORT are honored between steps (the safe points), and mid-wait.
  async controlGate() {
    for (;;) {
      const c = readControl(this.paths);
      if (c.abort) return this.abortRun();
      if (c.takeover) return this.takeover();
      if (c.stop) { this.setStatus('stopped', { exit_reason: 'STOP file: stopped at a checkpoint' }); this.jr('STOP: stopped at a checkpoint'); this.deps.notify?.('stopped', this.st); return { status: 'stopped', reason: 'STOP' }; }
      if (!c.pause) { if (this.st.status === 'paused') this.setStatus(this.st.phase === 'plan' ? 'planning' : 'running'); return null; }
      if (this.st.status !== 'paused') { this.setStatus('paused'); this.jr('PAUSE: idle at a checkpoint (zero tokens)'); }
      this.beat();
      await this.deps.sleep(Math.min(CHUNK_MS, 5000));
    }
  }

  // Watches control files while a worker runs; abort/takeover cancel the worker through the signal.
  watchControls(ctl) {
    if (!this.deps.pollMs) return () => {};
    const t = setInterval(() => { const c = readControl(this.paths); if (c.abort || c.takeover) ctl.abort(); }, this.deps.pollMs);
    return () => clearInterval(t);
  }

  // ------------------------------------------------------------ waiting (zero tokens)
  async waitUntil(ts, reason, kind = 'limit') {
    const start = this.now();
    this.st.events.waits = (this.st.events.waits || 0) + 1;
    this.setStatus('waiting', { wait: { reason, kind, since: start, until: ts } });
    const wakeAt = new Date(ts).toISOString();
    limitLog(this.paths, `WAIT kind=${kind} until=${wakeAt} (${Math.round((ts - start) / 60000)} min) reason="${reason}"`, new Date(start));
    this.jr(`waiting until ${wakeAt}: ${reason}`);
    const notifyKey = kind === 'external' ? 'waiting_external' : 'long_wait';
    const minMs = (this.contract.notify.wait_min || 120) * 60000;
    const last = this.st.notified[notifyKey] || 0;
    if ((kind === 'external' || ts - start >= minMs) && start - last >= (kind === 'external' ? EXTERNAL_RENOTIFY_MS : 3600000)) { this.st.notified[notifyKey] = start; this.save(); this.deps.notify?.(notifyKey, this.st); }
    this.cp('wait-begin');
    while (this.now() < ts) {
      this.beat({ waiting_until: wakeAt });
      const c = readControl(this.paths);
      if (c.stop || c.abort || c.takeover || c.pause) break;
      await this.deps.sleep(Math.min(CHUNK_MS, Math.max(1, ts - this.now())));
    }
    limitLog(this.paths, `WAKE slept=${Math.round((this.now() - start) / 60000)} min`, new Date(this.now()));
    this.st.wait = null;
    if (this.st.status === 'waiting') this.st.status = this.st.phase === 'plan' ? 'planning' : 'running';
    this.save();
  }

  // Network / login problems: zero-token probes with growing gaps; never exits.
  async waitExternal(reason, probe) {
    const start = this.now();
    this.st.events.waits = (this.st.events.waits || 0) + 1;
    this.setStatus('waiting', { wait: { reason, kind: 'external', since: start, until: null } });
    limitLog(this.paths, `WAIT kind=external reason="${reason}" (probing without model calls)`, new Date(start));
    this.jr(`waiting for an external problem to clear: ${reason}`);
    const last = this.st.notified.waiting_external || 0;
    if (start - last >= EXTERNAL_RENOTIFY_MS) { this.st.notified.waiting_external = start; this.save(); this.deps.notify?.('waiting_external', this.st); }
    for (let i = 0; ; i++) {
      this.beat({ waiting_external: reason });
      const c = readControl(this.paths);
      if (c.stop || c.abort || c.takeover || c.pause) break;
      const gap = EXTERNAL_BACKOFF_MIN[Math.min(i, EXTERNAL_BACKOFF_MIN.length - 1)] * 60000;
      const until = this.now() + gap;
      while (this.now() < until) {
        const cc = readControl(this.paths);
        if (cc.stop || cc.abort || cc.takeover || cc.pause) break;
        await this.deps.sleep(Math.min(CHUNK_MS, Math.max(1, until - this.now())));
        this.beat({ waiting_external: reason });
      }
      if (readControl(this.paths).stop) break;
      const ok = await probe();
      if (ok) break;
    }
    limitLog(this.paths, `WAKE external problem cleared or interrupted after ${Math.round((this.now() - start) / 60000)} min`, new Date(this.now()));
    this.st.wait = null;
    if (this.st.status === 'waiting') this.st.status = this.st.phase === 'plan' ? 'planning' : 'running';
    this.save();
  }

  // ------------------------------------------------------------ usage and routing
  async refreshLimits() {
    try { await this.deps.refreshUsage?.(this.st.limits, this.now()); } catch { /* the feed is best effort */ }
  }

  recordTick(family, tick) {
    if (tick.windows?.windows) recordWindows(this.st.limits, family, tick.windows.windows, this.now(), 'exact');
    if (tick.windows?.overage?.using) this.st.limits[family].overage_seen = true;
    const u = (this.st.usage[family] ||= { ticks: 0, tokens: 0, fresh: 0 });
    u.ticks += 1; u.tokens += tick.usage?.total || 0; u.fresh += tick.usage?.fresh || 0;
    appendJsonl(this.paths.usage, { at: new Date(this.now()).toISOString(), family, task: this.st.inflight?.task || null, kind: tick.kind, tokens: tick.usage?.total || 0, fresh: tick.usage?.fresh || 0 });
  }

  taskSensitivity(t) {
    return effectiveSensitivity(this.deps.reg, { sensitivity: maxSens(this.contract.sensitivity, t.sensitivity || 'none'), files: t.files || [] }).level;
  }

  poolsView(av) {
    const reg = this.deps.reg;
    const out = {};
    for (const p of allPoolStatus(reg)) {
      const f = p.family;
      const lim = this.st.limits[f];
      const known = lim && (lim.five_hour || lim.seven_day);
      const pct = known ? Math.max(0, lim.five_hour?.pct || 0, lim.seven_day?.pct || 0) : p.pct;
      const blocked = !av.use.includes(f);
      out[p.pool] = { ...p, pct, level: blocked ? 'cooldown' : 'ok', model_cooldowns: {}, cooldown_until: null };
    }
    return out;
  }

  // Picks family + model + effort for one dispatch, honoring privacy, soft/hard limits and "no approvals overnight".
  selectRoute({ type, complexity, risk, sensitivity, exclude = [], only = null, kind = 'work', role = 'author', lens, override = null }) {
    const reg = this.deps.reg;
    const allowed = this.contract.families?.allow;
    const fams = enabledFamilies(reg).filter((f) => (!allowed || allowed.includes(f)) && (!only || only.includes(f)) && !exclude.includes(f) && familyAllowed(reg, f, sensitivity).ok);
    if (!fams.length) return { ok: false, permanent: true, reason: `no enabled family may handle ${sensitivity} data${exclude.length ? ' besides the excluded ones' : ''}` };
    const av = availability(this.st.limits, fams, this.policy, this.now(), kind);
    if (!av.use.length) return { ok: false, wait: av.earliest_unblock, reason: av.blocked.map((b) => `${b.family}: ${b.reason}`).join('; '), blocked: av.blocked, external: av.blocked.some((b) => /^(auth|network|cli_missing)/.test(b.reason || '')) };
    const pools = this.poolsView(av);
    const ctx = { type, complexity, risk, sensitivity, onlyFamilies: av.use, pools, role, lens };
    let r = candidates(reg, ctx);
    if (!r.candidates.length) r = candidates(reg, { ...ctx, allowDowngrade: true });
    let cands = r.candidates.filter((c) => !c.needs_approval);
    if (override) { const o = cands.find((c) => c.model === override.model) || null; if (o) cands = [o, ...cands.filter((c) => c !== o)]; }
    if (!cands.length) return { ok: false, permanent: !av.blocked.length, wait: av.earliest_unblock, reason: 'no eligible model for this task under the current limits and privacy rules' };
    return { ok: true, ...cands[0], soft: av.soft.includes(cands[0].family), alternatives: cands.slice(1, 3).map((c) => c.model) };
  }

  // ------------------------------------------------------------ planning
  async doPlan() {
    const c = this.contract;
    const hint = c.task_hint || {};
    await this.refreshLimits();
    const route = this.selectRoute({ type: 'plan', complexity: hint.complexity === 'S' ? 'M' : hint.complexity || 'M', risk: hint.risk || 'med', sensitivity: c.sensitivity, kind: 'reserved', lens: 'general' });
    if (!route.ok) return this.handleNoRoute(route, 'planning');
    const promptText = fs.existsSync(this.paths.prompt) ? fs.readFileSync(this.paths.prompt, 'utf8') : '';
    const prompt = plannerPrompt({ contract: c, promptText, rules: this.rules }) + (this.st.plan_feedback ? `\nYour previous plan was rejected: ${this.st.plan_feedback}. Fix exactly that.` : '');
    this.st.counters.plan_attempts += 1;
    this.save();
    const tick = await this.dispatch({ route, mode: 'plan', prompt, readonly: true, label: 'plan', task: null, sensitivity: c.sensitivity, agent: this.deps.reg.meta.subagent_for_type.plan });
    if (tick.handled) return;
    const raw = tick.final;
    const norm = raw ? this.normalizePlan(raw) : { errors: ['no final JSON block in the planner answer'], tasks: [] };
    if (norm.errors.length) {
      this.jr(`plan rejected (${norm.errors.join('; ')})`);
      if (this.st.counters.plan_attempts >= c.budgets.planning_attempts) return void this.finish('blocked', `the planner could not produce a valid plan: ${norm.errors[0]}`, { skipLoop: true });
      this.st.plan_feedback = norm.errors.join('; '); this.save();
      return;
    }
    this.st.tasks = norm.tasks;
    this.st.plan = { approach: String(raw.approach || '').slice(0, 800), risks: (raw.risks || []).slice(0, 8), by: `${route.family}/${route.model}` };
    writeFileAtomic(this.paths.plan, JSON.stringify({ approach: this.st.plan.approach, risks: this.st.plan.risks, tasks: norm.tasks.map(({ id, title, type, complexity, risk, deps, files, criteria, sensitivity }) => ({ id, title, type, complexity, risk, deps, files, criteria, sensitivity })) }, null, 2));
    this.cp('plan-written');
    for (const p of raw.parked_upfront || []) {
      const t = { id: `P${(this.st.tasks.filter((x) => x.id.startsWith('P')).length + 1)}`, title: String(p.title || 'parked item').slice(0, 120), type: 'research', complexity: 'S', risk: 'high', deps: [], files: [], criteria: [], sensitivity: 'none', status: 'pending', attempts: 0, failures: 0, decisions: [], active_ms: 0 };
      this.st.tasks.push(t);
      this.parkTask(t, `planner: ${p.reason || 'needs a forbidden or irreversible action'}`, { rollback: false });
    }
    for (const d of raw.decisions || []) await this.recordDecision(null, { ...d, source: 'plan' });
    this.st.phase = 'execute'; this.st.status = 'running'; this.st.plan_feedback = undefined;
    this.jr(`plan accepted: ${this.st.tasks.length} tasks (${this.st.tasks.filter((t) => t.status === 'parked').length} parked upfront)`);
    this.save();
  }

  normalizePlan(raw) {
    const errors = [];
    const list = Array.isArray(raw.tasks) ? raw.tasks.slice(0, 30) : [];
    if (!list.length) errors.push('the plan has no tasks');
    const ids = new Set();
    const reg = this.deps.reg;
    const critical = reg.meta.repo_rules?.critical_globs || [];
    const tasks = list.map((t, i) => {
      const id = String(t.id || `T${i + 1}`);
      if (ids.has(id)) errors.push(`duplicate task id ${id}`);
      ids.add(id);
      const type = TASK_TYPES.includes(t.type) ? t.type : 'implement';
      let risk = ['low', 'med', 'high'].includes(t.risk) ? t.risk : 'med';
      const files = Array.isArray(t.files) ? t.files.map(String) : [];
      if (critical.length && risk !== 'high' && matchGlobList(critical, files).length) risk = 'high';
      return { id, title: String(t.title || id).slice(0, 140), type, complexity: ['S', 'M', 'L'].includes(t.complexity) ? t.complexity : 'M', risk, deps: Array.isArray(t.deps) ? t.deps.map(String) : [], files, criteria: Array.isArray(t.criteria) ? t.criteria.map(String).slice(0, 8) : [], sensitivity: SENS.includes(t.sensitivity) ? t.sensitivity : 'none', status: 'pending', attempts: 0, failures: 0, decisions: [], active_ms: 0 };
    });
    for (const t of tasks) { t.deps = t.deps.filter((d) => ids.has(d) && d !== t.id); }
    // acyclic?
    const left = new Map(tasks.map((t) => [t.id, new Set(t.deps)]));
    for (let progressed = true; progressed && left.size;) { progressed = false; for (const [id, d] of [...left]) { if (![...d].some((x) => left.has(x))) { left.delete(id); progressed = true; } } }
    if (left.size) errors.push(`dependency cycle among ${[...left.keys()].join(', ')}`);
    return { errors, tasks };
  }

  // ------------------------------------------------------------ execution
  stepExecute() {
    const st = this.st;
    // dependents of parked tasks cannot run
    for (const t of st.tasks.filter((x) => x.status === 'pending')) {
      const bad = t.deps.map((d) => this.task(d)).find((d) => d && d.status === 'parked');
      if (bad) this.parkTask(t, `depends on parked task ${bad.id}`, { rollback: false });
    }
    const pending = st.tasks.filter((t) => t.status === 'pending');
    if (!pending.length) { st.phase = 'final'; this.save(); return null; }
    const eligible = pending.filter((t) => t.deps.every((d) => this.task(d)?.status === 'done'));
    if (!eligible.length) { for (const t of pending) this.parkTask(t, 'unresolvable dependencies', { rollback: false }); return null; }
    // an interrupted task comes first (its tree is the live one); others keep plan order
    eligible.sort((a, b) => (b.resume ? 1 : 0) - (a.resume ? 1 : 0));
    return this.workOn(eligible[0]);
  }

  async workOn(t) {
    await this.refreshLimits();
    const sens = this.taskSensitivity(t);
    const override = t.route_override || null;
    const resumeWaitMs = (this.contract.budgets.resume_wait_max_min || 360) * 60000;
    // a limit-interrupted task keeps waiting for its own family while the wait is a window, not a week
    const exclude = t.excluded_families || [];
    if (t.resume) {
      const fs_ = availability(this.st.limits, [t.resume.family], this.policy, this.now(), 'work');
      if (fs_.blocked.length && fs_.earliest_unblock - this.now() <= resumeWaitMs) {
        return this.waitUntil(fs_.earliest_unblock, `${t.resume.family} limit; ${t.id} resumes its session afterwards (${fs_.blocked[0].reason})`, 'limit');
      }
      if (fs_.blocked.length) { this.jr(`${t.id}: ${t.resume.family} is blocked for long; the task continues on another family from the preserved tree`); t.resume = null; this.st.events.reroutes += 1; }
    }
    const route = this.selectRoute({ type: t.type, complexity: t.complexity, risk: t.risk, sensitivity: sens, exclude, kind: 'work', override });
    if (!route.ok) return this.handleNoRoute(route, t.id, t);
    if (route.soft) this.jr(`${t.id}: soft limit on the preferred family; routed to ${route.family}/${route.model}`);
    if (this.st.limits[this.deps.reg.meta.main_family] && route.family !== this.deps.reg.meta.main_family) limitLog(this.paths, `ROUTED task=${t.id} to ${route.family} while ${this.deps.reg.meta.main_family} is soft/blocked`, new Date(this.now()));
    if (t.last_family && t.last_family !== route.family) { this.st.events.reroutes += 1; limitLog(this.paths, `REROUTE task=${t.id} ${t.last_family} -> ${route.family} (limits/privacy)`, new Date(this.now())); this.jr(`${t.id}: rerouted ${t.last_family} -> ${route.family} (limits/privacy)`); }
    t.last_family = route.family;
    if (t.risk === 'high' || t.critical) {
      const g = egmGate({ critical: true, setting: this.rules?.egm || 'ask', contract: this.contract });
      this.jr(`${t.id}: egm_gate -> ${g.action}${g.consent === false ? ' (no pre-consent in the contract: continuing without EGM)' : ''}`);
    }
    const base = this.git(this.wt, ['rev-parse', 'HEAD']).out;
    if (t.status !== 'running') { t.status = 'running'; t.base_sha = t.resume ? t.base_sha || base : base; }
    t.base_sha ||= base;
    const resuming = !!(t.resume && t.resume.family === route.family);
    const sessionId = resuming ? t.resume.session_id : uuid();
    const failure = t.failure_evidence || null;
    const forced = t.decisions.filter((d) => d.outcome === 'decided').map((d) => ({ question: d.question, chosen: d.chosen, chosen_label: (d.options.find((o) => o.id === d.chosen) || {}).label }));
    const prompt = resuming
      ? `The previous run was interrupted (${t.resume.reason}); your edits are still in the working tree. Check \`git status\` and \`git diff\`, finish the task, and end with the final JSON block as before.${failure ? `\nKnown failure evidence:\n${failure}` : ''}`
      : taskPrompt({ contract: this.contract, task: t, decisions: forced, failure, resumeNote: t.resume || (t.attempts && !failure) ? 'Partial work from an earlier attempt may be in the working tree: inspect `git status`/`git diff` first and continue from it.' : null, rules: this.rules });
    this.st.inflight = { task: t.id, kind: 'work', family: route.family, model: route.model, effort: route.effort, session_id: sessionId, phase: 'dispatched', base_sha: t.base_sha, attempt: t.attempts + 1, started_at: this.now(), pid: null };
    this.st.counters.dispatches += 1;
    this.save();
    this.cp('work-dispatching');
    const t0 = this.now();
    const tick = await this.dispatch({ route, mode: t.type === 'research' ? 'research' : 'implement', prompt, readonly: t.type === 'research', label: t.id, task: t, sessionId, resume: resuming, sensitivity: sens, agent: this.deps.reg.meta.subagent_for_type[t.type] });
    t.active_ms = (t.active_ms || 0) + Math.max(0, this.now() - t0);
    this.cp('work-returned');
    if (tick.handled) return;
    if (resuming && ['error', 'crash'].includes(tick.kind) && !t.resume_failed) {
      // the saved session could not be resumed (gone, or never created): once, retry fresh on the preserved tree, no attempt spent
      t.resume_failed = true; t.resume = null; t.status = 'pending'; this.st.inflight = null;
      this.jr(`${t.id}: the worker session could not be resumed (${String(tick.error || tick.kind).slice(0, 80)}); continuing with a fresh session on the same tree`);
      this.save();
      return;
    }
    t.resume = null;
    if (tick.kind !== 'ok') { await this.failTask(t, route, tick.kind, `${tick.kind}: ${tick.note || tick.error || String(tick.text || '').slice(0, 300)}`, sens); return; }
    await this.afterWork(t, route, tick, sens);
  }

  // Common dispatch + failure classification for every worker call. -> tick with `handled: true` when the caller must return.
  async dispatch({ route, mode, prompt, readonly, label, task, sessionId = uuid(), resume = false, sensitivity, agent = null }) {
    const ctl = new AbortController();
    const stopWatch = this.watchControls(ctl);
    const inf = this.st.inflight;
    const onActivity = () => {};
    let tick;
    try {
      if (route.invoke === 'claude-agent') {
        const system = `${SYSTEM_RULES}\n\n${agent ? readAgentBody(agent) : ''}`;
        tick = await this.deps.runClaude({ cwd: this.wt, model: route.call_as, effort: route.effort, sessionId, resume, prompt, perms: this.perms, readonly, system, runDir: this.paths.dir, label, timeoutMs: this.contract.budgets.tick_timeout_min * 60000, idleMs: this.contract.budgets.idle_timeout_min * 60000, signal: ctl.signal, onActivity, onSpawn: (pid) => { if (inf) { inf.pid = pid; } } });
      } else {
        const promptFile = path.join(this.paths.tasks, `${label}-${this.st.counters.dispatches}.md`);
        writeFileAtomic(promptFile, prompt);
        tick = await this.deps.runAdapter({ family: route.family, model: route.call_as, effort: route.effort, mode: readonly ? 'research' : 'implement', promptFile, cwd: this.wt, sensitivity, files: task?.files || [], allowCmds: this.perms.commands, taskType: task?.type || (mode === 'review' ? 'review' : 'plan'), complexity: task?.complexity || 'M', risk: task?.risk || 'med', timeoutS: this.contract.budgets.tick_timeout_min * 60, signal: ctl.signal });
      }
    } finally { stopWatch(); }
    this.recordTick(route.family, tick);
    if (tick.denials?.length) this.jr(`${label}: ${tick.denials.length} tool call(s) denied by the allowlist (e.g. ${tick.denials.slice(0, 3).map((x) => String(x).slice(0, 80)).join(' ; ')})`);
    if (inf) inf.pid = null;
    const ctrl = readControl(this.paths);
    if (tick.kind === 'aborted' || ctl.signal.aborted || ctrl.abort || ctrl.takeover) {
      if (task) { await this.interruptTask(task, route, tick, ctrl.abort ? 'abort' : 'takeover'); this.st.inflight = null; this.save(); }
      return { ...tick, handled: true, aborted: true };
    }
    switch (tick.kind) {
      case 'ok': return tick;
      case 'limit': await this.onLimit(route, tick, task); return { ...tick, handled: true };
      case 'network': this.markResume(task, route, tick, 'network'); await this.waitExternal('network unreachable', () => this.deps.netCheck()); return { ...tick, handled: true };
      case 'overloaded': this.markResume(task, route, tick, 'overloaded'); await this.waitUntil(this.now() + 2 * 60000, `${route.family} overloaded; retrying`, 'external'); return { ...tick, handled: true };
      case 'auth':
      case 'missing':
        if (route.family === this.deps.reg.meta.main_family) { this.markResume(task, route, tick, tick.kind); await this.waitExternal(tick.kind === 'auth' ? 'Claude login required' : 'claude CLI missing', async () => (await this.deps.netCheck()) && (await this.deps.authCheck()).ok); return { ...tick, handled: true }; }
        recordBlock(this.st.limits, route.family, { reason: `${tick.kind}: fix the ${route.family} CLI login`, now: this.now(), schedule: [30, 60, 120, 360] });
        this.jr(`${route.family} unusable (${tick.kind}); rerouting around it`); this.st.events.reroutes += 1; this.save(); return { ...tick, handled: true };
      case 'privacy': case 'model': case 'approval':
        if (task) { task.excluded_families = [...new Set([...(task.excluded_families || []), route.family])]; task.status = 'pending'; this.jr(`${label}: ${route.family} refused the task (${tick.kind}); excluded for this task`); this.st.inflight = null; this.save(); }
        return { ...tick, handled: true };
      default: return tick; // hang | timeout | crash | error: the caller counts an attempt
    }
  }

  async onLimit(route, tick, task) {
    const f = route.family;
    const now = this.now();
    const until = tick.retry_at && tick.retry_at > now ? tick.retry_at : null;
    const entry = `LIMIT family=${f} scope=${tick.scope || 'unknown'} reset=${until ? new Date(until).toISOString() : 'unknown'} ${until ? (tick.estimated ? '(from error text, estimated)' : '(exact, from the CLI)') : '(unknown: probing with backoff)'}${tick.overage ? ' OVERAGE-REFUSED' : ''} task=${task?.id || '-'}`;
    limitLog(this.paths, entry, new Date(now));
    recordBlock(this.st.limits, f, { until, reason: `limit (${tick.scope || 'window'})`, now, margin_min: this.policy.safety_margin_min });
    if (tick.overage) this.st.limits[f].overage_seen = true;
    if (task) {
      // checkpoint: the partial edits stay in the tree; a snapshot ref is the insurance copy
      try { snapshotWorktree(this.git, this.wt, `refs/auto/${this.contract.id}/wip/${task.id}`, `wip ${task.id} (limit)`); } catch { /* snapshot is insurance only */ }
      this.markResume(task, route, tick, 'limit');
      this.jr(`${task.id}: limit hit mid-task; partial work kept in the tree and snapshotted; the session resumes after the reset`);
      this.st.inflight = null;
    }
    this.save();
    this.cp('limit-recorded');
  }

  // The task goes back to pending with its tree intact; the worker session is resumed when it was really created.
  markResume(task, route, tick, reason) {
    if (!task) return;
    task.status = 'pending';
    task.resume = tick.seen_session === false ? null : { session_id: tick.session_id || this.st.inflight?.session_id, family: route.family, model: route.model, effort: route.effort, reason, at: this.now() };
    this.save();
  }

  async interruptTask(t, route, tick, why) {
    try { snapshotWorktree(this.git, this.wt, `refs/auto/${this.contract.id}/wip/${t.id}`, `wip ${t.id} (${why})`); } catch { /* insurance */ }
    if (why === 'takeover') { t.status = 'pending'; t.resume = null; } else this.markResume(t, route, tick, why);
    this.jr(`${t.id}: worker ended cleanly for ${why}; partial work snapshotted`);
  }

  // No route right now: wait for the earliest unblock (or park the task when it can never run).
  async handleNoRoute(route, label, t = null) {
    if (route.permanent && t) { this.parkTask(t, route.reason); return; }
    if (route.permanent) return void this.finish('blocked', route.reason, { skipLoop: true });
    const until = route.wait && route.wait > this.now() ? route.wait : this.now() + 10 * 60000;
    this.jr(`${label}: nothing may run now (${route.reason}); sleeping`);
    await this.waitUntil(until, route.reason || 'all families blocked', route.external ? 'external' : 'limit');
  }

  // ------------------------------------------------------------ after a worker returned ok
  async afterWork(t, route, tick, sens) {
    const inf = this.st.inflight;
    const fin = tick.final || {};
    try { fs.mkdirSync(this.paths.tasks, { recursive: true }); fs.writeFileSync(path.join(this.paths.tasks, `${t.id}-final.json`), JSON.stringify(fin, null, 1)); } catch { /* debugging aid only */ }
    for (const d of Array.isArray(fin.decisions) ? fin.decisions : []) {
      // a worker entry without a question is not a decision (echo, empty object, stray note): ignore it instead of parking the task
      if (!d || typeof d.question !== 'string' || d.question.trim().length < 3) { this.jr(`${t.id}: ignored a malformed decision entry from the worker (no question)`); continue; }
      await this.recordDecision(t, { ...d, source: 'worker' });
    }
    const parkedByDecision = t.decisions.find((d) => d.outcome === 'parked' && !d.handled);
    if (parkedByDecision) { parkedByDecision.handled = true; this.parkTask(t, `decision needs a human: ${parkedByDecision.question} (${parkedByDecision.rule_reason})`); this.st.inflight = null; this.save(); return; }
    const redo = t.decisions.find((d) => d.rule === 'safest_minimal' && d.chosen !== d.worker_choice && !d.handled);
    if (redo && !t.redone_for_decisions) { redo.handled = true; t.redone_for_decisions = true; this.rollback(t); t.failure_evidence = null; t.status = 'pending'; this.st.inflight = null; this.jr(`${t.id}: an uncertain decision was settled to the safest option (${redo.chosen}); redoing the task with it`); this.save(); return; }
    if (fin.status === 'blocked' && !(await this.treeChanged())) { this.parkTask(t, `worker blocked: ${(fin.blockers || []).join('; ') || fin.summary || 'no reason given'}`); this.st.inflight = null; this.save(); return; }
    if (fin.status === 'partial') return this.failTask(t, route, 'incomplete work', `The worker reported status=partial: ${fin.summary || ''} ${(fin.blockers || []).join('; ')}`, sens);
    inf.phase = 'verifying'; this.save(); this.cp('verifying');
    // 1. diff guard (protected paths, dependencies, CI, secrets, mass deletes)
    const changed = await this.changedFiles();
    const g = guardDiff(changed, this.contract, { readOld: (p) => this.git(this.wt, ['show', `HEAD:${p}`], { allowFail: true }).out || null, readNew: (p) => { try { return fs.readFileSync(path.join(this.wt, p), 'utf8'); } catch { return null; } } }, { critical_globs: this.deps.reg.meta.repo_rules?.critical_globs || [] });
    if (!g.ok) {
      const why = g.violations.map((v) => `${v.file}: ${v.detail}`).join('; ');
      for (const v of g.violations) await this.recordDecision(t, { question: `Keep the change to ${v.file}?`, options: [{ id: 'revert', label: 'Revert the task and park it', safest: true, reversible: true }, { id: 'keep', label: `Keep (${v.rule})`, reversible: false }], chosen: 'keep', confidence: 0.2, reasoning: v.detail, reversibility: 'irreversible', category: v.category, files: [v.file], source: 'guard' });
      this.parkTask(t, `forbidden by the contract: ${why}`, { snapshot: true });
      this.st.inflight = null; this.save(); return;
    }
    // 2. checks, run by the supervisor
    const cmds = verifyCommands(this.contract);
    const checks = changed.length || t.type !== 'research' ? await this.deps.runChecks(cmds, this.wt) : { ok: true, results: [] };
    this.cp('checks-done');
    if (!checks.ok) {
      const red = checks.results.find((r) => r.code !== 0) || {};
      return this.failTask(t, route, 'verification', `Command: ${red.cmd}\nExit ${red.code}${red.timedOut ? ' (timed out)' : ''}\n${red.tail || ''}`.slice(0, 2500), sens);
    }
    // 3. cross-family review (risk-gated), with at most two fix rounds
    if (this.needsReview(t) && changed.length) {
      const verdict = await this.reviewTask(t, route, sens, changed);
      if (verdict === 'parked' || verdict === 'retry') { this.st.inflight = null; this.save(); return; }
    }
    // 4. checkpoint commit (a takeover/abort that arrived meanwhile wins: nothing is committed)
    const ctl = readControl(this.paths);
    if (ctl.abort || ctl.takeover) { await this.interruptTask(t, route, tick, ctl.abort ? 'abort' : 'takeover'); this.st.inflight = null; this.save(); return; }
    await this.commitCheckpoint(t, route, tick, checks);
  }

  needsReview(t) {
    if (!CODE_TYPES.includes(t.type)) return false;
    if (t.type === 'mechanical' && t.risk === 'low') return false;
    return !(t.risk === 'low' && t.complexity === 'S');
  }

  async treeChanged() { return (await this.changedFiles()).length > 0; }

  // [{path, status}] of the worktree against HEAD (tracked + untracked), parsed from `status --porcelain -z`.
  async changedFiles() {
    const raw = this.git(this.wt, ['status', '--porcelain=v1', '-z', '-uall']).out;
    const parts = raw.split('\0').filter(Boolean);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i].slice(0, 2);
      const p = parts[i].slice(3);
      if (code[0] === 'R' || code[1] === 'R') { i++; out.push({ path: p, status: 'R' }); continue; }
      out.push({ path: p, status: code.includes('D') ? 'D' : code.includes('?') || code.includes('A') ? 'A' : 'M' });
    }
    return out;
  }

  rollback(t) {
    this.git(this.wt, ['reset', '--hard', t.base_sha || this.st.checkpoint_sha]);
    this.git(this.wt, ['clean', '-fdq']);
  }

  async failTask(t, route, kind, evidence, sens) {
    t.attempts += 1; t.failures += 1;
    this.rollback(t);
    t.status = 'pending'; t.resume = null;
    this.st.inflight = null;
    const budget = this.contract.budgets.task_attempts;
    this.jr(`${t.id}: attempt ${t.attempts}/${budget} failed (${kind})`);
    if (t.attempts >= budget || (t.active_ms || 0) > this.contract.budgets.no_progress_min * 60000) {
      this.parkTask(t, `${kind} failed ${t.attempts}x${(t.active_ms || 0) > this.contract.budgets.no_progress_min * 60000 ? ' and no progress within the time budget' : ''}: ${String(evidence).split('\n').slice(0, 3).join(' | ').slice(0, 300)}`, { rollback: false, snapshot: false });
      this.save(); return;
    }
    t.failure_evidence = String(evidence).slice(0, 2500);
    // escalation ladder: effort +1 -> other primary family -> heavy tier; stop_and_report parks the task
    let esc;
    try { esc = escalate(this.deps.reg, { model: route.model, effort: route.effort, failures: t.failures, type: t.type, complexity: t.complexity, risk: t.risk, sensitivity: sens }); } catch { esc = { action: 'stop_and_report', reason: 'router error' }; }
    if (esc.action === 'stop_and_report') { this.parkTask(t, `escalation ladder exhausted: ${esc.reason}`, { rollback: false }); this.save(); return; }
    t.route_override = { model: esc.model, effort: esc.effort, family: esc.family };
    this.st.events.escalations = (this.st.events.escalations || 0) + 1;
    await this.recordDecision(t, { question: `Escalate ${t.id} after ${kind} failure ${t.failures}`, options: [{ id: esc.action, label: `${esc.action}: ${esc.model}/${esc.effort}`, reversible: true, safest: true }], chosen: esc.action, confidence: 0.9, reasoning: esc.reason, reversibility: 'reversible', source: 'engine', files: [] });
    this.save();
  }

  parkTask(t, reason, { rollback = true, snapshot = false } = {}) {
    if (snapshot) { try { snapshotWorktree(this.git, this.wt, `refs/auto/${this.contract.id}/parked/${t.id}`, `parked ${t.id}`); t.parked_ref = `refs/auto/${this.contract.id}/parked/${t.id}`; } catch { /* insurance */ } }
    if (rollback && t.base_sha) { try { this.rollback(t); } catch { /* best effort */ } }
    t.status = 'parked'; t.parked_reason = reason; t.resume = null;
    parkNote(this.paths, t, `${reason}${t.parked_ref ? `\n- inspect the rejected work: git -C "${this.wt}" diff ${t.base_sha}..${t.parked_ref}` : ''}`, new Date(this.now()));
    this.jr(`${t.id} parked: ${reason}`);
    this.flushDecisions(t, null);
    this.st.progress_at = this.now();
    this.save();
  }

  // ------------------------------------------------------------ review
  async reviewTask(t, route, sens, changed) {
    this.git(this.wt, ['add', '-A']);
    const diff = this.git(this.wt, ['diff', '--cached', 'HEAD']).out;
    const lenses = t.risk === 'high' ? ['general', 'security'] : ['general'];
    for (const lens of lenses) {
      for (let round = 1; round <= 2; round++) {
        const rv = await this.runReview({ label: `${t.id}-${lens}-r${round}`, task: t, authorFamily: route.family, sens, diff: round === 1 ? diff : this.git(this.wt, ['diff', '--cached', 'HEAD']).out, lens, checks: verifyCommands(this.contract).join(', ') });
        if (!rv) { t.review_deferred = [...(t.review_deferred || []), lens]; this.jr(`${t.id}: no cross-family reviewer available now (${lens}); deferred to the final review`); break; }
        const serious = (rv.findings || []).filter((f) => f.severity === 'high' || (f.severity === 'med' && f.confidence !== 'low'));
        const counts = { high: 0, med: 0, low: 0 };
        for (const f of rv.findings || []) counts[f.severity] = (counts[f.severity] || 0) + 1;
        this.st.reviews.push({ task: t.id, lens, round, by: rv.family, of: route.family, verdict: rv.verdict, ...counts, fixed: 0, rejected: 0 });
        this.save();
        if (!serious.length || rv.verdict === 'APPROVE') break;
        if (round === 2) {
          const high = serious.filter((f) => f.severity === 'high');
          if (high.length) { t.review_unresolved = high; this.parkTask(t, `review: ${high.length} high finding(s) unresolved after 2 fix rounds (${high[0].where}: ${String(high[0].scenario).slice(0, 120)})`, { snapshot: true }); return 'parked'; }
          t.review_unresolved = serious; break;
        }
        // fix round: back to the author (same session when the family matches)
        const evidence = serious.map((f) => `- ${f.where} (${f.severity}/${f.confidence}): ${f.scenario}`).join('\n');
        t.failure_evidence = evidence;
        const fixPrompt = `A cross-family review of your work found defects. Fix only these, keep the checks green, then give the final JSON again:\n${evidence}`;
        const r = await this.dispatch({ route, mode: 'implement', prompt: fixPrompt, readonly: false, label: `${t.id}-fix${round}`, task: t, sessionId: this.st.inflight?.session_id || uuid(), resume: route.invoke === 'claude-agent' && !!this.st.inflight?.session_id, sensitivity: sens });
        if (r.handled) return 'retry';
        if (r.kind !== 'ok') { t.review_unresolved = serious; break; }
        t.failure_evidence = null;
        this.st.reviews.at(-1).fixed = serious.length;
        const checks = await this.deps.runChecks(verifyCommands(this.contract), this.wt);
        if (!checks.ok) { await this.failTask(t, route, 'verification after review fix', checks.results.find((x) => x.code !== 0)?.tail || '', sens); return 'retry'; }
        this.git(this.wt, ['add', '-A']);
      }
    }
    return 'ok';
  }

  // One read-only review by a family different from the author's. -> {verdict, findings, family} | null when nobody may/can review now.
  async runReview({ label, task, authorFamily, sens, diff, lens, checks, wholeRun = false }) {
    const type = 'review';
    const prim = Object.entries(this.deps.reg.families).filter(([, f]) => f.enabled && f.role === 'primary').map(([id]) => id).filter((f) => f !== authorFamily);
    const sec = Object.entries(this.deps.reg.families).filter(([, f]) => f.enabled && f.role === 'secondary').map(([id]) => id);
    const only = lens === 'security' ? [...prim, ...sec] : prim;
    const route = this.selectRoute({ type, complexity: task?.complexity || 'M', risk: task?.risk || 'med', sensitivity: sens, exclude: [authorFamily], only: only.length ? only : ['__none__'], kind: 'reserved', role: 'reviewer', lens });
    if (!route.ok) return null;
    const capped = diff.length > 80000 ? `${diff.slice(0, 80000)}\n...[diff truncated: ${diff.length - 80000} more chars]` : diff;
    const prompt = reviewPrompt({ task: task || { title: 'the whole run' }, criteria: task?.criteria?.length ? task.criteria : this.contract.definition_of_done, diff: capped, checks, lens });
    this.st.counters.dispatches += 1;
    const tick = await this.dispatch({ route, mode: 'review', prompt, readonly: true, label, task: null, sensitivity: sens, agent: lens === 'security' ? this.deps.reg.meta.security_review_agent : this.deps.reg.meta.subagent_for_type.review });
    if (tick.handled || tick.kind !== 'ok') return null;
    const r = tick.final;
    if (!r) { this.jr(`${label}: the reviewer returned no parsable verdict; treated as no findings`); return { verdict: 'APPROVE', findings: [], family: route.family, unparsed: true }; }
    const findings = (Array.isArray(r.findings) ? r.findings : []).slice(0, 5).map((f) => ({ where: String(f.where || '?'), severity: ['high', 'med', 'low'].includes(f.severity) ? f.severity : 'low', confidence: ['high', 'med', 'low'].includes(f.confidence) ? f.confidence : 'med', scenario: String(f.scenario || '') }));
    return { verdict: ['APPROVE', 'FIX', 'BLOCK'].includes(r.verdict) ? r.verdict : findings.length ? 'FIX' : 'APPROVE', findings, family: route.family, wholeRun };
  }

  // ------------------------------------------------------------ checkpoint
  async commitCheckpoint(t, route, tick, checks) {
    const inf = this.st.inflight;
    inf.phase = 'committing'; this.save(); this.cp('before-commit');
    this.git(this.wt, ['add', '-A']);
    const staged = this.git(this.wt, ['diff', '--cached', '--quiet'], { allowFail: true });
    let sha = this.git(this.wt, ['rev-parse', 'HEAD']).out;
    if (!staged.ok) {
      const msg = `[auto] ${t.id}: ${t.title}\n\nRun: ${this.contract.id}\nChecks: ${verifyCommands(this.contract).join(' && ')} (passed)\nWorker: ${route.family}/${route.model}/${route.effort}`;
      let r = this.git(this.wt, ['commit', '-q', '-m', msg], { allowFail: true });
      if (!r.ok && /tell me who you are|empty ident|unable to auto-detect/i.test(r.err)) r = this.git(this.wt, ['-c', 'user.name=orchestrator-auto', '-c', 'user.email=auto@localhost', 'commit', '-q', '-m', msg], { allowFail: true });
      if (!r.ok && this.contract.checkpoints.hooks === 'bypass_on_failure') {
        r = this.git(this.wt, ['-c', 'user.name=orchestrator-auto', '-c', 'user.email=auto@localhost', 'commit', '-q', '--no-verify', '-m', msg], { allowFail: true });
        if (r.ok) await this.recordDecision(t, { question: 'A commit hook rejected the checkpoint commit: bypass it on the auto branch?', options: [{ id: 'bypass', label: 'Commit with --no-verify on the auto branch', reversible: true, safest: true }], chosen: 'bypass', confidence: 0.8, reasoning: 'checkpoint commits are private to auto/*; the supervisor already ran the verify commands', reversibility: 'reversible', source: 'engine', files: [] });
      }
      if (!r.ok) return this.failTask(t, route, 'checkpoint commit', r.err, this.taskSensitivity(t));
      sha = this.git(this.wt, ['rev-parse', 'HEAD']).out;
    }
    this.cp('after-commit');
    if (!staged.ok) t.checkpoint = { files: this.git(this.wt, ['diff', '--name-only', `${inf.base_sha}..${sha}`], { allowFail: true }).out.split(/\r?\n/).filter(Boolean).slice(0, 60) };
    this.completeTask(t, sha, inf, staged.ok);
  }

  completeTask(t, sha, inf, noChange = false) {
    const tag = `auto/${this.contract.id}/${t.id}`;
    if (!noChange) this.git(this.wt, ['tag', '-f', tag, sha], { allowFail: true });
    t.status = 'done'; t.checkpoint = { ...(t.checkpoint || {}), sha, tag: noChange ? null : tag, at: new Date(this.now()).toISOString(), no_change: noChange || undefined };
    t.worker = inf ? { family: inf.family, model: inf.model, effort: inf.effort } : t.worker;
    t.resume = null; t.failure_evidence = null; t.route_override = null;
    this.flushDecisions(t, noChange ? null : sha);
    this.st.checkpoint_sha = sha;
    this.st.inflight = null;
    this.st.progress_at = this.now();
    this.jr(`${t.id} done${noChange ? ' (no file changes)' : ` -> ${sha.slice(0, 8)}`}`);
    this.save();
    this.cp('task-saved');
  }

  // ------------------------------------------------------------ decisions
  async recordDecision(t, d) {
    const sens = maxSens(this.contract.sensitivity, t?.sensitivity || 'none');
    const resolved = await resolveDecision({ ...d, worker_choice: d.chosen }, {
      contract: this.contract,
      secondOpinion: (q, options) => this.secondOpinion(q, options, t, sens),
    });
    const rec = { id: this.nextDecisionId(), time: new Date(this.now()).toISOString(), task: t?.id || null, ...resolved, worker_choice: d.chosen ?? null, files: d.files || [] };
    if (t) t.decisions.push(rec); else { this.flushRecord(rec, null, 'planning-level choice; change the affected task description and re-run it'); }
    this.save();
    return rec;
  }

  flushRecord(rec, sha, undoNote) {
    const ids = new Set(readJsonl(this.paths.decisions).map((r) => r.id));
    if (ids.has(rec.id)) return;
    const { handled, ...clean } = rec;
    void handled;
    appendJsonl(this.paths.decisions, { ...clean, sha: sha || null, undo: undoCommand(this.wt, sha), undo_note: sha ? undefined : (undoNote || 'no committed change to revert') });
  }

  flushDecisions(t, sha) {
    for (const rec of t.decisions) this.flushRecord(rec, rec.outcome === 'decided' ? sha : null, rec.outcome === 'parked' ? 'task parked and rolled back: nothing to revert' : undefined);
  }

  // Independent opinion from a DIFFERENT family with zero repo context; null when privacy/limits leave nobody.
  async secondOpinion(question, options, t, sens) {
    const author = t?.last_family || this.deps.reg.meta.main_family;
    const route = this.selectRoute({ type: 'review', complexity: 'S', risk: 'med', sensitivity: sens, exclude: [author], kind: 'reserved', role: 'reviewer' });
    if (!route.ok) return { available: false };
    const prompt = secondOpinionPrompt({ question, options });
    const dir = path.join(this.paths.tasks, 'second-opinion');
    fs.mkdirSync(dir, { recursive: true });
    const tick = route.invoke === 'claude-agent'
      ? await this.deps.runClaude({ cwd: dir, model: route.call_as, effort: 'low', sessionId: uuid(), resume: false, prompt, perms: { ...this.perms, readonly: { ...this.perms.readonly, tools: [] } }, readonly: true, tools: [], system: SYSTEM_RULES, runDir: this.paths.dir, label: 'second-opinion', timeoutMs: 10 * 60000, idleMs: 5 * 60000 })
      : await this.deps.runAdapter({ family: route.family, model: route.call_as, effort: route.effort, mode: 'research', promptFile: this.writePrompt('second-opinion', prompt), cwd: dir, sensitivity: sens, files: [], allowCmds: [], taskType: 'review', complexity: 'S', risk: 'med', timeoutS: 600 });
    this.recordTick(route.family, tick);
    if (tick.kind === 'limit') { recordBlock(this.st.limits, route.family, { until: tick.retry_at, reason: 'limit', now: this.now(), margin_min: this.policy.safety_margin_min }); return { available: false }; }
    if (tick.kind !== 'ok' || !tick.final?.choice) return { available: false };
    return { available: true, choice: String(tick.final.choice), confidence: tick.final.confidence, reasoning: tick.final.reasoning, family: route.family };
  }

  writePrompt(label, text) {
    const f = path.join(this.paths.tasks, `${label}-${this.st.counters.dispatches}.md`);
    writeFileAtomic(f, text);
    return f;
  }

  // ------------------------------------------------------------ final phase
  async doFinal() {
    const st = this.st;
    const cmds = verifyCommands(this.contract);
    st.final ||= {};
    // 1. the full verify run on the checkpointed tree
    if (!st.final.checks_done) {
      const checks = await this.deps.runChecks(cmds, this.wt);
      this.cp('final-checks');
      if (!checks.ok && st.counters.final_repairs < 2 && st.tasks.some((t) => t.status === 'done')) {
        st.counters.final_repairs += 1;
        const red = checks.results.find((r) => r.code !== 0) || {};
        const id = `FIX${st.counters.final_repairs}`;
        st.tasks.push({ id, title: 'Make the full check run green again', type: 'debug', complexity: 'M', risk: 'med', deps: [], files: [], criteria: ['all verify commands pass on the whole tree'], sensitivity: 'none', status: 'pending', attempts: 0, failures: 0, decisions: [], active_ms: 0, failure_evidence: `Command: ${red.cmd}\n${red.tail}` });
        st.phase = 'execute'; this.jr('final checks failed: a repair task was added'); this.save();
        return null;
      }
      st.final.checks_done = true; st.final.checks_ok = checks.ok; st.final.checks = checks.results.map((r) => ({ cmd: r.cmd, code: r.code }));
      this.save();
    }
    // 2. whole-diff review by another family (low trust), + security lens when the risk is high
    const sens = maxSens(this.contract.sensitivity, ...st.tasks.map((t) => this.taskSensitivity(t)));
    const authors = [...new Set(st.tasks.filter((t) => t.worker).map((t) => t.worker.family))];
    const authorFamily = authors.length === 1 ? authors[0] : (authors.sort((a, b) => st.tasks.filter((t) => t.worker?.family === b).length - st.tasks.filter((t) => t.worker?.family === a).length)[0] || this.deps.reg.meta.main_family);
    const anyChange = st.tasks.some((t) => t.status === 'done' && t.checkpoint && !t.checkpoint.no_change);
    const needSecurity = st.tasks.some((t) => t.risk === 'high' && t.status === 'done');
    const lenses = anyChange ? ['general', ...(needSecurity ? ['security'] : [])] : [];
    for (const lens of lenses) {
      const key = `review_${lens}`;
      if (st.final[key]) continue;
      const diff = this.git(this.wt, ['diff', `${st.base_sha}..HEAD`]).out || '';
      const stat = this.git(this.wt, ['diff', '--stat', `${st.base_sha}..HEAD`]).out;
      const rv = await this.runReview({ label: `final-${lens}`, task: null, authorFamily, sens, diff: `${stat}\n\n${diff}`, lens, checks: cmds.join(', '), wholeRun: true });
      this.cp(`final-review-${lens}`);
      if (!rv) {
        const waitRoute = this.selectRoute({ type: 'review', complexity: 'M', risk: 'med', sensitivity: sens, exclude: [authorFamily], kind: 'reserved', role: 'reviewer', lens });
        if (!waitRoute.ok && waitRoute.wait && !waitRoute.permanent) { await this.waitUntil(waitRoute.wait, `final ${lens} review: ${waitRoute.reason}`, 'limit'); return null; }
        st.final[key] = { skipped: true, reason: waitRoute.ok ? 'reviewer run did not complete' : (waitRoute.reason || 'no other family may or can review') };
        this.jr(`final ${lens} review skipped: ${st.final[key].reason}`); this.save();
        continue;
      }
      const counts = { high: 0, med: 0, low: 0 };
      for (const f of rv.findings) counts[f.severity] += 1;
      st.final[key] = { by: rv.family, verdict: rv.verdict, findings: rv.findings, ...counts };
      st.reviews.push({ task: '*', lens, round: 1, by: rv.family, of: authorFamily, verdict: rv.verdict, ...counts, fixed: 0, rejected: 0 });
      this.save();
      const serious = rv.findings.filter((f) => f.severity === 'high');
      if (serious.length && !st.final[`${key}_fix`]) {
        st.final[`${key}_fix`] = true;
        st.tasks.push({ id: `RF-${lens}`, title: `Fix high-severity findings from the final ${lens} review`, type: 'debug', complexity: 'M', risk: 'med', deps: [], files: [], criteria: serious.map((f) => `${f.where}: ${f.scenario}`), sensitivity: 'none', status: 'pending', attempts: 0, failures: 0, decisions: [], active_ms: 0, failure_evidence: serious.map((f) => `- ${f.where}: ${f.scenario}`).join('\n') });
        st.final.checks_done = false;
        st.phase = 'execute'; this.save();
        return null;
      }
    }
    // 3. done
    const parked = st.tasks.filter((t) => t.status === 'parked').length;
    const unresolved = Object.values(st.final).some((r) => r?.findings?.some((f) => f.severity === 'high'));
    const redChecks = st.final.checks_ok === false;
    return this.finish(parked || unresolved || redChecks ? 'blocked' : 'completed', parked ? `${parked} task(s) parked` : redChecks ? 'final checks are red' : unresolved ? 'unresolved high findings' : 'all tasks done');
  }

  // ------------------------------------------------------------ endings
  finish(status, reason, { skipLoop = false } = {}) {
    void skipLoop;
    const st = this.st;
    st.phase = 'done'; st.status = status; st.exit_reason = reason; st.finished_at = new Date(this.now()).toISOString();
    this.save();
    try { writeFileAtomic(this.paths.report, buildReport(this.paths, { final: true, now: this.now() })); } catch (e) { this.jr(`report generation failed: ${e.message}`); }
    clearActive(this.contract.repo, this.contract.id);
    this.jr(`finished: ${status} (${reason})`);
    this.deps.notify?.(status === 'completed' ? 'done' : 'blocked', st);
    return { status, reason };
  }

  abortRun() {
    const st = this.st;
    const inf = st.inflight;
    if (inf) { const t = this.task(inf.task); if (t) { try { snapshotWorktree(this.git, this.wt, `refs/auto/${this.contract.id}/wip/${t.id}`, `wip ${t.id} (abort)`); } catch { /* insurance */ } t.status = 'pending'; } st.inflight = null; }
    st.status = 'aborted'; st.phase = 'done'; st.exit_reason = 'ABORT'; st.finished_at = new Date(this.now()).toISOString();
    this.save();
    try { writeFileAtomic(this.paths.report, buildReport(this.paths, { final: true, now: this.now() })); } catch { /* report is best effort here */ }
    clearActive(this.contract.repo, this.contract.id);
    setControl(this.paths, 'ABORT', false);
    this.jr('ABORT: ended immediately; the tree and all checkpoints are untouched');
    this.deps.notify?.('aborted', st);
    return { status: 'aborted', reason: 'ABORT' };
  }

  // Hand over to the interactive orchestrator: clean tree at the last checkpoint, compact ledger, no loose workers.
  takeover() {
    const st = this.st;
    const inf = st.inflight;
    if (inf) { const t = this.task(inf.task); if (t) { try { snapshotWorktree(this.git, this.wt, `refs/auto/${this.contract.id}/wip/${t.id}`, `wip ${t.id} (takeover)`); } catch { /* insurance */ } t.status = 'pending'; t.resume = null; t.note = 'interrupted by takeover; partial work snapshotted in refs/auto/*/wip'; } st.inflight = null; }
    this.git(this.wt, ['reset', '--hard', st.checkpoint_sha]);
    this.git(this.wt, ['clean', '-fdq']);
    st.status = 'handed_over'; st.mode = 'interactive'; st.exit_reason = 'takeover'; st.finished_at = new Date(this.now()).toISOString();
    this.save();
    writeFileAtomic(this.paths.handoff, buildHandoff(this.paths, { now: this.now() }));
    clearActive(this.contract.repo, this.contract.id);
    setControl(this.paths, 'TAKEOVER', false);
    this.jr('TAKEOVER: handed over at the last checkpoint; see handoff.md');
    this.deps.notify?.('handed_over', st);
    return { status: 'handed_over', reason: 'takeover' };
  }
}


export { readContract, runPaths, AUTO_ROOT, feedFromPool, extractFinalJson };
