# API & Interface Contracts

## CLI Interfaces

### Watcher (changes mode)
`node src/watcher.js --strategy=changes --mode=dual`

### Watcher (fullscan mode)
`node src/watcher.js --strategy=fullscan --mode=dual --scan-interval-ms=300000`

### One-shot pipeline
`node src/runPipeline.js <filePath> --mode=dual --reason=external --approved`

## Required Project Docs Contract
Folder: `projectdocs/`
Required files:
- `PRD.md`
- `ARCHITECTURE.md`
- `API.md`

Pipeline must fail preflight when docs are required and missing.

## Webhook Service

### Endpoints
- `GET /health`
- `POST /trigger`
- `GET /trigger/:requestId`

### Trigger Payload
```json
{
  "filePath": "src/contextBuilder.js",
  "mode": "dual",
  "approved": true,
  "reason": "webhook",
  "promptTrack": "safe",
  "requestId": "optional-idempotency-key",
  "timeoutMs": 30000,
  "executionPolicy": {
    "dryRun": false,
    "ignorePriority": false,
    "notify": true
  }
}
```

### Auth
- Shared secret (`x-webhook-secret` or Bearer token)
- Optional HMAC signature (`x-webhook-signature`)
- Optional timestamp/nonce hardening

## MCP Context Tools (Core)
- `get_project_context`
- `get_project_profile`
- `get_prompt_status`
- `get_fullscan_latest`
- `get_fullscan_run`
- `get_master_prompts`
- `get_recent_changes`
- `get_context_overview`
- `get_context_quality`
- `get_watcher_state`
- `get_health`

## Output Contracts
- Prompts written to `prompts/` and `Prompts (Fullscan)/...`
- Fullscan run summary in `summary.json`
- Stage statuses and execution metadata emitted by orchestrator
