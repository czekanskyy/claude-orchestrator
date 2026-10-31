// Exact Codex 5h/weekly usage at zero model tokens: `codex app-server` JSON-RPC `account/rateLimits/read`
// (the interface the Codex clients use for their own usage display; experimental). Never touches credential files.
import { spawn } from 'node:child_process';
import { cliCommand, snapshotFile, writeJsonAtomic, killTree } from './common.mjs';

// -> { ok, plan_type, windows: {five_hour, seven_day}, error }
export function readCodexRateLimits(reg, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const cli = cliCommand(reg.families.gpt);
    if (!cli) return resolve({ ok: false, error: 'codex CLI not found' });
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli.cmd);
    let child;
    try {
      child = spawn(shell ? `"${cli.cmd}"` : cli.cmd, [...cli.pre, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    const pending = new Map();
    let buf = '';
    let nextId = 0;
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child);
      resolve(res);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'app-server timeout' }), timeoutMs);
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', () => finish({ ok: false, error: 'app-server exited' }));
    child.stderr.on('data', () => {});
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        try { const m = JSON.parse(line); if (m.id !== undefined) pending.get(m.id)?.(m); } catch { /* not a response */ }
      }
    });
    const rpc = (method, params) => new Promise((res) => {
      const id = ++nextId;
      pending.set(id, res);
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    (async () => {
      await rpc('initialize', { clientInfo: { name: 'orchestrator', version: '3' }, capabilities: {} });
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      const r = await rpc('account/rateLimits/read');
      const rl = r.result?.rateLimits;
      if (!rl) return finish({ ok: false, error: r.error?.message || 'no rateLimits in response (not logged in?)' });
      const win = (w) => (w && typeof w.usedPercent === 'number' ? { used_percentage: w.usedPercent, resets_at: w.resetsAt ?? null, window_mins: w.windowDurationMins ?? null } : null);
      finish({ ok: true, plan_type: rl.planType || null, windows: { five_hour: win(rl.primary), seven_day: win(rl.secondary) }, limit_reached: rl.rateLimitReachedType || null });
    })().catch((e) => finish({ ok: false, error: e.message }));
  });
}

// Writes the snapshot poolStatus() reads (same shape as the Claude statusline snapshot).
export async function syncCodexLimits(reg) {
  const fam = reg.families.gpt;
  if (!fam?.enabled || !fam.pool) return { ok: false, skipped: true, error: 'gpt family not enabled' };
  const r = await readCodexRateLimits(reg);
  if (!r.ok) return r;
  const rate_limits = Object.fromEntries(Object.entries(r.windows).filter(([, v]) => v));
  writeJsonAtomic(snapshotFile(fam.pool), { updated_at: new Date().toISOString(), source: 'codex app-server', plan_type: r.plan_type, rate_limits });
  return { ok: true, pool: fam.pool, plan_type: r.plan_type, five_hour_pct: r.windows.five_hour?.used_percentage ?? null, seven_day_pct: r.windows.seven_day?.used_percentage ?? null, limit_reached: r.limit_reached };
}
