// Self-tests of the EGM mode (`selftest.mjs egm`; the autonomous-engine part runs inside `selftest.mjs auto`).
// No model calls: a fake `egm` plugin tree stands in for the installed one (ORCH_EGM_DIR), the engine runs with fake workers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PERSONAS = { zoom_out: 'egm-zoom-out', comprehension: 'egm-comprehension', design_critic: 'egm-design', structural: 'egm-structural', style: 'egm-style', implementation_readiness: 'egm-implementation-readiness', codebase_details: 'egm-codebase-details', synthesizer: 'egm-synthesizer' };
const SKILLS = ['egm-brainstorm', 'egm-draft', 'egm-review', 'egm-review-loop', 'egm-resolve', 'egm-drift-report'];

// A minimal tree with the layout of the real plugin (what lib/egm.mjs checks and reads), so the tests do not depend on the machine.
export function mkFakeEgm(dir, { version = '0.1.0', skip = [] } = {}) {
  const put = (rel, text) => { if (skip.includes(rel)) return; const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  for (const s of SKILLS) put(`skills/${s}/SKILL.md`, `---\nname: ${s}\ndisable-model-invocation: true\n---\n# ${s}\nfixture skill ${version}\n`);
  put('skills/egm-draft/references/design_doc.md', '# [Feature]\n## Overview\n## Detailed Implementation Plan\n');
  for (const [f, name] of Object.entries(PERSONAS)) { put(`agents/${f}.md`, `---\nname: ${name}\n---\n# Persona ${name}\nFixture persona text for ${name}.\n`); put(`.claude-plugin/agents/${f}.md`, `---\nname: ${name}\n---\nadapter\n`); }
  for (const r of ['resources/execution_instructions.md', 'resources/document_standards/feature-spec-standard.md', 'resources/document_standards/implementation-readiness-standard.md', 'resources/document_standards/zoom-out-standard.md', 'docs/claude.md']) put(r, `# ${r}\nfixture standard text\n`);
  put('.claude-plugin/plugin.json', JSON.stringify({ name: 'egm', version }));
  return dir;
}

export async function egmScenario(ctx) {
  const { check, TMP, HERE, common, log } = ctx;
  const S = 'egm';
  const L = (n) => import(pathToFileURL(path.join(HERE, n)).href);
  const egmLib = await L('lib/egm.mjs');
  const gateLib = await L('egm-gate.mjs');
  const cfgLib = await L('lib/config.mjs');
  const triageLib = await L('triage.mjs');
  const doctorLib = await L('doctor.mjs');
  const updateLib = await L('update.mjs');
  const dryLib = await L('dryrun.mjs');
  const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'egm-rubric.json'), 'utf8'));
  const node = (script, args, env = {}, input) => { const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: 'utf8', input, env: { ...process.env, ...env } }); let json = null; try { json = JSON.parse(r.stdout); } catch { /* text */ } return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }; };
  const fake = process.env.ORCH_EGM_DIR;
  const withEgm = (dir, fn) => { const saved = process.env.ORCH_EGM_DIR; process.env.ORCH_EGM_DIR = dir; try { return fn(); } finally { process.env.ORCH_EGM_DIR = saved; } };
  const reg = common.loadRegistry();
  const withEgmSettings = (egm) => { const r = common.loadRegistry(); r.meta.egm = egm; return r; };

  // ---------------------------------------------------------------- the critical rubric
  log('\n=== EGM: critical rubric, gate, consent ===');
  for (const text of fx.critical) {
    const t = triageLib.triage(text, reg);
    const r = egmLib.egmRubric({ cls: t.class, text, riskHint: t.risk_hint });
    check(S, `rubric: critical "${text.slice(0, 50)}…"`, r.critical === true && r.categories.length > 0, JSON.stringify({ cls: t.class, r }));
  }
  for (const text of fx.not_critical) {
    const t = triageLib.triage(text, reg);
    const r = egmLib.egmRubric({ cls: t.class, text, riskHint: t.risk_hint });
    check(S, `rubric: not critical "${text.slice(0, 50)}"`, r.critical === false, JSON.stringify({ cls: t.class, r }));
  }
  const cat = (text, cls = 'complex') => egmLib.egmRubric({ cls, text }).categories;
  check(S, 'rubric categories: architecture, hard-to-reverse, cross-subsystem and high-risk-large are told apart', cat('Redesign the module architecture around a new service').includes('architecture') && cat('Add a payment refund flow with a database migration').includes('hard_to_reverse') && cat('Rename the helpers', 'huge').includes('cross_subsystem') && cat('Touch src/a/x.ts, lib/b/y.ts and web/c/z.ts to align the naming').includes('cross_subsystem') && egmLib.egmRubric({ cls: 'complex', text: 'Change the cache', task: { risk: 'high', complexity: 'L' } }).categories.includes('high_risk_large'));
  check(S, 'rubric: a simple request is never EGM material, even with auth words (triage may flag it, EGM does not)', egmLib.egmRubric({ cls: 'simple', text: 'Fix the typo in the login and password labels' }).critical === false && triageLib.triage('Fix the typo in the login and password labels', reg).critical === true);

  // ---------------------------------------------------------------- the gate: consent logic
  const crit = fx.critical[1];
  const base = { class: 'complex', text: crit, reg };
  const ask = gateLib.egmGate(base);
  check(S, 'gate: a critical task asks first (never runs by itself) with a cost estimate and a 3-option question', ask.action === 'ask' && ask.consent === null && ask.estimate?.agents >= 10 && ask.question.options.length === 3 && ['Uruchom EGM', 'Zwykły przepływ', 'Anuluj'].every((l) => ask.question.options.some((o) => o.label === l)) && /\d+ agentów/.test(ask.question.question), JSON.stringify(ask).slice(0, 300));
  check(S, 'gate: the estimate is agent count x model tier from the registry (Elephant heavy, Goldfish standard) with the pool effect', ask.estimate.units > 0 && ask.estimate.pools.length > 0 && /Elephant/.test(ask.estimate.summary));
  const yes = gateLib.egmGate({ ...base, answer: 'run' });
  const no = gateLib.egmGate({ ...base, answer: 'normal' });
  const stop = gateLib.egmGate({ ...base, answer: 'cancel' });
  check(S, 'gate: only the user\'s yes starts EGM (answer run -> egm); normal -> continue; cancel -> stop', yes.action === 'egm' && yes.consent === true && yes.consent_by === 'user' && no.action === 'continue' && no.consent === false && stop.action === 'stop');
  const flag = gateLib.egmGate({ ...base, explicit: true });
  const flagOnSimple = gateLib.egmGate({ class: 'simple', text: 'Fix the typo in README.md', explicit: true, reg });
  check(S, 'gate: --egm is the consent (no question), also for a task the rubric would not flag', flag.action === 'egm' && flag.consent_by === 'flag' && flagOnSimple.action === 'egm');
  const offCfg = gateLib.egmGate({ ...base, reg: withEgmSettings({ mode: 'off' }) });
  const offRepo = gateLib.egmGate({ ...base, setting: 'off', reg: (() => { const r = common.loadRegistry(); r.meta.repo_rules = { egm: 'off' }; return r; })() });
  check(S, 'gate: egm off in config.yaml or in the repo profile -> normal flow, nothing proposed; an explicit --egm still wins', offCfg.action === 'continue' && /off \(config\.yaml/.test(offCfg.note) && offRepo.action === 'continue' && /repo profile/.test(offRepo.note) && gateLib.egmGate({ ...base, reg: withEgmSettings({ mode: 'off' }), explicit: true }).action === 'egm');
  check(S, 'gate: not critical -> continue without a question', gateLib.egmGate({ class: 'complex', text: fx.not_critical[3], reg }).action === 'continue');
  const absent = withEgm(path.join(TMP, 'no-such-egm'), () => ({ implicit: gateLib.egmGate(base), explicit: gateLib.egmGate({ ...base, explicit: true }), status: egmLib.egmStatus() }));
  check(S, 'plugin absent: the implicit proposal degrades to ONE line with the install hint and the normal flow; no question, no run', absent.implicit.action === 'continue' && absent.implicit.unavailable === true && !absent.implicit.note.includes('\n') && absent.implicit.note.includes('claude plugin marketplace add google/elephant-goldfish-model') && absent.status.present === false);
  check(S, 'plugin absent + explicit --egm: action unavailable with the install hint and a normal-flow / cancel question (never a silent skip, never a run)', absent.explicit.action === 'unavailable' && absent.explicit.question.options.map((o) => o.label).join() === 'Zwykły przepływ,Anuluj' && absent.explicit.question.question.includes('claude plugin install egm@egm'));
  const incomplete = withEgm(mkFakeEgm(path.join(TMP, 'egm-incomplete'), { skip: ['skills/egm-review/SKILL.md', 'agents/design_critic.md'] }), () => ({ g: gateLib.egmGate(base), st: egmLib.egmStatus() }));
  check(S, 'plugin incomplete (a skill and a persona missing): detected, named, treated like absent', incomplete.st.ok === false && incomplete.st.missing.includes('egm-review') && incomplete.g.action === 'continue' && /incomplete/.test(incomplete.g.note));
  // autonomous: only the contract's pre-consent counts, nobody is asked
  const cOn = { egm: { allow: true } };
  const cOff = { egm: { allow: false } };
  const autoOn = gateLib.egmGate({ ...base, contract: cOn });
  const autoOff = gateLib.egmGate({ ...base, contract: cOff });
  const autoNoPlugin = withEgm(path.join(TMP, 'no-such-egm'), () => gateLib.egmGate({ ...base, contract: cOn }));
  check(S, 'autonomous: pre-consent in the contract -> egm (consent_by contract); without it -> continue, never a question; plugin absent -> continue', autoOn.action === 'egm' && autoOn.consent_by === 'contract' && autoOn.mode === 'autonomous' && autoOff.action === 'continue' && autoOff.consent === false && /without EGM pre-consent/.test(autoOff.note) && autoNoPlugin.action === 'continue' && !autoNoPlugin.question);
  check(S, 'autonomous: legacy callers (critical flag, no text) keep working: allow true -> egm, allow false -> continue, no contract -> ask-able', gateLib.egmGate({ critical: true, setting: 'ask', contract: cOn }).action === 'egm' && gateLib.egmGate({ critical: true, setting: 'ask', contract: cOff }).action === 'continue' && gateLib.egmGate({ critical: true }).consent === null);
  // invariant sweep: whatever the inputs, action egm implies a recorded consent
  let violations = 0; let combos = 0;
  for (const explicit of [false, true]) for (const answer of [null, 'run', 'normal', 'cancel']) for (const contract of [null, cOn, cOff]) for (const mode of ['ask', 'off']) for (const cls of ['simple', 'complex', 'huge']) for (const text of [crit, fx.not_critical[0]]) {
    const g = gateLib.egmGate({ class: cls, text, explicit, answer, contract, reg: withEgmSettings({ mode }) });
    combos++;
    if (g.action === 'egm' && !(g.consent === true && ['flag', 'user', 'contract'].includes(g.consent_by))) violations++;
    if (g.action === 'egm' && !explicit && answer !== 'run' && !(contract && contract.egm.allow)) violations++;
  }
  check(S, `gate invariant over ${combos} input combinations: EGM never starts without --egm, the user's yes or the contract's pre-consent`, violations === 0, String(violations));
  const cli = node('egm-gate.mjs', ['--class', 'complex', '--text', crit]);
  const cliYes = node('egm-gate.mjs', ['--class', 'complex', '--text', crit, '--answer', 'run']);
  check(S, 'gate CLI: prints one JSON, ask without an answer, egm with --answer run; a bad answer is refused', cli.json?.action === 'ask' && cliYes.json?.action === 'egm' && node('egm-gate.mjs', ['--class', 'complex', '--text', crit, '--answer', 'maybe']).code !== 0);

  // ---------------------------------------------------------------- config switch
  const fams = common.loadRegistry(undefined, { config: null }).families;
  const baseCfg = JSON.parse(JSON.stringify(cfgLib.readConfig(process.env.ORCH_CONFIG).config));
  const okForms = ['ask', 'off', { mode: 'off' }, { mode: 'ask', review: 'feature', goldfish: 'cross' }];
  const badForms = ['maybe', { mode: 'sometimes' }, { review: 'half' }, { goldfish: 'all' }, { surprise: 1 }, 7];
  check(S, 'config: egm accepts ask|off or a map (mode/review/goldfish); bad values and unknown keys are rejected', okForms.every((v) => cfgLib.validateConfig({ ...baseCfg, egm: v }, fams).ok) && badForms.every((v) => !cfgLib.validateConfig({ ...baseCfg, egm: v }, fams).ok));
  const rt = (v) => { const f = path.join(TMP, `egm-rt-${Math.random().toString(36).slice(2)}.yaml`); fs.writeFileSync(f, cfgLib.serializeConfig({ ...baseCfg, egm: v })); const back = cfgLib.readConfig(f).config; return { text: fs.readFileSync(f, 'utf8'), back }; };
  const r1 = rt('off'); const r2 = rt({ mode: 'ask', review: 'plan', goldfish: 'cross' });
  check(S, 'config: scalar and map forms round-trip through serialize/read (scalar stays a one-liner)', /^egm: "off"$/m.test(r1.text) && r1.back.egm === 'off' && r2.back.egm.review === 'plan' && r2.back.egm.goldfish === 'cross' && /^egm:\n  mode: "ask"/m.test(r2.text));
  const home = path.join(TMP, 'egm-cfg-home');
  const env = { ORCH_HOME: home, ORCH_CONFIG: path.join(home, 'config.yaml'), ORCH_NO_OVERLAY: '1' };
  const af = path.join(TMP, 'egm-answers.json');
  fs.writeFileSync(af, JSON.stringify({ main_family: 'claude', families: { claude: { enabled: true, plans: ['claude_team'] } }, egm: 'off' }));
  const ap = node('configure.mjs', ['apply', '--answers', af], env);
  const shown = node('configure.mjs', ['show', '--md'], env).stdout;
  fs.writeFileSync(af, JSON.stringify({ egm: { review: 'feature' } }));
  const ap2 = node('configure.mjs', ['apply', '--answers', af], env);
  const after = cfgLib.readConfig(env.ORCH_CONFIG).config;
  const detect = node('configure.mjs', ['detect'], { ...env, ORCH_AGY_BIN: path.join(HERE, 'fixtures', 'mock-agy.mjs') });
  check(S, 'configure apply persists egm: off, merges a later partial map (mode kept), shows it, and detect reports plugin + effective settings', ap.code === 0 && /EGM .*: off/.test(shown) && ap2.code === 0 && after.egm.mode === 'off' && after.egm.review === 'feature' && detect.json?.egm?.plugin?.present === true && detect.json.egm.effective.mode === 'off', shown.slice(-200) + JSON.stringify(after));
  check(S, 'registry: reg.meta.egm carries the config and "off" in either place wins (readEgmSettings)', egmLib.readEgmSettings(withEgmSettings({ mode: 'off' })).mode === 'off' && egmLib.readEgmSettings(withEgmSettings({ review: 'plan', goldfish: 'cross' })).goldfish === 'cross' && egmLib.readEgmSettings((() => { const r = common.loadRegistry(); r.meta.repo_rules = { egm: 'off' }; r.meta.egm = {}; return r; })()).off_by === 'repo profile (egm)');

  // ---------------------------------------------------------------- doctor (offline)
  const okRows = doctorLib.egmRows(reg, egmLib.egmStatus());
  const goneRows = doctorLib.egmRows(reg, absent.status);
  const badRows = doctorLib.egmRows(reg, incomplete.st);
  const area = (rows, a) => rows.find((r) => r.area === a);
  check(S, 'doctor: plugin present -> version and reachable skills/personas, gate self-check (critical -> ask, trivial -> continue), cost line', area(okRows, 'egm plugin')?.status === 'ok' && /egm 0\.1\.0: 6 skills, 8 reviewer personas/.test(area(okRows, 'egm plugin').detail) && area(okRows, 'egm gate')?.status === 'ok' && /critical task → ask, trivial → continue/.test(area(okRows, 'egm gate').detail) && area(okRows, 'egm cost')?.status === 'ok', JSON.stringify(okRows.map((r) => [r.area, r.status, r.detail.slice(0, 60)])));
  check(S, 'doctor: plugin absent or incomplete -> a warning with the install hint (never a failure: EGM is optional); incomplete names what is missing', area(goneRows, 'egm plugin')?.status === 'warn' && /claude plugin install egm@egm/.test(area(goneRows, 'egm plugin').fix) && area(badRows, 'egm plugin')?.status === 'warn' && /egm-review/.test(area(badRows, 'egm plugin').detail));
  const drifted = withEgm(mkFakeEgm(path.join(TMP, 'egm-v2'), { version: '0.2.0' }), () => doctorLib.egmRows(reg));
  check(S, 'doctor: a newer plugin version than the one the briefs were written against -> an "egm drift" warning pointing to /orchestrator:update', area(drifted, 'egm drift')?.status === 'warn' && /0\.2\.0/.test(area(drifted, 'egm drift').detail) && /orchestrator:update/.test(area(drifted, 'egm drift').fix));
  check(S, 'doctor: the Elephant agent file is checked', fs.existsSync(path.join(HERE, '..', 'agents', 'egm-elephant.md')) && area(okRows, 'egm gate').status === 'ok');

  // ---------------------------------------------------------------- update: drift detection, stamp, nothing of the user's is touched
  const scanGone = withEgm(path.join(TMP, 'no-such-egm'), () => updateLib.egmScan(reg));
  const scanNew = withEgm(path.join(TMP, 'egm-v2'), () => updateLib.egmScan(reg));
  check(S, 'update: scan reports installed vs tested version and which tracked files changed; an absent plugin is "nothing to update", not an error', scanNew.drift === true && scanNew.version_changed === true && scanNew.changed.length > 0 && scanGone.present === false && /optional/.test(scanGone.next) && scanNew.sources.length >= 3);
  const regCopy = path.join(TMP, 'models-copy.yaml');
  fs.copyFileSync(path.join(HERE, '..', 'models.yaml'), regCopy);
  const logCopy = path.join(TMP, 'CHANGELOG-copy.md');
  fs.writeFileSync(logCopy, '# Changelog\n\n## old\n- x\n');
  const profDir = path.join(TMP, 'egm-state', 'repos');
  fs.mkdirSync(profDir, { recursive: true });
  fs.writeFileSync(path.join(profDir, 'profile-x.yaml'), 'decisions:\n  egm: off\n');
  fs.writeFileSync(path.join(TMP, 'egm-state', 'config.yaml'), 'schema_version: 1\n');
  const hashDir = (d) => crypto.createHash('sha1').update(fs.readdirSync(d, { recursive: true }).sort().map((f) => { const p = path.join(d, f); return fs.statSync(p).isFile() ? `${f}:${fs.readFileSync(p, 'utf8')}` : f; }).join('|')).digest('hex');
  const userBefore = hashDir(path.join(TMP, 'egm-state'));
  const uenv = { ORCH_REGISTRY: regCopy, ORCH_CHANGELOG: logCopy, ORCH_EGM_DIR: path.join(TMP, 'egm-v2'), ORCH_HOME: path.join(TMP, 'egm-state') };
  const dry = node('update.mjs', ['egm-stamp'], uenv);
  const stamped = node('update.mjs', ['egm-stamp', '--approved'], uenv);
  const rescan = node('update.mjs', ['scan'], uenv);
  const validate = node('registry.mjs', ['validate'], uenv);
  check(S, 'update: egm-stamp is a dry run without --approved; with it the tested version and fingerprint are recorded (registry still valid, CHANGELOG entry added), and the next scan shows no drift', dry.json?.dry_run === true && fs.readFileSync(regCopy, 'utf8').includes('tested_version: "0.1.0"') === false && stamped.json?.version === '0.2.0' && /## EGM plugin/.test(fs.readFileSync(logCopy, 'utf8')) && validate.json?.ok === true && rescan.json?.egm?.drift === false, JSON.stringify({ dry: dry.json, stamped: stamped.json, rescan: rescan.json?.egm, v: validate.json?.errors }));
  check(S, "update leaves the user's state alone: config.yaml and the per-repo profiles are byte-identical after scan + stamp", hashDir(path.join(TMP, 'egm-state')) === userBefore);

  // ---------------------------------------------------------------- the pass on disk: plan, briefs, state, report lines (zero model calls)
  log('\n=== EGM: plan, briefs, state, report ===');
  const run = node('run.mjs', ['init', '--slug', 'egm']).json;
  const D = run.dir;
  fs.writeFileSync(path.join(D, 'prompt.md'), '## Goal\nRedesign the payments module.\n');
  const planOut = node('egm.mjs', ['plan', '--run', D]);
  const ledger = JSON.parse(fs.readFileSync(path.join(D, 'ledger.json'), 'utf8'));
  const first = node('run.mjs', ['assign', '--run', D, '--json']).json;
  check(S, 'plan: estimate + ledger rows (🐘 Elephant, 🧩 synthesizers, 🐟 Goldfish) in waves; the first wave is the Elephant on the heavy-tier model', planOut.json?.ok && planOut.json.rows === 14 && ledger.rows.filter((r) => r.role === 'goldfish').length === 9 && ledger.rows.filter((r) => r.role === 'synthesizer').length === 4 && first.dispatch.length === 1 && first.dispatch[0].subagent_type === 'orchestrator:egm-elephant' && first.dispatch[0].model === 'opus' && /🐘/.test(first.show), JSON.stringify(first).slice(0, 300));
  const rows7 = ledger.rows.filter((r) => /^EG-s7/.test(r.id));
  check(S, 'plan: a synthesizer stage dispatches only the synthesizer (nested reviewers have no dispatch); the comprehension reviewer is dispatched directly', rows7.filter((r) => r.dispatch).length === 1 && rows7.find((r) => r.dispatch).dispatch.subagent_type === 'egm:egm-synthesizer' && ledger.rows.find((r) => r.id === 'EG-s6-comprehension').dispatch.subagent_type === 'egm:egm-comprehension');
  const designBrief = node('egm.mjs', ['brief', '--run', D, '--phase', 'design']);
  const bt = fs.readFileSync(designBrief.json.files[0], 'utf8');
  check(S, 'brief (design): points the Elephant at the REAL egm-draft skill and execution rules, sets the artifact directory, keeps "owner decides architecture", forbids production edits', bt.includes(path.join(fake, 'skills/egm-draft/SKILL.md')) && bt.includes('EGM artifact directory:') && /Owner decides architecture/i.test(bt) && /No production code|do not choose|do NOT choose/i.test(bt) && /"status":"questions\|drafted"/.test(bt));
  check(S, 'brief: the dispatch prompt is a one-line pointer to the brief file (the orchestrator context stays lean)', ledger.rows[0].dispatch.prompt.startsWith('Read ') && ledger.rows[0].dispatch.prompt.length < 400);
  const noDesign = node('egm.mjs', ['brief', '--run', D, '--phase', 'review', '--stage', '7']);
  fs.writeFileSync(path.join(D, 'egm', 'design.md'), '# D\n## Overview\nx\n## Detailed Implementation Plan\ny\n');
  const b7 = node('egm.mjs', ['brief', '--run', D, '--phase', 'review', '--stage', '7']);
  const b6 = node('egm.mjs', ['brief', '--run', D, '--phase', 'review', '--stage', '6']);
  const t7 = fs.readFileSync(b7.json.files[0], 'utf8');
  const t6 = fs.readFileSync(b6.json.files[0], 'utf8');
  check(S, 'brief (review): refuses without a design; stage 7 names the synthesizer, the three critic reviewers, the feature range, their standards and the model to spawn them on; stage 6 is a direct reviewer brief (no synthesizer)', noDesign.code !== 0 && b7.json.ranges.feature === '1-3' && /egm-synthesizer|agents[\\/]synthesizer\.md/.test(t7) && t7.includes('[egm-design, egm-structural, egm-style]') && t7.includes('feature-spec-standard.md') && /model: sonnet/.test(t7) && /Findings: <blockers>/.test(t6) && !/synthesizer/.test(t6));
  const rs = node('egm.mjs', ['brief', '--run', D, '--phase', 'resolve', '--stage', '7']);
  const rt_ = fs.readFileSync(rs.json.files[0], 'utf8');
  check(S, 'brief (resolve): the Elephant applies the real egm-resolve skill in auto-accept mode, escalates instead of fixing ESCALATE items', rt_.includes('skills') && rt_.includes('egm-resolve') && /auto accept/.test(rt_) && /escalated/.test(rt_));
  node('egm.mjs', ['save', '--run', D, '--name', 'comprehension_report.md'], {}, 'Findings: 0 blocker, 1 major, 2 nit\n');
  check(S, 'save: stores a reviewer reply in the run\'s reports directory (path-safe)', fs.existsSync(path.join(D, 'egm', 'reports', 'comprehension_report.md')) && node('egm.mjs', ['save', '--run', D, '--name', '../../evil.md'], {}, 'x').json.file.startsWith(path.join(D, 'egm', 'reports')));
  node('egm.mjs', ['record', '--run', D, '--stage', '7', '--blocker', '1', '--major', '2', '--nit', '3', '--applied', '3', '--contested', '0', '--escalated', '0', '--files-listed', '5', '--approved', 'true']);
  node('egm.mjs', ['record', '--run', D, '--stage', '9', '--not-run', 'egm-codebase-details']);
  const lines = node('egm.mjs', ['report-lines', '--run', D]).json.lines;
  check(S, 'report lines: design + approval, Goldfish stages/findings (a reviewer that did not run is named), drift status', lines.length === 3 && /zatwierdzony/.test(lines[0]) && /blokerów/.test(lines[1]) && /NIE uruchomiono: egm-codebase-details@9/.test(lines[1]) && /dryfu: nie wykonana/.test(lines[2]), lines.join(' | '));
  const rep = { title: 'Test', result: 'done', summary: 's', done: ['a'], tests: [], not_done: [], egm: lines };
  fs.writeFileSync(path.join(D, 'report.json'), JSON.stringify(rep));
  const rendered = node('run.mjs', ['report', '--run', D, '--data', path.join(D, 'report.json'), '--strict']);
  const noEgm = node('run.mjs', ['report', '--run', D, '--data', (() => { const f = path.join(D, 'r2.json'); fs.writeFileSync(f, JSON.stringify({ ...rep, egm: [] })); return f; })()]);
  check(S, 'final report: a compact "### EGM" section only when EGM ran, still within the 35-line cap', /### EGM/.test(rendered.stdout) && rendered.code === 0 && rendered.stdout.split('\n').length <= 35 && !/### EGM/.test(noEgm.stdout));
  const drift = node('egm.mjs', ['brief', '--run', D, '--phase', 'drift']);
  const dt = fs.readFileSync(drift.json.files[0], 'utf8');
  check(S, 'brief (drift): the real egm-drift-report procedure on the design for a fresh read-only reviewer; the drift row is added to the ledger once', dt.includes('egm-drift-report') && /No drift detected/.test(dt) && node('egm.mjs', ['brief', '--run', D, '--phase', 'drift']).code === 0 && JSON.parse(fs.readFileSync(path.join(D, 'ledger.json'), 'utf8')).rows.filter((r) => r.id === 'EG-drift').length === 1);

  // ---------------------------------------------------------------- dry run: gate -> cost -> question -> phases, zero model calls
  const dry1 = dryLib.dryRun(reg, fx.critical[0], {});
  const dry2 = dryLib.dryRun(reg, fx.critical[0], { explicit: true });
  const dry3 = dryLib.dryRun(reg, fx.not_critical[0], {});
  log(`\n--- dry run (critical sample)\n${dry1.text}`);
  check(S, 'dry run of a critical task: gate -> cost estimate -> consent question -> planned EGM phases, nothing started, zero model calls', dry1.model_calls === 0 && dry1.gate.action === 'ask' && /egm_gate: ask/.test(dry1.text) && /Cost: \d+ agents/.test(dry1.text) && /Question: .*EGM/.test(dry1.text) && /EGM phases if accepted/.test(dry1.text) && /EG-design Elephant/.test(dry1.text) && /Gosia|Grzesiek/.test(dry1.text));
  check(S, 'dry run: --egm skips the question and shows the phases; a trivial task shows no EGM at all', dry2.gate.action === 'egm' && !/Question:/.test(dry2.text) && /EGM phases if accepted/.test(dry2.text) && dry3.gate.action === 'continue' && !/EGM phases/.test(dry3.text));

  // ---------------------------------------------------------------- cross-family Goldfish: only where the privacy filter allows
  const xr = withEgmSettings({ goldfish: 'cross' });
  const xEst = egmLib.estimateEgm(xr, { crossFamily: true, sensitivity: 'internal' });
  const xRow = xEst.steps.find((s) => s.cross);
  const sensEst = egmLib.estimateEgm(xr, { crossFamily: true, sensitivity: 'sensitive' });
  const sensRow = sensEst.steps.find((s) => s.cross);
  check(S, 'cross-family Goldfish (goldfish: cross): one design-critic review by another family through its adapter, never Claude', xRow && xRow.family !== 'claude' && xRow.via === 'adapter' && /^run-/.test(xRow.dispatch.script) && xEst.agents >= 15);
  check(S, 'cross-family Goldfish honors privacy: for sensitive data it is used only if that family has sensitive_ok, else dropped with a note (Claude Goldfish only)', sensRow ? xr.families[sensRow.family].data_policy.sensitive_ok === true : sensEst.notes.some((n) => /cross-family Goldfish unavailable/.test(n)));
  const pr = egmLib.crossFamilyPrompt(egmLib.locateEgm(), { reviewer: 'egm-design', standard: 'feature-spec-standard', designFile: '/x/design.md', range: 'FeatureRange 1-10' });
  check(S, 'cross-family prompt inlines the canonical persona and standard (adapters have no plugin agents) and demands a fresh read-only review', /Persona egm-design/.test(pr) && /fixture standard text/.test(pr) && /fresh context/.test(pr) && /Read-only/.test(pr));
  check(S, 'skills: SKILL.md routes to egm-flow.md, never starts EGM without consent, and stays within its size budget; references exist', /egm-flow\.md/.test(fs.readFileSync(path.join(HERE, '..', 'skills', 'orchestrate', 'SKILL.md'), 'utf8')) && /Never start EGM without a yes/.test(fs.readFileSync(path.join(HERE, '..', 'skills', 'orchestrate', 'SKILL.md'), 'utf8')) && ['egm.md', 'egm-flow.md'].every((f) => fs.existsSync(path.join(HERE, '..', 'references', f))));
}

// ---------------------------------------------------------------- EGM inside an autonomous run (engine on a temp repo, fake workers)
export async function egmAutoScenario(h) {
  const { check, mkRepo, setupRun, mkClock, mkWorld, mkEngine, st, sh, T0, H, readLog, core, eng, TMP, common } = h;
  const S = 'egm-auto';
  const savedEgm = process.env.ORCH_EGM_DIR;
  const DESIGN = `# Design: auth redesign\n## Overview\n${'The design explains the redesign of authentication in plain words. '.repeat(8)}\n## Detailed Implementation Plan\n#### 1. \`src/T1.txt\` (Create)\nwhy\n`;
  const REVISED = DESIGN.replace('plain words', 'plain words (revised after review)');
  const PLAN_T1 = () => ({
    status: 'ready', approach: 'one critical task',
    tasks: [{ id: 'T1', title: 'Redesign the authentication architecture and migrate the session schema', type: 'implement', complexity: 'L', risk: 'high', deps: [], files: ['src/T1.txt'], criteria: ['T1 exists'] }],
    decisions: [], parked_upfront: [], risks: [],
  });
  const withTick = (spec, h2, text, final, extra) => h2.tick(spec, final, { text: `${text}\n\n\`\`\`json\n${JSON.stringify(final)}\n\`\`\``, ...extra });
  // scripted EGM ticks: label -> reply; `o` tunes findings, resolve result and drift
  const script = (world, o = {}) => {
    const R = (label, act) => world.script.push({ match: (s) => s.label === label, once: false, act });
    R('T1-egm-design', async (spec, hh) => withTick(spec, hh, DESIGN, { status: 'drafted', files_listed: 1, decisions: [] }));
    R('T1-egm-lens-design', async (spec, hh) => hh.tick(spec, { findings: o.findings ?? [{ id: 'F1', severity: 'major', where: 'Technical Plan', description: 'session fixation is not addressed', rationale: 'security' }, { id: 'F2', severity: 'nit', where: 'x', description: 'wording' }], checked: ['a', 'b', 'c'] }));
    R('T1-egm-lens-readiness', async (spec, hh) => hh.tick(spec, { findings: [], checked: ['a', 'b', 'c'] }));
    R('T1-egm-lens-zoomout', async (spec, hh) => hh.tick(spec, { findings: [{ id: 'F3', severity: 'nit', where: 'x', description: 'trim' }], checked: ['a'] }));
    R('T1-egm-resolve', async (spec, hh) => withTick(spec, hh, REVISED, { status: 'resolved', applied: 1, contested: 0, declined: 1, blockers_open: o.blockersOpen ?? 0 }));
    let drifts = 0;
    R('T1-egm-drift-r1', async (spec, hh) => hh.tick(spec, { findings: o.drift?.[drifts++] ?? [] }));
    R('T1-egm-drift-r2', async (spec, hh) => hh.tick(spec, { findings: o.drift?.[drifts++] ?? [] }));
    R('T1-egm-fix', async (spec, hh) => { hh.work(spec, 'T1'); return hh.tick(spec, { status: 'done', summary: 'fixed drift', files: ['src/T1.txt'], decisions: [] }); });
  };
  const egmCalls = (w) => w.calls.filter((c) => /-egm-/.test(c.label));
  const setup = async (slug, contractOver, o) => {
    const repo = mkRepo(); const run = await setupRun(repo, slug, { families: { allow: ['claude'] }, ...contractOver }); const clock = mkClock(); const world = mkWorld(run, clock, { plan: PLAN_T1() });
    script(world, o);
    return { repo, run, clock, world };
  };

  // 1. pre-consent: design -> three Goldfish -> resolve -> work with the design -> drift
  {
    const { run, clock, world } = await setup('egm-yes', { egm: { allow: true } });
    const r = await mkEngine(run, clock, world).run();
    const s = st(run); const t = s.tasks[0];
    const labels = world.calls.map((c) => c.label);
    const iDesign = labels.indexOf('T1-egm-design'); const iWork = labels.indexOf('T1'); const iDrift = labels.indexOf('T1-egm-drift-r1'); const iResolve = labels.indexOf('T1-egm-resolve');
    check(S, 'pre-consent: the critical task goes design -> Goldfish lenses -> resolve -> work -> drift check, then completes', r.status === 'completed' && t.status === 'done' && iDesign > 0 && iDesign < iResolve && iResolve < iWork && iWork < iDrift && labels.filter((l) => /-egm-lens-/.test(l)).length === 3, JSON.stringify({ r, labels }));
    const design = world.calls[iDesign]; const resolve = world.calls[iResolve];
    const lenses = world.calls.filter((c) => /-egm-lens-/.test(c.label));
    check(S, 'the Elephant resolves in its OWN session (resumed), the Goldfish run fresh, read-only, each in a new session with no history', resolve.resume === true && resolve.sessionId === design.sessionId && lenses.every((c) => c.resume === false && c.readonly === true && c.sessionId !== design.sessionId) && new Set(lenses.map((c) => c.sessionId)).size === 3);
    check(S, 'Goldfish prompts carry the real persona + standard of the plugin and the design only (no run history, no contract chatter)', lenses.every((c) => /Persona|Fixture persona text/.test(c.prompt) && /fixture standard text/.test(c.prompt) && c.prompt.includes('Design: auth redesign')) && !lenses.some((c) => /Definition of done|Checks the supervisor/.test(c.prompt)));
    const designFile = path.join(run.paths.dir, 'egm', 'T1', 'design.md');
    check(S, 'the design is saved in the run directory, the first version kept, the revised one is what the worker gets; the worker prompt carries it', fs.readFileSync(designFile, 'utf8').includes('revised after review') && fs.existsSync(designFile.replace(/\.md$/, '.v1.md')) && world.calls[iWork].prompt.includes('Approved EGM design') && world.calls[iWork].prompt.includes('revised after review'));
    check(S, 'findings are counted (1 major, 2 nits), the resolve result and the drift check are recorded on the task and in the Polish report', t.egm.status === 'done' && t.egm.counts.major === 1 && t.egm.counts.nit === 2 && t.egm.resolve.applied === 1 && t.egm.drift.items === 0 && /## EGM/.test(readLog(run.paths.report)) && /1 poważnych/.test(readLog(run.paths.report)) && /dryf: 0 rozbież/.test(readLog(run.paths.report)), readLog(run.paths.report).split('\n').filter((l) => /EGM|T1/.test(l)).slice(0, 4).join(' | '));
    check(S, 'EGM ticks are ordinary ticks: counted in the dispatch budget, the task still got its checkpoint commit and went through the review step (deferred: only one family allowed)', s.counters.dispatches >= 7 && !!s.tasks[0].checkpoint?.sha && (s.reviews.some((x) => x.task === 'T1') || (s.tasks[0].review_deferred || []).length > 0), JSON.stringify({ d: s.counters.dispatches, cp: !!s.tasks[0].checkpoint?.sha, rv: s.reviews.map((x) => x.task) }));
  }
  // 2. no pre-consent: no EGM tick at all
  {
    const { run, clock, world } = await setup('egm-no', {});
    const r = await mkEngine(run, clock, world).run();
    const t = st(run).tasks[0];
    check(S, 'no pre-consent in the contract: zero EGM ticks, the task runs the normal way and completes; the journal says why', r.status === 'completed' && egmCalls(world).length === 0 && t.egm.status === 'skipped' && /without EGM pre-consent/.test(readLog(run.paths.journal)));
  }
  // 3. plugin absent
  {
    process.env.ORCH_EGM_DIR = path.join(TMP, 'no-such-egm');
    const { run, clock, world } = await setup('egm-gone', { egm: { allow: true } });
    const r = await mkEngine(run, clock, world).run();
    process.env.ORCH_EGM_DIR = savedEgm;
    check(S, 'pre-consent but the egm plugin is missing: no EGM tick, the task completes without it (never an error)', r.status === 'completed' && egmCalls(world).length === 0 && st(run).tasks[0].egm.status === 'skipped');
  }
  // 4. blockers survive the resolve turn -> the task is parked, not implemented
  {
    const { run, clock, world } = await setup('egm-block', { egm: { allow: true } }, { findings: [{ id: 'F1', severity: 'blocker', where: 'Technical Plan', description: 'data loss on rollback', rationale: 'x' }], blockersOpen: 1 });
    await mkEngine(run, clock, world).run();
    const t = st(run).tasks[0];
    check(S, 'a blocker still open after the resolve turn parks the task (no implementation of a design the reviewers reject)', t.status === 'parked' && /EGM: 1 blocker/.test(t.parked_reason) && !world.calls.some((c) => c.label === 'T1'), t.parked_reason);
  }
  // 5. drift: one fix round settles it / unresolved high drift parks
  {
    const high = [{ where: 'src/T1.txt', severity: 'high', scenario: 'design requires file X, code has none' }];
    const a = await setup('egm-drift-ok', { egm: { allow: true } }, { drift: [high, []] });
    await mkEngine(a.run, a.clock, a.world).run();
    const ta = st(a.run).tasks[0];
    check(S, 'drift found -> one fix round through the author -> second drift check clean -> checkpoint', ta.status === 'done' && a.world.calls.some((c) => c.label === 'T1-egm-fix') && ta.egm.drift.fixed === 1, JSON.stringify(ta.egm.drift));
    const b = await setup('egm-drift-bad', { egm: { allow: true } }, { drift: [high, high] });
    await mkEngine(b.run, b.clock, b.world).run();
    const tb = st(b.run).tasks[0];
    check(S, 'drift still high after the fix round -> the task is parked with a snapshot (the diff is kept for review)', tb.status === 'parked' && /EGM drift/.test(tb.parked_reason) && !!tb.parked_ref);
  }
  // 6. a usage limit during the design phase is a wait, not a failure; the phase resumes where it stopped
  {
    const { run, clock, world } = await setup('egm-limit', { egm: { allow: true } });
    let hit = false;
    world.script.unshift({ match: (s) => s.label === 'T1-egm-lens-design', once: false, act: async (spec) => { if (hit) return null; hit = true; return { kind: 'limit', retry_at: clock.t + 3 * H, estimated: false, scope: 'five_hour', session_id: spec.sessionId, seen_session: false, usage: { total: 0, fresh: 0 } }; } });
    const r = await mkEngine(run, clock, world).run();
    const t = st(run).tasks[0];
    check(S, 'a usage limit mid-review is a wait: the run sleeps until the reset, then re-runs only the unfinished Goldfish (the design is not redone) and completes', r.status === 'completed' && t.egm.status === 'done' && world.calls.filter((c) => c.label === 'T1-egm-design').length === 1 && world.calls.filter((c) => c.label === 'T1-egm-lens-design').length === 2 && /WAIT kind=limit/.test(readLog(run.paths.limits)), JSON.stringify(world.calls.map((c) => c.label)));
  }
  // 7. crash after the design was saved: the restarted engine does not design again
  {
    const { run, clock, world } = await setup('egm-crash', { egm: { allow: true } });
    let crashed = false;
    const cp = (name) => { if (!crashed && name === 'egm-lens-design-dispatching') { crashed = true; throw new eng.CrashForTest(name); } };
    try { await mkEngine(run, clock, world, { crashPoint: cp }).run(); } catch (e) { if (!(e instanceof eng.CrashForTest)) throw e; }
    let r = null;
    for (let i = 0; i < 3 && r?.status !== 'completed'; i++) r = await mkEngine(run, clock, world).run();
    check(S, 'crash right before the first Goldfish tick: the restarted engine keeps the saved design (one design tick in total) and finishes', crashed && r?.status === 'completed' && world.calls.filter((c) => c.label === 'T1-egm-design').length === 1 && st(run).tasks[0].egm.status === 'done');
  }
  process.env.ORCH_EGM_DIR = savedEgm;
  void sh; void T0; void common;
}
