import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const RULES_DIR = path.join(ROOT, '.cursor', 'rules');
const PROMPTS_DIR = path.join(ROOT, 'prompts');
const FULLSCAN_DIR = path.join(ROOT, 'Prompts (Fullscan)');
const WATCHER_STATE_PATH = path.join(ROOT, '.cache', 'watcher-state.json');
const API_VERSION = '2.0.0';
const RESPONSE_SCHEMA_VERSION = 1;
const CACHE_TTL_MS = 1500;
const MAX_RAW_CHARS = 20000;
const SERVER_STARTED_AT = Date.now();
const diagnostics = {
  fileReads: 0,
  jsonReads: 0,
  parseFailures: 0,
  cacheHits: 0,
  cacheMisses: 0,
  requests: 0,
};
const responseCache = new Map();

function getSharedToken() {
  return process.env.MCP_SHARED_TOKEN ?? '';
}

function strictAuthEnabled() {
  return (process.env.MCP_STRICT_AUTH ?? 'false').toLowerCase() === 'true';
}

function safeRead(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    diagnostics.fileReads += 1;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    diagnostics.parseFailures += 1;
    return fallback;
  }
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    diagnostics.jsonReads += 1;
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    diagnostics.parseFailures += 1;
    return fallback;
  }
}

function toPositiveInt(value, fallback, max = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function toOffset(value, fallback = 0, max = 10000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function normalizeTrack(value) {
  if (value === 'safe' || value === 'feature' || value === 'both') return value;
  return null;
}

function normalizeOrder(value) {
  if (value === 'asc' || value === 'desc') return value;
  return 'desc';
}

function normalizeSortBy(value, allowed, fallback) {
  if (typeof value === 'string' && allowed.includes(value)) return value;
  return fallback;
}

function findLatestRunDir() {
  try {
    if (!fs.existsSync(FULLSCAN_DIR)) return null;
    const entries = fs
      .readdirSync(FULLSCAN_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
    if (entries.length === 0) return null;
    return entries[0];
  } catch {
    return null;
  }
}

function parseRecentChangesMdc(raw) {
  const lines = raw.split('\n');
  return lines
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s/.test(line))
    .map((line) => line.replace(/^\d+\.\s*/, ''));
}

function truncateRaw(raw) {
  if (typeof raw !== 'string') {
    return { text: '', truncated: false };
  }
  if (raw.length <= MAX_RAW_CHARS) {
    return { text: raw, truncated: false };
  }
  return { text: `${raw.slice(0, MAX_RAW_CHARS)}\n\n... [truncated]`, truncated: true };
}

function cacheKeyFor(tool, args) {
  return `${tool}:${JSON.stringify(args ?? {})}`;
}

function getCachedOrBuild(tool, args, builder) {
  const key = cacheKeyFor(tool, args);
  const now = Date.now();
  const cached = responseCache.get(key);
  if (cached && cached.expiresAt > now) {
    diagnostics.cacheHits += 1;
    return cached.value;
  }
  diagnostics.cacheMisses += 1;
  const value = builder();
  responseCache.set(key, {
    value,
    expiresAt: now + CACHE_TTL_MS,
  });
  return value;
}

function buildEnvelope(tool, data, meta = {}, warnings = []) {
  return {
    ok: true,
    apiVersion: API_VERSION,
    schemaVersion: RESPONSE_SCHEMA_VERSION,
    tool,
    generatedAt: new Date().toISOString(),
    data,
    meta,
    warnings,
  };
}

export function buildProjectContext() {
  const projectRule = safeRead(
    path.join(RULES_DIR, 'project-context.mdc'),
    'project-context.mdc not found.'
  );
  const promptMeta = safeRead(
    path.join(PROMPTS_DIR, 'latest.meta.json'),
    '{"message":"latest.meta.json not found."}'
  );

  return {
    projectRule,
    latestPromptMeta: promptMeta,
    timestamp: new Date().toISOString(),
  };
}

export function buildProjectProfile() {
  const profile = safeReadJson(path.join(ROOT, 'project-profile.json'), {});
  return {
    scopeMode: profile.scopeMode ?? 'everything',
    projectName: profile.projectName ?? 'Unnamed project',
    projectSummary: profile.projectSummary ?? 'No summary set.',
    riskTolerance: profile?.deliveryPreferences?.riskTolerance ?? 'balanced',
    changeStyle: profile?.deliveryPreferences?.changeStyle ?? 'incremental',
    coreUseCases: Array.isArray(profile?.coreUseCases) ? profile.coreUseCases : [],
    timestamp: new Date().toISOString(),
  };
}

export function buildCurrentTask() {
  const currentTaskRule = safeRead(
    path.join(RULES_DIR, 'current-task.mdc'),
    'current-task.mdc not found.'
  );
  return {
    currentTaskRule,
    timestamp: new Date().toISOString(),
  };
}

export function buildBrowserResearch() {
  const browserContextRule = safeRead(
    path.join(RULES_DIR, 'browser-context.mdc'),
    'browser-context.mdc not found.'
  );
  return {
    browserContextRule,
    timestamp: new Date().toISOString(),
  };
}

export function buildPromptStatus() {
  const safeMeta = safeReadJson(path.join(PROMPTS_DIR, 'latest.meta.json'), null);
  const featureMeta = safeReadJson(path.join(PROMPTS_DIR, 'features', 'latest.meta.json'), null);
  return {
    safe: safeMeta,
    feature: featureMeta,
    timestamp: new Date().toISOString(),
  };
}

export function buildLatestFullscan(options = {}) {
  const latestRunId = findLatestRunDir();
  if (!latestRunId) {
    return {
      latestRunId: null,
      summary: null,
      topPrompts: [],
      timestamp: new Date().toISOString(),
    };
  }

  const runDir = path.join(FULLSCAN_DIR, latestRunId);
  const summary = safeReadJson(path.join(runDir, 'summary.json'), null);
  const limit = toPositiveInt(options.limit ?? 5, 5, 20);
  const topPrompts = Array.isArray(summary?.prompts) ? summary.prompts.slice(0, limit) : [];
  return {
    latestRunId,
    summary,
    topPrompts,
    timestamp: new Date().toISOString(),
  };
}

export function buildMasterPrompts(options = {}) {
  const runId =
    typeof options.runId === 'string' && options.runId.trim()
      ? options.runId.trim()
      : findLatestRunDir();
  const track = normalizeTrack(options.track) ?? 'both';
  const includeRaw = options.includeRaw !== false;
  if (!runId) {
    return { runId: null, track, prompts: {}, timestamp: new Date().toISOString() };
  }

  const runDir = path.join(FULLSCAN_DIR, runId, 'master');
  const result = {};
  const tracks = track === 'both' ? ['safe', 'feature'] : [track];
  for (const item of tracks) {
    const base = `${item}-master-prompts`;
    const contentPath = path.join(runDir, `${base}.md`);
    const metaPath = path.join(runDir, `${base}.meta.json`);
    const contentRaw = includeRaw ? safeRead(contentPath, '') : '';
    const { text, truncated } = truncateRaw(contentRaw);
    result[item] = {
      meta: safeReadJson(metaPath, null),
      ...(includeRaw ? { content: text } : {}),
      ...(includeRaw ? { truncated } : {}),
      exists: fs.existsSync(contentPath) || fs.existsSync(metaPath),
    };
  }

  return {
    runId,
    track,
    prompts: result,
    timestamp: new Date().toISOString(),
  };
}

export function buildRecentChanges(options = {}) {
  const raw = safeRead(path.join(RULES_DIR, 'recent-changes.mdc'), 'recent-changes.mdc not found.');
  const entries = parseRecentChangesMdc(raw);
  const limit = toPositiveInt(options.limit ?? 10, 10, 50);
  return {
    entries: entries.slice(0, limit),
    count: entries.length,
    ...(options.includeRaw ? { raw } : {}),
    timestamp: new Date().toISOString(),
  };
}

export function buildWatcherState() {
  const state = safeReadJson(WATCHER_STATE_PATH, null);
  const activeRun = state?.activeRun ?? null;
  return {
    watcherStatePath: WATCHER_STATE_PATH,
    hasState: Boolean(activeRun),
    activeRun,
    timestamp: new Date().toISOString(),
  };
}

export function buildFullscanRun(options = {}) {
  const runId =
    typeof options.runId === 'string' && options.runId.trim()
      ? options.runId.trim()
      : findLatestRunDir();
  if (!runId) {
    return {
      runId: null,
      summary: null,
      prompts: [],
      timestamp: new Date().toISOString(),
    };
  }
  const runDir = path.join(FULLSCAN_DIR, runId);
  const summary = safeReadJson(path.join(runDir, 'summary.json'), null);
  const allPrompts = Array.isArray(summary?.prompts) ? summary.prompts : [];
  const track = normalizeTrack(options.track) ?? 'both';
  const filteredByTrack =
    track === 'both'
      ? allPrompts
      : allPrompts.filter((item) =>
          Array.isArray(item?.deliveredTracks)
            ? item.deliveredTracks.includes(track)
            : item?.promptTrack === track
        );
  const sortBy = normalizeSortBy(options.sortBy, ['priorityScore', 'durationMs', 'file'], 'priorityScore');
  const order = normalizeOrder(options.order);
  const sorted = [...filteredByTrack].sort((a, b) => {
    const aValue = a?.[sortBy] ?? (sortBy === 'file' ? '' : -1);
    const bValue = b?.[sortBy] ?? (sortBy === 'file' ? '' : -1);
    if (typeof aValue === 'string' || typeof bValue === 'string') {
      const cmp = String(aValue).localeCompare(String(bValue));
      return order === 'asc' ? cmp : -cmp;
    }
    const cmp = Number(aValue) - Number(bValue);
    return order === 'asc' ? cmp : -cmp;
  });
  const offset = toOffset(options.offset, 0);
  const limit = toPositiveInt(options.limit ?? 10, 10, 100);
  return {
    runId,
    track,
    sortBy,
    order,
    total: sorted.length,
    summary,
    prompts: sorted.slice(offset, offset + limit),
    timestamp: new Date().toISOString(),
  };
}

export function buildPromptHistory(options = {}) {
  const track = normalizeTrack(options.track) ?? 'both';
  const folders =
    track === 'both'
      ? [
          { track: 'safe', dir: path.join(PROMPTS_DIR, 'history') },
          { track: 'feature', dir: path.join(PROMPTS_DIR, 'features', 'history') },
        ]
      : [
          {
            track,
            dir:
              track === 'feature'
                ? path.join(PROMPTS_DIR, 'features', 'history')
                : path.join(PROMPTS_DIR, 'history'),
          },
        ];

  const entries = [];
  for (const item of folders) {
    try {
      if (!fs.existsSync(item.dir)) continue;
      const files = fs
        .readdirSync(item.dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name);
      for (const name of files) {
        const fullPath = path.join(item.dir, name);
        const stat = fs.statSync(fullPath);
        entries.push({
          track: item.track,
          file: name,
          path: fullPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      }
    } catch {
      diagnostics.parseFailures += 1;
    }
  }

  const sortBy = normalizeSortBy(options.sortBy, ['mtimeMs', 'size', 'file'], 'mtimeMs');
  const order = normalizeOrder(options.order);
  const sorted = [...entries].sort((a, b) => {
    const aValue = a?.[sortBy];
    const bValue = b?.[sortBy];
    if (typeof aValue === 'string' || typeof bValue === 'string') {
      const cmp = String(aValue).localeCompare(String(bValue));
      return order === 'asc' ? cmp : -cmp;
    }
    const cmp = Number(aValue) - Number(bValue);
    return order === 'asc' ? cmp : -cmp;
  });
  const offset = toOffset(options.offset, 0);
  const limit = toPositiveInt(options.limit ?? 20, 20, 200);
  return {
    track,
    sortBy,
    order,
    total: sorted.length,
    entries: sorted.slice(offset, offset + limit),
    timestamp: new Date().toISOString(),
  };
}

export function buildContextQuality() {
  const recent = buildRecentChanges({ limit: 50, includeRaw: false });
  const fullscan = buildLatestFullscan({ limit: 10 });
  const watcher = buildWatcherState();
  const warningFlags = [];
  if (!watcher.hasState) warningFlags.push('missing-watcher-state');
  if (!fullscan.latestRunId) warningFlags.push('no-fullscan-runs');
  if (recent.count === 0) warningFlags.push('no-recent-changes');
  return {
    warningFlags,
    recency: {
      recentChangesCount: recent.count,
      latestRunId: fullscan.latestRunId,
    },
    watcherState: {
      hasState: watcher.hasState,
      status: watcher.activeRun?.status ?? 'none',
    },
    timestamp: new Date().toISOString(),
  };
}

export function buildContextOverview(options = {}) {
  const profile = buildProjectProfile();
  const promptStatus = buildPromptStatus();
  const latestFullscan = buildLatestFullscan({ limit: options.limit ?? 5 });
  const watcherState = buildWatcherState();
  const contextQuality = buildContextQuality();
  return {
    project: profile,
    prompts: promptStatus,
    fullscan: {
      latestRunId: latestFullscan.latestRunId,
      counts: latestFullscan.summary?.counts ?? null,
      topPrompts: latestFullscan.topPrompts,
    },
    watcher: watcherState,
    quality: contextQuality,
    timestamp: new Date().toISOString(),
  };
}

export function assertAuthorized(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Invalid MCP tool arguments');
  }
  const sharedToken = getSharedToken();
  if (!sharedToken) return;
  if (args.token !== sharedToken) {
    throw new Error('Unauthorized: invalid MCP token');
  }
}

function assertValidToolArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Invalid MCP tool arguments');
  }
  const strictMode = strictAuthEnabled();
  const allowed = {
    get_project_context: ['token'],
    get_current_task: ['token'],
    get_browser_research: ['token'],
    get_health: ['token'],
    get_project_profile: ['token'],
    get_prompt_status: ['token'],
    get_fullscan_latest: ['token', 'limit'],
    get_fullscan_run: ['token', 'runId', 'track', 'limit', 'offset', 'sortBy', 'order'],
    get_prompt_history: ['token', 'track', 'limit', 'offset', 'sortBy', 'order'],
    get_context_quality: ['token'],
    get_context_overview: ['token', 'limit'],
    get_master_prompts: ['token', 'runId', 'track', 'includeRaw'],
    get_recent_changes: ['token', 'limit', 'includeRaw'],
    get_watcher_state: ['token'],
  }[name];

  if (!allowed) {
    throw new Error(`Unknown tool: ${name}`);
  }
  if (strictMode) {
    const unknownKeys = Object.keys(args).filter((key) => !allowed.includes(key));
    if (unknownKeys.length > 0) {
      throw new Error(`Unknown arguments for ${name}: ${unknownKeys.join(', ')}`);
    }
  }
  if (args.limit !== undefined && (!Number.isFinite(Number(args.limit)) || Number(args.limit) <= 0)) {
    throw new Error('limit must be a positive number when provided');
  }
  if (
    args.offset !== undefined &&
    (!Number.isFinite(Number(args.offset)) || Number(args.offset) < 0)
  ) {
    throw new Error('offset must be a non-negative number when provided');
  }
  if (args.track !== undefined && normalizeTrack(args.track) === null) {
    throw new Error('track must be one of: safe, feature, both');
  }
  if (
    args.order !== undefined &&
    args.order !== 'asc' &&
    args.order !== 'desc'
  ) {
    throw new Error('order must be one of: asc, desc');
  }
  if (
    args.sortBy !== undefined &&
    !['priorityScore', 'durationMs', 'file', 'mtimeMs', 'size'].includes(args.sortBy)
  ) {
    throw new Error('sortBy value is not supported');
  }
  if (args.includeRaw !== undefined && typeof args.includeRaw !== 'boolean') {
    throw new Error('includeRaw must be a boolean when provided');
  }
}

export function createMcpServer() {
  const server = new Server(
    {
      name: 'ai-dev-agent-context',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'get_project_context',
          description:
            'Returns auto-generated project context and latest prompt metadata.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
            },
            additionalProperties: false
          },
        },
        {
          name: 'get_project_profile',
          description: 'Returns normalized project profile scope and delivery preferences.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_current_task',
          description: 'Returns the latest detected current task intent.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
            },
            additionalProperties: false
          },
        },
        {
          name: 'get_browser_research',
          description: 'Returns the latest browser research context summary.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
            },
            additionalProperties: false
          },
        },
        {
          name: 'get_prompt_status',
          description: 'Returns latest safe/feature prompt metadata.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_fullscan_latest',
          description: 'Returns latest fullscan summary and top prompt entries.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              limit: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_context_overview',
          description: 'Returns aggregated project/fullscan/prompt/watcher overview.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              limit: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_fullscan_run',
          description: 'Returns normalized prompts and telemetry for a fullscan run.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              runId: { type: 'string' },
              track: { type: 'string' },
              limit: { type: 'number' },
              offset: { type: 'number' },
              sortBy: { type: 'string' },
              order: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_prompt_history',
          description: 'Returns safe/feature prompt history entries with selectors.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              track: { type: 'string' },
              limit: { type: 'number' },
              offset: { type: 'number' },
              sortBy: { type: 'string' },
              order: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_context_quality',
          description: 'Returns quality/fallback indicators for current context surface.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_master_prompts',
          description: 'Returns safe/feature master prompts for a run (latest by default).',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              runId: { type: 'string' },
              track: { type: 'string' },
              includeRaw: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_recent_changes',
          description: 'Returns parsed recent change timeline from rules context.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              limit: { type: 'number' },
              includeRaw: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_health',
          description: 'Returns MCP server health and current timestamp.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
            },
            additionalProperties: false
          },
        },
        {
          name: 'get_watcher_state',
          description: 'Returns persisted watcher checkpoint state for fullscan resume.',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    diagnostics.requests += 1;
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    assertValidToolArgs(name, args);
    assertAuthorized(args);
    let payload;
    let warnings = [];
    let meta = {};

    if (name === 'get_project_context') {
      payload = getCachedOrBuild(name, args, () => buildProjectContext());
    } else if (name === 'get_project_profile') {
      payload = getCachedOrBuild(name, args, () => buildProjectProfile());
    } else if (name === 'get_current_task') {
      payload = getCachedOrBuild(name, args, () => buildCurrentTask());
    } else if (name === 'get_browser_research') {
      payload = getCachedOrBuild(name, args, () => buildBrowserResearch());
    } else if (name === 'get_prompt_status') {
      payload = getCachedOrBuild(name, args, () => buildPromptStatus());
    } else if (name === 'get_fullscan_latest') {
      payload = getCachedOrBuild(name, args, () => buildLatestFullscan({ limit: args.limit }));
    } else if (name === 'get_context_overview') {
      payload = getCachedOrBuild(name, args, () => buildContextOverview({ limit: args.limit }));
    } else if (name === 'get_fullscan_run') {
      payload = getCachedOrBuild(name, args, () =>
        buildFullscanRun({
          runId: args.runId,
          track: args.track,
          limit: args.limit,
          offset: args.offset,
          sortBy: args.sortBy,
          order: args.order,
        })
      );
    } else if (name === 'get_prompt_history') {
      payload = getCachedOrBuild(name, args, () =>
        buildPromptHistory({
          track: args.track,
          limit: args.limit,
          offset: args.offset,
          sortBy: args.sortBy,
          order: args.order,
        })
      );
    } else if (name === 'get_context_quality') {
      payload = getCachedOrBuild(name, args, () => buildContextQuality());
    } else if (name === 'get_master_prompts') {
      payload = getCachedOrBuild(name, args, () =>
        buildMasterPrompts({
          runId: args.runId,
          track: args.track,
          includeRaw: args.includeRaw,
        })
      );
    } else if (name === 'get_recent_changes') {
      payload = getCachedOrBuild(name, args, () =>
        buildRecentChanges({
          limit: args.limit,
          includeRaw: args.includeRaw,
        })
      );
    } else if (name === 'get_watcher_state') {
      payload = getCachedOrBuild(name, args, () => buildWatcherState());
    } else if (name === 'get_health') {
      payload = {
        ok: true,
        service: 'ai-dev-agent-context',
        uptimeMs: Date.now() - SERVER_STARTED_AT,
        diagnostics: {
          ...diagnostics,
          cacheSize: responseCache.size,
        },
        lastFullscanRunId: findLatestRunDir(),
        timestamp: new Date().toISOString(),
      };
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    if (name !== 'get_health' && !payload) {
      warnings.push('empty_payload');
    }
    meta = {
      authMode: getSharedToken() ? 'token-required' : 'token-optional',
      cached: name === 'get_health' ? false : true,
    };
    const envelope = buildEnvelope(name, payload, meta, warnings);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(envelope, null, 2),
        },
      ],
    };
  });

  return server;
}

export async function startMcpServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startMcpServer();
}
