#!/usr/bin/env node
// Backend of /orchestrator:init (one-time, user-triggered, per-repository setup). The interview (AskUserQuestion) lives
// in the skill; this script does the deterministic parts. Zero model tokens. Never commits; writes only the profile.
//   plan [--repo D] [--refresh]            state (empty|exists|ready) + compact scan + questions in rounds (reads, writes nothing)
//   dry-run [--repo D]                     the proposed profile, questions and consequences as text (reads, writes nothing)
//   apply --answers F|- [--share] [--repo D] [--dry-run]   settle answers over the repo's rules and the defaults, write the profile
//   show [--repo D]                        stored profile as a Polish summary + freshness
//   status [--repo D]                      JSON: none|ok|stale|invalid|empty and what changed
//   rules [--repo D]                       the rules block the workflow consumes (English)
// Answers: { "<decision>": "repo"|"default"|"merge" | {"choice":"custom","value":…}, "_repo": { "<decision>": refined repo value } }
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRegistry, parseArgs, repoRoot, out, fail, writeProjectPref } from './lib/common.mjs';
import { repoIdentity } from './lib/repo-facts.mjs';
import { repoIsEmpty, repoProfileStatus, readRepoProfile, applyAnswers, buildProfile, validateProfile, serializeProfile, writeLocalProfile, writeSharedProfile, rulesFrom, rulesLines, DECISION_KEYS } from './lib/repo-profile.mjs';
import { buildProposal, buildQuestions, describe } from './lib/repo-questions.mjs';
import { scanRepo, compactScan } from './repo-scan.mjs';

const today = () => new Date().toISOString().slice(0, 10);

// What the scan found, for the user and for the model (Polish, one line each).
export function highlights(scan) {
  const r = scan.repo;
  const c = scan.commits || {};
  const L = [];
  L.push(`Repo: ${scan.identity.id} · gałąź ${r.current_branch || '?'} · domyślna ${r.default_branch?.name || '?'}${r.default_branch?.verified ? '' : ' (niezweryfikowana)'} · ${r.files} plików, ${r.commit_count} commitów${r.dirty.total ? ` · drzewo robocze: ${r.dirty.total} zmian (init ich nie dotyka)` : ''}`);
  if (c.style) L.push(`Commity (próbka ${c.sampled}): styl ${c.style} (${Math.round((c.confidence || 0) * 100)}%), język ${c.language}${c.tags?.length ? `, tagi ${c.tags.join('/')}` : ''}; merge’e ${c.merge_commits}, PR-merge’e ${c.pr_merges}; ślady AI w historii: ${c.ai_trailers}`);
  if (scan.branches.patterns.length) L.push(`Gałęzie: ${scan.branches.patterns.map((p) => `${p.pattern} ×${p.n}`).join(', ')}; stałe: ${scan.branches.fixed.join(', ') || '—'}`);
  const cmds = Object.entries(scan.stack.commands).map(([k, v]) => `${k}=${v.cmd}`).join(' · ');
  L.push(`Stack: ${scan.stack.languages.join('/') || '?'}${scan.stack.package_manager ? ` (${scan.stack.package_manager})` : ''} · ${cmds || 'brak wykrytych poleceń'}`);
  const ci = scan.policies.ci;
  if (ci.files.length) L.push(`CI: ${ci.files.length} workflow(s); weryfikacja: ${ci.verification.map((v) => v.cmd).join('; ') || '—'}`);
  const p = scan.policies;
  L.push(`Polityki: commit docs=${p.hints.commit.docs || '—'} settings=${p.hints.commit.settings || '—'}; push docs=${p.hints.push.docs || '—'} settings=${p.hints.push.settings || '—'}; bez śladów AI=${p.hints.no_ai_attribution}; baza wg docs=${p.hints.docs_base_branch || '—'}; PR z orkiestratora zakazane=${p.hints.pr_never}${p.hooks.husky.length || p.hooks.lefthook || p.hooks.pre_commit || p.hooks.git_hooks.length ? '; hooki git są' : ''}${p.codeowners ? `; CODEOWNERS (${p.codeowners.rules})` : ''}`);
  const o = scan.orchestrators;
  if (o.repo_level.length || o.agents.length || o.other_tools.length) L.push(`Inne orkiestratory/agenci: ${o.repo_level.map((x) => x.invoke).join(', ') || 'brak własnego'} · ${o.agents.length} agentów, ${o.skills.length} skilli${o.docs.length ? ` · docs: ${o.docs.join(', ')}` : ''}${o.other_tools.length ? ` · reguły innych narzędzi: ${o.other_tools.join(', ')}` : ''}`);
  const s = scan.sensitivity;
  L.push(`Wrażliwość: pliki sekretów ${s.secret_files_total} (${s.secret_files.map((x) => `${x.path}${x.tracked ? ' [W GIT!]' : ''}`).join(', ') || '—'}; tylko nazwy, treści nie czytano) · katalogi z danymi osobowymi ${s.pii_dirs.length} · pliki danych ${s.data_files.total}`);
  if (scan.critical_paths.length) L.push(`Ścieżki krytyczne (wykryte): ${scan.critical_paths.map((x) => x.glob).join(', ')}`);
  for (const x of scan.conflicts.filter((k) => !['orchestrator', 'dirty_tree'].includes(k.id))) L.push(`⚠ ${x.id}: ${x.detail}`);
  return L;
}

