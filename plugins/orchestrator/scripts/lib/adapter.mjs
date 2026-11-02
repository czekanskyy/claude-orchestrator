// Shared adapter pipeline for external CLIs (codex, grok): validation → pool/secret checks →
// dry-run/simulate → run with timeout → classify → cooldown → usage log → one JSON result.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadRegistry, findModel, isExcluded, poolStatus, modelCooldown, scanSecrets, classifyError,
  setCooldown, appendUsage, readUsage, computeUnits, refreshEstimatesCache, ensureDir, newRunId, truncate,
  parseArgs, out, RUNS_DIR,
} from './common.mjs';
import { fallback } from '../registry.mjs';
import { detachAdapter, makeProgress, runDirOf } from './jobs.mjs';
import { effectiveSensitivity, familyAllowed, scanTextForSensitivePaths } from './privacy.mjs';

// True when `url` is the script node was started with (adapters export their spec and only run as a CLI).
export const isMain = (url) => url === pathToFileURL(process.argv[1] || '').href;

export const COMMON_FLAGS = ['detach', 'dry-run', 'approved', 'allow-secrets', 'allow-unverified', 'json-only'];
const SIMULATIONS = {
  rate_limit: { code: 1, stdout: '', stderr: "You've hit your usage limit. Try again in 45 minutes." },
  rate_limit_model: { code: 1, stdout: '', stderr: 'Rate limit reached for this model (429). Try again in 20 minutes.' },
  timeout: { code: -1, stdout: '', stderr: '', timedOut: true },
  cli_error: { code: 2, stdout: '', stderr: 'error: unexpected failure in CLI (simulated)' },
  auth: { code: 1, stdout: '', stderr: 'Not logged in. Please log in.' },
  unknown_model: { code: 1, stdout: '', stderr: 'error: unknown model "simulated-model"' },
};

export function parseAdapterArgs(argv) {
  return parseArgs(argv, { flags: COMMON_FLAGS, multi: ['allow-cmd', 'add-dir', 'file'] });
}

// Most recent logged run of this adapter in this working directory (used to guard session resumes).
export function lastRunIn(invoke, cwd) {
  const rows = readUsage().filter((r) => r.invoke === invoke && r.cwd && path.resolve(r.cwd) === path.resolve(cwd) && (!r.simulated || process.env.ORCH_SELFTEST === '1'));
  return rows[rows.length - 1] || null;
}

