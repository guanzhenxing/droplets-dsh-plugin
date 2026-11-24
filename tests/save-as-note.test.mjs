import test from 'node:test';
import assert from 'node:assert/strict';
import { tempHome, fakeCtx } from './helpers.mjs';

const { DropletsService } = await import('../src/host/index.js');

async function seededService(entries = []) {
  const home = tempHome();
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  await service.ready;
  service.store.data.subscriptions.push({
    id: 'feed:s', url: 'https://s.example/f', name: 'S', enabled: true,
    entries: entries.map((entry) => ({ ...entry, channelKey: 'feed:s', channelName: 'S' })),
  });
  return { service, ctx, home };
}

test('saveAsNote: feed entry HTML becomes a vault note with source URL', async () => {
  const { service, ctx, home } = await seededService([
    { key: 'feed:s|e1', guid: 'e1', title: 'Hello World', url: 'https://s.example/1', html: '<h2>Intro</h2><p>Body text.</p>', summary: 's' },
  ]);
  try {
    const result = await service.saveAsNote({ source: 'feed', key: 'feed:s|e1' });
    assert.equal(result.path, '0-Inbox/Hello World.md');
    const note = await service.vaultRead(result.path);
    assert.ok(note.content.includes('id: '), 'native frontmatter id');
    assert.ok(note.content.includes('# Hello World'));
    assert.ok(note.content.includes('source: https://s.example/1'));
    assert.ok(note.content.includes('## Intro'), 'HTML converted to Markdown');
    assert.ok(note.content.includes('Body text.'));

    // Same title again → deduped sibling, not a failure.
    const second = await service.saveAsNote({ source: 'feed', key: 'feed:s|e1' });
    assert.equal(second.path, '0-Inbox/Hello World-2.md');

    await assert.rejects(service.saveAsNote({ source: 'feed', key: 'missing' }), /unknown entry/);
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});

test('saveAsNote: feed entry without HTML falls back to summary', async () => {
  const { service, ctx, home } = await seededService([
    { key: 'feed:s|e2', guid: 'e2', title: '摘要条目', url: 'https://s.example/2', html: '', summary: '只有摘要' },
  ]);
  try {
    const result = await service.saveAsNote({ source: 'feed', key: 'feed:s|e2', dir: '1-Projects' });
    assert.equal(result.path, '1-Projects/摘要条目.md');
    const note = await service.vaultRead(result.path);
    assert.ok(note.content.includes('只有摘要'), 'summary becomes the body');
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});

test('saveAsNote: inbox item lands with its markdown body', async () => {
  const home = tempHome();
  const ctx = fakeCtx();
  const service = new DropletsService(ctx, {});
  await service.ready;
  try {
    const { item } = await service.inboxImportMarkdown({ filename: 'a.md', content: '# 标题\n\n导入正文。' });
    const result = await service.saveAsNote({ source: 'inbox', id: item.id });
    assert.equal(result.path, '0-Inbox/标题.md');
    const note = await service.vaultRead(result.path);
    // The note writes its own frontmatter and H1; the inbox body follows.
    assert.ok(note.content.includes('# 标题'));
    assert.ok(note.content.includes('导入正文。'));
    await assert.rejects(service.saveAsNote({ source: 'inbox', id: 'nope' }), /没有这一条/);
  } finally { service.shutdown(); await ctx.dispose(); home.cleanup(); }
});
