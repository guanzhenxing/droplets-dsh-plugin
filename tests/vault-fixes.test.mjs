import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Render tests for the audited vault fixes (fixes A/B/C/D/E/G):
 * mount the real client bundle in jsdom, seed tab state through the same
 * localStorage keys VaultView persists, and drive the conflict dialog /
 * tab switching / quick switcher / create dialog / view persistence.
 *
 * Drafts are produced by seeding a persisted dirty tab (tabs survive space
 * switches with their draft), which is exactly the state an interrupted
 * editing session leaves behind — no CM6 typing needed in jsdom.
 */
const DROPLETS_NM = '/Users/jesen/WorkSpace/MyProjects/droplets/apps/desktop/node_modules';
const bundlePath = new URL('../client.js', import.meta.url).pathname;
const skip = !existsSync(DROPLETS_NM);

// ---- shared bootstrap (one jsdom, one bundle evaluation) ----

let booted = null;
function boot() {
  if (booted) return booted;
  // Order matters: react-dom probes `"oninput" in document` at module load
  // to decide whether onChange rides native input events. The jsdom globals
  // must exist BEFORE the require, or React falls back to the IE polyfill
  // path and controlled inputs never fire onChange in these tests.
  const nmRequire = createRequire(path.join(DROPLETS_NM, 'x.js'));
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
  const react = nmRequire('react');
  const reactDomClient = nmRequire('react-dom/client');
  const jsxRuntime = nmRequire('react/jsx-runtime');
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
  const applied = client.apply(ctx);
  booted = { react, reactDomClient, applied, getPanel: () => panelComponent, rawSetTimeout: rawGlobalSetTimeout };
  return booted;
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setNativeValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

const shaOf = (content) => `sha:${String(content ?? '').length}:${String(content ?? '').slice(0, 12)}`;

function makeTab(path, { draft = null, sha, content, view } = {}) {
  const body = content ?? `# ${path}\n\n正文：${path} 的内容。\n`;
  return {
    id: path, path, name: path.split('/').pop(),
    content: body, draft, sha: sha ?? shaOf(body),
    title: path.replace(/\.md$/, ''), tags: [], wordCount: body.length, savedAt: null,
    ...(view ? { view } : {}),
  };
}

/**
 * A per-test in-memory vault: files map + write/read/fail records. The api
 * stub mirrors the host semantics that matter here — expectedSha:null means
 * create-only, a mismatched string sha yields { conflict }, undefined forces.
 */
function makeApi(state) {
  return new Proxy({}, { get: (t, prop) => {
    const name = String(prop);
    if (state.failOn?.[name]) return async () => { throw new Error(state.failOn[name]); };
    switch (name) {
      case 'vaultList': return async (req) => {
        const dir = typeof req === 'string' ? req : req?.dir ?? '';
        const entries = state.fileIndex
          .filter((file) => (dir === '' ? !file.path.includes('/') : file.path.startsWith(dir + '/') && !file.path.slice(dir.length + 1).includes('/')))
          .map((file) => (dir === ''
            ? { kind: file.path.endsWith('.md') ? 'file' : 'dir', name: file.path.split('/')[0], path: file.path.split('/')[0], mtime: 1, title: file.path }
            : { kind: 'file', name: file.name, path: file.path, mtime: 1, title: file.path.replace(/\.md$/, '') }));
        return { dir, entries };
      };
      case 'vaultStatus': return async () => ({ files: state.fileIndex.length, builtAt: 1, root: '/tmp/vault' });
      case 'vaultRead': return async (req) => {
        const p = typeof req === 'string' ? req : req?.path;
        state.reads.push(p);
        const file = state.files[p] ?? { content: `# ${p}\n\n${p} 的默认内容。`, sha: shaOf(p) };
        return { path: p, content: file.content, sha: file.sha, title: p.replace(/\.md$/, ''), tags: [], wordCount: file.content.length };
      };
      case 'vaultStat': return async (req) => {
        const p = typeof req === 'string' ? req : req?.path;
        const file = state.files[p];
        return { stat: { sha: file?.sha ?? 'missing', mtimeMs: Date.now(), size: 100 } };
      };
      case 'vaultWrite': return async (req) => {
        const p = req?.path;
        state.writes.push({ path: p, content: req?.content, expectedSha: req?.expectedSha, createOnly: req?.createOnly === true, at: Date.now() });
        const existing = state.files[p];
        if (req?.createOnly === true || req?.expectedSha === null) {
          if (existing) return { conflict: true, path: p, currentSha: existing.sha, currentExcerpt: existing.content.slice(0, 200) };
        } else if (typeof req?.expectedSha === 'string' && existing && existing.sha !== req.expectedSha) {
          return { conflict: true, path: p, currentSha: existing.sha, currentExcerpt: existing.content.slice(0, 200) };
        }
        const sha = shaOf(req?.content ?? '');
        state.files[p] = { content: req?.content ?? '', sha };
        return { conflict: false, path: p, sha, title: p.replace(/\.md$/, ''), created: !existing };
      };
      case 'vaultIndexFiles': return async () => state.fileIndex;
      case 'vaultBacklinks': return async () => ({ backend: 'local', backlinks: [], unlinked: [] });
      case 'vaultTags': return async () => ({ backend: 'local', tags: [] });
      case 'vaultSearch': return async () => ({ backend: 'local', results: [], total: 0 });
      case 'vaultGraph': return async () => ({ nodes: [], edges: [] });
      case 'vaultDuplicate': return async (req) => {
        const p = typeof req === 'string' ? req : req?.path;
        const stem = p.replace(/\.md$/, '');
        const target = `${stem} 副本.md`;
        state.files[target] = { content: state.files[p]?.content ?? '', sha: shaOf(state.files[p]?.content ?? '') };
        return { path: target };
      };
      case 'listFeeds': return async () => ({ feeds: [] });
      case 'inboxList': return async () => ({ items: [], counts: { byStatus: {}, byTag: {}, total: 0 }, pendingIds: [] });
      case 'getSettings': return async () => ({ settings: {} });
      default: return async () => ({});
    }
  } });
}

async function mountVault({ tabs, activeTabId, files = {}, failOn } = {}) {
  const { react, reactDomClient, applied, getPanel, rawSetTimeout } = boot();
  await applied;
  const panel = getPanel();
  assert.ok(panel, 'panel component registered');
  localStorage.clear();
  if (tabs) localStorage.setItem('droplets.vault.tabs', JSON.stringify(tabs));
  if (activeTabId !== undefined) localStorage.setItem('droplets.vault.tabs.active', JSON.stringify(activeTabId));

  const fileIndex = Object.keys(files).map((p) => ({ path: p, name: p.split('/').pop(), mtime: 1 }));
  const state = { files: { ...files }, fileIndex, writes: [], reads: [], failOn, mountedAt: Date.now() };
  const api = makeApi(state);

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = reactDomClient.createRoot(container);
  root.render(react.createElement(panel, { api, SessionProvider: ({ children }) => children, renderSlot: () => null }));
  await tick(300);
  const spaceTabs = [...container.querySelectorAll('.dpl-space-tab')];
  const vaultTab = spaceTabs.find((tab) => /知识库|vault/i.test(tab.textContent));
  assert.ok(vaultTab, 'vault space tab present');
  vaultTab.click();
  await tick(350);
  return { container, root, state, api, rawSetTimeout, react };
}

async function unmountVault(harness) {
  harness.root.unmount?.();
  await new Promise((resolve) => harness.rawSetTimeout(resolve, 120));
  harness.container.remove();
}

const cmNoiseGuards = () => {
  const consoleError = console.error;
  console.error = () => {};
  const onRejection = () => {};
  const onUncaught = () => {};
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onUncaught);
  return () => {
    console.error = consoleError;
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onUncaught);
  };
};

