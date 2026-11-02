#!/usr/bin/env node
// GPT adapter. Engine "plugin": the official codex-plugin-cc runtime (codex-companion.mjs, app-server,
// read-only / workspace-write sandbox, approval "never"). Engine "exec": plain `codex exec` fallback.
// Usage: node run-codex.mjs --model <id> --effort <lvl> --mode review|research|implement --prompt-file F
//          [--cwd DIR] [--timeout SEC] [--task-type T --complexity C --risk R] [--engine plugin|exec]
//          [--review-diff [--scope auto|working-tree|branch] [--base REF]] [--resume-of RUN_ID]
//          [--dry-run] [--simulate KIND]
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runAdapter, lastRunIn, isMain } from './lib/adapter.mjs';
import { runProcess, sanitizedEnv, which, readJson } from './lib/common.mjs';

// Effort levels accepted by codex-companion.mjs (VALID_REASONING_EFFORTS in plugin 1.0.6).
const PLUGIN_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function companionPath() {
  const installed = readJson(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), {});
  for (const entry of installed.plugins?.['codex@openai-codex'] || []) {
    const p = path.join(entry.installPath, 'scripts', 'codex-companion.mjs');
    if (fs.existsSync(p)) return { path: p, version: entry.version };
  }
  return null;
}

function isGitRepo(cwd) {
  let dir = cwd;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

export const spec = {
  loginHint: 'codex login',
  invoke: 'codex',
  async buildCommand(ctx) {
    const { a, model, effort, mode, cwd, promptFile, runDir } = ctx;
    const codex = which('codex');
    if (!codex) throw new Error('codex CLI not found on PATH (install: npm i -g @openai/codex)');
    const env = sanitizedEnv();
    const warnings = [];
    if (fs.existsSync(path.join(cwd, '.env'))) warnings.push('.env exists in cwd: Codex sandbox cannot hide it; the brief must not ask to read it.');
    const companion = companionPath();
    const wantPlugin = (a.engine || 'plugin') === 'plugin';
    const pluginOk = companion && PLUGIN_EFFORTS.includes(effort);
    if (wantPlugin && !pluginOk) warnings.push(companion ? `effort ${effort} not supported by codex plugin: using codex exec` : 'codex plugin not installed: using codex exec');

    if (wantPlugin && pluginOk) {
      let args;
      let resumed = false;
      if (a['review-diff']) {
        const focus = fs.readFileSync(promptFile, 'utf8').slice(0, 6000);
        args = [companion.path, 'adversarial-review', '--json', '--cwd', cwd, '--model', model.cli_model, '--scope', a.scope || 'auto'];
        if (a.base) args.push('--base', a.base);
        args.push(focus);
        warnings.push('adversarial-review ignores effort (plugin limitation); read-only sandbox');
      } else {
        // Fix rounds resume the worker's own thread (it keeps its context), but only when that thread is
        // provably the latest Codex run in this repo: the plugin's --resume-last picks the newest thread.
        let session = '--fresh';
        if (a['resume-of']) {
          const last = lastRunIn('codex', cwd);
          if (last?.run_id === a['resume-of'] && String(last.engine || '').startsWith('plugin') && last.mode !== 'review') {
            session = '--resume-last';
          } else {
            warnings.push(`--resume-of ${a['resume-of']} is not the latest Codex task in this repo: starting fresh (paste the findings into the brief)`);
          }
        }
        args = [companion.path, 'task', '--json', session, '--cwd', cwd, '--model', model.cli_model, '--effort', effort, '--prompt-file', promptFile];
        if (mode === 'implement') args.push('--write');
        resumed = session === '--resume-last';
      }
      const shown = a['review-diff'] ? [...args.slice(0, -1), '<focus text>'] : args;
      return {
        engine: `plugin@${companion.version}`, cmd: process.execPath, args, cwd, env, warnings, resumed,
        display: `node ${shown.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}`,
      };
    }

    const sandbox = mode === 'implement' ? 'workspace-write' : 'read-only';
    const lastFile = path.join(runDir, 'codex-last-message.txt');
    ctx.lastFile = lastFile;
    const args = ['exec', '--json', '-m', model.cli_model, '-c', `model_reasoning_effort="${effort}"`, '-s', sandbox, '-C', cwd, '--ephemeral', '-o', lastFile];
    if (!isGitRepo(cwd)) args.push('--skip-git-repo-check');
    args.push('-');
    return { engine: 'exec', cmd: codex, args, cwd, env, input: fs.readFileSync(promptFile, 'utf8'), warnings, display: `codex ${args.join(' ')} < ${promptFile}` };
  },

  // `task --json` prints nothing until the very end, so a second loop asks the plugin's own job registry
  // (`status --json`, the same data as /codex:status) what Codex is doing and appends changes to progress.log.
  async run(cmd, ctx) {
    const plugin = String(cmd.engine || '').startsWith('plugin') ? companionPath() : null;
    let stop = false;
    const poller = plugin ? pollCompanion(plugin.path, cmd, ctx, () => stop) : null;
    const tee = plugin ? undefined : (d) => ctx.progress?.chunk(d);
    try {
      return await runProcess(cmd.cmd, cmd.args, { cwd: cmd.cwd, env: cmd.env, input: cmd.input, timeoutMs: ctx.timeoutMs, onData: tee });
    } finally {
      stop = true;
      await poller;
    }
  },

  parse(proc, ctx) {
    const out = proc.stdout.trim();
    if (out.startsWith('{') && !out.includes('\n{"type"')) {
      // plugin JSON payload
      let p;
      try { p = JSON.parse(out); } catch { return { error: 'unparseable plugin output' }; }
      if (p.review) {
        const failed = p.codex?.status && p.codex.status !== 0;
        return { text: p.result ? JSON.stringify(p.result, null, 2) : (p.rawOutput || p.codex?.stdout || ''), session_id: p.threadId, error: failed ? (p.parseError || p.codex?.stderr || 'review failed') : null };
      }
      return { text: p.rawOutput || '', session_id: p.threadId, touched_files: p.touchedFiles, error: p.status && p.status !== 0 ? (p.rawOutput || 'task failed') : null };
    }
    return parseExecJsonl(proc, ctx);
  },

  parseFailure(proc, ctx) {
    const s = proc.stdout.trim();
    if (s.startsWith('{')) {
      try {
        const p = JSON.parse(s);
        return { error: p.error || p.rawOutput || p.codex?.stderr || null, session_id: p.threadId };
      } catch { /* fall through */ }
    }
    return parseExecJsonl(proc, ctx);
  },

  simulateOk: (ctx) => JSON.stringify({ status: 0, threadId: 'sim-thread', rawOutput: `SIMULATED ${ctx.model.id}/${ctx.effort}: OK`, touchedFiles: [] }),
};

// Poll the companion every few seconds: the job started by this run is the newest running task in the workspace.
async function pollCompanion(script, cmd, ctx, stopped, everyMs = 5000) {
  const seen = new Set();
  let jobId = null;
  // The companion titles a task with the first 72 chars of its prompt: that identifies our job among parallel ones;
  // an exclusive claim file settles the case of two briefs that open with the same text.
  const head = fs.readFileSync(ctx.promptFile, 'utf8').trim().replace(/\s+/g, ' ');
  const claimDir = path.join(path.dirname(ctx.runDir), '.codex-claims');
  const ours = (j) => {
    const sum = String(j.summary || '').replace(/\.\.\.$/, '');
    if (!head.startsWith(sum)) return false;
    try { fs.mkdirSync(claimDir, { recursive: true }); fs.writeFileSync(path.join(claimDir, j.id), ctx.runId, { flag: 'wx' }); return true; } catch { return fs.existsSync(path.join(claimDir, j.id)) && fs.readFileSync(path.join(claimDir, j.id), 'utf8') === ctx.runId; }
  };
  while (!stopped()) {
    const r = spawnSync(process.execPath, [script, 'status', '--json', '--cwd', cmd.cwd], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    try {
      const snap = JSON.parse(r.stdout);
      const job = jobId ? (snap.running || []).find((j) => j.id === jobId) : (snap.running || []).find((j) => ours(j));
      if (job) {
        if (job.id !== jobId) {
          jobId = job.id;
          fs.writeFileSync(path.join(ctx.runDir, 'cancel.json'), JSON.stringify({ script, job_id: jobId, cwd: cmd.cwd }));
          ctx.progress.line(`codex job ${jobId}`);
        }
        const phase = job.phase ? `[${job.phase}${job.elapsed ? ` ${job.elapsed}` : ''}]` : '';
        for (const l of job.progressPreview || []) {
          if (seen.has(l)) continue;
          seen.add(l);
          ctx.progress.line(`${phase} ${l}`);
        }
      }
    } catch (e) { if (process.env.ORCH_DEBUG) ctx.progress.line(`poll error: ${e.message} ${String(r.stderr).slice(0, 120)}`); }
    for (let i = 0; i < everyMs / 250 && !stopped(); i++) await new Promise((res) => setTimeout(res, 250));
  }
}

function parseExecJsonl(proc, ctx) {
  let text = '';
  let usage = null;
  let sessionId = null;
  const errors = [];
  for (const line of proc.stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'thread.started') sessionId = ev.thread_id;
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') text = ev.item.text || text;
    if (ev.type === 'turn.completed' && ev.usage) {
      const u = ev.usage;
      usage = { input: u.input_tokens, cached_input: u.cached_input_tokens, output: u.output_tokens, reasoning: u.reasoning_output_tokens, total: (u.input_tokens || 0) + (u.output_tokens || 0) };
    }
    if (ev.type === 'turn.failed') errors.push(ev.error?.message || 'turn failed');
    if (ev.type === 'error') errors.push(ev.message || 'error');
  }
  if (ctx.lastFile && fs.existsSync(ctx.lastFile)) {
    text = fs.readFileSync(ctx.lastFile, 'utf8') || text;
  }
  return { text, usage, session_id: sessionId, error: errors.length ? errors.join('\n') : null };
}

if (isMain(import.meta.url)) runAdapter(spec, process.argv.slice(2)).catch((e) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error_kind: 'adapter_crash', error: e.stack || e.message }, null, 2)}\n`);
  process.exitCode = 1;
});
