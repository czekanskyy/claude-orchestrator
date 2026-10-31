// Exact Gemini 5h/weekly quota at zero model tokens: `agy -p /usage --output-format json` is answered by the CLI
// itself (num_turns 0). The arguments are spawned directly: in Git Bash on Windows an unquoted `/usage` is rewritten
// to a filesystem path (set MSYS_NO_PATHCONV=1 when trying it by hand). Never touches credential files.
import os from 'node:os';
import { cliCommand, runProcess, snapshotFile, writeJsonAtomic } from './common.mjs';

const WINDOW_KEY = { '5h': 'five_hour', weekly: 'seven_day' };

// Pure: the CLI's JSON envelope -> { ok, groups: { <group name>: { five_hour, seven_day } }, error }
export function parseAgyUsage(text) {
  let env;
  try { env = JSON.parse(String(text).trim().split(/\r?\n/).filter(Boolean).pop() || ''); } catch { return { ok: false, error: 'agy did not return JSON' }; }
  if (env?.command?.name !== 'usage') return { ok: false, error: env?.response ? 'agy did not treat /usage as a command (CLI too old?)' : (env?.error || 'no usage data in the response') };
  const groups = {};
  for (const g of env.command.data?.groups || []) {
    const wins = {};
    for (const b of g.buckets || []) {
      const key = WINDOW_KEY[b.window];
      if (!key || typeof b.remaining_fraction !== 'number') continue;
      const reset = Date.parse(b.reset_time);
      wins[key] = { used_percentage: +Math.min(100, Math.max(0, (1 - b.remaining_fraction) * 100)).toFixed(2), resets_at: Number.isFinite(reset) ? Math.floor(reset / 1000) : null };
    }
    if (Object.keys(wins).length) groups[g.name] = wins;
  }
  return Object.keys(groups).length ? { ok: true, groups } : { ok: false, error: 'no quota buckets in the /usage response' };
}

// The group our Gemini models draw from (the other group, Claude/GPT-OSS inside agy, is not used by the orchestrator).
export function geminiGroup(groups) {
  const name = Object.keys(groups).find((n) => /gemini/i.test(n));
  return name ? groups[name] : null;
}

export async function readAgyUsage(reg, { timeoutMs = 30000 } = {}) {
  const cli = cliCommand(reg.families.gemini);
  if (!cli) return { ok: false, error: 'agy CLI not found' };
  const r = await runProcess(cli.cmd, [...cli.pre, '-p', '/usage', '--output-format', 'json'], { cwd: os.tmpdir(), timeoutMs, env: process.env });
  if (r.timedOut) return { ok: false, error: 'agy /usage timeout' };
  const p = parseAgyUsage(r.stdout);
  if (!p.ok && r.stderr) p.error = `${p.error} (${r.stderr.trim().split(/\r?\n/).pop().slice(0, 160)})`;
  return p;
}

// Writes the snapshot poolStatus() reads (same shape as the Claude statusline snapshot).
export async function syncAgyLimits(reg) {
  const fam = reg.families.gemini;
  if (!fam?.enabled || !fam.pool) return { ok: false, skipped: true, error: 'gemini family not enabled' };
  const r = await readAgyUsage(reg);
  if (!r.ok) return r;
  const win = geminiGroup(r.groups);
  if (!win) return { ok: false, error: `no Gemini group in /usage (${Object.keys(r.groups).join(', ')})` };
  writeJsonAtomic(snapshotFile(fam.pool), { updated_at: new Date().toISOString(), source: 'agy /usage', rate_limits: win });
  return { ok: true, pool: fam.pool, five_hour_pct: win.five_hour?.used_percentage ?? null, seven_day_pct: win.seven_day?.used_percentage ?? null };
}
