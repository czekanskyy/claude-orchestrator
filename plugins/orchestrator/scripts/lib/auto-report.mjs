// Autonomous mode: everything the user reads is generated here, from the run directory's files only (state.json,
// decisions.jsonl, parked.md, limits.log, journal.md, usage.jsonl, contract.yaml), never from conversation memory.
// The report is Polish; the hand-over file is English because the interactive orchestrator (a model) loads it.
import fs from 'node:fs';
import { loadState, readJsonl, readHeartbeat, supervisorAlive, readControl } from './auto-core.mjs';
import { readContract } from './auto-contract.mjs';

const ICON = { done: '✅', running: '🔄', pending: '⏳', parked: '⚠️', failed: '❌' };
const STATUS_PL = {
  created: ['⏳', 'utworzony'], planning: ['🔄', 'planowanie'], running: ['🔄', 'w toku'], waiting: ['⏳', 'czeka (limity/sieć)'], paused: ['⏳', 'wstrzymany'], stopping: ['🔄', 'zatrzymywanie'],
  stopped: ['⚠️', 'zatrzymany w punkcie kontrolnym'], takeover_pending: ['🔄', 'przekazywanie'], handed_over: ['✅', 'przekazany do trybu zwykłego'], completed: ['✅', 'zakończony'],
  blocked: ['⚠️', 'zakończony, wymaga Twojej uwagi'], aborted: ['❌', 'przerwany'],
};
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

function load(paths) {
  const { state } = loadState(paths);
  let contract = null;
  try { contract = readContract(paths.contract); } catch { /* fixture runs may lack it */ }
  return { st: state, c: contract, decisions: readJsonl(paths.decisions), usage: readJsonl(paths.usage), limits: read(paths.limits).split('\n').filter(Boolean), journal: read(paths.journal).split('\n').filter(Boolean), parkedMd: read(paths.parked) };
}

// WAIT/WAKE pairs of limits.log -> { waits, minutes, events: [...] }
export function summarizeLimits(lines) {
  let waits = 0; let minutes = 0; let limitHits = 0; let reroutes = 0;
  for (const l of lines) {
    if (/ WAIT /.test(l)) waits++;
    const m = l.match(/ WAKE slept=(\d+) min| WAKE .* after (\d+) min/);
    if (m) minutes += Number(m[1] || m[2]);
    if (/ LIMIT /.test(l)) limitHits++;
    if (/ REROUTE /.test(l)) reroutes++;
  }
  return { waits, minutes, limit_hits: limitHits, reroutes, events: lines };
}

function mergeCommands(st, paths) {
  const wt = paths.worktree;
  return [
    `# podgląd: git -C "${st.repo}" log --oneline ${st.base_sha.slice(0, 8)}..${st.branch}`,
    `# podgląd: git -C "${st.repo}" diff --stat ${st.base_sha.slice(0, 8)}..${st.branch}`,
    `# przegląd z cofaniem pojedynczych pozycji: /orchestrator:auto review`,
    `# AKCEPTACJA (dopiero po Twoim tak; na gałęzi, na której chcesz mieć zmiany): git -C "${st.repo}" merge --no-ff ${st.branch}`,
    `# ODRZUCENIE całości: git -C "${st.repo}" worktree remove --force "${wt}" && git -C "${st.repo}" branch -D ${st.branch}`,
  ];
}

