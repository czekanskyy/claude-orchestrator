#!/usr/bin/env node
// Detached worker jobs (started with `run-codex|grok|gemini.mjs ... --detach`): progress, wait, cancel.
//   job.mjs wait   --run-id R [--run-id R2 ...] [--max-wait-s 240] [--lines 5]   block until a job finishes or the time is up
//   job.mjs status --run-id R [--run-id R2 ...]                                  instant snapshot
//   job.mjs cancel --run-id R                                                    stop the worker (and Codex's own job)
// One JSON object per call: { jobs: [{ run_id, state: running|done|failed|stalled|dead, elapsed_s, idle_s, over_budget,
// progress: [last lines], result? }], pending: n }. `result` is the adapter's usual JSON (ok, text, error_kind, usage, fallback_hint...).
import { parseArgs, out, fail, truncate } from './lib/common.mjs';
import { waitJobs, jobSnapshot, cancelJob } from './lib/jobs.mjs';

// One ready Polish line per job, for the user: what runs, for how long, and the last thing it did.
const ICON = { running: '⏳', stalled: '⚠️', done: '✅', failed: '❌', dead: '❌', unknown: '❔' };
const minutes = (s) => (s < 90 ? `${s}s` : `${Math.round(s / 60)} min`);
export function showLine(s) {
  const last = (s.progress || []).at(-1)?.replace(/^\[[\d:]+\]\s*(\[[^\]]*\]\s*)?/, '') || '';
  const what = s.task || s.model || s.run_id;
  if (s.state === 'done') return `${ICON.done} ${what} · skończone po ${minutes(s.elapsed_s)}`;
  if (s.state === 'failed' || s.state === 'dead') return `${ICON.failed} ${what} · ${s.result?.error_kind || s.error || 'błąd'} po ${minutes(s.elapsed_s)}`;
  if (s.state === 'stalled') return `${ICON.stalled} ${what} · brak aktywności od ${minutes(s.idle_s)} (łącznie ${minutes(s.elapsed_s)})`;
  return `${ICON.running} ${what} · ${minutes(s.elapsed_s)}${s.over_budget ? ' (ponad budżet)' : ''}${last ? ` — ${last.slice(0, 110)}` : ''}`;
}

const compact = (s) => (s.result ? { ...s, result: { ...s.result, text: truncate(s.result.text, 4000) } } : s);

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest, { multi: ['run-id'] });
  const ids = a['run-id'] || a._;
  if (!['wait', 'status', 'cancel'].includes(cmd) || !ids.length) return fail('usage: job.mjs wait|status|cancel --run-id R [--run-id R2 ...] [--max-wait-s N] [--lines N]');
  const lines = Number(a.lines || 5);
  if (cmd === 'cancel') return out({ jobs: ids.map(cancelJob) });
  const snaps = cmd === 'wait'
    ? await waitJobs(ids, { maxWaitMs: Number(a['max-wait-s'] || 240) * 1000, lines, stallS: Number(a['stall-s'] || 600) })
    : ids.map((id) => jobSnapshot(id, { lines, stallS: Number(a['stall-s'] || 600) }));
  out({ show: snaps.filter((x) => x.state !== 'unknown').map(showLine).join('\n'), jobs: snaps.map(compact), pending: snaps.filter((s) => ['running', 'stalled'].includes(s.state)).length });
}

main(process.argv.slice(2)).catch((e) => fail(e.message));