// ---- A: conflict dialog 重载 actually loads the disk version ----

test('conflict dialog: external change + draft → 重载 refreshes tab from disk', { skip }, async () => {
  const diskContent = '# 冲突\n\n外部改写后的磁盘正文。';
  const draft = '# 冲突\n\n本地草稿，尚未保存。';
  const h = await mountVault({
    tabs: [makeTab('note.md', { draft, sha: 'stale-sha' })],
    activeTabId: 'note.md',
    files: { 'note.md': { content: diskContent, sha: shaOf(diskContent) } },
  });
  try {
    window.dispatchEvent(new window.Event('focus'));
    await tick(450);
    // Draft visible in the read view, and the conflict dialog is up.
    assert.ok(h.container.innerHTML.includes('本地草稿'), 'draft renders before reload');
    assert.ok(h.container.innerHTML.includes('保存冲突'), 'conflict dialog appears');
    const reloadButton = [...h.container.querySelectorAll('.dpl-modal button')].find((b) => b.textContent === '重载');
    assert.ok(reloadButton, '重载 button present');
    const saveCopy = [...h.container.querySelectorAll('.dpl-modal button')].find((b) => b.textContent === '另存副本');
    assert.ok(saveCopy, '另存副本 button present (fix A third option)');

    reloadButton.click();
    await tick(400);
    const html = h.container.innerHTML;
    assert.ok(!html.includes('保存冲突'), 'conflict dialog closed after reload');
    assert.ok(html.includes('外部改写后的磁盘正文'), 'disk version now rendered');
    assert.ok(!html.includes('本地草稿'), 'draft cleared (tab content replaced)');
  } finally { await unmountVault(h); }
});

