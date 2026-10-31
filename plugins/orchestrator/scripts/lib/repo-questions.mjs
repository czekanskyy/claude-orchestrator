// From a repo scan to decisions: per decision the repo's own rule (derived from verified facts), the orchestrator default,
// and, only where they conflict or are ambiguous, a Polish AskUserQuestion entry "repo rule vs default vs merge".
// Deterministic and offline. The model may refine a repo-derived value with what it read (answers._repo) before applying.
import { DECISION_KEYS, orchestratorDefaults, settle, evidenceHash } from './repo-profile.mjs';

const clip = (s, n = 140) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const rec = (s) => `${s} (Recommended)`;
const MAX_ROUNDS = 3;
const MAX_PER_ROUND = 4;
const DOC_DUTY_RE = /\b(docs?|documentation|changelog|readme|map|adr|decisions?|log\.md)\b/i;

const differs = (key, def, repo) => repo !== undefined && JSON.stringify(settle(key, def, repo, 'repo')) !== JSON.stringify(def);

// ---------------------------------------------------------------- repo-derived values (undefined = the repo is silent)
function commitFormat(c) {
  if (!c?.style || c.style === 'plain' || (c.confidence ?? 0) < 0.6) return undefined;
  const lang = c.language === 'pl' ? 'Polish' : c.language === 'en' ? 'English' : null;
  const shape = { 'bracket-tag': '[<TAG>] <summary>', conventional: 'Conventional Commits: type(scope): summary', 'ticket-prefix': '<TICKET-123> <summary>', gitmoji: '<gitmoji> <summary>', 'issue-ref': '#<issue> <summary>' }[c.style];
  return clip(`${shape}${lang ? `, ${lang}` : ''}${c.examples?.[0] ? `, e.g. ${c.examples[0]}` : ''}`, 170);
}

function repoValues(scan, reg) {
  const H = scan.policies.hints;
  const S = scan.policies.settings;
  const out = {};
  if (scan.orchestrators.repo_level.length) out.orchestrator = 'project';

  const commit = {};
  const docs = H.commit.docs;
  const policy = docs === 'orchestrator_only' ? 'orchestrator' : docs === 'forbidden' ? 'forbidden' : docs === 'ask_first' ? 'ask' : S?.git_commit === 'deny' ? 'forbidden' : S?.git_commit === 'ask' ? 'ask' : undefined;
  if (policy) commit.policy = policy;
  const fmt = commitFormat(scan.commits);
  if (fmt) commit.format = fmt;
  if (H.no_ai_attribution) commit.attribution = 'none';
  if (Object.keys(commit).length) out.commit = commit;

  const patterns = (scan.branches.patterns || []).filter((p) => p.n >= 3).slice(0, 3).map((p) => p.pattern);
  const branching = {};
  if (H.docs_base_branch) branching.base = H.docs_base_branch;
  if (patterns.length) branching.pattern = patterns.join(' | ');
  if (H.protected_branches?.length) branching.protected = H.protected_branches;
  if (H.pr_never) branching.pr = 'never';
  if (Object.keys(branching).length) out.branching = { action: 'follow_repo', ...branching };

  const items = scan.docs.evidence_items || [];
  // imperative sentences that name a doc; conditionals and pronoun-led fragments need their context, so the model refines those
  const duties = items.filter((e) => e.tags.some((t) => t === 'docs_duty' || t === 'done') && DOC_DUTY_RE.test(e.text) && !e.text.includes(' | ') && !/^(definition of done|if|when|it|this|that|they|so)\b/i.test(e.text)).map((e) => clip(e.text, 150));
  const h = scan.docs.history;
  if (h?.changelog && h.commits_checked >= 5 && h.changelog.touched_in / h.commits_checked >= 0.5) duties.push(`Update ${h.changelog.path} (touched in ${h.changelog.touched_in} of the last ${h.commits_checked} commits)`);
  if (duties.length) out.docs_duties = [...new Set(duties)].slice(0, 5);

  const ci = scan.policies.ci.verification || [];
  const verify = {};
  const firstOf = (role) => ci.find((c) => c.role === role)?.cmd;
  for (const role of ['test', 'typecheck', 'lint', 'build']) if (firstOf(role)) verify[role] = firstOf(role);
  const extra = ci.filter((c) => c.role === 'extra').map((c) => c.cmd);
  if (extra.length) verify.extra = extra;
  const dod = items.filter((e) => e.tags.includes('done') && /definition of done|\bdone\b/i.test(e.text) && !e.text.includes(' | ')).map((e) => clip(e.text, 200));
  const checklist = scan.policies.pr_template?.checklist || [];
  const doneWhen = [...dod, ...checklist].slice(0, 4);
  if (doneWhen.length) verify.done_when = doneWhen;
  if (Object.keys(verify).length) out.verify = verify;

  if (scan.critical_paths.length) out.critical_paths = scan.critical_paths.map((c) => c.glob);

  const sens = scan.sensitivity;
  const privacyEvidence = items.filter((e) => e.tags.includes('privacy')).length;
  const strong = sens.pii_dirs.length || sens.data_files.total || sens.secret_files.some((s) => s.tracked);
  if (strong || sens.secret_files_total || sens.env_templates.length || privacyEvidence) {
    out.sensitivity = { default: strong ? 'sensitive' : 'internal', globs: sens.pii_dirs.map((d) => `${d}/**`) };
  }
  return out;
}

