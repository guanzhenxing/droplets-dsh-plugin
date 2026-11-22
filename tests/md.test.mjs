import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml } from '../src/client/md.js';

test('markdownToHtml renders headings, lists, code and wikilinks', () => {
  const html = markdownToHtml('# Title\n\n- a\n- b\n\n`code`\n\nSee [[other note|Other]].');
  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('class="dpl-wikilink"'));
  assert.ok(html.includes('data-dpl-target="other note"'));
});

test('markdownToHtml strips a leading frontmatter block', () => {
  const html = markdownToHtml('---\ntitle: Note\ncreated: 2026-11-21\n---\n\n# Note\n\nBody');
  assert.ok(!html.includes('title: Note'));
  assert.ok(!html.includes('created:'));
  assert.ok(html.includes('<h1>Note</h1>'));
  assert.ok(html.includes('Body'));
});
