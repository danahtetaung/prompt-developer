import { isTransientHttpError, withRetry } from './utils/retry.js';

const FALLBACK_RELEVANT_DOCS =
  'No docs context available. External retrieval returned no high-confidence documentation matches.';

const DEFAULT_MIN_SCORE = 0.25;
const DEFAULT_MIN_CONFIDENCE = 0.5;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_SUMMARY_ITEMS = 3;
const DOMAIN_DUPLICATE_PENALTY = 0.02;
const MAX_DOMAIN_DUPLICATE_PENALTY = 0.06;

const TRUST_BONUS_BY_TIER = {
  tier1: 0.1,
  tier2: 0.06,
  tier3: 0.03,
  unknown: 0,
};

const TRUST_DOMAIN_TIERS = {
  tier1: [
    'developer.mozilla.org',
    'nodejs.org',
    'docs.github.com',
    'docs.npmjs.com',
    'npmjs.com',
    'react.dev',
    'nextjs.org',
    'vuejs.org',
    'angular.dev',
    'svelte.dev',
    'www.typescriptlang.org',
    'docs.python.org',
    'go.dev',
    'golang.org',
    'docs.deno.com',
    'docs.aws.amazon.com',
    'cloud.google.com',
    'learn.microsoft.com',
    'supabase.com',
    'www.postgresql.org',
  ],
  tier2: [
    'stackoverflow.com',
    'jestjs.io',
    'vitest.dev',
    'eslint.org',
    'prettier.io',
    'expressjs.com',
    'fastify.dev',
    'hono.dev',
    'tailwindcss.com',
    'prisma.io',
    'sequelize.org',
  ],
  tier3: ['medium.com', 'dev.to', 'hashnode.com'],
};

const API_REFERENCE_TERMS = new Set([
  'api',
  'reference',
  'docs',
  'documentation',
  'guide',
  'sdk',
  'cli',
  'configuration',
]);

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() || fallback : fallback;
}

function tokenize(value) {
  if (typeof value !== 'string') return [];
  return value
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
}

function extractHostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function overlapRatio(targetTokens, sourceTokens) {
  if (targetTokens.size === 0 || sourceTokens.length === 0) return 0;
  let hits = 0;
  for (const token of targetTokens) {
    if (sourceTokens.includes(token)) hits += 1;
  }
  return clampNumber(hits / targetTokens.size, 0, 1, 0);
}

function hasReferenceTerms(tokens) {
  return tokens.some((token) => API_REFERENCE_TERMS.has(token));
}

function compareByTitleAndUrl(a, b) {
  const titleCompare = a.title.localeCompare(b.title);
  if (titleCompare !== 0) return titleCompare;
  return a.url.localeCompare(b.url);
}

function normalizeTierInput(value) {
  if (value === 'tier1' || value === 'tier2' || value === 'tier3') return value;
  return 'unknown';
}

function flattenDuckDuckGoTopics(value) {
  if (!Array.isArray(value)) return [];
  const flattened = [];
  for (const item of value) {
    if (item && typeof item === 'object' && Array.isArray(item.Topics)) {
      flattened.push(...flattenDuckDuckGoTopics(item.Topics));
    } else {
      flattened.push(item);
    }
  }
  return flattened;
}

export function getDomainTrustTier(hostname, domainTiers = TRUST_DOMAIN_TIERS) {
  if (!hostname) return 'unknown';
  for (const tier of ['tier1', 'tier2', 'tier3']) {
    const domains = Array.isArray(domainTiers?.[tier]) ? domainTiers[tier] : [];
    const found = domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    if (found) return tier;
  }
  return 'unknown';
}

export function normalizeSearchResults(rawResults, provider = 'unknown') {
  const entries = Array.isArray(rawResults) ? rawResults : [];
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const title = normalizeString(entry.title ?? entry.Text);
      const url = normalizeString(entry.url ?? entry.href ?? entry.FirstURL);
      const snippet = normalizeString(entry.snippet ?? entry.description ?? entry.body);
      if (!title || !url) return null;
      const domain = extractHostname(url);
      return { title, url, snippet, provider, domain };
    })
    .filter((item) => item !== null);
}

