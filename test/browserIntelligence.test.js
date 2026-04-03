import test from 'node:test';
import assert from 'node:assert/strict';
import { clearBrowserRetrievalCache, getBrowserContext } from '../src/browserIntelligence.js';

function makeJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test('getBrowserContext returns high-signal output when retrieval succeeds', async () => {
  clearBrowserRetrievalCache();
  const context = await getBrowserContext(
    'src/contextBuilder.js',
    { summary: 'Uses fs and path modules', purpose: 'build context', imports: ['node:fs'] },
    {
      completion: async () => 'node fs readFileSync api reference',
      retrieval: {
        provider: 'keyless',
        fetchImpl: async () =>
          makeJsonResponse(200, {
            RelatedTopics: [
              {
                Text: 'Node.js fs.readFileSync API reference',
                FirstURL: 'https://nodejs.org/api/fs.html#fsreadfilesyncpath-options',
              },
              {
                Text: 'Node.js fs API docs',
                FirstURL: 'https://nodejs.org/api/fs.html',
              },
            ],
          }),
      },
    }
  );

  assert.equal(typeof context.timestamp, 'string');
  assert.equal(context.quality, 'high-signal');
  assert.equal(context.confidence > 0.5, true);
  assert.equal(Array.isArray(context.topics), true);
  assert.equal(context.relevantDocs.includes('Retrieved documentation:'), true);
  assert.equal(context.retrieval.provider, 'keyless');
  assert.equal(context.retrieval.status, 'ok');
});

test('getBrowserContext falls back when retrieval confidence is low', async () => {
  clearBrowserRetrievalCache();
  const context = await getBrowserContext(
    'src/fileDiscovery.js',
    { summary: 'discovers files', purpose: 'discover files', imports: [] },
    {
      completion: async () => 'node file discovery docs',
      retrieval: {
        provider: 'keyless',
        minScore: 0.95,
        fetchImpl: async () =>
          makeJsonResponse(200, {
            RelatedTopics: [
              {
                Text: 'Some irrelevant content',
                FirstURL: 'https://example.com/irrelevant',
              },
            ],
          }),
      },
    }
  );

  assert.equal(context.quality, 'low-signal');
  assert.equal(context.relevantDocs.includes('No docs context available.'), true);
  assert.equal(context.retrieval.status, 'low-confidence');
});

test('getBrowserContext falls back when completion fails', async () => {
  clearBrowserRetrievalCache();
  const context = await getBrowserContext(
    'src/watcher.js',
    { summary: 'watcher logic', purpose: 'watch files', imports: ['chokidar'] },
    {
      completion: async () => {
        throw new Error('completion unavailable');
      },
    }
  );

  assert.equal(context.quality, 'low-signal');
  assert.equal(context.relevantDocs.includes('No docs context available.'), true);
  assert.equal(context.retrieval.status, 'query-error');
  assert.equal(context.query.includes('watcher.js'), true);
});

test('getBrowserContext falls back to keyless when brave retrieval errors', async () => {
  clearBrowserRetrievalCache();
  let callCount = 0;
  const context = await getBrowserContext(
    'src/contextBuilder.js',
    { summary: 'Uses fs and path modules', purpose: 'build context', imports: ['node:fs'] },
    {
      completion: async () => 'node fs readFileSync api reference',
      retrieval: {
        provider: 'brave',
        apiKey: 'test-key',
        fetchImpl: async (url) => {
          callCount += 1;
          const requestUrl = String(url);
          if (requestUrl.includes('api.search.brave.com')) {
            throw new Error('network timeout');
          }
          return makeJsonResponse(200, {
            RelatedTopics: [
              {
                Text: 'Node.js fs.readFileSync API reference',
                FirstURL: 'https://nodejs.org/api/fs.html#fsreadfilesyncpath-options',
              },
            ],
          });
        },
      },
    }
  );
  assert.equal(callCount > 1, true);
  assert.equal(context.retrieval.provider, 'keyless');
  assert.equal(context.retrieval.status, 'ok');
});

test('getBrowserContext caches retrieval results by query/provider', async () => {
  clearBrowserRetrievalCache();
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return makeJsonResponse(200, {
      RelatedTopics: [
        {
          Text: 'Node.js fs.readFileSync API reference',
          FirstURL: 'https://nodejs.org/api/fs.html#fsreadfilesyncpath-options',
        },
      ],
    });
  };

  const options = {
    completion: async () => 'node fs readFileSync api reference',
    retrieval: {
      provider: 'keyless',
      cacheTtlMs: 100000,
      fetchImpl,
    },
  };

  const first = await getBrowserContext(
    'src/contextBuilder.js',
    { summary: 'Uses fs and path modules', purpose: 'build context', imports: ['node:fs'] },
    options
  );
  const second = await getBrowserContext(
    'src/contextBuilder.js',
    { summary: 'Uses fs and path modules', purpose: 'build context', imports: ['node:fs'] },
    options
  );

  assert.equal(callCount, 1);
  assert.equal(first.relevantDocs, second.relevantDocs);
});
