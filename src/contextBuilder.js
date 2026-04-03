import fs from 'node:fs';
import path from 'node:path';
import { getBrowserContext } from './browserIntelligence.js';
import { ANALYSIS_VERSION, analyzeFile, buildDependencyMap } from './fileIntelligence.js';

const ALLOWED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);
const RECENT_CHANGES_LIMIT = 5;
const recentChanges = [];
const FALLBACK_SUMMARY_LIMIT = 300;
const PROJECT_PROFILE_PATH = path.resolve(process.cwd(), 'project-profile.json');
const STRING_ITEM_MAX_LEN = 140;
const STRING_LIST_MAX_ITEMS = 20;
const TOP_DEPENDENCY_MAX_ITEMS = 8;
const REVIEW_TARGET_MAX_ITEMS = 5;
const MIN_CONFIDENCE_FOR_HIGH_SIGNAL = 0.45;
const CONTEXT_DIGEST_LIMIT = 1200;

function summarizeContent(content) {
  const trimmed = content.trim();
  if (!trimmed) return 'File is empty.';
  if (trimmed.length <= FALLBACK_SUMMARY_LIMIT) return trimmed;
  return `${trimmed.slice(0, FALLBACK_SUMMARY_LIMIT)}...`;
}

function clampNumber(value, min, max, fallback = min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeStringList(input, maxItems = STRING_LIST_MAX_ITEMS) {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.slice(0, STRING_ITEM_MAX_LEN))
    ),
  ].slice(0, maxItems);
}

function normalizeOptionalString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toSafePath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return value.replace(/\\/g, '/');
}

function normalizeProjectProfile(profile = {}) {
  const scopeMode =
    profile?.scopeMode === 'personal' || profile?.scopeMode === 'b2b_saas'
      ? profile.scopeMode
      : 'everything';
  const riskTolerance =
    typeof profile?.deliveryPreferences?.riskTolerance === 'string'
      ? profile.deliveryPreferences.riskTolerance
      : 'balanced';
  const changeStyle =
    typeof profile?.deliveryPreferences?.changeStyle === 'string'
      ? profile.deliveryPreferences.changeStyle
      : 'incremental';
  const coreUseCases = Array.isArray(profile?.coreUseCases)
    ? profile.coreUseCases.filter((item) => typeof item === 'string').slice(0, 5)
    : [];

  /** @type {string[]} */
  const emphasis = [];
  if (scopeMode === 'b2b_saas') {
    emphasis.push('tenant-safety', 'auth-hardening', 'operability');
  } else if (scopeMode === 'personal') {
    emphasis.push('simplicity', 'low-maintenance');
  } else {
    emphasis.push('balanced-capability', 'broad-compatibility');
  }

  if (riskTolerance === 'aggressive') emphasis.push('feature-expansion');
  if (changeStyle === 'incremental') emphasis.push('small-safe-steps');

  return {
    projectName:
      typeof profile?.projectName === 'string' && profile.projectName.trim()
        ? profile.projectName.trim()
        : 'Unnamed project',
    projectSummary:
      typeof profile?.projectSummary === 'string' && profile.projectSummary.trim()
        ? profile.projectSummary.trim()
        : 'No project summary provided.',
    scopeMode,
    riskTolerance,
    changeStyle,
    coreUseCases,
    profileInfluence: {
      emphasis,
      suggestedScopeStyle:
        riskTolerance === 'aggressive'
          ? 'allow-broader-feature-scope'
          : 'prefer-safe-and-incremental',
    },
  };
}

function loadProjectProfile(overrideProfile) {
  if (overrideProfile && typeof overrideProfile === 'object') {
    return normalizeProjectProfile(overrideProfile);
  }
  try {
    if (!fs.existsSync(PROJECT_PROFILE_PATH)) {
      return normalizeProjectProfile({});
    }
    const raw = fs.readFileSync(PROJECT_PROFILE_PATH, 'utf-8').trim();
    const parsed = raw ? JSON.parse(raw) : {};
    return normalizeProjectProfile(parsed);
  } catch (err) {
    console.warn(
      '[contextBuilder] Failed to load project-profile.json, using defaults:',
      err instanceof Error ? err.message : err
    );
    return normalizeProjectProfile({});
  }
}