export function scoreSearchResult(result, queryTokens, contextTokens, options = {}) {
  const safeQueryTokens = queryTokens instanceof Set ? queryTokens : new Set();
  const safeContextTokens = contextTokens instanceof Set ? contextTokens : new Set();
  const titleTokens = tokenize(result.title);
  const snippetTokens = tokenize(result.snippet);
  const combinedTokens = tokenize(`${result.title} ${result.snippet}`);
  const trustTier = getDomainTrustTier(result.domain, options.domainTiers);
  const trustScore = clampNumber(
    TRUST_BONUS_BY_TIER[normalizeTierInput(trustTier)] ?? 0,
    0,
    0.12,
    0
  );

  const titleOverlap = overlapRatio(safeQueryTokens, titleTokens);
  const snippetOverlap = overlapRatio(safeQueryTokens, snippetTokens);
  const contextOverlap = overlapRatio(safeContextTokens, combinedTokens);
  const referenceBonus = hasReferenceTerms(combinedTokens) ? 0.05 : 0;

  const relevanceScore = clampNumber(
    0.6 * titleOverlap + 0.3 * snippetOverlap + 0.1 * contextOverlap + referenceBonus,
    0,
    1,
    0
  );

  return {
    ...result,
    ranking: {
      relevanceScore,
      trustTier,
      trustScore,
      titleOverlap,
      snippetOverlap,
      contextOverlap,
      referenceBonus,
      domainPenalty: 0,
      finalScore: clampNumber(relevanceScore + trustScore, 0, 1, 0),
    },
  };
}

export function rankSearchResults(results, query, fileAnalysis = {}, options = {}) {
  const normalized = normalizeSearchResults(results);
  const queryTokens = new Set(tokenize(query));
  const contextTokens = new Set(
    tokenize(
      [
        normalizeString(fileAnalysis?.summary),
        normalizeString(fileAnalysis?.purpose),
        ...(Array.isArray(fileAnalysis?.imports)
          ? fileAnalysis.imports.filter((item) => typeof item === 'string')
          : []),
      ].join(' ')
    )
  );

  const scored = normalized
    .map((result) => scoreSearchResult(result, queryTokens, contextTokens, options))
    .sort((a, b) => {
      const scoreDiff = b.ranking.finalScore - a.ranking.finalScore;
      if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
      const trustDiff = b.ranking.trustScore - a.ranking.trustScore;
      if (Math.abs(trustDiff) > 0.0001) return trustDiff;
      return compareByTitleAndUrl(a, b);
    });

  const domainFrequency = scored.reduce((acc, item) => {
    const key = item.domain || 'unknown';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));

  const penalized = scored
    .map((item) => {
      const frequency = domainFrequency[item.domain || 'unknown'] ?? 1;
      const domainPenalty = clampNumber(
        (frequency - 1) * DOMAIN_DUPLICATE_PENALTY,
        0,
        MAX_DOMAIN_DUPLICATE_PENALTY,
        0
      );
      const finalScore = clampNumber(item.ranking.finalScore - domainPenalty, 0, 1, 0);
      return {
        ...item,
        ranking: {
          ...item.ranking,
          domainPenalty,
          finalScore,
        },
      };
    })
    .sort((a, b) => {
      const scoreDiff = b.ranking.finalScore - a.ranking.finalScore;
      if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
      const trustDiff = b.ranking.trustScore - a.ranking.trustScore;
      if (Math.abs(trustDiff) > 0.0001) return trustDiff;
      return compareByTitleAndUrl(a, b);
    });

  return penalized;
}

export function selectRankedResults(rankedResults, options = {}) {
  const minScore = clampNumber(options.minScore, 0, 1, DEFAULT_MIN_SCORE);
  const maxResults = clampNumber(options.maxResults, 1, 10, DEFAULT_MAX_SUMMARY_ITEMS);
  return rankedResults
    .filter((item) => item.ranking.finalScore >= minScore)
    .slice(0, maxResults);
}

export function deriveTopics(rankedResults, query) {
  const allTokens = [
    ...tokenize(query),
    ...rankedResults.flatMap((item) => tokenize(`${item.title} ${item.snippet}`)),
  ];
  return [...new Set(allTokens)].slice(0, 10);
}

export function deriveConfidence(selectedResults) {
  if (!Array.isArray(selectedResults) || selectedResults.length === 0) return 0;
  const averageScore =
    selectedResults.reduce((acc, item) => acc + item.ranking.finalScore, 0) /
    selectedResults.length;
  const resultCoverageBonus = Math.min(0.1, selectedResults.length * 0.02);
  return clampNumber(averageScore + resultCoverageBonus, 0, 1, 0);
}

