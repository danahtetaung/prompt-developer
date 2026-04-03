# Architecture

## High-Level Components
- `src/watcher.js`:
  - file-change watcher and fullscan scheduler
  - queueing/backpressure/retries/resume controls
- `src/orchestratorAdapter.js`:
  - stage orchestration (docs -> analyze -> intent -> prompt -> deliver -> notify)
  - mode/policy execution controls
- `src/contextBuilder.js`:
  - enriched context assembly (analysis, browser, profile, docs signals)
- `src/fileIntelligence.js`:
  - code analysis and dependency inference
- `src/intentDetector.js`:
  - intent sentence generation from enriched context
- `src/promptGenerator.js`:
  - structured safe/feature prompt generation
- `src/cursorDelivery.js`:
  - prompt persistence/history/clipboard/rules outputs
- `src/webhookServer.js`:
  - authenticated trigger endpoint + idempotency + async status
- `mcp/contextServer.js`:
  - MCP tools exposing runtime/project/fullscan context

## Data Flow
1. Trigger (watcher/webhook/CLI) invokes orchestrator.
2. Orchestrator loads `projectdocs` first (required).
3. Context builder builds enriched context.
4. Intent detector determines current objective.
5. Prompt generator creates safe/feature prompt(s).
6. Delivery writes outputs + optional rules + notifications.
7. Fullscan writes ranked summaries + master prompts.

## Key Design Principles
- Deterministic defaults for safety
- Configurable controls for scale/performance
- Additive context signals to improve prompt quality
- Explicit stage statuses for observability/debugging

## Reliability Mechanisms
- Fullscan resume checkpoints
- Queue backpressure + overflow policy
- Per-file retries for transient failures
- Webhook idempotency + request status endpoint

## Security/Trust Boundaries
- Local filesystem as source of truth
- Shared secret and optional HMAC verification for webhook
- Optional signed timestamp/nonce replay hardening
