#!/usr/bin/env node
// End-to-end smoke of /orchestrator:auto with the REAL claude CLI on a throwaway git repo: one tiny task, cheapest
// adequate models (the router's choice for an S task), accelerated waiting and one injected limit event.
// Spends a small amount of the user's Claude usage (a few headless calls). Usage: node auto-smoke.mjs [--keep] [--timeout-min 25]
// Isolation: ORCH_HOME points at a temp dir holding only a copy of the user's config.yaml, so nothing in ~/.claude/orchestrator changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const timeoutMin = Number(args[args.indexOf('--timeout-min') + 1]) || 25;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-auto-smoke-'));
const HOME = path.join(TMP, 'orch-home');
const REPO = path.join(TMP, 'repo');
fs.mkdirSync(HOME, { recursive: true });
const realCfg = path.join(os.homedir(), '.claude', 'orchestrator', 'config.yaml');
if (fs.existsSync(realCfg)) fs.copyFileSync(realCfg, path.join(HOME, 'config.yaml'));
const ENV = { ...process.env, ORCH_HOME: HOME, ORCH_CONFIG: path.join(HOME, 'config.yaml'), ORCH_AUTO_WAIT_SCALE: '0.001', ORCH_AUTO_INJECT: JSON.stringify({ reset_in_s: 8 }) };

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${String(detail).slice(0, 400)})`}`); };
const run = (cmd, a, cwd, env = ENV) => spawnSync(cmd, a, { cwd, encoding: 'utf8', env, windowsHide: true });
const git = (...a) => run('git', a, REPO);
const auto = (a, cwd = REPO) => { const r = run(process.execPath, [path.join(HERE, 'auto.mjs'), ...a], cwd); let json = null; try { json = JSON.parse(r.stdout); } catch { /* text */ } return { ...r, json }; };

// ---- throwaway repo with a tiny task
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
git('init', '-q', '-b', 'main');
for (const [k, v] of [['user.email', 'smoke@example.invalid'], ['user.name', 'smoke'], ['core.autocrlf', 'false']]) git('config', k, v);
fs.writeFileSync(path.join(REPO, 'check.mjs'), "import fs from 'node:fs';\nconst t = fs.existsSync('src/hello.txt') ? fs.readFileSync('src/hello.txt', 'utf8').trim() : '';\nif (t !== 'hello smoke') { console.error('src/hello.txt must contain exactly: hello smoke'); process.exit(1); }\nconsole.log('ok');\n");
fs.writeFileSync(path.join(REPO, 'README.md'), '# smoke repo\n');
fs.writeFileSync(path.join(REPO, '.gitignore'), 'node_modules/\n');
git('add', '-A'); git('commit', '-qm', 'init');
const mainBefore = git('rev-parse', 'main').stdout.trim();

// ---- contract (what the skill would build from the interview)
const answers = path.join(TMP, 'answers.json');
fs.writeFileSync(answers, JSON.stringify({
  slug: 'smoke', goal: 'Create the file src/hello.txt containing exactly the line "hello smoke" so that `node check.mjs` passes.',
  definition_of_done: ['`node check.mjs` exits 0', 'only src/hello.txt is added'], verify: { test: 'node check.mjs' },
  families: { allow: ['claude'] }, protected_paths: ['README.md'], notify: { channel: 'file' },
  task_hint: { complexity: 'S', files: 1, criteria: 2, risk: 'low' }, budgets: { task_attempts: 2, no_progress_min: 30, tick_timeout_min: 10, idle_timeout_min: 5, max_dispatches: 30 },
  limits: { soft_pct: 80, hard_pct: 95, weekly_soft_pct: 90, weekly_hard_pct: 97, reserve_pct: 5, safety_margin_min: 1 },
}));
const draft = auto(['draft', '--answers', answers]);
check('draft: contract + allowlist + feasibility', draft.json?.ok && draft.json.permissions.hash, draft.stdout + draft.stderr);
if (!draft.json?.ok) process.exit(finish());
const id = draft.json.run_id;
const dir = draft.json.dir;

const pre = auto(['preflight', '--run', id, '--skip-doctor']);
check('preflight: clean tree, worktree, claude CLI, one live headless probe', pre.json?.ok, JSON.stringify(pre.json?.checks?.filter((c) => !c.ok)) || pre.stdout + pre.stderr);
if (!pre.json?.ok) process.exit(finish());