function profileSummary(profile, status) {
  const d = profile.decisions || {};
  const L = [`Profil repo: ${profile.identity} (zapisany ${profile.updated || '?'}, źródło: ${status.source})`];
  for (const key of DECISION_KEYS) if (d[key] !== undefined) L.push(`- ${key}: ${describe(key, d[key])}${profile.choices?.[key] ? ` [${profile.choices[key]}]` : ''}`);
  if (status.state === 'stale') L.push(`⚠ Dokumenty źródłowe zmieniły się od zapisu profilu (${[...status.diff.changed, ...status.diff.removed.map((x) => `${x} (usunięty)`), ...status.diff.added.map((x) => `${x} (nowy)`)].slice(0, 6).join(', ')}): \`/orchestrator:init --refresh\``);
  return L.join('\n');
}

function resolveRoot(a) {
  const root = a.repo ? path.resolve(a.repo) : repoRoot();
  return root && fs.existsSync(root) ? root : null;
}

function stage(root, { refresh = false, reg = loadRegistry() } = {}) {
  const scan = scanRepo(root, { reg });
  if (scan.empty) return { scan };
  const found = readRepoProfile(root);
  const existing = found.profile && found.source !== 'shared' ? found.profile : null;
  const proposal = buildProposal(scan, { reg, existing: refresh ? existing : null });
  return { scan, proposal, questions: buildQuestions(scan, proposal, { reg }), found, reg };
}

function previewProfile(root, scan, proposal, answers = {}) {
  const applied = applyAnswers(proposal, answers);
  const identity = repoIdentity(root);
  return buildProfile({ identity, fingerprint: scan.fingerprint, ...applied, today: today() });
}

