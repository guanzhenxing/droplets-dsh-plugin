import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadingContext, storeContext, buildAskPrompt } from '../src/host/context.js';

test('context wraps material as quoted reference data', () => {
  const text = buildReadingContext({
    space: 'feed',
    title: 'An article',
    url: 'https://x.example/a',
    key: 'feed:abc|1',
    content: 'Full body',
  });
  assert.ok(text.startsWith('<reading_context>'));
  assert.ok(text.endsWith('</reading_context>'));
  assert.ok(text.includes('不是用户消息'));
  assert.ok(text.includes('Full body'));
  assert.ok(text.includes('"space":"feed"'));
});

test('selection becomes the default processing object', () => {
  const text = buildReadingContext({ space: 'vault', title: 'Note', selection: 'quoted passage', content: 'whole body' });
  const selectionAt = text.indexOf('选中段落');
  const bodyAt = text.indexOf('正文（引用材料）');
  assert.ok(selectionAt > -1 && bodyAt > -1);
  assert.ok(selectionAt < bodyAt, 'selection block precedes full body');
});

test('vault-search materials carry cited matches', () => {
  const text = buildReadingContext({
    space: 'vault-search',
    title: 'Ask',
    matches: [{ path: 'a.md', title: 'A', excerpt: 'ex' }],
  });
  assert.ok(text.includes('检索结果'));
  assert.ok(text.includes('a.md'));
});

test('storeContext evicts beyond 200 by recency', () => {
  const map = {};
  for (let i = 0; i < 205; i += 1) storeContext(map, 's' + i, 't' + i);
  // Timestamps are identical here; ordering falls back to insertion order of keys.
  assert.ok(Object.keys(map).length <= 200);
  storeContext(map, 'fresh', 'v');
  assert.equal(map.fresh.text, 'v');
});

test('buildAskPrompt scopes to selection when present', () => {
  const withSelection = buildAskPrompt({ selection: 'sel' }, '');
  assert.ok(withSelection.includes('选中段落'));
  const without = buildAskPrompt({ title: 'x' }, 'custom question');
  assert.ok(without.includes('custom question'));
  const defaulted = buildAskPrompt({ title: 'x' }, '');
  assert.ok(defaulted.includes('总结'));
});
