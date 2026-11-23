import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tempHome, fakeCtx } from './helpers.mjs';

// The peer stubs (register-peers.mjs) make these imports host-free.
const { DropletsService, Config } = await import('../src/host/index.js');
const { createGuardedFetch } = await import('../src/host/guarded-fetch.js');

const LOOPBACK_FETCHER = createGuardedFetch({
  resolver: { async resolve() { return ['127.0.0.1']; } },
  ipPolicy: (ip) => ip === '127.0.0.1',
  portGate: () => true,
});

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

const RSS_BODY = '<?xml version="1.0"?><rss version="2.0"><channel><title>Local Feed</title>' +
  '<item><title>Entry One</title><link>https://example.com/one</link><guid>e1</guid>' +
  '<description><![CDATA[<p>Body one <script>bad()</script></p>]]></description></item>' +
  '<item><title>Entry Two</title><link>https://example.com/two</link><guid>e2</guid></item>' +
  '</channel></rss>';

test('Config validates the four documented keys and rejects unknown ones', () => {
  const ok = Config['~standard'].validate({ vaultPath: '/tmp/v', refreshInterval: 120000, maxBodies: 50, enableTranslation: false });
  assert.deepEqual(Object.keys(ok.value).sort(), ['enableTranslation', 'maxBodies', 'refreshInterval', 'vaultPath']);
  assert.equal(ok.value.refreshInterval, 120000);
  const clamped = Config['~standard'].validate({ refreshInterval: 1000 });
  assert.equal(clamped.value.refreshInterval, 60000, 'refreshInterval clamps to the 60s floor');
  const bad = Config['~standard'].validate({ nonsense: true });
  assert.ok(bad.issues.length > 0);
  const badType = Config['~standard'].validate({ maxBodies: 'many' });
  assert.ok(badType.issues.length > 0);
});

test('feed flow: subscribe, list, read, favorite, refresh keeps dedup state', async () => {
  const home = tempHome();
  const feed = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(RSS_BODY);
  });
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  service.fetcher = LOOPBACK_FETCHER;
  try {
    const added = await service.addSubscription({ url: 'http://loopback.test:' + feed.port + '/feed' });
    assert.equal(added.status, 'ok');
    assert.equal(added.entryCount, 2);

    const { channels } = await service.listChannels();
    assert.equal(channels[0].key, 'all');
    assert.equal(channels[0].unread, 2);
    const feedChannel = channels.find((channel) => channel.kind === 'feed');
    assert.equal(feedChannel.name, 'Local Feed');

    const page = await service.listEntries({ channel: feedChannel.key, filter: 'unread' });
    assert.equal(page.entries.length, 2);
    const entry = page.entries[0];
    assert.equal(entry.title, 'Entry One');
    assert.equal(entry.hasBody, true);

    const read = await service.getEntry({ key: entry.key });
    assert.ok(read.html.includes('Body one'));
    assert.ok(!read.html.includes('script'), 'ingestion sanitizes');

    await service.setRead({ keys: [entry.key], read: true });
    await service.setFavorite({ key: entry.key, favorite: true });
    const afterRead = await service.listEntries({ channel: feedChannel.key, filter: 'unread' });
    assert.equal(afterRead.entries.length, 1);
    const favorites = await service.listEntries({ channel: feedChannel.key, filter: 'favorite' });
    assert.equal(favorites.entries.length, 1);

    // Refresh merges by stable key: still 2 entries, read state preserved.
    const outcome = await service.refresh({});
    assert.equal(outcome.feeds, 1);
    const reloaded = await service.listEntries({ channel: feedChannel.key });
    assert.equal(reloaded.entries.length, 2);
    assert.equal(reloaded.entries.find((item) => item.key === entry.key).read, true);
    assert.equal(reloaded.entries.find((item) => item.key === entry.key).favorite, true);

    const search = await service.searchEntries({ query: 'entry two' });
    assert.equal(search.length, 1);
  } finally {
    service.shutdown();
    await ctx.dispose();
    await feed.close();
    home.cleanup();
  }
});

