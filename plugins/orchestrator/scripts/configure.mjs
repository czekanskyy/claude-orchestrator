#!/usr/bin/env node
// Backend of /orchestrator:configure. The wizard (AskUserQuestion) lives in the skill; this script does the
// deterministic parts: detect what is installed, validate and write config.yaml, show the effective setup.
//   detect                      CLI presence, version, login (no model call), detected plan, catalog plans, current config
//   show [--md]                 current config + effective privacy per family
//   apply --answers FILE|-      merge answers over the current config, validate, write (atomic, .bak kept)
//   validate                    check the current config.yaml against the schema
// Answers = config shape without schema_version: { main_family, families: { <f>: { enabled, plans, data_policy } },
//   defaults: { orchestrator }, privacy: { sensitive_globs, default_sensitivity } }. Omitted families/keys keep their values.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadRegistry, parseArgs, out, fail, repoRoot, readProjectPrefs, enabledFamilies } from './lib/common.mjs';
import { readConfig, validateConfig, writeConfig, CONFIG_SCHEMA_VERSION, CONFIG_FILE } from './lib/config.mjs';
import { cliInfo, authCheck, detectPlan } from './lib/health.mjs';
import { projectOrchestrators } from './registry.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const planSummary = (id, p) => ({ id, label: p.label, sensitive_ok: p.data_policy?.sensitive_ok === true, training_on_data: p.data_policy?.training_on_data ?? 'unknown', limits: String(p.limits_note || '').slice(0, 110) });

export async function detect(reg) {
  const { config, error } = readConfig();
  const root = repoRoot();
  const project = projectOrchestrators(root);
  const families = {};
  await Promise.all(Object.entries(reg.families).map(async ([fid, fam]) => {
    const cli = await cliInfo(reg, fid);
    const auth = cli.found || fam.cli?.auth === 'account-file' ? await authCheck(reg, fid) : { status: 'fail', note: 'CLI not installed' };
    const plan = auth.status === 'ok' ? await detectPlan(reg, fid) : null;
    families[fid] = {
      label: fam.label, role: fam.role, cli, auth,
      detected_plan: plan, default_plan: fam.default_plan,
      plans: Object.entries(fam.plans || {}).map(([id, p]) => planSummary(id, p)),
      preselect: cli.found && auth.status === 'ok',
      current: config?.families?.[fid] || null,
    };
  }));
  return {
    config_file: CONFIG_FILE, config_present: !!config, config_error: error, current: config,
    main_family: { current: config?.main_family || null, default: reg.meta.main_family },
    repo: { root, project_orchestrators: project.map((p) => p.invoke), current_default: config?.defaults?.orchestrator || null, repo_pref: readProjectPrefs(root).orchestrator || null },
    families,
  };
}

// Answers over the existing config (idempotent: applying the same answers twice yields the same file).
export function mergeAnswers(current, answers) {
  const cfg = { ...(current || {}), schema_version: CONFIG_SCHEMA_VERSION };
  if (answers.main_family) cfg.main_family = answers.main_family;
  cfg.families = { ...(current?.families || {}) };
  for (const [fid, f] of Object.entries(answers.families || {})) {
    const next = { enabled: f.enabled, ...(f.enabled ? { plans: f.plans } : {}) };
    const dp = f.data_policy ?? current?.families?.[fid]?.data_policy;
    if (dp && Object.keys(dp).length) next.data_policy = dp;
    cfg.families[fid] = next;
  }
  if (answers.defaults) cfg.defaults = { ...(current?.defaults || {}), ...answers.defaults };
  if (answers.privacy) cfg.privacy = { ...(current?.privacy || {}), ...answers.privacy };
  cfg.updated = today();
  return cfg;
}

export function effectiveSummary(reg) {
  return enabledFamilies(reg).map((f) => {
    const fam = reg.families[f];
    return { family: f, plans: fam.configured_plans, active_pool: fam.pool, sensitive_ok: fam.data_policy.sensitive_ok, training_on_data: fam.data_policy.training_on_data, policy_source: fam.data_policy.source };
  });
}

function showMarkdown(reg, config) {
  if (!config) return `No config yet (${CONFIG_FILE}). Run /orchestrator:configure. Conservative defaults apply: only ${reg.meta.main_family} enabled, no sensitive data leaves it.`;
  const rows = effectiveSummary(reg).map((e) => `| ${e.family}${e.family === reg.meta.main_family ? ' (main)' : ''} | ${e.plans.join(', ')} | ${e.sensitive_ok ? 'yes' : 'NO'} | ${e.training_on_data} | ${e.policy_source || ''} |`);
  return [`Config: ${CONFIG_FILE} (updated ${config.updated || '?'})`, '', '| family | plans | sensitive data ok | trains on data | policy source |', '|---|---|---|---|---|', ...rows,
    '', `Per-repo default: ${config.defaults?.orchestrator || 'unset (ask)'}${config.privacy?.sensitive_globs?.length ? ` · extra sensitive globs: ${config.privacy.sensitive_globs.join(', ')}` : ''}`].join('\n');
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest, { flags: ['md'] });
  switch (cmd) {
    case 'detect': return out(await detect(loadRegistry(undefined, { config: null })));
    case 'show': {
      const reg = loadRegistry();
      const { config, error } = readConfig();
      if (a.md) { process.stdout.write(`${showMarkdown(reg, config)}${error ? `\n⚠ ${error}` : ''}\n`); return; }
      return out({ file: CONFIG_FILE, present: !!config, error, config, effective: effectiveSummary(reg) });
    }
    case 'validate': {
      const reg = loadRegistry(undefined, { config: null });
      const { config, error } = readConfig();
      if (error) return fail(error);
      if (!config) return out({ ok: true, present: false, note: 'no config.yaml (conservative defaults apply)', errors: [], warnings: [] });
      const v = validateConfig(config, reg.families);
      return out({ present: true, file: CONFIG_FILE, ...v }, v.ok ? 0 : 1);
    }
    case 'apply': {
      const src = a.answers;
      if (!src) return fail('usage: apply --answers <file.json | ->');
      let answers;
      try { answers = JSON.parse(src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8')); } catch (e) { return fail(`answers are not valid JSON: ${e.message}`); }
      const reg = loadRegistry(undefined, { config: null });
      const { config: current, error } = readConfig();
      if (error) return fail(`${error} (fix or remove ${CONFIG_FILE} first; the file was not changed)`);
      const merged = mergeAnswers(current, answers);
      const v = validateConfig(merged, reg.families);
      if (!v.ok) return fail('invalid configuration (nothing written)', { errors: v.errors, warnings: v.warnings });
      const unchanged = current && JSON.stringify({ ...current, updated: 0 }) === JSON.stringify({ ...merged, updated: 0 });
      if (!unchanged) writeConfig(merged);
      const eff = loadRegistry();
      return out({ ok: true, file: CONFIG_FILE, changed: !unchanged, warnings: v.warnings, effective: effectiveSummary(eff) });
    }
    default:
      process.stdout.write('configure.mjs detect | show [--md] | validate | apply --answers <file|->\n');
      process.exitCode = cmd ? 1 : 0;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => fail(e.message));
}