function buildDependencyContext(analysis) {
  const dependencies = Array.isArray(analysis?.dependencies) ? analysis.dependencies : [];
  const internalDependencies = dependencies
    .filter((item) => item.kind === 'internal')
    .map((item) => item.raw);
  const externalDependencies = dependencies
    .filter((item) => item.kind === 'external')
    .map((item) => item.raw);
  const relativeDependencies = dependencies
    .filter((item) => item.kind === 'relative')
    .map((item) => item.raw);
  const topDependencies = dependencies
    .map((item) => item.module || item.raw)
    .filter(Boolean)
    .slice(0, TOP_DEPENDENCY_MAX_ITEMS);
  const sideEffects = analysis?.sideEffects ?? {};
  const sideEffectScore =
    Number(Boolean(sideEffects.filesystem)) +
    Number(Boolean(sideEffects.network)) +
    Number(Boolean(sideEffects.process)) +
    Number(Boolean(sideEffects.globalMutation));
  const density = Math.min(10, dependencies.length);
  const dependencyRisk = Math.min(20, density + sideEffectScore * 3);
  const hotspotHints = Array.isArray(analysis?.clusterHints)
    ? analysis.clusterHints.filter((item) => typeof item === 'string')
    : [];
  const touchNeighbors = [
    ...new Set([
      ...internalDependencies.slice(0, 3),
      ...relativeDependencies.slice(0, 3),
      ...topDependencies.slice(0, 2),
    ]),
  ];

  return {
    internalDependencies,
    externalDependencies,
    relativeDependencies,
    topDependencies,
    dependencyRisk,
    hotspotHints,
    touchNeighbors,
  };
}

function buildSuggestedReviewTargets(currentFilePath, dependencyContext, changeContext) {
  const currentBase = path.basename(currentFilePath).toLowerCase();
  const recentByBasename = (changeContext?.recentWindow ?? []).reduce((acc, item) => {
    const base = path.basename(item.fullPath ?? '').toLowerCase();
    if (!base || base === currentBase) return acc;
    acc[base] = (acc[base] ?? 0) + 1;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));

  const dependencyCandidates = normalizeStringList([
    ...(dependencyContext?.touchNeighbors ?? []),
    ...(dependencyContext?.topDependencies ?? []),
  ]);

  return dependencyCandidates
    .map((candidate) => {
      const base = path.basename(candidate).toLowerCase();
      return {
        target: candidate,
        score: (recentByBasename[base] ?? 0) + (base ? 1 : 0),
      };
    })
    .sort((a, b) => b.score - a.score || a.target.localeCompare(b.target))
    .map((item) => item.target)
    .slice(0, REVIEW_TARGET_MAX_ITEMS);
}

function buildChangeIntentHints(currentFilePath, changeContext, dependencyContext) {
  const currentBase = path.basename(currentFilePath).toLowerCase();
  const recentBases = new Set(
    (changeContext?.recentWindow ?? [])
      .map((item) => path.basename(item.fullPath ?? '').toLowerCase())
      .filter((base) => base && base !== currentBase)
  );
  const neighborBases = new Set(
    normalizeStringList(dependencyContext?.touchNeighbors ?? []).map((item) =>
      path.basename(item).toLowerCase()
    )
  );
  const neighborChangeOverlap = [...neighborBases].filter((base) => recentBases.has(base)).length;

  let editMomentum = 'low';
  if (changeContext.changeFrequency >= 3 || changeContext.recencyScore > 1.3) {
    editMomentum = 'high';
  } else if (changeContext.changeFrequency >= 2 || changeContext.recencyScore > 0.75) {
    editMomentum = 'medium';
  }

  return {
    editMomentum,
    neighborChangeOverlap,
    likelyRefactorWindow:
      editMomentum !== 'low' && neighborChangeOverlap >= 1 && Boolean(changeContext.isHotFile),
  };
}

