/**
 * droplets-dsh client half: mounts the `droplets` Remote namespace and
 * registers the panel (sidebar icon + `main` page with a `droplets.chat`
 * child slot for the native companion conversation). Built into a single
 * window.__ModuleLoader__ bundle; react stays external.
 */
import { DropletsPanel } from './Panel.jsx';
import { NativeConversation } from './NativeConversation.jsx';
import { nativeChatBridge } from './native-chat.js';
import { DropletIcon } from './components.jsx';
import zh from '../../locale/zh.json';
import en from '../../locale/en.json';
import PANEL_CSS from './styles.css';

const PLUGIN_ID = 'droplets-dsh';
export const PANEL_ID = 'droplets';

/** Duck-typed codec stub: the client never parses payloads, it forwards JSON. */
const codec = () => ({
  mode: 'strict',
  typeSymbol: PLUGIN_ID + '#json',
  create: () => ({ parse: (value) => value, safeParse: (value) => ({ success: true, data: value }) }),
});

function method(name, params = true) {
  return {
    id: PLUGIN_ID + '#droplets/' + name,
    service: 'droplets',
    namespace: 'droplets',
    method: name,
    invocation: { kind: 'direct' },
    ...(params ? { parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec() }] } : { parameters: [] }),
    result: { mode: 'src-json' },
    cancellation: { parameter: 'signal' },
  };
}

const NO_PARAM_METHODS = new Set([
  'listChannels', 'listFeeds', 'refreshStatus', 'listSubscriptions', 'opmlExport', 'vaultStatus', 'vaultReindex',
  'vaultTree', 'vaultGraph', 'vaultTags', 'vaultTrashList', 'vaultIndexFiles', 'getSettings', 'getWorkspace', 'getStorageInfo', 'clearData', 'inboxRetryAllFailed',
]);

const TYPERT_REMOTE = {
  package: PLUGIN_ID,
  descriptors: [
    'listChannels', 'listEntries', 'getEntry', 'searchEntries', 'setRead', 'setFavorite',
    'listFeeds', 'refreshStatus', 'listItems', 'setItemState', 'markAllRead', 'setFeed',
    'listSubscriptions', 'addSubscription', 'removeSubscription', 'updateSubscription',
    'opmlPreview', 'opmlImport', 'opmlExport', 'refresh',
    'inboxAddUrl', 'inboxList', 'inboxGet', 'inboxRead', 'inboxReadOriginal',
    'inboxUpdate', 'inboxRetry', 'inboxRetryAllFailed', 'inboxImportMarkdown',
    'inboxMoveToLibrary', 'inboxMoveToTrash', 'inboxMarkDone',
    'vaultStatus', 'vaultReindex', 'vaultTree', 'vaultRead', 'vaultSearch', 'vaultGraph', 'vaultBacklinks', 'vaultWrite',
    'vaultList', 'vaultIndexFiles', 'vaultCreate', 'vaultCreateDir', 'vaultRename', 'vaultDuplicate', 'vaultDelete', 'vaultTags', 'vaultTrashList', 'vaultTrashRestore',
    'getSettings', 'saveSettings', 'getWorkspace', 'setWorkspace', 'openPath', 'getStorageInfo', 'clearData', 'setReadingContext', 'prepareChat',
  ].map((name) => method(name, !NO_PARAM_METHODS.has(name))),
};

export const inject = ['slots', 'layout', 'remote'];

export async function apply(ctx) {
  // Panel styles as one managed <style> node (text loader; bare css imports
  // are silently dropped when bundling to CJS, which once shipped an
  // unstyled panel — the artifact test freezes this contract).
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'droplets: panel styles');

  try {
    await ctx.remote.$mount(TYPERT_REMOTE);
  } catch (error) {
    ctx.logger?.error?.('droplets: failed to mount the droplets Remote namespace: %o', error);
    throw error;
  }
  ctx.inject(['remote.droplets'], (child) => registerPanel(child));
}