test('inbox flow: add url, background fetch lands markdown, mark done trashes', async () => {
  const home = tempHome();
  const site = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Doc</title></head><body><main><article><p>' + 'Real content. '.repeat(40) + '</p></article></main></body></html>');
  });
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  service.fetcher = LOOPBACK_FETCHER;
  service.inbox.fetcherProvider = () => LOOPBACK_FETCHER;
  try {
    const { item, duplicate } = await service.inboxAddUrl({ url: 'http://loopback.test:' + site.port + '/page' });
    assert.equal(duplicate, false);
    assert.equal(item.status, 'unread');
    // Wait out the background fetch chain, then the outcome is on disk.
    await service.inbox.runExclusive(item.id, () => Promise.resolve());
    const detail = await service.inboxGet({ id: item.id });
    assert.equal(detail.item.title, 'Doc');
    assert.equal(detail.item.objectType, 'article');
    assert.ok(detail.content.includes('Real content'));

    const read = await service.inboxRead({ key: item.id });
    assert.ok(read.content.includes('Real content'));
    assert.ok(read.text.includes('Real content'));

    const again = await service.inboxAddUrl({ url: 'http://loopback.test:' + site.port + '/page' });
    assert.equal(again.duplicate, true);

    const marked = await service.inboxUpdate({ id: item.id, patch: { status: 'finished' } });
    assert.equal(marked.item.status, 'finished');

    const removed = await service.inboxMarkDone({ key: item.id });
    assert.deepEqual(removed, { removed: true, trashed: true });
    const { items } = await service.inboxList({});
    assert.equal(items.length, 0);
  } finally {
    service.shutdown();
    await ctx.dispose();
    await site.close();
    home.cleanup();
  }
});

test('vault flow: default skeleton, write/read/backlinks/search, conflict lock', async () => {
  const home = tempHome();
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  try {
    const status = await service.vaultStatus();
    assert.equal(status.files, 0);
    assert.ok(status.root.includes(path.join('storages', 'droplets-dsh')));

    const written = await service.vaultWrite({ path: '0-Inbox/first.md', content: '# First\nlinks [[second]]', expectedSha: null });
    assert.equal(written.conflict, false);
    assert.equal(written.created, true);

    const second = await service.vaultWrite({ path: '0-Inbox/second.md', content: '# Second\ntags: #kb', expectedSha: null });
    await service.vaultReindex();

    const read = await service.vaultRead({ path: '0-Inbox/first.md' });
    assert.equal(read.title, 'First');
    assert.ok(read.sha.length === 64);

    const conflict = await service.vaultWrite({ path: '0-Inbox/first.md', content: 'clobber', expectedSha: '0'.repeat(64) });
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.currentSha, read.sha);

    const { backlinks } = await service.vaultBacklinks({ path: '0-Inbox/second.md' });
    assert.equal(backlinks.length, 1);
    assert.equal(backlinks[0].path, '0-Inbox/first.md');

    const { results } = await service.vaultSearch({ query: 'second' });
    assert.ok(results.some((result) => result.path === '0-Inbox/second.md'));

    const graph = await service.vaultGraph();
    assert.ok(graph.nodes.length >= 2);

    const { tree } = await service.vaultTree();
    assert.ok(tree.dirs.some((dir) => dir.name === '0-Inbox'));
  } finally {
    service.shutdown();
    await ctx.dispose();
    home.cleanup();
  }
});

test('setReadingContext validation and prompt building', async () => {
  const home = tempHome();
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  try {
    await assert.rejects(service.setReadingContext({ sessionId: '' }), /无效会话/);
    await assert.rejects(service.setReadingContext({ sessionId: 's'.repeat(200) }), /无效会话/);
    await assert.rejects(service.setReadingContext({ sessionId: 'ok', material: { space: 'feed', title: '' } }), /缺少标题/);
    await assert.rejects(service.setReadingContext({ sessionId: 'ok', material: { space: 'feed', title: 't', content: 42 } }), /字符串/);
    const ok = await service.setReadingContext({ sessionId: 'sess-1', material: { space: 'feed', title: 'T', content: 'C' } });
    assert.deepEqual(ok, { ok: true });
    const { prompt } = await service.prepareChat({ material: { space: 'feed', title: 'T' }, question: '为什么?' });
    assert.ok(prompt.includes('为什么?'));
  } finally {
    service.shutdown();
    await ctx.dispose();
    home.cleanup();
  }
});

test('companion context reaches the systemPrompt injection', async () => {
  const home = tempHome();
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  let registered = null;
  try {
    // fakeCtx records inject callbacks; run the systemPrompt one manually.
    const injection = ctx.__injections.find((entry) => entry.names.includes('systemPrompt'));
    assert.ok(injection, 'service subscribes to systemPrompt');
    const scope = {
      systemPrompt: { context(def) { registered = def; } },
    };
    injection.callback(scope);
    assert.equal(registered.name, 'droplets:reading');
    assert.equal(registered.order, 9500);
    assert.equal(registered.interpolate, false);
    await service.setReadingContext({ sessionId: 'sx', material: { space: 'inbox', title: 'M', content: 'BODY' } });
    assert.ok(registered.text({ agent: { session: { id: 'sx' } } }).includes('BODY'));
    assert.equal(registered.text({ agent: { session: { id: 'other' } } }), '');
  } finally {
    service.shutdown();
    await ctx.dispose();
    home.cleanup();
  }
});
