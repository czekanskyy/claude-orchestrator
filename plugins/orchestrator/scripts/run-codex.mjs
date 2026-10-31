#!/usr/bin/env node
// GPT adapter. Engine "plugin": the official codex-plugin-cc runtime (codex-companion.mjs, app-server,
// read-only / workspace-write sandbox, approval "never"). Engine "exec": plain `codex exec` fallback.
// Usage: node run-codex.mjs --model <id> --effort <lvl> --mode review|research|implement --prompt-file F
//          [--cwd DIR] [--timeout SEC] [--task-type T --complexity C --risk R] [--engine plugin|exec]
//          [--review-diff [--scope auto|working-tree|branch] [--base REF]] [--resume-of RUN_ID]
//          [--dry-run] [--simulate KIND]
import fs from 'node:fs';
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

  run(cmd, ctx) {
    return runProcess(cmd.cmd, cmd.args, { cwd: cmd.cwd, env: cmd.env, input: cmd.input, timeoutMs: ctx.timeoutMs });
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