export function buildReport(paths, { final = false, now = Date.now() } = {}) {
  const { st, c, decisions, usage, limits, journal, parkedMd } = load(paths);
  if (!st) return '# Raport autonomicznego przebiegu\n\nBrak pliku stanu: nie ma z czego zbudować raportu.\n';
  const [icon, label] = STATUS_PL[st.status] || ['❔', st.status];
  const done = st.tasks.filter((t) => t.status === 'done');
  const parked = st.tasks.filter((t) => t.status === 'parked');
  const lim = summarizeLimits(limits);
  const started = Date.parse(st.created_at);
  const ended = st.finished_at ? Date.parse(st.finished_at) : now;
  const L = [];
  L.push(`# ${icon} Autonomiczny przebieg ${st.run_id}: ${label}${final || st.finished_at ? '' : ' (raport częściowy, przebieg trwa)'}`);
  L.push('', `**Cel:** ${c?.goal ? clip(c.goal, 300) : '(brak kontraktu)'}`);
  L.push(`**Gałąź:** \`${st.branch}\` (worktree: \`${st.worktree}\`), start od \`${(st.base_sha || '').slice(0, 8)}\` na \`${st.base_branch || '?'}\`. Nic nie zostało wypchnięte, gałąź \`${st.base_branch || 'główna'}\` jest nietknięta.`);
  L.push(`**Czas:** ${iso(started)} → ${st.finished_at ? iso(ended) : 'trwa'} (${fmtDur(ended - started)}), w tym oczekiwanie na limity/sieć: ${fmtDur(lim.minutes * 60000)} (${lim.waits}×).`);
  if (st.exit_reason) L.push(`**Powód zakończenia:** ${esc(st.exit_reason)}`);

  // what to look at first
  const first = [];
  for (const t of parked) first.push(`⚠️ **${t.id}** zaparkowane: ${esc(clip(t.parked_reason || '', 160))}`);
  for (const d of decisions.filter((x) => x.outcome === 'decided' && (x.confidence < 0.75 || x.rule === 'safest_minimal'))) first.push(`🤔 **${d.id}** wybór o niskiej pewności (${Math.round(d.confidence * 100)}%): ${esc(clip(d.question, 100))} → \`${esc(d.chosen)}\``);
  for (const [k, r] of Object.entries(st.final || {})) if (r?.findings?.some((f) => f.severity === 'high')) first.push(`🧐 końcowy przegląd (${k.replace('review_', '')}) zostawił ${r.high} znalezisk(a) wysokiej wagi`);
  if (st.final?.checks_ok === false) first.push('❌ końcowe testy/sprawdzenia są czerwone');
  for (const k of ['review_general', 'review_security']) if (st.final?.[k]?.skipped) first.push(`⚠️ pominięto końcowy przegląd ${k.replace('review_', '')}: ${esc(st.final[k].reason)} (kontrola jednorodzinna)`);
  if (lim.waits === 0 && st.limits?.claude?.overage_seen) first.push('💸 wykryto użycie ponad limit (overage): sprawdź rozliczenie');
  L.push('', '## Co sprawdzić najpierw', first.length ? first.map((x) => `- ${x}`).join('\n') : '- nic pilnego: wszystkie zadania zakończone, bez zaparkowanych pozycji.');

  // stages
  L.push('', '## Etapy');
  L.push('| | etap | wykonawca | próby | commit | uwagi |', '|---|---|---|---|---|---|');
  L.push(`| ${st.plan ? '✅' : '⏳'} | Plan | ${esc(st.plan?.by || '—')} | ${st.counters?.plan_attempts ?? 0} | — | ${esc(clip(st.plan?.approach || '', 100))} |`);
  for (const t of st.tasks) {
    const w = t.worker ? `${t.worker.family}/${t.worker.model}` : t.last_family || '—';
    L.push(`| ${ICON[t.status] || '❔'} | ${esc(t.id)} ${esc(clip(t.title, 60))} | ${esc(w)} | ${t.attempts + (t.status === 'done' ? 1 : 0)} | ${t.checkpoint?.sha ? `\`${t.checkpoint.sha.slice(0, 8)}\`` : '—'} | ${esc(clip(t.status === 'parked' ? t.parked_reason : t.review_unresolved?.length ? 'nierozwiązane uwagi recenzji (średnie)' : t.review_deferred?.length ? 'recenzja odroczona do końcowej' : '', 90))} |`);
  }
  const fin = st.final || {};
  L.push(`| ${fin.checks_done ? (fin.checks_ok ? '✅' : '❌') : '⏳'} | Końcowe testy | — | — | — | ${esc((fin.checks || []).map((x) => `${x.cmd}: ${x.code === 0 ? 'ok' : `kod ${x.code}`}`).join('; '))} |`);
  for (const lens of ['general', 'security']) {
    const r = fin[`review_${lens}`];
    if (r || lens === 'general') L.push(`| ${r ? (r.skipped ? '⚠️' : r.high ? '❌' : '✅') : '⏳'} | Przegląd całości (${lens === 'general' ? 'ogólny' : 'bezpieczeństwo'}) | ${esc(r?.by || '—')} | — | — | ${r?.skipped ? esc(r.reason) : r ? `${r.verdict}; ${r.high} wys. / ${r.med} śr. / ${r.low} nisk.` : ''} |`);
  }

  // changes
  L.push('', '## Co się zmieniło');
  if (!done.length) L.push('Brak zakończonych zadań.');
  for (const t of done) {
    const files = t.checkpoint?.files?.length ? `: ${t.checkpoint.files.slice(0, 8).map((f) => `\`${f}\``).join(', ')}${t.checkpoint.files.length > 8 ? ` (+${t.checkpoint.files.length - 8})` : ''}` : '';
    L.push(`- **${esc(t.id)}** ${esc(t.title)} — ${t.checkpoint?.sha ? `\`${t.checkpoint.sha.slice(0, 8)}\`` : 'bez zmian w plikach'}${files}`);
  }
  L.push('', `**Sprawdzenia przy każdym punkcie kontrolnym:** ${c ? [...['test', 'typecheck', 'lint', 'build'].map((k) => c.verify?.[k]).filter(Boolean), ...(c.verify?.extra || [])].map((x) => `\`${x}\``).join(', ') : '—'}; nieudany punkt cofał się do poprzedniego (prób: ${st.tasks.reduce((a, t) => a + (t.failures || 0), 0)} niepowodzeń).`);

  // decisions
  L.push('', '## Decyzje podjęte bez pytania');
  if (!decisions.length) L.push('Brak decyzji wymagających zapisu.');
  else {
    L.push('| id | zadanie | pytanie | wybór | pewność | odwracalność | druga opinia | cofnięcie |', '|---|---|---|---|---|---|---|---|');
    for (const d of decisions) {
      const so = d.second_opinion ? (d.second_opinion.choice ? `${d.second_opinion.family}: ${d.second_opinion.agrees ? 'zgoda' : `inny wybór (${d.second_opinion.choice})`}` : 'niedostępna') : '—';
      L.push(`| ${d.id} | ${esc(d.task || 'plan')} | ${esc(clip(d.question, 70))} | ${d.outcome === 'parked' ? '**zaparkowane**' : `\`${esc(d.chosen)}\``} | ${Math.round((d.confidence || 0) * 100)}% | ${d.reversibility === 'irreversible' ? 'nieodwracalna' : 'odwracalna'} | ${esc(so)} | ${d.undo ? `\`${esc(d.undo)}\`` : esc(d.undo_note || '—')} |`);
    }
  }

  // parked
  L.push('', '## Zaparkowane (wymagają Ciebie)');
  if (!parked.length) L.push('Nic nie zaparkowano.');
  else for (const t of parked) L.push(`- **${esc(t.id)}** ${esc(t.title)}: ${esc(t.parked_reason)}${t.parked_ref ? ` — odrzucone zmiany: \`git -C "${st.worktree}" diff ${(t.base_sha || '').slice(0, 8)}..${t.parked_ref}\`` : ''}`);
  if (parkedMd.trim() && !parked.length) L.push('', parkedMd.trim());

  // cross-model
  L.push('', '## Kontrola między modelami');
  if (!st.reviews?.length) L.push('Brak recenzji (zadania zwolnione z recenzji lub brak drugiej rodziny).');
  else for (const r of st.reviews) L.push(`- ${r.task === '*' ? 'całość' : r.task} (${r.lens}, runda ${r.round}): ${r.by} → ${r.of}: ${r.verdict}, ${r.high} wys. / ${r.med} śr. / ${r.low} nisk.${r.fixed ? `, naprawiono ${r.fixed}` : ''}`);

  // EGM (only tasks that went through the gate with a real outcome)
  const egmTasks = st.tasks.filter((t) => t.egm && t.egm.status !== 'skipped');
  if (egmTasks.length) {
    L.push('', '## EGM (projekt i recenzje Goldfish dla zadań krytycznych)');
    for (const t of egmTasks) {
      const e = t.egm;
      const c = e.counts || {};
      const base = `**${esc(t.id)}** ${e.status === 'done' ? '✅' : e.status === 'failed' ? '⚠️' : '🔄'}`;
      if (e.status !== 'done') { L.push(`- ${base} ${e.status === 'failed' ? `nie powiodło się: ${esc(e.reason || 'nieznany powód')}` : 'w toku'}`); continue; }
      const drift = e.drift ? (e.drift.skipped ? `pominięty (${esc(e.drift.skipped)})` : `${e.drift.items} rozbież.${e.drift.fixed ? `, naprawiono ${e.drift.fixed}` : ''}`) : 'nie sprawdzano';
      L.push(`- ${base} projekt \`${esc(e.design_file || '')}\`${e.files_listed ? ` (${e.files_listed} plików w planie)` : ''}; Goldfish: ${c.blocker || 0} bloker. / ${c.major || 0} poważnych / ${c.nit || 0} drobnych${e.resolve ? `, naprawiono ${e.resolve.applied}, zakwestionowano ${e.resolve.contested}` : ''}${c.not_run?.length ? `; NIE uruchomiono: ${c.not_run.join(', ')}` : ''}; dryf: ${drift}`);
    }
  }

  // limits
  L.push('', '## Limity i przekierowania');
  L.push(`- trafienia w limit: ${lim.limit_hits}; oczekiwania: ${lim.waits} (łącznie ${fmtDur(lim.minutes * 60000)}); przekierowania do innych rodzin: ${st.events?.reroutes ?? 0}; eskalacje: ${st.events?.escalations ?? 0}`);
  for (const e of lim.events.filter((l) => / (LIMIT|WAIT) /.test(l)).slice(0, 10)) L.push(`  - \`${esc(clip(e, 170))}\``);
  const lc = st.limits?.claude;
  if (lc) L.push(`- ostatni odczyt Claude: 5 h ${lc.five_hour?.pct ?? '?'}%, tydzień ${lc.seven_day?.pct ?? '?'}% (odczyt dokładny z nagłówków CLI; dla innych rodzin część wartości to szacunki)`);

  // tokens
  const byFam = {};
  for (const u of usage) { const f = (byFam[u.family] ||= { ticks: 0, tokens: 0, fresh: 0 }); f.ticks++; f.tokens += u.tokens || 0; f.fresh += u.fresh || 0; }
  L.push('', '## Zużycie');
  if (!Object.keys(byFam).length) L.push('Brak zapisanych wywołań.');
  else for (const [f, u] of Object.entries(byFam)) L.push(`- ${f}: ${u.ticks} wywołań, ${(u.fresh / 1000).toFixed(1)}k tokenów nowych (${(u.tokens / 1000).toFixed(0)}k z cache)`);

  L.push('', '## Jak przyjąć albo odrzucić', '```', ...mergeCommands(st, paths), '```');
  if (final || st.finished_at) L.push('', `_Raport wygenerowany z plików przebiegu (journal.md, decisions.jsonl, parked.md, limits.log, state.json) w \`${paths.dir}\`._`);
  else L.push('', `_Raport częściowy z ${iso(now)}; nie zmienia trybu ani nie przerywa pracy. Ostatnie wpisy dziennika:_`, ...journal.slice(-5).map((j) => `> ${clip(j, 200)}`));
  return `${L.join('\n')}\n`;
}