function buildRiskContext(analysis, dependencyContext, changeContext, projectProfileContext) {
  const sideEffects = analysis?.sideEffects ?? {};
  const sideEffectWeight =
    Number(Boolean(sideEffects.filesystem)) * 2 +
    Number(Boolean(sideEffects.network)) * 3 +
    Number(Boolean(sideEffects.process)) * 3 +
    Number(Boolean(sideEffects.globalMutation)) * 2;
  const profileRiskBias =
    projectProfileContext?.riskTolerance === 'conservative'
      ? 3
      : projectProfileContext?.riskTolerance === 'aggressive'
        ? -2
        : 0;
  const baseRisk = clampNumber(
    (dependencyContext?.dependencyRisk ?? 0) + sideEffectWeight + (changeContext?.isHotFile ? 2 : 0) + profileRiskBias,
    0,
    25,
    0
  );
  const level = baseRisk >= 16 ? 'high' : baseRisk >= 8 ? 'medium' : 'low';

  return {
    score: baseRisk,
    level,
    rationale: normalizeStringList([
      sideEffects.network ? 'network-side-effects' : '',
      sideEffects.process ? 'process-side-effects' : '',
      sideEffects.globalMutation ? 'global-mutation' : '',
      changeContext?.isHotFile ? 'hot-file' : '',
      projectProfileContext?.riskTolerance === 'conservative' ? 'conservative-profile' : '',
    ]),
    recommendedChangeStyle:
      level === 'high' ? 'narrow-and-validated' : level === 'medium' ? 'stepwise' : 'flexible',
  };
}

function buildScopeGuidance(projectProfileContext, promptTrack, riskContext) {
  const emphasis = normalizeStringList(projectProfileContext?.profileInfluence?.emphasis ?? []);
  const riskTolerance = projectProfileContext?.riskTolerance ?? 'balanced';
  const effectiveTrack = promptTrack === 'feature' || promptTrack === 'both' ? promptTrack : 'safe';
  const suggestedScope =
    effectiveTrack === 'feature'
      ? riskContext.level === 'high'
        ? 'feature-incremental'
        : 'feature-expansion'
      : riskContext.level === 'high'
        ? 'safe-patch'
        : 'safe-improvement';

  return {
    promptTrack: effectiveTrack,
    riskTolerance,
    emphasis,
    suggestedScope,
    planningHints: normalizeStringList([
      projectProfileContext?.profileInfluence?.suggestedScopeStyle ?? '',
      effectiveTrack === 'feature' ? 'favor-user-facing-capability' : 'favor-stability-and-clarity',
      riskContext.level === 'high' ? 'add-validation-and-rollout-steps' : 'keep-implementation-focused',
    ]),
  };
}

function normalizeBrowserContext(browserContext) {
  const query = normalizeOptionalString(browserContext?.query, 'No query available.');
  const relevantDocs = normalizeOptionalString(browserContext?.relevantDocs, 'No docs context available.');
  const timestamp =
    typeof browserContext?.timestamp === 'string' && browserContext.timestamp
      ? browserContext.timestamp
      : new Date().toISOString();
  const lowSignal =
    /mvp:|not enabled|no docs/i.test(relevantDocs) || /no query available/i.test(query);
  const providedTopics = Array.isArray(browserContext?.topics)
    ? browserContext.topics.filter((item) => typeof item === 'string')
    : [];
  const topicsSource =
    providedTopics.length > 0
      ? providedTopics.join(' ')
      : `${query} ${relevantDocs}`
          .split(/[^a-zA-Z0-9_-]+/)
          .map((item) => item.toLowerCase())
          .filter((item) => item.length >= 4)
          .join(' ');
  const topics = normalizeStringList(topicsSource, 10);
  const providedConfidence =
    typeof browserContext?.confidence === 'number' && Number.isFinite(browserContext.confidence)
      ? clampNumber(browserContext.confidence, 0, 1, lowSignal ? 0.25 : 0.85)
      : null;
  const confidence = providedConfidence ?? (lowSignal ? 0.25 : 0.85);
  const providedQuality =
    browserContext?.quality === 'high-signal' || browserContext?.quality === 'low-signal'
      ? browserContext.quality
      : null;
  const quality = providedQuality ?? (confidence < 0.5 ? 'low-signal' : 'high-signal');
  return {
    query,
    relevantDocs,
    timestamp,
    confidence,
    quality,
    topics,
  };
}

