import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ANALYSIS_VERSION, buildDependencyMap, normalizeAnalysis } from '../src/fileIntelligence.js';

test('normalizeAnalysis enriches structural fields and version', () => {
  const filePath = path.join(process.cwd(), 'src', 'sample.js');
  const content = `
import fs from 'node:fs';
import { helper } from './helper.js';
const item = 1;
function runTask() { if (item) return fs.readFileSync('x'); }
`;

  const result = normalizeAnalysis(
    {
      summary: 'ok',
      imports: ['node:fs', './helper.js'],
      exports: ['runTask'],
      purpose: 'task runner',
      suggestedContext: 'ctx',
    },
    { filePath, content }
  );

  assert.equal(result.analysisVersion, ANALYSIS_VERSION);
  assert.equal(Array.isArray(result.symbols), true);
  assert.equal(result.symbols.includes('runTask'), true);
  assert.equal(result.sideEffects.filesystem, true);
  assert.equal(result.complexity.lineCount > 0, true);
  assert.equal(Array.isArray(result.dependencies), true);
  assert.equal(result.dependencies.length >= 2, true);
  assert.equal(Array.isArray(result.tags), true);
  assert.equal(Array.isArray(result.clusterHints), true);
});

test('buildDependencyMap uses dependency details and relative inference', () => {
  const filePath = path.join(process.cwd(), 'src', 'example.js');
  const dependencyGraph = buildDependencyMap(filePath, {
    imports: ['./utils/retry.js', 'openai'],
    dependencies: [
      {
        raw: './notify/index.js',
        kind: 'relative',
        resolved: path.join(process.cwd(), 'src', 'notify', 'index.js'),
        module: 'index.js',
      },
    ],
  });

  assert.equal(typeof dependencyGraph['example.js'], 'object');
  assert.equal(dependencyGraph['example.js'].includes('./utils/retry.js'), true);
  assert.equal(dependencyGraph['example.js'].includes('index.js'), true);
});
