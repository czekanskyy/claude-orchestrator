// Autonomous mode: usage limits as data. Parses what a headless Claude run reports (stream-json `rate_limit_event`,
// error texts), tracks per-family windows and blocks, and answers one question for the engine: may this family take
// new work now, should new work prefer someone else (soft), or must we sleep until a known time (hard)?
// All functions are pure (the clock is a parameter) so the engine and the selftest drive them with a simulated clock.
import { detectLimit } from './common.mjs';

export const DEFAULT_LIMITS = Object.freeze({ soft_pct: 80, hard_pct: 95, weekly_soft_pct: 90, weekly_hard_pct: 97, reserve_pct: 5, safety_margin_min: 3 });
export const WINDOW_MS = { five_hour: 5 * 3600000, seven_day: 7 * 24 * 3600000 };
// Unknown reset time: retry with growing gaps. A rejected request costs no tokens, so probing is cheap.
export const UNKNOWN_RESET_BACKOFF_MIN = [10, 20, 40, 60];
export const EXTERNAL_BACKOFF_MIN = [1, 2, 5, 10, 15];

export const normPolicy = (p = {}) => ({ ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) });

export function validatePolicy(p) {
  const x = normPolicy(p);
  const errors = [];
  if (!(x.soft_pct > 0 && x.soft_pct < x.hard_pct && x.hard_pct <= 100)) errors.push('limits: need 0 < soft_pct < hard_pct <= 100');
  if (!(x.weekly_soft_pct > 0 && x.weekly_soft_pct < x.weekly_hard_pct && x.weekly_hard_pct <= 100)) errors.push('limits: need 0 < weekly_soft_pct < weekly_hard_pct <= 100');
  if (!(x.reserve_pct >= 0 && x.reserve_pct < x.hard_pct)) errors.push('limits: reserve_pct must be >= 0 and below hard_pct');
  if (x.hard_pct - x.reserve_pct <= x.soft_pct) errors.push('limits: hard_pct - reserve_pct must stay above soft_pct (work would stop before rerouting starts)');
  if (!(x.safety_margin_min >= 0)) errors.push('limits: safety_margin_min must be >= 0');
  return { ok: !errors.length, errors, policy: x };
}

// ---------------------------------------------------------------- parsing
// One stream-json line `{"type":"rate_limit_event","rate_limit_info":{...}}` (Claude Code 2.1.x). `utilization` is a
// fraction (header convention: 0.64 = 64%); a value above 1 is read as a percentage. [interpretation, see autonomous.md]
export function parseRateLimitEvent(ev) {
  const i = ev?.rate_limit_info;
  if (!i || typeof i !== 'object') return null;
  const pct = (u) => (typeof u !== 'number' ? null : +(u <= 1 ? u * 100 : u).toFixed(1));
  const windows = {};
  for (const key of ['five_hour', 'seven_day']) {
    const w = i.unifiedWindows?.[key];
    if (w) windows[key] = { pct: pct(w.utilization), resets_at: w.resetsAt ? w.resetsAt * 1000 : null, status: w.status || null };
  }
  const type = i.rateLimitType || null;
  if (type && windows[type] === undefined && WINDOW_MS[type] && typeof i.resetsAt === 'number') windows[type] = { pct: null, resets_at: i.resetsAt * 1000, status: i.status || null };
  return {
    status: i.status || 'allowed', type, resets_at: typeof i.resetsAt === 'number' ? i.resetsAt * 1000 : null, windows,
    overage: { using: !!i.isUsingOverage, status: i.overageStatus || null },
  };
}

function tzOffsetMs(tz, at) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(at / 1000) * 1000;
  } catch { return null; }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "resets 3pm", "resets at 3:30 PM (Europe/Warsaw)", "resets Nov 2, 9am". Estimated: the zone defaults to the machine's.
