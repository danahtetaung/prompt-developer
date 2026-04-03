import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scorePathPriority,
  scorePromptPriority,
  shouldDeliverByPriority,
} from '../src/promptPriority.js';

test('scorePathPriority gives higher scores to src core files than tests', () => {
  const srcScore = scorePathPriority('src/orchestratorAdapter.js').score;
  const testScore = scorePathPriority('test/orchestrator.test.js').score;
  assert.equal(srcScore > testScore, true);
});

test('scorePromptPriority boosts urgency and recent change signals', () => {
  const base = scorePromptPriority({
    filePath: 'src/example.js',
    analysis: { imports: [], exports: [] },
    intent: 'refactor module',
    recentChanges: [],
  });
  const boosted = scorePromptPriority({
    filePath: 'src/example.js',
    analysis: { imports: ['a', 'b'], exports: ['x'] },
    intent: 'fix urgent auth error',
    recentChanges: [{ fullPath: 'src/example.js' }],
  });
  assert.equal(boosted.score > base.score, true);
});

test('scorePromptPriority boosts critical tags and side effects', () => {
  const base = scorePromptPriority({
    filePath: 'src/inert.js',
    analysis: { imports: [], exports: [], tags: [], sideEffects: {} },
    intent: 'refactor',
    recentChanges: [],
  });

  const boosted = scorePromptPriority({
    filePath: 'src/important.js',
    analysis: {
      imports: ['fs'],
      exports: ['run'],
      tags: ['auth', 'watcher'],
      clusterHints: ['core-pipeline'],
      sideEffects: { filesystem: true, network: true, process: false, globalMutation: false },
    },
    intent: 'refactor',
    recentChanges: [],
  });

  assert.equal(boosted.score > base.score, true);
  assert.equal(boosted.factors.tagCriticality > 0, true);
  assert.equal(boosted.factors.sideEffectRisk > 0, true);
});

test('shouldDeliverByPriority respects topN and minScore controls', () => {
  assert.equal(
    shouldDeliverByPriority(
      { score: 80, rank: 2 },
      { topN: 3, minScore: 70 }
    ),
    true
  );
  assert.equal(
    shouldDeliverByPriority(
      { score: 60, rank: 4 },
      { topN: 3, minScore: 50 }
    ),
    false
  );
  assert.equal(
    shouldDeliverByPriority(
      { score: 40, rank: 1 },
      { topN: null, minScore: 50 }
    ),
    false
  );
});