export function buildRelevantDocs(selectedResults) {
  if (!Array.isArray(selectedResults) || selectedResults.length === 0) {
    return FALLBACK_RELEVANT_DOCS;
  }
  const lines = selectedResults.map((item, index) => {
    const finalScore = item.ranking.finalScore.toFixed(2);
    const trustScore = item.ranking.trustScore.toFixed(2);
    return `${index + 1}. ${item.title} (${item.domain || 'unknown'}, score=${finalScore}, trust=${trustScore}) - ${item.url}`;
  });
  return `Retrieved documentation:\n${lines.join('\n')}`;
}

export function normalizeRetrievalOutput(selectedResults, query) {
  const confidence = deriveConfidence(selectedResults);
  const quality = confidence >= DEFAULT_MIN_CONFIDENCE ? 'high-signal' : 'low-signal';
  return {
    relevantDocs: buildRelevantDocs(selectedResults),
    topics: deriveTopics(selectedResults, query),
    confidence,
    quality,
  };
}

async function fetchWithTimeout(url, requestInit, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...requestInit, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function createHttpError(label, status, bodyText) {
  const err = new Error(`${label} retrieval failed (${status}): ${String(bodyText).slice(0, 200)}`);
  err.name = 'BrowserRetrievalHttpError';
  /** @type {{ status?: number }} */ (err).status = status;
  return err;
}

export async function fetchBraveSearchResults(query, options = {}) {
  const apiKey = normalizeString(options.apiKey ?? process.env.BRAVE_API_KEY);
  if (!apiKey) {
    throw new Error('BRAVE_API_KEY is required for Brave retrieval.');
  }
  const timeoutMs = clampNumber(options.timeoutMs, 500, 30000, 8000);
  const maxResults = clampNumber(options.maxResults, 1, 20, DEFAULT_MAX_RESULTS);
  const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}&text_decorations=0&search_lang=en`;
  return withRetry(
    async () => {
      const response = await fetchWithTimeout(
        endpoint,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': apiKey,
          },
        },
        timeoutMs,
        options.fetchImpl
      );
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw createHttpError('Brave', response.status, bodyText);
      }
      const payload = await response.json();
      const results = Array.isArray(payload?.web?.results) ? payload.web.results : [];
      return results.map((item) => ({
        title: item?.title ?? '',
        url: item?.url ?? '',
        snippet: item?.description ?? '',
      }));
    },
    {
      retries: 2,
      baseDelayMs: 250,
      factor: 2,
      shouldRetry: (error) => isTransientHttpError(error),
    }
  );
}

export async function fetchKeylessSearchResults(query, options = {}) {
  const timeoutMs = clampNumber(options.timeoutMs, 500, 30000, 8000);
  const maxResults = clampNumber(options.maxResults, 1, 20, DEFAULT_MAX_RESULTS);
  const endpoint = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1&skip_disambig=1`;
  return withRetry(
    async () => {
      const response = await fetchWithTimeout(
        endpoint,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        },
        timeoutMs,
        options.fetchImpl
      );
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw createHttpError('Keyless', response.status, bodyText);
      }
      const payload = await response.json();
      const results = flattenDuckDuckGoTopics(payload?.RelatedTopics).slice(0, maxResults);
      return results.map((item) => ({
        title: item?.Text ?? '',
        url: item?.FirstURL ?? '',
        snippet: item?.Text ?? '',
      }));
    },
    {
      retries: 2,
      baseDelayMs: 250,
      factor: 2,
      shouldRetry: (error) => isTransientHttpError(error),
    }
  );
}

export async function retrieveRankedDocs(query, fileAnalysis = {}, options = {}) {
  const provider = options.provider ?? 'keyless';
  const maxResults = clampNumber(options.maxResults, 1, 20, DEFAULT_MAX_RESULTS);
  const minScore = clampNumber(options.minScore, 0, 1, DEFAULT_MIN_SCORE);

  const rawResults =
    provider === 'brave'
      ? await fetchBraveSearchResults(query, { ...options, maxResults })
      : await fetchKeylessSearchResults(query, { ...options, maxResults });

  const ranked = rankSearchResults(rawResults, query, fileAnalysis, options);
  const selected = selectRankedResults(ranked, { minScore, maxResults: DEFAULT_MAX_SUMMARY_ITEMS });
  const normalized = normalizeRetrievalOutput(selected, query);
  const lowConfidence = normalized.confidence < DEFAULT_MIN_CONFIDENCE;

  return {
    provider,
    ranked,
    selected,
    ...normalized,
    lowConfidence,
  };
}

export {
  DEFAULT_MIN_CONFIDENCE,
  FALLBACK_RELEVANT_DOCS,
  TRUST_BONUS_BY_TIER,
  TRUST_DOMAIN_TIERS,
};
