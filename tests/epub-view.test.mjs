import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { openEpub } from '../src/client/epub-view.js';

// Minimal PNG payload: content is opaque to the reader, only bytes matter.
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];

/** Build a minimal EPUB: container.xml + opf with the given spine, plus files. */
function epubZip(files, { opfPath = 'content.opf', spine = [] } = {}) {
  const manifest = spine.map((href, i) => `<item id="c${i + 1}" href="${href}" media-type="application/xhtml+xml"/>`).join('');
  const itemrefs = spine.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('');
  return zipSync({
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfile full-path="' + opfPath + '"/></container>'),
    [opfPath]: strToU8('<package><manifest>' + manifest + '</manifest><spine>' + itemrefs + '</spine></package>'),
    ...files,
  });
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/** Stub the blob URL APIs for one test body; restores the originals after. */
function withBlobStubs({ onCreate, onRevoke }, body) {
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  if (onCreate) URL.createObjectURL = onCreate;
  if (onRevoke) URL.revokeObjectURL = onRevoke;
  try {
    return body();
  } finally {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
}

test('chapter titles come from h1-h6, then <title>, then the positional fallback', () => {
  const zip = epubZip({
    'c1.xhtml': strToU8('<html><head><title>ignored</title></head><body><h1>第一章 起点</h1><p>正文</p></body></html>'),
    'c2.xhtml': strToU8('<html><body><h2 class="chapter">第二章 带属性</h2><p>正文</p></body></html>'),
    'c3.xhtml': strToU8('<html><head><title>第三章 head title</title></head><body><p>正文</p></body></html>'),
    'c4.xhtml': strToU8('<html><body><p>正文</p></body></html>'),
  }, { spine: ['c1.xhtml', 'c2.xhtml', 'c3.xhtml', 'c4.xhtml'] });
  const epub = openEpub(toBase64(zip));
  assert.equal(epub.title, 'EPUB');
  assert.equal(typeof epub.destroy, 'function');
  assert.deepEqual(epub.chapters.map((chapter) => chapter.title), ['第一章 起点', '第二章 带属性', '第三章 head title', '第 4 节']);
  assert.deepEqual(epub.chapters.map((chapter) => chapter.index), [0, 1, 2, 3]);
  for (const chapter of epub.chapters) {
    assert.deepEqual(Object.keys(chapter).sort(), ['html', 'index', 'title']);
    assert.ok(!chapter.html.includes('<title>'));
    assert.ok(chapter.html.includes('正文'));
  }
});

test('image srcs become blob: URLs resolved against the chapter directory; destroy() revokes them once', () => {
  const created = [];
  const revoked = [];
  withBlobStubs({
    onCreate: (blob) => { created.push(blob); return 'blob:mock-' + created.length; },
    onRevoke: (url) => { revoked.push(url); },
  }, () => {
    const zip = epubZip({
      'OEBPS/text/c1.xhtml': strToU8('<html><body><h1>带图章节</h1><img src="../images/pic.png" alt="封面"/></body></html>'),
      'OEBPS/text/c2.xhtml': strToU8('<html><body><img src="../images/pic.png"/></body></html>'),
      'OEBPS/images/pic.png': Uint8Array.from(PNG_BYTES),
    }, { opfPath: 'OEBPS/content.opf', spine: ['text/c1.xhtml', 'text/c2.xhtml'] });
    const epub = openEpub(toBase64(zip));
    assert.equal(epub.chapters[0].title, '带图章节');
    assert.equal(created.length, 1, 'one resource shared across chapters');
    assert.ok(created[0] instanceof Blob);
    assert.equal(created[0].type, 'image/png');
    assert.equal(created[0].size, PNG_BYTES.length);
    assert.ok(epub.chapters[0].html.includes('src="blob:mock-1"'), epub.chapters[0].html);
    assert.ok(!epub.chapters[0].html.includes('../images/pic.png'), 'original ref is gone');
    assert.ok(epub.chapters[1].html.includes('src="blob:mock-1"'), 'second chapter reuses the same blob URL');
    assert.deepEqual(revoked, []);
    epub.destroy();
    assert.deepEqual(revoked, ['blob:mock-1']);
    epub.destroy(); // idempotent
    assert.deepEqual(revoked, ['blob:mock-1']);
  });
});

test('misses and absolute URLs stay untouched; percent-encoded and css refs resolve', () => {
  withBlobStubs({ onCreate: (blob) => 'blob:' + blob.type }, () => {
    const zip = epubZip({
      'OEBPS/text/c1.xhtml': strToU8('<html><body><img src="../images/missing.png"/>' +
        '<img src="https://cdn.example/x.png"/>' +
        '<img src="../images/sp%20ace.png"/>' +
        '<a href="c1.xhtml#top">anchor</a>' +
        '<link rel="stylesheet" href="../style/main.css"/></body></html>'),
      'OEBPS/images/sp ace.png': Uint8Array.from(PNG_BYTES),
      'OEBPS/style/main.css': strToU8('body{margin:0}'),
    }, { opfPath: 'OEBPS/content.opf', spine: ['text/c1.xhtml'] });
    const epub = openEpub(toBase64(zip));
    const html = epub.chapters[0].html;
    assert.ok(html.includes('src="../images/missing.png"'), 'missing resource keeps the original ref');
    assert.ok(html.includes('src="https://cdn.example/x.png"'), 'absolute URL passes through');
    assert.ok(html.includes('src="blob:image/png"'), 'percent-encoded ref resolves: ' + html);
    assert.ok(!html.includes('sp%20ace'), 'decoded ref replaced');
    assert.ok(html.includes('href="c1.xhtml#top"'), 'in-document anchor passes through');
    assert.ok(html.includes('href="blob:text/css"'), 'css link resolves with its mime');
  });
});

test('without URL.createObjectURL the html keeps the original refs and destroy() stays safe', () => {
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
  try {
    const zip = epubZip({
      'OEBPS/text/c1.xhtml': strToU8('<html><body><img src="../images/pic.png"/></body></html>'),
      'OEBPS/images/pic.png': Uint8Array.from(PNG_BYTES),
    }, { opfPath: 'OEBPS/content.opf', spine: ['text/c1.xhtml'] });
    const epub = openEpub(toBase64(zip));
    assert.ok(epub.chapters[0].html.includes('src="../images/pic.png"'), 'no rewrite without createObjectURL');
    epub.destroy(); // must not throw even without revokeObjectURL
  } finally {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
});

test('spineless EPUBs fall back to every XHTML file with titles and rewrites intact', () => {
  withBlobStubs({ onCreate: () => 'blob:mock' }, () => {
    const zip = zipSync({
      'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfile full-path="content.opf"/></container>'),
      'content.opf': strToU8('<package><manifest></manifest><spine></spine></package>'),
      'c1.xhtml': strToU8('<html><body><h1>无 spine</h1><img src="pic.png"/></body></html>'),
      'pic.png': Uint8Array.from(PNG_BYTES),
    });
    const epub = openEpub(toBase64(zip));
    assert.equal(epub.chapters.length, 1);
    assert.equal(epub.chapters[0].title, '无 spine');
    assert.ok(epub.chapters[0].html.includes('src="blob:mock"'), 'root-relative-to-chapter ref resolves');
  });
});
