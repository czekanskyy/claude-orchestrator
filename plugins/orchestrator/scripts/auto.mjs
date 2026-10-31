#!/usr/bin/env node
// Backend of /orchestrator:auto. The interactive parts (start contract interview, GO, morning review) live in the
// skill; this script does the deterministic work and prints JSON (or the Polish report/status text).
//   prepare [--repo DIR]                      facts for the contract interview: repo state, profile defaults, config defaults
//   draft --answers F [--prompt-file P] [--repo DIR]   validate answers into contract.yaml + permission allowlist + feasibility
//   preflight --run ID [--skip-doctor]        clean tree, worktree support, one live Claude probe (exact usage), doctor --live
//   start --run ID --go --hash H              explicit GO: worktree + branch, state, detached supervisor. Nothing starts without --go
//   status | report [--run ID]                read-only text (never interrupts, never changes the mode)
//   pause | continue | stop | abort | takeover [--run ID]   kill switch and mode control (files the supervisor polls)
//   review list|revert|done [--run ID]        morning review on the auto/* branch only
//   merge --run ID --into BRANCH --yes        merge the auto branch (only on the user's explicit yes)
//   cleanup --run ID --yes | list
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, out, fail, loadRegistry, repoRoot, readJson, ensureDir, PLUGIN_DIR, runProcess, enabledFamilies, snapshotFile } from './lib/common.mjs';
import { readConfig } from './lib/config.mjs';
import { readRepoProfile, rulesFrom } from './lib/repo-profile.mjs';
import {
  AUTO_ROOT, runPaths, runDirOf, newAutoId, loadState, saveState, setControl, readControl, supervisorAlive, registerActive, clearActive, autoRunFor,
  BLOCKING, FINISHED, createGit, writeFileAtomic, journal, appendJsonl, readJsonl, uuid,
} from './lib/auto-core.mjs';
import { commitPolicyIssue, defaultContract, validateContract, writeContract, readContract, buildPermissions, permissionsSummary, estimateFeasibility, verifyCommands } from './lib/auto-contract.mjs';
import { recordWindows, normPolicy, DEFAULT_LIMITS } from './lib/auto-limits.mjs';
import { AutoEngine, makeInitialState } from './lib/auto-engine.mjs';
import { buildReport, buildStatus } from './lib/auto-report.mjs';
import { runClaudeTick, runChecks, claudeBin } from './lib/auto-worker.mjs';
import { keepAwakeCapability } from './lib/auto-system.mjs';

const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'auto-supervisor.mjs');
const NOW = () => Date.now();
const g = (cwd, args, o = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, ...o });

// ---------------------------------------------------------------- helpers
function resolveRun(a) {
  if (a.run) { const dir = fs.existsSync(a.run) ? path.resolve(a.run) : runDirOf(a.run); return fs.existsSync(dir) ? runPaths(dir) : null; }
  const repo = repoRoot(a.repo || process.cwd());
  const r = autoRunFor(repo);
  if (r.run_id) return runPaths(r.dir);
  let ids = [];
  try { ids = fs.readdirSync(AUTO_ROOT).filter((n) => n !== 'active' && fs.existsSync(path.join(AUTO_ROOT, n, 'state.json'))).sort().reverse(); } catch { /* none */ }
  return ids.length && !repo ? runPaths(runDirOf(ids[0])) : null;
}

function claudeSnapshot(reg) {
  const pool = reg.families[reg.meta.main_family]?.pool;
  const snap = pool ? readJson(snapshotFile(pool), null) : null;
  if (!snap || Date.now() - Date.parse(snap.updated_at) > 6 * 3600000) return null;
  const w = (x) => (x && typeof x.used_percentage === 'number' && (!x.resets_at || x.resets_at * 1000 > Date.now()) ? { pct: x.used_percentage, resets_at: x.resets_at ? x.resets_at * 1000 : null } : null);
  return { five_hour: w(snap.rate_limits?.five_hour), seven_day: w(snap.rate_limits?.seven_day), source: `statusline snapshot ${snap.updated_at}` };
}

