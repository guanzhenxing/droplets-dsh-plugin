import test from 'node:test';
import assert from 'node:assert/strict';
import { tempHome, fakeCtx } from './helpers.mjs';

const { DropletsService } = await import('../src/host/index.js');
const { groupAndSortFeeds, sortFeedList, partitionFeedItems, snapshotReadItems, sortManageFeeds } = await import('../src/client/feed/feed-sorting.js');

async function seeded() {
  const home = tempHome();
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  await service.ready;
  const mk = (id, name, group, n) => ({
    id, url: 'https://' + id + '/feed', name, group: group || undefined, enabled: true,
    entries: Array.from({ length: n }, (_, i) => ({
      key: id + '|e' + i, title: name + ' #' + i, url: 'https://' + id + '/' + i,
      publishedAt: new Date(2025, 0, 1 + i).toISOString(), html: '<p>body ' + i + '</p>', summary: 's' + i,
    })),
  });
  service.store.data.subscriptions.push(mk('feed:a', 'Alpha', 'Tech', 3), mk('feed:b', 'Beta', 'Tech', 2), mk('feed:c', 'Gamma', '', 2));
  return { service, ctx, home };
}

test('listFeeds returns the droplets RssFeed shape', async () => {
  const { service, ctx, home } = await seeded();
  try {
    const { feeds } = await service.listFeeds();
    assert.equal(feeds.length, 3);
    const alpha = feeds.find((f) => f.id === 'feed:a');
    assert.equal(alpha.title, 'Alpha');
    assert.equal(alpha.groupName, 'Tech');
    assert.equal(alpha.enabled, true);
    assert.equal(alpha.unreadCount, 3);
    assert.equal(alpha.itemCount, 3);
    assert.equal(alpha.lastError, null);
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});

test('listItems scopes by sourceId / groupName and carries three states', async () => {
  const { service, ctx, home } = await seeded();
  try {
    const all = await service.listItems({});
    assert.equal(all.items.length, 7);
    assert.ok(all.items.every((item) => item.state === 'unseen'));

    const tech = await service.listItems({ groupName: 'Tech' });
    assert.equal(tech.items.length, 5);

    const alpha = await service.listItems({ sourceId: 'feed:a' });
    assert.equal(alpha.items.length, 3);
    assert.ok(alpha.items.every((item) => item.sourceId === 'feed:a'));

    await service.setItemState({ keys: ['feed:a|e0'], state: 'seen' });
    await service.setItemState({ keys: ['feed:a|e1'], state: 'skipped' });
    const mixed = await service.listItems({ sourceId: 'feed:a' });
    assert.equal(mixed.items.find((item) => item.key === 'feed:a|e0').state, 'seen');
    assert.equal(mixed.items.find((item) => item.key === 'feed:a|e1').state, 'skipped');
    await service.setItemState({ keys: ['feed:a|e0'], state: 'unseen' });
    const cleared = await service.listItems({ sourceId: 'feed:a' });
    assert.equal(cleared.items.find((item) => item.key === 'feed:a|e0').state, 'unseen');

    const { feeds } = await service.listFeeds();
    assert.equal(feeds.find((f) => f.id === 'feed:a').unreadCount, 2);
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});

test('markAllRead scopes: group / feed / all', async () => {
  const { service, ctx, home } = await seeded();
  try {
    const group = await service.markAllRead({ groupName: 'Tech' });
    assert.equal(group.marked, 5);
    const alpha = await service.listFeeds();
    assert.equal(alpha.feeds.find((f) => f.id === 'feed:a').unreadCount, 0);
    assert.equal(alpha.feeds.find((f) => f.id === 'feed:c').unreadCount, 2);

    const one = await service.markAllRead({ sourceId: 'feed:c' });
    assert.equal(one.marked, 2);
    const afterAll = await service.listItems({});
    assert.ok(afterAll.items.every((item) => item.state !== 'unseen'));
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});

test('setFeed renames, regroups and disables (disabled feeds skip refresh)', async () => {
  const { service, ctx, home } = await seeded();
  try {
    await service.setFeed({ id: 'feed:a', patch: { name: 'Alpha2', group: 'News', enabled: false } });
    const { feeds } = await service.listFeeds();
    const alpha = feeds.find((f) => f.id === 'feed:a');
    assert.equal(alpha.title, 'Alpha2');
    assert.equal(alpha.groupName, 'News');
    assert.equal(alpha.enabled, false);
    const outcome = await service.refresh({});
    assert.equal(outcome.feeds, 2, 'disabled feed excluded from refresh');
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});

test('legacy read map migrates to seen states', async () => {
  const home = tempHome();
  const { DropletsStore, storageDir } = await import('../src/host/store.js');
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const path = await import('node:path');
  try {
    const dir = storageDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ version: 1, subscriptions: [], read: { 'feed:x|1': 12345, 'feed:x|2': 12345 }, favorites: {} }));
    const store = new DropletsStore(console);
    await store.load();
    assert.equal(store.data.states['feed:x|1'], 'seen');
    assert.equal(Object.keys(store.data.read).length, 0);
  } finally { home.cleanup(); }
});

test('feed-sorting: unread-desc default, ungrouped sinks last', () => {
  const feeds = [
    { id: '1', title: 'A', groupName: 'G1', unreadCount: 1 },
    { id: '2', title: 'B', groupName: '', unreadCount: 9 },
    { id: '3', title: 'C', groupName: 'G1', unreadCount: 5 },
    { id: '4', title: 'D', groupName: 'G0', unreadCount: 3 },
  ];
  const grouped = groupAndSortFeeds(feeds, 'unread-desc');
  assert.deepEqual(grouped.map(([name]) => name), ['G1', 'G0', '']);
  assert.deepEqual(grouped[0][1].map((f) => f.id), ['3', '1']);
  assert.deepEqual(sortFeedList(feeds, 'name-asc').map((f) => f.id), ['1', '2', '3', '4']);
  assert.deepEqual(sortFeedList(feeds, 'default').map((f) => f.id), ['1', '2', '3', '4']);
});

test('feed-sorting: partition freezes read rows at list entry', () => {
  const items = [
    { sourceId: 'a', key: '1', state: 'unseen' },
    { sourceId: 'a', key: '2', state: 'seen' },
    { sourceId: 'a', key: '3', state: 'unseen' },
  ];
  const snapshot = snapshotReadItems(items);
  assert.deepEqual([...snapshot], ['a:2']);
  // Session marks #1 read after entry: it stays in the unread partition.
  const after = [
    { sourceId: 'a', key: '1', state: 'seen' },
    { sourceId: 'a', key: '2', state: 'seen' },
    { sourceId: 'a', key: '3', state: 'unseen' },
  ];
  assert.deepEqual(partitionFeedItems(after, snapshot).map((i) => i.key), ['1', '3', '2']);
  // A fresh arrival (not in the snapshot) also lands unread-first.
  const refreshed = [...after, { sourceId: 'a', key: '4', state: 'unseen' }];
  assert.deepEqual(partitionFeedItems(refreshed, snapshot).map((i) => i.key), ['1', '3', '4', '2']);
});

test('feed-sorting: manage table sinks disabled feeds', () => {
  const feeds = [
    { id: 'on', title: 'B', groupName: '', enabled: true, unreadCount: 0, lastFetchAt: 5, lastError: null },
    { id: 'off', title: 'A', groupName: '', enabled: false, unreadCount: 0, lastFetchAt: 9, lastError: null },
    { id: 'err', title: 'C', groupName: '', enabled: true, unreadCount: 0, lastFetchAt: 1, lastError: 'x' },
  ];
  // Enabled layer first (title order inside it), disabled sinks regardless of column.
  assert.deepEqual(sortManageFeeds(feeds, 'title', true).map((f) => f.id), ['on', 'err', 'off']);
  assert.deepEqual(sortManageFeeds(feeds, 'health', true).map((f) => f.id), ['err', 'on', 'off']);
});

test('inbox list treats doneAt: null as not done (legacy records)', async () => {
  const home = tempHome();
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  await service.ready;
  try {
    service.store.data.inbox.push({
      key: 'inbox:legacy', url: 'https://x.example/a', title: 'Legacy', kind: 'web',
      addedAt: 1, readAt: null, doneAt: null, bytes: 1, file: null, status: 'ready', excerpt: '',
    });
    const { items } = await service.inboxList({});
    assert.ok(items.some((item) => item.key === 'inbox:legacy'), 'doneAt:null item must stay visible');
    const removed = await service.inboxMarkDone({ key: 'inbox:legacy' });
    assert.equal(removed.removed, true);
    const after = await service.inboxList({});
    assert.ok(!after.items.some((item) => item.key === 'inbox:legacy'));
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});
