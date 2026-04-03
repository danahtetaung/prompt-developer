# AI Dev Agent

Local AI Dev Agent pipeline that watches source changes, builds enriched context, detects intent, generates a structured Cursor prompt, and delivers that prompt through configurable output modes.

## Project Profile

Edit `project-profile.json` to describe your project scope and audience (for example `personal`, `b2b_saas`, or `everything`), plus business/technical context and delivery preferences.

## Run Modes

- `npm run watch` or `npm run watch:clipboard`
  - Writes `prompts/latest.md`
  - Writes timestamped history in `prompts/history/`
  - Copies the prompt to clipboard
- `npm run watch:cursorrules`
  - Writes dynamic rule files in `.cursor/rules/`
- `npm run watch:dual`
  - Writes both prompt files/clipboard and `.cursor/rules/`
- `npm run watch:fullscan`
  - Analyzes the whole codebase every 5 minutes and generates prompts/rules
- `npm run watch:fullscan:fast`
  - Same as fullscan but 15-second interval for local testing
- `npm run pipeline:run -- <filePath> --mode=clipboard --reason=webhook --approved`
  - Runs the same pipeline entrypoint for external orchestrators (for example OpenClaw/webhooks)
  - Additional orchestrator modes: `analysis-only`, `prompt-only`, `delivery-only`
  - Optional controls: `--prompt-track=safe|feature|both`, `--dry-run`, `--ignore-priority`, `--no-notify`, `--no-deliver`, `--no-rules`

## Output Locations

- Safe prompt text: `prompts/latest.md`
- Safe prompt history: `prompts/history/*.md`
- Safe prompt metadata: `prompts/latest.meta.json`
- Feature prompt text: `prompts/features/latest.md`
- Feature prompt history: `prompts/features/history/*.md`
- Feature prompt metadata: `prompts/features/latest.meta.json`
- Fullscan run folders:
  - Safe prompts: `Prompts (Fullscan)/<fullscanRunId>/safe/*.md`
  - Feature prompts: `Prompts (Fullscan)/<fullscanRunId>/feature/*.md`
  - Master prompts:
    - Safe: `Prompts (Fullscan)/<fullscanRunId>/master/safe-master-prompts.md`
    - Feature: `Prompts (Fullscan)/<fullscanRunId>/master/feature-master-prompts.md`
- Cursor rules:
  - `.cursor/rules/project-context.mdc`
  - `.cursor/rules/current-task.mdc`
  - `.cursor/rules/browser-context.mdc`
  - `.cursor/rules/code-style.mdc`
  - `.cursor/rules/recent-changes.mdc`

## Context Signal Quality

`buildContext()` now emits deeper `contextSignals` to improve intent/prompt shaping:

- `riskContext` (risk score/level + recommended change style)
- `complexityContext` (complexity score/level + recommended instruction density)
- `changeIntentHints` (edit momentum + neighbor overlap signal)
- `scopeGuidance` (profile + prompt-track scoped planning hints)
- `promptShapingContext` (goal, objective/caution hints, preferred track, execution style)
- `contextDigest` (compact one-line summary for downstream prompt conditioning)
- `suggestedReviewTargets` (top related files to inspect first)
- `contextQualityFlags` (fallback/low-signal markers for downstream handling)

## Environment

Create a `.env` file and set:

`OPENAI_API_KEY=your_key_here`

Without an API key, the pipeline continues with fallback analysis/prompt behavior.

Provider routing (optional):

- `LLM_PROVIDER=openai` (default)
- `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`
- `LLM_PROVIDER=openrouter` with `OPENROUTER_API_KEY`

Browser intelligence retrieval (optional):

