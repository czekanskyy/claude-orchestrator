// Zero-model-token probes of a family's CLI: presence, version, login state, detected plan. Shared by configure and doctor.
// Reads no credential files: only the CLIs' own status commands (and the Claude account metadata file, org type only).
import { cliPath, cliCommand, runProcess, detectClaudeAccount, poolForAccount } from './common.mjs';
import { readCodexRateLimits } from './codex-limits.mjs';

export async function cliInfo(reg, fid) {
  const fam = reg.families[fid];
  const bin = cliPath(fam);
  if (!bin) return { found: false, bin: fam.cli?.bin || null, version: null };
  const c = cliCommand(fam);
  const v = await runProcess(c.cmd, [...c.pre, ...(fam.cli.version_args || ['--version'])], { timeoutMs: 20000 });
  const text = `${v.stdout}\n${v.stderr}`.trim().split(/\r?\n/).find((l) => /\d+\.\d+/.test(l)) || null;
  return { found: true, bin, version: text ? text.trim().slice(0, 80) : null };
}

// -> { status: 'ok'|'fail'|'unknown', note }
export async function authCheck(reg, fid) {
  const fam = reg.families[fid];
  const cli = fam.cli || {};
  if (cli.auth === 'account-file') {
    const a = detectClaudeAccount();
    return a ? { status: 'ok', note: `logged in (${a.organization_type || 'account'})` } : { status: 'unknown', note: 'no Claude login metadata found: run claude and /login' };
  }
  const c = cliCommand(fam);
  if (!c) return { status: 'fail', note: 'CLI not installed' };
  if (!cli.auth_args) return { status: 'unknown', note: 'no non-model auth check for this CLI' };
  const r = await runProcess(c.cmd, [...c.pre, ...cli.auth_args], { timeoutMs: 30000 });
  if (r.timedOut) return { status: 'unknown', note: 'auth check timed out' };
  const text = `${r.stdout}\n${r.stderr}`;
  if (cli.auth_ok) return new RegExp(cli.auth_ok, 'i').test(text) ? { status: 'ok', note: 'logged in' } : { status: 'fail', note: 'not logged in' };
  if (cli.auth_fail && new RegExp(cli.auth_fail, 'i').test(text)) return { status: 'fail', note: 'not logged in' };
  return r.code === 0 ? { status: 'ok', note: 'CLI answered without an auth error' } : { status: 'unknown', note: `exit ${r.code}` };
}

// Plan the login belongs to, where a CLI exposes it without spending tokens. -> { plan_id, source } | null
export async function detectPlan(reg, fid) {
  const fam = reg.families[fid];
  if (fam.cli?.auth === 'account-file') {
    const id = poolForAccount(fam, detectClaudeAccount());
    return id ? { plan_id: id, source: 'Claude login metadata (organization type)' } : null;
  }
  if (fam.adapter?.id === 'codex') {
    const r = await readCodexRateLimits(reg, { timeoutMs: 8000 });
    const t = String(r.plan_type || '').toLowerCase();
    const hit = r.ok && Object.entries(fam.plans || {}).find(([, p]) => (p.account_match?.codex_plan_types || []).includes(t));
    return hit ? { plan_id: hit[0], source: `codex app-server planType=${t}` } : null;
  }
  return null;
}