function buildChangeContext(currentFilePath) {
  const recentWindow = [...recentChanges];
  const normalizedCurrent = path.resolve(currentFilePath);
  const frequencyByFile = recentWindow.reduce((acc, item) => {
    const key = path.resolve(item.fullPath);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));
  const changeFrequency = frequencyByFile[normalizedCurrent] ?? 0;

  const now = Date.now();
  const recencyScore = recentWindow.reduce((acc, item) => {
    if (path.resolve(item.fullPath) !== normalizedCurrent) return acc;
    const ageMs = Math.max(0, now - Date.parse(item.timestamp));
    const ageMinutes = ageMs / 60000;
    return acc + Math.exp(-ageMinutes / 30);
  }, 0);

  return {
    recentWindow,
    changeFrequency,
    recencyScore: Number(recencyScore.toFixed(3)),
    isHotFile: changeFrequency >= 2 || recencyScore > 0.8,
  };
}

function buildComplexityContext(analysis, riskContext) {
  const complexity = analysis?.complexity ?? {};
  const lineCount = clampNumber(complexity.lineCount, 1, 200000, 1);
  const functionCount = clampNumber(complexity.functionCount, 0, 100000, 0);
  const branchCount = clampNumber(complexity.branchCount, 0, 100000, 0);
  const baseScore =
    Math.min(8, lineCount / 120) +
    Math.min(6, functionCount / 8) +
    Math.min(6, branchCount / 10) +
    (riskContext.level === 'high' ? 3 : riskContext.level === 'medium' ? 1.5 : 0);
  const score = clampNumber(baseScore, 0, 20, 0);
  const level = score >= 13 ? 'high' : score >= 7 ? 'medium' : 'low';
  return {
    score,
    level,
    suggestedInstructionDensity:
      level === 'high' ? 'high-detail' : level === 'medium' ? 'medium-detail' : 'low-detail',
  };
}

function buildPromptShapingContext({
  analysis,
  browserContext,
  dependencyContext,
  changeIntentHints,
  riskContext,
  complexityContext,
  scopeGuidance,
  suggestedReviewTargets,
  projectProfileContext,
}) {
  const primaryGoal = normalizeOptionalString(analysis?.purpose, 'Improve this file safely.');
  const objectiveHints = normalizeStringList([
    analysis?.suggestedContext ?? '',
    ...scopeGuidance.planningHints,
    changeIntentHints.likelyRefactorWindow ? 'validate adjacent modules before merge' : '',
  ]);
  const cautionHints = normalizeStringList([
    riskContext.level === 'high' ? 'preserve behavior with explicit checks' : '',
    dependencyContext.dependencyRisk >= 12 ? 'verify dependency compatibility' : '',
    browserContext.quality === 'low-signal' ? 'avoid speculative external API assumptions' : '',
    ...(analysis?.qualityFlags ?? []),
  ]);
  const preferredTrack =
    scopeGuidance.promptTrack === 'feature' || scopeGuidance.promptTrack === 'both'
      ? riskContext.level === 'high'
        ? 'safe'
        : 'feature'
      : 'safe';
  const executionStyle =
    complexityContext.level === 'high'
      ? 'phased-plan'
      : riskContext.level === 'high'
        ? 'guardrail-first'
        : 'direct-implementation';
  const signalScore = clampNumber(
    ((analysis?.confidence?.summary ?? 0) +
      (analysis?.confidence?.structure ?? 0) +
      (analysis?.confidence?.deps ?? 0) +
      browserContext.confidence) /
      4,
    0,
    1,
    0
  );

  return {
    primaryGoal,
    objectiveHints,
    cautionHints,
    preferredTrack,
    executionStyle,
    signalConfidence: signalScore,
    mustReference: normalizeStringList([
      ...suggestedReviewTargets,
      ...(projectProfileContext?.coreUseCases ?? []),
      ...dependencyContext.touchNeighbors,
    ], 8),
  };
}

