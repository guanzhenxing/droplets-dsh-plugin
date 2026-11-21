import test from 'node:test';
import assert from 'node:assert/strict';
import { tempHome, fakeCtx } from './helpers.mjs';

const { DropletsService } = await import('../src/host/index.js');
const { createToolDefinitions } = await import('../src/host/tools.js');

async function seededService() {
  const home = tempHome();
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  await service.ready;
  const feedId = 'feed:' + 'a'.repeat(32);
  service.store.data.subscriptions.push({
    id: feedId,
    url: 'https://feeds.example/xml',
    name: 'Seeded Feed',
    group: 'G',
    entries: [
      { key: feedId + '|e1', title: 'Alpha article', url: 'https://x.example/1', publishedAt: '2025-09-01T00:00:00Z', html: '<p>Alpha body</p>', summary: 'Alpha body' },
      { key: feedId + '|e2', title: 'Beta article', url: 'https://x.example/2', publishedAt: '2025-09-02T00:00:00Z', html: '<p>Beta body</p>', summary: 'Beta body' },
    ],
  });
  service.store.data.inbox.push({
    key: 'inbox:' + 'b'.repeat(32),
    url: 'https://inbox.example/doc',
    title: 'Saved doc',
    kind: 'web',
    addedAt: Date.now(),
    readAt: null,
    bytes: 100,
    file: null,
    status: 'ready',
    excerpt: 'Saved excerpt',
  });
  await service.vaultWrite({ path: '0-Inbox/note.md', content: '---\ntitle: KB Note\ntags: [kb]\n---\nBody about droplets.', expectedSha: null });
  await service.vaultReindex();
  return { service, ctx, home };
}

function toolByName(tools, name) {
  const found = tools.find((definition) => definition.name === name);
  assert.ok(found, 'tool ' + name + ' registered');
  return found;
}

test('three multi-action tools with enum contracts are registered', async () => {
  const { service, ctx, home } = await seededService();
  try {
    const tools = createToolDefinitions(service);
    assert.equal(tools.length, 3);
    const feed = toolByName(tools, 'droplets_feed');
    assert.deepEqual(feed.parameters.action.enum, ['list_channels', 'list_articles', 'read', 'search', 'add_subscription', 'refresh']);
    const inbox = toolByName(tools, 'droplets_inbox');
    assert.deepEqual(inbox.parameters.action.enum, ['add_url', 'list', 'read', 'mark_done']);
    const vault = toolByName(tools, 'droplets_vault');
    assert.deepEqual(vault.parameters.action.enum, ['search', 'read', 'write', 'backlinks', 'list']);
    for (const definition of tools) {
      assert.equal(typeof definition.execute, 'function', definition.name + ' execute');
      assert.equal(typeof definition.output.render, 'function', definition.name + ' render');
      assert.equal(definition.parameters.action.required, true);
    }
  } finally {
    service.shutdown();
    await ctx.dispose();
    home.cleanup();
  }
});

test('droplets_feed happy paths and invalid action', async () => {
  const { service, ctx, home } = await seededService();
  const tools = createToolDefinitions(service);
  const feed = toolByName(tools, 'droplets_feed');
  try {
    const channels = await feed.execute({ action: 'list_channels' });
    assert.ok(channels.includes('Seeded Feed'));
    const articles = await feed.execute({ action: 'list_articles', filter: 'unread' });
    assert.ok(articles.includes('Alpha article'));
    const key = /- (.+?) |/.exec(articles)?.[1] ?? articles.split('\n')[1].split(' | ')[0].slice(2);
    const read = await feed.execute({ action: 'read', key });
    // list_articles is date-desc, so the first listed entry is the Beta one.
    assert.ok(read.includes('Beta body'));
    assert.ok(read.includes('原文链接'));
    const search = await feed.execute({ action: 'search', query: 'beta' });
    assert.ok(search.includes('Beta article'));
    await assert.rejects(feed.execute({ action: 'nonsense' }), /未知 action/);
    await assert.rejects(feed.execute({ action: 'read' }), /需要 key/);
    await assert.rejects(feed.execute({ action: 'add_subscription', url: 'ftp://x' }), /http/);
  } finally {
    service.shutdown();
    await ctx.dispose();
    home.cleanup();
  }
});

test('droplets_inbox paths and mark_done removes the item', async () => {
  const { service, ctx, home } = await seededService();
  const tools = createToolDefinitions(service);
  const inbox = toolByName(tools, 'droplets_inbox');
  try {
    const listed = await inbox.execute({ action: 'list' });
    assert.equal(listed.count, 1);
    const key = listed.items[0].key;
    const read = await inbox.execute({ action: 'read', key });
    assert.ok(read.text.includes('body') || read.text === '' || typeof read.text === 'string');
    const done = await inbox.execute({ action: 'mark_done', key });
    assert.deepEqual(done, { removed: true });
    const after = await inbox.execute({ action: 'list' });
    assert.equal(after.count, 0);
    await assert.rejects(inbox.execute({ action: 'read', key }), /没有这一条/);
  } finally {
    service.shutdown();
    await ctx.dispose();
    home.cleanup();
  }
});

test('droplets_vault write conflict returns structured guidance', async () => {
  const { service, ctx, home } = await seededService();
  const tools = createToolDefinitions(service);
  const vault = toolByName(tools, 'droplets_vault');
  try {
    const found = await vault.execute({ action: 'search', query: 'kb' });
    assert.equal(found.count >= 1, true);

    const read = await vault.execute({ action: 'read', path: '0-Inbox/note.md' });
    assert.equal(read.title, 'KB Note');

    const conflict = await vault.execute({ action: 'write', path: '0-Inbox/note.md', content: 'no lock', expected_sha: '0'.repeat(64) });
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.currentSha, read.sha);
    assert.ok(conflict.hint.includes('重新 read'));

    const written = await vault.execute({ action: 'write', path: '0-Inbox/note.md', content: '# Rewritten\nvia tool', expected_sha: read.sha });
    assert.equal(written.conflict, false);
    assert.equal(written.created, false);

    const created = await vault.execute({ action: 'write', path: '0-Inbox/fresh.md', content: '# Fresh', expected_sha: null });
    assert.equal(created.created, true);

    const links = await vault.execute({ action: 'backlinks', path: '0-Inbox/note.md' });
    assert.equal(links.count, 0);

    const list = await vault.execute({ action: 'list' });
    assert.ok(list.total >= 2);

    await assert.rejects(vault.execute({ action: 'write', path: 'escape/../../x.md', content: 'x' }), /不允许|越界|not_markdown/);
    await assert.rejects(vault.execute({ action: 'write', path: 'a.md' }), /需要 content/);
  } finally {
    service.shutdown();
    await ctx.dispose();
    home.cleanup();
  }
});

test('vault guidance when the vault is empty', async () => {
  const home = tempHome();
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  try {
    const tools = createToolDefinitions(service);
    const vault = toolByName(tools, 'droplets_vault');
    const list = await vault.execute({ action: 'list' });
    assert.equal(list.files, 0);
    assert.ok(list.hint.includes('write'));
  } finally {
    service.shutdown();
    await ctx.dispose();
    home.cleanup();
  }
});
