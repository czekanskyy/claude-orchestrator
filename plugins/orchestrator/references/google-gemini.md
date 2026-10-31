# Google Gemini via the Antigravity CLI (`agy`)

Checked: 2026-10-31 (agy 1.4.12, logged in). Details of the connectivity research: `docs/research-connectivity.md`.

- **Headless call**: `agy -p <prompt> --output-format json --model <id>-<effort> --mode plan|accept-edits --print-timeout <N>s [--conversation <id>] [--settings <file>] [--add-dir <dir>]`. The prompt is the last argument. Effort is part of the model id (`gemini-3.8-flash-low|medium|high`).
- **Result**: one JSON envelope (`status`, `response`, `conversation_id`, `usage{input,output,thinking,cache_read,total}`). `status != SUCCESS` is an error. A denied permission exits 0 and only prints a notice on stderr; the adapter appends it to `text`.
- **Models**: `agy models` (zero tokens) lists `<id>\t<label>`. It also lists third-party Claude/GPT-OSS models; they are ignored (`excluded_models: agy-third-party`).
- **Sessions**: `--conversation <conversation_id>` resumes a worker's own thread for fix rounds.
- **Permissions**: `plan` = read-only; `accept-edits` for implement mode, shell commands only through `--allow-cmd` (written to a session-only settings file). No deny rules for secret files exist, so the adapter's privacy gate and secret scan are the barrier.
- **Privacy**: consumer Gemini plans have no training opt-out, so the catalog sets `sensitive_ok: false` and the router never sends `sensitive` work here. A Workspace/Enterprise plan with a data-protection agreement can be set to `sensitive_ok: true` in `/orchestrator:configure` after the user checked the terms.
- **Open risks**: whether consumer-plan use through a CLI wrapper is within Google's terms (flagged in adapter warnings); Windows non-TTY stdout issue (check with `/orchestrator:doctor --live`). The model stays `status: unverified` until a live call passes.
- **Limits**: no programmatic readout; the pool is an estimate (`~`) fed by the usage log.
