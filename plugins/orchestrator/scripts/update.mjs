#!/usr/bin/env node
// Backend of /orchestrator:update. The skill reads the official docs and proposes edits; this script gathers what is
// checkable offline-cheaply and stamps the result. It never touches config.yaml (user state) and never writes
// without --approved.
//   scan [--out FILE]                       configured families only: sources to read, CLI-observed catalog, diff, staleness
//   stamp [--date D] [--note T] [--plans id,id] [--approved]   set meta.verified_at, refresh plan "checked" dates, append CHANGELOG
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRegistry, enabledFamilies, parseArgs, out, fail, PLUGIN_DIR, REGISTRY_PATH } from './lib/common.mjs';
import { observe, diffRegistry, diffMarkdown, staleCheck } from './registry.mjs';

const CHANGELOG = path.join(PLUGIN_DIR, 'CHANGELOG.md');
const today = () => new Date().toISOString().slice(0, 10);

export async function scan(reg) {
  const fams = enabledFamilies(reg);
  const families = fams.map((f) => {
    const fam = reg.families[f];
    const plans = fam.configured_plans.map((id) => {
      const p = fam.plans?.[id];
      return { id, label: p?.label || id, custom: !p, limits_note: p?.limits_note || null, policy: p?.data_policy || null, checked: p?.data_policy?.checked || null, sources: [...new Set([...(p?.sources || []), p?.data_policy?.source].filter(Boolean))] };
    });
    const models = Object.values(reg.models).filter((m) => m.family === f).map((m) => ({ id: m.id, status: m.status, tier: m.tier, effort: m.effort.levels, context_tokens: m.context_tokens, sources: m.sources || [] }));
    return { id: f, label: fam.label, cli_bin: fam.cli?.bin, plans, models, user_policy_override: reg.families[f].data_policy.source === 'config.yaml override' };
  });
  const observed = await observe(reg);
  const diff = diffRegistry(reg, observed);
  return {
    today: today(), registry: { file: REGISTRY_PATH, ...staleCheck(reg) }, configured_families: fams, families,
    skipped_families: Object.keys(reg.families).filter((f) => !fams.includes(f)),
    observed: { cli: observed.cli, notes: observed.notes }, diff, diff_markdown: diffMarkdown(diff),
    checklist: ['models: new/removed/renamed, effort levels, context window', 'plans: price tiers, 5h/weekly limits, new tiers', 'CLI flags used by the adapters (headless, sandbox, resume, model/effort selection)', 'plugin versions of the vendor plugins in use', 'training/retention terms per configured plan (data_policy.sensitive_ok must stay conservative when unclear)'],
  };
}

// Replace `key: "date"` inside one plan block of models.yaml (text edit: keeps comments and layout).
function stampPlan(text, planId, date) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `      ${planId}:`);
  if (start < 0) return { text, found: false };
  let end = start + 1;
  while (end < lines.length && (/^        /.test(lines[end]) || lines[end].trim() === '')) end++;
  for (let i = start; i < end; i++) lines[i] = lines[i].replace(/\b(checked|verified_at): "[^"]*"/g, `$1: "${date}"`);
  return { text: lines.join('\n'), found: true };
}

export function stamp(reg, { date = today(), note = '', plans = [], approved = false }) {
  let text = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const before = text;
  const meta = /^(meta:\n(?:[ \t].*\n|\n)*?  verified_at: )"[^"]*"/m;
  if (!meta.test(text)) throw new Error('meta.verified_at not found in models.yaml');
  text = text.replace(meta, `$1"${date}"`);
  const missing = [];
  for (const id of plans) { const r = stampPlan(text, id, date); if (r.found) text = r.text; else missing.push(id); }
  const entry = `\n## Registry update ${date}\n\n${note ? `${note.trim()}\n` : '- Re-verified against official docs; no changes.\n'}`;
  const plan = { file: REGISTRY_PATH, verified_at: date, plans_stamped: plans.filter((p) => !missing.includes(p)), plans_missing: missing, changelog: CHANGELOG, changed: text !== before };
  if (!approved) return { ...plan, dry_run: true, note: 'pass --approved after the user approved the diff' };
  fs.writeFileSync(REGISTRY_PATH, text);
  const log = fs.existsSync(CHANGELOG) ? fs.readFileSync(CHANGELOG, 'utf8') : '# Changelog\n';
  const at = log.search(/^## /m);
  fs.writeFileSync(CHANGELOG, at < 0 ? `${log.trimEnd()}\n${entry}` : `${log.slice(0, at).trimEnd()}\n${entry}\n${log.slice(at)}`);
  return plan;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest, { flags: ['approved'] });
  const reg = loadRegistry();
  switch (cmd) {
    case 'scan': {
      const s = await scan(reg);
      if (!a.out) return out(s);
      fs.writeFileSync(a.out, JSON.stringify(s, null, 2));
      // compact stdout: what the skill needs to start reading docs (full detail is in the file)
      return out({ full: a.out, today: s.today, registry: s.registry, configured_families: s.configured_families, skipped_families: s.skipped_families, observed: s.observed, diff_markdown: s.diff_markdown, checklist: s.checklist,
        sources: Object.fromEntries(s.families.map((f) => [f.id, [...new Set([...f.models.flatMap((m) => m.sources), ...f.plans.flatMap((p) => p.sources)])]])) });
    }
    case 'stamp': return out(stamp(reg, { date: a.date, note: a.note || '', plans: a.plans ? a.plans.split(',') : [], approved: !!a.approved }));
    default: process.stdout.write('update.mjs scan [--out F] | stamp [--date D] [--note T] [--plans a,b] [--approved]\n'); process.exitCode = cmd ? 1 : 0;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => fail(e.message));
