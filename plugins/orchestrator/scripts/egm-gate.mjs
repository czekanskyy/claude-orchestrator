#!/usr/bin/env node
// `egm_gate`: runs after the prompt is ready (simple: the user's request; complex: prompt.md; huge: after the split) and BEFORE
// planning. It decides whether the Elephant-Goldfish mode (EGM, references/egm.md) is proposed, and never starts it without consent:
//   action continue     normal flow (not critical, EGM off, no consent, plugin absent on an implicit proposal)
//   action ask          critical + EGM available: ask the user (the `question` is ready for AskUserQuestion), then call again with --answer
//   action egm          consent exists: --egm (the user asked for it), --answer run, or a contract with egm.allow (autonomous run)
//   action unavailable  the user asked for EGM (--egm) but the plugin is absent or incomplete: one line, install hint, normal flow offered
//   action stop         the user answered "cancel"
// Usage: node egm-gate.mjs --class simple|complex|huge [--text T | --text-file F] [--files a,b] [--critical true|false] [--risk-hint low|med|high]
//        [--egm] [--answer run|normal|cancel] [--run DIR] [--contract contract.yaml] [--review full|feature|plan]
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, out, fail, loadRegistry } from './lib/common.mjs';
import { parseYaml } from './lib/yaml-lite.mjs';
import { scanTextForGlobs } from './lib/privacy.mjs';
import { egmRubric, egmStatus, estimateEgm, readEgmSettings, EGM_INSTALL_HINT, EGM_REVIEWS } from './lib/egm.mjs';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Ask text for AskUserQuestion (user-facing, Polish like the rest of the session UI). Neutral options: the cost is the user's call.
const REASON_PL = { architecture: 'zmiana na poziomie architektury', hard_to_reverse: 'bezpieczeństwo/uwierzytelnianie/płatności/dane lub inna trudno odwracalna zmiana', cross_subsystem: 'praca obejmuje kilka podsystemów', high_risk_large: 'wysokie ryzyko przy dużej złożoności', declared: 'uznane za krytyczne' };
const costPl = (est) => (est.agents === '?' ? est.summary : `${est.agents} agentów (Elephant, recenzenci Goldfish, syntezatory, kontrola dryfu), ≈${est.units} jednostek zużycia${(est.pools || []).length ? `, pula ${est.pools.map((p) => `${p.pool} ${p.pct_before ?? '?'}% → ${p.pct_after}%`).join(', ')}` : ''}`);

export function gateQuestion(rubric, est) {
  return {
    header: 'EGM',
    question: clip(`Zadanie wygląda na krytyczne (${rubric.categories.map((c) => REASON_PL[c] || c).join('; ')}). Uruchomić tryb EGM (Elephant–Goldfish)? Koszt jeszcze przed implementacją: ${costPl(est)}.`, 700),
    multiSelect: false,
    options: [
      { label: 'Uruchom EGM', description: 'Projekt (Elephant) → recenzje Goldfish w czystym kontekście → poprawki → Twoja akceptacja → implementacja wg projektu → kontrola dryfu. To tryb bardzo kosztowny.' },
      { label: 'Zwykły przepływ', description: 'Bez EGM: plan i implementacja jak zawsze (z cross-review innej rodziny modeli).' },
      { label: 'Anuluj', description: 'Nic nie uruchamiaj.' },
    ],
  };
}

export function unavailableQuestion(status) {
  return {
    header: 'EGM',
    question: `Prosisz o EGM, ale ${status.present ? `wtyczka jest niekompletna (brak: ${status.missing.slice(0, 3).join(', ')})` : 'wtyczka egm nie jest zainstalowana'}. Instalacja: ${EGM_INSTALL_HINT}. Co dalej?`,
    multiSelect: false,
    options: [
      { label: 'Zwykły przepływ', description: 'Kontynuuj bez EGM.' },
      { label: 'Anuluj', description: 'Zatrzymaj; zainstaluj wtyczkę i uruchom ponownie z --egm.' },
    ],
  };
}

