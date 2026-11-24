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
  for (const signature of [
    'async listEntries(request)', 'async inboxRead(request)', 'async vaultWrite(request)', 'async setReadingContext(request)',
    'async inboxGet(request)', 'async inboxUpdate(request)', 'async inboxRetry(request)', 'async inboxRetryAllFailed()',
    'async inboxImportMarkdown(request)', 'async inboxMoveToLibrary(request)', 'async inboxMoveToTrash(request)', 'async inboxReadOriginal(request)',
  ]) {
    assert.ok(host.includes(signature), 'host bundle must keep ' + signature);
  }
});

test('client bundle carries the panel stylesheet (no silent unstyled ship)', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(/\.dpl-root\s*\{/.test(source), 'panel css rules present in bundle');
  assert.ok(/createElement\(['"]style['"]\)/.test(source), 'style node injection present');
  assert.ok(!source.includes("import './styles.css'"), 'no bare css import left behind');
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

test('every zero-arg client api method is registered in NO_PARAM_METHODS', async () => {
  // Guards the class of bug where a parameterless Remote (listFeeds,
  // refreshStatus) is sent an empty params object and the host rejects it —
  // the call fails silently and the feature looks "just not there".
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/index.jsx', import.meta.url), 'utf8');

  const declared = source.match(/const NO_PARAM_METHODS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(declared, 'NO_PARAM_METHODS set not found');
  const registered = new Set(
    [...declared[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((match) => match[1]),
  );

  const zeroArgPattern = new RegExp("([A-Za-z0-9_]+)\\s*:\\s*\\(\\)\\s*=>\\s*call\\('([A-Za-z0-9_]+)'\\)", 'g');
  const zeroArg = [...source.matchAll(zeroArgPattern)].map((match) => match[2]);
  assert.ok(zeroArg.length > 0, 'no zero-arg api methods discovered');

  const missing = zeroArg.filter((name) => !registered.has(name));
  assert.deepEqual(missing, [], 'these zero-arg methods must be added to NO_PARAM_METHODS');

  // ...and every api method must also be DECLARED in TYPERT_REMOTE.descriptors,
  // otherwise the remote proxy has no such function and the call throws
  // "服务未就绪" (listFeeds and refreshStatus both shipped broken this way).
  const declaredBlock = source.match(/descriptors:\s*\[([\s\S]*?)\]\.map/);
  assert.ok(declaredBlock, 'TYPERT_REMOTE.descriptors not found');
  const declaredNames = new Set(
    [...declaredBlock[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((match) => match[1]),
  );
  const apiBlock = source.match(/const api = \{([\s\S]*?)\n  \};/);
  assert.ok(apiBlock, 'client api object not found');
  const allApi = [...apiBlock[1].matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)].map((match) => match[1]);
  assert.ok(allApi.length > 20, 'api object keys not discovered');
  const undeclared = allApi.filter((name) => !declaredNames.has(name));
  assert.deepEqual(undeclared, [], 'these api methods must be added to TYPERT_REMOTE.descriptors');
});

test('client bundle exports the inbox UI against the new remote methods', () => {
  // The registerPanel api object must cover every method InboxView calls;
  // a missing entry throws "Droplets 服务未就绪" only at click time.
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  for (const method of [
    'inboxAddUrl', 'inboxList', 'inboxGet', 'inboxReadOriginal', 'inboxUpdate',
    'inboxRetry', 'inboxRetryAllFailed', 'inboxImportMarkdown', 'inboxMoveToLibrary', 'inboxMoveToTrash',
  ]) {
    assert.ok(client.includes(method + ':'), 'client api must expose ' + method);
  }
  // The new inbox page must render through the shared panel group.
  assert.ok(client.includes('dpl-ib-filter'), 'inbox FilterPane styles present');
  assert.ok(client.includes('dpl-ib-reader'), 'inbox Reader present');
  assert.ok(client.includes('"retry-all-failed"'), 'retry-all-failed control present');
  assert.ok(client.includes('"done-dialog"'), '处理完成 dialog present');
  // 样式冻结：JSX 用到的每个新交互类名必须有对应 CSS 规则（防「无样式上线」复发）
  for (const rule of [
    '.dpl-vault2-crumbbar {', '.dpl-vault2-crumbbtn {', '.dpl-vault2-ctxmenu {',
    '.dpl-vault2-ctxitem {', '.dpl-vault2-seg {', '.dpl-vault2-tbrow {',
    '.dpl-vault2-tbactions {', '.dpl-vault2-fmtbar {', '.dpl-vault2-fmtbtn {',
    '.dpl-vault2-bldrawer {', '.dpl-vault2-askall {', '.dpl-vault2-popmenu {',
  ]) {
    assert.ok(client.includes(rule), `stylesheet must carry ${rule} (交互对齐样式不可缺)`);
  }
});

test('feed fixes are frozen in the bundle: hit-test dots, aux rail, translation UI', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  // The dots placeholder is a full-row overlay that stays in the hit-test
  // tree at opacity:0 — without pointer-events:none the two buttons painted
  // under it (自动定位 / 全部折叠) can never be clicked.
  assert.ok(
    /\.dpl-toolbar-dots\s*\{[^}]*pointer-events:\s*none/.test(client),
    'dots overlay must be pointer-events:none',
  );
  // Aux rail: idle ticks visible against the page (not border-faint) and a
  // compact rhythm (12px pitch, 3px gap).
  assert.ok(/\.dpl-aux-bar\s*\{[^}]*background:\s*var\(--dpl-faint\)/.test(client), 'aux tick idle color');
  assert.ok(/\.dpl-aux-tick\s*\{[^}]*height:\s*12px/.test(client), 'aux tick height');
  // Translation + favicon styles must ship with the panel.
  for (const rule of ['.dpl-translation-notice {', '.dpl-inline-btn {', '.dpl-badge-img {', '.dpl-round-btn.is-on {']) {
    assert.ok(client.includes(rule), `stylesheet must carry ${rule}`);
  }
  assert.ok(client.includes('translateEntry'), 'translation remote wired');
  assert.ok(client.includes('feedIcons'), 'favicon remote wired');
});