test('conflict dialog: 另存副本 writes the draft to a copy and reloads the original', { skip }, async () => {
  const diskContent = '# 冲突\n\n磁盘版本正文。';
  const draft = '# 冲突\n\n本地草稿要被另存。';
  const h = await mountVault({
    tabs: [makeTab('note.md', { draft, sha: 'stale-sha' })],
    activeTabId: 'note.md',
    files: { 'note.md': { content: diskContent, sha: shaOf(diskContent) } },
  });
  try {
    window.dispatchEvent(new window.Event('focus'));
    await tick(450);
    const saveCopy = [...h.container.querySelectorAll('.dpl-modal button')].find((b) => b.textContent === '另存副本');
    assert.ok(saveCopy, '另存副本 button present');
    saveCopy.click();
    await tick(500);

    const copyWrite = h.state.writes.find((w) => w.path === 'note 副本.md');
    assert.ok(copyWrite, 'draft was written to a 副本 path');
    assert.equal(copyWrite.content, draft, 'the copy carries the draft, not the disk text');
    assert.ok(!h.container.innerHTML.includes('保存冲突'), 'conflict resolved');
    const activeTab = h.container.querySelector('.dpl-vault2-tab.is-active');
    assert.ok(activeTab?.textContent.includes('note 副本'), 'the copy opened as the active tab');
    assert.ok(h.container.innerHTML.includes('本地草稿要被另存'), 'copy tab shows the draft content');
  } finally { await unmountVault(h); }
});

// ---- B: switching away from a dirty tab flushes it; badge counts ----