const profileRules = (repo) => { try { return rulesFrom(readRepoProfile(repo, {}).profile); } catch { return null; } };

function suggestedVerify(rules) {
  const v = rules?.verify || {};
  return { test: v.test || null, typecheck: v.typecheck || null, lint: v.lint || null, build: v.build || null, extra: v.extra || [] };
}

function linkCandidates(repo) {
  return ['node_modules', '.venv', 'vendor'].filter((d) => fs.existsSync(path.join(repo, d)) && g(repo, ['check-ignore', '-q', d]).status === 0);
}

// ---------------------------------------------------------------- prepare
function prepare(a) {
  const repo = repoRoot(a.repo || process.cwd());
  if (!repo) return fail('not inside a git repo');
  const reg = loadRegistry();
  const rules = profileRules(repo);
  const status = g(repo, ['status', '--porcelain']).stdout.split('\n').filter(Boolean);
  const tracked = status.filter((l) => !l.startsWith('??'));
  const cfg = readConfig().config?.auto || {};
  const privacy = Object.fromEntries(enabledFamilies(reg).map((f) => [f, { sensitive_ok: reg.families[f].data_policy.sensitive_ok, plan: reg.pools[reg.families[f].pool]?.plan }]));
  const existing = autoRunFor(repo);
  return out({
    ok: true, repo, branch: g(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), base_sha: g(repo, ['rev-parse', 'HEAD']).stdout.trim(),
    tree: { clean: tracked.length === 0, tracked_changes: tracked.slice(0, 10), untracked: status.length - tracked.length },
    existing_run: existing, blocked_by_run: existing.state === 'active' ? existing : null,
    profile: { present: !!rules, commit_policy: rules?.commit?.policy || null, commit_format: rules?.commit?.format || null, critical_paths: rules?.critical_globs || [], sensitivity_default: rules?.sensitivity?.default || null, egm: rules?.egm || null, docs_duties: rules?.docs_duties || [] },
    defaults: { verify: suggestedVerify(rules), limits: { ...DEFAULT_LIMITS, ...(cfg.limits || {}) }, notify: { channel: cfg.notify?.channel || 'file', command: cfg.notify?.command || null }, link_dirs: linkCandidates(repo), sensitivity: reg.meta.default_sensitivity || 'internal' },
    needs_commit_override: !!rules && ['forbidden', 'ask'].includes(rules.commit.policy),
    privacy, families: enabledFamilies(reg), main_family: reg.meta.main_family, keep_awake: keepAwakeCapability(), claude_snapshot: claudeSnapshot(reg),
    notify_channels: { os: process.platform, file: true, command: 'any shell command; receives the generic text in ORCH_NOTIFY_TEXT' },
  });
}

