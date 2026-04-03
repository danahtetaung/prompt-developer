import path from 'node:path';

const HIGH_VALUE_FILES = new Set([
  'watcher.js',
  'orchestratorAdapter.js',
  'contextBuilder.js',
  'promptGenerator.js',
  'webhookServer.js',
  'contextServer.js',
]);

const URGENCY_KEYWORDS = [
  'fix',
  'error',
  'bug',
  'failure',
  'security',
  'auth',
  'urgent',
  'crash',
  'incident',
];

/**
 * @param {string} filePath
 * @returns {{ score: number, reason: string, factors: Record<string, number> }}
 */
export function scorePathPriority(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const fileName = path.basename(normalized);
  /** @type {Record<string, number>} */
  const factors = {
    pathCriticality: 0,
    fileRoleBoost: 0,
  };

  if (normalized.includes('/src/')) factors.pathCriticality += 35;
  else if (normalized.includes('/mcp/')) factors.pathCriticality += 25;
  else if (normalized.includes('/test/')) factors.pathCriticality += 12;
  else factors.pathCriticality += 8;

  if (HIGH_VALUE_FILES.has(fileName)) factors.fileRoleBoost += 18;

  const score = factors.pathCriticality + factors.fileRoleBoost;
  return {
    score,
    reason: `Path + role priority for ${fileName}`,
    factors,
  };
}

/**
 * @param {{
 *   filePath: string,
 *   analysis?: { imports?: string[], exports?: string[] },
 *   intent?: string,
 *   recentChanges?: Array<{ fullPath?: string }>
 * }} input
 * @returns {{ score: number, reason: string, factors: Record<string, number> }}
 */
export function scorePromptPriority(input) {
  const base = scorePathPriority(input.filePath);
  /** @type {Record<string, number>} */
  const factors = {
    ...base.factors,
    dependencyDensity: 0,
    recentHit: 0,
    intentUrgency: 0,
    sideEffectRisk: 0,
    tagCriticality: 0,
    clusterCriticality: 0,
  };

  const importsCount = Array.isArray(input.analysis?.imports)
    ? input.analysis.imports.length
    : 0;
  const exportsCount = Array.isArray(input.analysis?.exports)
    ? input.analysis.exports.length
    : 0;
  factors.dependencyDensity = Math.min(20, importsCount * 2 + exportsCount);

  const normalizedPath = path.resolve(input.filePath);
  const recentHit = Array.isArray(input.recentChanges)
    ? input.recentChanges.some((change) =>
        typeof change.fullPath === 'string'
          ? path.resolve(change.fullPath) === normalizedPath
          : false
      )
    : false;
  if (recentHit) factors.recentHit = 12;

  const intent = (input.intent ?? '').toLowerCase();
  if (URGENCY_KEYWORDS.some((keyword) => intent.includes(keyword))) {
    factors.intentUrgency = 15;
  }

  const sideEffects = input.analysis?.sideEffects;
  if (sideEffects && typeof sideEffects === 'object') {
    const signals = [
      Boolean(sideEffects.filesystem),
      Boolean(sideEffects.network),
      Boolean(sideEffects.process),
      Boolean(sideEffects.globalMutation),
    ].filter(Boolean).length;
    factors.sideEffectRisk = Math.min(8, signals * 2);
  }

  const tags = Array.isArray(input.analysis?.tags)
    ? input.analysis.tags.filter((item) => typeof item === 'string')
    : [];
  const criticalTags = ['auth', 'orchestration', 'watcher', 'integration', 'mcp', 'llm'];
  const tagHits = tags.filter((tag) => criticalTags.includes(tag.toLowerCase())).length;
  factors.tagCriticality = Math.min(10, tagHits * 3);

  const clusterHints = Array.isArray(input.analysis?.clusterHints)
    ? input.analysis.clusterHints.filter((item) => typeof item === 'string')
    : [];
  if (
    clusterHints.some((item) =>
      ['core-pipeline', 'integration-surface', 'intelligence-layer'].includes(
        item.toLowerCase()
      )
    )
  ) {
    factors.clusterCriticality = 5;
  }

  const score = Object.values(factors).reduce((acc, value) => acc + value, 0);
  const reason = `Priority ${score} (${importsCount} imports, ${exportsCount} exports, recent=${recentHit}, tags=${tags.length})`;
  return { score: Math.max(0, Math.min(100, score)), reason, factors };
}

/**
 * @param {{ score: number, rank: number }} stats
 * @param {{ topN: number | null, minScore: number | null }} controls
 * @returns {boolean}
 */
export function shouldDeliverByPriority(stats, controls) {
  if (typeof controls.topN === 'number' && stats.rank > controls.topN) return false;
  if (typeof controls.minScore === 'number' && stats.score < controls.minScore) return false;
  return true;
}
