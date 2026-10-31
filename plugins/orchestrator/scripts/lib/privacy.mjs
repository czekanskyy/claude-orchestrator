// Privacy model: task sensitivity vs. a family's data policy. Used by the router (fail closed) and by every
// adapter as a second line of defence. Heuristics are conservative: a false positive only re-routes work.

export function globToRegex(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

const cache = new Map();
function compiled(globs) {
  const key = globs.join('\n');
  if (!cache.has(key)) cache.set(key, globs.map((g) => [g, globToRegex(g)]));
  return cache.get(key);
}

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^~\//, '').replace(/:\d+(?::\d+)?$/, '');

export function sensitiveGlobs(reg) {
  return reg.meta.sensitive_globs || [];
}

// Which of the files match any glob of the list: [{file, glob}].
export function matchGlobList(globList, files = []) {
  const globs = compiled(globList);
  const hits = [];
  for (const f of files) {
    const p = norm(f);
    const hit = globs.find(([, re]) => re.test(p));
    if (hit) hits.push({ file: f, glob: hit[0] });
  }
  return hits;
}

export const matchSensitiveFiles = (reg, files = []) => matchGlobList(sensitiveGlobs(reg), files);

// Path-like tokens of free text (briefs). Plain words are ignored: only tokens with "/" or "." can be files.
export function scanTextForGlobs(globList, text) {
  const tokens = String(text || '').split(/[\s"'`()<>,;=\[\]{}]+/).map((t) => t.replace(/[.:]+$/, '')).filter((t) => /[\\/.]/.test(t) && t.length < 260);
  return matchGlobList(globList, [...new Set(tokens)]);
}

export const scanTextForSensitivePaths = (reg, text) => scanTextForGlobs(sensitiveGlobs(reg), text);

export function familyPolicy(reg, familyId) {
  return reg.families?.[familyId]?.data_policy || { training_on_data: 'unknown', sensitive_ok: false, source: 'default (unknown family)' };
}

// task: { sensitivity?, files? } -> { level, reasons }
export function effectiveSensitivity(reg, task = {}) {
  const levels = reg.meta.sensitivity_levels;
  let level = levels.includes(task.sensitivity) ? task.sensitivity : (reg.meta.default_sensitivity || 'internal');
  const reasons = [];
  const hits = matchSensitiveFiles(reg, task.files || []);
  if (hits.length) {
    reasons.push(`sensitive files: ${hits.map((h) => h.file).join(', ')}`);
    level = 'sensitive';
  }
  return { level, reasons };
}

// Hard rule: sensitive never goes to a family without sensitive_ok. Everything else is allowed; `soft` marks the
// weaker preference for internal data (family may train on it).
export function familyAllowed(reg, familyId, level) {
  const p = familyPolicy(reg, familyId);
  if (level === 'sensitive' && p.sensitive_ok !== true) {
    return { ok: false, soft: false, reason: `privacy: ${familyId} has sensitive_ok=false (${p.source || 'no source'})` };
  }
  const trains = p.training_on_data !== false;
  return { ok: true, soft: level === 'internal' && trains && p.sensitive_ok !== true, reason: null };
}
