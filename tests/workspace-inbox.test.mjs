import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { WorkspaceInbox, uuidv7, parseInboxMetaCompat } from '../src/host/workspace-inbox.js';
import { htmlToMarkdown } from '../src/host/html-to-md.js';

function tempWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), 'droplets-ws-inbox-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 }),
  };
}

const quietLogger = { info() {}, warn() {}, error() {} };

function fetcherOf(responses) {
  return {
    async fetch(url) {
      const hit = responses[url];
      if (!hit) throw Object.assign(new Error('连接失败：ENOENT'), { code: 'FETCH_NETWORK' });
      if (hit.throw) throw hit.throw;
      return hit;
    },
  };
}

async function seedObject(root, { id, title = '条目', status = 'unread', tags = [], content = '正文', source } = {}) {
  const dir = path.join(root, 'inbox', id);
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta = {
    id,
    objectType: 'article',
    space: 'inbox',
    status,
    title,
    tags,
    source: source ?? { kind: 'markdown-import', addedAt: now },
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  await writeFile(path.join(dir, 'content.md'), content);
  return meta;
}

test('uuidv7 has the version and variant bits', () => {
  const id = uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(parseInt(id.slice(0, 8), 16) <= Date.now());
});

test('list returns native shapes: counts, newest first, status/tag filter', async () => {
  const ws = tempWorkspace();
  try {
    await seedObject(ws.dir, { id: 'a1', title: '旧', tags: ['web3'], status: 'unread', content: 'old' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedObject(ws.dir, { id: 'b2', title: '新', tags: ['ai', 'web3'], status: 'finished' });
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({}));
    const all = await inbox.list();
    assert.equal(all.counts.total, 2);
    assert.equal(all.counts.byStatus.unread, 1);
    assert.equal(all.counts.byStatus.finished, 1);
    assert.equal(all.counts.byTag.web3, 2);
    assert.deepEqual(all.items.map((item) => item.id), ['b2', 'a1']);
    const unread = await inbox.list({ status: 'unread' });
    assert.deepEqual(unread.items.map((item) => item.id), ['a1']);
    const tagged = await inbox.list({ tag: 'ai' });
    assert.deepEqual(tagged.items.map((item) => item.id), ['b2']);
  } finally { ws.cleanup(); }
});

test('list query matches title, tag and body', async () => {
  const ws = tempWorkspace();
  try {
    await seedObject(ws.dir, { id: 'q1', title: '深度解析 Codex', tags: [], content: 'harness architecture inside' });
    await seedObject(ws.dir, { id: 'q2', title: '别的', tags: ['needle-tag'], content: 'nothing' });
    await seedObject(ws.dir, { id: 'q3', title: '再看一篇', tags: [], content: 'mentions harness too' });
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({}));
    assert.deepEqual((await inbox.list({ query: 'codex' })).items.map((i) => i.id), ['q1']);
    assert.deepEqual((await inbox.list({ query: 'needle-tag' })).items.map((i) => i.id), ['q2']);
    // Newest first: q3 was seeded last, so it leads the body matches.
    assert.deepEqual((await inbox.list({ query: 'harness' })).items.map((i) => i.id), ['q3', 'q1']);
  } finally { ws.cleanup(); }
});

test('parseInboxMetaCompat normalizes the legacy reading status', () => {
  const meta = parseInboxMetaCompat(JSON.stringify({ id: 'x', status: 'reading', title: 't', tags: [], source: { kind: 'markdown-import', addedAt: '2026-01-01T00:00:00.000Z' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
  assert.equal(meta.status, 'unread');
});

test('addUrl creates a placeholder then lands markdown content (native format)', async () => {
  const ws = tempWorkspace();
  try {
    const html = '<html><head><title>测试文章</title></head><body><main><h2>标题二</h2><p>第一段 <strong>加粗</strong> 与 <a href="https://example.com/x">链接</a>。</p><ul><li>一项</li><li>二项</li></ul></main></body></html>';
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({
      'https://example.com/post': {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: new TextEncoder().encode(html),
        finalUrl: 'https://example.com/post',
      },
    }));
    const { item, duplicate } = await inbox.addUrl('https://example.com/post');
    assert.equal(duplicate, false);
    assert.equal(item.title, 'https://example.com/post'); // placeholder title until the outcome lands
    await inbox.runExclusive(item.id, () => Promise.resolve()); // wait out the background chain
    const stored = await inbox.get(item.id);
    assert.equal(stored.meta.status, 'unread');
    assert.equal(stored.meta.title, '测试文章');
    assert.match(stored.content, /^## 标题二/);
    assert.ok(stored.content.includes('**加粗**'));
    assert.ok(stored.content.includes('[链接](https://example.com/x)'));
    assert.ok(stored.content.includes('- 一项'));
    // staged original HTML for a later library move
    assert.ok(existsSync(path.join(ws.dir, 'state', 'inbox-originals', `${item.id}.bin`)));
    // duplicate add short-circuits
    const again = await inbox.addUrl('https://example.com/post');
    assert.equal(again.duplicate, true);
    assert.equal(again.item.id, item.id);
  } finally { ws.cleanup(); }
});

test('addUrl failure writes a fetch_failed placeholder with the error triple', async () => {
  const ws = tempWorkspace();
  try {
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({
      'https://example.com/missing': { throw: Object.assign(new Error('连接失败：ECONNREFUSED'), { code: 'FETCH_NETWORK' }) },
    }));
    const { item } = await inbox.addUrl('https://example.com/missing');
    await inbox.runExclusive(item.id, () => Promise.resolve());
    const stored = await inbox.get(item.id);
    assert.equal(stored.meta.status, 'fetch_failed');
    assert.equal(stored.meta.source.fetchError.code, 'FETCH_NETWORK');
    assert.equal(stored.meta.source.fetchError.securityRejection, false);
    const list = await inbox.list({ status: 'fetch_failed' });
    assert.equal(list.items.length, 1);
  } finally { ws.cleanup(); }
});

test('updateMeta patches tags and status, bumping updatedAt', async () => {
  const ws = tempWorkspace();
  try {
    await seedObject(ws.dir, { id: 'u1' });
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({}));
    const next = await inbox.updateMeta('u1', { tags: ['backend', 'ai'], status: 'finished' });
    assert.deepEqual(next.tags, ['backend', 'ai']);
    assert.equal(next.status, 'finished');
    const stored = JSON.parse(readFileSync(path.join(ws.dir, 'inbox', 'u1', 'meta.json'), 'utf8'));
    assert.deepEqual(stored.tags, ['backend', 'ai']);
  } finally { ws.cleanup(); }
});

test('retry refetches a failed object back to unread', async () => {
  const ws = tempWorkspace();
  try {
    await seedObject(ws.dir, {
      id: 'r1',
      status: 'fetch_failed',
      source: { kind: 'url', url: 'https://example.com/ok', addedAt: new Date().toISOString(), fetchError: { code: 'FETCH_NETWORK', message: 'x', securityRejection: false } },
    });
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({
      'https://example.com/ok': {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: new TextEncoder().encode('<html><body><main><p>回来了</p></main></body></html>'),
        finalUrl: 'https://example.com/ok',
      },
    }));
    const next = await inbox.retry('r1');
    assert.equal(next.status, 'unread');
    assert.equal(next.source.fetchError, undefined);
    const stored = await inbox.get('r1');
    assert.ok(stored.content.includes('回来了'));
  } finally { ws.cleanup(); }
});

test('retryAllFailed counts outcomes', async () => {
  const ws = tempWorkspace();
  try {
    await seedObject(ws.dir, { id: 'f1', status: 'fetch_failed', source: { kind: 'url', url: 'https://example.com/good', addedAt: new Date().toISOString() } });
    await seedObject(ws.dir, { id: 'f2', status: 'fetch_failed', source: { kind: 'url', url: 'https://example.com/bad', addedAt: new Date().toISOString() } });
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({
      'https://example.com/good': { status: 200, headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode('<main><p>ok</p></main>'), finalUrl: 'https://example.com/good' },
      'https://example.com/bad': { throw: Object.assign(new Error('连接失败'), { code: 'FETCH_NETWORK' }) },
    }));
    const result = await inbox.retryAllFailed();
    assert.equal(result.total, 2);
    // fetchIntoInner records failures as fetch_failed outcomes (it does not
    // throw), matching the native service — both retries "succeed" here.
    assert.equal(result.retried, 2);
    assert.equal(result.failed, 0);
    // The "failed" one stays fetch_failed (fetchInto writes the outcome, not an exception).
    const stored = await inbox.get('f2');
    assert.equal(stored.meta.status, 'fetch_failed');
  } finally { ws.cleanup(); }
});

test('retryAllFailed retries concurrently with a cap of 4 and counts failures', async () => {
  const ws = tempWorkspace();
  try {
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    for (const id of ids) {
      await seedObject(ws.dir, {
        id,
        status: 'fetch_failed',
        source: { kind: 'url', url: 'https://example.com/' + id, addedAt: new Date().toISOString() },
      });
    }
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({}));
    let active = 0;
    let maxActive = 0;
    const attempted = [];
    // mock fetchInto：量测并发上界（旧实现是逐条 await 的串行循环）
    inbox.fetchInto = async (id) => {
      attempted.push(id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      if (id === 'c3') throw new Error('重试被拒');
      return { status: 'unread' };
    };
    const result = await inbox.retryAllFailed();
    assert.equal(result.total, 6);
    assert.equal(result.retried, 5, 'five retries reported as retried');
    assert.equal(result.failed, 1, 'the rejecting id counted as failed');
    assert.equal(attempted.length, 6, 'every failed id retried exactly once');
    assert.ok(maxActive > 1, 'retries actually overlapped (max concurrent ' + maxActive + ')');
    assert.ok(maxActive <= 4, 'concurrency capped at 4 (max concurrent ' + maxActive + ')');
  } finally { ws.cleanup(); }
});

test('moveToTrash relocates the directory behind a staging commit', async () => {
  const ws = tempWorkspace();
  try {
    await seedObject(ws.dir, { id: 't1', title: '要删的', content: '拜拜' });
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({}));
    const entry = await inbox.moveToTrash('t1');
    assert.equal(entry.deletedFrom, 'inbox');
    assert.equal(entry.entryKind, 'directory');
    assert.equal(entry.title, '要删的');
    assert.ok(entry.fileCount >= 2);
    assert.equal(existsSync(path.join(ws.dir, 'inbox', 't1')), false);
    const trashMeta = JSON.parse(readFileSync(path.join(ws.dir, '.trash', 't1', 'trash-meta.json'), 'utf8'));
    assert.equal(trashMeta.id, 't1');
    assert.ok(existsSync(path.join(ws.dir, '.trash', 't1', 'payload', 'content.md')));
    // No staging leftovers
    assert.equal(readdirSync(path.join(ws.dir, '.trash')).filter((name) => name.startsWith('.staging-')).length, 0);
  } finally { ws.cleanup(); }
});

