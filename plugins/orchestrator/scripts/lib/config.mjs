// User configuration (~/.claude/orchestrator/config.yaml): which families and plans the user has, privacy overrides,
// main-session family, per-repo orchestrator default. Never holds secrets. Standalone (imported by common.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseYaml } from './yaml-lite.mjs';

export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_FILE = process.env.ORCH_CONFIG || path.join(process.env.ORCH_HOME || path.join(os.homedir(), '.claude', 'orchestrator'), 'config.yaml');

const TOP_KEYS = ['schema_version', 'main_family', 'families', 'defaults', 'privacy', 'updated'];
const FAMILY_KEYS = ['enabled', 'plans', 'data_policy'];
const POLICY_KEYS = ['training_on_data', 'sensitive_ok'];
const TRAINING_VALUES = [true, false, 'unknown', 'user_setting'];
const ORCHESTRATORS = ['global', 'project', 'ask'];
const SENSITIVITIES = ['none', 'internal', 'sensitive'];
export const SECRET_KEY = /secret|token|passw|api_?key|credential|auth/i;
export const SECRET_VALUE = /sk-[A-Za-z0-9_-]{16,}|-----BEGIN|xox[abprs]-|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|xai-[A-Za-z0-9]{16,}/;

export function readConfig(file = CONFIG_FILE) {
  if (!fs.existsSync(file)) return { config: null, error: null, file };
  try {
    return { config: parseYaml(fs.readFileSync(file, 'utf8')) || {}, error: null, file };
  } catch (e) {
    return { config: null, error: `config unreadable: ${e.message}`, file };
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// families: registry.families (catalog) so the schema is generic over the registry, not tied to known vendors.
export function validateConfig(cfg, families) {
  const errors = [];
  const warnings = [];
  if (!isObj(cfg)) return { ok: false, errors: ['config must be a map'], warnings };
  for (const k of Object.keys(cfg)) if (!TOP_KEYS.includes(k)) errors.push(`unknown key "${k}"`);
  if (cfg.schema_version !== CONFIG_SCHEMA_VERSION) errors.push(`schema_version must be ${CONFIG_SCHEMA_VERSION}`);
  if (cfg.main_family !== undefined && !families[cfg.main_family]) errors.push(`main_family "${cfg.main_family}" is not a registry family (${Object.keys(families).join(', ')})`);
  if (!isObj(cfg.families) || !Object.keys(cfg.families).length) errors.push('families must be a non-empty map');
  for (const [fid, f] of Object.entries(isObj(cfg.families) ? cfg.families : {})) {
    const at = `families.${fid}`;
    if (!families[fid]) { errors.push(`${at}: unknown family`); continue; }
    if (!isObj(f)) { errors.push(`${at} must be a map`); continue; }
    for (const k of Object.keys(f)) if (!FAMILY_KEYS.includes(k)) errors.push(`${at}: unknown key "${k}"`);
    if (typeof f.enabled !== 'boolean') errors.push(`${at}.enabled must be true|false`);
    if (f.enabled) {
      if (!Array.isArray(f.plans) || !f.plans.length || f.plans.some((p) => typeof p !== 'string' || !p)) errors.push(`${at}.plans must be a non-empty list of plan ids`);
      else for (const p of f.plans) if (!families[fid].plans?.[p]) warnings.push(`${at}.plans: "${p}" is not in the catalog (treated as a custom plan with conservative defaults)`);
    }
    if (f.data_policy !== undefined) {
      if (!isObj(f.data_policy)) errors.push(`${at}.data_policy must be a map`);
      else {
        for (const k of Object.keys(f.data_policy)) if (!POLICY_KEYS.includes(k)) errors.push(`${at}.data_policy: unknown key "${k}"`);
        if (f.data_policy.sensitive_ok !== undefined && typeof f.data_policy.sensitive_ok !== 'boolean') errors.push(`${at}.data_policy.sensitive_ok must be true|false`);
        if (f.data_policy.training_on_data !== undefined && !TRAINING_VALUES.includes(f.data_policy.training_on_data)) errors.push(`${at}.data_policy.training_on_data must be true|false|unknown|user_setting`);
      }
    }
  }
  if (cfg.main_family && isObj(cfg.families) && cfg.families[cfg.main_family]?.enabled === false) errors.push('main_family must be an enabled family');
  if (cfg.defaults !== undefined) {
    if (!isObj(cfg.defaults)) errors.push('defaults must be a map');
    else {
      for (const k of Object.keys(cfg.defaults)) if (k !== 'orchestrator') errors.push(`defaults: unknown key "${k}"`);
      if (cfg.defaults.orchestrator !== undefined && !ORCHESTRATORS.includes(cfg.defaults.orchestrator)) errors.push(`defaults.orchestrator must be ${ORCHESTRATORS.join('|')}`);
    }
  }
  if (cfg.privacy !== undefined) {
    if (!isObj(cfg.privacy)) errors.push('privacy must be a map');
    else {
      for (const k of Object.keys(cfg.privacy)) if (!['sensitive_globs', 'default_sensitivity'].includes(k)) errors.push(`privacy: unknown key "${k}"`);
      if (cfg.privacy.default_sensitivity !== undefined && !SENSITIVITIES.includes(cfg.privacy.default_sensitivity)) errors.push(`privacy.default_sensitivity must be ${SENSITIVITIES.join('|')}`);
      if (cfg.privacy.sensitive_globs !== undefined && (!Array.isArray(cfg.privacy.sensitive_globs) || cfg.privacy.sensitive_globs.some((g) => typeof g !== 'string'))) errors.push('privacy.sensitive_globs must be a list of strings');
    }
  }
  const walk = (v, p) => {
    if (typeof v === 'string' && SECRET_VALUE.test(v)) errors.push(`${p}: looks like a secret; config must not store secrets`);
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (SECRET_KEY.test(k)) errors.push(`${p}.${k}: secret-like key; config must not store secrets`); walk(x, `${p}.${k}`); }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
  };
  walk(cfg, 'config');
  return { ok: errors.length === 0, errors, warnings };
}

const scalar = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));
const list = (a) => `[${a.map(scalar).join(', ')}]`;