- `BROWSER_RETRIEVAL_PROVIDER=auto|brave|keyless` (default `auto`; uses Brave when `BRAVE_API_KEY` is set, otherwise keyless)
- `BRAVE_API_KEY=...` (required for Brave backend)
- `BROWSER_RETRIEVAL_MAX_RESULTS=8`
- `BROWSER_RETRIEVAL_TIMEOUT_MS=8000`
- `BROWSER_RETRIEVAL_MIN_SCORE=0.25`
- `BROWSER_RETRIEVAL_CACHE_TTL_MS=300000`
- `BROWSER_RETRIEVAL_CACHE_MAX_ENTRIES=200`

Project docs grounding (optional but recommended):

- `PROJECT_DOCS_ENABLED=true|false`
- `PROJECT_DOCS_DIR=projectdocs`
- `PROJECT_DOCS_REQUIRED=true|false` (default `true`; fail pipeline when docs are missing/unreadable)
- `PROJECT_DOCS_MAX_FILES=40`
- `PROJECT_DOCS_MAX_CHARS=24000`
- Allowed doc format is strict: `.md` only.
- Required docs (enforced): `projectdocs/PRD.md`, `projectdocs/ARCHITECTURE.md`, `projectdocs/API.md`

Watcher tuning (optional):

- `WATCH_STRATEGY=changes|fullscan`
- `SCAN_INTERVAL_MS=300000` (5 minutes)
- `SCAN_JITTER_MS=0` (optional random delay added per fullscan cycle)
- `FULLSCAN_INCLUDE=` (optional comma-separated wildcard scope, ex: `src/**/*.js`)
- `FULLSCAN_EXCLUDE=` (optional comma-separated wildcard exclusions)
- `FULLSCAN_RESUME_POLICY=always|safe-only|never` (resume strategy guard)
- `FULLSCAN_STALE_STATE_MS=21600000` (stale checkpoint cutoff)
- `FULLSCAN_PRIORITY_WINDOW=` (optional top-ranked first-pass window size)
- `MAX_FILES_PER_RUN=10` (optional cap for large repos)
- `FULLSCAN_STAGGER_MS=100` (optional delay between files in fullscan mode)
- `FULLSCAN_CONCURRENCY=1` (parallel workers for fullscan processing)
- `FULLSCAN_RESUME=true|false` (resume interrupted fullscan from checkpoint)
- `MAX_QUEUE_SIZE=500` (changes mode backpressure guard)
- `WATCH_BATCH_MAX=100` (max files processed per batch)
- `WATCH_OVERFLOW_POLICY=drop_oldest|drop_newest|coalesce_by_path`
- `WATCH_DEBOUNCE_MS_MIN=200`
- `WATCH_DEBOUNCE_MS_MAX=1000`
- `WATCH_PIPELINE_RETRIES=1` (per-file pipeline attempts)
- `WATCH_PIPELINE_RETRY_MS=250`
- `WATCH_DRY_RUN=true|false` (discover/rank only, no prompt generation)
- `WATCH_DRY_RUN_EXPLAIN=true|false` (prints include/exclude selection diagnostics)
- `PRIORITY_TOP_N=5` (optional: only deliver top-N ranked prompts in fullscan)
- `PRIORITY_MIN_SCORE=50` (optional: only deliver prompts at/above score)
- `PROMPT_TRACK=safe|feature|both` (default `safe`; use `feature` for larger feature proposals)
- `MASTER_PROMPTS_ENABLED=true|false` (default `true`)
- `MASTER_PROMPTS_COUNT=4|5` (default `5`)

## Fullscan Mode

Use periodic full-codebase analysis when you want prompt generation on a fixed cadence:

```bash
npm run watch:fullscan
```

Behavior:

- Scans eligible project files (`.js`, `.jsx`, `.ts`, `.tsx`)
- Excludes heavy/system directories such as `node_modules`, `.git`, `.cursor`, and `prompts`
- Runs one full analysis immediately, then repeats every `SCAN_INTERVAL_MS`
- Adds optional cycle jitter via `SCAN_JITTER_MS`
- Skips overlapping runs if a previous interval is still processing
- Supports bounded fullscan workers via `FULLSCAN_CONCURRENCY`
- Persists interrupted run state in `.cache/watcher-state.json` and resumes when `FULLSCAN_RESUME=true`
- Supports scoped fullscan filtering via `FULLSCAN_INCLUDE` / `FULLSCAN_EXCLUDE`
- Supports resume policy + stale checkpoint recovery controls
- Stores per-cycle prompt copies in `Prompts (Fullscan)/<fullscanRunId>/`
- Separates outputs by track:
  - `Prompts (Fullscan)/<runId>/safe/`
  - `Prompts (Fullscan)/<runId>/feature/`
- `safe` track updates `prompts/latest.md` and `prompts/history/*`
- `feature` track updates `prompts/features/latest.md` and `prompts/features/history/*`
- `both` updates both locations in one run
- Writes ranked `summary.json` in each fullscan run folder
- Summary now includes queue/retry/scope diagnostics for tuning
- Writes track-specific master prompt files with top 4-5 priorities:
  - `master/safe-master-prompts.md`
  - `master/feature-master-prompts.md` (when `PROMPT_TRACK=feature|both`)

Cost/performance guidance:

- Start with `MAX_FILES_PER_RUN=10` for medium/large repos.
- Use `FULLSCAN_STAGGER_MS` to smooth API usage bursts.
- Increase `FULLSCAN_CONCURRENCY` gradually (e.g. `2`, then `4`) and monitor summary telemetry.
- Use `WATCH_DRY_RUN=true` to validate discovery/ranking behavior without API spend.
- Keep regular coding workflows on `watch:dual` or one-shot mode if you need lower API volume.

Prompt prioritization guidance:

- By default, fullscan still delivers all prompts (now with priority scoring metadata).
- Set `PRIORITY_TOP_N` and/or `PRIORITY_MIN_SCORE` to reduce low-value prompt noise.
- Check `Prompts (Fullscan)/<runId>/summary.json` for full ranked results, including skipped items.

## Two-Lane Prompt Grounding

Prompt generation now uses two explicit lanes:

- `ReasoningContext`: code analysis, context signals, project profile/docs, recent changes.
- `EvidenceContext`: browser intelligence retrieval (query, docs summary, topics, confidence, retrieval metadata).

Grounding policy behavior:

- High-signal evidence (`quality=high-signal`, confidence >= 0.6): factual API claims should be evidence-backed.
- Low-signal evidence: use conservative reasoning and label uncertain claims as assumptions with verification steps.

The generated prompt template requires:

- `Evidence-backed recommendations`
- `Assumptions needing verification`
- `Uncertainty/conflicts`

## MCP Context Server (Phase 3)

Start the local MCP server:

`npm run mcp:context`

Cursor can connect through `.cursor/mcp.json` and request:

- `get_project_context`
- `get_project_profile`
- `get_current_task`
- `get_browser_research`
- `get_prompt_status`
- `get_fullscan_latest`
- `get_context_overview`
- `get_fullscan_run`
- `get_prompt_history`
- `get_context_quality`
- `get_master_prompts`
- `get_recent_changes`
- `get_watcher_state`
- `get_health`

If `MCP_SHARED_TOKEN` is set, pass `token` in each MCP tool call.

Response format:

- MCP tools return a consistent envelope:
  - `ok`, `apiVersion`, `schemaVersion`, `tool`, `generatedAt`
  - `data` (tool payload)
  - `meta` (auth/cache info)
  - `warnings` (for empty/missing/truncated states)

## OpenClaw Adapter (Step 5)

The orchestrator adapter lives in `src/orchestratorAdapter.js`. It enables:

- File-triggered pipeline execution (existing watcher path)
- Programmatic pipeline execution entrypoint for external orchestrators
- Optional notification hooks in `src/notify/`

Optional safety controls:

- `HUMAN_APPROVAL_REQUIRED=true` to require explicit `--approved` for `--reason=webhook|external`
- `NOTIFY_WEBHOOK_URL=...` to send prompt-ready events to Slack/Discord/Telegram webhook bridges

