import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { tempHome, fakeCtx } from './helpers.mjs';

/**
 * Smoke the BUILT artifacts (not the sources): the host bundle must boot the
 * service and execute a tool through the peer stubs, and the client bundle
 * must be a window.__ModuleLoader__ wrapper whose id matches the package.
 */
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('host bundle boots the service and executes a tool', async () => {
  const home = tempHome();
  const ctx = fakeCtx();
  const hostUrl = new URL('../index.js', import.meta.url).href;
  const module = await import(hostUrl);
  assert.equal(typeof module.default, 'function');
  const service = new module.default(ctx, {});
  try {
    await service.ready;
    const { channels } = await service.listChannels();
    assert.equal(channels.length, 1);
    const { item } = await service.inboxAddUrl({ url: 'not a url' }).then(() => ({}), (error) => ({ error }));
    assert.equal(item, undefined, 'invalid url rejected');
    const { results } = await service.vaultSearch({ query: 'zzz-none' });
    assert.deepEqual(results, []);
  } finally {
    service.shutdown();
    await ctx.dispose();
    home.cleanup();
  }
});

test('host bundle preserves request parameter names (typert introspection)', () => {
  // The gateway derives parameter names from method signatures; if bundling
  // renames them (a bundled undici 'request' export once forced request2),
  // every parameterized Remote call fails with an unexpected-"request" args
  // error. Freeze the signatures of representative methods.
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  for (const signature of ['async listEntries(request)', 'async inboxRead(request)', 'async vaultWrite(request)', 'async setReadingContext(request)']) {
    assert.ok(host.includes(signature), 'host bundle must keep ' + signature);
  }
});

test('client bundle is a ModuleLoader wrapper with matching id', () => {
  const clientPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'client.js');
  assert.ok(existsSync(clientPath), 'client.js committed');
  const source = readFileSync(clientPath, 'utf8');
  assert.ok(source.includes('window.__ModuleLoader__.load('));
  assert.ok(source.includes(JSON.stringify(pkg.name).replace(/"/g, '"')), 'loader id = package name');
  assert.ok(source.includes('droplets.chat'), 'companion child slot present');
  assert.ok(source.includes('sidebar.panellist'), 'sidebar entry present');
});
