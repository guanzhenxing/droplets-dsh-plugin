import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tempHome, fakeCtx } from './helpers.mjs';
import { DropletsStore, entriesDir } from '../src/host/store.js';

const base = (home) => path.join(home.dir, 'storages', 'droplets-dsh');

test('a store keeps writing entries into the home it was created with', async () => {
  const first = tempHome();
  const store = new DropletsStore(undefined);
  // The next test starts while this store's flush is still in flight.
  const second = tempHome();
  try {
    await store.saveEntries('feed:a', [{ key: 'k1' }]);
    assert.ok(existsSync(path.join(base(first), 'entries', 'feed%3Aa.json')), 'entry file landed in the creating home');
    assert.ok(!existsSync(base(second)), 'nothing leaked into the home that became current later');
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test('two stores in one process never share a temp file path', async () => {
  const home = tempHome();
  try {
    const a = new DropletsStore(undefined);
    const b = new DropletsStore(undefined);
    await Promise.all([
      a.saveEntries('feed:a', [{ key: 'from-a' }]),
      b.saveEntries('feed:a', [{ key: 'from-b' }]),
    ]);
    assert.deepEqual(readdirSync(entriesDir()), ['feed%3Aa.json'], 'no temp file left behind');
  } finally {
    home.cleanup();
  }
});

test('shutdown() resolves only after the final flush has landed on disk', async () => {
  const home = tempHome();
  const ctx = fakeCtx();
  const { DropletsService } = await import('../src/host/index.js');
  const service = new DropletsService(ctx, {});
  await service.ready;
  service.store.data.subscriptions.push({
    id: 'feed:a', url: 'https://feed-a.invalid/feed', name: 'Alpha', enabled: true,
    entries: [{ key: 'feed:a|e0', title: 't0' }],
  });
  service.store.touch(); // schedules a debounced flush 500 ms out
  try {
    const pending = service.shutdown();
    assert.equal(typeof pending?.then, 'function', 'shutdown() must return a promise');
    await pending;
    assert.ok(existsSync(path.join(base(home), 'data.json')), 'data.json was flushed before shutdown resolved');
    assert.ok(existsSync(path.join(base(home), 'entries', 'feed%3Aa.json')), 'entry file was flushed before shutdown resolved');
  } finally {
    await ctx.dispose();
    home.cleanup();
  }
});

test('the fake context waits for async disposers', async () => {
  const ctx = fakeCtx();
  let flushed = false;
  ctx.effect(() => () => new Promise((resolve) => setTimeout(() => { flushed = true; resolve(); }, 5)));
  await ctx.dispose();
  assert.equal(flushed, true);
});