function buildContextDigest({
  filePath,
  analysis,
  scopeGuidance,
  riskContext,
  changeIntentHints,
  complexityContext,
  browserContext,
  suggestedReviewTargets,
  qualityFlags,
}) {
  const parts = [
    `File: ${path.basename(filePath)}`,
    `Purpose: ${analysis.purpose}`,
    `Scope: ${scopeGuidance.suggestedScope}`,
    `Risk: ${riskContext.level} (${riskContext.score})`,
    `Complexity: ${complexityContext.level} (${complexityContext.score})`,
    `Momentum: ${changeIntentHints.editMomentum}; overlap=${changeIntentHints.neighborChangeOverlap}`,
    `Browser: ${browserContext.quality}; topics=${(browserContext.topics ?? []).slice(0, 4).join(', ') || 'none'}`,
    `Review targets: ${suggestedReviewTargets.slice(0, 4).join(', ') || 'none'}`,
    `Quality flags: ${qualityFlags.slice(0, 6).join(', ') || 'none'}`,
  ];
  const digest = parts.join(' | ');
  return digest.length <= CONTEXT_DIGEST_LIMIT
    ? digest
    : `${digest.slice(0, CONTEXT_DIGEST_LIMIT)}...`;
}

function normalizeAnalysis(analysis, content, filePath) {
  const fallbackSummary = summarizeContent(content);
  const fallbackPurpose = `Handle logic in ${path.basename(filePath)}.`;
  const summary = normalizeOptionalString(analysis?.summary);
  const purpose = normalizeOptionalString(analysis?.purpose);
  const suggestedContext = normalizeOptionalString(analysis?.suggestedContext);
  const normalizedImports = normalizeStringList(analysis?.imports);
  const normalizedExports = normalizeStringList(analysis?.exports);
  const normalizedSymbols = normalizeStringList(analysis?.symbols);
  const normalizedTags = normalizeStringList(analysis?.tags);
  const normalizedClusterHints = normalizeStringList(analysis?.clusterHints);
  const confidence =
    analysis?.confidence && typeof analysis.confidence === 'object'
      ? {
          summary: clampNumber(analysis.confidence.summary, 0, 1, 0),
          structure: clampNumber(analysis.confidence.structure, 0, 1, 0),
          deps: clampNumber(analysis.confidence.deps, 0, 1, 0),
          tags: clampNumber(analysis.confidence.tags, 0, 1, 0),
        }
      : { summary: 0, structure: 0, deps: 0, tags: 0 };
  const qualityFlags = normalizeStringList([
    !summary || summary.toLowerCase() === 'analysis unavailable.' ? 'fallback-summary' : '',
    !purpose || purpose.toLowerCase() === 'unknown' ? 'fallback-purpose' : '',
    suggestedContext ? '' : 'fallback-suggested-context',
    normalizedImports.length === 0 && normalizedExports.length === 0 ? 'sparse-io-signals' : '',
    confidence.deps < MIN_CONFIDENCE_FOR_HIGH_SIGNAL ? 'low-confidence-deps' : '',
    confidence.structure < MIN_CONFIDENCE_FOR_HIGH_SIGNAL ? 'low-confidence-structure' : '',
  ]);

  return {
    summary: summary && summary.toLowerCase() !== 'analysis unavailable.' ? summary : fallbackSummary,
    imports: normalizedImports,
    exports: normalizedExports,
    purpose: purpose && purpose.toLowerCase() !== 'unknown' ? purpose : fallbackPurpose,
    suggestedContext:
      suggestedContext || 'Review imports/exports and recent changes to preserve behavior.',
    symbols: normalizedSymbols,
    sideEffects:
      analysis?.sideEffects && typeof analysis.sideEffects === 'object'
        ? {
            filesystem: Boolean(analysis.sideEffects.filesystem),
            network: Boolean(analysis.sideEffects.network),
            process: Boolean(analysis.sideEffects.process),
            globalMutation: Boolean(analysis.sideEffects.globalMutation),
          }
        : {
            filesystem: false,
            network: false,
            process: false,
            globalMutation: false,
          },
    complexity:
      analysis?.complexity && typeof analysis.complexity === 'object'
        ? {
            lineCount: clampNumber(analysis.complexity.lineCount, 1, 200000, content.split('\n').length),
            functionCount: clampNumber(analysis.complexity.functionCount, 0, 100000, 0),
            branchCount: clampNumber(analysis.complexity.branchCount, 0, 100000, 0),
          }
        : {
            lineCount: content.split('\n').length,
            functionCount: 0,
            branchCount: 0,
          },
    dependencies: Array.isArray(analysis?.dependencies)
      ? analysis.dependencies
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            raw: typeof item.raw === 'string' ? item.raw : '',
            kind: item.kind === 'relative' || item.kind === 'internal' ? item.kind : 'external',
            resolved: typeof item.resolved === 'string' ? item.resolved : undefined,
            module: typeof item.module === 'string' ? item.module : '',
          }))
      : [],
    tags: normalizedTags,
    clusterHints: normalizedClusterHints,
    confidence,
    qualityFlags,
    analysisVersion:
      Number.isFinite(analysis?.analysisVersion) && Number(analysis.analysisVersion) > 0
        ? Number(analysis.analysisVersion)
        : ANALYSIS_VERSION,
  };
}

