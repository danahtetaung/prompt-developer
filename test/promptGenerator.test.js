import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGroundingPolicy, buildPromptPayload, generatePrompt } from '../src/promptGenerator.js';

function makeContext(overrides = {}) {
  return {
    file: 'contextBuilder.js',
    fullPath: 'C:\\repo\\src\\contextBuilder.js',
    lineCount: 120,
    charCount: 3200,
    analysis: {
      summary: 'Builds enriched context for prompt generation.',
      purpose: 'context assembly',
    },
    browserContext: {
      query: 'node fs readFileSync api reference',
      relevantDocs: 'Retrieved documentation:\n1. Node.js fs docs',
      topics: ['node', 'fs', 'readfilesync', 'api'],
      confidence: 0.82,
      quality: 'high-signal',
      retrieval: {
        provider: 'brave',
        status: 'ok',
        selectedCount: 2,
        lowConfidence: false,
        ranked: [
          {
            title: 'Node.js fs docs',
            url: 'https://nodejs.org/api/fs.html',
            domain: 'nodejs.org',
            ranking: { finalScore: 0.85, trustScore: 0.1 },
          },
        ],
      },
    },
    recentChanges: [{ file: 'contextBuilder.js', timestamp: new Date().toISOString() }],
    contextSignals: {
      contextDigest: 'Purpose: context assembly',
      complexityContext: { level: 'medium' },
    },
    dependencyMap: { 'contextBuilder.js': ['fileIntelligence.js'] },
    projectProfileContext: { scopeMode: 'everything', riskTolerance: 'balanced' },
    projectDocsContext: { summary: 'Project docs loaded.', snippets: [] },
    ...overrides,
  };
}

test('buildGroundingPolicy is evidence-first for high-signal confidence', () => {
  const policy = buildGroundingPolicy({ quality: 'high-signal', confidence: 0.8 });
  assert.equal(policy.evidenceFirst, true);
  assert.equal(
    policy.factualClaimPolicy.includes('primary source for API behavior'),
    true
  );
});

test('buildGroundingPolicy is conservative for low-signal confidence', () => {
  const policy = buildGroundingPolicy({ quality: 'low-signal', confidence: 0.2 });
  assert.equal(policy.evidenceFirst, false);
  assert.equal(policy.assumptionsPolicy.includes('verification'), true);
});

test('buildPromptPayload separates reasoning and evidence lanes', () => {
  const context = makeContext();
  const payload = buildPromptPayload(context, 'Refine context quality scoring.', 'safe');

  assert.equal(typeof payload.reasoningContext.analysis.summary, 'string');
  assert.equal(typeof payload.evidenceContext.relevantDocs, 'string');
  assert.equal(Array.isArray(payload.evidenceContext.topics), true);
  assert.equal(Array.isArray(payload.evidenceContext.retrieval.ranked), true);
  assert.equal(payload.groundingPolicy.evidenceFirst, true);
  assert.equal(payload.promptTrack, 'safe');
});

test('generatePrompt includes lane payload for LLM completion', async () => {
  const context = makeContext();
  /** @type {string} */
  let capturedUserPrompt = '';

  const output = await generatePrompt(context, {
    promptTrack: 'safe',
    services: {
      detectIntent: async () => 'Refine context generation quality.',
      getCompletion: async ({ userPrompt }) => {
        capturedUserPrompt = userPrompt;
        return 'PROMPT_OUTPUT';
      },
    },
  });

  assert.equal(output, 'PROMPT_OUTPUT');
  assert.equal(capturedUserPrompt.includes('"reasoningContext"'), true);
  assert.equal(capturedUserPrompt.includes('"evidenceContext"'), true);
  assert.equal(capturedUserPrompt.includes('"groundingPolicy"'), true);
});

test('generatePrompt fallback template contains evidence sections', async () => {
  const context = makeContext({
    browserContext: {
      query: '',
      relevantDocs: 'No docs context available.',
      confidence: 0.1,
      quality: 'low-signal',
    },
  });

  const output = await generatePrompt(context, {
    services: {
      detectIntent: async () => 'Improve resilience.',
      getCompletion: async () => '',
    },
  });

  assert.equal(output.includes('Reasoning Context:'), true);
  assert.equal(output.includes('Evidence Context:'), true);
  assert.equal(output.includes('Grounding Policy:'), true);
  assert.equal(output.includes('Assumptions needing verification:'), true);
});
