import fs from 'node:fs';
import chokidar from 'chokidar';
import path from 'node:path';
import crypto from 'node:crypto';
import { ALLOWED_EXT } from './contextBuilder.js';
import { runPipeline } from './orchestratorAdapter.js';
import { discoverProjectFiles } from './fileDiscovery.js';
import { scorePathPriority } from './promptPriority.js';
import { generateMasterPrompts, resolveMasterPromptCount } from './masterPromptGenerator.js';
import { writeMasterPrompts } from './cursorDelivery.js';

/** @type {string} Root directory to watch (change here or assign from env in one place). */
const PROJECT_PATH = process.cwd();

const DEBOUNCE_MS = 200; // Used for changes strategy
const IGNORE_DIR_PATTERN = /(node_modules|\.git)/;
const args = process.argv.slice(2);
const WATCHER_STATE_FILE = path.resolve(process.cwd(), '.cache', 'watcher-state.json');
const STALE_STATE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h

function getArgValue(prefix) {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasArg(flag) {
  return args.includes(flag);
}

function toPositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toOptionalPositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseCsvList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeChoice(value, allowed, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function toWildcardRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const normalized = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${normalized}$`, 'i');
}

function createPathMatcher(patterns) {
  const regexes = patterns.map(toWildcardRegex);
  return (filePath) => {
    if (regexes.length === 0) return true;
    const normalized = filePath.replace(/\\/g, '/');
    return regexes.some((regex) => regex.test(normalized));
  };
}

function ensureWatcherStateDir() {
  fs.mkdirSync(path.dirname(WATCHER_STATE_FILE), { recursive: true });
}

function readWatcherState() {
  try {
    if (!fs.existsSync(WATCHER_STATE_FILE)) return null;
    const raw = fs.readFileSync(WATCHER_STATE_FILE, 'utf-8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeWatcherState(value) {
  try {
    ensureWatcherStateDir();
    fs.writeFileSync(WATCHER_STATE_FILE, JSON.stringify(value, null, 2), 'utf-8');
  } catch (err) {
    console.warn(
      '[watcher] Failed to persist watcher state:',
      err instanceof Error ? err.message : err
    );
  }
}

function clearWatcherState() {
  try {
    if (fs.existsSync(WATCHER_STATE_FILE)) {
      fs.rmSync(WATCHER_STATE_FILE, { force: true });
    }
  } catch (err) {
    console.warn(
      '[watcher] Failed to clear watcher state:',
      err instanceof Error ? err.message : err
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatRunTimestamp(date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}-${ms}`;
}

const MODE = (getArgValue('--mode=') ?? 'clipboard').toLowerCase();
const EFFECTIVE_MODE = ['clipboard', 'cursorrules', 'dual'].includes(MODE)
  ? MODE
  : 'clipboard';
const WATCH_STRATEGY = (
  getArgValue('--strategy=') ??
  process.env.WATCH_STRATEGY ??
  'changes'
).toLowerCase();
const EFFECTIVE_STRATEGY = WATCH_STRATEGY === 'fullscan' ? 'fullscan' : 'changes';
const SCAN_INTERVAL_MS = toPositiveInt(
  getArgValue('--scan-interval-ms=') ?? process.env.SCAN_INTERVAL_MS,
  300000
);
const MAX_FILES_PER_RUN = toOptionalPositiveInt(
  getArgValue('--max-files=') ?? process.env.MAX_FILES_PER_RUN
);
const FULLSCAN_STAGGER_MS = toPositiveInt(
  getArgValue('--stagger-ms=') ?? process.env.FULLSCAN_STAGGER_MS,
  0
);
const PRIORITY_TOP_N = toOptionalPositiveInt(
  getArgValue('--priority-top-n=') ?? process.env.PRIORITY_TOP_N
);
const PRIORITY_MIN_SCORE = toOptionalPositiveInt(
  getArgValue('--priority-min-score=') ?? process.env.PRIORITY_MIN_SCORE
);
const FULLSCAN_CONCURRENCY = toPositiveInt(
  getArgValue('--fullscan-concurrency=') ?? process.env.FULLSCAN_CONCURRENCY,
  1
);
const FULLSCAN_RESUME = toBoolean(
  getArgValue('--fullscan-resume=') ?? process.env.FULLSCAN_RESUME,
  true
);
const MAX_QUEUE_SIZE = toOptionalPositiveInt(
  getArgValue('--max-queue-size=') ?? process.env.MAX_QUEUE_SIZE
);
const WATCH_BATCH_MAX = toPositiveInt(
  getArgValue('--watch-batch-max=') ?? process.env.WATCH_BATCH_MAX,
  100
);
const WATCH_OVERFLOW_POLICY = normalizeChoice(
  getArgValue('--watch-overflow-policy=') ?? process.env.WATCH_OVERFLOW_POLICY,
  ['drop_oldest', 'drop_newest', 'coalesce_by_path'],
  'drop_oldest'
);
const WATCH_DEBOUNCE_MS_MIN = toPositiveInt(
  getArgValue('--watch-debounce-ms-min=') ?? process.env.WATCH_DEBOUNCE_MS_MIN,
  DEBOUNCE_MS
);
const WATCH_DEBOUNCE_MS_MAX = toPositiveInt(
  getArgValue('--watch-debounce-ms-max=') ?? process.env.WATCH_DEBOUNCE_MS_MAX,
  Math.max(DEBOUNCE_MS, 1000)
);
const SCAN_JITTER_MS = toPositiveInt(
  getArgValue('--scan-jitter-ms=') ?? process.env.SCAN_JITTER_MS,
  0
);
const WATCH_PIPELINE_RETRIES = toPositiveInt(
  getArgValue('--watch-pipeline-retries=') ?? process.env.WATCH_PIPELINE_RETRIES,
  1
);
const WATCH_PIPELINE_RETRY_MS = toPositiveInt(
  getArgValue('--watch-pipeline-retry-ms=') ?? process.env.WATCH_PIPELINE_RETRY_MS,
  250
);
const WATCH_DRY_RUN_EXPLAIN = toBoolean(
  getArgValue('--watch-dry-run-explain=') ?? process.env.WATCH_DRY_RUN_EXPLAIN,
  false
);
const FULLSCAN_RESUME_POLICY = normalizeChoice(
  getArgValue('--fullscan-resume-policy=') ?? process.env.FULLSCAN_RESUME_POLICY,
  ['always', 'safe-only', 'never'],
  'always'
);
const FULLSCAN_STALE_STATE_MS = toPositiveInt(
  getArgValue('--fullscan-stale-state-ms=') ?? process.env.FULLSCAN_STALE_STATE_MS,
  STALE_STATE_MAX_AGE_MS
);
const FULLSCAN_PRIORITY_WINDOW = toOptionalPositiveInt(
  getArgValue('--fullscan-priority-window=') ?? process.env.FULLSCAN_PRIORITY_WINDOW
);
const FULLSCAN_INCLUDE = parseCsvList(
  getArgValue('--include=') ?? process.env.FULLSCAN_INCLUDE ?? ''
);
const FULLSCAN_EXCLUDE = parseCsvList(
  getArgValue('--exclude=') ?? process.env.FULLSCAN_EXCLUDE ?? ''
);
const PROMPT_TRACK = (
  getArgValue('--prompt-track=') ??
  process.env.PROMPT_TRACK ??
  'safe'
).toLowerCase();
const EFFECTIVE_PROMPT_TRACK =
  PROMPT_TRACK === 'feature' || PROMPT_TRACK === 'both' ? PROMPT_TRACK : 'safe';
const MASTER_PROMPTS_ENABLED = toBoolean(
  getArgValue('--master-prompts=') ?? process.env.MASTER_PROMPTS_ENABLED,
  true
);
const MASTER_PROMPTS_COUNT = resolveMasterPromptCount(
  toPositiveInt(
    getArgValue('--master-prompts-count=') ?? process.env.MASTER_PROMPTS_COUNT,
    5
  )
);
const WATCH_DRY_RUN =
  hasArg('--dry-run') ||
  toBoolean(getArgValue('--dry-run=') ?? process.env.WATCH_DRY_RUN, false);
const FULLSCAN_DIR = path.resolve(process.cwd(), 'Prompts (Fullscan)');
const includeMatcher = createPathMatcher(FULLSCAN_INCLUDE);
const excludeMatcher = createPathMatcher(FULLSCAN_EXCLUDE);

function shouldKeepInScope(filePath) {
  const relative = path.relative(PROJECT_PATH, filePath).replace(/\\/g, '/');
  if (FULLSCAN_INCLUDE.length > 0 && !includeMatcher(relative)) {
    scopeStats.excluded += 1;
    return false;
  }
  if (FULLSCAN_EXCLUDE.length > 0 && excludeMatcher(relative)) {
    scopeStats.excluded += 1;
    return false;
  }
  scopeStats.included += 1;
  return true;
}

function isTransientPipelineError(message) {
  const normalized = String(message ?? '').toLowerCase();
  return (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('rate limit') ||
    normalized.includes('econnreset') ||
    normalized.includes('temporarily')
  );
}

function shouldAttemptResume(previousState) {
  if (!FULLSCAN_RESUME) return false;
  if (FULLSCAN_RESUME_POLICY === 'never') return false;
  const resumableRun = previousState?.activeRun;
  if (!resumableRun || resumableRun.status !== 'running') return false;
  if (FULLSCAN_RESUME_POLICY === 'safe-only' && EFFECTIVE_PROMPT_TRACK === 'feature') {
    return false;
  }
  const recencySource = resumableRun.updatedAt ?? resumableRun.startedAt;
  const recencyMs = recencySource ? Date.parse(recencySource) : Number.NaN;
  if (!Number.isFinite(recencyMs)) return false;
  const stale = Date.now() - recencyMs > FULLSCAN_STALE_STATE_MS;
  if (stale) {
    console.warn('[watcher] Existing watcher checkpoint is stale; starting a fresh fullscan.');
    clearWatcherState();
    return false;
  }
  return true;
}

function getMasterTracks(promptTrack) {
  if (promptTrack === 'both') return ['safe', 'feature'];
  if (promptTrack === 'feature') return ['feature'];
  return ['safe'];
}

/** @type {Set<string>} */
const pendingPaths = new Set();
/** @type {string[]} */
const pendingOrder = [];
/** @type {ReturnType<typeof setTimeout> | null} */
let debounceTimer = null;
let fullScanTimer = null;
let fullScanInProgress = false;
let shutdownRequested = false;
let interruptRequested = false;
let observedQueueMaxDepth = 0;
const queueStats = {
  enqueued: 0,
  dropped: 0,
  coalesced: 0,
  processedBatches: 0,
};
const retryStats = {
  attemptedRetries: 0,
  recoveredFailures: 0,
};
const scopeStats = {
  preFilterCount: 0,
  included: 0,
  excluded: 0,
};
let checkpointWrites = 0;

/**
 * Chokidar v5 does not expand glob strings; use ignored() to limit to ts, tsx, js, jsx.
 * @param {string} filePath
 * @param {import('node:fs').Stats | undefined} stats
 */
function isIgnoredArtifact(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const base = path.basename(normalized);
  if (base.endsWith('~')) return true;
  // Ignore hidden files/directories to reduce editor/OS noise.
  return segments.some((segment) => segment.startsWith('.'));
}

/**
 * Chokidar v5 does not expand glob strings; use ignored() to limit to ts, tsx, js, jsx.
 * @param {string} filePath
 * @param {import('node:fs').Stats | undefined} stats
 */
function ignored(filePath, stats) {
  if (IGNORE_DIR_PATTERN.test(filePath)) return true;
  if (isIgnoredArtifact(filePath)) return true;
  if (stats?.isDirectory()) return false;
  if (stats === undefined && path.extname(filePath) === '') return false;
  const ext = path.extname(filePath).toLowerCase();
  return !ALLOWED_EXT.has(ext);
}

/**
 * @param {string[]} inputPaths
 * @param {'file-change'|'fullscan-interval'} reason
 * @param {{ fullscanRunId?: string, rankMap?: Record<string, number> }} [deliveryContext]
 * @returns {Promise<Array<any>>}
 */
async function processPaths(inputPaths, reason, deliveryContext = {}, onProgress = null) {
  if (inputPaths.length === 0) return [];
  let paths = inputPaths;

  if (MAX_FILES_PER_RUN !== null && inputPaths.length > MAX_FILES_PER_RUN) {
    if (reason === 'file-change') {
      paths = inputPaths.slice(-MAX_FILES_PER_RUN);
    } else {
      paths = inputPaths.slice(0, MAX_FILES_PER_RUN);
    }
    console.log(
      `[watcher] Limiting run to ${paths.length} file(s); skipped ${inputPaths.length - paths.length}.`
    );
  }

  /** @type {Array<any>} */
  const results = new Array(paths.length);
  const getRank = (filePath) =>
    typeof deliveryContext.rankMap === 'object' &&
    deliveryContext.rankMap !== null &&
    typeof deliveryContext.rankMap[filePath] === 'number'
      ? deliveryContext.rankMap[filePath]
      : null;

  const processSingle = async (filePath, index) => {
    if (interruptRequested && reason === 'fullscan-interval') return;
    try {
      const rank = getRank(filePath);
      let attempt = 0;
      let result = null;
      let lastError = null;
      const maxAttempts = Math.max(1, WATCH_PIPELINE_RETRIES);
      while (attempt < maxAttempts) {
        attempt += 1;
        try {
          result = await runPipeline({
            filePath,
            mode: EFFECTIVE_MODE,
            reason,
            deliveryContext: {
              fullscanRunId: deliveryContext.fullscanRunId,
              priorityRank: rank,
              priorityTopN: PRIORITY_TOP_N,
              priorityMinScore: PRIORITY_MIN_SCORE,
              promptTrack: EFFECTIVE_PROMPT_TRACK,
            },
          });
          if (attempt > 1) {
            retryStats.recoveredFailures += 1;
          }
          break;
        } catch (err) {
          lastError = err;
          const message = err instanceof Error ? err.message : String(err);
          const canRetry = attempt < maxAttempts && isTransientPipelineError(message);
          if (!canRetry) {
            throw err;
          }
          retryStats.attemptedRetries += 1;
          await sleep(WATCH_PIPELINE_RETRY_MS);
        }
      }
      if (!result && lastError) throw lastError;
      results[index] = result;
      if (typeof onProgress === 'function') {
        onProgress(filePath, result);
      }
      if (reason === 'fullscan-interval' && FULLSCAN_STAGGER_MS > 0) {
        await sleep(FULLSCAN_STAGGER_MS);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[watcher] Unexpected error building context for ${filePath}:`, message);
      results[index] = {
        ok: false,
        delivered: false,
        file: path.basename(filePath),
        error: message,
        failureType: isTransientPipelineError(message) ? 'transient' : 'hard',
        priorityRank: getRank(filePath),
      };
      if (typeof onProgress === 'function') {
        onProgress(filePath, results[index]);
      }
    }
  };

  const useConcurrentPool =
    reason === 'fullscan-interval' && FULLSCAN_CONCURRENCY > 1 && !WATCH_DRY_RUN;
  if (!useConcurrentPool) {
    for (const [index, filePath] of paths.entries()) {
      await processSingle(filePath, index);
    }
    return results.filter(Boolean);
  }

  let nextIndex = 0;
  const workerCount = Math.min(FULLSCAN_CONCURRENCY, paths.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= paths.length) return;
      if (interruptRequested) return;
      await processSingle(paths[current], current);
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

async function flushBatch() {
  debounceTimer = null;
  if (pendingOrder.length === 0) return;
  const paths = pendingOrder.splice(0, WATCH_BATCH_MAX);
  for (const item of paths) {
    if (!pendingOrder.includes(item)) {
      pendingPaths.delete(item);
    }
  }
  queueStats.processedBatches += 1;
  await processPaths(paths, 'file-change');
  if (pendingOrder.length > 0 && !shutdownRequested) {
    debounceTimer = setTimeout(() => {
      void flushBatch();
    }, WATCH_DEBOUNCE_MS_MIN);
  }
}

async function runFullScan() {
  if (fullScanInProgress) {
    console.log('[watcher] Skipping fullscan run because previous run is still active.');
    return;
  }

  fullScanInProgress = true;
  const startedAt = Date.now();
  const fullscanRunId = `${formatRunTimestamp(new Date())}__${crypto
    .randomUUID()
    .slice(0, 8)}`;
  try {
    scopeStats.preFilterCount = 0;
    scopeStats.included = 0;
    scopeStats.excluded = 0;
    checkpointWrites = 0;
    const previousState = FULLSCAN_RESUME ? readWatcherState() : null;
    const resumableRun = previousState?.activeRun;
    const canResume =
      shouldAttemptResume(previousState) &&
      resumableRun &&
      resumableRun.status === 'running' &&
      resumableRun.projectPath === PROJECT_PATH &&
      Array.isArray(resumableRun.remainingPaths) &&
      resumableRun.remainingPaths.length > 0;
    const effectiveRunId = canResume ? resumableRun.runId : fullscanRunId;

    let discovered = [];
    let rankedPaths = [];
    /** @type {Record<string, number>} */
    let rankMap = {};
    let resumeUsed = false;
    let resumeRemainingAtStart = 0;

    if (canResume) {
      resumeUsed = true;
      scopeStats.preFilterCount = resumableRun.remainingPaths.length;
      rankedPaths = resumableRun.remainingPaths.filter(shouldKeepInScope);
      discovered = Array.isArray(resumableRun.discoveredPaths)
        ? resumableRun.discoveredPaths.filter(shouldKeepInScope)
        : [...rankedPaths];
      rankMap =
        resumableRun.rankMap && typeof resumableRun.rankMap === 'object'
          ? resumableRun.rankMap
          : Object.fromEntries(rankedPaths.map((item, index) => [item, index + 1]));
      resumeRemainingAtStart = rankedPaths.length;
      console.log(
        `[watcher] Resuming fullscan run ${effectiveRunId} with ${rankedPaths.length} remaining file(s).`
      );
    } else {
      discovered = await discoverProjectFiles(PROJECT_PATH, {
        allowedExt: ALLOWED_EXT,
      });
      scopeStats.preFilterCount = discovered.length;
      discovered = discovered.filter(shouldKeepInScope);
      const ranked = discovered
        .map((filePath) => ({
          filePath,
          preliminary: scorePathPriority(filePath).score,
        }))
        .sort((a, b) => {
          if (a.preliminary !== b.preliminary) return b.preliminary - a.preliminary;
          return a.filePath.localeCompare(b.filePath);
        });
      rankedPaths = ranked.map((item) => item.filePath);
      rankMap = Object.fromEntries(
        rankedPaths.map((filePath, index) => [filePath, index + 1])
      );
      if (FULLSCAN_PRIORITY_WINDOW !== null && rankedPaths.length > FULLSCAN_PRIORITY_WINDOW) {
        rankedPaths = [
          ...rankedPaths.slice(0, FULLSCAN_PRIORITY_WINDOW),
          ...rankedPaths.slice(FULLSCAN_PRIORITY_WINDOW),
        ];
      }
    }

    console.log(
      `[watcher] Starting fullscan run ${effectiveRunId} for ${discovered.length} eligible file(s).`
    );
    if (MAX_FILES_PER_RUN === null) {
      console.log(
        `[watcher] Fullscan will process all eligible files (${rankedPaths.length}) with concurrency=${FULLSCAN_CONCURRENCY}.`
      );
    }
    writeWatcherState({
      activeRun: {
        runId: effectiveRunId,
        status: 'running',
        strategy: EFFECTIVE_STRATEGY,
        projectPath: PROJECT_PATH,
        startedAt: new Date().toISOString(),
        discoveredPaths: discovered,
        rankMap,
        remainingPaths: rankedPaths,
        processedPaths: [],
      },
    });
    checkpointWrites += 1;

    const remainingPaths = new Set(rankedPaths);
    const processedPaths = [];
    const failedPaths = [];
    const persistRunProgress = () => {
      writeWatcherState({
        activeRun: {
          runId: effectiveRunId,
          status: 'running',
          strategy: EFFECTIVE_STRATEGY,
          projectPath: PROJECT_PATH,
          startedAt: new Date(startedAt).toISOString(),
          updatedAt: new Date().toISOString(),
          discoveredPaths: discovered,
          rankMap,
          remainingPaths: Array.from(remainingPaths),
          processedPaths,
          failedPaths,
        },
      });
      checkpointWrites += 1;
    };

    let runResults = [];
    if (!WATCH_DRY_RUN) {
      runResults = await processPaths(rankedPaths, 'fullscan-interval', {
        fullscanRunId: effectiveRunId,
        rankMap,
      }, (filePath, result) => {
        remainingPaths.delete(filePath);
        processedPaths.push(filePath);
        if (result?.ok === false) {
          failedPaths.push(filePath);
        }
        persistRunProgress();
      });
    }
    if (WATCH_DRY_RUN && WATCH_DRY_RUN_EXPLAIN) {
      console.log(
        `[watcher] Dry-run explain: preFilter=${scopeStats.preFilterCount}, included=${scopeStats.included}, excluded=${scopeStats.excluded}, selected=${rankedPaths.length}`
      );
    }
    const runDir = path.join(FULLSCAN_DIR, effectiveRunId);
    fs.mkdirSync(runDir, { recursive: true });
    const sortedResults = [...runResults].sort(
      (a, b) => (b.priorityScore ?? -1) - (a.priorityScore ?? -1)
    );
    const trackCounts = runResults.reduce(
      (acc, item) => {
        const tracks = Array.isArray(item?.deliveredTracks) ? item.deliveredTracks : [];
        for (const track of tracks) {
          if (track === 'safe') acc.safe += 1;
          if (track === 'feature') acc.feature += 1;
        }
        return acc;
      },
      { safe: 0, feature: 0 }
    );
    const processedFilesPerMinute =
      runResults.length === 0
        ? 0
        : Number(((runResults.length / Math.max(1, Date.now() - startedAt)) * 60000).toFixed(2));

    const summary = {
      fullscanRunId: effectiveRunId,
      createdAt: new Date().toISOString(),
      strategy: EFFECTIVE_STRATEGY,
      mode: EFFECTIVE_MODE,
      status: interruptRequested ? 'interrupted' : WATCH_DRY_RUN ? 'dry-run' : 'completed',
      controls: {
        priorityTopN: PRIORITY_TOP_N,
        priorityMinScore: PRIORITY_MIN_SCORE,
        maxFilesPerRun: MAX_FILES_PER_RUN,
        staggerMs: FULLSCAN_STAGGER_MS,
        fullscanConcurrency: FULLSCAN_CONCURRENCY,
        fullscanResume: FULLSCAN_RESUME,
        maxQueueSize: MAX_QUEUE_SIZE,
        scanJitterMs: SCAN_JITTER_MS,
        watchBatchMax: WATCH_BATCH_MAX,
        watchOverflowPolicy: WATCH_OVERFLOW_POLICY,
        watchDebounceMsMin: WATCH_DEBOUNCE_MS_MIN,
        watchDebounceMsMax: WATCH_DEBOUNCE_MS_MAX,
        watchPipelineRetries: WATCH_PIPELINE_RETRIES,
        watchPipelineRetryMs: WATCH_PIPELINE_RETRY_MS,
        fullscanResumePolicy: FULLSCAN_RESUME_POLICY,
        fullscanPriorityWindow: FULLSCAN_PRIORITY_WINDOW,
        includePatterns: FULLSCAN_INCLUDE,
        excludePatterns: FULLSCAN_EXCLUDE,
        dryRun: WATCH_DRY_RUN,
        promptTrack: EFFECTIVE_PROMPT_TRACK,
        masterPromptsEnabled: MASTER_PROMPTS_ENABLED,
        masterPromptsCount: MASTER_PROMPTS_COUNT,
      },
      counts: {
        discovered: discovered.length,
        processed: runResults.length,
        delivered: runResults.filter((item) => item?.delivered === true).length,
        skipped: runResults.filter((item) => item?.delivered === false).length,
        failed: runResults.filter((item) => item?.ok === false).length,
        deliveredSafePrompts: trackCounts.safe,
        deliveredFeaturePrompts: trackCounts.feature,
      },
      telemetry: {
        throughput: {
          filesPerMinute: processedFilesPerMinute,
        },
        queue: {
          maxDepth: observedQueueMaxDepth,
          enqueued: queueStats.enqueued,
          dropped: queueStats.dropped,
          coalesced: queueStats.coalesced,
          processedBatches: queueStats.processedBatches,
        },
        workers: {
          concurrency: FULLSCAN_CONCURRENCY,
        },
        retries: {
          attempted: retryStats.attemptedRetries,
          recovered: retryStats.recoveredFailures,
        },
        scope: {
          preFilterCount: scopeStats.preFilterCount,
          included: scopeStats.included,
          excluded: scopeStats.excluded,
        },
        resume: {
          enabled: FULLSCAN_RESUME,
          used: resumeUsed,
          remainingAtStart: resumeRemainingAtStart,
          policy: FULLSCAN_RESUME_POLICY,
          checkpointWrites,
        },
      },
      prompts: sortedResults.map((item) => ({
        file: item.file ?? null,
        runId: item.runId ?? null,
        ok: item.ok ?? false,
        delivered: item.delivered ?? false,
        promptTrack: item.promptTrack ?? 'safe',
        deliveredTracks: Array.isArray(item.deliveredTracks) ? item.deliveredTracks : [],
        priorityScore: item.priorityScore ?? null,
        priorityReason: item.priorityReason ?? null,
        priorityRank: item.priorityRank ?? null,
        durationMs: item.durationMs ?? null,
      })),
      masterPrompts: {
        generated: false,
        tracks: {},
      },
    };

    if (MASTER_PROMPTS_ENABLED && !WATCH_DRY_RUN && !interruptRequested) {
      try {
        const tracks = getMasterTracks(EFFECTIVE_PROMPT_TRACK);
        const trackResults = {};
        for (const track of tracks) {
          const master = await generateMasterPrompts({
            fullscanRunId: effectiveRunId,
            summary,
            track,
            maxCount: MASTER_PROMPTS_COUNT,
          });
          const masterPath = writeMasterPrompts(
            effectiveRunId,
            master.content,
            {
              source: master.source,
              count: master.count,
              selectedFiles: master.selectedFiles,
            },
            { track }
          );
          trackResults[track] = {
            generated: true,
            count: master.count,
            source: master.source,
            path: path.relative(runDir, masterPath).replace(/\\/g, '/'),
            selectedFiles: master.selectedFiles,
          };
        }
        summary.masterPrompts = {
          generated: true,
          tracks: trackResults,
        };
      } catch (err) {
        summary.masterPrompts = {
          generated: false,
          tracks: {},
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    writeWatcherState({
      activeRun: {
        runId: effectiveRunId,
        status: interruptRequested ? 'interrupted' : 'completed',
        strategy: EFFECTIVE_STRATEGY,
        projectPath: PROJECT_PATH,
        updatedAt: new Date().toISOString(),
        remainingPaths: Array.from(remainingPaths),
        processedPaths,
        failedPaths,
        discoveredPaths: discovered,
      },
    });
    checkpointWrites += 1;
    if (!interruptRequested) {
      clearWatcherState();
    }

    fs.writeFileSync(
      path.join(runDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
      'utf-8'
    );
    console.log(
      `[watcher] Fullscan run ${effectiveRunId} completed in ${Date.now() - startedAt}ms.`
    );
    console.log(
      `[watcher] Summary queue(enqueued=${queueStats.enqueued}, dropped=${queueStats.dropped}, coalesced=${queueStats.coalesced}) retries(attempted=${retryStats.attemptedRetries}, recovered=${retryStats.recoveredFailures}) scope(included=${scopeStats.included}, excluded=${scopeStats.excluded})`
    );
  } catch (err) {
    console.error(
      '[watcher] Fullscan run failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    fullScanInProgress = false;
    const shouldExit = shutdownRequested;
    interruptRequested = false;
    if (shouldExit) {
      process.exit(0);
    }
  }
}

function scheduleBatch(filePath) {
  if (pendingPaths.has(filePath)) {
    queueStats.coalesced += 1;
    if (WATCH_OVERFLOW_POLICY !== 'coalesce_by_path') {
      const existingIndex = pendingOrder.indexOf(filePath);
      if (existingIndex >= 0) pendingOrder.splice(existingIndex, 1);
    }
  } else {
    if (MAX_QUEUE_SIZE !== null && pendingOrder.length >= MAX_QUEUE_SIZE) {
      if (WATCH_OVERFLOW_POLICY === 'drop_newest') {
        queueStats.dropped += 1;
        return;
      }
      const droppedPath = pendingOrder.shift();
      if (droppedPath) {
        pendingPaths.delete(droppedPath);
      }
      queueStats.dropped += 1;
      console.warn('[watcher] Pending queue full; dropping oldest queued change event.');
    }
    pendingPaths.add(filePath);
    queueStats.enqueued += 1;
  }
  pendingOrder.push(filePath);
  observedQueueMaxDepth = Math.max(observedQueueMaxDepth, pendingOrder.length);
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  const range = Math.max(0, WATCH_DEBOUNCE_MS_MAX - WATCH_DEBOUNCE_MS_MIN);
  const ratio =
    MAX_QUEUE_SIZE && MAX_QUEUE_SIZE > 0
      ? Math.min(1, pendingOrder.length / MAX_QUEUE_SIZE)
      : Math.min(1, pendingOrder.length / 200);
  const adaptiveDebounceMs = WATCH_DEBOUNCE_MS_MIN + Math.floor(range * ratio);
  debounceTimer = setTimeout(() => {
    void flushBatch();
  }, adaptiveDebounceMs);
}

function scheduleNextFullScan() {
  if (shutdownRequested) return;
  const jitter = SCAN_JITTER_MS > 0 ? Math.floor(Math.random() * (SCAN_JITTER_MS + 1)) : 0;
  fullScanTimer = setTimeout(async () => {
    await runFullScan();
    scheduleNextFullScan();
  }, SCAN_INTERVAL_MS + jitter);
}

if (EFFECTIVE_STRATEGY === 'fullscan') {
  console.log(
    `🔍 watching: ${PROJECT_PATH} (strategy=fullscan, mode=${EFFECTIVE_MODE}, promptTrack=${EFFECTIVE_PROMPT_TRACK}, intervalMs=${SCAN_INTERVAL_MS}, concurrency=${FULLSCAN_CONCURRENCY}, dryRun=${WATCH_DRY_RUN}, retries=${WATCH_PIPELINE_RETRIES}, masterPrompts=${MASTER_PROMPTS_ENABLED ? `on/${MASTER_PROMPTS_COUNT}` : 'off'})`
  );
  if (FULLSCAN_INCLUDE.length > 0 || FULLSCAN_EXCLUDE.length > 0) {
    console.log(
      `[watcher] Fullscan scope filters active include=[${FULLSCAN_INCLUDE.join(', ')}] exclude=[${FULLSCAN_EXCLUDE.join(', ')}]`
    );
  }
  void runFullScan();
  scheduleNextFullScan();
} else {
  console.log(
    `🔍 watching: ${PROJECT_PATH} (strategy=changes, mode=${EFFECTIVE_MODE}, promptTrack=${EFFECTIVE_PROMPT_TRACK}, debounce=${WATCH_DEBOUNCE_MS_MIN}-${WATCH_DEBOUNCE_MS_MAX}ms, overflowPolicy=${WATCH_OVERFLOW_POLICY}, batchMax=${WATCH_BATCH_MAX})`
  );

  const watcher = chokidar.watch(PROJECT_PATH, {
    ignored,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200 },
    depth: 10,
  });

  watcher.on('add', (filePath) => {
    try {
      scheduleBatch(filePath);
    } catch (err) {
      console.error(
        '[watcher] Error scheduling batch (add):',
        err instanceof Error ? err.message : err
      );
    }
  });

  watcher.on('change', (filePath) => {
    try {
      scheduleBatch(filePath);
    } catch (err) {
      console.error(
        '[watcher] Error scheduling batch (change):',
        err instanceof Error ? err.message : err
      );
    }
  });

  watcher.on('error', (err) => {
    console.error(
      '[watcher] Watcher error:',
      err instanceof Error ? err.message : err
    );
  });
}

process.on('SIGINT', () => {
  shutdownRequested = true;
  if (fullScanTimer) clearTimeout(fullScanTimer);
  if (fullScanInProgress) {
    interruptRequested = true;
    console.log('[watcher] Received SIGINT, waiting for active fullscan to finish gracefully...');
    return;
  }
  process.exit(0);
});