// Deterministic block-YAML writer for the (small, known) config shape.
export function serializeConfig(cfg) {
  const L = ['# Orchestrator user configuration. Written by /orchestrator:configure; safe to edit by hand.', '# Never put secrets here. Validate: node <plugin>/scripts/configure.mjs validate', ''];
  L.push(`schema_version: ${cfg.schema_version}`);
  if (cfg.main_family) L.push(`main_family: ${scalar(cfg.main_family)}`);
  L.push('families:');
  for (const [fid, f] of Object.entries(cfg.families)) {
    L.push(`  ${fid}:`, `    enabled: ${f.enabled}`);
    if (f.plans) L.push(`    plans: ${list(f.plans)}`);
    if (f.data_policy && Object.keys(f.data_policy).length) {
      L.push('    data_policy:');
      for (const [k, v] of Object.entries(f.data_policy)) L.push(`      ${k}: ${scalar(v)}`);
    }
  }
  if (cfg.defaults) L.push('defaults:', ...Object.entries(cfg.defaults).map(([k, v]) => `  ${k}: ${scalar(v)}`));
  if (cfg.privacy) {
    L.push('privacy:');
    if (cfg.privacy.default_sensitivity) L.push(`  default_sensitivity: ${scalar(cfg.privacy.default_sensitivity)}`);
    if (cfg.privacy.sensitive_globs) L.push(`  sensitive_globs: ${list(cfg.privacy.sensitive_globs)}`);
  }
  if (cfg.updated) L.push(`updated: ${scalar(cfg.updated)}`);
  return `${L.join('\n')}\n`;
}

// Atomic write; the previous file is kept as config.yaml.bak.
export function writeConfig(cfg, file = CONFIG_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serializeConfig(cfg));
  fs.renameSync(tmp, file);
  return file;
}
