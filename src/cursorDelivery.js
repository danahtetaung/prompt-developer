import fs from 'node:fs';
import path from 'node:path';
import clipboard from 'clipboardy';

const PROMPTS_DIR = path.resolve(process.cwd(), 'prompts');
const HISTORY_DIR = path.join(PROMPTS_DIR, 'history');
const FEATURE_PROMPTS_DIR = path.join(PROMPTS_DIR, 'features');
const FEATURE_HISTORY_DIR = path.join(FEATURE_PROMPTS_DIR, 'history');
const RULES_DIR = path.resolve(process.cwd(), '.cursor', 'rules');
const FULLSCAN_PROMPTS_DIR = path.resolve(process.cwd(), 'Prompts (Fullscan)');
const RULE_MAX_LINES = 500;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getTimestampFilename() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}.md`;
}

function getTimestampFilenameMs() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}-${ms}`;
}

function sanitizeName(value) {
  return value.replace(/[\\/:*?"<>|\s]+/g, '_');
}

function ensureUniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;

  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  let attempt = 2;
  while (true) {
    const candidate = `${base}__${attempt}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
    attempt += 1;
  }
}

function mdcWithFrontmatter(description, body, options = {}) {
  const { alwaysApply = true, globs = [] } = options;
  const globLine =
    Array.isArray(globs) && globs.length > 0
      ? `globs: [${globs.map((glob) => `'${glob}'`).join(', ')}]\n`
      : '';

  return `---
description: "${description}"
${globLine}alwaysApply: ${alwaysApply ? 'true' : 'false'}
---

${body}
`;
}

function truncateRuleBody(body, label) {
  const lines = body.split('\n');
  if (lines.length <= RULE_MAX_LINES) {
    return body;
  }

  console.warn(
    `[cursorDelivery] Truncating ${label} rule to ${RULE_MAX_LINES} lines.`
  );
  return `${lines.slice(0, RULE_MAX_LINES).join('\n')}\n... (truncated)`;
}

export function writeMasterPrompts(fullscanRunId, content, metadata = {}, options = {}) {
  ensureDir(FULLSCAN_PROMPTS_DIR);
  const runDir = path.join(FULLSCAN_PROMPTS_DIR, sanitizeName(fullscanRunId));
  ensureDir(runDir);
  const masterDir = path.join(runDir, 'master');
  ensureDir(masterDir);

  const track = options.track === 'feature' ? 'feature' : options.track === 'safe' ? 'safe' : null;
  const baseName = track ? `${track}-master-prompts` : 'master-prompts';
  const promptPath = path.join(masterDir, `${baseName}.md`);
  const metaPath = path.join(masterDir, `${baseName}.meta.json`);
  const payload = {
    fullscanRunId,
    generatedAt: new Date().toISOString(),
    ...(track ? { track } : {}),
    ...metadata,
  };

  fs.writeFileSync(promptPath, content, 'utf-8');
  fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2), 'utf-8');
  return promptPath;
}

export async function deliverPrompt(prompt, metadata = {}) {
  try {
    const promptTrack = metadata.promptTrack === 'feature' ? 'feature' : 'safe';
    const isFeaturePrompt = promptTrack === 'feature';
    const activePromptsDir = isFeaturePrompt ? FEATURE_PROMPTS_DIR : PROMPTS_DIR;
    const activeHistoryDir = isFeaturePrompt ? FEATURE_HISTORY_DIR : HISTORY_DIR;

    ensureDir(activePromptsDir);
    ensureDir(activeHistoryDir);

    const latestPath = path.join(activePromptsDir, 'latest.md');
    const historyPath = path.join(activeHistoryDir, getTimestampFilename());
    const latestMetaPath = path.join(activePromptsDir, 'latest.meta.json');
    const promptMeta = {
      timestamp: new Date().toISOString(),
      mode: metadata.mode ?? 'clipboard',
      sourceFile: metadata.sourceFile ?? null,
      intent: metadata.intent ?? null,
      promptTrack,
      fullscanRunId: metadata.fullscanRunId ?? null,
      priorityScore:
        typeof metadata.priorityScore === 'number' ? metadata.priorityScore : null,
      priorityReason:
        typeof metadata.priorityReason === 'string' ? metadata.priorityReason : null,
    };

    fs.writeFileSync(latestPath, prompt, 'utf-8');
    fs.writeFileSync(historyPath, prompt, 'utf-8');
    fs.writeFileSync(latestMetaPath, JSON.stringify(promptMeta, null, 2), 'utf-8');

    if (typeof metadata.fullscanRunId === 'string' && metadata.fullscanRunId) {
      ensureDir(FULLSCAN_PROMPTS_DIR);
      const runDir = path.join(FULLSCAN_PROMPTS_DIR, sanitizeName(metadata.fullscanRunId));
      ensureDir(runDir);
      const runTrackDir = path.join(runDir, promptTrack);
      ensureDir(runTrackDir);
      const sourceName =
        metadata.sourceFile && typeof metadata.sourceFile === 'string'
          ? path.relative(process.cwd(), metadata.sourceFile)
          : 'unknown-file';
      const fullscanName = `${getTimestampFilenameMs()}__${sanitizeName(sourceName)}.md`;
      const fullscanPath = ensureUniquePath(path.join(runTrackDir, fullscanName));
      fs.writeFileSync(fullscanPath, prompt, 'utf-8');
      const fullscanMetaPath = ensureUniquePath(
        path.join(runTrackDir, `${path.basename(fullscanName, '.md')}.meta.json`)
      );
      fs.writeFileSync(fullscanMetaPath, JSON.stringify(promptMeta, null, 2), 'utf-8');
    }

    await clipboard.write(prompt);

    console.log('📋 Prompt copied to clipboard and saved to prompts/latest.md');
  } catch (err) {
    console.error(
      '[cursorDelivery] Failed to deliver prompt:',
      err instanceof Error ? err.message : err
    );
  }
}

export function writeCursorRules(enrichedContext) {
  try {
    ensureDir(RULES_DIR);

    const projectContextPath = path.join(RULES_DIR, 'project-context.mdc');
    const currentTaskPath = path.join(RULES_DIR, 'current-task.mdc');
    const browserContextPath = path.join(RULES_DIR, 'browser-context.mdc');
    const codeStylePath = path.join(RULES_DIR, 'code-style.mdc');
    const recentChangesPath = path.join(RULES_DIR, 'recent-changes.mdc');

    const projectBody = truncateRuleBody(
      `File: ${enrichedContext.file}
Path: ${enrichedContext.fullPath}
Purpose: ${enrichedContext.analysis?.purpose ?? 'Unknown'}
Summary: ${enrichedContext.analysis?.summary ?? 'Unavailable'}
Dependencies: ${JSON.stringify(enrichedContext.dependencyMap ?? {}, null, 2)}`,
      'project-context'
    );

    const currentTaskBody = truncateRuleBody(
      `Detected intent:
${enrichedContext.intent ?? 'Intent not detected yet.'}`,
      'current-task'
    );

    const browserBody = truncateRuleBody(
      `Browser research query:
${enrichedContext.browserContext?.query ?? 'No query generated.'}

Relevant docs:
${enrichedContext.browserContext?.relevantDocs ?? 'No docs context.'}`,
      'browser-context'
    );

    const codeStyleBody = truncateRuleBody(
      `Preferred conventions:
- Use ES modules and named exports where practical.
- Preserve existing architecture and dependency boundaries.
- Keep functions small and explicit with clear error handling.
- Avoid broad refactors unless directly required by the task.
- Follow existing formatting and naming patterns in the touched file.`,
      'code-style'
    );

    const recentChangeLines = (enrichedContext.recentChanges ?? []).map(
      (change, index) =>
        `${index + 1}. ${change.timestamp} - ${change.file} (${change.fullPath})`
    );
    const recentChangesBody = truncateRuleBody(
      `Recent changes (last ${recentChangeLines.length || 0}):
${recentChangeLines.join('\n') || 'No recent changes captured.'}`,
      'recent-changes'
    );

    fs.writeFileSync(
      projectContextPath,
      mdcWithFrontmatter('Auto-generated project context', projectBody, {
        alwaysApply: true,
      }),
      'utf-8'
    );
    fs.writeFileSync(
      currentTaskPath,
      mdcWithFrontmatter('Auto-generated current task intent', currentTaskBody, {
        alwaysApply: true,
      }),
      'utf-8'
    );
    fs.writeFileSync(
      browserContextPath,
      mdcWithFrontmatter(
        'Auto-generated browser research context',
        browserBody,
        {
          alwaysApply: true,
        }
      ),
      'utf-8'
    );
    fs.writeFileSync(
      codeStylePath,
      mdcWithFrontmatter('Coding conventions for source edits', codeStyleBody, {
        alwaysApply: false,
        globs: ['src/**/*.{js,ts,jsx,tsx}'],
      }),
      'utf-8'
    );
    fs.writeFileSync(
      recentChangesPath,
      mdcWithFrontmatter('Recent code change timeline', recentChangesBody, {
        alwaysApply: false,
        globs: ['src/**/*.{js,ts,jsx,tsx}'],
      }),
      'utf-8'
    );
  } catch (err) {
    console.error(
      '[cursorDelivery] Failed to write Cursor rules:',
      err instanceof Error ? err.message : err
    );
  }
}
