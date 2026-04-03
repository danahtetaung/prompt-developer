import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runPipeline } from './orchestratorAdapter.js';

const PORT = Number(process.env.WEBHOOK_PORT ?? '8787');
const SHARED_SECRET = process.env.WEBHOOK_SHARED_SECRET ?? '';
const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? '';
const ALLOWED_IPS = (process.env.WEBHOOK_ALLOWED_IPS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const WEBHOOK_ENABLE_CIDR = (process.env.WEBHOOK_ENABLE_CIDR ?? 'false').toLowerCase() === 'true';
const WEBHOOK_ASYNC_MODE = (process.env.WEBHOOK_ASYNC_MODE ?? 'false').toLowerCase() === 'true';
const WEBHOOK_TIMEOUT_MS = Number.parseInt(process.env.WEBHOOK_TIMEOUT_MS ?? '30000', 10);
const WEBHOOK_IDEMPOTENCY_TTL_MS = Number.parseInt(
  process.env.WEBHOOK_IDEMPOTENCY_TTL_MS ?? '300000',
  10
);
const WEBHOOK_MAX_SKEW_MS = Number.parseInt(process.env.WEBHOOK_MAX_SKEW_MS ?? '300000', 10);
const WEBHOOK_REQUIRE_SIGNED_TIMESTAMP =
  (process.env.WEBHOOK_REQUIRE_SIGNED_TIMESTAMP ?? 'false').toLowerCase() === 'true';
const WEBHOOK_REQUIRE_NONCE =
  (process.env.WEBHOOK_REQUIRE_NONCE ?? 'false').toLowerCase() === 'true';
const WEBHOOK_MAX_INFLIGHT = Number.parseInt(process.env.WEBHOOK_MAX_INFLIGHT ?? '10', 10);
const WEBHOOK_MAX_BODY_BYTES = Number.parseInt(
  process.env.WEBHOOK_MAX_BODY_BYTES ?? `${1024 * 1024}`,
  10
);
const idempotencyStore = new Map();
const nonceStore = new Map();
const metrics = {
  total: 0,
  unauthorized: 0,
  invalid: 0,
  conflicts: 0,
  accepted: 0,
  completed: 0,
  failed: 0,
  overCapacity: 0,
};
const serverStartedAt = Date.now();
let inflightRequests = 0;

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function logRequestOutcome(req, statusCode, message) {
  console.log(
    `[webhookServer] ${req.method ?? 'UNKNOWN'} ${req.url ?? ''} -> ${statusCode} (${message})`
  );
}

function requestIp(req) {
  const direct = req.socket.remoteAddress ?? '';
  return direct.replace('::ffff:', '');
}

function ipToInt(ip) {
  const parts = ip.split('.').map((value) => Number.parseInt(value, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function cidrContains(cidr, ip) {
  const [base, prefixRaw] = cidr.split('/');
  const prefix = Number.parseInt(prefixRaw ?? '', 10);
  const baseInt = ipToInt(base);
  const ipInt = ipToInt(ip);
  if (
    baseInt === null ||
    ipInt === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (baseInt & mask) === (ipInt & mask);
}

function isIpAllowed(req) {
  if (ALLOWED_IPS.length === 0) return true;
  const ip = requestIp(req);
  if (!WEBHOOK_ENABLE_CIDR) {
    return ALLOWED_IPS.includes(ip);
  }
  return ALLOWED_IPS.some((allowed) =>
    allowed.includes('/') ? cidrContains(allowed, ip) : allowed === ip
  );
}

function timingSafeEquals(a, b) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function hasValidHmac(rawBody, signatureHeader) {
  if (!HMAC_SECRET) return false;
  if (typeof signatureHeader !== 'string' || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', HMAC_SECRET).update(rawBody).digest('hex');
  const normalized = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  return timingSafeEquals(expected, normalized);
}

function resolveAuth(req, rawBody) {
  const hmacHeader = req.headers['x-webhook-signature'];
  if (hasValidHmac(rawBody, hmacHeader)) {
    return { ok: true, method: 'hmac' };
  }
  if (!SHARED_SECRET) return { ok: false, method: 'none' };
  const secretHeader = req.headers['x-webhook-secret'];
  const authHeader = req.headers.authorization;
  if (typeof secretHeader === 'string' && secretHeader === SHARED_SECRET) {
    return { ok: true, method: 'secret-header' };
  }
  if (
    typeof authHeader === 'string' &&
    authHeader.startsWith('Bearer ') &&
    authHeader.slice(7) === SHARED_SECRET
  ) {
    return { ok: true, method: 'bearer' };
  }
  return { ok: false, method: 'none' };
}

function hashPayload(rawBody) {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

function normalizeMaxBodyBytes() {
  if (!Number.isInteger(WEBHOOK_MAX_BODY_BYTES) || WEBHOOK_MAX_BODY_BYTES <= 0) {
    return 1024 * 1024;
  }
  return Math.min(WEBHOOK_MAX_BODY_BYTES, 10 * 1024 * 1024);
}

function normalizeMaxInflight() {
  if (!Number.isInteger(WEBHOOK_MAX_INFLIGHT) || WEBHOOK_MAX_INFLIGHT <= 0) {
    return 10;
  }
  return Math.min(WEBHOOK_MAX_INFLIGHT, 1000);
}

function parseTimestampHeader(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  const isoMs = Date.parse(value);
  if (Number.isFinite(isoMs)) return isoMs;
  return null;
}

function validateSignedFreshness(req, auth) {
  if (auth.method !== 'hmac') return { ok: true };
  if (!WEBHOOK_REQUIRE_SIGNED_TIMESTAMP && !WEBHOOK_REQUIRE_NONCE) {
    return { ok: true };
  }

  if (WEBHOOK_REQUIRE_SIGNED_TIMESTAMP) {
    const rawTimestamp = req.headers['x-webhook-timestamp'];
    const timestampMs = parseTimestampHeader(rawTimestamp);
    if (timestampMs === null) {
      return { ok: false, code: 'signature_timestamp_missing', message: 'Signed timestamp is required' };
    }
    const skew = Math.abs(Date.now() - timestampMs);
    const maxSkew = Number.isInteger(WEBHOOK_MAX_SKEW_MS) && WEBHOOK_MAX_SKEW_MS > 0
      ? WEBHOOK_MAX_SKEW_MS
      : 300000;
    if (skew > maxSkew) {
      return { ok: false, code: 'signature_stale', message: 'Signed timestamp outside allowed skew' };
    }
  }

  if (WEBHOOK_REQUIRE_NONCE) {
    const nonce = req.headers['x-webhook-nonce'];
    if (typeof nonce !== 'string' || !nonce.trim()) {
      return { ok: false, code: 'signature_nonce_missing', message: 'Signed nonce is required' };
    }
    if (nonceStore.has(nonce)) {
      return { ok: false, code: 'signature_replay', message: 'Nonce has already been used' };
    }
    nonceStore.set(nonce, Date.now() + Math.max(1000, WEBHOOK_IDEMPOTENCY_TTL_MS));
  }

  return { ok: true };
}

function normalizeTimeoutMs(value) {
  const fallback = Number.isInteger(WEBHOOK_TIMEOUT_MS) && WEBHOOK_TIMEOUT_MS > 0
    ? WEBHOOK_TIMEOUT_MS
    : 30000;
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 120000);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    const maxBytes = normalizeMaxBodyBytes();
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > maxBytes) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve({ rawBody: body, payload: body ? JSON.parse(body) : {} });
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'Payload must be a JSON object';
  }
  if (typeof payload.filePath !== 'string' || payload.filePath.trim() === '') {
    return 'filePath is required';
  }
  if (
    payload.mode !== undefined &&
    ![
      'clipboard',
      'cursorrules',
      'dual',
      'analysis-only',
      'analysis',
      'prompt-only',
      'prompt',
      'delivery-only',
      'deliver-only',
    ].includes(payload.mode)
  ) {
    return 'mode must be one of: clipboard, cursorrules, dual, analysis-only, prompt-only, delivery-only';
  }
  if (payload.approved !== undefined && typeof payload.approved !== 'boolean') {
    return 'approved must be a boolean when provided';
  }
  if (
    payload.reason !== undefined &&
    !['webhook', 'external', 'manual'].includes(payload.reason)
  ) {
    return 'reason must be one of: webhook, external, manual';
  }
  if (
    payload.promptTrack !== undefined &&
    !['safe', 'feature', 'both'].includes(payload.promptTrack)
  ) {
    return 'promptTrack must be one of: safe, feature, both';
  }
  if (payload.requestId !== undefined) {
    if (typeof payload.requestId !== 'string' || payload.requestId.trim() === '') {
      return 'requestId must be a non-empty string when provided';
    }
    if (payload.requestId.length > 128) {
      return 'requestId must be at most 128 characters';
    }
  }
  if (
    payload.timeoutMs !== undefined &&
    (!Number.isInteger(payload.timeoutMs) || payload.timeoutMs <= 0)
  ) {
    return 'timeoutMs must be a positive integer when provided';
  }
  if (payload.executionPolicy !== undefined) {
    if (!payload.executionPolicy || typeof payload.executionPolicy !== 'object') {
      return 'executionPolicy must be an object when provided';
    }
    const allowedPolicyKeys = new Set([
      'analyze',
      'intent',
      'prompt',
      'deliver',
      'rules',
      'notify',
      'dryRun',
      'ignorePriority',
      'failFast',
    ]);
    for (const [key, value] of Object.entries(payload.executionPolicy)) {
      if (!allowedPolicyKeys.has(key)) {
        return `executionPolicy.${key} is not supported`;
      }
      if (typeof value !== 'boolean') {
        return `executionPolicy.${key} must be a boolean`;
      }
    }
  }
  return null;
}

function hasJsonContentType(req) {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string') return false;
  return contentType.toLowerCase().includes('application/json');
}

function buildWebhookResponse({
  ok,
  requestId,
  status,
  code = null,
  error = null,
  result = null,
  durationMs = 0,
  receivedAt = new Date().toISOString(),
}) {
  return {
    ok,
    requestId,
    status,
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
    ...(result ? { result } : {}),
    durationMs,
    receivedAt,
  };
}

function cleanupIdempotencyStore() {
  const now = Date.now();
  for (const [requestId, entry] of idempotencyStore.entries()) {
    if (entry.expiresAt <= now) {
      idempotencyStore.delete(requestId);
    }
  }
  for (const [nonce, expiresAt] of nonceStore.entries()) {
    if (expiresAt <= now) {
      nonceStore.delete(nonce);
    }
  }
}

function getOrCreateRequestId(payload) {
  if (typeof payload?.requestId === 'string' && payload.requestId.trim()) {
    return payload.requestId.trim();
  }
  return crypto.randomUUID();
}

async function runPipelineWithTimeout(payload) {
  const timeoutMs = normalizeTimeoutMs(payload.timeoutMs);
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Pipeline timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([
    runPipeline({
      filePath: payload.filePath,
      mode: payload.mode ?? 'clipboard',
      reason: payload.reason ?? 'webhook',
      approved: payload.approved === true,
      deliveryContext: {
        promptTrack: payload.promptTrack,
        executionPolicy:
          payload.executionPolicy && typeof payload.executionPolicy === 'object'
            ? payload.executionPolicy
            : undefined,
      },
    }),
    timeoutPromise,
  ]);
}

export function createWebhookServer() {
  return http.createServer(async (req, res) => {
    const requestStartedAt = Date.now();
    metrics.total += 1;
    if (req.url === '/health' && req.method === 'GET') {
      logRequestOutcome(req, 200, 'health');
      return json(res, 200, {
        ok: true,
        service: 'webhook-server',
        uptimeMs: Date.now() - serverStartedAt,
        modes: {
          async: WEBHOOK_ASYNC_MODE,
          auth: HMAC_SECRET ? 'hmac+secret' : SHARED_SECRET ? 'shared-secret' : 'none',
          requireSignedTimestamp: WEBHOOK_REQUIRE_SIGNED_TIMESTAMP,
          requireNonce: WEBHOOK_REQUIRE_NONCE,
        },
        limits: {
          maxInflight: normalizeMaxInflight(),
          maxBodyBytes: normalizeMaxBodyBytes(),
        },
        stores: {
          idempotency: idempotencyStore.size,
          nonces: nonceStore.size,
        },
        inflightRequests,
        metrics,
      });
    }

    if (req.method === 'GET' && req.url?.startsWith('/trigger/')) {
      cleanupIdempotencyStore();
      const requestId = req.url.slice('/trigger/'.length).trim();
      if (!requestId) {
        return json(
          res,
          400,
          buildWebhookResponse({
            ok: false,
            requestId: null,
            status: 'invalid_request',
            code: 'missing_request_id',
            error: 'requestId is required',
            durationMs: Date.now() - requestStartedAt,
          })
        );
      }
      const entry = idempotencyStore.get(requestId);
      if (!entry) {
        return json(
          res,
          404,
          buildWebhookResponse({
            ok: false,
            requestId,
            status: 'expired',
            code: 'request_not_found',
            error: 'No request state found',
            durationMs: Date.now() - requestStartedAt,
          })
        );
      }
      return json(
        res,
        entry.status === 'processing' ? 202 : entry.status === 'completed' ? 200 : 400,
        buildWebhookResponse({
          ok: entry.status === 'completed' ? Boolean(entry.response?.ok) : true,
          requestId,
          status: entry.status,
          code: entry.response?.code ?? 'request_status',
          ...(entry.response?.error ? { error: entry.response.error } : {}),
          ...(entry.response?.result ? { result: entry.response.result } : {}),
          durationMs: Date.now() - requestStartedAt,
        })
      );
    }

    if (req.url !== '/trigger' || req.method !== 'POST') {
      logRequestOutcome(req, 404, 'not-found');
      return json(res, 404, { ok: false, error: 'Not found' });
    }

    if (!isIpAllowed(req)) {
      logRequestOutcome(req, 403, 'ip-not-allowed');
      return json(res, 403, { ok: false, error: 'IP not allowed' });
    }

    if (!hasJsonContentType(req)) {
      logRequestOutcome(req, 415, 'invalid-content-type');
      return json(res, 415, { ok: false, error: 'content-type must be application/json' });
    }

    try {
      const { rawBody, payload } = await parseBody(req);
      const requestId = getOrCreateRequestId(payload);
      const payloadHash = hashPayload(rawBody);
      const auth = resolveAuth(req, rawBody);
      if (!auth.ok) {
        metrics.unauthorized += 1;
        logRequestOutcome(req, 401, 'unauthorized');
        return json(
          res,
          401,
          buildWebhookResponse({
            ok: false,
            requestId,
            status: 'unauthorized',
            code: 'unauthorized',
            error: 'Unauthorized',
            durationMs: Date.now() - requestStartedAt,
          })
        );
      }
      const freshness = validateSignedFreshness(req, auth);
      if (!freshness.ok) {
        metrics.unauthorized += 1;
        logRequestOutcome(req, 401, freshness.code ?? 'signature-invalid');
        return json(
          res,
          401,
          buildWebhookResponse({
            ok: false,
            requestId,
            status: 'unauthorized',
            code: freshness.code ?? 'signature_invalid',
            error: freshness.message ?? 'Invalid signature freshness',
            durationMs: Date.now() - requestStartedAt,
          })
        );
      }

      const validationError = validatePayload(payload);
      if (validationError) {
        metrics.invalid += 1;
        logRequestOutcome(req, 400, validationError);
        return json(
          res,
          400,
          buildWebhookResponse({
            ok: false,
            requestId,
            status: 'invalid_request',
            code: 'invalid_request',
            error: validationError,
            durationMs: Date.now() - requestStartedAt,
          })
        );
      }

      cleanupIdempotencyStore();
      const existing = idempotencyStore.get(requestId);
      if (existing) {
        if (existing.payloadHash && existing.payloadHash !== payloadHash) {
          metrics.conflicts += 1;
          logRequestOutcome(req, 409, 'idempotency-conflict');
          return json(
            res,
            409,
            buildWebhookResponse({
              ok: false,
              requestId,
              status: 'rejected',
              code: 'idempotency_conflict',
              error: 'requestId already exists with different payload',
              durationMs: Date.now() - requestStartedAt,
            })
          );
        }
        const duplicateStatus = existing.status === 'completed' ? 200 : 202;
        const duplicatePayload =
          existing.response ??
          buildWebhookResponse({
            ok: true,
            requestId,
            status: 'duplicate',
            code: 'duplicate_request',
            durationMs: Date.now() - requestStartedAt,
          });
        logRequestOutcome(req, duplicateStatus, `duplicate-${existing.status}`);
        return json(res, duplicateStatus, duplicatePayload);
      }

      if (WEBHOOK_ASYNC_MODE && inflightRequests >= normalizeMaxInflight()) {
        metrics.overCapacity += 1;
        logRequestOutcome(req, 429, 'over-capacity');
        return json(
          res,
          429,
          buildWebhookResponse({
            ok: false,
            requestId,
            status: 'rejected',
            code: 'over_capacity',
            error: 'Too many inflight webhook requests',
            durationMs: Date.now() - requestStartedAt,
          })
        );
      }

      idempotencyStore.set(requestId, {
        status: 'processing',
        payloadHash,
        response: null,
        expiresAt: Date.now() + Math.max(1000, WEBHOOK_IDEMPOTENCY_TTL_MS),
      });
      inflightRequests += 1;

      if (WEBHOOK_ASYNC_MODE) {
        metrics.accepted += 1;
        logRequestOutcome(req, 202, 'accepted');
        json(
          res,
          202,
          buildWebhookResponse({
            ok: true,
            requestId,
            status: 'accepted',
            code: 'accepted',
            durationMs: Date.now() - requestStartedAt,
          })
        );

        void runPipelineWithTimeout(payload)
          .then((result) => {
            const response = buildWebhookResponse({
              ok: Boolean(result?.ok),
              requestId,
              status: result?.ok ? 'completed' : 'failed',
              code: result?.ok ? 'pipeline_ok' : 'pipeline_failed',
              result,
              durationMs: Date.now() - requestStartedAt,
            });
            idempotencyStore.set(requestId, {
              status: 'completed',
              payloadHash,
              response,
              expiresAt: Date.now() + Math.max(1000, WEBHOOK_IDEMPOTENCY_TTL_MS),
            });
            if (result?.ok) metrics.completed += 1;
            else metrics.failed += 1;
            console.log(
              `[webhookServer] async request ${requestId} finished with status=${response.status}`
            );
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            const response = buildWebhookResponse({
              ok: false,
              requestId,
              status: 'failed',
              code: 'pipeline_failed',
              error: message,
              durationMs: Date.now() - requestStartedAt,
            });
            idempotencyStore.set(requestId, {
              status: 'completed',
              payloadHash,
              response,
              expiresAt: Date.now() + Math.max(1000, WEBHOOK_IDEMPOTENCY_TTL_MS),
            });
            metrics.failed += 1;
            console.warn(`[webhookServer] async request ${requestId} failed: ${message}`);
          })
          .finally(() => {
            inflightRequests = Math.max(0, inflightRequests - 1);
          });
        return;
      }

      const result = await runPipelineWithTimeout(payload);
      const responsePayload = buildWebhookResponse({
        ok: Boolean(result?.ok),
        requestId,
        status: result?.ok ? 'completed' : 'failed',
        code: result?.ok ? 'pipeline_ok' : 'pipeline_failed',
        result,
        durationMs: Date.now() - requestStartedAt,
      });
      idempotencyStore.set(requestId, {
        status: 'completed',
        payloadHash,
        response: responsePayload,
        expiresAt: Date.now() + Math.max(1000, WEBHOOK_IDEMPOTENCY_TTL_MS),
      });
      if (result?.ok) metrics.completed += 1;
      else metrics.failed += 1;
      inflightRequests = Math.max(0, inflightRequests - 1);

      logRequestOutcome(req, result.ok ? 200 : 400, result.ok ? 'pipeline-ok' : 'pipeline-failed');
      return json(res, result.ok ? 200 : 400, responsePayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      inflightRequests = Math.max(0, inflightRequests - 1);
      metrics.failed += 1;
      logRequestOutcome(req, 400, message);
      return json(
        res,
        400,
        buildWebhookResponse({
          ok: false,
          requestId: null,
          status: 'bad_request',
          code: message === 'Payload too large' ? 'payload_too_large' : 'bad_request',
          error: message,
          durationMs: Date.now() - requestStartedAt,
        })
      );
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!SHARED_SECRET && !HMAC_SECRET) {
    console.warn(
      '[webhookServer] WEBHOOK_SHARED_SECRET and WEBHOOK_HMAC_SECRET are empty; authenticated endpoints will reject requests.'
    );
  }
  const server = createWebhookServer();
  server.listen(PORT, () => {
    console.log(`Webhook server listening on http://localhost:${PORT}`);
  });
}
