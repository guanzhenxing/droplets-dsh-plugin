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
