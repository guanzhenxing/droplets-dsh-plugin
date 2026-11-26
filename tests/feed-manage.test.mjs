import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

/**
 * jsdom render tests for the feed manage view (fixes B/C/N):
 * - B: batch patch / remove survive per-item failures — the rest still run,
 *   the outcome is announced (成功 N 个，失败 M 个), and the selection that
 *   failed is kept checked instead of being silently wiped.
 * - C: the batch 重试 button refreshes exactly the selected ids (single →
 *   channel, several → channels array), never the whole subscription set.
 * - N: the sources-pane filter narrows the list and force-expands collapsed
 *   groups; clearing restores the collapsed state.
 * Same harness as feed-render.test.mjs (real client bundle, shared React 19).
 */
const bundlePath = new URL('../client.js', import.meta.url).pathname;

test('manage view: batch failures are visible and scoped retry refreshes the selection', async () => {
  const nmRequire = createRequire(import.meta.url);
  const react = nmRequire('react');
  const reactDomClient = nmRequire('react-dom/client');
  const jsxRuntime = nmRequire('react/jsx-runtime');

  const { JSDOM } = nmRequire('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.Node = dom.window.Node;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  dom.window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.MutationObserver = dom.window.MutationObserver;
  if (!dom.window.Element.prototype.getBoundingClientRect) {
    dom.window.Element.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  }
  if (!dom.window.Element.prototype.scrollTo) dom.window.Element.prototype.scrollTo = () => {};
  if (!dom.window.Element.prototype.scrollIntoView) dom.window.Element.prototype.scrollIntoView = () => {};
  // React's IE-era value-change polyfill calls attachEvent on focus; stub it
  // (same as vault-fixes.test.mjs) so focusing an input cannot crash.
  for (const name of ['attachEvent', 'detachEvent']) {
    if (!dom.window.HTMLElement.prototype[name]) dom.window.HTMLElement.prototype[name] = () => {};
  }
  const rawGlobalSetTimeout = globalThis.setTimeout;
  const pendingTimers = new Set();
  globalThis.setTimeout = (fn, delay, ...rest) => {
    const id = rawGlobalSetTimeout((...args) => {
      pendingTimers.delete(id);
      try { fn(...args); } catch (error) {
        const text = String(error?.message ?? error);
        if (text.includes('delayedAndroidKey') || text.includes('attachEvent')) return;
        throw error;
      }
    }, delay, ...rest);
    pendingTimers.add(id);
    return id;
  };

  const loaded = [];
  window.__ModuleLoader__ = { load: (def) => loaded.push(def) };
  const dshStub = new Proxy(function () {}, {
    apply: () => ({ apply: async () => ({}) }),
    get: () => (opts) => ({ apply: async () => ({}) }),
  });
  const src = readFileSync(bundlePath, 'utf8');
  const mod = { exports: {} };
  const fakeRequire = (name) => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === 'react-dom' || name === 'react-dom/client') return reactDomClient;
    if (name.startsWith('@deepseek-ai/')) return dshStub;
    try { return nmRequire(name); } catch { return {}; }
  };
  new Function('require', 'module', 'exports', src)(fakeRequire, mod, mod.exports);
  const client = loaded[0].factory(fakeRequire);

  let panelComponent = null;
  const remoteNs = new Proxy({}, { get: (t, prop) => async () => ({ ok: true, value: {} }) });
  const childCtx = {
    remote: { droplets: remoteNs },
    slots: {
      inject(slotName, reg) { reg(); },
      register(opts, component) {
        if (opts && (opts.key === 'droplets' || opts.name === 'main') && component) panelComponent = component;
        return () => {};
      },
    },
    locale: { register() {} },
    inject(n, cb2) { return cb2(childCtx); },
  };
  const ctx = {
    effect(fn) { try { return fn(); } catch { /* styles under jsdom */ } return () => {}; },
    inject(names, cb) { return cb(childCtx); },
    remote: { $mount: async () => {} },
    logger: { info() {}, warn() {}, error() {} },
  };
  await client.apply(ctx);
  assert.ok(panelComponent, 'panel component registered');

  // --- fake api: three feeds; feed:b fails every batch write ---
  const mkFeed = (id, title, group, unread) => ({
    id, title, groupName: group, url: 'https://' + id + '/feed', enabled: true,
    unreadCount: unread, itemCount: unread + 4, lastFetchAt: 1, lastError: null,
  });
  let feeds = [mkFeed('feed:a', 'Alpha', 'Tech', 1), mkFeed('feed:b', 'Beta', 'Tech', 2), mkFeed('feed:c', 'Gamma', '', 1)];
  const refreshCalls = [];
  const setFeedCalls = [];
  const removeCalls = [];
  const api = new Proxy({}, { get: (t, prop) => {
    const name = String(prop);
    if (name === 'listFeeds') return async () => ({ feeds: feeds.map((f) => ({ ...f })) });
    if (name === 'listItems') return async () => ({ items: [
      { sourceId: 'feed:a', key: 'feed:a|e1', title: 'Post', link: 'https://a.example/1', summary: 's', content: '', publishedAt: '2026-11-01T00:00:00.000Z', state: 'unseen' },
    ] });
    if (name === 'getEntry') return async () => ({ html: '<p>body</p>', truncated: false, hasTranslation: false });
    if (name === 'getSettings') return async () => ({ settings: {} });
    if (name === 'refreshStatus') return async () => ({ running: false, total: 0 });
    if (name === 'refresh') return async (request) => { refreshCalls.push(request); return { feeds: 1, entries: 0, errors: 0 }; };
    if (name === 'setFeed') return async ({ id, patch }) => {
      setFeedCalls.push({ id, patch });
      if (id === 'feed:b') throw new Error('写入失败(feed:b)');
      feeds = feeds.map((f) => (f.id === id
        ? { ...f, enabled: patch.enabled ?? f.enabled, title: patch.name ?? f.title, groupName: patch.group ?? f.groupName }
        : f));
      return { ok: true };
    };
    if (name === 'removeSubscription') return async (id) => {
      removeCalls.push(id);
      if (id === 'feed:b') throw new Error('删除失败(feed:b)');
      feeds = feeds.filter((f) => f.id !== id);
      return { removed: true };
    };
    if (name === 'saveSettings') return async () => ({ settings: {} });
    if (name === 'feedIcons') return async () => ({ icons: {} });
    if (name === 'listChannels') return async () => ({ channels: [] });
    if (name === 'inboxList') return async () => ({ items: [], counts: { byStatus: {}, byTag: {}, total: 0 }, pendingIds: [] });
    return async () => ({});
  } });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = reactDomClient.createRoot(container);
  root.render(react.createElement(panelComponent, { api, SessionProvider: ({ children }) => children, renderSlot: () => null }));
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

  // React's value tracker swallows direct `input.value = …` assignments, and
  // dispatched 'input' events alone do not reach React's onChange in this
  // jsdom; the working recipe is focus + prototype setter + a key event
  // (React's change detection runs on keydown/keyup for the focused input).
  const setInputValue = (input, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value');
    input.focus();
    descriptor.set.call(input, value);
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  };

  // Cleanup must run even when an assertion fails, or the refresh-status
  // poll loop keeps the process alive (a hung test run).
  try {
    await settle(400);

    // --- N: the sources filter narrows the pane and force-expands groups ---
    const inGroupRows = () => [...container.querySelectorAll('.dpl-in-group')];
    assert.equal(inGroupRows().length, 3, 'all three feeds listed initially');
    const filterInput = container.querySelector('.dpl-source-filter input');
    assert.ok(filterInput, 'filter input rendered');
    setInputValue(filterInput, 'alp');
    await settle();
    assert.equal(inGroupRows().length, 1, 'title filter narrows to Alpha');
    assert.ok(inGroupRows()[0].textContent.includes('Alpha'));

    // Collapse the Tech group, then filter into it: hits must stay visible.
    const techChevron = container.querySelectorAll('.dpl-group-chevron')[0];
    techChevron.click();
    await settle();
    setInputValue(filterInput, '');
    await settle();
    assert.equal(inGroupRows().length, 1, 'collapsed Tech hides its feeds once the filter is empty');
    assert.ok(inGroupRows()[0].textContent.includes('Gamma'));
    setInputValue(filterInput, 'bet');
    await settle();
    assert.equal(inGroupRows().length, 1, 'a non-empty filter force-expands collapsed groups');
    assert.ok(inGroupRows()[0].textContent.includes('Beta'));
    setInputValue(filterInput, '');
    await settle();
    assert.equal(inGroupRows().length, 1, 'clearing the filter restores the collapsed state');

    // --- enter the manage view ---
    const manageButton = [...container.querySelectorAll('.dpl-pane-btn')].find((b) => b.textContent.includes('管理'));
    assert.ok(manageButton, 'manage button present');
    manageButton.click();
    await settle();
    assert.ok(container.querySelector('.dpl-manage'), 'manage table rendered');

    const batchNotice = () => container.querySelector('.dpl-manage-batch-notice');
    const batchBar = () => container.querySelector('.dpl-manage-batch');
    const batchButton = (label) => [...container.querySelectorAll('.dpl-manage-batch .dpl-btn')].find((b) => b.textContent === label);

    // --- C: retry refreshes exactly the selection ---
    container.querySelector('input[aria-label="选择 Alpha"]').click();
    container.querySelector('input[aria-label="选择 Beta"]').click();
    await settle();
    assert.ok(batchBar(), 'batch bar appears once rows are checked');
    assert.ok(batchBar().textContent.includes('已选 2'), 'selection count shown');
    batchButton('重试').click();
    await settle();
    assert.equal(refreshCalls.length, 1, 'retry issued one refresh');
    assert.deepEqual(refreshCalls[0], { channels: ['feed:a', 'feed:b'] }, 'several selected ids go through the channels array');

    batchButton('取消选择').click();
    await settle();
    assert.ok(!batchBar(), 'batch bar hidden after clearing the selection');
    container.querySelector('input[aria-label="选择 Gamma"]').click();
    await settle();
    batchButton('重试').click();
    await settle();
    assert.equal(refreshCalls.length, 2, 'single-selection retry issued a refresh');
    assert.equal(refreshCalls[1], 'feed:c', 'a single id goes through the channel value');
    batchButton('取消选择').click();
    await settle();

    // --- B: batch patch survives a per-item failure ---
    for (const title of ['Alpha', 'Beta', 'Gamma']) container.querySelector('input[aria-label="选择 ' + title + '"]').click();
    await settle();
    batchButton('停用').click();
    await settle(350);
    assert.equal(setFeedCalls.length, 3, 'every id attempted — a failure no longer abandons the rest');
    assert.ok(batchNotice(), 'failure outcome is announced');
    assert.ok(batchNotice().textContent.includes('成功 2 个，失败 1 个'), 'counts quoted');
    assert.ok(batchNotice().textContent.includes('写入失败(feed:b)'), 'first error message quoted');
    assert.ok(batchBar().textContent.includes('已选 3'), 'patch failure keeps the checked rows');
    assert.ok(container.querySelector('input[aria-label="选择 Beta"]').checked, 'the failed row stays checked');

    // --- B: batch delete keeps the failed rows selected for a retry ---
    batchButton('删除…').click();
    await settle();
    const confirmButton = container.querySelector('.dpl-modal .dpl-danger-solid');
    assert.ok(confirmButton, 'delete confirmation dialog open');
    confirmButton.click();
    await settle(350);
    assert.deepEqual(removeCalls, ['feed:a', 'feed:b', 'feed:c'], 'every id attempted for deletion');
    assert.ok(batchNotice(), 'delete failure outcome is announced');
    assert.ok(batchNotice().textContent.includes('成功 2 个，失败 1 个：删除失败(feed:b)'), 'delete counts and message quoted');
    assert.ok(!container.querySelector('.dpl-modal'), 'dialog closed after the attempt');
    assert.ok(container.querySelector('input[aria-label="选择 Beta"]'), 'failed row still listed');
    assert.ok(container.querySelector('input[aria-label="选择 Beta"]').checked, 'failed row kept checked');
    assert.ok(!container.querySelector('input[aria-label="选择 Alpha"]'), 'deleted rows are gone');
    assert.ok(batchBar().textContent.includes('已选 1'), 'selection now counts only the surviving failure');
  } finally {
    root.unmount();
    container.remove();
    for (const id of pendingTimers) clearTimeout(id);
  }
});