// ---- start: must return promptly and leave a detached supervisor
const t0 = Date.now();
const started = auto(['start', '--run', id, '--go', '--hash', draft.json.permissions.hash]);
check('start returns promptly (supervisor is detached, no inherited stdio)', started.json?.started && Date.now() - t0 < 30000 && started.stderr === '', started.stdout + started.stderr);

// ---- wait for the end; collect everything the run could have printed
const deadline = Date.now() + timeoutMin * 60000;
let last = null;
const seen = new Set();
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  try { last = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { continue; }
  seen.add(last.status);
  if (['completed', 'blocked', 'aborted', 'stopped', 'handed_over'].includes(last.status)) break;
}
check('run reached a final state without any help', ['completed', 'blocked'].includes(last?.status), `status=${last?.status} seen=${[...seen].join(',')}`);

// ---- evidence
const wt = path.join(dir, 'worktree');
const branch = `auto/${id}`;
const log = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
check('nothing was printed by the run: start printed one JSON object and exited; the supervisor only logs diagnostics to its own file', started.stderr === '' && started.json?.ok === true, log('supervisor.log').slice(0, 300));
check('branch auto/<id> exists and the worktree is used', git('rev-parse', '--verify', '-q', branch).status === 0 && fs.existsSync(path.join(wt, 'src', 'hello.txt')) && fs.readFileSync(path.join(wt, 'src', 'hello.txt'), 'utf8').trim() === 'hello smoke');
check('main and the user checkout are untouched', git('rev-parse', 'main').stdout.trim() === mainBefore && git('status', '--porcelain').stdout.trim() === '' && !fs.existsSync(path.join(REPO, 'src', 'hello.txt')) && git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim() === 'main');
const checkpoints = git('log', '--format=%s', `${mainBefore}..${branch}`).stdout.split('\n').filter((l) => l.startsWith('[auto]'));
check('checkpoint commit(s) and tag(s) present', checkpoints.length >= 1 && git('tag', '--list', `auto/${id}/*`).stdout.trim() !== '', checkpoints.join(' | '));
check('injected limit event handled as a wait, not a failure (LIMIT + WAIT + WAKE logged, no failed attempts)', /LIMIT/.test(log('limits.log')) && /WAIT/.test(log('limits.log')) && /WAKE/.test(log('limits.log')) && (last?.tasks || []).every((t) => !t.failures), log('limits.log').slice(0, 500));
check('no push possible/recorded: no remote configured and no push in the supervisor log', git('remote').stdout.trim() === '' && !/push/i.test(log('supervisor.log')));
for (const f of ['journal.md', 'decisions.jsonl', 'limits.log', 'report.md', 'state.json', 'contract.yaml']) check(`run file ${f} exists`, fs.existsSync(path.join(dir, f)) && fs.statSync(path.join(dir, f)).size > 0 || f === 'decisions.jsonl' && fs.existsSync(path.join(dir, f)));
const report = auto(['report', '--run', id]).stdout;
check('report is complete, Polish and readable (status, table, decisions, limits, commands, nothing pushed)', /Autonomiczny przebieg/.test(report) && /\|/.test(report) && /Nic nie zostało wypchnięte/.test(report) && /limit/i.test(report) && /merge/.test(report) && report.length > 800, report.slice(0, 600));
const status = auto(['status', '--run', id]).stdout;
check('status is read-only text', /smoke/.test(status) && /zakończony/.test(status), status.slice(0, 300));
const notes = log('notifications.log');
check('completion notification logged with generic text only', /./.test(notes) && !/hello|smoke|src\//.test(notes), notes.slice(0, 300));

fs.writeFileSync(path.join(TMP, 'report.md'), report);
console.log(`\nRun dir: ${dir}\nReport: ${path.join(TMP, 'report.md')}`);
process.exit(finish());

function finish() {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  if (!keep && bad.length === 0) {
    try { spawnSync('git', ['worktree', 'remove', '--force', path.join(dir || '', 'worktree')], { cwd: REPO }); } catch { /* best effort */ }
    console.log(`(temp dir kept at ${TMP} for inspection; pass nothing to delete manually)`);
  }
  return bad.length ? 1 : 0;
}
void spawn;
