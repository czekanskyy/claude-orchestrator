#!/usr/bin/env node
// Claude Code statusline: prints a compact line and snapshots the Claude plan rate limits
// (rate_limits.five_hour / seven_day) so the orchestrator can read the exact Claude pool usage.
// The snapshot goes to the ACTIVE Claude pool (detected login: Team vs personal Pro, else repo
// overlay/preference). Other pools come from a small cache, recomputed when older than 10 minutes
// so expired 5h windows do not linger. Must stay fast and never throw.
import fs from 'node:fs';
import path from 'node:path';
import { POOLS_DIR, snapshotFile, readJson, writeJsonAtomic, loadRegistry, refreshEstimatesCache } from './lib/common.mjs';

const CACHE = path.join(POOLS_DIR, 'estimates.json');
const CACHE_TTL_MS = 10 * 60000;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function otherPools(reg, claudePool) {
  let cache = readJson(CACHE, {});
  const ages = Object.values(cache).map((v) => Date.parse(v.at) || 0);
  if (reg && (!ages.length || Date.now() - Math.min(...ages) > CACHE_TTL_MS)) {
    refreshEstimatesCache(reg);
    cache = readJson(CACHE, {});
  }
  const now = Date.now();
  return Object.entries(cache)
    .filter(([pool, v]) => pool !== claudePool && v.label !== 'Claude')
    .map(([pool, v]) => {
      const cd = v.cooldown_until && Date.parse(v.cooldown_until) > now ? '⏸' : '';
      return `${v.label || pool} ~${Math.round(v.pct)}%${cd}`;
    });
}

try {
  const data = JSON.parse(readStdin() || '{}');
  let reg = null;
  let pool = process.env.ORCH_CLAUDE_POOL || 'claude_team';
  try {
    process.env.ORCH_PROJECT = data.workspace?.project_dir || data.cwd || process.cwd();
    reg = loadRegistry();
    pool = reg.families[reg.meta.main_family].pool;
  } catch { /* keep the default pool */ }
  const rl = data.rate_limits;
  if (rl && (rl.five_hour || rl.seven_day)) {
    writeJsonAtomic(snapshotFile(pool), { updated_at: new Date().toISOString(), rate_limits: rl });
  }
  const parts = [`${data.model?.display_name || 'Claude'} [${pool.replace(/^claude_/, '')}]`];
  if (typeof data.context_window?.used_percentage === 'number') parts.push(`ctx ${Math.round(data.context_window.used_percentage)}%`);
  const snap = rl || readJson(snapshotFile(pool), {})?.rate_limits || {};
  if (snap.five_hour) parts.push(`5h ${Math.round(snap.five_hour.used_percentage)}%`);
  if (snap.seven_day) parts.push(`7d ${Math.round(snap.seven_day.used_percentage)}%`);
  parts.push(...otherPools(reg, pool));
  process.stdout.write(parts.join(' · '));
} catch {
  process.stdout.write('Claude');
}
