import 'dotenv/config';
import { getCompletion } from './llm/client.js';
import {
  DEFAULT_MIN_CONFIDENCE,
  FALLBACK_RELEVANT_DOCS,
  retrieveRankedDocs,
} from './browserRetrieval.js';

const retrievalCache = new Map();

function toPositiveInt(value, fallback, min = 1, max = 30) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function toPositiveMs(value, fallback, min = 250, max = 30000) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function toNonNegativeMs(value, fallback, max = 86400000) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  if (rounded < 0) return 0;
  if (rounded > max) return max;
  return rounded;
}

function resolveProvider(providerOverride) {
  const configured = String(
    providerOverride ?? process.env.BROWSER_RETRIEVAL_PROVIDER ?? 'auto'
  ).toLowerCase();
  if (configured === 'brave') return 'brave';
  if (configured === 'keyless') return 'keyless';
  return process.env.BRAVE_API_KEY ? 'brave' : 'keyless';
}

function resolveRetrievalConfig(overrides = {}) {
  return {
    provider: resolveProvider(overrides.provider),
    maxResults: toPositiveInt(
      overrides.maxResults ?? process.env.BROWSER_RETRIEVAL_MAX_RESULTS,
      8
    ),
    timeoutMs: toPositiveMs(
      overrides.timeoutMs ?? process.env.BROWSER_RETRIEVAL_TIMEOUT_MS,
      8000
    ),
    minScore: Number.isFinite(Number(overrides.minScore ?? process.env.BROWSER_RETRIEVAL_MIN_SCORE))
      ? Number(overrides.minScore ?? process.env.BROWSER_RETRIEVAL_MIN_SCORE)
      : 0.25,
    cacheTtlMs: toNonNegativeMs(
      overrides.cacheTtlMs ?? process.env.BROWSER_RETRIEVAL_CACHE_TTL_MS,
      300000
    ),
    cacheMaxEntries: toPositiveInt(
      overrides.cacheMaxEntries ?? process.env.BROWSER_RETRIEVAL_CACHE_MAX_ENTRIES,
      200,
      1,
      5000
    ),
    fetchImpl: typeof overrides.fetchImpl === 'function' ? overrides.fetchImpl : undefined,
    apiKey: typeof overrides.apiKey === 'string' ? overrides.apiKey : process.env.BRAVE_API_KEY,
  };
}

function makeFallbackQuery(filePath, fileAnalysis) {
  const purpose =
    typeof fileAnalysis?.purpose === 'string' ? fileAnalysis.purpose : 'file behavior';
  const imports = Array.isArray(fileAnalysis?.imports)
    ? fileAnalysis.imports.filter((item) => typeof item === 'string').slice(0, 2)
    : [];
  const importHint = imports.length > 0 ? ` ${imports.join(' ')}` : '';
  return `${filePath} ${purpose}${importHint} API reference`;
}

function normalizeQuery(rawQuery, filePath, fileAnalysis) {
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  return query || makeFallbackQuery(filePath, fileAnalysis);
}

function buildFallbackResult(query, timestamp, reason = 'retrieval-unavailable') {
  return {
    query,
    relevantDocs: FALLBACK_RELEVANT_DOCS,
    timestamp,
    topics: [],
    confidence: 0,
    quality: 'low-signal',
    retrieval: {
      provider: 'none',
      status: reason,
      selectedCount: 0,
      confidence: 0,
      lowConfidence: true,
      ranked: [],
    },
  };
}

function buildCacheKey(query, config) {
  return JSON.stringify({
    provider: config.provider,
    query,
    minScore: config.minScore,
    maxResults: config.maxResults,
  });
}

function trimCache(maxEntries) {
  while (retrievalCache.size > maxEntries) {
    const firstKey = retrievalCache.keys().next().value;
    if (!firstKey) break;
    retrievalCache.delete(firstKey);
  }
}

