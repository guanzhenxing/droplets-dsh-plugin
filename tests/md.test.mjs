import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml } from '../src/client/md.js';
import { formatWhen, formatWhenFull } from '../src/client/feed/format.js';

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

// feed E: cross-year dates must carry the year; same-year keeps M/D.
test('formatWhen: same-year stays M/D, cross-year carries the year', () => {
  const now = new Date();
  const crossYear = new Date(now.getFullYear() - 1, 11, 31, 10, 5);
  const cross = formatWhen(crossYear.getTime());
  assert.ok(cross.includes(String(now.getFullYear() - 1)), 'cross-year date carries the year');
  assert.ok(cross.includes('12') && cross.includes('31'), 'month and day stay present');
  // A same-year, non-today day: shift away from the year boundary (Jan 1 →
  // +1, Dec 31 → -1) so the constructed date never rolls into another year.
  const shift = now.getDate() <= 15 ? 1 : -1;
  const sameYear = new Date(now.getFullYear(), now.getMonth(), now.getDate() + shift, 10, 5);
  assert.equal(sameYear.getFullYear(), now.getFullYear());
  const short = formatWhen(sameYear.getTime());
  assert.ok(!short.includes(String(now.getFullYear())), 'same-year date keeps M/D without the year');
  assert.ok(short.includes(String(sameYear.getMonth() + 1)) && short.includes(String(sameYear.getDate())), 'M/D present');
});

test('formatWhenFull: same-year keeps M/D + time, cross-year adds the year', () => {
  const now = new Date();
  const crossYear = new Date(now.getFullYear() - 1, 11, 31, 10, 5);
  const cross = formatWhenFull(crossYear.getTime());
  assert.ok(cross.includes(String(now.getFullYear() - 1)), 'cross-year date carries the year');
  assert.match(cross, /\d{1,2}:\d{2}/, 'time part present');
  const shift = now.getDate() <= 15 ? 1 : -1;
  const sameYear = new Date(now.getFullYear(), now.getMonth(), now.getDate() + shift, 10, 5);
  assert.equal(sameYear.getFullYear(), now.getFullYear());
  const full = formatWhenFull(sameYear.getTime());
  assert.ok(!full.includes(String(now.getFullYear())), 'same-year date stays M/D without the year');
  assert.match(full, /\d{1,2}:\d{2}/, 'time part present');
});