test('moveToLibrary flips space, copies content, and clears the marker', async () => {
  const ws = tempWorkspace();
  try {
    await seedObject(ws.dir, { id: 'l1', title: '要留的', content: '保重', tags: ['keep'] });
    await mkdir(path.join(ws.dir, 'state', 'inbox-originals'), { recursive: true });
    await writeFile(path.join(ws.dir, 'state', 'inbox-originals', 'l1.bin'), '<p>original</p>', 'utf8');
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({}));
    const finalMeta = await inbox.moveToLibrary('l1');
    assert.equal(finalMeta.space, 'library');
    assert.equal(finalMeta.migration, undefined);
    assert.equal(existsSync(path.join(ws.dir, 'inbox', 'l1')), false);
    assert.equal(readFileSync(path.join(ws.dir, 'library', 'l1', 'content.md'), 'utf8'), '保重');
    assert.equal(readFileSync(path.join(ws.dir, 'library', 'l1', 'source', 'original.html'), 'utf8'), '<p>original</p>');
    const libMeta = JSON.parse(readFileSync(path.join(ws.dir, 'library', 'l1', 'meta.json'), 'utf8'));
    assert.equal(libMeta.space, 'library');
    assert.equal(libMeta.migration, undefined);
    assert.equal(existsSync(path.join(ws.dir, 'state', 'inbox-originals', 'l1.bin')), false);
  } finally { ws.cleanup(); }
});

