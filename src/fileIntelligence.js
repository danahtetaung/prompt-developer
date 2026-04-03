import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { get as getDiskCache, load as loadDiskCache, save as saveDiskCache } from './cache.js';
import { getCompletion } from './llm/client.js';

export const ANALYSIS_VERSION = 2;

const SYSTEM_PROMPT =
  'You are a code analysis engine. Given a source file, respond with JSON only: { summary: string (2 sentences max), imports: string[], exports: string[], purpose: string (one line), suggestedContext: string (what a developer editing this file likely needs to know), symbols: string[], sideEffects: { filesystem: boolean, network: boolean, process: boolean, globalMutation: boolean }, complexity: { lineCount: number, functionCount: number, branchCount: number }, dependencies: Array<{ raw: string, kind: "relative"|"external"|"internal", resolved?: string, module: string }>, tags: string[], clusterHints: string[], confidence: { summary: number, structure: number, deps: number, tags: number } }';

const FALLBACK_ANALYSIS = {
  summary: 'Analysis unavailable.',
  imports: [],
  exports: [],
  purpose: 'Unknown',
  suggestedContext: 'Review the file directly for implementation details.',
  symbols: [],
  sideEffects: {
    filesystem: false,
    network: false,
    process: false,
    globalMutation: false,
  },
  complexity: {
    lineCount: 0,
    functionCount: 0,
    branchCount: 0,
  },
  dependencies: [],
  tags: [],
  clusterHints: [],
  confidence: {
    summary: 0.2,
    structure: 0.2,
    deps: 0.2,
    tags: 0.2,
  },
  analysisVersion: ANALYSIS_VERSION,
};

export const cache = new Map();
export const dependencyMap = new Map();

loadDiskCache();

function toCacheKey(filePath, content) {
  const digest = crypto.createHash('md5').update(content).digest('hex');
  return `${ANALYSIS_VERSION}:${filePath}:${digest}`;
}

function toUniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))];
}

function inferSymbols(content) {
  const symbols = new Set();
  const functionMatches = content.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g);
  for (const match of functionMatches) symbols.add(match[1]);
  const classMatches = content.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g);
  for (const match of classMatches) symbols.add(match[1]);
  const constMatches = content.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g);
  for (const match of constMatches) symbols.add(match[1]);
  return [...symbols];
}

