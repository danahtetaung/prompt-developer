import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRelevantDocs,
  fetchKeylessSearchResults,
  fetchBraveSearchResults,
  normalizeRetrievalOutput,
  normalizeSearchResults,
  rankSearchResults,
  selectRankedResults,
} from '../src/browserRetrieval.js';

test('normalizeSearchResults keeps only valid title/url entries', () => {
  const normalized = normalizeSearchResults([
    { title: 'Node fs docs', url: 'https://nodejs.org/api/fs.html', snippet: 'fs docs' },
    { title: 'missing-url', snippet: 'no url' },
    { Text: 'Duck topic', FirstURL: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API' },
  ]);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].domain, 'nodejs.org');
  assert.equal(normalized[1].domain, 'developer.mozilla.org');
});

test('rankSearchResults prioritizes relevance first with bounded trust bonus', () => {
  const ranked = rankSearchResults(
    [
      {
        title: 'Node fs readFileSync API reference',
        url: 'https://nodejs.org/api/fs.html#fsreadfilesyncpath-options',
        snippet: 'API reference for readFileSync usage and options.',
      },
      {
        title: 'General JavaScript tips',
        url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
        snippet: 'High-level JavaScript guide.',
      },
      {
        title: 'Deep readFileSync walkthrough',
        url: 'https://someblog.dev/posts/readFileSync-deep-dive',
        snippet: 'readFileSync API reference with examples and caveats.',
      },
    ],
    'node fs readFileSync API reference',
    { summary: 'Need readFileSync API docs', purpose: 'fs usage' }
  );

  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].url.includes('nodejs.org'), true);
  assert.equal(ranked[0].ranking.trustScore, 0.1);
  assert.equal(typeof ranked[0].ranking.relevanceScore, 'number');
  assert.equal(typeof ranked[0].ranking.finalScore, 'number');
  // A stronger relevance match should still beat weak official results.
  assert.equal(ranked[1].url.includes('someblog.dev'), true);
});

test('selectRankedResults applies deterministic thresholding', () => {
  const ranked = rankSearchResults(
    [
      {
        title: 'Fetch API reference',
        url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
        snippet: 'API docs for fetch.',
      },
      {
        title: 'Unrelated post',
        url: 'https://example.com/blog/unrelated',
        snippet: 'Totally unrelated topic.',
      },
    ],
    'fetch api reference',
    { summary: 'Need fetch docs' }
  );

  const selected = selectRankedResults(ranked, { minScore: 0.3, maxResults: 3 });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].url.includes('developer.mozilla.org'), true);
});

test('normalizeRetrievalOutput returns low-signal when selection is empty', () => {
  const normalized = normalizeRetrievalOutput([], 'node fs docs');
  assert.equal(normalized.quality, 'low-signal');
  assert.equal(normalized.confidence, 0);
  assert.equal(normalized.relevantDocs.includes('No docs context available.'), true);
});

test('buildRelevantDocs includes ranking metadata for debugging', () => {
  const ranked = rankSearchResults(
    [
      {
        title: 'Node path API',
        url: 'https://nodejs.org/api/path.html',
        snippet: 'Node.js path API docs.',
      },
    ],
    'node path api',
    { summary: 'Need node path docs' }
  );
  const summary = buildRelevantDocs(ranked.slice(0, 1));
  assert.equal(summary.includes('score='), true);
  assert.equal(summary.includes('trust='), true);
});

test('fetchKeylessSearchResults retries transient failures', async () => {
  let callCount = 0;
  const results = await fetchKeylessSearchResults('node fs docs', {
    timeoutMs: 5000,
    maxResults: 3,
    fetchImpl: async () => {
      callCount += 1;
      if (callCount < 2) {
        return {
          ok: false,
          status: 503,
          async json() {
            return {};
          },
          async text() {
            return 'temporary unavailable';
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            RelatedTopics: [
              {
                Text: 'Node.js fs docs',
                FirstURL: 'https://nodejs.org/api/fs.html',
              },
            ],
          };
        },
        async text() {
          return '';
        },
      };
    },
  });
  assert.equal(callCount >= 2, true);
  assert.equal(results.length > 0, true);
});

test('live Brave retrieval returns at least one result', async () => {
  if (!process.env.BRAVE_API_KEY) {
    assert.fail(
      'BRAVE_API_KEY is required for live retrieval tests. Set BRAVE_API_KEY before running test suite.'
    );
  }
  const results = await fetchBraveSearchResults('node fs readFileSync api reference', {
    apiKey: process.env.BRAVE_API_KEY,
    timeoutMs: 12000,
    maxResults: 5,
  });
  assert.equal(Array.isArray(results), true);
  assert.equal(results.length > 0, true);
});