// ---------------------------------------------------------------- draft
function draft(a) {
  const repo = repoRoot(a.repo || process.cwd());
  if (!repo) return fail('not inside a git repo');
  const reg = loadRegistry();
  const rules = profileRules(repo);
  let answers;
  try { answers = JSON.parse(fs.readFileSync(a.answers, 'utf8')); } catch (e) { return fail(`answers are not valid JSON: ${e.message}`); }
  const existing = autoRunFor(repo);
  if (existing.state === 'active') return fail(`another autonomous run owns this repo: ${existing.run_id} (${existing.status}). Use /orchestrator:auto status|continue|stop|takeover|abort first.`, { run: existing });
  const cfg = readConfig().config?.auto || {};
  const id = newAutoId(answers.slug || 'run');
  const c = defaultContract({
    id, created: new Date().toISOString(), repo, base_branch: g(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), base_sha: g(repo, ['rev-parse', 'HEAD']).stdout.trim(), branch: `auto/${id}`,
    limits: { ...DEFAULT_LIMITS, ...(cfg.limits || {}) }, notify: { channel: cfg.notify?.channel || 'file', command: cfg.notify?.command || null, wait_min: 120 },
    verify: suggestedVerify(rules),
  });
  const merge = (base, over) => { for (const [k, v] of Object.entries(over || {})) { if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') merge(base[k], v); else if (v !== undefined) base[k] = v; } return base; };
  const { slug, ...rest } = answers; void slug;
  merge(c, rest);
  const commitIssue = commitPolicyIssue(rules, c);
  if (commitIssue) return fail(commitIssue, { needs: 'checkpoints.profile_override' });
  const v = validateContract(c);
  if (!v.ok) return fail('contract is not valid', { errors: v.errors, warnings: v.warnings });
  const dir = runDirOf(id);
  const paths = runPaths(dir);
  ensureDir(dir);
  writeContract(paths.contract, c);
  if (a['prompt-file'] && fs.existsSync(a['prompt-file'])) fs.copyFileSync(a['prompt-file'], paths.prompt);
  const perms = buildPermissions(c, { rules, sensitiveGlobs: reg.meta.sensitive_globs || [], criticalGlobs: rules?.critical_globs || [] });
  writeFileAtomic(paths.permissions, JSON.stringify(perms, null, 2));
  const snap = claudeSnapshot(reg);
  const feas = estimateFeasibility(reg, c, snap ? { [reg.meta.main_family]: snap } : {});
  journal(paths, 'draft contract written (not started)');
  return out({ ok: true, run_id: id, dir, contract: c, warnings: v.warnings, permissions: { summary: permissionsSummary(perms), hash: perms.hash, allow: perms.allow, deny: perms.deny }, feasibility: feas, next: 'show the allowlist and feasibility, run `preflight`, then ask for GO' });
}

// ---------------------------------------------------------------- preflight
async function preflight(a) {
  const paths = resolveRun(a);
  if (!paths || !fs.existsSync(paths.contract)) return fail('--run <id> of a drafted contract is required');
  const c = readContract(paths.contract);
  const reg = loadRegistry();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const tracked = g(c.repo, ['status', '--porcelain']).stdout.split('\n').filter((l) => l && !l.startsWith('??'));
  add('clean tree', tracked.length === 0, tracked.length ? `${tracked.length} uncommitted tracked change(s): commit or stash them first (the worktree starts from HEAD)` : 'no uncommitted tracked changes');
  const head = g(c.repo, ['rev-parse', 'HEAD']).stdout.trim();
  add('base unchanged', head === c.base_sha, head === c.base_sha ? c.base_sha.slice(0, 8) : `HEAD moved since the draft (${c.base_sha.slice(0, 8)} -> ${head.slice(0, 8)}): re-draft`);
  const wtOk = g(c.repo, ['worktree', 'list']).status === 0;
  add('git worktree', wtOk, wtOk ? 'supported' : 'git worktree failed');
  add('branch free', g(c.repo, ['rev-parse', '--verify', '-q', c.branch]).status !== 0, c.branch);
  add('claude CLI', !!claudeBin(), claudeBin() || 'not found on PATH');
  const cap = keepAwakeCapability();
  add('keep awake', cap.ok, `${cap.method || cap.note}${cap.ok ? `; caveat: ${cap.note}` : ''}`);
  // one cheap headless call: proves login + headless mode and returns exact 5h/7d usage (rate_limit_event)
  let limits = {};
  let probe = null;
  if (claudeBin()) {
    const perms = readJson(paths.permissions);
    probe = await runClaudeTick({ cwd: os.tmpdir(), model: 'haiku', effort: 'low', sessionId: uuid(), resume: false, prompt: 'Reply with exactly: OK', perms, readonly: true, tools: [], system: 'Reply with exactly what is asked.', runDir: paths.dir, label: 'probe', timeoutMs: 180000, idleMs: 120000 });
    add('claude headless probe', probe.kind === 'ok', probe.kind === 'ok' ? `answered; ${probe.usage.total} tokens` : `${probe.kind}${probe.error ? `: ${String(probe.error).slice(0, 120)}` : ''}${probe.kind === 'limit' ? ' (limit already reached: the run would start by waiting)' : ''}`);
    if (probe.windows?.windows) recordWindows(limits, reg.meta.main_family, probe.windows.windows, NOW(), 'exact');
    if (probe.windows?.overage?.status && probe.windows.overage.status !== 'rejected') add('overage', false, `account reports overage status "${probe.windows.overage.status}": the run refuses to use it, but check your billing settings`);
  }
  let doctor = null;
  if (!a['skip-doctor']) {
    const r = await runProcess(process.execPath, [path.join(PLUGIN_DIR, 'scripts', 'doctor.mjs'), '--live', '--json', '--claude-live', probe?.kind === 'ok' ? 'ok' : 'fail:headless probe failed'], { timeoutMs: 15 * 60000 });
    try { doctor = JSON.parse(r.stdout); } catch { doctor = null; }
    add('doctor --live', !!doctor && !doctor.counts?.fail, doctor ? `${doctor.counts?.ok || 0} ok · ${doctor.counts?.warn || 0} warn · ${doctor.counts?.fail || 0} fail (≈${doctor.tokens?.total || 0} tokens)` : 'doctor output unreadable');
  }
  const feas = estimateFeasibility(reg, c, { [reg.meta.main_family]: { ...(limits[reg.meta.main_family] || {}), source: 'rate_limit_event (exact)' } });
  writeFileAtomic(path.join(paths.dir, 'preflight.json'), JSON.stringify({ at: new Date().toISOString(), checks, limits, feasibility: feas }, null, 2));
  return out({ ok: checks.every((x) => x.ok), checks, feasibility: feas, usage_now: limits[reg.meta.main_family] || null, doctor_rows: doctor ? doctor.rows.filter((x) => x.status !== 'ok').map((x) => `${x.area}: ${x.detail}`) : null });
}

// ---------------------------------------------------------------- start
function spawnGuardian(paths) {
  ensureDir(paths.dir);
  const fd = fs.openSync(paths.log, 'a');
  const child = spawn(process.execPath, [SUPERVISOR, '--run', paths.dir], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env } });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

// Worktree + branch (the only things done in the user's repo), state.json, active-run registration. No process is started.
export async function materialize(paths, c, perms) {
  const git = createGit({ repo: c.repo, worktree: paths.worktree });
  git(c.repo, ['worktree', 'add', '-b', c.branch, paths.worktree, c.base_sha]);
  for (const d of c.bootstrap.link_dirs || []) {
    if (g(c.repo, ['check-ignore', '-q', d]).status === 0 && fs.existsSync(path.join(c.repo, d))) { try { fs.symlinkSync(path.join(c.repo, d), path.join(paths.worktree, d), 'junction'); } catch { /* linking is optional */ } }
  }
  if (c.bootstrap.commands?.length) {
    const r = await runChecks(c.bootstrap.commands, paths.worktree, { timeoutMs: 20 * 60000 });
    if (!r.ok) { git(c.repo, ['worktree', 'remove', '--force', paths.worktree], { allowFail: true }); git(c.repo, ['branch', '-D', c.branch], { allowFail: true, allowCleanup: true }); return { ok: false, error: 'bootstrap commands failed', extra: { results: r.results.map((x) => ({ cmd: x.cmd, code: x.code, tail: x.tail })) } }; }
  }
  c.approved = { go: true, at: new Date().toISOString(), permissions_hash: perms.hash };
  writeContract(paths.contract, c);
  const st = makeInitialState(c, paths.worktree, NOW());
  const pre = readJson(path.join(paths.dir, 'preflight.json'), null);
  if (pre?.limits) st.limits = pre.limits;
  saveState(paths, st);
  registerActive(c.repo, c.id);
  journal(paths, `GO given; worktree ${paths.worktree} on ${c.branch}; supervisor starting`);
  return { ok: true };
}

async function start(a) {
  if (!a.go) return fail('refusing to start: the explicit GO is missing (--go). The user must have said GO after seeing the contract, the allowlist and the feasibility.');
  const paths = resolveRun(a);
  if (!paths || !fs.existsSync(paths.contract)) return fail('--run <id> of a drafted contract is required');
  const c = readContract(paths.contract);
  const perms = readJson(paths.permissions, null);
  if (!perms || (a.hash && a.hash !== perms.hash)) return fail('the permission allowlist changed since it was shown (hash mismatch): show it again and ask for GO');
  if (fs.existsSync(paths.state)) return fail('this run was already started: use continue');
  const v = validateContract({ ...c, approved: { go: true } }, { needGo: true });
  if (!v.ok) return fail('contract is not valid', { errors: v.errors });
  const other = autoRunFor(c.repo);
  if (other.state === 'active') return fail(`another autonomous run owns this repo: ${other.run_id}`);
  const tracked = g(c.repo, ['status', '--porcelain']).stdout.split('\n').filter((l) => l && !l.startsWith('??'));
  if (tracked.length) return fail('the working tree has uncommitted tracked changes: commit or stash them first');
  if (g(c.repo, ['rev-parse', 'HEAD']).stdout.trim() !== c.base_sha) return fail('HEAD moved since the draft: draft again');
  const m = await materialize(paths, c, perms);
  if (!m.ok) return fail(m.error, m.extra || {});
  const pid = spawnGuardian(paths);
  return out({ ok: true, started: true, run_id: c.id, branch: c.branch, worktree: paths.worktree, guardian_pid: pid, log: paths.log, note: 'Nothing is printed while the run works. Use status / report / stop / takeover.' });
}

// ---------------------------------------------------------------- read-only views
function needRun(a) {
  const paths = resolveRun(a);
  if (!paths) { fail('no autonomous run found for this repo (pass --run <id>)'); return null; }
  return paths;
}

function statusCmd(a) {
  const paths = needRun(a); if (!paths) return;
  process.stdout.write(`${buildStatus(paths)}\n`);
}
function reportCmd(a) {
  const paths = needRun(a); if (!paths) return;
  const { state } = loadState(paths);
  process.stdout.write(buildReport(paths, { final: !!state?.finished_at }));
}

// ---------------------------------------------------------------- control
function liveState(paths) { const { state } = loadState(paths); return state; }

async function waitFor(paths, pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const s = liveState(paths); if (s && pred(s)) return s; await new Promise((r) => setTimeout(r, 1000)); }
  return liveState(paths);
}