function defaultValues(scan, reg) {
  const d = orchestratorDefaults({ sensitivity: reg?.meta?.default_sensitivity || 'internal' });
  // the orchestrator's own verification default: every detected check except the dev server
  const c = scan.stack.commands;
  for (const role of ['test', 'typecheck', 'lint', 'build']) if (c[role]) d.verify[role] = c[role].cmd;
  return d;
}

// ---------------------------------------------------------------- proposal
export function buildProposal(scan, { reg, existing } = {}) {
  const def = defaultValues(scan, reg);
  const repo = repoValues(scan, reg);
  const decisions = {};
  for (const key of DECISION_KEYS) {
    decisions[key] = { def: def[key], repo: repo[key] };
    const prev = existing?.decisions?.[key];
    const prevEvidence = existing?.evidence?.[key];
    if (prev !== undefined && prevEvidence !== undefined) decisions[key].prev = { value: prev, evidence: prevEvidence, choice: existing.choices?.[key] };
  }
  return { decisions };
}

// ---------------------------------------------------------------- Polish descriptions
const CP = { orchestrator: 'commituje orkiestrator', forbidden: 'orkiestrator NIE commituje', ask: 'commit tylko po Twoim „tak”' };
export function describe(key, v) {
  if (v === undefined || v === null) return 'bez zmian';
  switch (key) {
    case 'orchestrator': return { project: 'własny orkiestrator repo', global: 'globalny orkiestrator v3', ask: 'pytaj za każdym razem' }[v] || v;
    case 'commit': return [v.policy && CP[v.policy], v.format && `format: ${v.format}`, v.attribution === 'none' && 'bez śladów AI w commitach/PR', v.push === 'never' && 'push zabroniony', v.granularity && v.granularity !== 'checkpoint' && `granulacja: ${v.granularity}`].filter(Boolean).join('; ') || 'commity na checkpointach, push tylko po Twoim „tak”';
    case 'branching': return [v.action === 'current_branch' && 'praca na bieżącej gałęzi, bez tworzenia gałęzi', v.action === 'ask' && 'pytaj przed utworzeniem gałęzi', v.base && `baza: ${v.base}`, v.pattern && `nazwy: ${v.pattern}`, v.protected?.length && `bez commitów prosto do: ${v.protected.join(', ')}`, v.pr === 'never' ? 'PR: nigdy z orkiestratora' : 'PR: tylko na Twoją prośbę'].filter(Boolean).join('; ');
    case 'docs_duties': return v.length ? v.map((x) => `„${x}”`).join('; ') : 'brak dodatkowych obowiązków';
    case 'verify': {
      const cmds = ['test', 'typecheck', 'lint', 'build'].filter((k) => v[k]).map((k) => `${k}: ${v[k]}`).concat(v.extra || []);
      return [cmds.join('; '), v.done_when?.length && `DoD: ${v.done_when.map((x) => `„${x}”`).join('; ')}`].filter(Boolean).join(' | ') || 'wykryte polecenia repo';
    }
    case 'critical_paths': return v.length ? v.join(', ') : 'tylko słowa kluczowe triage (bez ścieżek)';
    case 'sensitivity': return `domyślnie ${v.default}${v.globs?.length ? `; dodatkowe ścieżki wrażliwe: ${v.globs.join(', ')}` : ''}`;
    case 'egm': return v === 'off' ? 'EGM wyłączony' : 'EGM: pytaj przy zadaniach krytycznych';
    default: return JSON.stringify(v);
  }
}

