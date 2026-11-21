import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { epubPlainText, INBOX_LIMITS } from '../src/host/inbox.js';

function epubZip(entries) {
  return zipSync({
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfile full-path="content.opf"/></container>'),
    'content.opf': strToU8('<package><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="c1"/></spine></package>'),
    ...entries,
  });
}

test('extracts plain text from EPUB chapters', () => {
  const bytes = epubZip({ 'c1.xhtml': strToU8('<html><body><h1>Chapter</h1><p>Hello world</p></body></html>') });
  const text = epubPlainText(bytes);
  assert.ok(text.includes('Chapter'));
  assert.ok(text.includes('Hello world'));
});

test('rejects zip bombs on the single-entry limit', () => {
  const big = strToU8('x'.repeat(1024));
  const bomb = zipSync({ 'c1.xhtml': big }, { level: 0 });
  assert.throws(() => epubPlainText(bomb, { maxEntryBytes: 512, maxTotalBytes: INBOX_LIMITS.maxTotalBytes, maxFileCount: 100 }), /单文件解压超限/);
});

test('rejects zip bombs on the total limit', () => {
  const chunk = 'y'.repeat(2048);
  const entries = {};
  for (let i = 0; i < 6; i += 1) entries['c' + i + '.xhtml'] = strToU8(chunk);
  const bomb = zipSync({ ...entries, 'META-INF/container.xml': strToU8('<c/>'), 'content.opf': strToU8('<p/>') }, { level: 0 });
  assert.throws(() => epubPlainText(bomb, { maxEntryBytes: 4096, maxTotalBytes: 8192, maxFileCount: 100 }), /总解压量/);
});

test('rejects excessive file counts', () => {
  const entries = {};
  for (let i = 0; i < 50; i += 1) entries['f' + i + '.xhtml'] = strToU8('<p>x</p>');
  const bomb = epubZip(entries);
  assert.throws(() => epubPlainText(bomb, { maxEntryBytes: 65536, maxTotalBytes: 1 << 20, maxFileCount: 10 }), /文件数/);
});
