import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverProjectFiles } from '../src/fileDiscovery.js';

function makeTempProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dev-agent-discovery-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function write(root, relativePath, contents = '') {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf-8');
  return filePath;
}

function setMtime(filePath, mtimeMs) {
  const when = new Date(mtimeMs);
  fs.utimesSync(filePath, when, when);
}

test('discoverProjectFiles includes default extensions and excludes unsupported ones', async (t) => {
  const root = makeTempProject(t);

  const jsFile = write(root, 'src/main.js', 'export const a = 1;\n');
  const jsxFile = write(root, 'src/view.jsx', 'export const View = () => null;\n');
  const tsFile = write(root, 'src/types.ts', 'export type T = string;\n');
  const tsxFile = write(root, 'src/component.tsx', 'export const C = () => null;\n');
  const upperTsFile = write(root, 'src/UPPER.TS', 'export const upper = true;\n');
  const upperJsxFile = write(root, 'src/UPPER.JSX', 'export const upperJsx = true;\n');
  write(root, 'src/readme.md', '# no\n');
  write(root, 'src/data.json', '{ "a": 1 }\n');
  write(root, 'src/notes.txt', 'skip\n');

  const files = await discoverProjectFiles(root);

  assert.equal(files.includes(jsFile), true);
  assert.equal(files.includes(jsxFile), true);
  assert.equal(files.includes(tsFile), true);
  assert.equal(files.includes(tsxFile), true);
  assert.equal(files.includes(upperTsFile), true);
  assert.equal(files.includes(upperJsxFile), true);
  assert.equal(files.some((file) => file.endsWith('.md')), false);
  assert.equal(files.some((file) => file.endsWith('.json')), false);
  assert.equal(files.some((file) => file.endsWith('.txt')), false);
});

test('discoverProjectFiles ignores default excluded directories and scans nested allowed paths', async (t) => {
  const root = makeTempProject(t);

  const nestedSource = write(
    root,
    'src/nested/feature.ts',
    'export const feature = true;\n'
  );
  write(root, 'node_modules/pkg/index.js', 'skip me\n');
  write(root, '.git/hooks/pre-commit.js', 'skip me\n');
  write(root, '.cursor/rules/sample.ts', 'skip me\n');
  write(root, '.cache/tmp.js', 'skip me\n');
  write(root, 'prompts/latest.js', 'skip me\n');
  write(root, 'dist/output.js', 'skip me\n');
  write(root, 'build/output.js', 'skip me\n');
  write(root, 'coverage/output.js', 'skip me\n');

  const files = await discoverProjectFiles(root);

  assert.equal(files.includes(nestedSource), true);
  assert.equal(files.some((file) => file.includes('node_modules')), false);
  assert.equal(files.some((file) => file.includes('.git')), false);
  assert.equal(files.some((file) => file.includes('.cursor')), false);
  assert.equal(files.some((file) => file.includes('.cache')), false);
  assert.equal(files.some((file) => file.includes('prompts')), false);
  assert.equal(files.some((file) => file.includes('dist')), false);
  assert.equal(files.some((file) => file.includes('build')), false);
  assert.equal(files.some((file) => file.includes('coverage')), false);
});

test('discoverProjectFiles supports custom allowedExt and ignoredDirs options', async (t) => {
  const root = makeTempProject(t);

  const tsFile = write(root, 'src/file.ts', 'export type A = string;\n');
  write(root, 'src/file.js', 'export const a = 1;\n');
  write(root, 'vendor/keep.ts', 'export type Keep = true;\n');

  const onlyTs = await discoverProjectFiles(root, {
    allowedExt: new Set(['.ts']),
  });
  assert.equal(onlyTs.includes(tsFile), true);
  assert.equal(onlyTs.some((file) => file.endsWith('.js')), false);

  const customIgnore = await discoverProjectFiles(root, {
    ignoredDirs: new Set(['vendor']),
  });
  assert.equal(customIgnore.some((file) => file.includes(`${path.sep}vendor${path.sep}`)), false);
});

test('discoverProjectFiles returns deterministic ordering by mtime then filepath', async (t) => {
  const root = makeTempProject(t);

  const fileA = write(root, 'src/a.js', 'export const a = 1;\n');
  const fileB = write(root, 'src/b.js', 'export const b = 1;\n');
  const fileC = write(root, 'src/c.js', 'export const c = 1;\n');

  setMtime(fileA, 1700000000000);
  setMtime(fileB, 1700000000000);
  setMtime(fileC, 1700000005000);

  const files = await discoverProjectFiles(root);
  const firstThree = files.slice(0, 3);

  assert.deepEqual(firstThree, [fileC, fileA, fileB]);
});

test('discoverProjectFiles returns empty array when no eligible files exist', async (t) => {
  const root = makeTempProject(t);
  write(root, 'README.md', '# docs\n');
  write(root, 'notes.txt', 'notes\n');

  const files = await discoverProjectFiles(root);
  assert.deepEqual(files, []);
});

test('discoverProjectFiles remains stable if files are removed before scanning', async (t) => {
  const root = makeTempProject(t);
  const soonDeleted = write(root, 'src/transient.js', 'export const t = true;\n');
  fs.unlinkSync(soonDeleted);

  const files = await discoverProjectFiles(root);
  assert.equal(files.includes(soonDeleted), false);
});
