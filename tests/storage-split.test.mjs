import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test gets its own DSH_HOME; resolveDshHome() reads the env per call.
async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-split-'));
  process.env.DSH_HOME = home;
  const dir = join(home, 'storages', 'droplets-dsh');
  await mkdir(dir, { recursive: true });
  return { home, dir };
}

const legacyDoc = {
  version: 1,
  settings: { showImages: true },
  subscriptions: [
    { id: 'feed:aaa', url: 'https://a.example/f', name: 'A', enabled: true, entries: [
      { key: 'e1', title: 'One', publishedAt: 1 },
      { key: 'e2', title: 'Two', publishedAt: 2 },
    ] },
    { id: 'feed:bbb', url: 'https://b.example/f', name: 'B', enabled: true, entries: [] },
  ],
  read: {}, states: {}, favorites: {}, inbox: [], vaultCache: null, companionContexts: {},
};

test('entries move from data.json into per-feed files without loss', async () => {
  const { dir } = await makeHome();
  await writeFile(join(dir, 'data.json'), JSON.stringify(legacyDoc));
  const { DropletsStore } = await import('../src/host/store.js');

  const store = new DropletsStore(console);
  await store.load();
  assert.equal(store.data.subscriptions[0].entries.length, 2, 'legacy inline entries hydrate');

  await store.flush();

  const doc = JSON.parse(await readFile(store.path, 'utf8'));
  assert.equal(doc.subscriptions.length, 2);
  assert.ok(!doc.subscriptions.some((sub) => 'entries' in sub), 'data.json no longer carries entries');

  const files = await readdir(join(dir, 'entries'));
  assert.deepEqual(files, ['feed%3Aaaa.json'], 'only the feed with entries gets a file');

  const reloaded = new DropletsStore(console);
  await reloaded.load();
  const entries = reloaded.data.subscriptions[0].entries;
  assert.equal(entries.length, 2, 'entries survive a reload');
  assert.deepEqual(entries.map((entry) => entry.title), ['One', 'Two']);
});

test('metadata document stays small while entries grow', async () => {
  const { dir } = await makeHome();
  const many = Array.from({ length: 2000 }, (_, i) => ({ key: 'k' + i, title: 'T' + i, summary: 'x'.repeat(120) }));
  await writeFile(join(dir, 'data.json'), JSON.stringify({
    ...legacyDoc,
    subscriptions: [{ id: 'feed:big', url: 'https://big.example/f', name: 'Big', enabled: true, entries: many }],
  }));
  const { DropletsStore } = await import('../src/host/store.js');
  const store = new DropletsStore(console);
  await store.load();
  await store.flush();

  const docBytes = (await stat(store.path)).size;
  const entryBytes = (await stat(join(dir, 'entries', 'feed%3Abig.json'))).size;
  assert.ok(entryBytes > docBytes * 10, 'entries dominate the entry file, not the document');
  assert.ok(docBytes < 100 * 1024, 'document stays small (was tens of MB inline)');
});

test('a second flush does not rewrite unchanged entry files', async () => {
  const { dir } = await makeHome();
  await writeFile(join(dir, 'data.json'), JSON.stringify(legacyDoc));
  const { DropletsStore } = await import('../src/host/store.js');
  const store = new DropletsStore(console);
  await store.load();
  await store.flush();
  const target = join(dir, 'entries', 'feed%3Aaaa.json');
  const first = (await stat(target)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 15));
  await store.flush();
  assert.equal((await stat(target)).mtimeMs, first, 'unchanged feed is not rewritten');
});

test('stale temp files from a killed process are cleaned up', async () => {
  const { dir } = await makeHome();
  const stale = join(dir, 'data.json.999.tmp');
  await writeFile(stale, '{}');
  const before = (await stat(stale)).mtimeMs;
  const { DropletsStore } = await import('../src/host/store.js');
  const store = new DropletsStore(console);
  // Back-date the file past the 10 minute cutoff.
  const old = new Date(Date.now() - 30 * 60 * 1000);
  const { utimes } = await import('node:fs/promises');
  await utimes(stale, old, old);
  await writeFile(join(dir, 'data.json'), JSON.stringify(legacyDoc));
  await store.load();
  const remaining = await readdir(dir);
  assert.ok(!remaining.includes('data.json.999.tmp'), 'stale temp file removed');
  assert.ok(before > 0);
});