function offlineEngine(paths) {
  const c = readContract(paths.contract);
  const reg = loadRegistry();
  const git = createGit({ repo: c.repo, worktree: paths.worktree });
  const deps = { reg, now: NOW, sleep: async () => {}, git, notify: () => {} };
  const e = new AutoEngine({ paths, deps, contract: c, rules: null, perms: readJson(paths.permissions, {}) });
  e.load();
  return e;
}

async function control(cmd, a) {
  const paths = needRun(a); if (!paths) return;
  const st = liveState(paths);
  if (!st) return fail('run has no state');
  const alive = supervisorAlive(paths);
  const done = FINISHED.includes(st.status);
  switch (cmd) {
    case 'pause': if (done) return fail(`run is ${st.status}`); setControl(paths, 'PAUSE'); return out({ ok: true, note: 'PAUSE set: the run idles after the current task (zero tokens). `continue` resumes.' });
    case 'continue': {
      if (done) return fail(`run is ${st.status}: nothing to continue`);
      setControl(paths, 'PAUSE', false); setControl(paths, 'STOP', false);
      if (!alive) { const pid = spawnGuardian(paths); registerActive(st.repo, st.run_id); return out({ ok: true, restarted_supervisor: true, guardian_pid: pid }); }
      return out({ ok: true, note: 'PAUSE/STOP cleared; the supervisor is running' });
    }
    case 'stop': {
      if (done) return fail(`run is ${st.status}`);
      setControl(paths, 'STOP');
      if (!alive) { st.status = 'stopped'; saveState(paths, st); return out({ ok: true, stopped: true, note: 'the supervisor was not running; marked stopped at the last checkpoint' }); }
      if (a.wait) { const s = await waitFor(paths, (x) => x.status === 'stopped', Number(a['wait-min'] || 30) * 60000); return out({ ok: s.status === 'stopped', status: s.status }); }
      return out({ ok: true, note: 'STOP set: the run stops safely after the current task. Check with status.' });
    }
    case 'abort': {
      if (done) return fail(`run is ${st.status}`);
      setControl(paths, 'ABORT');
      if (!alive) { const e = offlineEngine(paths); const r = e.abortRun(); return out({ ok: true, ...r, note: 'the supervisor was not running; ended directly' }); }
      const s = await waitFor(paths, (x) => x.status === 'aborted', 60000);
      return out({ ok: s.status === 'aborted', status: s.status, note: 'the worktree and all checkpoints are untouched' });
    }
    case 'takeover': {
      if (done && st.status !== 'handed_over') return fail(`run is ${st.status}; use review instead`);
      if (st.status === 'handed_over') return out({ ok: true, already: true, handoff: paths.handoff });
      setControl(paths, 'TAKEOVER');
      if (!alive) { const e = offlineEngine(paths); e.takeover(); }
      else await waitFor(paths, (x) => x.status === 'handed_over', Number(a['wait-min'] || 10) * 60000);
      const s = liveState(paths);
      return out({ ok: s.status === 'handed_over', status: s.status, handoff: paths.handoff, worktree: paths.worktree, branch: s.branch, note: 'Load handoff.md in the interactive session and continue in normal mode.' });
    }
    default: return fail('unknown control');
  }
}

