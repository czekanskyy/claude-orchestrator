#!/usr/bin/env node
// The detached supervisor of an autonomous run. Two roles in one file:
//   guardian (default):  node auto-supervisor.mjs --run <dir>
//       single instance per run; keeps the machine awake; starts the engine as a child and restarts it after a crash
//       or a hang (stale heartbeat); never exits because of a limit or an error, only when the run is finished/stopped.
//   engine:              node auto-supervisor.mjs --engine --run <dir>
//       builds the real dependencies and runs lib/auto-engine.mjs.
// Writes nothing to the terminal: stdout/stderr belong to supervisor.log.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, loadRegistry, killTree, readJson, poolStatus, enabledFamilies } from './lib/common.mjs';
import { runPaths, loadState, createGit, acquireLock, releaseLock, readHeartbeat, writeHeartbeat, pidAlive } from './lib/auto-core.mjs';
import { readContract } from './lib/auto-contract.mjs';
import { AutoEngine } from './lib/auto-engine.mjs';
import { runClaudeTick, runAdapterTick, runChecks } from './lib/auto-worker.mjs';
import { sendNotification, startKeepAwake, networkReachable, claudeLoggedIn } from './lib/auto-system.mjs';
import { feedFromPool } from './lib/auto-limits.mjs';
import { syncCodexLimits } from './lib/codex-limits.mjs';
import { syncAgyLimits } from './lib/agy-limits.mjs';

const SELF = fileURLToPath(import.meta.url);
const TERMINAL = ['completed', 'blocked', 'aborted', 'handed_over', 'stopped'];
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- real dependencies
// ORCH_AUTO_WAIT_SCALE (<1) shortens waits for smoke tests: the engine's clock skips ahead by the time not slept.
export function realDeps(paths, contract, reg) {
  const scale = Number(process.env.ORCH_AUTO_WAIT_SCALE || 1);
  let skew = 0;
  const now = () => Date.now() + skew;
  const sleep = async (ms) => {
    if (scale >= 1) return sleepReal(ms);
    const real = Math.max(1, ms * scale);
    await sleepReal(real);
    skew += ms - real;
  };
  const git = createGit({ repo: contract.repo, worktree: paths.worktree });
  let lastCodex = 0;
  let runClaude = runClaudeTick;
  const inject = process.env.ORCH_AUTO_INJECT ? JSON.parse(process.env.ORCH_AUTO_INJECT) : null;
  if (inject) {
    // test hook: the first finished work tick is reported as a limit hit (real work done, real session to resume)
    runClaude = async (spec) => {
      const t = await runClaudeTick(spec);
      const mark = path.join(paths.dir, 'inject.json');
      if (t.kind === 'ok' && /^T\d/.test(spec.label || '') && !fs.existsSync(mark)) {
        fs.writeFileSync(mark, JSON.stringify({ at: new Date().toISOString() }));
        return { ...t, kind: 'limit', retry_at: Date.now() + (inject.reset_in_s || 8) * 1000, estimated: false, scope: 'five_hour', injected: true };
      }
      return t;
    };
  }
  return {
    reg, now, sleep, git, runClaude, runAdapter: runAdapterTick, runChecks,
    refreshUsage: async (limits, nowMs) => {
      const fams = enabledFamilies(reg).filter((f) => f !== 'claude');
      if (Date.now() - lastCodex > 5 * 60000) {
        lastCodex = Date.now();
        if (fams.includes('gpt')) { try { await syncCodexLimits(reg); } catch { /* estimate stays */ } }
        if (fams.includes('gemini')) { try { await syncAgyLimits(reg); } catch { /* estimate stays */ } }
      }
      for (const f of fams) { const pool = reg.families[f].pool; if (pool) feedFromPool(limits, f, poolStatus(reg, pool, Date.now()), nowMs); }
    },
    notify: (event) => sendNotification(contract.notify, event, paths),
    netCheck: () => networkReachable(),
    authCheck: () => claudeLoggedIn(),
    killPid: (pid) => { if (pidAlive(pid)) killTree({ pid }); },
    pollMs: 1500, heartbeatMs: 20000,
  };
}

async function runEngine(dir) {
  const paths = runPaths(dir);
  const contract = readContract(paths.contract);
  process.env.ORCH_PROJECT = contract.repo; // repo profile + overlay of the user's repo, not of the worktree
  const reg = loadRegistry();
  const perms = readJson(paths.permissions, null);
  if (!perms) throw new Error('permissions.json missing: the run was never approved');
  const engine = new AutoEngine({ paths, deps: realDeps(paths, contract, reg), contract, rules: reg.meta.repo_rules || null, perms });
  const r = await engine.run();
  return r;
}

// ---------------------------------------------------------------- guardian
async function guardian(dir) {
  const paths = runPaths(dir);
  const gpaths = { ...paths, lock: paths.guardianLock, heartbeat: paths.guardianHeartbeat };
  const lk = acquireLock(gpaths, { staleMs: 90000 });
  if (!lk.ok) { process.stdout.write(`guardian already running (pid ${lk.holder?.pid})\n`); return 0; }
  const beat = () => writeHeartbeat(gpaths, { role: 'guardian' });
  beat();
  const hb = setInterval(beat, 20000);
  const awake = startKeepAwake(process.pid);
  process.stdout.write(`${new Date().toISOString()} guardian up (pid ${process.pid}); keep-awake: ${awake.method || awake.note || 'none'}\n`);
  let restarts = [];
  try {
    for (;;) {
      const { state } = loadState(paths);
      if (state && TERMINAL.includes(state.status)) { process.stdout.write(`${new Date().toISOString()} run is ${state.status}: guardian exits\n`); return 0; }
      const child = spawn(process.execPath, [SELF, '--engine', '--run', dir], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
      const exit = await new Promise((resolve) => {
        const watchdog = setInterval(() => {
          const h = readHeartbeat(paths);
          if (h && Date.now() - h.ts > 6 * 60000 && !state?.wait) { process.stdout.write(`${new Date().toISOString()} engine heartbeat stale: restarting it\n`); killTree(child); }
        }, 30000);
        child.on('close', (code) => { clearInterval(watchdog); resolve(code); });
        child.on('error', () => { clearInterval(watchdog); resolve(-1); });
      });
      const after = loadState(paths).state;
      if (after && TERMINAL.includes(after.status)) { process.stdout.write(`${new Date().toISOString()} engine ended: ${after.status}\n`); return 0; }
      const nowMs = Date.now();
      restarts = restarts.filter((t) => nowMs - t < 10 * 60000).concat(nowMs);
      const gap = Math.min(5 * 60000, 5000 * 2 ** Math.min(restarts.length - 1, 6));
      process.stdout.write(`${new Date().toISOString()} engine exited (${exit}) without finishing: restart #${restarts.length} in ${Math.round(gap / 1000)} s\n`);
      await sleepReal(gap);
    }
  } finally {
    clearInterval(hb);
    awake.stop();
    releaseLock(gpaths);
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2), { flags: ['engine'] });
  if (!a.run) { process.stderr.write('usage: auto-supervisor.mjs [--engine] --run <run dir>\n'); process.exitCode = 2; return; }
  const dir = path.resolve(a.run);
  if (a.engine) {
    try { const r = await runEngine(dir); process.stdout.write(`${new Date().toISOString()} engine result ${JSON.stringify(r)}\n`); process.exitCode = 0; } catch (e) { process.stdout.write(`${new Date().toISOString()} engine crashed: ${e.stack}\n`); process.exitCode = 1; }
    return;
  }
  process.exitCode = await guardian(dir);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
