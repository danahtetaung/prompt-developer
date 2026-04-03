import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

test('webhook server rejects unauthorized trigger requests', async () => {
  process.env.WEBHOOK_SHARED_SECRET = 'test-secret';
  process.env.WEBHOOK_ALLOWED_IPS = '';

  const modulePath = path.join(process.cwd(), 'src', 'webhookServer.js');
  const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}`;
  const { createWebhookServer } = await import(moduleUrl);

  const server = createWebhookServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'src/contextBuilder.js' }),
    });
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('webhook server rejects non-json trigger requests', async () => {
  process.env.WEBHOOK_SHARED_SECRET = 'test-secret';
  process.env.WEBHOOK_ALLOWED_IPS = '';

  const modulePath = path.join(process.cwd(), 'src', 'webhookServer.js');
  const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}-ctype`;
  const { createWebhookServer } = await import(moduleUrl);

  const server = createWebhookServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'text/plain',
      },
      body: 'plain-text',
    });
    assert.equal(response.status, 415);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('webhook server accepts authorized JSON request and avoids 401/415', async () => {
  process.env.WEBHOOK_SHARED_SECRET = 'test-secret';
  process.env.WEBHOOK_ALLOWED_IPS = '';

  const modulePath = path.join(process.cwd(), 'src', 'webhookServer.js');
  const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}-authorized`;
  const { createWebhookServer } = await import(moduleUrl);

  const server = createWebhookServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ filePath: 'src/does-not-exist.js', mode: 'dual' }),
    });
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 415);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('webhook server rejects invalid promptTrack values', async () => {
  process.env.WEBHOOK_SHARED_SECRET = 'test-secret';
  process.env.WEBHOOK_ALLOWED_IPS = '';
  process.env.WEBHOOK_ASYNC_MODE = 'false';

  const modulePath = path.join(process.cwd(), 'src', 'webhookServer.js');
  const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}-badtrack`;
  const { createWebhookServer } = await import(moduleUrl);

  const server = createWebhookServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ filePath: 'src/contextBuilder.js', promptTrack: 'invalid' }),
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('webhook server rejects invalid executionPolicy values', async () => {
  process.env.WEBHOOK_SHARED_SECRET = 'test-secret';
  process.env.WEBHOOK_ALLOWED_IPS = '';
  process.env.WEBHOOK_ASYNC_MODE = 'false';

  const modulePath = path.join(process.cwd(), 'src', 'webhookServer.js');
  const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}-bad-policy`;
  const { createWebhookServer } = await import(moduleUrl);

  const server = createWebhookServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filePath: 'src/contextBuilder.js',
        executionPolicy: { notify: 'yes' },
      }),
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('webhook server accepts HMAC auth when shared secret is empty', async () => {
  process.env.WEBHOOK_SHARED_SECRET = '';
  process.env.WEBHOOK_HMAC_SECRET = 'hmac-secret';
  process.env.WEBHOOK_ALLOWED_IPS = '';
  process.env.WEBHOOK_ASYNC_MODE = 'false';

  const modulePath = path.join(process.cwd(), 'src', 'webhookServer.js');
  const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}-hmac`;
  const { createWebhookServer } = await import(moduleUrl);

  const payload = JSON.stringify({ filePath: 'src/does-not-exist.js', reason: 'external' });
  const signature = `sha256=${crypto
    .createHmac('sha256', 'hmac-secret')
    .update(payload)
    .digest('hex')}`;

  const server = createWebhookServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: {
        'x-webhook-signature': signature,
        'content-type': 'application/json',
      },
      body: payload,
    });
    assert.notEqual(response.status, 401);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('webhook server supports async accepted responses with requestId', async () => {
  process.env.WEBHOOK_SHARED_SECRET = 'test-secret';
  process.env.WEBHOOK_HMAC_SECRET = '';
  process.env.WEBHOOK_ALLOWED_IPS = '';
  process.env.WEBHOOK_ASYNC_MODE = 'true';
  process.env.WEBHOOK_IDEMPOTENCY_TTL_MS = '60000';

  const modulePath = path.join(process.cwd(), 'src', 'webhookServer.js');
  const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}-async`;
  const { createWebhookServer } = await import(moduleUrl);

  const server = createWebhookServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filePath: 'src/does-not-exist.js',
        requestId: 'req-123',
      }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.requestId, 'req-123');
    assert.equal(body.status, 'accepted');
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('webhook server exposes request status endpoint for requestId', async () => {
  process.env.WEBHOOK_SHARED_SECRET = 'test-secret';
  process.env.WEBHOOK_HMAC_SECRET = '';
  process.env.WEBHOOK_ALLOWED_IPS = '';
  process.env.WEBHOOK_ASYNC_MODE = 'true';
  process.env.WEBHOOK_IDEMPOTENCY_TTL_MS = '60000';

  const modulePath = path.join(process.cwd(), 'src', 'webhookServer.js');
  const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}-status-endpoint`;
  const { createWebhookServer } = await import(moduleUrl);

  const server = createWebhookServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const trigger = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filePath: 'src/does-not-exist.js',
        requestId: 'status-req-1',
      }),
    });
    assert.equal(trigger.status, 202);

    const statusResponse = await fetch(`http://127.0.0.1:${port}/trigger/status-req-1`);
    assert.ok([200, 202].includes(statusResponse.status));
    const statusBody = await statusResponse.json();
    assert.equal(statusBody.requestId, 'status-req-1');
    assert.ok(['processing', 'completed'].includes(statusBody.status));
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('webhook server rejects duplicate requestId with different payload hash', async () => {
  process.env.WEBHOOK_SHARED_SECRET = 'test-secret';
  process.env.WEBHOOK_HMAC_SECRET = '';
  process.env.WEBHOOK_ALLOWED_IPS = '';
  process.env.WEBHOOK_ASYNC_MODE = 'false';

  const modulePath = path.join(process.cwd(), 'src', 'webhookServer.js');
  const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}-idempotency-conflict`;
  const { createWebhookServer } = await import(moduleUrl);

  const server = createWebhookServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const first = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filePath: 'src/does-not-exist.js',
        requestId: 'conflict-1',
      }),
    });
    assert.ok([200, 400].includes(first.status));

    const second = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filePath: 'src/contextBuilder.js',
        requestId: 'conflict-1',
      }),
    });
    assert.equal(second.status, 409);
    const secondBody = await second.json();
    assert.equal(secondBody.code, 'idempotency_conflict');
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('webhook server enforces signed timestamp when configured', async () => {
  process.env.WEBHOOK_SHARED_SECRET = '';
  process.env.WEBHOOK_HMAC_SECRET = 'hmac-secret';
  process.env.WEBHOOK_REQUIRE_SIGNED_TIMESTAMP = 'true';
  process.env.WEBHOOK_ALLOWED_IPS = '';

  const modulePath = path.join(process.cwd(), 'src', 'webhookServer.js');
  const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}-signed-ts`;
  const { createWebhookServer } = await import(moduleUrl);

  const payload = JSON.stringify({ filePath: 'src/does-not-exist.js' });
  const signature = `sha256=${crypto
    .createHmac('sha256', 'hmac-secret')
    .update(payload)
    .digest('hex')}`;

  const server = createWebhookServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: {
        'x-webhook-signature': signature,
        'content-type': 'application/json',
      },
      body: payload,
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, 'signature_timestamp_missing');
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('webhook health endpoint includes runtime metrics', async () => {
  process.env.WEBHOOK_SHARED_SECRET = 'test-secret';
  process.env.WEBHOOK_HMAC_SECRET = '';
  process.env.WEBHOOK_ASYNC_MODE = 'false';

  const modulePath = path.join(process.cwd(), 'src', 'webhookServer.js');
  const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}-health-metrics`;
  const { createWebhookServer } = await import(moduleUrl);

  const server = createWebhookServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.uptimeMs, 'number');
    assert.equal(typeof body.inflightRequests, 'number');
    assert.equal(typeof body.metrics, 'object');
    assert.equal(typeof body.limits.maxBodyBytes, 'number');
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});
