import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * jsdom render smoke for the feed reading flow with the new features:
 * favicon badges (feedIcons), the translation toggle (translateEntry), and
 * the aux rail. Mounts the real client bundle with one shared React 19 —
 * the same harness vault-render.test.mjs uses.
 */
const DROPLETS_NM = '/Users/jesen/WorkSpace/MyProjects/droplets/apps/desktop/node_modules';
const bundlePath = new URL('../client.js', import.meta.url).pathname;

test('feed renders favicon badges and the translation toggle end-to-end', { skip: !existsSync(DROPLETS_NM) }, async () => {
  const nmRequire = createRequire(path.join(DROPLETS_NM, 'x.js'));
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
  // jsdom does not implement scrolling APIs the reader uses on mount.
  if (!dom.window.Element.prototype.scrollTo) dom.window.Element.prototype.scrollTo = () => {};
  if (!dom.window.Element.prototype.scrollIntoView) dom.window.Element.prototype.scrollIntoView = () => {};
  const rawGlobalSetTimeout = globalThis.setTimeout;
  // Track every scheduled timer so the 12s icon-retry timeout the refresh
  // path arms cannot leak past unmount (feed A: refresh reload test).
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

  // --- fake api: one feed with a favicon, one entry, one translation ---
  const calls = { translateEntry: 0, feedIcons: 0, listItems: 0, refresh: 0 };
  let setItemStateFails = false;
  const saveAsNoteCalls = [];
  const ICON = 'data:image/png;base64,iVBORw0KGgo=';
  const TRANSLATION = {
    title: '中文标题',
    markdown: '# 中文标题\n\n这是译文正文。\n\n## 译文小节\n\n- 列表项\n',
    generatedAt: '2026-11-24T10:00:00.000Z',
  };
  const mkItem = (key, title, publishedAt) => ({
    sourceId: 'feed:a', key, title, link: 'https://a.example/1', summary: 'sum', content: '', publishedAt, state: 'unseen',
  });
  const api = new Proxy({}, { get: (t, prop) => {
    const name = String(prop);
    if (name === 'listFeeds') return async () => ({ feeds: [
      { id: 'feed:a', title: 'Alpha', groupName: '', enabled: true, lastFetchAt: 1, lastError: null, unreadCount: 1, itemCount: 1 },
    ] });
    if (name === 'listItems') return async () => {
      // The reload after a refresh (A) sees one extra entry.
      calls.listItems += 1;
      const items = [mkItem('feed:a|e1', 'English post', '2026-11-01T00:00:00.000Z')];
      if (calls.listItems > 1) items.push(mkItem('feed:a|e2', 'Second post', '2026-10-15T00:00:00.000Z'));
      return { items };
    };
    if (name === 'refresh') return async () => { calls.refresh += 1; return { feeds: 1, entries: 1, errors: 0 }; };
    if (name === 'setItemState') return async (params) => {
      if (setItemStateFails) throw new Error('host 写入失败');
      return { updated: (params?.keys ?? []).length };
    };
    if (name === 'feedIcons') return async () => { calls.feedIcons += 1; return { icons: { 'feed:a': ICON } }; };
    if (name === 'getEntry') return async () => ({
      entry: { key: 'feed:a|e1', title: 'English post' },
      html: '<h2>Section</h2><p>Hello original body.</p>',
      truncated: false,
      hasTranslation: false,
    });
    if (name === 'translateEntry') return async () => { calls.translateEntry += 1; return { translation: TRANSLATION, cached: false }; };
    if (name === 'saveAsNote') return async (params) => { saveAsNoteCalls.push(params); return { path: '0-Inbox/English post.md', title: 'English post' }; };
    if (name === 'getSettings') return async () => ({ settings: {} });
    if (name === 'refreshStatus') return async () => ({ running: false, total: 0 });
    if (name === 'listChannels') return async () => ({ channels: [] });
    if (name === 'inboxList') return async () => ({ items: [], counts: { byStatus: {}, byTag: {}, total: 0 }, pendingIds: [] });
    return async () => ({});
  } });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = reactDomClient.createRoot(container);
  root.render(react.createElement(panelComponent, { api, SessionProvider: ({ children }) => children, renderSlot: () => null }));
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await settle(400);

  // Cleanup must run even when an assertion fails, or the refresh-status
  // poll loop keeps the process alive (a hung test run).
  try {
    // Feed space is the default: sources pane, item list, preview.
    assert.ok(container.querySelector('.dpl-sources'), 'sources pane rendered');
    assert.ok(calls.feedIcons >= 1, 'feedIcons RPC issued');

    // Favicon badge: the source row shows the site icon, not the letter mark.
    const badgeImg = container.querySelector('.dpl-sources .dpl-badge-img');
    assert.ok(badgeImg, 'favicon <img> badge present in sources pane');
    assert.equal(badgeImg.getAttribute('src'), ICON);
    assert.ok(!container.querySelector('.dpl-sources .dpl-source .dpl-badge:not(.dpl-badge-img)'), 'letter badge not used when an icon exists');

    // Auto-select opens the first entry: original body + translate button.
    await settle(400);
    assert.ok(container.innerHTML.includes('Hello original body'), 'original article body rendered');
    assert.ok(container.querySelector('[data-testid="feed-translate"]'), 'translate button present');
    assert.equal(container.querySelector('[data-testid="feed-translate"]').disabled, false, 'translate button is enabled (was a disabled placeholder)');

    // Aux rail ticks over the article headings.
    assert.ok(container.querySelector('.dpl-aux-rail'), 'aux rail rendered');
    assert.ok(container.querySelectorAll('.dpl-aux-tick').length >= 1, 'outline tick present');

    // --- A: refresh reloads the item list and revives the 「新增 N 条」 pill ---
    assert.equal(calls.listItems, 1, 'exactly one list load before refresh');
    const refreshButton = container.querySelector('button[aria-label="刷新全部"]');
    assert.ok(refreshButton, 'items-pane refresh button present');
    refreshButton.click();
    await settle(300);
    assert.equal(calls.refresh, 1, 'refresh RPC issued');
    assert.equal(calls.listItems, 2, 'refresh re-issues listItems for the scope');
    const pill = container.querySelector('.dpl-new-pill');
    assert.ok(pill, 'new-entries pill rendered after the refresh reload');
    assert.ok(pill.textContent.includes('新增 1 条'), 'pill counts the entry that arrived with the refresh');
    assert.ok(container.innerHTML.includes('Hello original body'), 'current selection survives the reload');
    assert.equal(container.querySelectorAll('.dpl-entry-row').length, 2, 'reloaded list shows both entries');

    // --- M: keyboard navigation — j/k move the selection, modified keys pass through ---
    const scroll = container.querySelector('.dpl-entry-scroll');
    assert.ok(scroll, 'entry scroll container present');
    const activeRow = () => container.querySelector('.dpl-entry-row.is-active');
    const press = (key, modifiers = {}) => scroll.dispatchEvent(new window.KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...modifiers,
    }));
    assert.ok(activeRow(), 'a selected row exists before keyboard use');
    assert.ok(activeRow().textContent.includes('English post'), 'first entry is the selection');
    press('j');
    await settle(60);
    assert.ok(activeRow().textContent.includes('Second post'), 'j moves the selection down');
    press('k');
    await settle(60);
    assert.ok(activeRow().textContent.includes('English post'), 'k moves the selection back up');
    press('j', { shiftKey: true });
    await settle(60);
    assert.ok(activeRow().textContent.includes('English post'), 'modified keys are ignored, selection unchanged');

    // --- D: optimistic state change rolls back when the host rejects it ---
    const activeDot = () => container.querySelector('.dpl-entry-row.is-active .dpl-dot');
    assert.ok(activeDot().classList.contains('is-unseen'), 'entry starts unread');
    setItemStateFails = true;
    press('s'); // 略过 current → optimistic 'skipped' → host rejects
    await settle(150);
    assert.ok(activeDot().classList.contains('is-unseen'), 'row state restored after the failure');
    const listNotice = container.querySelector('.dpl-items-notice');
    assert.ok(listNotice, 'rollback notice rendered');
    assert.ok(listNotice.textContent.includes('标记失败'), 'notice explains the failure');
    const sourceUnread = () => container.querySelector('.dpl-sources-list .dpl-in-group em');
    assert.ok(sourceUnread(), 'unread badge present after the rollback');
    assert.ok(sourceUnread().textContent.includes('1'), 'unread count compensated back to 1');
    setItemStateFails = false;

    // Click 文 → translation renders, notice shows, call counted.
    container.querySelector('[data-testid="feed-translate"]').click();
    await settle(300);
    assert.equal(calls.translateEntry, 1, 'translateEntry RPC issued exactly once');
    assert.ok(container.innerHTML.includes('这是译文正文'), 'translated body rendered');
    assert.ok(container.innerHTML.includes('中文标题'), 'translated title rendered');
    assert.ok(container.querySelector('.dpl-translation-notice'), 'translation notice visible');
    assert.ok(container.querySelector('[data-testid="feed-translate"]').classList.contains('is-on'), 'toggle state shown on the button');

    // Click 文 again → back to the original body without a new RPC.
    container.querySelector('[data-testid="feed-translate"]').click();
    await settle(300);
    assert.equal(calls.translateEntry, 1, 'toggle back hits the cache, no new request');
    assert.ok(container.innerHTML.includes('Hello original body'), 'original body restored');
    assert.ok(!container.querySelector('.dpl-translation-notice'), 'translation notice gone');

    // 存为笔记 (cross-space hand-off): the preview exposes the action and
    // invokes saveAsNote; the panel routes the result to the vault space.
    // (Must stay last: the hand-off switches the panel to the vault space.)
    const saveAsNoteButton = [...container.querySelectorAll('.dpl-round-btn')].find((b) => (b.dataset.tip ?? b.title) === '存为笔记');
    assert.ok(saveAsNoteButton, '存为笔记 button present in the feed preview');
    saveAsNoteButton.click();
    await settle(300);
    const saveCall = saveAsNoteCalls[0];
    assert.ok(saveCall, 'saveAsNote RPC issued');
    assert.equal(saveCall.source, 'feed');
    assert.ok(saveCall.key);
  } finally {
    root.unmount();
    container.remove();
    // Kill anything the refresh path armed (12s icon retry) so nothing leaks.
    for (const id of pendingTimers) clearTimeout(id);
  }
});
