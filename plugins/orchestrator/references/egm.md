# Elephant-Goldfish Model (EGM): what the orchestrator relies on

Short, sourced summary of EGM as shipped in the `egm` plugin v0.1.0 (Google, Apache-2.0). The orchestrator does not copy or reimplement it: it reads the installed plugin's skills, personas and standards at run time (`scripts/lib/egm.mjs`). How the orchestrator drives it: [egm-flow.md](egm-flow.md). Re-verify with `/orchestrator:update` (it compares the installed plugin with the fingerprint recorded in `models.yaml`).

## Sources
- Repository and install: <https://github.com/google/elephant-goldfish-model> · site <https://egm.dev/> · announcement <https://opensource.googleblog.com/2026/10/introducing-elephant-goldfish-model-plugin.html> · paper/essay <https://research.google/pubs/elephants-goldfish-and-the-new-golden-age-of-software-engineering/>
- Installed copy read for this summary (`docs/index.md`, `getting_started.md`, `claude.md`, `codex.md`, `harnesses.md`, `privacy.md`, `faq.md`; `skills/egm-*/SKILL.md`; `agents/*.md`; `resources/`): `~/.claude/plugins/cache/egm/egm/0.1.0/`.

## The two roles
- **Elephant**: the persistent context that remembers everything about the system and the design. It brainstorms, drafts the design doc, applies review findings and implements. It is the main conversation in EGM's own flow.
- **Goldfish**: a reviewer with a three-second memory: a fresh subagent that sees only the design document (plus the files it links and an optional reading list) and a persona and standard, never how the document was produced. That is what exposes unstated assumptions and hallucinations. A Goldfish that fails or times out has *not run*; it is never counted as "no findings".
- **Humans** own the outcome: EGM adds a human design review before implementation and does not replace it.

## Stages and skills (all `disable-model-invocation: true`: read the `SKILL.md` and follow it in the same thread; the Skill tool refuses them)
| Step | Skill | What it does |
|---|---|---|
| ideation | `egm-brainstorm` | interactive clarification, then a 6-lens Goldfish swarm (via `egm-synthesizer`) → `concepts_brief.md` |
| design | `egm-draft` | drafts `design_draft.md` section by section (Overview & Goals, Technical Plan, Alternatives, Detailed Implementation) from the brief, with an approval gate per section; final doc to `docs/designs/<feature>.md` (+ `SITEMAP.md`). Rule 13: **the owner decides architecture** (up to three neutral options, no ranking, no default) |
| review | `egm-review` | five sequential stages: 5 zoom-out (full file) → 6 comprehension (feature + detailed range, naive reader) → 7 critic (`egm-design`, `egm-structural`, `egm-style` on the feature part) → 8 intermediate zoom-out → 9 implementation readiness (`egm-implementation-readiness`, `egm-codebase-details`, `egm-style` on the detailed plan). Presets: full · feature spec only (5-8) · implementation plan only (9). Stages must run in order; remediation happens between them |
| loop | `egm-review-loop` | re-audit loop used by stages 7 and 9 (converged = two clean rounds, cap 5, max 1 re-audit inside `egm-review`) |
| resolve | `egm-resolve` | the Elephant classifies each finding (CONTEST / ESCALATE / PROPOSE FIX / DECLINE), writes `goldfish_review_report.md`, applies approved fixes |
| drift | `egm-drift-report` | compares each design doc with the code, writes `{YYYY-MM-DD}_DRIFT_REPORT.md`; recommended weekly |
| bootstrap | `egm-bootstrap` | builds README context hierarchies for existing code (not used by the orchestrator) |

Agents (Claude adapters in `.claude-plugin/agents/`, canonical personas in `agents/`): `egm:egm-zoom-out`, `-comprehension`, `-design`, `-structural`, `-style`, `-implementation-readiness`, `-codebase-details` (read-only, `omitClaudeMd: true`, `model: inherit`), `-synthesizer` (spawns and merges reviewers, may write the report; nesting up to 3 levels) and `-bootstrap-orchestrator`.

## Artifacts and where they live
Briefs, drafts and reports go to the working directory, or to the folder named by a line `EGM artifact directory: <path>` in the prompt or `CLAUDE.md`/`AGENTS.md` (the per-session scratchpad is wrong: artifacts must outlive it). Files: `concepts_brief.md`, `design_draft.md`, `zoom_out_report.md`, `comprehension_report.md`, `critic_report.md`, `intermediate_zoom_out_report.md`, `implementation_readiness_report.md`, `goldfish_review_report.md`, `consolidated_review_report.md`, drift reports. Final design docs belong in the repo (`docs/designs/`); the rest can stay out of git. EGM has no telemetry or service (`docs/privacy.md`): everything is processed by the host's own account.

## Cost drivers
EGM is deliberately heavy (`docs/faq.md`: use it for "what is important now", not everything). Drivers: the design pass by the strongest model; ~13 reviewer/synthesizer agents per full review (more with A/B reviewer instances or loop rounds), each starting cold and re-reading the design and linked code; resolve turns that keep the Elephant's context growing; the brainstorm swarm (6 more agents). Reviews "provide a lot of feedback by design". Nothing in the docs measures tokens; the orchestrator's estimate is registry units, not tokens.

## Harnesses (`docs/harnesses.md`, `claude.md`, `codex.md`)
- **Claude Code** (>= 2.1.271 for `omitClaudeMd`): `claude plugin marketplace add google/elephant-goldfish-model && claude plugin install egm@egm`; Goldfish = new native Agent of the registered type.
- **Codex**: `codex plugin marketplace add … && codex plugin add egm@egm`; no named personas: a general-purpose agent reads the persona file; `fork_context: false` / `fork_turns: "none"` is required for isolation.
- **Antigravity** (CLI/App/IDE extension): `agy plugin install <repo URL>` or copy into `~/.gemini/config/plugins/egm/`; `invoke_subagent` for Goldfish; the standalone IDE is unsupported.
- A harness without a fresh-context subagent tool must stop: a review in the same context is not a Goldfish review.
- Support status in 0.1.0: Claude Code, Codex and Antigravity pass the maintainers' fixtures; Cowork and ChatGPT Work have open verification gaps.

## How the orchestrator uses it (and where it differs from EGM's own flow)
- Uses the real skills, personas and standards; adds the `critical` rubric, a registry-based cost estimate, a consent gate, model/effort routing of every agent, personas/status tables and routing of the implementation phase to the usual workers.
- **Elephant = a dedicated agent**, not the main conversation, so the orchestrator's context stays lean (`agents/egm-elephant.md`, resumed with SendMessage so it keeps its memory). The orchestrator's vetted prompt replaces the brainstorm; section approval gates are replaced by one design approval; reviews run as the official "uninterrupted" flow with remediation between stages; Resolve runs in "auto accept" mode, ESCALATE items go to the user.
- **Goldfish** are the `egm:*` agents on the Claude family by default (isolation documented for Claude Code). `egm.goldfish: cross` adds one design-critic review by another family through the existing adapter, only when the privacy filter allows it; this follows the documented Codex/Antigravity personas-as-files approach but is not covered by EGM's own fixtures.
- Drift check: the real `egm-drift-report` procedure, run by a fresh read-only reviewer on the finished change.