export function parseResetText(text, now = Date.now()) {
  const s = String(text || '');
  const m = s.match(/resets?\s+(?:at\s+)?(?:(?:on\s+)?([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+\/[A-Za-z_]+|UTC)\))?/i);
  if (!m) return null;
  let h = Number(m[3]);
  const min = Number(m[4] || 0);
  if (m[5]) h = (h % 12) + (/pm/i.test(m[5]) ? 12 : 0);
  if (h > 23 || min > 59) return null;
  const tz = m[6] && tzOffsetMs(m[6], now) !== null ? m[6] : null;
  const base = new Date(now);
  const mon = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  const build = (year, month, day) => {
    if (!tz) return new Date(year, month, day, h, min, 0, 0).getTime();
    const guess = Date.UTC(year, month, day, h, min, 0, 0);
    return guess - (tzOffsetMs(tz, guess) ?? 0);
  };
  let t;
  if (mon >= 0) { t = build(base.getFullYear(), mon, Number(m[2])); if (t < now - 86400000) t = build(base.getFullYear() + 1, mon, Number(m[2])); }
  else { t = build(base.getFullYear(), base.getMonth(), base.getDate()); if (t <= now) t += 86400000; }
  return Number.isFinite(t) ? t : null;
}

// Classifies a failed or empty headless run. text = result/stderr/last assistant text; status = api_error_status.
export function classifyFailure({ text = '', status = null, event = null, now = Date.now() } = {}) {
  const s = String(text || '');
  const rl = event ? parseRateLimitEvent(event) : null;
  if (rl && (rl.status === 'rejected' || rl.overage.using)) {
    const until = rl.resets_at || Math.max(0, ...Object.values(rl.windows).filter((w) => w.status && w.status !== 'allowed').map((w) => w.resets_at || 0)) || null;
    return { kind: 'limit', retry_at: until, estimated: !until, scope: rl.type, overage: rl.overage.using, source: 'rate_limit_event' };
  }
  if (status === 429 || /usage limit|hit your .{0,40}limit|limit reached|limit exceeded|rate[ _-]?limit|too many requests|out of (usage|credits)/i.test(s)) {
    const t = parseResetText(s, now) || (detectLimit(s, now)?.retry_at ? Date.parse(detectLimit(s, now).retry_at) : null);
    return { kind: 'limit', retry_at: t, estimated: true, scope: /weekly|7[- ]?day|week/i.test(s) ? 'seven_day' : /5[- ]?hour|session/i.test(s) ? 'five_hour' : null, source: t ? 'error text' : 'none' };
  }
  if (status === 529 || /overloaded/i.test(s)) return { kind: 'overloaded' };
  if (status === 401 || status === 403 || /not logged in|please run \/login|invalid (api key|x-api-key)|oauth token (has )?expired|authentication (failed|error)|unauthori[sz]ed/i.test(s)) return { kind: 'auth' };
  if (/ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|fetch failed|socket hang up|network (error|is unreachable)|unable to connect|connection (error|refused|reset)|getaddrinfo/i.test(s) || (typeof status === 'number' && (status === 0 || status >= 500))) return { kind: 'network' };
  return { kind: 'other' };
}

// ---------------------------------------------------------------- tracker (state.limits)
export const emptyLimits = () => ({});
const fam = (limits, f) => (limits[f] ||= { five_hour: null, seven_day: null, blocked_until: null, blocked_reason: null, blocked_estimated: false, block_attempts: 0, overage_seen: false });

// windows: { five_hour?: {pct, resets_at}, seven_day?: ... }; source 'exact' (vendor readout) or 'estimated'.
export function recordWindows(limits, family, windows, now, source = 'exact') {
  const f = fam(limits, family);
  for (const key of ['five_hour', 'seven_day']) {
    const w = windows?.[key];
    if (!w) continue;
    const prev = f[key];
    const pct = typeof w.pct === 'number' ? w.pct : prev?.pct ?? null;
    f[key] = { pct, resets_at: w.resets_at ?? prev?.resets_at ?? null, at: now, source };
  }
  return f;
}

export function recordBlock(limits, family, { until = null, reason = 'limit', now, margin_min = 0, schedule = UNKNOWN_RESET_BACKOFF_MIN } = {}) {
  const f = fam(limits, family);
  f.block_attempts = (f.block_attempts || 0) + 1;
  const estimated = !until || until <= now;
  const gap = schedule[Math.min(f.block_attempts - 1, schedule.length - 1)] * 60000;
  f.blocked_until = estimated ? now + gap : until + margin_min * 60000;
  f.blocked_reason = reason;
  f.blocked_estimated = estimated;
  return f;
}
export function clearBlock(limits, family) {
  const f = limits[family];
  if (f) { f.blocked_until = null; f.blocked_reason = null; f.blocked_estimated = false; f.block_attempts = 0; }
}

