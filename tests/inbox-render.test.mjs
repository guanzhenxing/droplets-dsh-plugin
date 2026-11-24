import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * jsdom render tests for the inbox fixes (fix-inbox): pending fetch
 * visibility + reader auto-refresh (A), inboxGet error branch (C), the done
 * dialog failure state (D) and archive auto-advance (E), the retry-all stats
 * banner (G), save-as-note feedback (H), empty states per filter and list
 * errors (I). Mounts the real client bundle with one shared React 19 — the
 * same harness feed-render.test.mjs uses.
 */
const DROPLETS_NM = '/Users/jesen/WorkSpace/MyProjects/droplets/apps/desktop/node_modules';
const bundlePath = new URL('../client.js', import.meta.url).pathname;

async function loadHarness() {
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
  if (!dom.window.Element.prototype.scrollTo) dom.window.Element.prototype.scrollTo = () => {};
  if (!dom.window.Element.prototype.scrollIntoView) dom.window.Element.prototype.scrollIntoView = () => {};
  const rawGlobalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, delay, ...rest) => rawGlobalSetTimeout((...args) => {
    try { fn(...args); } catch (error) {
      const text = String(error?.message ?? error);
      if (text.includes('delayedAndroidKey') || text.includes('attachEvent')) return;
      throw error;
    }
  }, delay, ...rest);

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
  return { react, reactDomClient, panelComponent };
}

const harness = existsSync(DROPLETS_NM) ? await loadHarness() : null;

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mkItem(id, { title = id, status = 'unread', tags = [], kind = 'markdown-import', createdAt = '2026-11-20T10:00:00.000Z' } = {}) {
  return {
    id, objectType: 'article', space: 'inbox', status, title, tags,
    source: kind === 'url'
      ? { kind: 'url', url: 'https://example.com/' + id, addedAt: createdAt }
      : { kind, addedAt: createdAt },
    createdAt, updatedAt: createdAt,
  };
}

function countsOf(items) {
  const byStatus = {};
  const byTag = {};
  for (const item of items) {
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    for (const tag of item.tags) byTag[tag] = (byTag[tag] ?? 0) + 1;
  }
  return { byStatus, byTag, total: items.length };
}

/** Fake api：面板初始在信息流空间，喂空 feed；收件箱逻辑全部走 state 回调。 */
function fakeApi(state) {
  return new Proxy({}, { get: (target, prop) => {
    const name = String(prop);
    if (name === 'listFeeds') return async () => ({ feeds: [] });
    if (name === 'listItems') return async () => ({ items: [] });
    if (name === 'feedIcons') return async () => ({ icons: {} });
    if (name === 'getSettings') return async () => ({ settings: {} });
    if (name === 'refreshStatus') return async () => ({ running: false, total: 0 });
    if (name === 'listChannels') return async () => ({ channels: [] });
    if (name === 'inboxList') return async (params) => state.list(params);
    if (name === 'inboxGet') return async (id) => state.get(id);
    if (name === 'inboxRetryAllFailed') return async () => state.retryAll();
    if (name === 'inboxMoveToTrash') return async (id) => state.moveToTrash(id);
    if (name === 'inboxMoveToLibrary') return async (id) => state.moveToLibrary(id);
    if (name === 'saveAsNote') return async (params) => state.saveAsNote(params);
    return async () => ({});
  } });
}

async function mountInbox(state) {
  const { react, reactDomClient, panelComponent } = harness;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = reactDomClient.createRoot(container);
  root.render(react.createElement(panelComponent, { api: fakeApi(state), SessionProvider: ({ children }) => children, renderSlot: () => null }));
  await tick(300);
  const inboxTab = [...container.querySelectorAll('.dpl-space-tab')].find((b) => b.textContent === '收件箱');
  assert.ok(inboxTab, 'inbox space tab present');
  inboxTab.click();
  await tick(300);
  return { container, root };
}

