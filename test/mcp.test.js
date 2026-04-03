import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAuthorized,
  buildContextOverview,
  buildContextQuality,
  buildFullscanRun,
  buildLatestFullscan,
  buildMasterPrompts,
  buildPromptHistory,
  buildPromptStatus,
  buildProjectProfile,
  buildRecentChanges,
  buildBrowserResearch,
  buildCurrentTask,
  buildProjectContext,
  buildWatcherState,
} from '../mcp/contextServer.js';

test('MCP context builders return payload objects', () => {
  const project = buildProjectContext();
  const task = buildCurrentTask();
  const browser = buildBrowserResearch();

  assert.equal(typeof project, 'object');
  assert.equal(typeof task, 'object');
  assert.equal(typeof browser, 'object');
  assert.equal(typeof project.timestamp, 'string');
});

test('MCP expanded builders return structured payload objects', () => {
  const profile = buildProjectProfile();
  const promptStatus = buildPromptStatus();
  const latestFullscan = buildLatestFullscan({ limit: 3 });
  const fullscanRun = buildFullscanRun({ limit: 3, offset: 0, order: 'desc' });
  const promptHistory = buildPromptHistory({ track: 'both', limit: 5 });
  const masterPrompts = buildMasterPrompts({ track: 'both', includeRaw: false });
  const recentChanges = buildRecentChanges({ limit: 5, includeRaw: false });
  const watcherState = buildWatcherState();
  const quality = buildContextQuality();
  const overview = buildContextOverview({ limit: 3 });

  assert.equal(typeof profile.scopeMode, 'string');
  assert.equal(typeof promptStatus, 'object');
  assert.equal(Array.isArray(latestFullscan.topPrompts), true);
  assert.equal(Array.isArray(fullscanRun.prompts), true);
  assert.equal(Array.isArray(promptHistory.entries), true);
  assert.equal(typeof masterPrompts.prompts, 'object');
  assert.equal(Array.isArray(recentChanges.entries), true);
  assert.equal(typeof watcherState.hasState, 'boolean');
  assert.equal(Array.isArray(quality.warningFlags), true);
  assert.equal(typeof overview.project, 'object');
});

test('MCP auth check follows configured token mode', () => {
  const configuredToken = process.env.MCP_SHARED_TOKEN ?? '';
  if (!configuredToken) {
    assert.doesNotThrow(() => assertAuthorized({}));
    return;
  }

  assert.throws(() => assertAuthorized({ token: 'wrong-token' }));
  assert.doesNotThrow(() => assertAuthorized({ token: configuredToken }));
});

test('MCP auth rejects malformed arguments', () => {
  assert.throws(() => assertAuthorized(null));
  assert.throws(() => assertAuthorized([]));
});

test('MCP auth rejects missing token when token is configured', () => {
  const previous = process.env.MCP_SHARED_TOKEN;
  process.env.MCP_SHARED_TOKEN = 'unit-test-token';
  try {
    assert.throws(() => assertAuthorized({}));
  } finally {
    process.env.MCP_SHARED_TOKEN = previous;
  }
});

test('MCP master prompts builder handles invalid track by defaulting safely', () => {
  const payload = buildMasterPrompts({ track: 'invalid-track', includeRaw: false });
  assert.equal(typeof payload.track, 'string');
  assert.equal(payload.track, 'both');
});

test('MCP prompt history builder handles invalid track by defaulting to both', () => {
  const payload = buildPromptHistory({ track: 'invalid-track', limit: 2 });
  assert.equal(payload.track, 'both');
  assert.equal(Array.isArray(payload.entries), true);
});
