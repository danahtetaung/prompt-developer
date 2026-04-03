import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/orchestratorAdapter.js';

test('runPipeline blocks external run when human approval is required', async () => {
  process.env.HUMAN_APPROVAL_REQUIRED = 'true';
  const result = await runPipeline({
    filePath: 'src/not-real.js',
    reason: 'webhook',
    mode: 'clipboard',
    approved: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'human-approval-required');
  assert.equal(typeof result.runId, 'string');
});

test('runPipeline rejects out-of-scope absolute paths', async () => {
  process.env.HUMAN_APPROVAL_REQUIRED = 'false';
  await assert.rejects(
    runPipeline({
      filePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
      reason: 'external',
      mode: 'clipboard',
      approved: true,
    }),
    /Out-of-scope path/i
  );
});

test('runPipeline continues when approved even if approval mode enabled', async () => {
  process.env.HUMAN_APPROVAL_REQUIRED = 'true';
  const result = await runPipeline({
    filePath: 'src/does-not-exist.js',
    reason: 'webhook',
    mode: 'clipboard',
    approved: true,
  });

  assert.equal(result.ok, false);
  assert.notEqual(result.reason, 'human-approval-required');
});

test('runPipeline returns execution metadata for analysis-only mode', async () => {
  process.env.HUMAN_APPROVAL_REQUIRED = 'false';
  process.env.PROJECT_DOCS_REQUIRED = 'false';
  const result = await runPipeline({
    filePath: 'src/does-not-exist.js',
    reason: 'external',
    mode: 'analysis-only',
    approved: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'context-build-failed');
  assert.equal(result.executionMode, 'analysis-only');
  assert.equal(result.executionPolicy.prompt, false);
  assert.equal(result.executionPolicy.deliver, false);
});

test('runPipeline applies executionPolicy overrides', async () => {
  process.env.HUMAN_APPROVAL_REQUIRED = 'false';
  process.env.PROJECT_DOCS_REQUIRED = 'false';
  const result = await runPipeline({
    filePath: 'src/does-not-exist.js',
    reason: 'external',
    mode: 'clipboard',
    approved: true,
    deliveryContext: {
      executionPolicy: {
        notify: false,
        deliver: false,
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'context-build-failed');
  assert.equal(result.executionPolicy.notify, false);
  assert.equal(result.executionPolicy.deliver, false);
});

test('runPipeline delivery-only fails fast when prebuilt prompt is missing', async () => {
  process.env.HUMAN_APPROVAL_REQUIRED = 'false';
  process.env.PROJECT_DOCS_REQUIRED = 'false';
  const result = await runPipeline({
    filePath: 'src/contextBuilder.js',
    reason: 'external',
    mode: 'delivery-only',
    approved: true,
    deliveryContext: {
      executionPolicy: {
        failFast: true,
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(result.abortStage, 'deliver');
  assert.equal(result.stageErrors.deliver, 'missing-prebuilt-prompt');
});

test('runPipeline includes execution summary fields', async () => {
  process.env.HUMAN_APPROVAL_REQUIRED = 'false';
  const result = await runPipeline({
    filePath: 'src/does-not-exist.js',
    reason: 'external',
    mode: 'analysis-only',
    approved: true,
  });

  assert.equal(typeof result.executionSummary, 'object');
  assert.equal(typeof result.executionSummary.ran, 'number');
  assert.equal(typeof result.executionSummary.skipped, 'number');
  assert.equal(typeof result.executionSummary.errored, 'number');
});

test('runPipeline blocks when projectdocs are required but missing', async () => {
  process.env.HUMAN_APPROVAL_REQUIRED = 'false';
  const result = await runPipeline({
    filePath: 'src/contextBuilder.js',
    reason: 'external',
    mode: 'analysis-only',
    approved: true,
    deliveryContext: {
      projectDocsRequired: true,
      projectDocsDir: '__missing_projectdocs__',
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'projectdocs-required-missing');
  assert.equal(result.stageErrors.docs, 'projectdocs-required-missing');
});