// -> { level: 'ok'|'soft'|'blocked', until, reason, estimated }
// kind 'work' keeps reserve_pct of the window for the orchestration loop, the final review and the report ('reserved' may use it).
export function familyState(limits, family, policyIn, now, kind = 'work') {
  const policy = normPolicy(policyIn);
  const f = limits[family];
  if (!f) return { level: 'ok', until: null, reason: null, estimated: false };
  let level = 'ok';
  let until = null;
  let reason = null;
  let estimated = false;
  if (f.blocked_until && f.blocked_until > now) return { level: 'blocked', until: f.blocked_until, reason: f.blocked_reason || 'limit', estimated: !!f.blocked_estimated };
  const reserve = kind === 'work' ? policy.reserve_pct : 0;
  for (const [key, soft, hard] of [['five_hour', policy.soft_pct, policy.hard_pct], ['seven_day', policy.weekly_soft_pct, policy.weekly_hard_pct]]) {
    const e = f[key];
    if (!e || typeof e.pct !== 'number') continue;
    if (e.resets_at && e.resets_at <= now) continue; // window rolled over since the reading
    if (e.source === 'estimated') { if (e.pct >= soft && level === 'ok') { level = 'soft'; reason = `${key} ~${e.pct}% (estimate)`; } continue; }
    const resetAt = e.resets_at || e.at + WINDOW_MS[key];
    if (e.pct >= hard - reserve) {
      const u = resetAt + policy.safety_margin_min * 60000;
      if (level !== 'blocked' || u > until) { level = 'blocked'; until = u; reason = `${key} ${e.pct}% >= ${hard - reserve}%`; estimated = !e.resets_at; }
    } else if (e.pct >= soft && level === 'ok') { level = 'soft'; reason = `${key} ${e.pct}% >= ${soft}%`; }
  }
  return { level, until, reason, estimated };
}

// Splits families into usable now / soft / blocked. `allowed` already honors the privacy filter.
export function availability(limits, allowed, policy, now, kind = 'work') {
  const ok = [];
  const soft = [];
  const blocked = [];
  for (const f of allowed) {
    const s = familyState(limits, f, policy, now, kind);
    if (s.level === 'ok') ok.push(f); else if (s.level === 'soft') soft.push(f); else blocked.push({ family: f, until: s.until, reason: s.reason, estimated: s.estimated });
  }
  // Soft = send NEW work elsewhere. Only when nobody else is fully ok do the soft ones keep working.
  const use = ok.length ? ok : soft;
  const earliest = blocked.length ? Math.min(...blocked.map((b) => b.until)) : null;
  return { ok, soft, blocked, use, earliest_unblock: earliest, all_blocked: !use.length && blocked.length > 0 };
}

// Merge a registry pool status (codex app-server / estimates / adapter cooldowns) into the tracker for a non-Claude family.
export function feedFromPool(limits, family, pool, now) {
  if (!pool) return;
  const windows = {};
  let exact = false;
  for (const w of pool.windows || []) {
    const key = w.id === '5h' ? 'five_hour' : w.id === '7d' ? 'seven_day' : null;
    if (!key) continue;
    const isExact = w.source !== 'estimate' && w.source !== 'manual+estimate';
    exact ||= isExact;
    windows[key] = { pct: w.pct, resets_at: w.resets_at ? Date.parse(w.resets_at) : null };
    recordWindows(limits, family, { [key]: windows[key] }, now, isExact ? 'exact' : 'estimated');
  }
  const f = fam(limits, family);
  if (pool.cooldown_until && Date.parse(pool.cooldown_until) > now) {
    f.blocked_until = Math.max(f.blocked_until || 0, Date.parse(pool.cooldown_until));
    f.blocked_reason = pool.cooldown_reason || 'cooldown';
    f.blocked_estimated = false;
  } else if (f.blocked_until && f.blocked_until <= now) clearBlock(limits, family);
}
