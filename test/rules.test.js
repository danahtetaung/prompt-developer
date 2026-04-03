import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writeCursorRules } from '../src/cursorDelivery.js';

const RULES_DIR = path.resolve(process.cwd(), '.cursor', 'rules');

test('writeCursorRules creates expected dynamic rules with frontmatter', () => {
  writeCursorRules({
    file: 'example.js',
    fullPath: path.resolve(process.cwd(), 'src/example.js'),
    analysis: {
      summary: 'Example summary.',
      imports: ['a.js'],
      exports: ['x'],
      purpose: 'Example purpose',
      suggestedContext: 'Example context',
    },
    browserContext: {
      query: 'example api docs',
      relevantDocs: 'MVP docs',
    },
    dependencyMap: { 'example.js': ['a.js'] },
    recentChanges: [
      {
        file: 'example.js',
        fullPath: path.resolve(process.cwd(), 'src/example.js'),
        timestamp: new Date().toISOString(),
      },
    ],
    intent: 'Update example behavior.',
  });

  const requiredFiles = [
    'project-context.mdc',
    'current-task.mdc',
    'browser-context.mdc',
    'code-style.mdc',
    'recent-changes.mdc',
  ];

  for (const filename of requiredFiles) {
    const fullPath = path.join(RULES_DIR, filename);
    assert.equal(fs.existsSync(fullPath), true, `${filename} should exist`);
    const content = fs.readFileSync(fullPath, 'utf-8');
    assert.match(content, /^---/);
    assert.match(content, /description:/);
  }
});

test('writeCursorRules does not throw for sparse input', () => {
  assert.doesNotThrow(() => {
    writeCursorRules({
      file: 'sparse.js',
      fullPath: path.resolve(process.cwd(), 'src/sparse.js'),
    });
  });
});

test('writeCursorRules marks project context as alwaysApply', () => {
  writeCursorRules({
    file: 'always-apply.js',
    fullPath: path.resolve(process.cwd(), 'src/always-apply.js'),
  });
  const content = fs.readFileSync(path.join(RULES_DIR, 'project-context.mdc'), 'utf-8');
  assert.match(content, /alwaysApply:\s*true/);
});
