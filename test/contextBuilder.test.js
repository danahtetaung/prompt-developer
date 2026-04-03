import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext, resetRecentChanges } from '../src/contextBuilder.js';

function createTempFile(contents, name = 'sample.js') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dev-agent-context-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, 'utf-8');
  return filePath;
}

function makeServices(overrides = {}) {
  return {
    analyzeFile: async () => ({
      summary: 'summary',
      imports: [],
      exports: [],
      purpose: 'purpose',
      suggestedContext: 'ctx',
      ...(overrides.analysis ?? {}),
    }),
    getBrowserContext: async () => ({
      query: 'query',
      relevantDocs: 'docs',
      timestamp: new Date().toISOString(),
      ...(overrides.browserContext ?? {}),
    }),
    buildDependencyMap: () => ({ ...(overrides.dependencyMap ?? {}) }),
  };
}

test('buildContext returns enriched metadata and preserves browser timestamp', async () => {
  resetRecentChanges();
  const filePath = createTempFile("export const x = 1;\nconsole.log('ok');\n");
  const browserTimestamp = new Date().toISOString();

  const context = await buildContext(filePath, {
    services: makeServices({
      analysis: {
        summary: 'Analysis unavailable.',
        imports: ['dep-a.js'],
        exports: ['x'],
        purpose: 'Unknown',
        suggestedContext: '',
        symbols: ['x'],
        sideEffects: { filesystem: true, network: false, process: false, globalMutation: false },
        complexity: { lineCount: 3, functionCount: 1, branchCount: 0 },
        dependencies: [{ raw: './dep-a.js', kind: 'relative', module: 'dep-a.js' }],
        tags: ['runtime'],
        clusterHints: ['core-pipeline'],
        confidence: { summary: 0.8, structure: 0.7, deps: 0.6, tags: 0.5 },
        analysisVersion: 2,
      },
      browserContext: {
        query: 'node fs readFileSync docs',
        relevantDocs: 'MVP: external docs fetch not enabled yet.',
        timestamp: browserTimestamp,
      },
      dependencyMap: { 'sample.js': ['dep-a.js'] },
    }),
  });

  assert.ok(context);
  assert.equal(context.file, 'sample.js');
  assert.equal(context.relativePath.endsWith('sample.js'), true);
  assert.equal(context.browserContext.timestamp, browserTimestamp);
  assert.equal(context.browserContext.query, 'node fs readFileSync docs');
  assert.equal(typeof context.timestamp, 'string');
  assert.equal(context.lineCount, 3);
  assert.equal(context.charCount, "export const x = 1;\nconsole.log('ok');\n".length);
  assert.equal(context.extension, '.js');
  assert.equal(context.analysis.purpose.includes('sample.js'), true);
  assert.equal(context.analysis.summary.startsWith('export const x = 1;'), true);
  assert.equal(context.analysis.symbols.includes('x'), true);
  assert.equal(context.analysis.analysisVersion, 2);
  assert.equal(context.analysis.sideEffects.filesystem, true);
  assert.equal(context.analysis.tags.includes('runtime'), true);
  assert.equal(Array.isArray(context.analysis.qualityFlags), true);
  assert.equal(typeof context.projectProfileContext.scopeMode, 'string');
  assert.equal(
    typeof context.contextSignals.dependencyContext.dependencyRisk,
    'number'
  );
  assert.equal(
    typeof context.contextSignals.changeContext.changeFrequency,
    'number'
  );
  assert.equal(
    Array.isArray(context.contextSignals.profileInfluence.emphasis),
    true
  );
  assert.equal(typeof context.contextSignals.riskContext.level, 'string');
  assert.equal(typeof context.contextSignals.complexityContext.level, 'string');
  assert.equal(Array.isArray(context.contextSignals.suggestedReviewTargets), true);
  assert.equal(typeof context.contextSignals.changeIntentHints.editMomentum, 'string');
  assert.equal(typeof context.contextSignals.promptShapingContext.primaryGoal, 'string');
  assert.equal(Array.isArray(context.contextSignals.promptShapingContext.objectiveHints), true);
  assert.equal(typeof context.contextSignals.promptShapingContext.executionStyle, 'string');
  assert.equal(Array.isArray(context.contextSignals.contextQualityFlags), true);
  assert.equal(typeof context.contextSignals.contextDigest, 'string');
  assert.equal(context.contextSignals.contextDigest.includes('Purpose:'), true);
  assert.equal(typeof context.browserContext.quality, 'string');
  assert.equal(typeof context.browserContext.confidence, 'number');
  assert.equal(Array.isArray(context.browserContext.topics), true);
  assert.equal(
    context.analysis.suggestedContext,
    'Review imports/exports and recent changes to preserve behavior.'
  );
  assert.deepEqual(context.dependencyMap, { 'sample.js': ['dep-a.js'] });
});

