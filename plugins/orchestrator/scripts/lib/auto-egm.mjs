// Autonomous mode: the EGM phases for ONE critical task, used only when the start contract granted pre-consent (`egm.allow`,
// read by egm-gate.mjs --contract). Nobody can be asked, so the interactive gates of EGM become the decision protocol of the
// run: the Elephant (a Claude session, resumed for the resolve turn) drafts the design, fresh-context Goldfish ticks review it
// with the real personas and standards of the installed plugin (inlined: a headless tick cannot read the plugin directory),
// the Elephant resolves, and after the work a fresh Goldfish checks drift. Everything is a tick through engine.dispatch, so
// limits, waits, privacy routing and crash recovery work unchanged. Interactive flow: references/egm-flow.md.
import fs from 'node:fs';
import path from 'node:path';
import { uuid, writeFileAtomic } from './auto-core.mjs';
import { contractBrief } from './auto-worker.mjs';
import { verifyCommands } from './auto-contract.mjs';
import { locateEgm, readEgmSettings } from './egm.mjs';
import { egmGate } from '../egm-gate.mjs';
import { matchGlobList } from './privacy.mjs';

// The headless profile of the review: the three lenses that matter most for a design that code will follow (EGM stages 7 and 9 plus a zoom-out).
export const AUTO_LENSES = [
  { id: 'design', reviewer: 'egm-design', persona: 'design_critic', standard: 'feature-spec-standard' },
  { id: 'readiness', reviewer: 'egm-implementation-readiness', persona: 'implementation_readiness', standard: 'implementation-readiness-standard' },
  { id: 'zoomout', reviewer: 'egm-zoom-out', persona: 'zoom_out', standard: 'zoom-out-standard' },
];
const SEVERITY = ['blocker', 'major', 'nit'];
const stripFrontmatter = (t) => t.replace(/^---[\s\S]*?\r?\n---\r?\n/, '').trim();
const stripFinal = (text) => String(text || '').replace(/\s*```(?:json)?\s*\n[\s\S]*?```\s*$/, '').trim();
const readPlugin = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };
const cap = (s, n) => (s.length > n ? `${s.slice(0, n)}\n...[truncated, ${s.length - n} more chars]` : s);

export function gateForTask(eng, t) {
  const reg = eng.deps.reg;
  const critical = reg.meta.repo_rules?.critical_globs || [];
  const hits = critical.length ? matchGlobList(critical, t.files || []).map((h) => h.file) : [];
  const text = [eng.contract.goal, t.title, ...(t.criteria || [])].join('\n');
  return egmGate({ class: 'complex', task: { risk: t.risk, complexity: t.complexity }, text, files: t.files || [], repoCriticalHits: hits, reg, contract: eng.contract, sensitivity: eng.taskSensitivity(t), status: eng.deps.egmStatus?.() });
}

function elephantPrompt(eng, t, egm) {
  const template = stripFrontmatter(readPlugin(egm.root, 'skills/egm-draft/references/design_doc.md'));
  const spec = fs.existsSync(eng.paths.prompt) ? fs.readFileSync(eng.paths.prompt, 'utf8') : '';
  return [
    'You are the Elephant of an EGM (Elephant-Goldfish Model) pass in an unattended run: you write the design document that the implementation will follow and that fresh-context reviewers will attack. Read-only: do not edit files; your answer IS the document.',
    contractBrief(eng.contract, eng.rules),
    `Task ${t.id}: ${t.title}\nFiles in scope: ${(t.files || []).join(', ') || '(derive from the code)'}\nAcceptance criteria:\n${(t.criteria || []).map((c) => `- ${c}`).join('\n') || '- the task title is fulfilled'}`,
    spec ? `Run spec:\n${cap(spec, 8000)}` : '',
    'Method (egm-draft, adapted to a run where nobody can answer): read the code the task touches first. Write plain, direct English; no promotional adjectives; critique your own plan (alternatives, what fails). Cover: Overview & Goals, Non-Goals, Technical Plan, Alternatives Considered (with why each was rejected), Non-Functional Requirements, Detailed Implementation Plan listing EVERY file to create/modify/delete with a rationale, and a Verification Plan with exact commands. No production code (pseudocode or schemas only).',
    'Rule "the owner decides architecture" cannot be followed literally (nobody can answer): for every decision with more than one defensible answer choose the safest minimal reversible option, say so in the document, and list it under "decisions" in the final JSON with your honest confidence; the supervisor applies the run\'s decision protocol (second opinion, park when irreversible).',
    `Template to follow:\n${cap(template, 6000)}`,
    'Output: the COMPLETE design document as Markdown first, then ONE final fenced json block and nothing after it: {"status":"drafted","files_listed":0,"decisions":[{"question":"","options":[{"id":"a","label":"","reversible":true,"safest":true}],"chosen":"a","confidence":0.0,"reasoning":"","reversibility":"reversible|irreversible","files":[]}]}',
  ].filter(Boolean).join('\n\n');
}