function inferSideEffects(content) {
  return {
    filesystem: /\bfs\./.test(content) || /\b(readFile|writeFile|appendFile|mkdir|rename|rm)Sync?\(/.test(content),
    network: /\bfetch\(/.test(content) || /\bhttps?\./.test(content) || /\baxios\./.test(content),
    process: /\bprocess\./.test(content) || /\bchild_process\b/.test(content),
    globalMutation: /\bglobalThis\./.test(content) || /\bwindow\./.test(content),
  };
}

function inferComplexity(content) {
  const lineCount = content.split('\n').length;
  const functionCount =
    (content.match(/\bfunction\b/g) ?? []).length +
    (content.match(/=>/g) ?? []).length;
  const branchCount = (content.match(/\b(if|switch|case|for|while|catch)\b/g) ?? []).length;
  return { lineCount, functionCount, branchCount };
}

function classifyDependency(rawImport, filePath) {
  const raw = typeof rawImport === 'string' ? rawImport.trim() : '';
  if (!raw) return null;
  const kind = raw.startsWith('.')
    ? 'relative'
    : raw.startsWith('@/') || raw.startsWith('src/')
      ? 'internal'
      : 'external';
  const resolved = kind === 'relative' ? path.resolve(path.dirname(filePath), raw) : undefined;
  const module = kind === 'external' ? raw.split('/')[0] : path.basename(raw);
  return { raw, kind, resolved, module };
}

function inferTags(filePath, imports, purpose, content) {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  const source = `${normalizedPath}\n${imports.join('\n')}\n${purpose}\n${content.slice(0, 1200)}`.toLowerCase();
  const tags = new Set();
  if (normalizedPath.includes('/test/') || normalizedPath.endsWith('.test.js')) tags.add('test');
  if (source.includes('watcher') || source.includes('chokidar')) tags.add('watcher');
  if (source.includes('orchestrator')) tags.add('orchestration');
  if (source.includes('webhook') || source.includes('http')) tags.add('integration');
  if (source.includes('mcp')) tags.add('mcp');
  if (source.includes('openai') || source.includes('anthropic') || source.includes('llm')) tags.add('llm');
  if (source.includes('cache')) tags.add('cache');
  if (source.includes('intent') || source.includes('prompt')) tags.add('prompting');
  if (source.includes('auth') || source.includes('token') || source.includes('secret')) tags.add('auth');
  if (normalizedPath.includes('/src/')) tags.add('runtime');
  return [...tags];
}

function inferClusterHints(tags, filePath) {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  const hints = new Set();
  if (tags.includes('orchestration') || tags.includes('watcher')) hints.add('core-pipeline');
  if (tags.includes('integration') || tags.includes('mcp')) hints.add('integration-surface');
  if (tags.includes('llm') || tags.includes('prompting')) hints.add('intelligence-layer');
  if (tags.includes('test') || normalizedPath.includes('/test/')) hints.add('test-suite');
  if (hints.size === 0) hints.add('general-runtime');
  return [...hints];
}

export function normalizeAnalysis(value, options = {}) {
  const filePath = options.filePath ?? '';
  const content = options.content ?? '';
  if (!value || typeof value !== 'object') {
    return {
      ...FALLBACK_ANALYSIS,
      symbols: inferSymbols(content),
      sideEffects: inferSideEffects(content),
      complexity: inferComplexity(content),
      dependencies: [],
      tags: inferTags(filePath, [], FALLBACK_ANALYSIS.purpose, content),
      clusterHints: inferClusterHints([], filePath),
    };
  }

  const imports = toUniqueStrings(value.imports);
  const exportsList = toUniqueStrings(value.exports);
  const purpose =
    typeof value.purpose === 'string' && value.purpose.trim()
      ? value.purpose.trim()
      : FALLBACK_ANALYSIS.purpose;
  const symbols = toUniqueStrings(value.symbols);
  const inferredSymbols = symbols.length > 0 ? symbols : inferSymbols(content);
  const sideEffects =
    value.sideEffects && typeof value.sideEffects === 'object'
      ? {
          filesystem: Boolean(value.sideEffects.filesystem),
          network: Boolean(value.sideEffects.network),
          process: Boolean(value.sideEffects.process),
          globalMutation: Boolean(value.sideEffects.globalMutation),
        }
      : inferSideEffects(content);
  const complexity =
    value.complexity && typeof value.complexity === 'object'
      ? {
          lineCount:
            Number.isFinite(value.complexity.lineCount) && value.complexity.lineCount >= 0
              ? Number(value.complexity.lineCount)
              : inferComplexity(content).lineCount,
          functionCount:
            Number.isFinite(value.complexity.functionCount) && value.complexity.functionCount >= 0
              ? Number(value.complexity.functionCount)
              : inferComplexity(content).functionCount,
          branchCount:
            Number.isFinite(value.complexity.branchCount) && value.complexity.branchCount >= 0
              ? Number(value.complexity.branchCount)
              : inferComplexity(content).branchCount,
        }
      : inferComplexity(content);
  const dependenciesRaw = Array.isArray(value.dependencies) ? value.dependencies : imports;
  const dependencies = [
    ...new Map(
      dependenciesRaw
        .map((item) =>
          typeof item === 'string'
            ? classifyDependency(item, filePath)
            : classifyDependency(item?.raw ?? item?.module, filePath)
        )
        .filter(Boolean)
        .map((item) => [item.raw, item])
    ).values(),
  ];
  const tags = toUniqueStrings(value.tags);
  const normalizedTags =
    tags.length > 0 ? tags : inferTags(filePath, imports, purpose, content);
  const clusterHints = toUniqueStrings(value.clusterHints);
  const normalizedClusters =
    clusterHints.length > 0 ? clusterHints : inferClusterHints(normalizedTags, filePath);

  return {
    summary:
      typeof value.summary === 'string' && value.summary.trim()
        ? value.summary.trim()
        : FALLBACK_ANALYSIS.summary,
    imports,
    exports: exportsList,
    purpose,
    suggestedContext:
      typeof value.suggestedContext === 'string' && value.suggestedContext.trim()
        ? value.suggestedContext.trim()
        : FALLBACK_ANALYSIS.suggestedContext,
    symbols: inferredSymbols,
    sideEffects,
    complexity,
    dependencies,
    tags: normalizedTags,
    clusterHints: normalizedClusters,
    confidence:
      value.confidence && typeof value.confidence === 'object'
        ? {
            summary:
              Number.isFinite(value.confidence.summary) && value.confidence.summary >= 0
                ? Number(value.confidence.summary)
                : FALLBACK_ANALYSIS.confidence.summary,
            structure:
              Number.isFinite(value.confidence.structure) && value.confidence.structure >= 0
                ? Number(value.confidence.structure)
                : FALLBACK_ANALYSIS.confidence.structure,
            deps:
              Number.isFinite(value.confidence.deps) && value.confidence.deps >= 0
                ? Number(value.confidence.deps)
                : FALLBACK_ANALYSIS.confidence.deps,
            tags:
              Number.isFinite(value.confidence.tags) && value.confidence.tags >= 0
                ? Number(value.confidence.tags)
                : FALLBACK_ANALYSIS.confidence.tags,
          }
        : { ...FALLBACK_ANALYSIS.confidence },
    analysisVersion:
      Number.isFinite(value.analysisVersion) && Number(value.analysisVersion) > 0
        ? Number(value.analysisVersion)
        : ANALYSIS_VERSION,
  };
}

export async function analyzeFile(filePath, content) {
  const key = toCacheKey(filePath, content);

  if (cache.has(key)) {
    return cache.get(key);
  }

  const diskCached = getDiskCache(key);
  if (diskCached) {
    const normalized = normalizeAnalysis(diskCached, { filePath, content });
    cache.set(key, normalized);
    return normalized;
  }

  try {
    const text = await getCompletion({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `File path: ${filePath}\n\nSource code:\n${content}`,
      responseJsonOnly: true,
    });
    const parsed = JSON.parse(text);
    const normalized = normalizeAnalysis(parsed, { filePath, content });
    cache.set(key, normalized);
    saveDiskCache(key, normalized);
    return normalized;
  } catch (err) {
    console.error(
      `[fileIntelligence] analyzeFile failed for ${filePath}:`,
      err instanceof Error ? err.message : err
    );
    const fallback = { ...FALLBACK_ANALYSIS };
    cache.set(key, fallback);
    return fallback;
  }
}

export function buildDependencyMap(filePath, analysisResult) {
  const fileKey = path.basename(filePath);
  const directImports = Array.isArray(analysisResult?.imports)
    ? analysisResult.imports.filter((item) => typeof item === 'string')
    : [];
  const dependencyDetails = Array.isArray(analysisResult?.dependencies)
    ? analysisResult.dependencies.filter((item) => item && typeof item === 'object')
    : [];
  const inferredNested = directImports
    .filter((item) => item.startsWith('.'))
    .map((item) => path.basename(item))
    .filter(Boolean);
  const inferredDetails = dependencyDetails
    .filter((item) => item.kind === 'relative')
    .map((item) => path.basename(item.resolved ?? item.raw ?? ''))
    .filter(Boolean);
  const imports = [...new Set([...directImports, ...inferredNested, ...inferredDetails])];

  dependencyMap.set(fileKey, imports);
  return Object.fromEntries(dependencyMap);
}