// spec: { invoke, family, buildCommand(ctx) -> {cmd,args,input,cwd,env,display,engine}, parse(proc, ctx) -> {text, usage, session_id, extra} }
export async function runAdapter(spec, argv) {
  const a = parseAdapterArgs(argv);
  const reg = loadRegistry();
  const started = Date.now();
  const runId = a['run-id'] || newRunId(spec.invoke);
  const mode = a.mode || 'review';
  const base = { ok: false, invoke: spec.invoke, run_id: runId, mode, model: a.model || null, effort: a.effort || null };
  // A detached job's final answer also goes to <run_dir>/result.json, where `job.mjs wait` picks it up.
  const finish = (res, code) => {
    refreshEstimatesCache(reg);
    if (a['run-id']) { try { fs.writeFileSync(path.join(ensureDir(runDirOf(runId)), 'result.json'), JSON.stringify(res, null, 2)); } catch { /* best effort */ } }
    out(res, code);
    return res;
  };

  if (!['review', 'research', 'implement'].includes(mode)) return finish({ ...base, error_kind: 'bad_args', error: 'mode must be review|research|implement' }, 1);
  if (!a['prompt-file'] || !fs.existsSync(a['prompt-file'])) return finish({ ...base, error_kind: 'bad_args', error: '--prompt-file <existing file> is required' }, 1);

  // Soft budget (reported by job.mjs as over_budget) and a hard kill at twice that, unless --timeout says otherwise.
  const budgetS = Number(a.budget || (mode === 'implement' ? 1500 : 600));
  if (a.detach && !a['dry-run'] && !a.simulate) {
    return finish(await detachAdapter({ script: process.argv[1], argv, runId, meta: { invoke: spec.invoke, model: a.model || null, effort: a.effort || null, mode, task: a.task || a['task-type'] || null, budget_s: budgetS } }), 0);
  }

  const m = findModel(reg, a.model);
  if (!m) {
    const ex = a.model ? isExcluded(reg, a.model) : null;
    return finish({ ...base, error_kind: 'unknown_model', error: ex ? `model excluded: ${ex.reason}` : `model "${a.model}" not in models.yaml`, suggest: ex ? null : 'Run /orchestrator:update.' }, 1);
  }
  if (m.invoke !== spec.invoke) return finish({ ...base, error_kind: 'bad_args', error: `${m.id} is invoked via ${m.invoke}, not ${spec.invoke}` }, 1);
  Object.assign(base, { model: m.id, family: m.family, pool: m.pool, cli_model: m.cli_model });
  if (!reg.families[m.family]?.enabled) return finish({ ...base, error_kind: 'family_disabled', error: `family ${m.family} is not enabled in config.yaml`, suggest: 'Run /orchestrator:configure.' }, 1);
  const effort = a.effort || m.effort.default;
  base.effort = effort;
  if (!m.effort.levels.includes(effort)) return finish({ ...base, error_kind: 'unknown_effort', error: `effort "${effort}" not in ${m.id} levels [${m.effort.levels.join(', ')}]`, suggest: 'Run /orchestrator:update if the CLI supports new levels.' }, 1);
  if (reg.meta.approval_efforts.includes(effort) && !a.approved) return finish({ ...base, error_kind: 'approval_required', error: `effort ${effort} requires explicit user approval (--approved)` }, 1);
  if (['deprecated', 'requires_approval'].includes(m.status) && !a.approved) return finish({ ...base, error_kind: 'approval_required', error: `model status ${m.status}` }, 1);
  if (m.status === 'unverified' && !a['allow-unverified'] && !a['dry-run']) return finish({ ...base, error_kind: 'unverified_model', error: `${m.id} is unverified; pass --allow-unverified for a smoke test` }, 1);

  const pool = poolStatus(reg, m.pool);
  const mcd = modelCooldown(m.pool, m.id);
  if ((pool.level === 'cooldown' || mcd) && !a.simulate) {
    const fb = fallback(reg, { model: m.id, effort, error: 'pool_cooldown', type: a['task-type'], complexity: a.complexity, risk: a.risk });
    return finish({ ...base, error_kind: 'pool_cooldown', error: `pool ${m.pool} in cooldown until ${pool.cooldown_until || mcd?.until}`, fallback_hint: fb.next, suggest_account_switch: fb.suggest_account_switch || undefined }, 1);
  }

  const prompt = fs.readFileSync(a['prompt-file'], 'utf8');
  // Privacy gate (second line of defence after the router): sensitive task or brief mentioning sensitive files
  // never reaches a family whose data policy has sensitive_ok=false. Fail closed, hand back an allowed fallback.
  const sens = effectiveSensitivity(reg, { sensitivity: a.sensitivity, files: [...(a.file || []), ...scanTextForSensitivePaths(reg, prompt).map((h) => h.file)] });
  base.sensitivity = sens.level;
  const verdict = familyAllowed(reg, m.family, sens.level);
  if (!verdict.ok) {
    const fb = fallback(reg, { model: m.id, effort, error: 'cli_error', type: a['task-type'], complexity: a.complexity, risk: a.risk, sensitivity: sens.level });
    return finish({ ...base, error_kind: 'privacy_blocked', error: `${verdict.reason}${sens.reasons.length ? `; ${sens.reasons.join('; ')}` : ''}`, fallback_hint: fb.next }, 1);
  }
  const secrets = scanSecrets(prompt);
  if (secrets.length && !a['allow-secrets']) return finish({ ...base, error_kind: 'secret_detected', error: `brief contains possible secrets: ${secrets.join(', ')}. Remove them (never send secrets to external models).` }, 1);

  const cwd = path.resolve(a.cwd || process.cwd());
  const timeoutMs = Number(a.timeout || budgetS * 2) * 1000;
  const runDir = ensureDir(path.join(RUNS_DIR, runId));
  const progress = makeProgress(runDir);
  const ctx = { a, reg, model: m, effort, mode, cwd, prompt, promptFile: path.resolve(a['prompt-file']), timeoutMs, runId, runDir, progress };
  base.run_dir = runDir;

  let cmd;
  try {
    cmd = await spec.buildCommand(ctx);
  } catch (e) {
    return finish({ ...base, error_kind: 'cli_missing', error: e.message }, 1);
  }
  fs.writeFileSync(path.join(runDir, 'cmd.json'), JSON.stringify({ cmd: cmd.cmd, args: cmd.args, cwd: cmd.cwd, engine: cmd.engine }, null, 2));
  if (a['dry-run']) return finish({ ...base, ok: true, dry_run: true, engine: cmd.engine, resumed: cmd.resumed || false, command: cmd.display || [cmd.cmd, ...cmd.args].join(' '), pool_state: { pct: pool.pct, level: pool.level }, warnings: cmd.warnings || [] }, 0);

  let proc;
  if (a.simulate) {
    proc = { durationMs: 5, timedOut: false, ...(SIMULATIONS[a.simulate] || { code: 0, stdout: spec.simulateOk?.(ctx) || 'OK', stderr: '' }) };
  } else {
    progress.line(`start ${m.id} ${effort} ${mode} (${cmd.engine})`);
    proc = await spec.run(cmd, ctx);
    progress.line(proc.timedOut ? `hard timeout after ${Math.round(proc.durationMs / 1000)}s` : `exit ${proc.code} after ${Math.round(proc.durationMs / 1000)}s`);
  }
  fs.writeFileSync(path.join(runDir, 'stdout.txt'), proc.stdout || '');
  fs.writeFileSync(path.join(runDir, 'stderr.txt'), proc.stderr || '');

  const parsed = proc.code === 0 && !proc.timedOut ? spec.parse(proc, ctx) : spec.parseFailure?.(proc, ctx) || {};
  let errorKind = null;
  let errorText = parsed.error || null;
  let limit = null;
  if (proc.timedOut) errorKind = 'timeout';
  else if (proc.code !== 0 || parsed.error) {
    const c = classifyError(`${parsed.error || ''}\n${proc.stderr}\n${proc.stdout.slice(-4000)}`);
    errorKind = c.error_kind;
    limit = c.limit || null;
    errorText ||= (proc.stderr || proc.stdout).trim().split(/\r?\n/).slice(-5).join('\n');
  }
  if (errorKind === 'rate_limit') {
    setCooldown(reg, m.pool, { untilMs: limit?.retry_at ? Date.parse(limit.retry_at) : undefined, reason: `limit message from ${m.id}`, model: limit?.scope === 'model' ? m.id : undefined });
  }
  const tokens = parsed.usage?.total || null;
  const units = computeUnits(reg, m, effort, tokens);
  const result = errorKind ? (errorKind === 'rate_limit' ? 'limit' : 'fail') : 'ok';
  appendUsage({
    pool: m.pool, family: m.family, model: m.id, effort, mode, task_type: a['task-type'] || null,
    duration_ms: proc.durationMs, tokens, tokens_estimated: !tokens, units, result, error_kind: errorKind,
    run_id: runId, invoke: spec.invoke, engine: cmd.engine, cwd, session_id: parsed.session_id || null, sensitivity: sens.level,
    resumed: cmd.resumed || undefined, simulated: a.simulate || undefined,
  });
  const text = parsed.text || '';
  fs.writeFileSync(path.join(runDir, 'last.txt'), text);
  const res = {
    ...base, ok: !errorKind, engine: cmd.engine, exit_code: proc.code, duration_ms: proc.durationMs, timed_out: !!proc.timedOut,
    error_kind: errorKind, error: errorText, limit, text: truncate(text, Number(a['max-text'] || 4000)), resumed: cmd.resumed || undefined,
    usage: { ...(parsed.usage || {}), units, estimated: !tokens }, session_id: parsed.session_id || null,
    touched_files: parsed.touched_files || undefined, simulated: a.simulate || undefined,
  };
  if (errorKind) {
    const scope = limit?.scope;
    const fb = fallback(reg, { model: m.id, effort, error: errorKind === 'auth' ? 'cli_error' : errorKind, scope, type: a['task-type'] || 'implement', complexity: a.complexity || 'M', risk: a.risk || 'med', sensitivity: sens.level });
    res.fallback_hint = fb.next;
    res.fallback_ladder = fb.ladder;
    if (fb.suggest_account_switch) res.suggest_account_switch = fb.suggest_account_switch;
    if (errorKind === 'auth') res.suggest = `Ask the user to log in: ${spec.loginHint || `${spec.invoke} login`}`;
    if (['unknown_model', 'unknown_effort'].includes(errorKind)) res.suggest = 'Run /orchestrator:update.';
  }
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(res, null, 2));
  return finish(res, errorKind ? 1 : 0);
}
