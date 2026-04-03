import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMasterPrompts, resolveMasterPromptCount } from '../src/masterPromptGenerator.js';

const summaryFixture = {
  prompts: [
    { file: 'a.js', ok: true, priorityScore: 95, priorityReason: 'A' },
    { file: 'b.js', ok: true, priorityScore: 90, priorityReason: 'B' },
    { file: 'c.js', ok: true, priorityScore: 85, priorityReason: 'C' },
    { file: 'd.js', ok: true, priorityScore: 80, priorityReason: 'D' },
    { file: 'e.js', ok: true, priorityScore: 75, priorityReason: 'E' },
    { file: 'f.js', ok: true, priorityScore: 70, priorityReason: 'F' },
  ],
};

test('resolveMasterPromptCount clamps to 4 or 5', () => {
  assert.equal(resolveMasterPromptCount(1), 4);
  assert.equal(resolveMasterPromptCount(4), 4);
  assert.equal(resolveMasterPromptCount(5), 5);
  assert.equal(resolveMasterPromptCount(10), 5);
});

test('generateMasterPrompts returns fallback content when completion fails', async () => {
  const result = await generateMasterPrompts({
    fullscanRunId: 'run-1',
    summary: summaryFixture,
    track: 'feature',
    maxCount: 5,
    services: {
      getCompletion: async () => {
        throw new Error('simulated llm failure');
      },
    },
  });

  assert.equal(result.source, 'fallback');
  assert.equal(result.track, 'feature');
  assert.equal(result.count, 5);
  assert.deepEqual(result.selectedFiles, ['a.js', 'b.js', 'c.js', 'd.js', 'e.js']);
  assert.match(result.content, /# Feature Master Prompts \(run-1\)/);
  assert.match(result.content, /1\. Focus on `a\.js`/);
});

test('generateMasterPrompts returns llm content when available', async () => {
  const result = await generateMasterPrompts({
    fullscanRunId: 'run-2',
    summary: summaryFixture,
    track: 'safe',
    maxCount: 4,
    services: {
      getCompletion: async () => '# Safe Master Prompts (run-2)\n\n1. First',
    },
  });

  assert.equal(result.source, 'llm');
  assert.equal(result.track, 'safe');
  assert.equal(result.count, 4);
  assert.deepEqual(result.selectedFiles, ['a.js', 'b.js', 'c.js', 'd.js']);
  assert.match(result.content, /# Safe Master Prompts \(run-2\)/);
});