// ---------------------------------------------------------------- questions
const sensitiveFamilies = (reg) => Object.entries(reg?.families || {}).filter(([, f]) => f.enabled && f.data_policy?.sensitive_ok === true).map(([id]) => id);
const opt = (label, description, choice, value) => ({ label, description: clip(description, 280), choice, ...(value !== undefined ? { value } : {}) });

// "merge" is only worth a button when it settles differently from "repo wins"
function mergeOption(key, d, label) {
  const merged = settle(key, d.def, d.repo, 'merge');
  return JSON.stringify(merged) === JSON.stringify(settle(key, d.def, d.repo, 'repo')) ? [] : [opt(label, describe(key, merged), 'merge')];
}

function question(key, scan, d, reg) {
  switch (key) {
    case 'orchestrator': {
      const inv = scan.orchestrators.repo_level.map((o) => o.invoke).join(', ');
      return { header: 'Orkiestrator', question: `To repo ma własnego orkiestratora (${inv}). Który ma prowadzić pracę w tym repo?`, options: [
        opt(rec(`Własny repo (${inv})`), 'Plain „orchestrate” uruchamia orkiestratora repo; v3 zostaje poza grą.', 'repo'),
        opt('Globalny v3', 'Orkiestrator v3 prowadzi pracę; reguły repo (commity, gałęzie, DoD) nadal wygrywają.', 'default'),
        opt('Pytaj za każdym razem', 'Wybór przy każdym uruchomieniu (zachowanie v2).', 'merge'),
      ] };
    }
    case 'commit':
      return { header: 'Commity', question: 'Jak orkiestrator ma commitować w tym repo (push zawsze tylko po Twoim wyraźnym „tak”)?', options: [
        opt(rec('Wg reguł repo'), describe('commit', settle('commit', d.def, d.repo, 'repo')), 'repo'),
        opt('Domyślnie orkiestratora', describe('commit', d.def), 'default'),
        ...mergeOption('commit', d, 'Surowsze z obu'),
      ] };
    case 'branching':
      return { header: 'Gałęzie/PR', question: 'Jak pracować z gałęziami i PR w tym repo?', options: [
        opt(rec('Wg reguł repo'), describe('branching', settle('branching', d.def, d.repo, 'repo')), 'repo'),
        opt('Domyślnie orkiestratora', describe('branching', d.def), 'default'),
        opt('Pytaj przed utworzeniem gałęzi', 'Orkiestrator nic nie zakłada: o gałąź i bazę pyta za każdym razem.', 'custom', { ...settle('branching', d.def, d.repo, 'repo'), action: 'ask' }),
      ] };
    case 'docs_duties':
      return { header: 'Dokumentacja', question: 'Repo wymaga aktualizacji dokumentacji przy zmianach. Dodać to do kryteriów ukończenia KAŻDEGO zadania?', options: [
        opt(rec('Tak, do każdego zadania'), describe('docs_duties', d.repo), 'repo'),
        opt('Nie, tylko gdy zadanie dotyczy docs', 'Orkiestrator nie dodaje obowiązków dokumentacyjnych do briefów.', 'default'),
      ] };
    case 'verify':
      return { header: 'Weryfikacja', question: 'Jakie polecenia weryfikacji i kryteria „gotowe” przyjąć dla tego repo?', options: [
        opt(rec('Wg repo (CI/docs)'), describe('verify', settle('verify', d.def, d.repo, 'repo')), 'repo'),
        opt('Wszystkie wykryte w manifeście', describe('verify', d.def), 'default'),
        ...mergeOption('verify', d, 'Suma obu'),
      ] };
    case 'critical_paths':
      return { header: 'Ścieżki kryt.', question: 'Zmiany w tych ścieżkach mają wymuszać ryzyko wysokie i review z lensem bezpieczeństwa. Uznać je za krytyczne?', options: [
        opt(rec('Tak, wszystkie wykryte'), describe('critical_paths', d.repo), 'repo'),
        opt('Nie, decyduje triage', 'Ryzyko wg słów kluczowych w zadaniu, bez wymuszania po ścieżkach.', 'default'),
      ] };
    case 'sensitivity': {
      const fams = sensitiveFamilies(reg);
      const derived = d.repo.default;
      const levels = [derived, ...['sensitive', 'internal', 'none'].filter((l) => l !== derived)].slice(0, 3);
      const text = { sensitive: `zadania domyślnie „sensitive”: trafiają tylko do rodzin z sensitive_ok (teraz: ${fams.join(', ') || 'żadna: wszystko zatrzyma się na fail-closed'})`, internal: 'prywatny kod bez sekretów; dozwolone wszystkie włączone rodziny (z lekką preferencją tych, które nie trenują na danych)', none: 'bez ograniczeń prywatności dla zadań w tym repo' };
      return { header: 'Wrażliwość', question: `Jaki domyślny poziom wrażliwości danych w tym repo (wykryto: ${[scan.sensitivity.secret_files_total && `pliki sekretów (${scan.sensitivity.secret_files.map((s) => s.path).join(', ')})`, scan.sensitivity.pii_dirs.length && 'katalogi z danymi osobowymi', scan.sensitivity.data_files.total && 'pliki danych', scan.docs.evidence.some((e) => /^\[[^\]]*privacy/.test(e)) && 'wzmianki o RODO/danych klientów w docs'].filter(Boolean).join(', ') || 'brak twardych sygnałów'})?`, options: levels.map((l, i) => (i === 0 ? opt(rec(`${l} (wg wykrytych sygnałów)`), text[l], 'repo') : opt(l, text[l], 'custom', { ...d.repo, default: l }))) };
    }
    case 'egm':
      return { header: 'EGM', question: 'Co robić przy zadaniach krytycznych (tryb EGM: projekt + recenzje Goldfish, bardzo kosztowny)?', options: [
        opt(rec('Pytaj (ask)'), 'Przy zadaniu krytycznym bramka egm_gate pokaże koszt i zapyta, zanim cokolwiek się wydarzy.', 'default'),
        opt('Wyłącz (off)', 'Bramka egm_gate nic nie robi w tym repo.', 'custom', 'off'),
      ] };
    default: return null;
  }
}