test('inbox A: pending fetch is visible and the reader auto-refreshes when it lands', { skip: !harness }, async () => {
  const i1Item = mkItem('i1', { title: '第一篇' });
  const p1Item = mkItem('p1', { title: '抓取中的条目', kind: 'url' });
  const detailMap = {
    i1: { item: i1Item, content: '# 第一篇\n\n完整正文内容一。' },
    p1: { item: p1Item, content: '' },
  };
  let pendingIds = ['p1'];
  let p1GetCalls = 0;
  const state = {
    list: () => ({ items: [i1Item, p1Item], counts: countsOf([i1Item, p1Item]), pendingIds: [...pendingIds] }),
    get: (id) => {
      if (id === 'p1') p1GetCalls += 1;
      return detailMap[id] ?? { item: null, content: null };
    },
  };
  const { container, root } = await mountInbox(state);
  try {
    // 列表行：pending 条目用 spinner 替代状态点 + 标题尾「抓取中…」
    const p1Row = container.querySelector('[data-testid="item-p1"]');
    assert.ok(p1Row, 'pending row rendered');
    assert.ok(p1Row.querySelector('.dpl-spin'), 'pending row shows a spinner');
    assert.ok(p1Row.textContent.includes('抓取中…'), 'pending row title carries the hint');
    // 首条自动选中：普通条目正常阅读
    assert.ok(container.querySelector('[data-testid="reader-title"]').textContent.includes('第一篇'));

    // 点选 pending 条目：阅读器显示抓取中占位，而不是空正文 + 「正文较短（约 0 字）」
    p1Row.click();
    await tick(300);
    const pendingView = container.querySelector('[data-testid="reader-pending"]');
    assert.ok(pendingView, 'reader pending placeholder rendered');
    assert.ok(pendingView.textContent.includes('正在抓取内容'), 'pending copy present');
    assert.ok(!container.querySelector('[data-testid="reader-short-notice"]'), 'no 0-char short warning while pending');
    assert.ok(!container.querySelector('[data-testid="reader-article"]'), 'no empty article body while pending');

    // 抓取完成（轮询拿到空 pendingIds + 内容落地）→ 阅读器自动刷新
    detailMap.p1.content = '# 抓回来了\n\n后台抓取落地的新正文。';
    pendingIds = [];
    await tick(2100);
    assert.ok(container.querySelector('[data-testid="reader-article"]'), 'article body rendered after the fetch landed');
    assert.ok(container.textContent.includes('后台抓取落地的新正文'), 'reader auto-refreshed to the fetched content');
    assert.ok(p1GetCalls >= 2, 'inboxGet re-issued for the selected item (got ' + p1GetCalls + ')');
    assert.ok(!container.querySelector('[data-testid="reader-pending"]'), 'pending placeholder gone');
  } finally {
    root.unmount();
    container.remove();
  }
});

test('inbox C: inboxGet failures surface with a retry button instead of being swallowed', { skip: !harness }, async () => {
  const i1Item = mkItem('i1', { title: '坏掉的读取' });
  let getCalls = 0;
  let fail = true;
  const state = {
    list: () => ({ items: [i1Item], counts: countsOf([i1Item]), pendingIds: [] }),
    get: async () => {
      getCalls += 1;
      if (fail) throw new Error('RPC 断链');
      return { item: i1Item, content: '# 修好了\n\n重试后的正文。' };
    },
  };
  const { container, root } = await mountInbox(state);
  try {
    const errorView = container.querySelector('[data-testid="reader-error"]');
    assert.ok(errorView, 'reader error branch rendered');
    assert.ok(errorView.textContent.includes('读取条目失败'), 'error copy present');
    assert.ok(errorView.textContent.includes('RPC 断链'), 'underlying message surfaced');
    assert.ok(!container.querySelector('[data-testid="reader-archived"]'), 'not swallowed as the archived placeholder');
    const retryButton = container.querySelector('[data-testid="reader-error-retry"]');
    assert.ok(retryButton, 'retry button present');
    fail = false;
    retryButton.click();
    await tick(300);
    assert.ok(container.querySelector('[data-testid="reader-article"]'), 'retry recovered the article');
    assert.ok(container.textContent.includes('重试后的正文'), 'retried content rendered');
    assert.equal(getCalls, 2, 'inboxGet issued exactly twice');
  } finally {
    root.unmount();
    container.remove();
  }
});

