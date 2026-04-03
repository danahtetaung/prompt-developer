import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('cache load/save/get/clear persists JSON data', async () => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dev-agent-cache-'));
  process.chdir(tempRoot);

  try {
    const modulePath = path.join(originalCwd, 'src', 'cache.js');
    const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}`;
    const cacheModule = await import(moduleUrl);

    const { load, save, get, clear } = cacheModule;
    const firstLoad = load();
    assert.deepEqual(firstLoad, {});

    save('alpha', { value: 123 });
    assert.deepEqual(get('alpha'), { value: 123 });

    const cacheFile = path.join(tempRoot, '.cache', 'file-summaries.json');
    const raw = fs.readFileSync(cacheFile, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.alpha, { value: 123 });
    assert.equal(fs.existsSync(`${cacheFile}.tmp`), false);

    clear();
    assert.equal(get('alpha'), null);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