// Compact status for `status` (read-only).
export function buildStatus(paths, { now = Date.now() } = {}) {
  const { st, c, decisions, limits } = load(paths);
  if (!st) return 'Brak stanu przebiegu.';
  const [icon, label] = STATUS_PL[st.status] || ['❔', st.status];
  const hb = readHeartbeat(paths);
  const alive = supervisorAlive(paths, now);
  const ctl = readControl(paths);
  const L = [`${icon} ${st.run_id}: ${label}${ctl.stop ? ' (STOP zlecony)' : ''}${ctl.pause ? ' (PAUSE zlecony)' : ''}`];
  L.push(`supervisor: ${alive ? `działa (puls ${Math.round((now - (hb?.ts || now)) / 1000)} s temu)` : st.finished_at ? 'zakończył pracę' : '⚠️ nie działa (użyj: /orchestrator:auto continue)'}`);
  if (st.wait) L.push(`czeka: ${esc(st.wait.reason)}${st.wait.until ? `, do ${iso(st.wait.until)}` : ' (sonda bez tokenów)'}`);
  L.push('', '| | zadanie | uwagi |', '|---|---|---|');
  for (const t of st.tasks) L.push(`| ${ICON[t.status] || '❔'} | ${esc(t.id)} ${esc(clip(t.title, 50))} | ${esc(clip(t.status === 'parked' ? t.parked_reason : t.checkpoint?.sha ? t.checkpoint.sha.slice(0, 8) : '', 60))} |`);
  const lc = st.limits?.claude;
  L.push('', `limity Claude: 5 h ${lc?.five_hour?.pct ?? '?'}% · tydzień ${lc?.seven_day?.pct ?? '?'}% · decyzji: ${decisions.length} · zaparkowane: ${st.tasks.filter((t) => t.status === 'parked').length} · oczekiwania: ${summarizeLimits(limits).waits}`);
  if (c?.deadline) L.push(`termin: ${c.deadline}`);
  return L.join('\n');
}

