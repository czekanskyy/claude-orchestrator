#!/usr/bin/env node
// v2 -> v3 migration helper. State (usage.jsonl, projects.yaml, pools/, runs/) already lives in ~/.claude/orchestrator and
// is read unchanged by v3 (pool ids are stable), so migrating means: back up, validate the data, retire the v2 files.
//   plan                      what v2 left on this machine
//   backup                    copy v2 skills/agents (+ small state files) to ~/.claude/orchestrator/backup-v2-<date>[-n]
//   validate-state            parse usage.jsonl and projects.yaml
//   cleanup --approved        remove the v2 skills and orch-* agents (needs a backup and the installed plugin); leaves a
//                             forwarding statusline shim at the old path so settings.json need not change
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseYaml } from './lib/yaml-lite.mjs';
import { parseArgs, out, fail, ensureDir, STATE_DIR, USAGE_LOG, PROJECTS_FILE } from './lib/common.mjs';

const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const V2_SKILLS = ['orchestrator', 'orchestrator-update'].map((n) => path.join(CLAUDE, 'skills', n));
const AGENTS_DIR = path.join(CLAUDE, 'agents');
const v2Agents = () => (fs.existsSync(AGENTS_DIR) ? fs.readdirSync(AGENTS_DIR).filter((f) => /^orch-.*\.md$/.test(f)).map((f) => path.join(AGENTS_DIR, f)) : []);
const SHIM = path.join(CLAUDE, 'skills', 'orchestrator', 'scripts', 'statusline.mjs');
const today = () => new Date().toISOString().slice(0, 10);

export const v2Present = () => ({ skills: V2_SKILLS.filter((p) => fs.existsSync(path.join(p, 'SKILL.md'))), agents: v2Agents() });

function copyDir(src, dst) { fs.cpSync(src, dst, { recursive: true }); }

export function backup() {
  const found = v2Present();
  if (!found.skills.length && !found.agents.length) return { ok: true, nothing_to_back_up: true };
  let dest = path.join(STATE_DIR, `backup-v2-${today()}`);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(STATE_DIR, `backup-v2-${today()}-${n}`);
  ensureDir(dest);
  const manifest = { created: new Date().toISOString(), skills: [], agents: [], state: [] };
  for (const s of found.skills) { copyDir(s, path.join(dest, 'skills', path.basename(s))); manifest.skills.push(s); }
  for (const f of found.agents) { fs.mkdirSync(path.join(dest, 'agents'), { recursive: true }); fs.copyFileSync(f, path.join(dest, 'agents', path.basename(f))); manifest.agents.push(f); }
  for (const f of [USAGE_LOG, PROJECTS_FILE]) if (fs.existsSync(f)) { fs.mkdirSync(path.join(dest, 'state'), { recursive: true }); fs.copyFileSync(f, path.join(dest, 'state', path.basename(f))); manifest.state.push(f); }
  fs.writeFileSync(path.join(dest, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  return { ok: true, backup: dest, skills: manifest.skills.length, agents: manifest.agents.length, state_files: manifest.state.length };
}

export function validateState() {
  const res = { usage: { rows: 0, bad: 0 }, projects: { ok: true, repos: 0 } };
  if (fs.existsSync(USAGE_LOG)) {
    for (const line of fs.readFileSync(USAGE_LOG, 'utf8').split(/\r?\n/).filter(Boolean)) { try { JSON.parse(line); res.usage.rows++; } catch { res.usage.bad++; } }
  }
  if (fs.existsSync(PROJECTS_FILE)) {
    try { res.projects.repos = Object.keys(parseYaml(fs.readFileSync(PROJECTS_FILE, 'utf8'))?.projects || {}).length; } catch (e) { res.projects = { ok: false, error: e.message }; }
  }
  res.ok = res.usage.bad === 0 && res.projects.ok;
  return res;
}

function latestBackup() {
  if (!fs.existsSync(STATE_DIR)) return null;
  const d = fs.readdirSync(STATE_DIR).filter((n) => /^backup-v2-/.test(n)).sort().pop();
  return d && fs.existsSync(path.join(STATE_DIR, d, 'MANIFEST.json')) ? path.join(STATE_DIR, d) : null;
}

// The shim runs wherever settings.json's old statusline path points; it forwards to the installed plugin's script.
const SHIM_SOURCE = `// Forwarding shim left by the orchestrator v3 migration: settings.json still points here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const claude = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
try {
  const reg = JSON.parse(fs.readFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {};
  const entry = Object.entries(reg).find(([k]) => k.startsWith('orchestrator@'))?.[1]?.[0];
  const target = entry && path.join(entry.installPath, 'scripts', 'statusline.mjs');
  if (target && fs.existsSync(target)) await import(pathToFileURL(target).href);
} catch { /* a statusline must never throw */ }
`;

export function installedPlugin() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {};
    const e = Object.entries(reg).find(([k]) => k.startsWith('orchestrator@'));
    return e ? { id: e[0], ...e[1][0] } : null;
  } catch { return null; }
}

export function cleanup() {
  const bk = latestBackup();
  if (!bk) throw new Error('no v2 backup found: run backup first');
  const plugin = installedPlugin();
  if (!plugin) throw new Error('orchestrator plugin is not installed: refusing to remove v2');
  const removed = { skills: [], agents: [] };
  for (const s of V2_SKILLS) if (fs.existsSync(s)) { fs.rmSync(s, { recursive: true, force: true }); removed.skills.push(s); }
  for (const f of v2Agents()) {
    const saved = path.join(bk, 'agents', path.basename(f));
    if (fs.existsSync(saved) && fs.readFileSync(saved).equals(fs.readFileSync(f))) { fs.rmSync(f); removed.agents.push(f); }
  }
  fs.mkdirSync(path.dirname(SHIM), { recursive: true });
  fs.writeFileSync(SHIM, SHIM_SOURCE);
  return { ok: true, backup: bk, plugin: `${plugin.id}@${plugin.version}`, removed, statusline_shim: SHIM, note: 'the shim has no SKILL.md, so it is not a skill; point statusLine.command at the plugin path to retire it' };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest, { flags: ['approved'] });
  switch (cmd) {
    case 'plan': return out({ v2: v2Present(), state_dir: STATE_DIR, state: validateState(), latest_backup: latestBackup(), plugin: installedPlugin() });
    case 'backup': return out(backup());
    case 'validate-state': { const r = validateState(); return out(r, r.ok ? 0 : 1); }
    case 'cleanup': return a.approved ? out(cleanup()) : fail('cleanup removes the v2 files: pass --approved after the backup and doctor passed');
    default: process.stdout.write('migrate.mjs plan | backup | validate-state | cleanup --approved\n'); process.exitCode = cmd ? 1 : 0;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch((e) => fail(e.message));