function goldfishPrompt(egm, lens, design, t) {
  const persona = stripFrontmatter(readPlugin(egm.root, `agents/${lens.persona}.md`));
  const standard = readPlugin(egm.root, `resources/document_standards/${lens.standard}.md`).trim();
  return [
    'You are a Goldfish reviewer of the Elephant-Goldfish Model: a fresh context that knows nothing of how this document was produced. Read-only: do not edit anything; never read or print secrets. You may read the repository (current directory) to check the design against the real code.',
    `## Persona (${lens.reviewer})\n${persona}`,
    `## Standard\n${standard}`,
    `## Target: the design for task ${t.id}\n${cap(design, 70000)}`,
    'Reply with ONE final fenced json block (a short summary before it is fine): {"findings":[{"id":"F1","severity":"blocker|major|nit","where":"section or line","description":"the discrepancy","rationale":"why it matters"}],"checked":["at least 3 concrete things you verified"]}. At most 10 findings, most severe first, no praise.',
  ].join('\n\n');
}

function resolvePrompt(findings) {
  return [
    'Goldfish reviewers (fresh contexts) reviewed your design. Apply the egm-resolve method: classify each finding CONTEST (inaccurate, with evidence a reviewer could read), PROPOSE FIX (valid: fix it in the document now), ESCALATE (needs a human fact) or DECLINE (a nit). Nobody can answer: treat ESCALATE as PROPOSE FIX with the safest reversible option and say so in the document. Never contest a comprehension gap; never lower a severity.',
    `Findings:\n${findings.map((f) => `- [${f.lens}] ${f.id} ${f.severity.toUpperCase()} at ${f.where}: ${f.description} (${f.rationale || 'no rationale'})`).join('\n')}`,
    'Output: the COMPLETE revised design document as Markdown first, then ONE final fenced json block: {"status":"resolved","applied":0,"contested":0,"declined":0,"blockers_open":0}',
  ].join('\n\n');
}

const normFindings = (final, lens) => (Array.isArray(final?.findings) ? final.findings : []).slice(0, 10).map((f, i) => ({
  lens, id: String(f.id || `${lens}-${i + 1}`), severity: SEVERITY.includes(String(f.severity).toLowerCase()) ? String(f.severity).toLowerCase() : 'nit',
  where: String(f.where || '?'), description: String(f.description || '').slice(0, 400), rationale: String(f.rationale || '').slice(0, 300),
}));

// -> { stop: true } when the engine must return (a wait started, the task parked), else {} (continue with the work, with or without a design).
export async function egmStep(eng, t, sens) {
  if (!t.egm) {
    const g = gateForTask(eng, t);
    eng.jr(`${t.id}: egm_gate -> ${g.action}${g.action !== 'egm' && g.note ? ` (${g.note})` : ''}`);
    if (g.action !== 'egm') { t.egm = { status: 'skipped', reason: g.note }; eng.save(); return {}; }
    t.egm = { status: 'running', step: 'design', lenses: {}, started_at: eng.now(), categories: g.rubric.categories };
    eng.save();
  }
  if (t.egm.status !== 'running') return {};
  return runPhases(eng, t, sens);
}