test('moveToLibrary refuses to overwrite an existing foreign library object', async () => {
  const ws = tempWorkspace();
  try {
    await seedObject(ws.dir, { id: 'c1' });
    await mkdir(path.join(ws.dir, 'library', 'c1'), { recursive: true });
    await writeFile(path.join(ws.dir, 'library', 'c1', 'meta.json'), JSON.stringify({ id: 'c1', space: 'library' }));
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({}));
    await assert.rejects(() => inbox.moveToLibrary('c1'), /资料库已存在同 ID 对象/);
    // The inbox source survives the refusal.
    assert.ok(existsSync(path.join(ws.dir, 'inbox', 'c1', 'meta.json')));
  } finally { ws.cleanup(); }
});

test('importMarkdown derives a title and records the source kind', async () => {
  const ws = tempWorkspace();
  try {
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({}));
    const item = await inbox.importMarkdown({ filename: 'notes.md', content: '# 我的笔记\n\n内容' });
    assert.equal(item.title, '我的笔记');
    assert.equal(item.source.kind, 'markdown-import');
    assert.equal(item.source.originalFilename, 'notes.md');
    const stored = await inbox.get(item.id);
    assert.ok(stored.content.startsWith('# 我的笔记'));
  } finally { ws.cleanup(); }
});

