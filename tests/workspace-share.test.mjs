import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FS_SCHEMA = `CREATE TABLE feeds(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL UNIQUE,
  group_name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL, last_fetch_at REAL, last_error TEXT,
  site_url TEXT NOT NULL DEFAULT '', refresh_strategy TEXT NOT NULL DEFAULT 'follow',
  show_unread_badge INTEGER NOT NULL DEFAULT 1, include_in_all INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '', consecutive_failures INTEGER NOT NULL DEFAULT 0, last_success_at REAL);
CREATE TABLE rss_item_state(source_id TEXT, item_key TEXT, state TEXT, updated_at REAL, PRIMARY KEY(source_id, item_key));`;

const INDEX_SCHEMA = `CREATE TABLE rss_item(
  source_id TEXT NOT NULL, item_key TEXT NOT NULL, title TEXT NOT NULL,
  link TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '', published_at TEXT,
  source_title TEXT NOT NULL DEFAULT '', fetched_at REAL NOT NULL,
  tags TEXT, enclosure TEXT, content_html TEXT NOT NULL DEFAULT '', item_hash TEXT,
  PRIMARY KEY(source_id, item_key));`;

/** Build a minimal workspace that mirrors the Droplets layout. */
async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'dsws-'));
  await mkdir(join(root, 'state'), { recursive: true });
  await mkdir(join(root, 'vault'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const app = new DatabaseSync(join(root, 'state', 'app.sqlite'));
  app.exec(FS_SCHEMA);
  app.prepare('INSERT INTO feeds (id, title, url, group_name, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run('abc-feed', 'TypeScript Blog', 'https://ts.example/feed', 'Tech', 1795000000);
  app.prepare('INSERT INTO rss_item_state (source_id, item_key, state, updated_at) VALUES (?, ?, ?, ?)')
    .run('abc-feed', 'item-1', 'seen', 1795000000);
  app.close();
  const idx = new DatabaseSync(join(root, 'state', 'index.sqlite'));
  idx.exec(INDEX_SCHEMA);
  idx.prepare('INSERT INTO rss_item (source_id, item_key, title, link, summary, content, content_html, published_at, source_title, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('abc-feed', 'item-1', 'Announcing TypeScript 7.1', 'https://ts.example/71', 'Summary here', 'Body', '<p>Body</p>', '2026-10-20T17:53:06.000Z', 'TypeScript Blog', 1795000100);
  idx.prepare('INSERT INTO rss_item (source_id, item_key, title, link, summary, content, content_html, published_at, source_title, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('abc-feed', 'item-2', 'Announcing TypeScript 7.0', 'https://ts.example/70', 'Older', 'Body', '<p>Body</p>', '2026-07-08T15:58:29.000Z', 'TypeScript Blog', 1795000200);
  idx.close();
  return root;
}

test('a Droplets workspace is read as feeds, items and read states', async () => {
  const root = await makeWorkspace();
  const { WorkspaceStore } = await import('../src/host/workspace-store.js');
  const store = new WorkspaceStore(console, root);
  await store.load();
  try {
    assert.equal(store.data.subscriptions.length, 1);
    const sub = store.data.subscriptions[0];
    assert.equal(sub.name, 'TypeScript Blog');
    assert.equal(sub.group, 'Tech');
    assert.equal(sub.entries.length, 2, 'both items load');
    assert.equal(sub.entries[0].title, 'Announcing TypeScript 7.1', 'newest first');
    assert.equal(sub.entries[0].url, 'https://ts.example/71');
    assert.ok(sub.entries[0].html.includes('Body'));
    assert.equal(store.data.states['abc-feed|item-1'], 'seen');
  } finally { await store.dispose(); }
});

test('read state and new subscriptions are written back into the Droplets tables', async () => {
  const root = await makeWorkspace();
  const { WorkspaceStore } = await import('../src/host/workspace-store.js');
  const store = new WorkspaceStore(console, root);
  await store.load();
  store.data.states['abc-feed|item-2'] = 'seen';
  store.data.subscriptions.push({
    id: 'new-feed', url: 'https://new.example/feed', name: 'New Blog', enabled: true,
    createdAt: 1795000300,
    entries: [{ key: 'new-feed|g1', guid: 'g1', title: 'Fresh', url: 'https://new.example/1', summary: 's', html: '<p>h</p>', publishedAt: '2026-11-20T00:00:00.000Z' }],
  });
  await store.flush();
  await store.dispose();

  const { DatabaseSync } = await import('node:sqlite');
  const app = new DatabaseSync(join(root, 'state', 'app.sqlite'));
  assert.equal(app.prepare('SELECT COUNT(*) AS n FROM feeds').get().n, 2, 'new feed inserted');
  const state = app.prepare('SELECT state FROM rss_item_state WHERE source_id=? AND item_key=?').get('abc-feed', 'item-2');
  assert.equal(state.state, 'seen', 'read state shared with Droplets');
  app.close();

  const idx = new DatabaseSync(join(root, 'state', 'index.sqlite'));
  const item = idx.prepare('SELECT title FROM rss_item WHERE source_id=? AND item_key=?').get('new-feed', 'g1');
  assert.equal(item.title, 'Fresh', 'fetched item visible to Droplets');
  idx.close();
});

test('settings live in a sidecar, not in the shared tables', async () => {
  const root = await makeWorkspace();
  const { WorkspaceStore } = await import('../src/host/workspace-store.js');
  const store = new WorkspaceStore(console, root);
  await store.load();
  store.data.settings.refreshMinutes = 30;
  store.data.favorites['abc-feed|item-1'] = true;
  await store.flush();
  await store.dispose();

  const reloaded = new WorkspaceStore(console, root);
  await reloaded.load();
  try {
    assert.equal(reloaded.data.settings.refreshMinutes, 30);
    assert.equal(reloaded.data.favorites['abc-feed|item-1'], true);
  } finally { await reloaded.dispose(); }
});

test('legacy pollution is cleaned on load: duplicate guid-keyed rows dropped, feed: read marks migrated', async () => {
  const root = await makeWorkspace();
  const { DatabaseSync } = await import('node:sqlite');
  const { hashKey } = await import('../src/host/feeds.js');
  // Seed the pollution class the old bug produced: the same article twice
  // (native URL-keyed row + plugin guid-keyed copy) and read marks under a
  // feed:<hash> source id that matches no live feed.
  const idx = new DatabaseSync(join(root, 'state', 'index.sqlite'));
  // Real pollution shape: flush wrote the whole plugin key (feed:<32hex>|<hash>)
  // as item_key for guid-less feeds.
  const pluginKey = `feed:${hashKey('https://ts.example/feed')}|419e0d941736ff29`;
  idx.prepare('INSERT INTO rss_item (source_id, item_key, title, link, summary, content, content_html, published_at, source_title, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('abc-feed', pluginKey, 'Announcing TypeScript 7.1', 'https://ts.example/71', 'Dup', 'Body', '<p>Body</p>', '2026-10-20T17:53:06.000Z', 'TypeScript Blog', 1795000100);
  idx.close();
  const app = new DatabaseSync(join(root, 'state', 'app.sqlite'));
  const feedHash = `feed:${hashKey('https://ts.example/feed')}`;
  app.prepare('INSERT INTO rss_item_state (source_id, item_key, state, updated_at) VALUES (?, ?, ?, ?)')
    .run(feedHash, 'https://ts.example/70', 'seen', 1795000000); // URL-guid mark → migratable
  app.prepare('INSERT INTO rss_item_state (source_id, item_key, state, updated_at) VALUES (?, ?, ?, ?)')
    .run(feedHash, 'urn:uuid:unmatchable', 'skipped', 1795000000); // urn guid → unmatchable
  app.close();

  const { WorkspaceStore } = await import('../src/host/workspace-store.js');
  const store = new WorkspaceStore(console, root);
  await store.load();
  try {
    const sub = store.data.subscriptions[0];
    const titles = sub.entries.map((entry) => entry.title);
    assert.equal(titles.filter((t) => t === 'Announcing TypeScript 7.1').length, 1, 'guid-keyed duplicate dropped, native row kept');
    // Migrated read mark now lives under the native id and applies on load.
    assert.equal(store.data.states['abc-feed|https://ts.example/70'], 'seen', 'URL-guid mark migrated onto the native feed id');
    assert.equal(store.data.states['abc-feed|item-1'], 'seen', 'native states untouched');
  } finally { await store.dispose(); }

  const app2 = new DatabaseSync(join(root, 'state', 'app.sqlite'));
  assert.equal(app2.prepare("SELECT COUNT(*) AS n FROM rss_item_state WHERE source_id LIKE 'feed:%'").get().n, 0, 'orphan feed: rows deleted');
  assert.equal(app2.prepare('SELECT state FROM rss_item_state WHERE source_id=? AND item_key=?').get('abc-feed', 'https://ts.example/70').state, 'seen', 'migrated row persisted');
  app2.close();
  const idx2 = new DatabaseSync(join(root, 'state', 'index.sqlite'));
  assert.equal(idx2.prepare("SELECT COUNT(*) AS n FROM rss_item WHERE item_key LIKE 'feed:%'").get().n, 0, 'plugin-key-namespace rows removed');
  idx2.close();
});

test('shared-mode refresh merges by native keys — no duplicates, read states survive', async () => {
  const root = await makeWorkspace();
  const { tempHome, fakeCtx } = await import('./helpers.mjs');
  const home = tempHome();
  const ctx = fakeCtx();
  const { DropletsService } = await import('../src/host/index.js');
  const service = new DropletsService(ctx, { workspacePath: root });
  await service.ready;
  try {
    assert.ok(service.sharedWorkspace, 'service runs against the shared workspace');
    const before = await service.listItems({ sourceId: 'abc-feed' });
    assert.equal(before.items.length, 2);
    assert.equal(before.items.find((item) => item.key === 'abc-feed|item-1').state, 'seen', 'native read state applies');

    // A refresh serving the same articles under the plugin's own keying
    // (feed:hash|guid — the exact shape the old bug produced).
    const { hashKey } = await import('../src/host/feeds.js');
    const xml = `<?xml version="1.0"?><rss><channel><title>TypeScript Blog</title>
      <item><title>Announcing TypeScript 7.1</title><guid>item-1</guid><link>https://ts.example/71</link><description>Summary here</description></item>
      <item><title>Announcing TypeScript 7.0</title><guid>item-2</guid><link>https://ts.example/70</link><description>Older</description></item>
    </channel></rss>`;
    service.fetcher = { fetch: async () => ({ status: 200, headers: { 'content-type': 'text/xml' }, body: xml }) };
    await service.refresh({ channel: 'abc-feed' });

    const after = await service.listItems({ sourceId: 'abc-feed' });
    assert.equal(after.items.length, 2, 'refresh merges 1:1 by native keys — no phantom copies');
    const dup71 = after.items.filter((item) => item.title === 'Announcing TypeScript 7.1');
    assert.equal(dup71.length, 1, 'the refreshed article replaces its native row instead of duplicating');
    assert.equal(dup71[0].state, 'seen', 'read state survives the refresh (key continuity)');
    assert.ok(after.items.every((item) => item.key.startsWith('abc-feed|')), 'all keys share the native namespace');
    void hashKey;
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});