// Why each decision is (not) asked; unasked decisions follow the repo when it has a rule, else the default.
function needed(key, scan, d) {
  const prev = d.prev;
  if (prev && prev.evidence === evidenceHash(d.repo)) return { ask: false, why: 'unchanged since the last init' };
  switch (key) {
    case 'orchestrator': return d.repo ? { ask: true } : { ask: false, why: 'the repo ships no orchestrator of its own' };
    case 'commit': return differs('commit', d.def, d.repo) ? { ask: true } : { ask: false, why: d.repo ? 'repo rule equals the orchestrator default' : 'the repo says nothing about commits' };
    case 'branching': return differs('branching', d.def, d.repo) ? { ask: true } : { ask: false, why: 'the repo says nothing about branches/PRs' };
    case 'docs_duties': return d.repo?.length ? { ask: true } : { ask: false, why: 'no documentation duty found' };
    case 'verify': return d.repo && (differs('verify', d.def, d.repo) || d.repo.done_when?.length) ? { ask: true } : { ask: false, why: d.repo ? 'repo commands equal the detected ones' : 'no CI or documented verification commands' };
    case 'critical_paths': return d.repo?.length ? { ask: true } : { ask: false, why: 'no critical paths detected' };
    case 'sensitivity': return d.repo ? { ask: true } : { ask: false, why: 'no sensitivity signals' };
    case 'egm': return scan.critical_paths.length ? { ask: true } : { ask: false, why: 'no critical paths: EGM has nothing to gate' };
    default: return { ask: false };
  }
}

export function buildQuestions(scan, proposal, { reg } = {}) {
  const asked = [];
  const skipped = [];
  for (const key of DECISION_KEYS) {
    const d = proposal.decisions[key];
    const n = needed(key, scan, d);
    if (!n.ask) { skipped.push({ id: key, why: n.why }); continue; }
    const q = question(key, scan, d, reg);
    if (q) asked.push({ id: key, multiSelect: false, ...q });
  }
  const rounds = [];
  for (let i = 0; i < asked.length && rounds.length < MAX_ROUNDS; i += MAX_PER_ROUND) rounds.push(asked.slice(i, i + MAX_PER_ROUND).map((q) => q.id));
  return {
    questions: asked, rounds, skipped,
    share_question: { header: 'Zapis', question: 'Gdzie zapisać profil (plik w repo .claude/orchestrator.yaml dotyczy tylko części współdzielonej i NIE jest commitowany)?', options: [
      opt(rec('Tylko lokalnie'), 'Profil w ~/.claude/orchestrator/repos/ (poza repo).', 'local'),
      opt('Lokalnie + do repo', 'Dodatkowo blok repo_profile w <repo>/.claude/orchestrator.yaml (reguły repo bez Twoich osobistych wyborów); commit zostaje po Twojej stronie.', 'share'),
    ] },
  };
}