function dryRunText(root, st) {
  const { scan, proposal, questions } = st;
  const L = ['# /orchestrator:init --dry-run (nic nie zapisano)', '', '## Wykryto', ...highlights(scan).map((x) => `- ${x}`), '', '## Decyzje: reguła repo vs domyślne orkiestratora'];
  for (const key of DECISION_KEYS) {
    const d = proposal.decisions[key];
    const asked = questions.questions.find((q) => q.id === key);
    L.push(`- **${key}**: repo → ${d.repo === undefined ? '(brak reguły)' : describe(key, d.repo)} | domyślnie → ${describe(key, d.def)} | ${asked ? '**pytanie**' : `bez pytania (${questions.skipped.find((s) => s.id === key)?.why || 'n/a'})`}`);
  }
  L.push('', `## Pytania (${questions.questions.length}, rund: ${questions.rounds.length}, rekomendacja pierwsza)`);
  for (const q of questions.questions) {
    L.push(`### [${q.header}] ${q.question}`, ...q.options.map((o) => `- ${o.label}: ${o.description}`));
  }
  L.push(`### [${questions.share_question.header}] ${questions.share_question.question}`, ...questions.share_question.options.map((o) => `- ${o.label}: ${o.description}`));
  const profile = previewProfile(root, scan, proposal);
  L.push('', '## Profil, gdyby przyjąć rekomendacje (pytanie o zapis pominięte)', '```yaml', serializeProfile({ ...profile, fingerprint: { hash: profile.fingerprint.hash, sources: { '(…)': `${Object.keys(profile.fingerprint.sources).length} plików` } } }).trimEnd(), '```');
  return L.join('\n');
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest, { flags: ['refresh', 'share', 'dry-run', 'md'] });
  const root = resolveRoot(a);
  if (!cmd || cmd === 'help') { process.stdout.write('init.mjs plan [--refresh] | dry-run | apply --answers <file|-> [--share] [--dry-run] | show | status | rules  (all take --repo DIR)\n'); return; }
  if (!root) return fail('not inside a repo (no .git / CLAUDE.md / .claude/skills found); pass --repo <path>');
  if (cmd === 'status') return out(repoProfileStatus(root));
  if (cmd === 'rules') {
    const found = readRepoProfile(root);
    return process.stdout.write(`${found.profile ? rulesLines(rulesFrom(found.profile)).join('\n') : 'no repo profile'}\n`);
  }
  if (cmd === 'show') {
    const st = repoProfileStatus(root);
    if (['none', 'empty', 'no-repo'].includes(st.state)) return process.stdout.write(st.state === 'empty' ? 'To repo jest puste: nie ma czego profilować.\n' : 'Brak profilu dla tego repo. Uruchom /orchestrator:init.\n');
    if (st.state === 'invalid') return fail(`profile invalid: ${st.errors.join('; ')}`);
    return process.stdout.write(`${profileSummary(st.profile, st)}\n`);
  }
  if (cmd === 'plan' || cmd === 'dry-run') {
    if (repoIsEmpty(root)) return cmd === 'dry-run' ? process.stdout.write('To repo jest puste: /orchestrator:init jest dla repo z istniejącą zawartością.\n') : out({ state: 'empty', message: 'To repo jest puste: /orchestrator:init jest dla repo z istniejącą zawartością.' });
    const status = repoProfileStatus(root);
    if (cmd === 'plan' && !a.refresh && ['ok', 'stale'].includes(status.state)) {
      return out({ state: 'exists', summary: profileSummary(status.profile, status), freshness: status.state, offer: ['--refresh', '--show'], note: 'Profil już istnieje: pokaż podsumowanie i zaproponuj --refresh lub --show; nie uruchamiaj ponownie.' });
    }
    const st = stage(root, { refresh: !!a.refresh });
    if (cmd === 'dry-run') return process.stdout.write(`${dryRunText(root, st)}\n`);
    // one compact line: the model's input, not a report (the Polish highlights live in the dry-run text)
    return process.stdout.write(`${JSON.stringify({
      state: 'ready', refresh: !!a.refresh, repo: root, scan: compactScan(st.scan),
      questions: st.questions.questions, rounds: st.questions.rounds, skipped: st.questions.skipped, share_question: st.questions.share_question,
      next: 'Ask the questions (≤4 per AskUserQuestion call, rounds as given), build answers JSON, then `init.mjs apply --answers <file> [--share]`.',
    })}\n`);
  }
  if (cmd === 'apply') {
    if (!a.answers) return fail('usage: apply --answers <file.json | -> [--share] [--dry-run]');
    let answers;
    try { answers = JSON.parse(a.answers === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(a.answers, 'utf8')); } catch (e) { return fail(`answers are not valid JSON: ${e.message}`); }
    if (repoIsEmpty(root)) return fail('empty repo: nothing to profile');
    const st = stage(root, { refresh: true });
    let profile;
    try { profile = previewProfile(root, st.scan, st.proposal, answers); } catch (e) { return fail(e.message); }
    const v = validateProfile(profile);
    if (!v.ok) return fail('invalid profile (nothing written)', { errors: v.errors });
    if (a['dry-run']) return out({ ok: true, dry_run: true, profile });
    const identity = repoIdentity(root);
    const file = writeLocalProfile(profile, identity);
    const written = { profile: file };
    // The repo's own orchestrator switch lives in projects.yaml (existing per-repo preference); only meaningful when the repo ships one.
    if (st.scan.orchestrators.repo_level.length && profile.decisions.orchestrator) {
      writeProjectPref(root, { orchestrator: profile.decisions.orchestrator });
      written.projects_yaml = 'orchestrator preference updated';
    }
    if (a.share) written.shared = writeSharedProfile(root, profile);
    return out({ ok: true, written, decisions: profile.decisions, choices: profile.choices, fingerprint: { hash: profile.fingerprint.hash, files: Object.keys(profile.fingerprint.sources).length }, committed: false, note: 'Nothing was committed or staged; the repo-side file (if any) is for you to review and commit.' });
  }
  return fail(`unknown command ${cmd}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => fail(e.message));
}