function getCachedRetrieval(cacheKey, nowMs) {
  const cached = retrievalCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= nowMs) {
    retrievalCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

async function retrieveWithFallback(query, fileAnalysis, retrievalConfig) {
  const nowMs = Date.now();
  const cacheTtlMs = retrievalConfig.cacheTtlMs;
  const cacheMaxEntries = retrievalConfig.cacheMaxEntries;
  const primaryKey = buildCacheKey(query, retrievalConfig);
  const cachedPrimary = getCachedRetrieval(primaryKey, nowMs);
  if (cachedPrimary) return cachedPrimary;

  const primary = await retrieveRankedDocs(query, fileAnalysis, retrievalConfig);
  const shouldTrySecondary =
    retrievalConfig.provider === 'brave' && (primary.lowConfidence || primary.confidence < DEFAULT_MIN_CONFIDENCE);

  if (!shouldTrySecondary) {
    if (cacheTtlMs > 0) {
      retrievalCache.set(primaryKey, { expiresAt: nowMs + cacheTtlMs, value: primary });
      trimCache(cacheMaxEntries);
    }
    return primary;
  }

  const secondaryConfig = { ...retrievalConfig, provider: 'keyless' };
  const secondaryKey = buildCacheKey(query, secondaryConfig);
  const cachedSecondary = getCachedRetrieval(secondaryKey, nowMs);
  const secondary = cachedSecondary ?? (await retrieveRankedDocs(query, fileAnalysis, secondaryConfig));
  const winner = secondary.confidence > primary.confidence ? secondary : primary;

  if (cacheTtlMs > 0) {
    retrievalCache.set(primaryKey, { expiresAt: nowMs + cacheTtlMs, value: winner });
    retrievalCache.set(secondaryKey, { expiresAt: nowMs + cacheTtlMs, value: secondary });
    trimCache(cacheMaxEntries);
  }
  return winner;
}

export async function getBrowserContext(filePath, fileAnalysis, options = {}) {
  const timestamp = new Date().toISOString();
  const completion = options?.completion ?? getCompletion;
  const retrievalConfig = resolveRetrievalConfig(options?.retrieval ?? {});

  try {
    const prompt = `Given this file context: ${fileAnalysis?.summary ?? 'No summary available.'}. What specific technical documentation or API reference would a developer need? Return a single concise search query.`;
    const text = await completion({
      systemPrompt: 'Return only a concise search query.',
      userPrompt: prompt,
    });
    const query = normalizeQuery(text, filePath, fileAnalysis);

    try {
      let retrieval;
      try {
        retrieval = await retrieveWithFallback(query, fileAnalysis, retrievalConfig);
      } catch (primaryError) {
        if (retrievalConfig.provider === 'brave') {
          console.warn(
            `[browserIntelligence] brave retrieval failed for ${filePath}; falling back to keyless:`,
            primaryError instanceof Error ? primaryError.message : primaryError
          );
          retrieval = await retrieveWithFallback(query, fileAnalysis, {
            ...retrievalConfig,
            provider: 'keyless',
          });
        } else {
          throw primaryError;
        }
      }
      const lowConfidence =
        retrieval.lowConfidence || retrieval.confidence < DEFAULT_MIN_CONFIDENCE;
      if (lowConfidence) {
        return {
          query,
          relevantDocs: FALLBACK_RELEVANT_DOCS,
          timestamp,
          topics: retrieval.topics,
          confidence: retrieval.confidence,
          quality: 'low-signal',
          retrieval: {
            provider: retrieval.provider,
            status: 'low-confidence',
            selectedCount: retrieval.selected.length,
            confidence: retrieval.confidence,
            lowConfidence: true,
            ranked: retrieval.ranked,
          },
        };
      }

      return {
        query,
        relevantDocs: retrieval.relevantDocs,
        timestamp,
        topics: retrieval.topics,
        confidence: retrieval.confidence,
        quality: retrieval.quality,
        retrieval: {
          provider: retrieval.provider,
          status: 'ok',
          selectedCount: retrieval.selected.length,
          confidence: retrieval.confidence,
          lowConfidence: false,
          ranked: retrieval.ranked,
        },
      };
    } catch (retrievalError) {
      console.warn(
        `[browserIntelligence] retrieval failed for ${filePath}:`,
        retrievalError instanceof Error ? retrievalError.message : retrievalError
      );
      return buildFallbackResult(query, timestamp, 'retrieval-error');
    }
  } catch (err) {
    console.error(
      `[browserIntelligence] getBrowserContext failed for ${filePath}:`,
      err instanceof Error ? err.message : err
    );

    return buildFallbackResult(makeFallbackQuery(filePath, fileAnalysis), timestamp, 'query-error');
  }
}

export function clearBrowserRetrievalCache() {
  retrievalCache.clear();
}