// critical: legacy/advisory triage flag. When `text` or `task` is given the rubric is computed; otherwise `critical` is taken as the caller's verdict.
export function egmGate({
  class: cls = 'complex', critical = false, text = null, files = [], repoCriticalHits = [], task = null, riskHint = null,
  explicit = false, answer = null, reg = null, setting = 'ask', contract = null, status = null, sensitivity = 'internal', pools, review = null,
} = {}) {
  const settings = reg ? readEgmSettings(reg) : { mode: setting === 'off' ? 'off' : 'ask', review: 'full', goldfish: 'claude', off_by: setting === 'off' ? 'repo profile (egm)' : null };
  if (review && EGM_REVIEWS.includes(review)) settings.review = review;
  const computed = text !== null || task;
  const rubric = computed ? egmRubric({ cls, text: text || '', files, repoCriticalHits, task, riskHint }) : { critical: !!critical, eligible: true, categories: critical ? ['declared'] : [], reasons: critical ? ['declared critical by the caller'] : [], signals: {} };
  const autonomous = !!contract;
  const consentContract = autonomous ? contract.egm?.allow === true : null;
  const base = { gate: 'egm_gate', critical: rubric.critical, candidate: !!critical, setting, settings, rubric, mode: autonomous ? 'autonomous' : 'interactive', consent: autonomous ? consentContract : null, consent_by: null, action: 'continue', note: '' };
  const stat = () => status || egmStatus();

  if (!explicit) {
    if (settings.mode === 'off') return { ...base, note: `EGM is off (${settings.off_by})` };
    if (!rubric.critical) return { ...base, note: rubric.eligible ? 'not critical: normal flow' : 'simple request: EGM is for the heavy end only' };
  }
  const st = stat();
  const plugin = { present: st.present, ok: st.ok, version: st.version, missing: st.missing };
  if (!st.present || !st.ok) {
    const why = st.present ? `egm plugin incomplete (missing: ${st.missing.slice(0, 3).join(', ')})` : 'egm plugin not installed';
    if (explicit && !autonomous) return { ...base, plugin, action: 'unavailable', unavailable: true, note: `${why}. Install: ${EGM_INSTALL_HINT}. Normal flow is available.`, question: unavailableQuestion(st) };
    return { ...base, plugin, unavailable: true, note: `${why}: continuing with the normal flow. Install: ${EGM_INSTALL_HINT}` };
  }
  if (autonomous) {
    if (!consentContract) return { ...base, plugin, consent: false, note: 'autonomous run without EGM pre-consent in the contract: EGM is not used' };
    return { ...base, plugin, consent: true, consent_by: 'contract', action: 'egm', note: 'EGM pre-consent in the contract' };
  }
  if (explicit) return { ...base, plugin, consent: true, consent_by: 'flag', action: 'egm', note: 'the user asked for EGM (--egm)' };
  if (answer === 'run') return { ...base, plugin, consent: true, consent_by: 'user', action: 'egm', note: 'the user agreed to EGM' };
  if (answer === 'normal') return { ...base, plugin, consent: false, note: 'the user chose the normal flow' };
  if (answer === 'cancel') return { ...base, plugin, consent: false, action: 'stop', note: 'the user cancelled' };
  const estimate = reg ? estimateEgm(reg, { review: settings.review, crossFamily: settings.goldfish === 'cross', sensitivity, pools }) : null;
  const est = estimate && estimate.ok ? estimate : { summary: 'koszt nieznany', agents: '?', units: '?' };
  return { ...base, plugin, estimate: estimate ? { ok: estimate.ok, summary: estimate.summary, agents: estimate.agents, units: estimate.units, pools: estimate.pools, notes: estimate.notes, errors: estimate.errors } : null, action: 'ask', note: 'consent needed: ask the user, then call again with --answer', question: gateQuestion(rubric, est) };
}

function main() {
  const a = parseArgs(process.argv.slice(2), { flags: ['egm'] });
  const reg = loadRegistry();
  const contract = a.contract ? parseYaml(fs.readFileSync(a.contract, 'utf8')) : null;
  const file = a['text-file'] || a['prompt-file'];
  const text = file ? fs.readFileSync(file, 'utf8') : a.text ?? null;
  if (a.answer && !['run', 'normal', 'cancel'].includes(a.answer)) return fail('--answer must be run|normal|cancel');
  const repoCriticalHits = text ? scanTextForGlobs(reg.meta.repo_rules?.critical_globs || [], text).map((h) => h.file) : [];
  const r = egmGate({ class: a.class || 'complex', critical: a.critical === 'true', text, files: a.files ? String(a.files).split(',') : [], repoCriticalHits, riskHint: a['risk-hint'] || null, explicit: !!a.egm, answer: a.answer || null, reg, setting: reg.meta.repo_rules?.egm, contract, sensitivity: a.sensitivity || reg.meta.default_sensitivity || 'internal', review: a.review });
  // the decision made for the user goes to the run ledger (it feeds the final report)
  const lf = a.run && !contract ? path.join(a.run, 'ledger.json') : null;
  const line = r.action === 'egm' ? `EGM uruchomiony (zgoda: ${r.consent_by === 'flag' ? '--egm' : 'użytkownik'})` : r.action === 'stop' ? 'EGM: anulowano' : r.unavailable ? 'EGM niedostępny (brak wtyczki), zwykły przepływ' : r.critical && r.action === 'continue' ? 'EGM pominięty: zwykły przepływ' : null;
  if (lf && line && fs.existsSync(lf)) {
    const l = JSON.parse(fs.readFileSync(lf, 'utf8'));
    (l.decisions ||= []).push(line);
    fs.writeFileSync(lf, `${JSON.stringify(l, null, 2)}
`);
  }
  out(r);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