/**
 * @param {string} filePath
 * @param {{
 *   services?: {
 *     analyzeFile?: (filePath: string, content: string) => Promise<any>,
 *     getBrowserContext?: (filePath: string, analysis: any) => Promise<any>,
 *     buildDependencyMap?: (filePath: string, analysis: any) => Record<string, string[]>
 *   },
 *   projectProfile?: Record<string, any>,
 *   promptTrack?: 'safe' | 'feature' | 'both',
 *   projectDocsContext?: Record<string, any> | null
 * }} [options]
 * @returns {Promise<{
 *   file: string,
 *   fullPath: string,
 *   analysis: {
 *     summary: string,
 *     imports: string[],
 *     exports: string[],
 *     purpose: string,
 *     suggestedContext: string
 *   },
 *   browserContext: {
 *     query: string,
 *     relevantDocs: string,
 *     timestamp: string
 *   },
 *   dependencyMap: Record<string, string[]>,
 *   recentChanges: Array<{ file: string, fullPath: string, timestamp: string }>,
 *   timestamp: string,
 *   lineCount: number,
 *   charCount: number,
 *   extension: string
 * } | null>}
 */
export async function buildContext(filePath, options = {}) {
  try {
    const analyze = options.services?.analyzeFile ?? analyzeFile;
    const getBrowser = options.services?.getBrowserContext ?? getBrowserContext;
    const mapDependencies =
      options.services?.buildDependencyMap ?? buildDependencyMap;
    const projectProfileContext = loadProjectProfile(options.projectProfile);
    const projectDocsContext =
      options.projectDocsContext && typeof options.projectDocsContext === 'object'
        ? options.projectDocsContext
        : null;

    const content = fs.readFileSync(filePath, 'utf-8');
    const rawAnalysis = await analyze(filePath, content);
    const analysis = normalizeAnalysis(rawAnalysis, content, filePath);
    const browserContext = normalizeBrowserContext(await getBrowser(filePath, analysis));
    const dependencyMap = mapDependencies(filePath, analysis);
    const effectivePromptTrack =
      options.promptTrack === 'feature' || options.promptTrack === 'both'
        ? options.promptTrack
        : process.env.PROMPT_TRACK === 'feature' || process.env.PROMPT_TRACK === 'both'
          ? process.env.PROMPT_TRACK
          : 'safe';
    const changeItem = {
      file: path.basename(filePath),
      fullPath: filePath,
      timestamp: new Date().toISOString(),
    };

    recentChanges.push(changeItem);
    if (recentChanges.length > RECENT_CHANGES_LIMIT) {
      recentChanges.shift();
    }
    const changeContext = buildChangeContext(filePath);
    const dependencyContext = buildDependencyContext(analysis);
    const changeIntentHints = buildChangeIntentHints(filePath, changeContext, dependencyContext);
    const suggestedReviewTargets = buildSuggestedReviewTargets(
      filePath,
      dependencyContext,
      changeContext
    );
    const riskContext = buildRiskContext(
      analysis,
      dependencyContext,
      changeContext,
      projectProfileContext
    );
    const scopeGuidance = buildScopeGuidance(
      projectProfileContext,
      effectivePromptTrack,
      riskContext
    );
    const complexityContext = buildComplexityContext(analysis, riskContext);
    const contextQualityFlags = normalizeStringList([
      ...(analysis.qualityFlags ?? []),
      browserContext.quality === 'low-signal' ? 'missing-browser-context' : '',
      suggestedReviewTargets.length === 0 ? 'no-review-targets' : '',
      changeIntentHints.neighborChangeOverlap === 0 ? 'no-neighbor-overlap' : '',
    ]);
    const promptShapingContext = buildPromptShapingContext({
      analysis,
      browserContext,
      dependencyContext,
      changeIntentHints,
      riskContext,
      complexityContext,
      scopeGuidance,
      suggestedReviewTargets,
      projectProfileContext,
    });
    const contextDigest = buildContextDigest({
      filePath,
      analysis,
      scopeGuidance,
      riskContext,
      changeIntentHints,
      complexityContext,
      browserContext,
      suggestedReviewTargets,
      qualityFlags: contextQualityFlags,
    });
    const docsSummary =
      projectDocsContext && typeof projectDocsContext.summary === 'string'
        ? projectDocsContext.summary
        : 'No project docs summary available.';

    return {
      file: path.basename(filePath),
      fullPath: filePath,
      relativePath: toSafePath(path.relative(process.cwd(), filePath)),
      analysis,
      browserContext: {
        query: browserContext.query,
        relevantDocs: browserContext.relevantDocs,
        timestamp: browserContext.timestamp ?? new Date().toISOString(),
        quality: browserContext.quality,
        confidence: browserContext.confidence,
        topics: browserContext.topics,
      },
      dependencyMap,
      recentChanges: [...recentChanges],
      projectProfileContext,
      projectDocsContext,
      contextSignals: {
        dependencyContext,
        changeContext,
        changeIntentHints,
        riskContext,
        complexityContext,
        scopeGuidance,
        promptShapingContext,
        suggestedReviewTargets,
        contextQualityFlags,
        contextDigest,
        projectDocs: {
          loaded: Boolean(projectDocsContext?.loaded),
          fileCount: Number(projectDocsContext?.fileCount ?? 0),
          summary: docsSummary,
        },
        browserContext: {
          quality: browserContext.quality,
          confidence: browserContext.confidence,
          topics: browserContext.topics,
        },
        profileInfluence: projectProfileContext.profileInfluence,
      },
      timestamp: new Date().toISOString(),
      lineCount: content.split('\n').length,
      charCount: content.length,
      extension: path.extname(filePath),
    };
  } catch (err) {
    console.error(
      `[contextBuilder] Failed to read ${filePath}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export function resetRecentChanges() {
  recentChanges.length = 0;
}

export { ALLOWED_EXT };