// ---------------------------------------------------------------- morning review
function reviewCmd(a) {
  const paths = needRun(a); if (!paths) return;
  const st = liveState(paths);
  const sub = a._[1] || 'list';
  if (BLOCKING.includes(st.status) && supervisorAlive(paths)) return fail('the run is still working: review after it finishes, or stop/takeover first');
  const decisions = readJsonl(paths.decisions);
  if (sub === 'list') {
    const items = st.tasks.filter((t) => t.status === 'done' && t.checkpoint?.sha && !t.reverted).map((t) => ({ id: t.id, title: t.title, sha: t.checkpoint.sha.slice(0, 8), files: t.checkpoint.files || [], decisions: decisions.filter((d) => d.task === t.id).map((d) => ({ id: d.id, question: d.question, chosen: d.chosen, confidence: d.confidence, second_opinion: d.second_opinion?.agrees ?? null, undo: d.undo })) }));
    return out({ ok: true, run_id: st.run_id, branch: st.branch, items, parked: st.tasks.filter((t) => t.status === 'parked').map((t) => ({ id: t.id, reason: t.parked_reason })), reverted: st.tasks.filter((t) => t.reverted).map((t) => t.id), merged: st.merged || null });
  }
  if (sub === 'revert') {
    const key = a.id;
    const t = st.tasks.find((x) => x.id === key) || st.tasks.find((x) => x.id === decisions.find((d) => d.id === key)?.task);
    if (!t || !t.checkpoint?.sha) return fail(`no checkpointed task for ${key}`);
    if (t.reverted) return out({ ok: true, already: true });
    const git = createGit({ repo: st.repo, worktree: paths.worktree });
    const r = git(paths.worktree, ['revert', '--no-edit', t.checkpoint.sha], { allowFail: true });
    if (!r.ok) { git(paths.worktree, ['revert', '--abort'], { allowFail: true }); return fail(`revert of ${t.id} conflicts with later changes; nothing was changed. Revert the later tasks first or fix by hand.`, { detail: r.err.slice(0, 300) }); }
    t.reverted = { at: new Date().toISOString(), sha: git(paths.worktree, ['rev-parse', 'HEAD']).out };
    st.checkpoint_sha = t.reverted.sha;
    saveState(paths, st);
    appendJsonl(paths.decisions, { id: `R-${t.id}`, time: t.reverted.at, task: t.id, question: `Reverted ${t.id} during the morning review`, chosen: 'revert', outcome: 'reverted', undo: `git -C "${paths.worktree}" revert --no-edit ${t.reverted.sha}` });
    journal(paths, `review: ${t.id} reverted on ${st.branch} (${t.reverted.sha.slice(0, 8)})`);
    return out({ ok: true, reverted: t.id, commit: t.reverted.sha.slice(0, 8) });
  }
  if (sub === 'done') { st.reviewed = true; saveState(paths, st); return out({ ok: true, reviewed: true }); }
  return fail('review list | revert --id <task|decision> | done');
}