test('inbox D+E: done-dialog failure stays actionable; success archives and advances to the next unread', { skip: !harness }, async () => {
  const i1Item = mkItem('i1', { title: '要处理的' });
  const i2Item = mkItem('i2', { title: '下一条未读', createdAt: '2026-11-19T10:00:00.000Z' });
  const items = [i1Item, i2Item];
  const details = {
    i1: { item: i1Item, content: '# 要处理的\n\n正文一。' },
    i2: { item: i2Item, content: '# 下一条未读\n\n正文二。' },
  };
  let trashFails = true;
  const state = {
    list: () => ({ items: [...items], counts: countsOf(items), pendingIds: [] }),
    get: (id) => details[id] ?? { item: null, content: null },
    moveToTrash: async () => {
      if (trashFails) throw new Error('回收站写入被拒');
      const index = items.findIndex((entry) => entry.id === 'i1');
      if (index >= 0) items.splice(index, 1);
      delete details.i1;
      return {};
    },
    moveToLibrary: async () => { throw new Error('不应走到这里'); },
  };
  const { container, root } = await mountInbox(state);
  try {
    // 打开弹层，移入回收站失败：红色错误 + 两按钮重新可用 + 重试入口
    container.querySelector('[data-testid="done-button"]').click();
    await tick(100);
    assert.ok(container.querySelector('[data-testid="done-dialog"]'), 'dialog opened');
    container.querySelector('[data-testid="done-to-trash"]').click();
    await tick(250);
    const result = container.querySelector('[data-testid="done-result"]');
    assert.ok(result, 'failure result rendered');
    assert.ok(result.textContent.startsWith('操作失败：'), 'failure prefix: ' + result.textContent);
    assert.ok(result.textContent.includes('回收站写入被拒'), 'error message carried');
    assert.ok(result.classList.contains('dpl-error'), 'failure uses the red error style');
    assert.equal(container.querySelector('[data-testid="done-keep-library"]').disabled, false, 'keep-library re-enabled on failure');
    assert.equal(container.querySelector('[data-testid="done-to-trash"]').disabled, false, 'to-trash re-enabled on failure');
    assert.ok(container.querySelector('[data-testid="done-retry"]'), 'retry button present');

    // 重试 → 成功 → 详情/列表刷新 + 自动选中下一条未读（i2），弹层随选中切换关闭
    trashFails = false;
    container.querySelector('[data-testid="done-retry"]').click();
    await tick(500);
    assert.ok(container.querySelector('[data-testid="reader-title"]').textContent.includes('下一条未读'), 'advanced to the next unread item');
    assert.ok(container.textContent.includes('正文二'), 'next unread content rendered');
    assert.ok(!container.querySelector('[data-testid="item-i1"]'), 'archived item left the list');
    assert.ok(!container.querySelector('[data-testid="done-dialog"]'), 'dialog closed after the successful move');

    // Escape 关闭：再开弹层，按 Esc
    container.querySelector('[data-testid="done-button"]').click();
    await tick(100);
    assert.ok(container.querySelector('[data-testid="done-dialog"]'), 'dialog reopened');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(100);
    assert.ok(!container.querySelector('[data-testid="done-dialog"]'), 'Escape closes the dialog');

    // scrim 点击关闭（点到 scrim 本体而不是弹层）
    container.querySelector('[data-testid="done-button"]').click();
    await tick(100);
    const scrim = container.querySelector('[data-testid="done-dialog"]');
    scrim.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    await tick(100);
    assert.ok(!container.querySelector('[data-testid="done-dialog"]'), 'scrim click closes the dialog');
  } finally {
    root.unmount();
    container.remove();
  }
});

test('inbox G: the retry-all banner reports host-side stats', { skip: !harness }, async () => {
  const f1 = mkItem('f1', { title: '失败条目', status: 'fetch_failed', kind: 'url' });
  const state = {
    list: () => ({ items: [f1], counts: countsOf([f1]), pendingIds: [] }),
    get: () => ({ item: f1, content: '' }),
    retryAll: async () => ({ total: 3, retried: 2, failed: 1 }),
  };
  const { container, root } = await mountInbox(state);
  try {
    const button = container.querySelector('[data-testid="retry-all-failed"]');
    assert.ok(button, 'retry-all button present with a failed item');
    button.click();
    await tick(300);
    const notice = container.querySelector('[data-testid="retry-all-notice"]');
    assert.ok(notice, 'stats banner rendered');
    assert.ok(notice.textContent.includes('已重试 2 条，失败 1 条'), 'banner carries host stats: ' + notice.textContent);
    notice.querySelector('button').click();
    await tick(100);
    assert.ok(!container.querySelector('[data-testid="retry-all-notice"]'), 'banner is dismissible');
  } finally {
    root.unmount();
    container.remove();
  }
});