test('buildContext keeps recentChanges at max 5 entries', async () => {
  resetRecentChanges();

  for (let index = 0; index < 7; index += 1) {
    const filePath = createTempFile(`export const n = ${index};\n`, `file-${index}.js`);
    await buildContext(filePath, {
      services: makeServices({
        analysis: { summary: `summary-${index}` },
      }),
    });
  }

  const finalFilePath = createTempFile('export const final = true;\n', 'final.js');
  const context = await buildContext(finalFilePath, {
    services: makeServices({ analysis: { summary: 'summary-final' } }),
  });

  assert.ok(context);
  assert.equal(context.recentChanges.length, 5);
  assert.deepEqual(
    context.recentChanges.map((item) => item.file),
    ['file-3.js', 'file-4.js', 'file-5.js', 'file-6.js', 'final.js']
  );
  assert.equal(context.recentChanges[context.recentChanges.length - 1].file, 'final.js');
});

test('buildContext supports empty files and analysis value filtering', async () => {
  resetRecentChanges();
  const filePath = createTempFile('', 'empty.ts');

  const context = await buildContext(filePath, {
    services: makeServices({
      analysis: {
        summary: '',
        imports: ['valid-import', 10, null],
        exports: ['okExport', false],
        purpose: '   ',
        suggestedContext: '',
      },
    }),
  });

  assert.ok(context);
  assert.equal(context.extension, '.ts');
  assert.equal(context.analysis.summary, 'File is empty.');
  assert.equal(context.analysis.purpose, 'Handle logic in empty.ts.');
  assert.deepEqual(context.analysis.imports, ['valid-import']);
  assert.deepEqual(context.analysis.exports, ['okExport']);
  assert.equal(context.lineCount, 1);
  assert.equal(context.charCount, 0);
});

test('buildContext falls back to generated browser timestamp when missing', async () => {
  resetRecentChanges();
  const filePath = createTempFile('const a = 1;\r\nconst b = 2;\r\n', 'winlines.js');

  const context = await buildContext(filePath, {
    services: makeServices({
      browserContext: { timestamp: undefined },
    }),
  });

  assert.ok(context);
  assert.equal(typeof context.browserContext.timestamp, 'string');
  assert.equal(context.lineCount, 3);
});

test('buildContext uses project profile override for context shaping', async () => {
  resetRecentChanges();
  const filePath = createTempFile('export const profileAware = true;\n', 'profile.js');

  const context = await buildContext(filePath, {
    projectProfile: {
      projectName: 'PermitOps',
      scopeMode: 'b2b_saas',
      deliveryPreferences: {
        riskTolerance: 'aggressive',
        changeStyle: 'incremental',
      },
      coreUseCases: ['permit intake automation'],
    },
    services: makeServices(),
    promptTrack: 'feature',
  });

  assert.ok(context);
  assert.equal(context.projectProfileContext.scopeMode, 'b2b_saas');
  assert.equal(context.projectProfileContext.riskTolerance, 'aggressive');
  assert.equal(
    context.projectProfileContext.profileInfluence.suggestedScopeStyle,
    'allow-broader-feature-scope'
  );
  assert.equal(
    context.contextSignals.profileInfluence.emphasis.includes('tenant-safety'),
    true
  );
  assert.equal(
    context.contextSignals.scopeGuidance.suggestedScope.startsWith('feature'),
    true
  );
  assert.equal(
    ['safe', 'feature'].includes(context.contextSignals.promptShapingContext.preferredTrack),
    true
  );
});

test('buildContext flags low-signal browser and sparse analysis context', async () => {
  resetRecentChanges();
  const filePath = createTempFile('export const minimal = true;\n', 'minimal.js');

  const context = await buildContext(filePath, {
    services: makeServices({
      analysis: {
        summary: 'analysis unavailable.',
        imports: [],
        exports: [],
        purpose: 'unknown',
        suggestedContext: '',
        confidence: { summary: -1, structure: 2, deps: -10, tags: 99 },
      },
      browserContext: {
        query: '',
        relevantDocs: 'MVP: external docs fetch not enabled yet.',
      },
    }),
    promptTrack: 'safe',
  });

  assert.ok(context);
  assert.equal(context.browserContext.quality, 'low-signal');
  assert.equal(context.browserContext.confidence <= 0.3, true);
  assert.equal(context.analysis.qualityFlags.includes('fallback-summary'), true);
  assert.equal(context.analysis.qualityFlags.includes('fallback-purpose'), true);
  assert.equal(
    context.contextSignals.contextQualityFlags.includes('missing-browser-context'),
    true
  );
  assert.equal(
    context.contextSignals.promptShapingContext.cautionHints.includes(
      'avoid speculative external API assumptions'
    ),
    true
  );
});

test('buildContext returns null for invalid file path input', async () => {
  resetRecentChanges();
  const context = await buildContext('C:\\definitely-not-a-real-file\\missing.js');
  assert.equal(context, null);
});