function mergeCmd(a) {
  const paths = needRun(a); if (!paths) return;
  if (!a.yes) return fail('refusing to merge without the explicit yes (--yes)');
  const st = liveState(paths);
  if (!FINISHED.includes(st.status)) return fail(`run is ${st.status}: let it finish (or take over) before merging`);
  if (!a.into) return fail('--into <branch> is required');
  const git = createGit({ repo: st.repo, worktree: paths.worktree });
  const cur = git(st.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (cur !== a.into) return fail(`the repo is on "${cur}", not "${a.into}": switch yourself first (the orchestrator never changes your branch)`);
  const dirty = git(st.repo, ['status', '--porcelain']).out.split('\n').filter((l) => l && !l.startsWith('??'));
  if (dirty.length) return fail('your working tree has uncommitted changes: commit or stash them first');
  const r = git(st.repo, ['merge', '--no-ff', '-m', `Merge ${st.branch} (autonomous run ${st.run_id})`, st.branch], { allowFail: true, allowMerge: true });
  if (!r.ok) { git(st.repo, ['merge', '--abort'], { allowFail: true, allowMerge: true }); return fail('merge conflicts; aborted, nothing changed', { detail: r.err.slice(0, 300) }); }
  st.merged = { into: a.into, at: new Date().toISOString(), sha: git(st.repo, ['rev-parse', 'HEAD']).out }; st.reviewed = true;
  saveState(paths, st);
  return out({ ok: true, merged: st.merged });
}

function cleanup(a) {
  const paths = needRun(a); if (!paths) return;
  if (!a.yes) return fail('refusing to clean up without --yes');
  const st = liveState(paths);
  if (BLOCKING.includes(st.status)) return fail(`run is ${st.status}`);
  const git = createGit({ repo: st.repo, worktree: paths.worktree });
  git(st.repo, ['worktree', 'remove', '--force', paths.worktree], { allowFail: true });
  git(st.repo, ['branch', '-D', st.branch], { allowFail: true, allowCleanup: true });
  for (const t of git(st.repo, ['tag', '--list', `auto/${st.run_id}/*`], { allowFail: true, allowCleanup: true }).out.split('\n').filter(Boolean)) git(st.repo, ['tag', '-d', t], { allowFail: true, allowCleanup: true });
  for (const r of git(st.repo, ['for-each-ref', '--format=%(refname)', `refs/auto/${st.run_id}`], { allowFail: true }).out.split('\n').filter(Boolean)) git(st.repo, ['update-ref', '-d', r], { allowFail: true, allowCleanup: true });
  return out({ ok: true, cleaned: st.run_id, note: 'worktree, branch, tags and snapshot refs removed; the run directory with the report stays' });
}

function list() {
  let ids = [];
  try { ids = fs.readdirSync(AUTO_ROOT).filter((n) => n !== 'active').sort().reverse(); } catch { /* none */ }
  return out(ids.map((id) => { const s = loadState(runPaths(runDirOf(id))).state; return s ? { run_id: id, status: s.status, repo: s.repo, branch: s.branch, reviewed: !!s.reviewed } : { run_id: id, status: 'draft' }; }));
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest, { flags: ['go', 'yes', 'wait', 'skip-doctor'] });
  switch (cmd) {
    case 'prepare': return prepare(a);
    case 'draft': return draft(a);
    case 'preflight': return preflight(a);
    case 'start': return start(a);
    case 'status': return statusCmd(a);
    case 'report': return reportCmd(a);
    case 'pause': case 'continue': case 'stop': case 'abort': case 'takeover': return control(cmd, a);
    case 'review': return reviewCmd({ ...a, _: [cmd, ...a._] });
    case 'merge': return mergeCmd(a);
    case 'cleanup': return cleanup(a);
    case 'list': return list();
    default: process.stdout.write(`${fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')}\n`); process.exitCode = cmd ? 1 : 0;
  }
}

export { prepare, draft, preflight, start, verifyCommands, normPolicy, enabledFamilies };
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => fail(e.message));