async function runPhases(eng, t, sens) {
  const E = t.egm;
  const egm = locateEgm();
  if (!egm.present) { E.status = 'skipped'; E.reason = 'EGM plugin not installed any more'; eng.save(); return {}; }
  const dir = path.join(eng.paths.dir, 'egm', t.id);
  fs.mkdirSync(dir, { recursive: true });
  E.design_file = path.join(dir, 'design.md');
  const reg = eng.deps.reg;
  const settings = readEgmSettings(reg);
  const skip = (why) => { E.status = 'failed'; E.reason = why; eng.st.inflight = null; eng.jr(`${t.id}: EGM ${why}; continuing the task without a design`); eng.save(); return {}; };
  const elephant = eng.selectRoute({ type: 'plan', complexity: 'L', risk: 'high', sensitivity: sens, only: ['claude'], kind: 'reserved', role: 'author', lens: 'general' });
  if (!elephant.ok) {
    if (elephant.permanent) return skip(`needs the Claude family (${elephant.reason})`);
    await eng.handleNoRoute(elephant, `${t.id} EGM design`, null);
    return { stop: true };
  }
  const run = async (label, route, prompt, extra = {}) => {
    eng.st.inflight = { task: t.id, kind: 'egm', phase: label, family: route.family, model: route.model, effort: route.effort, session_id: extra.sessionId || null, pid: null, started_at: eng.now() };
    eng.st.counters.dispatches += 1;
    eng.save(); eng.cp(`egm-${label}-dispatching`);
    const tick = await eng.dispatch({ route, mode: extra.mode || 'plan', prompt, readonly: true, label: `${t.id}-egm-${label}`, task: null, sessionId: extra.sessionId || uuid(), resume: !!extra.resume, sensitivity: sens, agent: null });
    eng.st.inflight = null; eng.save(); eng.cp(`egm-${label}-returned`);
    return tick;
  };

  if (E.step === 'design') {
    const sessionId = uuid();
    const tick = await run('design', elephant, elephantPrompt(eng, t, egm), { sessionId });
    if (tick.handled) return { stop: true };
    const design = stripFinal(tick.text);
    if (tick.kind !== 'ok' || design.length < 200) return skip(`design tick ${tick.kind === 'ok' ? 'returned no document' : `failed (${tick.kind})`}`);
    for (const d of Array.isArray(tick.final?.decisions) ? tick.final.decisions : []) {
      if (!d || typeof d.question !== 'string' || d.question.trim().length < 3) continue;
      const rec = await eng.recordDecision(t, { ...d, source: 'egm' });
      if (rec.outcome === 'parked') { eng.parkTask(t, `EGM design needs a human decision: ${rec.question} (${rec.rule_reason})`); eng.save(); return { stop: true }; }
    }
    writeFileAtomic(E.design_file, `${design}\n`);
    E.session_id = tick.session_id || sessionId;
    E.files_listed = Number(tick.final?.files_listed) || undefined;
    E.step = 'review'; eng.save();
  }

  if (E.step === 'review') {
    const design = fs.readFileSync(E.design_file, 'utf8');
    for (const lens of AUTO_LENSES) {
      if (E.lenses[lens.id]) continue;
      // cross-family only for the design critic, only when asked for, and only where the privacy filter leaves a family; else Claude
      const wantCross = settings.goldfish === 'cross' && lens.id === 'design';
      let route = wantCross ? eng.selectRoute({ type: 'review', complexity: 'M', risk: 'med', sensitivity: sens, exclude: ['claude'], kind: 'reserved', role: 'reviewer' }) : null;
      if (!route?.ok) route = eng.selectRoute({ type: 'review', complexity: 'M', risk: 'med', sensitivity: sens, kind: 'reserved', role: 'reviewer' });
      if (!route.ok) { if (route.permanent) { E.lenses[lens.id] = { not_run: true, reason: route.reason, findings: [] }; continue; } await eng.handleNoRoute(route, `${t.id} EGM ${lens.id}`, null); return { stop: true }; }
      const tick = await run(`lens-${lens.id}`, route, goldfishPrompt(egm, lens, design, t), { mode: 'review' });
      if (tick.handled) return { stop: true };
      E.lenses[lens.id] = tick.kind === 'ok' ? { family: route.family, model: route.model, findings: normFindings(tick.final, lens.id), unparsed: !tick.final } : { not_run: true, reason: tick.kind, findings: [] };
      eng.save();
    }
    E.step = 'resolve'; eng.save();
  }

  if (E.step === 'resolve') {
    const all = Object.values(E.lenses).flatMap((l) => l.findings || []);
    E.counts = { blocker: all.filter((f) => f.severity === 'blocker').length, major: all.filter((f) => f.severity === 'major').length, nit: all.filter((f) => f.severity === 'nit').length, not_run: Object.entries(E.lenses).filter(([, l]) => l.not_run).map(([k]) => k) };
    const serious = all.filter((f) => f.severity !== 'nit');
    if (serious.length) {
      const tick = await run('resolve', elephant, resolvePrompt(serious), { sessionId: E.session_id, resume: true });
      if (tick.handled) return { stop: true };
      const revised = stripFinal(tick.text);
      if (tick.kind === 'ok' && revised.length >= 200) {
        fs.copyFileSync(E.design_file, E.design_file.replace(/\.md$/, '.v1.md'));
        writeFileAtomic(E.design_file, `${revised}\n`);
        E.resolve = { applied: Number(tick.final?.applied) || 0, contested: Number(tick.final?.contested) || 0, declined: Number(tick.final?.declined) || 0, blockers_open: Number(tick.final?.blockers_open) || 0 };
      } else E.resolve = { applied: 0, contested: 0, declined: 0, blockers_open: E.counts.blocker, failed: tick.kind };
      if (E.resolve.blockers_open > 0) { E.status = 'failed'; eng.parkTask(t, `EGM: ${E.resolve.blockers_open} blocker finding(s) of the design review are still open after the resolve turn (see egm/${t.id}/design.md)`); eng.save(); return { stop: true }; }
    }
    E.step = 'done'; E.status = 'done'; E.finished_at = eng.now();
    eng.jr(`${t.id}: EGM design approved by the protocol (${E.counts.blocker} blockers, ${E.counts.major} major, ${E.counts.nit} nits${E.resolve ? `; applied ${E.resolve.applied}, contested ${E.resolve.contested}` : ''}${E.counts.not_run.length ? `; not run: ${E.counts.not_run.join(', ')}` : ''})`);
    eng.save();
  }
  return {};
}

