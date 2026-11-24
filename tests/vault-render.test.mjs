import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * jsdom render smoke for the vault workbench (P0–P3 + native-alignment):
 * evaluate the real client bundle with one shared React 19, mount the panel,
 * switch to the vault space, and drive mode dropdown / more menu / context
 * menu / segmented buttons — catching render-time crashes (the 0.5.0
 * white-screen class of bug).
 */
const DROPLETS_NM = '/Users/jesen/WorkSpace/MyProjects/droplets/apps/desktop/node_modules';
const bundlePath = new URL('../client.js', import.meta.url).pathname;

test('vault renders tree/tabs/read + native menus + graph', { skip: !existsSync(DROPLETS_NM) }, async () => {
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
  dom.window.delayedAndroidKey = null;
  dom.window.postTextContent = null;
  for (const name of ['attachEvent', 'detachEvent']) {
    if (!dom.window.HTMLElement.prototype[name]) dom.window.HTMLElement.prototype[name] = () => {};
  }
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.Window = dom.window.Window;
  globalThis.DocumentFragment = dom.window.DocumentFragment;
  globalThis.Selection = dom.window.Selection;
  const rangeProto = dom.window.Range.prototype;
  if (!rangeProto.getClientRects) {
    rangeProto.getClientRects = () => [];
    rangeProto.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  }
  if (!dom.window.Element.prototype.getBoundingClientRect) {
    dom.window.Element.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  }
  const rawGlobalSetTimeout = globalThis.setTimeout;
  const filteredSetTimeout = (fn, delay, ...rest) => rawGlobalSetTimeout((...args) => {
    try { fn(...args); } catch (error) {
      const text = String(error?.message ?? error);
      if (text.includes('delayedAndroidKey') || text.includes('attachEvent')) return;
      throw error;
    }
  }, delay, ...rest);
  globalThis.setTimeout = filteredSetTimeout;

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

  const sampleFiles = [
    { path: 'hello.md', name: 'hello.md', mtime: Date.now() },
    { path: '0-Drafts/nested.md', name: 'nested.md', mtime: Date.now() },
  ];
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
    if (name === 'vaultRead') return async (req) => ({
      path: typeof req === 'string' ? req : req?.path,
      content: '# 你好\n\n正文一段。\n\n## 第二节\n\n- 列表\n',
      sha: 'a'.repeat(64), title: '你好', tags: [], wordCount: 10,
    });
    if (name === 'vaultBacklinks') return async () => ({ backend: 'local', backlinks: [{ path: 'other.md', title: 'Other' }], unlinked: [] });
    if (name === 'vaultTags') return async () => ({ backend: 'local', tags: [{ tag: 'ai', count: 3 }] });
    if (name === 'vaultSearch') return async () => ({ backend: 'local', results: [], total: 0 });
    if (name === 'vaultGraph') return async () => ({ nodes: [
      { id: 'hello.md', title: '你好', dangling: false },
      { id: 'other.md', title: 'Other', dangling: false },
    ], edges: [{ source: 'hello.md', target: 'other.md' }] });
    if (name === 'vaultIndexFiles') return async () => sampleFiles;
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

  const spaceTabs = [...container.querySelectorAll('.dpl-space-tab')];
  const vaultTab = spaceTabs.find((tab) => /知识库|vault/i.test(tab.textContent));
  assert.ok(vaultTab, 'vault tab present');
  vaultTab.click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const html = container.innerHTML;
  assert.ok(html.includes('dpl-vault2'), 'vault2 shell rendered');
  assert.ok(html.includes('dpl-vault2-tabstrip'), 'tab strip rendered');
  assert.ok(html.includes('0-Drafts'), 'tree lists dirs');
  assert.ok(html.includes('hello'), 'tree lists files');
  assert.ok(container.querySelector('[data-testid="vault-graph-toggle"]'), '图谱 segmented button');
  assert.ok(container.querySelector('[data-testid="vault-tags-toggle"]'), '标签云 segmented button');
  assert.ok(container.querySelector('[data-testid="vault-ask-ai"]'), '整库问 AI button');
  assert.ok(container.querySelector('[data-testid="vault-tree-toolbar"]'), 'dot toolbar row');

  // 展开目录触发懒加载（点击 chevron 所在的 dir 按钮）
  const dirButton = [...container.querySelectorAll('.dpl-vault2-dir')].find((b) => b.textContent.includes('0-Drafts'));
  assert.ok(dirButton, 'dir row present');
  dirButton.click();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(container.innerHTML.includes('nested'), 'expanding a dir lazy-loads its children');

  // Open a note.
  const fileButton = [...container.querySelectorAll('.dpl-vault2-file')].find((button) => button.textContent.includes('hello'));
  assert.ok(fileButton, 'file button present');
  fileButton.click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = container.innerHTML;
  assert.ok(after.includes('你好'), 'note title rendered');
  assert.ok(after.includes('正文一段'), 'note body rendered');
  assert.ok(after.includes('dpl-aux-rail'), 'aux rail rendered over the reader');

  // Breadcrumb renders the path segments.
  assert.ok(container.querySelector('.dpl-vault2-crumb'), 'breadcrumb bar renders');

  // ---- mode dropdown (native 源码/实时/阅读) ----
  const cmErrors = [];
  const cmNoise = (error) => {
    const text = String(error?.message ?? error);
    return text.includes('delayedAndroidKey') || text.includes('attachEvent');
  };
  const consoleError = console.error;
  console.error = (...args) => {};
  const onErrorEvent = (event) => { cmErrors.push(String(event?.error?.message ?? event?.message ?? 'error')); };
  window.addEventListener('error', onErrorEvent);
  const onRejection = (reason) => { cmNoise(reason); };
  process.on('unhandledRejection', onRejection);
  const onUncaught = (error) => { cmNoise(error); };
  process.on('uncaughtException', onUncaught);
  try {
    const modeButton = container.querySelector('[data-testid="vault-mode"]');
    assert.ok(modeButton, 'mode dropdown present');
    modeButton.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(container.querySelector('[data-testid="vault-mode-live"]'), 'mode menu lists 实时预览');
    assert.ok(container.querySelector('[data-testid="vault-mode-source"]'), 'mode menu lists 源码模式');
    assert.ok(container.querySelector('[data-testid="vault-mode-read"]'), 'mode menu lists 阅读视图');
    container.querySelector('[data-testid="vault-mode-live"]').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(container.querySelector('.cm-editor'), 'CodeMirror mounts — view=' + (container.querySelector('.dpl-vault2-note')?.getAttribute('data-view') ?? 'none') + ' menuOpenItems=' + container.querySelectorAll('[data-testid=vault-mode-live]').length + ' shell=' + (container.querySelector('.dpl-vault2')?'y':'n') + ' len=' + container.innerHTML.length + ' errors: ' + cmErrors.slice(0,3).join('|'));
    assert.ok(container.querySelector('.cm-content'), 'CM content surface exists');

    // … menu (native items).
    container.querySelector('[data-testid="vault-more"]').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(container.querySelector('[data-testid="backlinks-toggle"]'), 'more menu has 反向链接');
    assert.ok(container.querySelector('[data-testid="vault-more-export-html"]'), 'more menu has 导出为 HTML');
    assert.ok(container.querySelector('[data-testid="vault-more-toolbar"]'), 'more menu has 格式工具栏');
    window.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(container.querySelector('[data-testid="vault-format-toolbar"]'), 'format toolbar renders in edit mode');
    assert.ok(container.innerHTML.includes('dpl-aux-rail'), 'aux rail persists while editing');

    container.querySelector('[data-testid="vault-mode"]').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    container.querySelector('[data-testid="vault-mode-read"]').click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(container.innerHTML.includes('dpl-vault2-readerscroll'), 'read view restores');
  } finally {
    console.error = consoleError;
    window.removeEventListener('error', onErrorEvent);
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onUncaught);
  }

  // ---- tree context menu (native file groupings) ----
  const fileRow = [...container.querySelectorAll('.dpl-vault2-file')].find((b) => b.textContent.includes('hello'));
  assert.ok(fileRow, 'file row for ctx menu');
  fileRow.closest('.dpl-vault2-row').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const ctxMenuEl = container.querySelector('[data-testid="vault-context-menu"]');
  assert.ok(ctx, 'context menu opens');
  const ctxText = ctxMenuEl.textContent;
  for (const item of ['打开', '重命名', '移动到…', '剪切', '复制', '复制路径', '复制相对路径', '在 Finder 中显示', '问 AI（这篇）', '删除']) {
    assert.ok(ctxText.includes(item), `ctx menu has ${item}`);
  }
  document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 80));

  // ---- graph in left pane ----
  container.querySelector('[data-testid="vault-graph-toggle"]').click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(container.innerHTML.includes('dpl-graph'), 'graph renders in left pane');
  const graphClose = container.querySelector('.dpl-vault2-graphhead .dpl-icon-btn');
  if (graphClose) { graphClose.click(); await new Promise((resolve) => setTimeout(resolve, 120)); }

  root.unmount?.();
  await new Promise((resolve) => filteredSetTimeout(resolve, 120));
  globalThis.setTimeout = rawGlobalSetTimeout;
});
