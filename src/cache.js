import fs from 'node:fs';
import path from 'node:path';

const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'file-summaries.json');

let memoryCache = {};
let loaded = false;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

export function load() {
  if (loaded) return memoryCache;

  try {
    ensureCacheDir();
    if (!fs.existsSync(CACHE_FILE)) {
      fs.writeFileSync(CACHE_FILE, '{}', 'utf-8');
      memoryCache = {};
      loaded = true;
      return memoryCache;
    }

    const raw = fs.readFileSync(CACHE_FILE, 'utf-8').trim();
    memoryCache = raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error(
      '[cache] Failed to load cache file:',
      err instanceof Error ? err.message : err
    );
    memoryCache = {};
  }

  loaded = true;
  return memoryCache;
}

function persist() {
  try {
    ensureCacheDir();
    const tmpFile = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(memoryCache, null, 2), 'utf-8');
    fs.renameSync(tmpFile, CACHE_FILE);
  } catch (err) {
    console.error(
      '[cache] Failed to persist cache file:',
      err instanceof Error ? err.message : err
    );
  }
}

export function save(key, value) {
  load();
  memoryCache[key] = value;
  persist();
}

export function get(key) {
  load();
  return memoryCache[key] ?? null;
}

export function clear() {
  memoryCache = {};
  loaded = true;
  persist();
}