test('ids are validated against traversal', async () => {
  const ws = tempWorkspace();
  try {
    const inbox = new WorkspaceInbox(ws.dir, quietLogger, fetcherOf({}));
    await assert.rejects(() => inbox.get('../state'), /非法对象 id/);
    await assert.rejects(() => inbox.get('.hidden'), /非法对象 id/);
  } finally { ws.cleanup(); }
});

// ---------------------------------------------------------------------------
// htmlToMarkdown
// ---------------------------------------------------------------------------

test('htmlToMarkdown: headings, emphasis, links, images', () => {
  const markdown = htmlToMarkdown('<h1>标题</h1><p>你好 <strong>世界</strong>，<em>轻</em> <del>删</del>。<a href="https://a.b/c">锚</a> <img src="https://a.b/i.png" alt="图"></p>');
  assert.ok(markdown.includes('# 标题'));
  assert.ok(markdown.includes('**世界**'));
  assert.ok(markdown.includes('*轻*'));
  assert.ok(markdown.includes('~~删~~'));
  assert.ok(markdown.includes('[锚](https://a.b/c)'));
  assert.ok(markdown.includes('![图](https://a.b/i.png)'));
});

test('htmlToMarkdown: nested lists keep order and nesting', () => {
  const markdown = htmlToMarkdown('<ul><li>一</li><li>二<ol><li>2.1</li><li>2.2</li></ol></li><li>三</li></ul>');
  const lines = markdown.split('\n');
  assert.ok(lines.includes('- 一'));
  assert.ok(lines.some((line) => line.startsWith('  1. 2.1')));
  assert.ok(lines.some((line) => line.startsWith('  2. 2.2')));
});

test('htmlToMarkdown: fenced code, blockquote, hr, table', () => {
  const markdown = htmlToMarkdown([
    '<pre><code class="language-js">const x = 1;</code></pre>',
    '<blockquote><p>引用</p></blockquote>',
    '<hr>',
    '<table><thead><tr><th>名</th><th>值</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>',
  ].join(''));
  assert.ok(markdown.includes('```js\nconst x = 1;\n```'));
  assert.ok(markdown.includes('> 引用'));
  assert.ok(markdown.includes('---'));
  assert.ok(markdown.includes('| 名 | 值 |'));
  assert.ok(markdown.includes('| a | 1 |'));
});

test('htmlToMarkdown: literal markdown specials in text are escaped', () => {
  const markdown = htmlToMarkdown('<p>1. 不是列表 *也不是强调* [也不是链接]</p>');
  // The paragraph keeps its literal characters on one line.
  assert.ok(markdown.includes('1\\. 不是列表'));
  assert.ok(markdown.includes('\\*也不是强调\\*'));
});

test('htmlToMarkdown: caps runaway documents', () => {
  const markdown = htmlToMarkdown(`<p>${'x'.repeat(10)}</p>`.repeat(50_000), { maxLength: 1000 });
  assert.ok(markdown.length < 1100);
  assert.ok(markdown.includes('已截断'));
});
