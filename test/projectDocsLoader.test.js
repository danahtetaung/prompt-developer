import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectDocsContext } from '../src/projectDocsLoader.js';

test('loadProjectDocsContext returns loaded=false when folder missing', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dev-agent-docs-missing-'));
  const result = loadProjectDocsContext({
    baseDir: tempRoot,
    docsDirName: 'projectdocs',
    required: false,
  });
  assert.equal(result.enabled, true);
  assert.equal(result.exists, false);
  assert.equal(result.loaded, false);
  assert.equal(Array.isArray(result.requiredMissing), true);
  assert.equal(result.requiredMissing.includes('PRD.md'), true);
});

test('loadProjectDocsContext loads markdown snippets from projectdocs', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dev-agent-docs-present-'));
  const docsDir = path.join(tempRoot, 'projectdocs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(
    path.join(docsDir, 'PRD.md'),
    '# Requirements\nThe system should support webhook lifecycle and prompt quality.\n',
    'utf-8'
  );
  fs.writeFileSync(
    path.join(docsDir, 'ARCHITECTURE.md'),
    '# Architecture\nEvent-driven watcher + orchestration pipeline.\n',
    'utf-8'
  );
  fs.writeFileSync(
    path.join(docsDir, 'API.md'),
    '# API\nWebhook trigger and status endpoints.\n',
    'utf-8'
  );

  const result = loadProjectDocsContext({
    baseDir: tempRoot,
    docsDirName: 'projectdocs',
    required: true,
    targetFilePath: path.join(tempRoot, 'src', 'webhookServer.js'),
  });
  assert.equal(result.exists, true);
  assert.equal(result.loaded, true);
  assert.equal(result.fileCount >= 1, true);
  assert.equal(Array.isArray(result.snippets), true);
  assert.deepEqual(result.requiredMissing, []);
});

test('loadProjectDocsContext ignores non-md docs for strict mode', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dev-agent-docs-strict-'));
  const docsDir = path.join(tempRoot, 'projectdocs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'PRD.md'), '# PRD\n', 'utf-8');
  fs.writeFileSync(path.join(docsDir, 'ARCHITECTURE.md'), '# ARCH\n', 'utf-8');
  fs.writeFileSync(path.join(docsDir, 'API.md'), '# API\n', 'utf-8');
  fs.writeFileSync(path.join(docsDir, 'notes.txt'), 'should not be loaded', 'utf-8');

  const result = loadProjectDocsContext({
    baseDir: tempRoot,
    docsDirName: 'projectdocs',
    required: true,
  });

  assert.equal(result.loaded, true);
  assert.equal(result.snippets.some((item) => item.path.endsWith('notes.txt')), false);
});