Pipeline control notes:

- `analysis-only`: build context + detect intent, skip prompt generation/delivery
- `prompt-only`: build context + intent + generate prompt, skip delivery/rules
- `delivery-only`: reuse provided prebuilt prompt payload for delivery paths
- You can also override stage behavior per run through `executionPolicy` (webhook payload) or CLI flags.
- `executionPolicy.failFast=true` aborts pipeline on first stage error and returns `abortStage`.
- `delivery-only` expects `prebuiltPrompt` or `prebuiltPrompts` in delivery context; missing inputs now surface `missing-prebuilt-prompt`.
- Pipeline now attempts to load `projectdocs/` first (configurable via `PROJECT_DOCS_*`).

## Webhook Trigger Service

Start a local trigger server:

`npm run serve:webhook`

Endpoints:

- `GET /health`
- `POST /trigger`
- `GET /trigger/:requestId` (request lifecycle status lookup)

Auth:

- Set `WEBHOOK_SHARED_SECRET` in `.env`.
- Send either `x-webhook-secret: <secret>` or `Authorization: Bearer <secret>`.
- Optional stronger signing: set `WEBHOOK_HMAC_SECRET` and send `x-webhook-signature: sha256=<hex>`.
- Optional replay-hardening headers when enabled:
  - `x-webhook-timestamp: <unix-ms-or-iso>`
  - `x-webhook-nonce: <unique-value>`

Example trigger payload:

```json
{
  "filePath": "src/contextBuilder.js",
  "mode": "dual",
  "approved": true,
  "reason": "webhook",
  "promptTrack": "both",
  "requestId": "optional-idempotency-key",
  "timeoutMs": 30000,
  "executionPolicy": {
    "dryRun": false,
    "ignorePriority": false,
    "notify": true
  }
}
```

Optional webhook runtime controls:

- `WEBHOOK_HMAC_SECRET=...`
- `WEBHOOK_ENABLE_CIDR=true|false`
- `WEBHOOK_ASYNC_MODE=true|false`
- `WEBHOOK_IDEMPOTENCY_TTL_MS=300000`
- `WEBHOOK_TIMEOUT_MS=30000`
- `WEBHOOK_MAX_SKEW_MS=300000`
- `WEBHOOK_REQUIRE_SIGNED_TIMESTAMP=true|false`
- `WEBHOOK_REQUIRE_NONCE=true|false`
- `WEBHOOK_MAX_INFLIGHT=10`
- `WEBHOOK_MAX_BODY_BYTES=1048576`

Robustness behavior:

- Same `requestId` + same payload => returns existing status/result (`duplicate` semantics)
- Same `requestId` + different payload => `409` with `code=idempotency_conflict`
- In async mode, use `GET /trigger/:requestId` to poll lifecycle state (`processing`, `completed`, `expired`)

Quick smoke checks:

```bash
curl http://localhost:8787/health
```

```bash
curl -X POST http://localhost:8787/trigger \
  -H "content-type: application/json" \
  -H "x-webhook-secret: YOUR_SECRET" \
  -d "{\"filePath\":\"src/contextBuilder.js\",\"mode\":\"dual\",\"approved\":true}"
```

## OpenClaw Trigger Mapping

Use OpenClaw to call this webhook whenever a monitored file changes.

- Trigger condition in OpenClaw:
  - file save/change event in project workspace
- Action:
  - HTTP POST to `http://localhost:8787/trigger`
- Headers:
  - `content-type: application/json`
  - `x-webhook-secret: <WEBHOOK_SHARED_SECRET>`
- Body template:

```json
{
  "filePath": "{{changed_file_path}}",
  "mode": "dual",
  "approved": true
}
```

Suggested mode defaults by environment:

- Local development: `dual`
- CI/non-interactive jobs: `cursorrules`
- Manual single-user workflow: `clipboard`