test('switching tabs flushes the outgoing dirty tab and shows the unsaved badge', { skip }, async () => {
  const a = 'A 草稿内容';
  const b = 'B 草稿内容';
  const h = await mountVault({
    tabs: [
      makeTab('a.md', { draft: a, sha: shaOf(a) }),
      makeTab('b.md', { draft: b, sha: shaOf(b) }),
    ],
    activeTabId: 'a.md',
    files: {
      'a.md': { content: a, sha: shaOf(a) },
      'b.md': { content: b, sha: shaOf(b) },
    },
  });
  try {
    await tick(150);
    assert.ok(h.container.innerHTML.includes('2 个未保存'), 'badge lists both dirty tabs');
    assert.equal(h.state.writes.length, 0, 'nothing flushed before switching (debounce intact)');

    const tabB = [...h.container.querySelectorAll('.dpl-vault2-tab')].find((t) => t.title === 'b.md');
    assert.ok(tabB, 'tab b present');
    const clickedAt = Date.now();
    tabB.click();
    await tick(300);
    assert.equal(h.state.writes.length, 1, 'exactly one write — the switch flush');
    assert.equal(h.state.writes[0].path, 'a.md', 'the outgoing dirty tab was flushed');
    assert.ok(h.state.writes[0].at >= clickedAt, 'flush happened on switch, not by the timer');
    assert.ok(!h.container.innerHTML.includes('2 个未保存'), 'badge gone once only one dirty tab remains');
  } finally { await unmountVault(h); }
});

// ---- D: create-note collision surfaces inside the modal ----

test('create dialog: name collision shows an inline error and keeps the dialog open', { skip }, async () => {
  const h = await mountVault({
    files: { 'note.md': { content: '# note', sha: shaOf('# note') } },
  });
  try {
    const newNote = h.container.querySelector('[data-testid="vault-tb-new-note"]');
    assert.ok(newNote, 'new-note toolbar button');
    newNote.click();
    await tick(150);
    const inputs = [...h.container.querySelectorAll('.dpl-modal input')];
    assert.ok(inputs.length >= 2, '位置 + 名称 inputs render');
    setNativeValue(inputs[1], 'note'); // 名称
    const createButton = [...h.container.querySelectorAll('.dpl-modal button')].find((btn) => btn.textContent === '创建');
    createButton.click();
    await tick(250);

    assert.ok(h.container.innerHTML.includes('新建笔记'), 'dialog stays open after the failure');
    const errorEl = h.container.querySelector('.dpl-dialog-error');
    assert.ok(errorEl, 'inline error element rendered');
    assert.ok(errorEl.textContent.includes('已存在：note.md'), 'error names the colliding path');
  } finally { await unmountVault(h); }
});

// ---- E: quick switcher keyboard navigation ----

test('quick switcher: arrows move a ring selection and Enter opens the active row', { skip }, async () => {
  const h = await mountVault({
    files: {
      'a1.md': { content: '# a1\n\nA1 正文。', sha: shaOf('a1') },
      'a2.md': { content: '# a2\n\nA2 正文。', sha: shaOf('a2') },
      'a3.md': { content: '# a3\n\nA3 正文。', sha: shaOf('a3') },
      'b.md': { content: '# b', sha: shaOf('b') },
    },
  });
  try {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true }));
    await tick(150);
    const quickInput = [...h.container.querySelectorAll('.dpl-vault2-quick > input')].find((i) => i.placeholder.includes('快速切换'));
    assert.ok(quickInput, 'quick switcher opened via ⌘P');
    setNativeValue(quickInput, 'a');
    await tick(120);
    const rows = [...h.container.querySelectorAll('[data-testid="vault-quicklist"] button')];
    assert.equal(rows.length, 3, 'three files match "a"');
    assert.ok(rows[0].className.includes('is-active'), 'first row is active by default');

    quickInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await tick(100);
    let active = [...h.container.querySelectorAll('[data-testid="vault-quicklist"] button.is-active')];
    assert.equal(active.length, 1, 'exactly one active row');
    assert.ok(active[0].textContent.includes('a2'), 'ArrowDown moved to the second row');

    quickInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await tick(100);
    active = [...h.container.querySelectorAll('[data-testid="vault-quicklist"] button.is-active')];
    assert.ok(active[0].textContent.includes('a1'), 'ArrowUp moves back up');

    quickInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await tick(100);
    active = [...h.container.querySelectorAll('[data-testid="vault-quicklist"] button.is-active')];
    assert.ok(active[0].textContent.includes('a3'), 'ArrowUp wraps around to the last row');

    quickInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(400);
    assert.ok(!h.container.querySelector('.dpl-vault2-quick > input'), 'switcher closed after Enter');
    const activeTab = h.container.querySelector('.dpl-vault2-tab.is-active');
    assert.ok(activeTab?.textContent.includes('a3'), 'Enter opened the active row (a3), not the first row');
    assert.ok(h.state.reads.includes('a3.md'), 'a3.md was read from the vault');
    assert.ok(h.container.innerHTML.includes('A3 正文'), 'a3 content rendered');
  } finally { await unmountVault(h); }
});