function registerPanel(ctx) {
  const call = async (name, ...args) => {
    const namespace = ctx.remote.droplets;
    if (!namespace || typeof namespace[name] !== 'function') {
      throw new Error('Droplets 服务未就绪，请稍后重试');
    }
    const result = await namespace[name](...args);
    if (result.ok) return result.value;
    throw result.error;
  };

  const api = {
    ...nativeChatBridge(ctx),
    setReadingContext: (params) => call('setReadingContext', params),
    listChannels: () => call('listChannels'),
    listEntries: (params) => call('listEntries', params),
    getEntry: (key) => call('getEntry', { key }),
    searchEntries: (query) => call('searchEntries', { query }),
    setRead: (keys, read) => call('setRead', { keys, read }),
    setFavorite: (key, favorite) => call('setFavorite', { key, favorite }),
    listFeeds: () => call('listFeeds'),
    refreshStatus: () => call('refreshStatus'),
    listItems: (params) => call('listItems', params),
    setItemState: (params) => call('setItemState', params),
    markAllRead: (params) => call('markAllRead', params),
    setFeed: (params) => call('setFeed', params),
    listSubscriptions: () => call('listSubscriptions'),
    addSubscription: (params) => call('addSubscription', params),
    removeSubscription: (id) => call('removeSubscription', { id }),
    updateSubscription: (params) => call('updateSubscription', params),
    opmlPreview: (params) => call('opmlPreview', params),
    opmlImport: (xml, urls) => call('opmlImport', { xml, urls }),
    opmlExport: () => call('opmlExport'),
    refresh: (channel) => call('refresh', { channel }),
    inboxAddUrl: (params) => call('inboxAddUrl', params),
    inboxList: (params) => call('inboxList', params),
    inboxGet: (id) => call('inboxGet', { id }),
    inboxReadOriginal: (id) => call('inboxReadOriginal', { id }),
    inboxUpdate: (params) => call('inboxUpdate', params),
    inboxRetry: (id) => call('inboxRetry', { id }),
    inboxRetryAllFailed: () => call('inboxRetryAllFailed'),
    inboxImportMarkdown: (params) => call('inboxImportMarkdown', params),
    inboxMoveToLibrary: (id) => call('inboxMoveToLibrary', { id }),
    inboxMoveToTrash: (id) => call('inboxMoveToTrash', { id }),
    inboxMarkDone: (key) => call('inboxMarkDone', { key }),
    vaultStatus: () => call('vaultStatus'),
    vaultReindex: () => call('vaultReindex'),
    vaultTree: () => call('vaultTree'),
    vaultRead: (path) => call('vaultRead', { path }),
    vaultSearch: (params) => call('vaultSearch', params),
    vaultGraph: () => call('vaultGraph'),
    vaultBacklinks: (path) => call('vaultBacklinks', { path }),
    vaultList: (dir) => call('vaultList', { dir }),
    vaultIndexFiles: () => call('vaultIndexFiles'),
    vaultCreate: (params) => call('vaultCreate', params),
    vaultCreateDir: (params) => call('vaultCreateDir', params),
    vaultRename: (params) => call('vaultRename', params),
    vaultDuplicate: (path) => call('vaultDuplicate', { path }),
    vaultDelete: (path) => call('vaultDelete', { path }),
    vaultTags: () => call('vaultTags'),
    vaultTrashList: () => call('vaultTrashList'),
    vaultTrashRestore: (id) => call('vaultTrashRestore', { id }),
    vaultWrite: (params) => call('vaultWrite', params),
    getSettings: () => call('getSettings'),
    getWorkspace: () => call('getWorkspace'),
    setWorkspace: (params) => call('setWorkspace', params),
    openPath: (params) => call('openPath', params),
    // The remote layer takes the argument object flat (a wrapped { patch }
    // object is silently ignored), so send the patch as the request itself.
    saveSettings: (patch) => call('saveSettings', patch),
    getStorageInfo: () => call('getStorageInfo'),
    clearData: () => call('clearData'),
  };

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: 'droplets',
    children: { 'droplets.chat': { kind: 'single', scope: 'session' } },
    inject: () => ({ api }),
  }, DropletsPanel));

  ctx.slots.inject('droplets.chat', () => ctx.slots.register({ name: 'droplets.chat' }, NativeConversation));

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 16,
    label: () => 'Droplets',
  }, DropletIcon));

  // Locale dictionary from locale/{zh,en}.json (M0 onward, both languages).
  ctx.inject(['locale'], (child) => {
    return child.locale.register('droplets', {
      zh: { title: 'Droplets', ...flattenEntry(zh) },
      en: { title: 'Droplets', ...flattenEntry(en) },
    });
  });
}

function flattenEntry(dict) {
  const out = {};
  const visit = (value, prefix) => {
    for (const [key, item] of Object.entries(value ?? {})) {
      const path = prefix === '' ? key : prefix + '.' + key;
      if (item && typeof item === 'object') visit(item, path);
      else out[path] = String(item);
    }
  };
  visit(dict, '');
  return out;
}
