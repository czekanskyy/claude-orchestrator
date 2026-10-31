// Autonomous mode: files on disk are the only memory. Run directory layout, atomic state with a backup, journal and
// log appenders, the single-instance lock, STOP/PAUSE/TAKEOVER/ABORT control files, the per-repo active-run registry
// and the git wrapper (which refuses `push` and refuses to mutate the user's checkout).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { STATE_DIR, ensureDir, readJson } from './common.mjs';

export const AUTO_ROOT = path.join(STATE_DIR, 'auto');
export const ACTIVE_DIR = path.join(AUTO_ROOT, 'active');
// Statuses: a run in BLOCKING status owns its repo (preflight shows it, a second run is refused).
export const BLOCKING = ['created', 'planning', 'running', 'waiting', 'paused', 'stopping', 'stopped', 'takeover_pending'];
export const FINISHED = ['completed', 'blocked', 'aborted', 'handed_over'];
export const CONTROL = ['STOP', 'PAUSE', 'TAKEOVER', 'ABORT'];

export function runPaths(dir) {
  const f = (n) => path.join(dir, n);
  return {
    dir, contract: f('contract.yaml'), state: f('state.json'), stateBak: f('state.json.bak'), plan: f('plan.json'), prompt: f('prompt.md'),
    permissions: f('permissions.json'), settings: f('claude-settings.json'), journal: f('journal.md'), decisions: f('decisions.jsonl'),
    parked: f('parked.md'), limits: f('limits.log'), report: f('report.md'), usage: f('usage.jsonl'), handoff: f('handoff.md'),
    heartbeat: f('heartbeat.json'), lock: f('supervisor.lock'), guardianLock: f('guardian.lock'), guardianHeartbeat: f('guardian-heartbeat.json'), log: f('supervisor.log'), worktree: f('worktree'), tasks: f('tasks'),
    ctl: Object.fromEntries(CONTROL.map((c) => [c, f(c)])),
  };
}

export function newAutoId(slug = 'task', now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-').slice(0, 13);
  return `${stamp}-${String(slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'task'}`;
}

export const runDirOf = (id) => path.join(AUTO_ROOT, id);

// ---------------------------------------------------------------- atomic files
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1)); // brief sleep: Windows scanners hold files
    }
  }
}

export function writeFileAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  renameRetry(tmp, file);
}

// State: previous generation kept as .bak. A crash between the copy and the rename leaves the old file intact.
export function saveState(paths, state) {
  state.updated_at = new Date().toISOString();
  state.seq = (state.seq || 0) + 1;
  if (fs.existsSync(paths.state)) { try { fs.copyFileSync(paths.state, paths.stateBak); } catch { /* best effort */ } }
  writeFileAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

// -> { state, source: 'state'|'backup'|null, corrupt }
export function loadState(paths) {
  const main = readJson(paths.state);
  if (main && typeof main === 'object' && main.run_id) return { state: main, source: 'state', corrupt: false };
  const bak = readJson(paths.stateBak);
  if (bak && typeof bak === 'object' && bak.run_id) return { state: bak, source: 'backup', corrupt: fs.existsSync(paths.state) };
  return { state: null, source: null, corrupt: fs.existsSync(paths.state) || fs.existsSync(paths.stateBak) };
}

export const readJsonl = (file) => {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch { /* torn last line after a crash */ } }
  return rows;
};
export const appendJsonl = (file, obj) => { ensureDir(path.dirname(file)); fs.appendFileSync(file, `${JSON.stringify(obj)}\n`); };

// ---------------------------------------------------------------- journal and logs (plain files, no model tokens)
export function journal(paths, text, at = new Date()) {
  ensureDir(paths.dir);
  fs.appendFileSync(paths.journal, `- ${at.toISOString()} ${String(text).replace(/\s*\n\s*/g, ' ')}\n`);
}
export function limitLog(paths, text, at = new Date()) {
  ensureDir(paths.dir);
  fs.appendFileSync(paths.limits, `${at.toISOString()} ${String(text).replace(/\s*\n\s*/g, ' ')}\n`);
}
export function parkNote(paths, task, reason, at = new Date()) {
  ensureDir(paths.dir);
  fs.appendFileSync(paths.parked, `## ${task.id}: ${task.title}\n- parked: ${at.toISOString()}\n- reason: ${String(reason).replace(/\s*\n\s*/g, ' ')}\n- needs: a human decision or a manual fix; the work done so far is on the auto branch\n\n`);
}