export const designFor = (t) => {
  if (t.egm?.status !== 'done' || !t.egm.design_file) return null;
  try { return cap(fs.readFileSync(t.egm.design_file, 'utf8'), 30000); } catch { return null; }
};

// After the work and its checks: a fresh Goldfish compares design and diff (egm-drift-report). One fix round through the author.
// -> 'ok' | 'parked' | 'retry'
export async function egmDrift(eng, t, route, sens) {
  const E = t.egm;
  if (!E || E.status !== 'done') return 'ok';
  const egm = locateEgm();
  if (!egm.present) return 'ok';
  const design = fs.readFileSync(E.design_file, 'utf8');
  const procedure = stripFrontmatter(readPlugin(egm.root, 'skills/egm-drift-report/SKILL.md'));
  for (let round = 1; round <= 2; round++) {
    eng.git(eng.wt, ['add', '-A']);
    const diff = eng.git(eng.wt, ['diff', '--cached', 'HEAD']).out;
    const dr = eng.selectRoute({ type: 'review', complexity: 'M', risk: 'med', sensitivity: sens, kind: 'reserved', role: 'reviewer' });
    if (!dr.ok) { E.drift = { skipped: dr.reason }; eng.save(); return 'ok'; }
    const prompt = [
      'You are a Goldfish: a fresh context with no knowledge of how this change was made. Read-only: never edit, never print secrets. You may read the repository (current directory).',
      `## Procedure (egm-drift-report, one design document)\n${cap(procedure, 5000)}`,
      `## Design\n${cap(design, 50000)}`, `## The change (diff of the working tree against the last checkpoint)\n${cap(diff, 60000)}`,
      'Report only differences between design and code (missing features, incomplete models, logic shortcuts, architectural divergence), plus code the design does not cover. Final fenced json block: {"findings":[{"where":"file:line or symbol","severity":"high|med|low","scenario":"design says X, code does Y"}]}. At most 8 findings, none without a concrete difference.',
    ].join('\n\n');
    eng.st.counters.dispatches += 1;
    const tick = await eng.dispatch({ route: dr, mode: 'review', prompt, readonly: true, label: `${t.id}-egm-drift-r${round}`, task: null, sensitivity: sens, agent: null });
    if (tick.handled) return 'retry';
    const findings = tick.kind === 'ok' && Array.isArray(tick.final?.findings) ? tick.final.findings.slice(0, 8).map((f) => ({ where: String(f.where || '?'), severity: ['high', 'med', 'low'].includes(f.severity) ? f.severity : 'low', scenario: String(f.scenario || '') })) : [];
    const serious = findings.filter((f) => f.severity !== 'low');
    E.drift = { ...(E.drift?.fixed ? { fixed: E.drift.fixed } : {}), round, items: findings.length, serious: serious.length, by: dr.family, unreadable: tick.kind !== 'ok' || !tick.final };
    eng.save();
    if (!serious.length) return 'ok';
    if (round === 2) {
      const high = serious.filter((f) => f.severity === 'high');
      if (high.length) { eng.parkTask(t, `EGM drift: the code diverges from the approved design (${high[0].where}: ${high[0].scenario.slice(0, 120)}) and one fix round did not settle it`, { snapshot: true }); return 'parked'; }
      return 'ok';
    }
    const evidence = serious.map((f) => `- ${f.where} (${f.severity}): ${f.scenario}`).join('\n');
    t.failure_evidence = evidence;
    const fix = await eng.dispatch({ route, mode: 'implement', prompt: `A fresh-context review found drift between the approved design and your code. Fix only these, keeping the checks green, then give the final JSON again:\n${evidence}`, readonly: false, label: `${t.id}-egm-fix`, task: t, sessionId: eng.st.inflight?.session_id || uuid(), resume: route.invoke === 'claude-agent' && !!eng.st.inflight?.session_id, sensitivity: sens });
    if (fix.handled) return 'retry';
    t.failure_evidence = null;
    if (fix.kind !== 'ok') { E.drift.unfixed = true; return 'ok'; }
    E.drift.fixed = serious.length;
    const checks = await eng.deps.runChecks(verifyCommands(eng.contract), eng.wt);
    if (!checks.ok) { await eng.failTask(t, route, 'verification after drift fix', checks.results.find((x) => x.code !== 0)?.tail || '', sens); return 'retry'; }
  }
  return 'ok';
}
