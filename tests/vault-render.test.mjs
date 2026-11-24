import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * jsdom render smoke for the rebuilt VaultView (P0): evaluate the real
 * client bundle with one shared React 19, mount VaultView with a stub api,
 * switch between tree / note read / search, and catch render-time crashes
 * (the 0.5.0 white-screen class of bug).
 */
const DROPLETS_NM = '/Users/jesen/WorkSpace/MyProjects/droplets/apps/desktop/node_modules';
const bundlePath = new URL('../client.js', import.meta.url).pathname;

test('vault P0 renders tree, tabs, read pane, aux rail, search', { skip: !existsSync(DROPLETS_NM) }, async () => {
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
  // CM6 captures `view.win` at construction and calls requestAnimationFrame /
  // cancelAnimationFrame on it; jsdom's window lacks them under Node 24.
  dom.window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
  dom.window.delayedAndroidKey = null;
  dom.window.postTextContent = null;
  // CM's measure timer can fire after view.destroy() under jsdom and touches
  // this.observer (already torn down). Wrap the timer so that known teardown
  // noise is swallowed instead of failing the whole test process.
  const rawSetTimeout = dom.window.setTimeout.bind(dom.window);
  dom.window.setTimeout = (fn, delay, ...rest) => rawSetTimeout((...args) => {
    try { fn(...args); } catch (error) {
      if (String(error).includes('delayedAndroidKey') || String(error).includes('attachEvent')) return;
      throw error;
    }
  }, delay, ...rest);
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame;
  // CM's focus polling calls activeElement.attachEvent (legacy IE hook);
  // jsdom elements don't have it. Patch the prototype once.
  for (const name of ['attachEvent', 'detachEvent']) {
    if (!dom.window.HTMLElement.prototype[name]) {
      dom.window.HTMLElement.prototype[name] = () => {};
    }
  }
  // CM observes DOM mutations through its own MutationObserver instances,
  // and some paths reference the Window constructor for instanceof checks.
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.Window = dom.window.Window;
  globalThis.DocumentFragment = dom.window.DocumentFragment;
  globalThis.Selection = dom.window.Selection;
  // jsdom Range lacks the geometry methods CM's measurement uses.
  const rangeProto = dom.window.Range.prototype;
  if (!rangeProto.getClientRects) {
    rangeProto.getClientRects = () => [];
    rangeProto.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  }
  if (!dom.window.Element.prototype.getBoundingClientRect) {
    dom.window.Element.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  }
  globalThis.IntersectionObserver = dom.window.IntersectionObserver ?? class { observe() {} unobserve() {} disconnect() {} };
  globalThis.ResizeObserver = dom.window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} };
  globalThis.DOMSelectionState = undefined;

  const loaded = [];
  window.__ModuleLoader__ = { load: (def) => loaded.push(def) };
  const dshStub = new Proxy(function () {}, {
    apply: () => ({ apply: async () => ({}) }),
    get: () => (opts) => ({ apply: async () => ({}) }),
  });
  // CM's measureSoon schedules via the bare module-scope setTimeout (Node
  // global after eval). Its timer can fire on a destroyed view under jsdom;
  // filter that known teardown noise for the duration of this test.
  const rawGlobalSetTimeout = globalThis.setTimeout;
  const filteredSetTimeout = (fn, delay, ...rest) => rawGlobalSetTimeout((...args) => {
    try { fn(...args); } catch (error) {
      const text = String(error?.message ?? error);
      if (text.includes('delayedAndroidKey') || text.includes('attachEvent')) return;
      throw error;
    }
  }, delay, ...rest);
  globalThis.setTimeout = filteredSetTimeout;
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

  // Capture the VaultView component through the panel: simplest is to call
  // apply() with stubs that record the registered main component, then walk
  // its children. Instead we exercise the exported panel and click the vault
  // space tab, matching the earlier panel-level render test.
  let panelComponent = null;
  const remoteNs = new Proxy({}, { get: (t, prop) => async () => {
    const name = String(prop);
    if (name === 'vaultList') {
      const entries = dir === '' ? [
        { kind: 'dir', name: '0-Drafts', path: '0-Drafts' },
        { kind: 'file', name: 'hello.md', path: 'hello.md', mtime: Date.now(), title: 'hello' },
      ] : [
        { kind: 'file', name: 'nested.md', path: dir + '/nested.md', mtime: Date.now(), title: 'nested' },
      ];
      return { ok: true, value: { dir, entries } };
    }
    if (name === 'vaultStatus') return { ok: true, value: { files: 2, builtAt: Date.now(), root: '/tmp/vault' } };
    if (name === 'vaultRead') return { ok: true, value: { path: 'hello.md', content: '# 你好\n\n正文一段。\n\n## 第二节\n\n- 列表\n', sha: 'a'.repeat(64), title: '你好', tags: [], wordCount: 10 } };
    if (name === 'vaultBacklinks') return { ok: true, value: { backend: 'local', backlinks: [{ path: 'other.md', title: 'Other' }] } };
    if (name === 'vaultTags') return { ok: true, value: { backend: 'local', tags: [{ tag: 'ai', count: 3 }] } };
    if (name === 'listFeeds') return { ok: true, value: { feeds: [] } };
    if (name === 'inboxList') return { ok: true, value: { items: [], counts: { byStatus: {}, byTag: {}, total: 0 }, pendingIds: [] } };
    if (name === 'getSettings') return { ok: true, value: { settings: {} } };
    return { ok: true, value: {} };
  } });
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

  const api = new Proxy({}, { get: (t, prop) => {
    const name = String(prop);
    if (name === 'vaultList') return async (req) => {
      const dir = typeof req === 'string' ? req : req?.dir ?? '';
      const entries = dir === '' ? [
        { kind: 'dir', name: '0-Drafts', path: '0-Drafts' },
        { kind: 'file', name: 'hello.md', path: 'hello.md', mtime: Date.now(), title: 'hello' },
      ] : [
        { kind: 'file', name: 'nested.md', path: dir + '/nested.md', mtime: Date.now(), title: 'nested' },
      ];
      return { dir, entries };
    };
    if (name === 'vaultStatus') return async () => ({ files: 2, builtAt: Date.now(), root: '/tmp/vault' });
    if (name === 'vaultRead') return async () => ({ path: 'hello.md', content: '# 你好\n\n正文一段。\n\n## 第二节\n\n- 列表\n', sha: 'a'.repeat(64), title: '你好', tags: [], wordCount: 10 });
    if (name === 'vaultBacklinks') return async () => ({ backend: 'local', backlinks: [{ path: 'other.md', title: 'Other' }] });
    if (name === 'vaultTags') return async () => ({ backend: 'local', tags: [{ tag: 'ai', count: 3 }] });
    if (name === 'vaultGraph') return async () => ({ nodes: [
      { id: 'hello.md', title: '你好', dangling: false },
      { id: 'other.md', title: 'Other', dangling: false },
    ], edges: [{ source: 'hello.md', target: 'other.md' }] });
    if (name === 'vaultSearch') return async () => ({ backend: 'local', results: [], total: 0 });
    if (name === 'listFeeds') return async () => ({ feeds: [] });
    if (name === 'inboxList') return async () => ({ items: [], counts: { byStatus: {}, byTag: {}, total: 0 }, pendingIds: [] });
    if (name === 'getSettings') return async () => ({ settings: {} });
    return async () => ({});
  } });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = reactDomClient.createRoot(container);
  root.render(react.createElement(panelComponent, { api, SessionProvider: ({ children }) => children, renderSlot: () => null }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(container.innerHTML.length > 1000, 'feed space rendered');

  // Switch to the vault space.
  const tabs = [...container.querySelectorAll('.dpl-space-tab')];
  const vaultTab = tabs.find((tab) => /知识库|vault/i.test(tab.textContent));
  assert.ok(vaultTab, 'vault tab present');
  vaultTab.click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const html = container.innerHTML;
  assert.ok(html.includes('dpl-vault2'), 'vault2 shell rendered');
  assert.ok(html.includes('dpl-vault2-tabstrip'), 'tab strip rendered');
  assert.ok(html.includes('反链'), 'backlink pane rendered');
  assert.ok(html.includes('标签'), 'tag pane rendered');
  assert.ok(html.includes('0-Drafts'), 'tree lists dirs');
  assert.ok(html.includes('hello'), 'tree lists files');

  // Open a note.
  const fileButton = [...container.querySelectorAll('.dpl-vault2-file')].find((button) => button.textContent.includes('hello'));
  assert.ok(fileButton, 'file button present');
  fileButton.click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = container.innerHTML;
  assert.ok(after.includes('你好'), 'note title rendered');
  assert.ok(after.includes('正文一段'), 'note body rendered');
  assert.ok(after.includes('dpl-aux-rail'), 'aux rail rendered over the reader');
  assert.ok(after.includes('已保存') === false, 'no premature save state');
  const statusText = container.querySelector('.dpl-vault2-statusbar')?.textContent ?? '';
  assert.ok(/\d 反链/.test(statusText), 'status bar shows backlink count');

  // Quick switcher opens via the search control (⌘P surface uses the same list).
  const searchButton = container.querySelector('[title*="全库搜索"]');
  if (searchButton) {
    searchButton.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(container.innerHTML.includes('dpl-vault2-searchbar'), 'search bar opens');
  }

  // P1: switch the note to live editing. CM6's background polling loops hit
  // jsdom gaps (attachEvent / androidKey bookkeeping) — those are environment
  // noise, so we tolerate them via an error collector and assert only that
  // the editor DOM actually mounts.
  const cmErrors = [];
  const consoleError = console.error;
  console.error = (...args) => { cmErrors.push(String(args[0])); };
  // CM 后台 measure 定时器在 jsdom 的 destroy 竞态下会抛 observer 未定义；
  // 浏览器无此路径。挂一个放行 filter，不让它杀死测试进程。
  const cmNoise = (error) => {
    const text = String(error?.message ?? error);
    return text.includes('delayedAndroidKey') || text.includes('attachEvent');
  };
  const onRejection = (reason) => { cmNoise(reason); };
  process.on('unhandledRejection', onRejection);
  const onUncaught = (error) => {
    if (cmNoise(error)) return; // swallowed
    throw error;
  };
  process.on('uncaughtException', onUncaught);
  try {
    const liveButton = [...container.querySelectorAll('.dpl-vault2-viewswitch button')].find((b) => b.textContent === '实时');
    assert.ok(liveButton, 'view switch present');
    liveButton.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(container.querySelector('.cm-editor'), 'CodeMirror mounts in live view');
    assert.ok(container.querySelector('.cm-content'), 'CM content surface exists');
  } finally {
    console.error = consoleError;
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onUncaught);
  }

  // P1: outline still present in editing view (CM6-anchored).
  assert.ok(container.innerHTML.includes('dpl-aux-rail'), 'aux rail persists while editing');

  // P1: switch to source and back to read without crashing.
  const sourceButton = [...container.querySelectorAll('.dpl-vault2-viewswitch button')].find((b) => b.textContent === '源码');
  sourceButton.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(container.querySelector('.cm-editor'), 'source view keeps CodeMirror');
  const readButton = [...container.querySelectorAll('.dpl-vault2-viewswitch button')].find((b) => b.textContent === '阅读');
  readButton.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(container.innerHTML.includes('dpl-vault2-readerscroll'), 'read view restores');

  // P2: command palette via the head button surface (⌘⇧P content).
  const trashViaPalette = [...container.querySelectorAll('.dpl-vault2-tabstrip .dpl-icon-btn')].find((b) => (b.title ?? '').includes('图谱'));
  assert.ok(trashViaPalette, 'graph button present');
  trashViaPalette.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(container.innerHTML.includes('dpl-graph'), 'graph pane renders');
  const graphClose = container.querySelector('.dpl-vault2-graphhead .dpl-icon-btn');
  if (graphClose) { graphClose.click(); await new Promise((resolve) => setTimeout(resolve, 150)); }

  // Back to read view first so the CM instance unmounts cleanly through the
  // component path (destroy() cancels its measure timers).
  const readAgain = [...container.querySelectorAll('.dpl-vault2-viewswitch button')].find((b) => b.textContent === '阅读');
  if (readAgain) { readAgain.click(); await new Promise((resolve) => setTimeout(resolve, 250)); }
  root.unmount?.();
  // measureSoon's 50 ms timer may still be pending; drain it before the
  // test runner tears the world down, then restore the global timer.
  await new Promise((resolve) => filteredSetTimeout(resolve, 120));
  globalThis.setTimeout = rawGlobalSetTimeout;
});
