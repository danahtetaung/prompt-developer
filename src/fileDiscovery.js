import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.cursor',
  '.cache',
  'prompts',
  'dist',
  'build',
  'coverage',
]);

/**
 * @param {string} rootPath
 * @param {{
 *   allowedExt?: Set<string>,
 *   ignoredDirs?: Set<string>
 * }} [options]
 * @returns {Promise<string[]>}
 */
export async function discoverProjectFiles(rootPath, options = {}) {
  const allowedExt =
    options.allowedExt ?? new Set(['.js', '.jsx', '.ts', '.tsx']);
  const ignoredDirs = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;

  /** @type {Array<{filePath: string, mtimeMs: number}>} */
  const discovered = [];

  /**
   * @param {string} currentDir
   */
  async function walk(currentDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      // Skip unreadable or transient directories.
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        await walk(entryPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExt.has(ext)) continue;

      try {
        const stats = await fs.stat(entryPath);
        discovered.push({ filePath: entryPath, mtimeMs: stats.mtimeMs });
      } catch {
        // Ignore files that disappear during scan.
      }
    }
  }

  await walk(rootPath);

  discovered.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.filePath.localeCompare(b.filePath);
  });

  return discovered.map((item) => item.filePath);
}