// English hand-over for the interactive orchestrator (takeover): compact ledger + journal summary.
export function buildHandoff(paths, { now = Date.now() } = {}) {
  const { st, c, decisions, journal } = load(paths);
  if (!st) return '# Handoff\n\nNo state.\n';
  const L = [`# Handoff: autonomous run ${st.run_id}`, '', `Taken over at ${new Date(now).toISOString()}. Continue in NORMAL orchestrator mode (standard silence policy and status tables), working in the worktree below.`];
  L.push('', `- worktree: \`${st.worktree}\` on branch \`${st.branch}\` (base \`${st.base_branch}\` @ ${(st.base_sha || '').slice(0, 8)}); last verified checkpoint: \`${(st.checkpoint_sha || '').slice(0, 8)}\`; the tree is clean at that checkpoint`);
  L.push(`- goal: ${c?.goal || '(no contract)'}`, `- definition of done: ${(c?.definition_of_done || []).join(' | ')}`);
  L.push(`- verify with: ${c ? [...['test', 'typecheck', 'lint', 'build'].map((k) => c.verify?.[k]).filter(Boolean), ...(c.verify?.extra || [])].join(' ; ') : '?'}`);
  L.push(`- contract limits: dependencies=${c?.dependencies}, network=${c?.network}, sensitivity=${c?.sensitivity}, protected=${(c?.protected_paths || []).join(', ') || 'none'}; no push, merging only on the user's explicit yes`);
  L.push('', '## Tasks', '| id | status | type C/R | deps | note |', '|---|---|---|---|---|');
  for (const t of st.tasks) L.push(`| ${t.id} ${esc(clip(t.title, 60))} | ${t.status}${t.checkpoint?.sha ? ` ${t.checkpoint.sha.slice(0, 8)}` : ''} | ${t.type || '-'} ${t.complexity || '-'}/${t.risk || '-'} | ${(t.deps || []).join(',') || '-'} | ${esc(clip(t.parked_reason || t.note || '', 90))} |`);
  L.push('', '## Decisions so far', decisions.length ? decisions.map((d) => `- ${d.id} [${d.task || 'plan'}] ${clip(d.question, 80)} -> ${d.outcome === 'parked' ? 'PARKED' : d.chosen} (${Math.round((d.confidence || 0) * 100)}%)`).join('\n') : '- none');
  L.push('', '## Journal (last entries)', ...journal.slice(-15));
  L.push('', '## How to continue', 'Create a normal run (`run.mjs init`), add a row for every pending task, and dispatch as usual. Interrupted work is snapshotted in `refs/auto/<run>/wip/<task>` (`git -C <worktree> diff HEAD..<ref>`).');
  return `${L.join('\n')}\n`;
}
