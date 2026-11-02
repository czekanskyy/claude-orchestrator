// Detached worker jobs: an external CLI (Codex, Grok, Gemini) runs in its own process, writes live progress to
// <run_dir>/progress.log and its final adapter JSON to <run_dir>/result.json. The main session never blocks on it:
// it starts the job (`--detach`), then `job.mjs wait` returns a progress snapshot every few minutes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { RUNS_DIR, ensureDir, readJson, killTree } from './common.mjs';

export const runDirOf = (runId) => path.join(RUNS_DIR, runId);
const stamp = () => new Date().toTimeString().slice(0, 8);

// Append-only progress log. `chunk` accepts raw process output (split into lines, blank lines dropped).
export function makeProgress(runDir) {
  const file = path.join(runDir, 'progress.log');
  const add = (text) => {
    // Codex logs the full shell launcher ("C:\\...\\pwsh.exe" -Command '...'): keep only the command itself.
    const lines = String(text).split(/\r?\n/).map((l) => l.trim().replace(/"[^"]*[\\/](?:pwsh|powershell|bash|cmd)(?:\.exe)?"\s+(?:-Command|-c|\/c)\s*/i, '')).filter(Boolean);
    if (!lines.length) return;
    try { fs.appendFileSync(file, `${lines.map((l) => `[${stamp()}] ${l.slice(0, 300)}`).join('\n')}\n`); } catch { /* progress is best-effort */ }
  };
  return { file, line: add, chunk: (buf) => add(buf) };
}

// Re-run this adapter as a detached process. The parent returns at once; validation errors that the child hits in its
// first seconds (bad model, privacy block, missing CLI, dry-run) are returned directly instead of a "started" stub.
export async function detachAdapter({ script, argv, runId, meta, graceMs = 4000 }) {
  const runDir = ensureDir(runDirOf(runId));
  const child = spawn(process.execPath, [script, ...argv.filter((x) => x !== '--detach'), '--run-id', runId], {
    cwd: process.cwd(), env: process.env, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  const job = { run_id: runId, run_dir: runDir, pid: child.pid, started_at: new Date().toISOString(), ...meta };
  fs.writeFileSync(path.join(runDir, 'job.json'), JSON.stringify(job, null, 2));
  const deadline = Date.now() + graceMs;
  const resultFile = path.join(runDir, 'result.json');
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) { const r = readJson(resultFile); if (r) return r; }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: true, status: 'started', ...job, progress_file: path.join(runDir, 'progress.log'), next: `node job.mjs wait --run-id ${runId} --max-wait-s 240` };
}

const tailLines = (file, n) => {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n); } catch { return []; }
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Snapshot of one job: state running | done | failed | stalled | dead, elapsed, idle time, last progress lines.
export function jobSnapshot(runId, { lines = 5, stallS = 600 } = {}) {
  const dir = runDirOf(runId);
  const job = readJson(path.join(dir, 'job.json'));
  if (!job) return { run_id: runId, state: 'unknown', error: 'no such job (job.json missing)' };
  const result = readJson(path.join(dir, 'result.json'));
  const progressFile = path.join(dir, 'progress.log');
  const elapsed = Math.round((Date.now() - Date.parse(job.started_at)) / 1000);
  const mtime = fs.existsSync(progressFile) ? fs.statSync(progressFile).mtimeMs : Date.parse(job.started_at);
  const idle = Math.round((Date.now() - mtime) / 1000);
  const snap = {
    run_id: runId, model: job.model, effort: job.effort, mode: job.mode, task: job.task || null, elapsed_s: elapsed, idle_s: idle,
    budget_s: job.budget_s || null, over_budget: !!(job.budget_s && elapsed > job.budget_s), progress: tailLines(progressFile, lines),
  };
  if (result) return { ...snap, state: result.ok ? 'done' : 'failed', result };
  if (job.pid && !alive(job.pid)) return { ...snap, state: 'dead', error: 'worker process ended without a result (see run_dir/stderr.txt)', run_dir: dir };
  return { ...snap, state: idle >= stallS ? 'stalled' : 'running' };
}

// Block up to maxWaitMs (or until every job is finished) and return the snapshots. Quiet jobs are polled cheaply.
export async function waitJobs(runIds, { maxWaitMs = 240000, pollMs = 3000, lines = 5, stallS = 600 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  let snaps;
  for (;;) {
    snaps = runIds.map((id) => jobSnapshot(id, { lines, stallS }));
    const open = snaps.filter((s) => s.state === 'running');
    if (!open.length || snaps.some((s) => ['done', 'failed', 'dead'].includes(s.state)) || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return snaps;
}

export function cancelJob(runId) {
  const dir = runDirOf(runId);
  const job = readJson(path.join(dir, 'job.json'));
  if (!job) return { run_id: runId, cancelled: false, error: 'no such job' };
  killTree({ pid: job.pid });
  // Engines with their own job registry (Codex companion) keep running after the client dies: cancel there too.
  const extra = readJson(path.join(dir, 'cancel.json'));
  if (extra?.script && extra.job_id) spawnSync(process.execPath, [extra.script, 'cancel', extra.job_id, '--cwd', extra.cwd], { windowsHide: true, timeout: 20000 });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ok: false, run_id: runId, error_kind: 'cancelled', error: 'cancelled by the orchestrator', text: '', cancel: extra || null }, null, 2));
  return { run_id: runId, cancelled: true, cancel_hook: extra || null };
}