// ---------------------------------------------------------------- lock + heartbeat
export function pidAlive(pid) {
  if (!pid || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function writeHeartbeat(paths, extra = {}, now = Date.now()) {
  try { writeFileAtomic(paths.heartbeat, JSON.stringify({ ts: now, at: new Date(now).toISOString(), pid: process.pid, ...extra })); } catch { /* heartbeat is advisory */ }
}
export const readHeartbeat = (paths) => readJson(paths.heartbeat, null);

// Atomic create (`wx`). A lock whose process is gone, or whose heartbeat is older than staleMs, is taken over.
export function acquireLock(paths, { pid = process.pid, now = Date.now(), staleMs = 5 * 60000, alive = pidAlive } = {}) {
  ensureDir(paths.dir);
  const body = JSON.stringify({ pid, token: crypto.randomUUID(), started: new Date(now).toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(paths.lock, 'wx');
      fs.writeSync(fd, body);
      fs.closeSync(fd);
      return { ok: true, holder: JSON.parse(body) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = readJson(paths.lock, null);
      const hb = readHeartbeat(paths);
      const fresh = hb ? now - hb.ts < staleMs : holder?.started ? now - Date.parse(holder.started) < staleMs : false;
      if (holder && alive(holder.pid) && holder.pid !== pid && fresh) return { ok: false, reason: 'another supervisor is running this run', holder };
      if (holder && holder.pid === pid && alive(pid)) return { ok: true, holder, reentrant: true };
      try { fs.unlinkSync(paths.lock); } catch { /* raced with another taker */ }
    }
  }
  return { ok: false, reason: 'could not take the lock', holder: readJson(paths.lock, null) };
}
export function releaseLock(paths, pid = process.pid) {
  const holder = readJson(paths.lock, null);
  if (holder && holder.pid === pid) { try { fs.unlinkSync(paths.lock); } catch { /* gone */ } }
}
export const supervisorAlive = (paths, now = Date.now(), staleMs = 5 * 60000) => {
  const holder = readJson(paths.lock, null);
  const hb = readHeartbeat(paths);
  return !!(holder && pidAlive(holder.pid) && hb && now - hb.ts < staleMs);
};

// ---------------------------------------------------------------- control files (kill switch)
export function readControl(paths) {
  return Object.fromEntries(CONTROL.map((c) => [c.toLowerCase(), fs.existsSync(paths.ctl[c])]));
}
export function setControl(paths, name, on = true, note = '') {
  if (!CONTROL.includes(name)) throw new Error(`unknown control ${name}`);
  if (on) writeFileAtomic(paths.ctl[name], `${new Date().toISOString()} ${note}\n`);
  else { try { fs.unlinkSync(paths.ctl[name]); } catch { /* not set */ } }
}

// ---------------------------------------------------------------- repo -> active run registry
const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
export const repoKey = (repo) => crypto.createHash('sha1').update(norm(repo)).digest('hex').slice(0, 12);

export function registerActive(repo, runId) {
  ensureDir(ACTIVE_DIR);
  writeFileAtomic(path.join(ACTIVE_DIR, `${repoKey(repo)}.json`), JSON.stringify({ repo: path.resolve(repo), run_id: runId, since: new Date().toISOString() }));
}
export function clearActive(repo, runId) {
  const f = path.join(ACTIVE_DIR, `${repoKey(repo)}.json`);
  const cur = readJson(f, null);
  if (cur && (!runId || cur.run_id === runId)) { try { fs.unlinkSync(f); } catch { /* gone */ } }
}

// -> { state: 'none'|'active'|'finished', run_id, status, reviewed, dir } for a repo (most relevant run).
export function autoRunFor(repo) {
  if (!repo) return { state: 'none' };
  const reg = readJson(path.join(ACTIVE_DIR, `${repoKey(repo)}.json`), null);
  let best = null;
  if (reg) {
    const paths = runPaths(runDirOf(reg.run_id));
    const { state } = loadState(paths);
    if (state) best = { run_id: reg.run_id, status: state.status, reviewed: !!state.reviewed, dir: paths.dir, branch: state.branch };
  }
  if (!best) {
    // finished runs are not registered as active: look for the newest run of this repo
    let ids = [];
    try { ids = fs.readdirSync(AUTO_ROOT).filter((n) => n !== 'active').sort().reverse(); } catch { return { state: 'none' }; }
    for (const id of ids) {
      const { state } = loadState(runPaths(runDirOf(id)));
      if (state && norm(state.repo || '') === norm(repo)) { best = { run_id: id, status: state.status, reviewed: !!state.reviewed, dir: runDirOf(id), branch: state.branch }; break; }
    }
  }
  if (!best) return { state: 'none' };
  // a handed-over or aborted run needs no review nag; completed/blocked runs do until the user reviews them
  return { ...best, state: BLOCKING.includes(best.status) ? 'active' : (['completed', 'blocked'].includes(best.status) && !best.reviewed ? 'finished' : 'none') };
}

// ---------------------------------------------------------------- git (never push; never mutate the user's checkout)
const MUTATING = new Set(['add', 'commit', 'reset', 'checkout', 'switch', 'merge', 'rebase', 'clean', 'rm', 'mv', 'stash', 'restore', 'cherry-pick', 'revert', 'tag', 'branch', 'update-ref', 'apply']);

// ctx: { repo, worktree } (absolute). Throws on anything that would push or change the user's own checkout.
export function assertSafeGit(args, cwd, ctx = {}) {
  let sub = '';
  for (let i = 0; i < args.length; i++) { if (args[i] === '-c') { i++; continue; } if (!args[i].startsWith('-')) { sub = args[i]; break; } }
  if (sub === 'push' || args.includes('push')) throw new Error('git push is forbidden in autonomous mode');
  if (['remote', 'fetch', 'pull', 'clone', 'config'].includes(sub)) throw new Error(`git ${sub} is not used in autonomous mode`);
  const inRepo = ctx.repo && norm(cwd) === norm(ctx.repo);
  // cleanup of the run's own branch/tags/refs is the only other write to the user's repo: deletions and listings only
  const cleanup = ctx.allowCleanup && ['branch', 'tag', 'update-ref'].includes(sub) && args.some((x) => ['-D', '-d', '--list', '-l'].includes(x));
  if (inRepo && MUTATING.has(sub) && !(sub === 'merge' && ctx.allowMerge) && !cleanup) throw new Error(`git ${sub} would modify the user's checkout; autonomous mode works in the worktree only`);
  if (inRepo && sub === 'worktree' && !args.includes('add') && !args.includes('list') && !args.includes('prune') && !args.includes('remove')) throw new Error('unsupported git worktree subcommand');
}

// createGit({repo, worktree, record}) -> git(cwd, args, {input, allowFail, env}) => {ok, out, err, code}
export function createGit(ctx = {}) {
  const calls = ctx.record || [];
  const git = (cwd, args, { input, allowFail = false, env, allowMerge = false, allowCleanup = false } = {}) => {
    assertSafeGit(args, cwd, { ...ctx, allowMerge, allowCleanup });
    calls.push({ cwd, args: [...args] });
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env || {}) }, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const res = { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), code: r.status };
    if (!res.ok && !allowFail) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${res.err.slice(0, 300)}`);
    return res;
  };
  git.calls = calls;
  return git;
}

// Snapshot of a worktree (tracked + untracked) as a commit under refs/auto/..., without touching its index or branch.
export function snapshotWorktree(git, worktree, ref, message) {
  const gitDir = git(worktree, ['rev-parse', '--git-dir']).out;
  const idx = path.resolve(worktree, gitDir, 'auto-snapshot.index');
  const env = { GIT_INDEX_FILE: idx };
  try { fs.unlinkSync(idx); } catch { /* none yet */ }
  git(worktree, ['read-tree', 'HEAD'], { env });
  git(worktree, ['add', '-A'], { env });
  const tree = git(worktree, ['write-tree'], { env }).out;
  const head = git(worktree, ['rev-parse', 'HEAD']).out;
  const commit = git(worktree, ['-c', 'user.name=orchestrator-auto', '-c', 'user.email=auto@localhost', 'commit-tree', tree, '-p', head, '-m', message]).out;
  git(worktree, ['update-ref', ref, commit]);
  try { fs.unlinkSync(idx); } catch { /* gone */ }
  return commit;
}

export const sha8 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
export const uuid = () => crypto.randomUUID();
