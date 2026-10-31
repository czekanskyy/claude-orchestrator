# claude-orchestrator

Prywatny plugin Claude Code: główna sesja jest orkiestratorem, deleguje pracę subagentom Claude
(Opus, Sonnet, Haiku) i workerom Codex (GPT) przez plugin Codexa, a każdą zmianę sprawdza druga
rodzina modeli.

## v3 (3.0.0)

Plugin obsługuje rodziny Claude, GPT (Codex), Grok i Gemini (Antigravity CLI), model prywatności
(zadania `sensitive` trafiają tylko do rodzin, które nie trenują na danych) i trzy komendy:
`/orchestrator:configure` (kreator, zapis w `~/.claude/orchestrator/config.yaml`),
`/orchestrator:doctor` (kontrola offline, `--live` robi jedno minimalne wywołanie na rodzinę),
`/orchestrator:update` (aktualizacja rejestru modeli z diffem i zgodą). Stan użytkownika jest poza repo.
Szczegóły: `plugins/orchestrator/CHANGELOG.md`, `docs/research-connectivity.md`.
Uwaga: po instalacji z marketplace edycje `models.yaml` robione przez `/orchestrator:update` żyją w cache
pluginu i znikają przy aktualizacji pluginu; trwałą zmianę zrób w tym repo i zainstaluj ponownie.

## Zawartość

- `plugins/orchestrator/agents/`: `planner`, `security-reviewer`, `implementer`, `debugger`,
  `reviewer`, `runner`, `scribe`, dostępni jako `orchestrator:<rola>`.
- `plugins/orchestrator/skills/orchestrate/`: skill `orchestrator:orchestrate` z procedurą
  (`roster.md`: kto co robi, `codex.md`: jak wołać Codexa).
- `global/CLAUDE.md`: globalna instrukcja dla `~/.claude/CLAUDE.md` (plugin nie przenosi tego pliku).

## Instalacja na nowym komputerze

1. Codex CLI zainstalowany i zalogowany (`codex login`).
2. W Claude Code:

```
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/codex:setup --disable-review-gate
/plugin marketplace add czekanskyy/claude-orchestrator
/plugin install orchestrator@czekanskyy-tools
```

Repo jest prywatne, więc `gh auth login` (albo inny dostęp git do GitHuba) musi działać na tym
komputerze.

3. Skopiuj `global/CLAUDE.md` do `~/.claude/CLAUDE.md` (albo dopisz jego treść do istniejącego).

## Aktualizacja

Zmiany w tym repo, potem podbij `version` w `plugins/orchestrator/.claude-plugin/plugin.json`
i w `.claude-plugin/marketplace.json`, commit i push. Na pozostałych komputerach:

```
/plugin marketplace update czekanskyy-tools
```

## Pierwszeństwo

Projekt z własną orkiestracją (np. `docs/orchestration.md`, `.claude/skills/orchestrate`,
`.claude/agents/`) wygrywa: skill to wykrywa i przechodzi na zasady projektu.
