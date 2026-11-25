import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tempHome, fakeCtx } from './helpers.mjs';

const { DropletsService } = await import('../src/host/index.js');
const { createGuardedFetch } = await import('../src/host/guarded-fetch.js');
const { WorkspaceStore } = await import('../src/host/workspace-store.js');

const LOOPBACK_FETCHER = createGuardedFetch({
  resolver: { async resolve() { return ['127.0.0.1']; } },
  ipPolicy: (ip) => ip === '127.0.0.1',
  portGate: () => true,
});

const RSS_BODY = (title) => '<?xml version="1.0"?><rss version="2.0"><channel><title>' + title + '</title>' +
  '<item><title>Entry A</title><link>https://example.com/a</link><guid>a-' + title + '</guid>' +
  '<description><![CDATA[<p>Body A</p>]]></description></item></channel></rss>';

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function makeService() {
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  service.fetcher = LOOPBACK_FETCHER;
  return { ctx, service };
}

test('surfaces: subscriptions default to rss, news is explicit and scoping filters both ways', async () => {
  const home = tempHome();
  const feed = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(RSS_BODY('Blog Source'));
  });
  const news = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(RSS_BODY('News Source'));
  });
  const { ctx, service } = await makeService();
  try {
    await service.addSubscription({ url: 'http://loopback.test:' + feed.port + '/feed' });
    await service.addSubscription({ url: 'http://loopback.test:' + news.port + '/feed', surface: 'news' });

    const { feeds } = await service.listFeeds();
    const byTitle = new Map(feeds.map((f) => [f.title, f]));
    assert.equal(byTitle.get('Blog Source').surface, 'rss', 'absent surface means rss');
    assert.equal(byTitle.get('News Source').surface, 'news');

    const rssItems = await service.listItems({ surface: 'rss' });
    assert.equal(rssItems.items.filter((i) => i.sourceId === byTitle.get('News Source').id).length, 0);
    assert.ok(rssItems.items.some((i) => i.sourceId === byTitle.get('Blog Source').id));

    const newsItems = await service.listItems({ surface: 'news' });
    assert.equal(newsItems.items.length, 1);
    assert.equal(newsItems.items[0].sourceId, byTitle.get('News Source').id);

    const { subscriptions } = await service.listSubscriptions();
    assert.equal(subscriptions.find((s) => s.name === 'News Source').surface, 'news');

    const { channels } = await service.listChannels();
    const feedChannels = channels.filter((c) => c.kind === 'feed');
    assert.equal(feedChannels.find((c) => c.name === 'News Source').surface, 'news');
  } finally {
    await feed.close();
    await news.close();
    await ctx.dispose();
    home.cleanup();
  }
});

test('surfaces: setFeed moves a subscription between surfaces and it persists across reloads', async () => {
  const home = tempHome();
  const feed = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(RSS_BODY('Move Me'));
  });
  const { ctx, service } = await makeService();
  try {
    const added = await service.addSubscription({ url: 'http://loopback.test:' + feed.port + '/feed' });
    const { feeds } = await service.listFeeds();
    assert.equal(feeds[0].surface, 'rss');

    await service.setFeed({ id: added.id, patch: { surface: 'news' } });
    const moved = await service.listFeeds();
    assert.equal(moved.feeds[0].surface, 'news');
    const newsOnly = await service.listItems({ surface: 'news' });
    assert.equal(newsOnly.items.length, 1);
    const rssOnly = await service.listItems({ surface: 'rss' });
    assert.equal(rssOnly.items.length, 0);

    // Reload: a fresh service over the same storage keeps the assignment.
    await service.shutdown();
    const ctx2 = fakeCtx();
    const service2 = new DropletsService(ctx2, {});
    service2.fetcher = LOOPBACK_FETCHER;
    const reloaded = await service2.listFeeds();
    assert.equal(reloaded.feeds[0].surface, 'news', 'surface survives a reload');
    await ctx2.dispose();
  } finally {
    await feed.close();
    await ctx.dispose();
    home.cleanup();
  }
});

test('surfaces: removing a subscription drops its surface entry', async () => {
  const home = tempHome();
  const feed = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(RSS_BODY('Doomed'));
  });
  const { ctx, service } = await makeService();
  try {
    const added = await service.addSubscription({ url: 'http://loopback.test:' + feed.port + '/feed', surface: 'news' });
    await service.removeSubscription({ id: added.id });
    assert.equal(Object.keys(service.store.data.surfaces ?? {}).length, 0);
  } finally {
    await feed.close();
    await ctx.dispose();
    home.cleanup();
  }
});

test('surfaces: shared Droplets workspace keeps them in the .droplets-dsh sidecar', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsws-surface-'));
  await import('node:fs/promises').then((fs) => fs.mkdir(path.join(root, 'state'), { recursive: true }));
  const { DatabaseSync } = await import('node:sqlite');
  const app = new DatabaseSync(path.join(root, 'state', 'app.sqlite'));
  app.exec('CREATE TABLE feeds(id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL UNIQUE, group_name TEXT NOT NULL DEFAULT \'\', enabled INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL, last_fetch_at REAL, last_error TEXT, site_url TEXT NOT NULL DEFAULT \'\', refresh_strategy TEXT NOT NULL DEFAULT \'follow\', show_unread_badge INTEGER NOT NULL DEFAULT 1, include_in_all INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT \'\', consecutive_failures INTEGER NOT NULL DEFAULT 0, last_success_at REAL)');
  app.exec('CREATE TABLE rss_item_state(source_id TEXT, item_key TEXT, state TEXT, updated_at REAL, PRIMARY KEY(source_id, item_key))');
  app.prepare('INSERT INTO feeds (id, title, url, created_at) VALUES (?, ?, ?, ?)').run('n1', 'Native News', 'https://n.example/feed', 1795000000);
  app.close();
  const idx = new DatabaseSync(path.join(root, 'state', 'index.sqlite'));
  idx.exec('CREATE TABLE rss_item(source_id TEXT NOT NULL, item_key TEXT NOT NULL, title TEXT NOT NULL, link TEXT NOT NULL DEFAULT \'\', summary TEXT NOT NULL DEFAULT \'\', content TEXT NOT NULL DEFAULT \'\', published_at TEXT, source_title TEXT NOT NULL DEFAULT \'\', fetched_at REAL NOT NULL, tags TEXT, enclosure TEXT, content_html TEXT NOT NULL DEFAULT \'\', item_hash TEXT, PRIMARY KEY(source_id, item_key))');
  idx.close();

  const store = new WorkspaceStore(console, root);
  await store.load();
  try {
    store.data.surfaces['n1'] = 'news';
    await store.flush();
    const reloaded = new WorkspaceStore(console, root);
    await reloaded.load();
    assert.equal(reloaded.data.surfaces['n1'], 'news', 'surface round-trips through the sidecar');
    await reloaded.dispose();
  } finally {
    await store.dispose();
  }
});
