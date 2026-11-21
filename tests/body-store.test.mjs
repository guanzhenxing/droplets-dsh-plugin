import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BodyStore } from '../src/host/body-store.js';

function tempFile(name) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dpl-body-'));
  return { dir, file: path.join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('lazy load, atomic flush and prune with pinned keys', async () => {
  const { file, cleanup } = tempFile('bodies.json');
  const store = new BodyStore(file, 3);
  store.set('a', '<p>1</p>');
  store.set('b', '<p>2</p>');
  store.set('c', '<p>3</p>');
  store.set('d', '<p>4</p>');
  await store.flush();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['a', 'b', 'c', 'd']);
  store.dispose.bind(store);
  // prune to metadata {b, d} with pinned {d}: a and c drop, cap keeps b and d.
  store.prune(['b', 'd'], new Set(['d']));
  await store.flush();
  const raw2 = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(raw2).sort(), ['b', 'd']);
  await store.dispose();
  cleanup();
});

test('a prune that races the one-time load is re-applied (no resurrection)', async () => {
  const { file, cleanup } = tempFile('race.json');
  writeFileSync(file, JSON.stringify({ stale1: 'x', stale2: 'y', keep: 'z' }));
  const store = new BodyStore(file, 100);
  const loading = store.load(); // in flight
  store.prune(['keep'], new Set()); // races the load
  await loading;
  await store.flush();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(raw), ['keep'], 'evicted bodies must not resurrect from file contents');
  await store.dispose();
  cleanup();
});

test('a write before the first read merges with the file', async () => {
  const { file, cleanup } = tempFile('merge.json');
  writeFileSync(file, JSON.stringify({ existing: 'old' }));
  const store = new BodyStore(file, 100);
  store.set('fresh', 'new');
  await store.flush();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['existing', 'fresh']);
  await store.dispose();
  cleanup();
});

test('destroy removes the file', async () => {
  const { file, cleanup } = tempFile('destroy.json');
  const store = new BodyStore(file, 10);
  store.set('x', 'y');
  await store.flush();
  assert.ok(existsSync(file));
  await store.destroy();
  assert.equal(existsSync(file), false);
  cleanup();
});