// ---- G: switching tabs preserves the editing view ----

test('tab switch preserves the per-tab view (live survives a round trip)', { skip }, async () => {
  const h = await mountVault({
    tabs: [
      makeTab('a.md', { content: '# a\n\nA 正文。' }),
      makeTab('b.md', { content: '# b\n\nB 正文。' }),
    ],
    activeTabId: 'a.md',
    files: {
      'a.md': { content: '# a\n\nA 正文。', sha: shaOf('a') },
      'b.md': { content: '# b\n\nB 正文。', sha: shaOf('b') },
    },
  });
  const restoreConsole = cmNoiseGuards();
  try {
    // a → live
    h.container.querySelector('[data-testid="vault-mode"]').click();
    await tick(120);
    h.container.querySelector('[data-testid="vault-mode-live"]').click();
    await tick(450);
    assert.equal(h.container.querySelector('.dpl-vault2-note')?.getAttribute('data-view'), 'live', 'a is live');
    assert.ok(h.container.querySelector('.cm-editor'), 'CM editor mounted for a');

    // switch to b (default read)
    const tabB = [...h.container.querySelectorAll('.dpl-vault2-tab')].find((t) => t.title === 'b.md');
    tabB.click();
    await tick(300);
    assert.equal(h.container.querySelector('.dpl-vault2-note')?.getAttribute('data-view'), 'read', 'b renders read');
    assert.ok(h.container.innerHTML.includes('B 正文'), 'b content loaded');

    // back to a — still live, no remount reset
    const tabA = [...h.container.querySelectorAll('.dpl-vault2-tab')].find((t) => t.title === 'a.md');
    tabA.click();
    await tick(400);
    assert.equal(h.container.querySelector('.dpl-vault2-note')?.getAttribute('data-view'), 'live', 'a kept its live view across the round trip');
    assert.ok(h.container.querySelector('.cm-editor'), 'editor re-present for a');
    assert.ok(h.container.querySelector('.cm-content'), 'CM content surface exists');
  } finally {
    restoreConsole();
    await unmountVault(h);
  }
});

// ---- C: failures flash in danger color ----

test('failing duplicate action flashes a danger-colored notice', { skip }, async () => {
  const h = await mountVault({
    files: { 'note.md': { content: '# note', sha: shaOf('# note') } },
    failOn: { vaultDuplicate: '复制失败：磁盘已满' },
  });
  try {
    const fileButton = [...h.container.querySelectorAll('.dpl-vault2-file')].find((b) => b.textContent.includes('note'));
    assert.ok(fileButton, 'file row present');
    fileButton.closest('.dpl-vault2-row').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }));
    await tick(150);
    const dupItem = [...h.container.querySelectorAll('[data-testid="vault-context-menu"] button')].find((b) => b.textContent === '创建副本');
    assert.ok(dupItem, '创建副本 menu item present');
    assert.ok(
      [...h.container.querySelectorAll('[data-testid="vault-context-menu"] button')].some((b) => b.textContent === '复制'),
      '复制 now means clipboard-copy (fix K)',
    );
    dupItem.click();
    await tick(300);

    const errorNotice = h.container.querySelector('.dpl-vault2-statusnotice.is-error');
    assert.ok(errorNotice, 'failure notice carries the is-error class');
    assert.ok(errorNotice.textContent.includes('磁盘已满'), 'notice shows the failure message');
  } finally { await unmountVault(h); }
});
