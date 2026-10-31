#!/usr/bin/env node
// Gemini adapter over the Antigravity CLI (`agy`, the consumer successor of Gemini CLI). Headless print mode with the
// documented JSON envelope: https://antigravity.google/docs/cli/headless
// Usage: node run-gemini.mjs --model <id> --effort <lvl> --mode review|research|implement --prompt-file F
//          [--cwd DIR] [--timeout SEC] [--allow-cmd "npm test" ...] [--resume-session CONVERSATION_ID]
//          [--task-type T --complexity C --risk R --sensitivity S --file PATH ...] [--dry-run] [--simulate KIND]
// Safety: review/research run in `--mode plan` (no edits), implement in `--mode accept-edits`; shell commands stay
// denied unless listed with --allow-cmd (passed as session-only --settings, never saved). stdin is closed (Windows
// non-TTY stdout issue, google-antigravity/antigravity-cli#76). The router keeps sensitive data away from consumer plans.
import fs from 'node:fs';
import path from 'node:path';
import { runAdapter, isMain } from './lib/adapter.mjs';
import { runProcess, sanitizedEnv, cliCommand } from './lib/common.mjs';

// Beyond this the prompt would risk the Windows command-line limit (32k): the brief is read from a file instead.
const MAX_INLINE_PROMPT = 20000;
const PLAN_NOTE = '\n\nConstraints: do not modify, create or delete any file and do not run shell commands. Answer in text only.';

export const spec = {
  loginHint: 'run `agy` once interactively and sign in',
  invoke: 'gemini',
  async buildCommand(ctx) {
    const { a, reg, model, effort, mode, cwd, promptFile, runDir, timeoutMs } = ctx;
    const cli = cliCommand(reg.families.gemini);
    if (!cli) throw new Error('agy (Antigravity CLI) not found on PATH (install: https://antigravity.google/docs/cli)');
    const warnings = [];
    let prompt = ctx.prompt;
    const args = ['--output-format', 'json', '--model', model.effort?.model_suffix ? `${model.cli_model}-${effort}` : model.cli_model];
    if (!model.effort?.model_suffix) args.push('--effort', effort);
    args.push('--mode', mode === 'implement' ? 'accept-edits' : 'plan', '--print-timeout', `${Math.max(30, Math.floor(timeoutMs / 1000) - 5)}s`);
    if (a['resume-session']) args.push('--conversation', a['resume-session']);
    if (mode !== 'implement') prompt += PLAN_NOTE;
    if (mode === 'implement' && a['allow-cmd']?.length) {
      const settingsFile = path.join(runDir, 'agy-settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: a['allow-cmd'].map((c) => `command(${c})`) } }));
      args.push('--settings', settingsFile);
    }
    if (prompt.length > MAX_INLINE_PROMPT) {
      args.push('--add-dir', path.dirname(promptFile));
      prompt = `Read the task brief in the file ${promptFile} and carry it out.${mode !== 'implement' ? PLAN_NOTE : ''}`;
      warnings.push('brief too long for the command line: agy reads it from the prompt file');
    }
    args.push('-p', prompt); // prompt last (headless doc)
    warnings.push('agy has no documented deny rules for secret files: privacy relies on the router (sensitive_ok) and brief scanning.');
    if (reg.families.gemini.data_policy?.sensitive_ok !== true) warnings.push('consumer-plan data policy: training may be on and wrapping agy in other tools may be unsupported (ToS unresolved); never send sensitive data.');
    const shown = args.map((x, i) => (i === args.length - 1 ? '<prompt>' : /\s/.test(x) ? `"${x}"` : x)).join(' ');
    return { engine: 'agy-cli', cmd: cli.cmd, args: [...cli.pre, ...args], cwd, env: sanitizedEnv(), warnings, resumed: !!a['resume-session'], display: `agy ${shown}` };
  },

  // stdin is closed by runProcess (no input): required on Windows when stdout is piped.
  run(cmd, ctx) {
    return runProcess(cmd.cmd, cmd.args, { cwd: cmd.cwd, env: cmd.env, timeoutMs: ctx.timeoutMs });
  },

  parse(proc, ctx) {
    const j = parseEnvelope(proc.stdout);
    if (!j) return ctx.a.simulate ? { text: proc.stdout } : { error: 'unparseable agy output (empty stdout can be the Windows non-TTY issue: run doctor)' };
    if (j.status && j.status !== 'SUCCESS') return { error: j.error || `agy status ${j.status}`, session_id: j.conversation_id || null };
    const u = j.usage || {};
    const denial = /denied|not allowed|permission/i.test(proc.stderr || '') ? `\n[agy notice: ${(proc.stderr || '').trim().split(/\r?\n/).slice(-1)[0].slice(0, 200)}]` : '';
    return {
      text: String(j.response ?? '') + denial,
      session_id: j.conversation_id || null,
      usage: j.usage ? { input: u.input_tokens, cached_input: u.cache_read_tokens, output: u.output_tokens, reasoning: u.thinking_tokens, total: u.total_tokens ?? (u.input_tokens || 0) + (u.output_tokens || 0) + (u.thinking_tokens || 0), turns: j.num_turns } : null,
    };
  },

  parseFailure(proc) {
    const j = parseEnvelope(proc.stdout);
    return { error: j?.error || (j?.status && j.status !== 'SUCCESS' ? `agy status ${j.status}` : null), session_id: j?.conversation_id || null };
  },

  simulateOk: (ctx) => JSON.stringify({ conversation_id: 'sim-conversation', status: 'SUCCESS', response: `SIMULATED ${ctx.model.id}/${ctx.effort}: OK`, duration_seconds: 1, num_turns: 1, usage: { input_tokens: 900, output_tokens: 40, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 940 } }),
};

function parseEnvelope(stdout) {
  const s = String(stdout || '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(s.slice(start)); } catch { return null; }
}

if (isMain(import.meta.url)) {
  runAdapter(spec, process.argv.slice(2)).catch((e) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error_kind: 'adapter_crash', error: e.stack || e.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
