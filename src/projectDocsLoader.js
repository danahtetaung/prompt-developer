import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ALLOWED_EXT = new Set(['.md']);
const REQUIRED_DOC_FILES = ['PRD.md', 'ARCHITECTURE.md', 'API.md'];

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function listFilesRecursive(baseDir, maxFiles) {
  const files = [];
  const queue = [baseDir];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
        if (files.length >= maxFiles) return files;
      }
    }
  }
  return files;
}

function scoreDocForTarget(docPath, targetFilePath, content) {
  const docBase = path.basename(docPath, path.extname(docPath)).toLowerCase();
  const targetBase = targetFilePath
    ? path.basename(targetFilePath, path.extname(targetFilePath)).toLowerCase()
    : '';
  const lower = content.toLowerCase();
  let score = 1;
  if (targetBase && docBase.includes(targetBase)) score += 4;
  if (targetBase && lower.includes(targetBase)) score += 3;
  if (lower.includes('requirements') || lower.includes('acceptance criteria')) score += 2;
  if (lower.includes('architecture') || lower.includes('design')) score += 2;
  return score;
}

export function loadProjectDocsContext(options = {}) {
  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  const enabled = toBoolean(
    options.enabled ?? process.env.PROJECT_DOCS_ENABLED,
    true
  );
  const docsDirName = String(
    options.docsDirName ?? process.env.PROJECT_DOCS_DIR ?? 'projectdocs'
  );
  const required = toBoolean(
    options.required ?? process.env.PROJECT_DOCS_REQUIRED,
    true
  );
  const maxFiles = toPositiveInt(
    options.maxFiles ?? process.env.PROJECT_DOCS_MAX_FILES,
    40
  );
  const maxChars = toPositiveInt(
    options.maxChars ?? process.env.PROJECT_DOCS_MAX_CHARS,
    24000
  );
  const snippetCount = toPositiveInt(options.snippetCount, 5);
  const docsDir = path.resolve(baseDir, docsDirName);
  const warnings = [];
  const requiredFiles = Array.isArray(options.requiredFiles)
    ? options.requiredFiles
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : REQUIRED_DOC_FILES;

  if (!enabled) {
    return {
      enabled: false,
      required,
      loaded: false,
      baseDir,
      docsDir,
      exists: false,
      fileCount: 0,
      totalChars: 0,
      snippets: [],
      summary: 'Project docs loading is disabled.',
      warnings,
    };
  }

  if (!fs.existsSync(docsDir)) {
    if (required) warnings.push('projectdocs-missing-required');
    else warnings.push('projectdocs-missing');
    return {
      enabled: true,
      required,
      loaded: false,
      baseDir,
      docsDir,
      exists: false,
      fileCount: 0,
      totalChars: 0,
      snippets: [],
      summary: 'Project docs folder not found.',
      requiredFiles,
      requiredMissing: requiredFiles,
      warnings,
    };
  }

  const candidateFiles = listFilesRecursive(docsDir, maxFiles * 2).filter((filePath) =>
    DEFAULT_ALLOWED_EXT.has(path.extname(filePath).toLowerCase())
  );
  const requiredMissing = requiredFiles.filter(
    (requiredName) => !fs.existsSync(path.join(docsDir, requiredName))
  );
  if (requiredMissing.length > 0) {
    warnings.push(`projectdocs-required-files-missing:${requiredMissing.join(',')}`);
  }
  const selectedFiles = candidateFiles.slice(0, maxFiles);
  let totalChars = 0;
  const entries = [];
  for (const filePath of selectedFiles) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const budget = Math.max(0, maxChars - totalChars);
      if (budget <= 0) break;
      const content = trimmed.slice(0, Math.min(trimmed.length, budget));
      totalChars += content.length;
      entries.push({
        path: path.relative(baseDir, filePath).replace(/\\/g, '/'),
        content,
        score: scoreDocForTarget(filePath, options.targetFilePath ?? '', content),
      });
    } catch {
      warnings.push(`projectdocs-read-failed:${path.basename(filePath)}`);
    }
  }

  const sorted = entries.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const snippets = sorted.slice(0, snippetCount).map((entry) => ({
    path: entry.path,
    snippet: entry.content.slice(0, 800),
    score: entry.score,
  }));
  const loaded = snippets.length > 0 && requiredMissing.length === 0;
  if (snippets.length === 0) {
    warnings.push(required ? 'projectdocs-empty-required' : 'projectdocs-empty');
  }

  return {
    enabled: true,
    required,
    loaded,
    baseDir,
    docsDir,
    exists: true,
    requiredFiles,
    requiredMissing,
    fileCount: entries.length,
    totalChars,
    snippets,
    summary: loaded
      ? `Loaded ${entries.length} docs from ${docsDirName}.`
      : requiredMissing.length > 0
        ? `Missing required docs in ${docsDirName}: ${requiredMissing.join(', ')}.`
        : `No readable docs in ${docsDirName}.`,
    warnings,
  };
}