test('inbox H: save-as-note failure is visible and retryable; success confirms briefly', { skip: !harness }, async () => {
  const i1 = mkItem('i1', { title: '要存的' });
  let fails = true;
  const calls = [];
  const state = {
    list: () => ({ items: [i1], counts: countsOf([i1]), pendingIds: [] }),
    get: () => ({ item: i1, content: '# 要存的\n\n正文。' }),
    saveAsNote: async (params) => {
      calls.push(params);
      if (fails) throw new Error('vault 写入失败');
      return {}; // 无 path：不触发跨空间跳转，留在收件箱观察确认条
    },
  };
  const { container, root } = await mountInbox(state);
  try {
    container.querySelector('[data-testid="save-as-note"]').click();
    await tick(250);
    const errorBar = container.querySelector('[data-testid="save-note-error"]');
    assert.ok(errorBar, 'save failure rendered');
    assert.equal(errorBar.getAttribute('role'), 'alert', 'failure is a live alert');
    assert.ok(errorBar.textContent.includes('存为笔记失败：vault 写入失败'), 'error message surfaced');
    assert.ok(!container.querySelector('[data-testid="save-note-ok"]'), 'no success notice on failure');

    // 失败可重试：按钮可用，第二次成功 → 错误清空 + 3 秒确认条
    fails = false;
    container.querySelector('[data-testid="save-as-note"]').click();
    await tick(250);
    assert.ok(!container.querySelector('[data-testid="save-note-error"]'), 'error cleared on success');
    const okBar = container.querySelector('[data-testid="save-note-ok"]');
    assert.ok(okBar, 'success confirmation rendered');
    assert.ok(okBar.textContent.includes('已存为笔记'), 'confirmation copy present');
    assert.equal(calls.length, 2, 'saveAsNote issued twice');
    await tick(3300);
    assert.ok(!container.querySelector('[data-testid="save-note-ok"]'), 'confirmation auto-dismisses after 3s');
  } finally {
    root.unmount();
    container.remove();
  }
});

test('inbox I: empty states follow the filter and list errors are visible with retry', { skip: !harness }, async () => {
  const i1 = mkItem('i1', { title: '常规条目', tags: ['ai'] });
  let listFails = true;
  const state = {
    list: async (params) => {
      if (listFails) throw new Error('存储不可用');
      if (params?.tag === 'ai') return { items: [], counts: { byStatus: {}, byTag: { ai: 1 }, total: 1 }, pendingIds: [] };
      if (params?.status === 'fetch_failed') return { items: [], counts: { byStatus: { fetch_failed: 0 }, byTag: {}, total: 1 }, pendingIds: [] };
      return { items: [i1], counts: countsOf([i1]), pendingIds: [] };
    },
    get: () => ({ item: i1, content: '# 常规条目\n\n正文。' }),
  };
  const { container, root } = await mountInbox(state);
  try {
    // 初次加载失败：列表区顶部错误条 + 重试
    const errorBar = container.querySelector('[data-testid="list-error"]');
    assert.ok(errorBar, 'list error banner rendered');
    assert.ok(errorBar.textContent.includes('加载失败：存储不可用'), 'list error message surfaced');
    // 重试成功 → 错误消失，列表恢复
    listFails = false;
    container.querySelector('[data-testid="list-error-retry"]').click();
    await tick(300);
    assert.ok(!container.querySelector('[data-testid="list-error"]'), 'list error cleared after retry');
    assert.ok(container.querySelector('[data-testid="item-i1"]'), 'items rendered after retry');

    // 标签筛选空态（tag chip 需要来自 counts 的计数）
    const tagButton = container.querySelector('[data-testid="tag-ai"]');
    assert.ok(tagButton, 'tag chip rendered from counts');
    tagButton.click();
    await tick(300);
    const tagEmpty = container.querySelector('[data-testid="list-empty"]');
    assert.ok(tagEmpty, 'empty state rendered under the tag filter');
    assert.ok(tagEmpty.textContent.includes('标签 ai 下暂无条目'), 'tag empty copy: ' + tagEmpty.textContent);

    // 失败筛选空态
    container.querySelector('[data-testid="filter-fetch_failed"]').click();
    await tick(300);
    const failedEmpty = container.querySelector('[data-testid="list-empty"]');
    assert.ok(failedEmpty, 'empty state rendered under the failed filter');
    assert.ok(failedEmpty.textContent.includes('当前没有失败条目'), 'fetch_failed empty copy: ' + failedEmpty.textContent);
  } finally {
    root.unmount();
    container.remove();
  }
});
