#!/usr/bin/env node
// Grok adapter: calls Grok Build (`grok`) headless. The grok-build plugin is NOT used because it always
// passes --always-approve and Grok's sandbox is not enforced on Windows. Isolation here comes from
// --permission-mode dontAsk (deny by default), tool allowlists and --deny rules for secrets.
// Usage: node run-grok.mjs --model <id> --effort <lvl> --mode review|research|implement --prompt-file F
//          [--cwd DIR] [--timeout SEC] [--max-turns N] [--allow-cmd "npm test" ...] [--resume-session ID]
//          [--task-type T --complexity C --risk R] [--dry-run] [--simulate KIND]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAdapter, isMain } from './lib/adapter.mjs';
import { runProcess, sanitizedEnv, which } from './lib/common.mjs';

const SECRET_DENY = [
  'Read(**/.env*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/id_rsa*)', 'Read(**/id_ed25519*)',
  'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.codex/**)', 'Read(~/.grok/auth.json)', 'Read(~/.claude/.credentials*)',
  'Edit(**/.env*)', 'Write(**/.env*)', 'Grep(**/.env*)',
  'Bash(*.env*)', 'Bash(printenv*)', 'Bash(env)', 'Bash(*id_rsa*)', 'Bash(*.ssh*)',
];
// Huge generated files: reading them burns the pool without adding signal.
const TOKEN_DENY = ['Read(**/pnpm-lock.yaml)', 'Read(**/package-lock.json)', 'Read(**/yarn.lock)', 'Read(**/*.min.js)', 'Read(**/node_modules/**)'];

function grokPath() {
  return which('grok') || [path.join(os.homedir(), '.grok', 'bin', 'grok.exe'), path.join(os.homedir(), '.grok', 'bin', 'grok')].find((p) => fs.existsSync(p)) || null;
}

export const spec = {
  loginHint: "grok login",
  invoke: 'grok',
  async buildCommand(ctx) {
    const { a, model, effort, mode, cwd, promptFile } = ctx;
    const grok = grokPath();
    if (!grok) throw new Error('grok CLI not found (install: irm https://x.ai/cli/install.ps1 | iex)');
    const args = [
      '--prompt-file', promptFile, '--output-format', 'json',
      '-m', model.cli_model, '--reasoning-effort', effort, '--cwd', cwd,
      '--no-subagents', '--permission-mode', 'dontAsk',
      '--max-turns', String(a['max-turns'] || (mode === 'implement' ? 40 : 20)),
    ];
    for (const rule of [...SECRET_DENY, ...TOKEN_DENY]) args.push('--deny', rule);
    // Fix rounds: resume the worker's own session by id (exact, unlike "latest").
    if (a['resume-session']) args.unshift('-r', a['resume-session']);
    if (mode === 'implement') {
      args.push('--allow', 'Edit(**)', '--allow', 'Write(**)', '--disallowed-tools', 'Agent');
      for (const c of a['allow-cmd'] || []) args.push('--allow', `Bash(${c.replace(/\)/g, '\\)')}*)`);
    } else {
      const tools = mode === 'research' ? 'read_file,grep,list_dir,web_search,web_fetch' : 'read_file,grep,list_dir';
      args.push('--tools', tools, '--disallowed-tools', 'run_terminal_cmd,search_replace,write,Agent');
      if (mode === 'review') args.push('--disable-web-search');
    }
    const warnings = [];
    if (process.platform === 'win32') warnings.push('Grok sandbox is not enforced on Windows: isolation relies on dontAsk + allowlists + deny rules.');
    return { engine: 'grok-cli', cmd: grok, args, cwd, env: sanitizedEnv(), warnings, resumed: !!a['resume-session'], display: `grok ${args.map((x) => (/[\s*()]/.test(x) ? `"${x}"` : x)).join(' ')}` };
  },

  run(cmd, ctx) {
    return runProcess(cmd.cmd, cmd.args, { cwd: cmd.cwd, env: cmd.env, timeoutMs: ctx.timeoutMs, onData: (d, kind) => kind === 'stderr' && ctx.progress?.chunk(d) });
  },

  parse(proc, ctx) {
    const j = parseJson(proc.stdout);
    if (!j) return ctx.a.simulate ? { text: proc.stdout } : { error: 'unparseable grok output' };
    if (j.type === 'error') return { error: j.message };
    const u = j.usage || {};
    const notes = j.stopReason && j.stopReason !== 'end_turn' ? `\n[stopReason: ${j.stopReason}]` : '';
    return {
      text: (j.text || '') + notes,
      session_id: j.sessionId || null,
      usage: j.usage ? { input: u.input_tokens, cached_input: u.cache_read_input_tokens, output: u.output_tokens, reasoning: u.reasoning_tokens, total: u.total_tokens, turns: j.num_turns } : null,
    };
  },

  parseFailure(proc) {
    const j = parseJson(proc.stdout);
    return { error: j?.message || j?.error || null, session_id: j?.sessionId || null };
  },

  simulateOk: (ctx) => JSON.stringify({ text: `SIMULATED ${ctx.model.id}/${ctx.effort}: OK`, stopReason: 'end_turn', sessionId: 'sim', usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 } }),
};

function parseJson(stdout) {
  const s = String(stdout || '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(s.slice(start)); } catch { return null; }
}

if (isMain(import.meta.url)) runAdapter(spec, process.argv.slice(2)).catch((e) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error_kind: 'adapter_crash', error: e.stack || e.message }, null, 2)}\n`);
  process.exitCode = 1;
});
