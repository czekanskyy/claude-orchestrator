#!/usr/bin/env node
// Usage tracker CLI: pool status, Claude:GPT balance, manual pool readings, cooldowns, logging.
import { pathToFileURL } from 'node:url';
import { syncCodexLimits } from './lib/codex-limits.mjs';
import { syncAgyLimits } from './lib/agy-limits.mjs';
import {
  loadRegistry, findModel, allPoolStatus, poolStatus, appendUsage, readUsage, computeUnits,
  setCooldown, clearCooldown, setManualPct, refreshEstimatesCache, parseArgs, out, fail,
} from './lib/common.mjs';

const USAGE = `usage.mjs <command>
  status [--md]                         pool table (exact for Claude via statusline, estimates otherwise)
  sync-limits                           exact Codex (codex app-server) and Gemini (agy -p /usage) 5h/weekly usage, zero model tokens -> pool snapshots
  balance [--hours 168]                 units per family over the period (target ~1:1 for primary families)
  log --model M --effort E --task-type T --result ok|fail|limit [--tokens N] [--duration-ms N] [--note TEXT]
  set-pool <pool> <pct> [--window 5h|7d]  manual reading (e.g. from grok.com or chatgpt.com usage pages)
  cooldown set <pool> [--minutes N] [--model M] [--reason TEXT] | cooldown clear <pool> [--model M]`;

export function statusMarkdown(list) {
  const icon = { ok: '🟢', busy: '🟡', constrained: '🟠', cooldown: '🔴' };
  const rows = list.map((p) => {
    const win = p.windows.map((w) => `${w.id}: ${w.pct}%${['statusline', 'app-server', 'agy-usage'].includes(w.source) ? '' : '~'}`).join(', ');
    const cd = p.cooldown_until ? ` cooldown until ${p.cooldown_until}` : '';
    const mc = Object.keys(p.model_cooldowns || {}).length ? ` (model cooldown: ${Object.keys(p.model_cooldowns).join(', ')})` : '';
    return `| ${icon[p.level] || ''} ${p.pool} | ${p.plan} | ${p.pct}% | ${win} | ${p.exact ? 'exact' : p.measurement === 'manual' ? 'manual/estimate' : 'estimate'}${cd}${mc} |`;
  });
  return ['| pool | plan | state | windows | measurement |', '|---|---|---|---|---|', ...rows].join('\n');
}

export function balance(reg, hours = 168) {
  const rows = readUsage(Date.now() - hours * 3600000);
  const fam = {};
  for (const r of rows) {
    const f = r.family || reg.pools[r.pool]?.family || 'unknown';
    fam[f] ||= { units: 0, calls: 0, failures: 0 };
    fam[f].units = +(fam[f].units + Number(r.units || 0)).toFixed(2);
    fam[f].calls += 1;
    if (r.result && r.result !== 'ok') fam[f].failures += 1;
  }
  const prim = Object.entries(reg.families).filter(([, f]) => f.role === 'primary' && f.enabled).map(([id]) => id);
  const pu = prim.map((f) => fam[f]?.units || 0);
  const total = pu.reduce((a, b) => a + b, 0);
  const shares = Object.fromEntries(prim.map((f, i) => [f, total ? +((pu[i] / total) * 100).toFixed(1) : 0]));
  return { hours, families: fam, primary_shares_pct: shares, note: 'Claude units exclude the main session; Claude pool % from the statusline includes it.' };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest, { flags: ['md'] });
  const reg = loadRegistry();
  if (['log', 'set-pool', 'cooldown'].includes(cmd)) process.on('exit', () => refreshEstimatesCache(reg));
  switch (cmd) {
    case 'status': {
      const list = allPoolStatus(reg);
      if (a.md) { process.stdout.write(`${statusMarkdown(list)}\n`); return; }
      return out(list);
    }
    case 'sync-limits': {
      const res = { gpt: await syncCodexLimits(reg), gemini: await syncAgyLimits(reg) };
      return out(res, Object.values(res).every((r) => r.ok || r.skipped) ? 0 : 1);
    }
    case 'balance': return out(balance(reg, Number(a.hours || 168)));
    case 'log': {
      const m = findModel(reg, a.model);
      if (!m) return fail(`unknown model ${a.model}`);
      const tokens = a.tokens ? Number(a.tokens) : null;
      return out(appendUsage({
        pool: m.pool, family: m.family, model: m.id, effort: a.effort, task_type: a['task-type'] || null,
        mode: a.mode || null, duration_ms: a['duration-ms'] ? Number(a['duration-ms']) : null,
        tokens, tokens_estimated: !tokens, units: computeUnits(reg, m, a.effort, tokens), result: a.result || 'ok',
        error_kind: a['error-kind'] || null, note: a.note || null, via: 'manual-log',
      }));
    }
    case 'set-pool': {
      const [pool, pct] = a._;
      if (!reg.pools[pool] || pct === undefined) return fail('usage: set-pool <pool> <pct> [--window id]');
      setManualPct(pool, pct, a.window);
      return out(poolStatus(reg, pool));
    }
    case 'cooldown': {
      const [sub, pool] = a._;
      if (!reg.pools[pool]) return fail(`unknown pool ${pool}`);
      if (sub === 'set') {
        const untilMs = a.minutes ? Date.now() + Number(a.minutes) * 60000 : undefined;
        const m = a.model ? findModel(reg, a.model)?.id : undefined;
        setCooldown(reg, pool, { untilMs, reason: a.reason || 'manual', model: m });
      } else if (sub === 'clear') clearCooldown(pool, a.model ? findModel(reg, a.model)?.id : undefined);
      else return fail('usage: cooldown set|clear <pool>');
      return out(poolStatus(reg, pool));
    }
    default: process.stdout.write(`${USAGE}\n`); process.exitCode = cmd ? 1 : 0;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => fail(e.message));
}
