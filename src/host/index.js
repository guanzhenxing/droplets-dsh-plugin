/**
 * droplets-dsh · host half.
 *
 * One service, three spaces (feed / inbox / vault) plus the cross-cutting
 * store. Spaces are separate modules invoked only through this service; the
 * web panel reaches them through the Remote face and agents through the
 * three multi-action tools — both share these implementations.
 *
 * Self-managed refresh: a 60 s setTimeout chain (unref'd, panel-independent)
 * refreshes feeds with bounded concurrency, per-feed timeouts and caps.
 */
import path from 'node:path';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DropletsStore, defaultVaultPath, entriesDir, storageDir } from './store.js';
import { WorkspaceStore } from './workspace-store.js';
import { WorkspaceInbox, stripUndefined } from './workspace-inbox.js';
import { Vault, ensureDefaultVault, safeResolve } from './vault.js';
import { safeResolveDir as safeResolveDirShared } from './vault.js';
import { createVaultIndex } from './vault-index.js';
import { buildAskPrompt, buildReadingContext, storeContext } from './context.js';
import { createToolDefinitions } from './tools.js';
import { extractArticle } from './extract.js';
import { excerptOf, FEED_LIMITS, mergeEntries, parseFeed, parseOpml, buildOpml, sortByDate, subscriptionIdOf } from './feeds.js';
import { htmlToText } from './sanitize.js';
import { guardedFetch } from './guarded-fetch.js';

export const name = 'droplets';

/** Optional services only: a missing peer must not take the profile down. */
export const inject = ['tools'];

const REFRESH_WORKERS = 3;
const FEED_TIMEOUT_MS = 20_000;

/*
 * Line config as a handwritten Standard Schema v1 validator (the contract
 * Cordis validates with `Config['~standard'].validate()` — see the reader
 * reference). Keys per the plan: vaultPath, refreshInterval, maxBodies,
 * enableTranslation.
 */
const CONFIG_KEYS = new Set(['workspacePath', 'vaultPath', 'refreshInterval', 'maxBodies', 'enableTranslation']);

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'droplets-dsh',
    validate(value) {
      if (value === undefined || value === null) return { value: {} };
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'droplets：配置必须是一个对象' }] };
      }
      const issues = [];
      for (const key of Object.keys(value)) {
        if (!CONFIG_KEYS.has(key)) issues.push({ message: `droplets：不认识配置项「${key}」`, path: [key] });
      }
      if (typeof value.workspacePath === 'string' && value.workspacePath.trim() === '') {
        issues.push({ message: 'droplets：workspacePath 不能为空字符串（留空请删除该键）', path: ['workspacePath'] });
      }
      if (typeof value.vaultPath === 'string' && value.vaultPath.trim() === '') {
        issues.push({ message: 'droplets：vaultPath 不能为空字符串（留空请删除该键）', path: ['vaultPath'] });
      }
      for (const key of ['refreshInterval', 'maxBodies']) {
        if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0)) {
          issues.push({ message: `droplets：「${key}」必须是正数`, path: [key] });
        }
      }
      if (value.enableTranslation !== undefined && typeof value.enableTranslation !== 'boolean') {
        issues.push({ message: 'droplets：enableTranslation 必须是布尔值', path: ['enableTranslation'] });
      }
      if (issues.length > 0) return { issues };
      const result = {};
      if (typeof value.workspacePath === 'string' && value.workspacePath.trim() !== '') result.workspacePath = path.resolve(value.workspacePath.trim());
      if (typeof value.vaultPath === 'string' && value.vaultPath.trim() !== '') result.vaultPath = path.resolve(value.vaultPath.trim());
      if (typeof value.refreshInterval === 'number') result.refreshInterval = Math.max(60_000, Math.floor(value.refreshInterval));
      if (typeof value.maxBodies === 'number') result.maxBodies = Math.floor(value.maxBodies);
      if (typeof value.enableTranslation === 'boolean') result.enableTranslation = value.enableTranslation;
      return { value: result };
    },
  },
};

export class DropletsService extends TypertRemoteService {
  static inject = inject;

  constructor(ctx, config = {}) {
    super(ctx, 'droplets');
    this.ctx = ctx;
    this.config = config;
    // workspacePath switches to sharing the Droplets desktop app's own
    // workspace (its SQLite tables + vault + inbox) instead of a private
    // document, so both apps read and write the same subscriptions and items.
    // The chosen workspace can come from the profile config OR from the
    // in-app switcher (which persists a pointer file so no YAML edit is
    // needed). The pointer wins: it is the user's most recent explicit action.
    this.workspacePointer = join(storageDir(), 'workspace.json');
    this.workspacePath = config.workspacePath ?? null;
    this.store = this.workspacePath
      ? new WorkspaceStore(ctx.logger, this.workspacePath, config.maxBodies ?? 300)
      : new DropletsStore(ctx.logger, config.maxBodies ?? 300);
    this.sharedWorkspace = Boolean(this.workspacePath);
    // The strict shared instance by default; tests (and only tests) may swap
    // this for a permissive factory to exercise the full flow on loopback.
    this.fetcher = guardedFetch;
    this.inbox = this.createInbox();
    this.refreshing = false;
    this.tickTimer = undefined;
    this.stopped = false;
    this.ready = this.readWorkspacePointer().then(async (pointer) => {
      // A pointer written by the in-app switcher replaces whatever the profile
      // config said, so the user's last explicit choice always wins.
      if (pointer !== null) {
        if (pointer === '') {
          // Explicitly switched back to the plugin's private storage.
          if (this.sharedWorkspace) {
            this.workspacePath = null;
            this.sharedWorkspace = false;
            this.store = new DropletsStore(this.ctx.logger, this.config.maxBodies ?? 300);
            this.inbox = this.createInbox();
          }
        } else if (pointer !== this.workspacePath) {
          const probe = await stat(join(pointer, 'state', 'app.sqlite')).catch(() => null);
          if (probe) {
            this.workspacePath = pointer;
            this.sharedWorkspace = true;
            this.store = new WorkspaceStore(this.ctx.logger, pointer, this.config.maxBodies ?? 300);
            this.inbox = this.createInbox();
          }
        }
      }
      return this.store.load();
    }).then(async () => {
      this.store.setMaxBodies(config.maxBodies ?? 300);
      await this.ensureVault(false);
    });

    // Companion context → agent system prompt (order 9500, no interpolation).
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'droplets:reading',
        order: 9500,
        interpolate: false,
        text: ({ agent }) => this.store.data.companionContexts?.[agent?.session?.id]?.text || '',
      });
    });

    // Agent tools share the same implementations as the panel.
    ctx.effect(() => {
      const tools = ctx.get('tools');
      if (tools === undefined) return () => {};
      const disposers = createToolDefinitions(this).map((tool) => tools.register(tool));
      return () => { for (const dispose of disposers) { try { dispose?.(); } catch { /* best effort */ } } };
    }, 'droplets: agent tools');

    this.startTick();
    ctx.logger?.info?.('droplets: service started');
    ctx.effect(() => () => this.shutdown(), 'droplets: flush store on dispose');
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  shutdown() {
    this.stopped = true;
    if (this.tickTimer !== undefined) {
      clearTimeout(this.tickTimer);
      this.tickTimer = undefined;
    }
    void this.store.dispose().catch((error) => this.ctx.logger?.warn?.(String(error)));
  }

  /** Self-managed 60 s tick: unref'd, runs whether or not the panel is open. */
  startTick() {
    if (this.stopped) return;
    const interval = this.config.refreshInterval ?? 60_000;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      void this.refreshAllFeeds().catch(() => {}).finally(() => this.startTick());
    }, interval);
    this.tickTimer.unref?.();
  }

  vaultRoot() {
    const configured = this.config.vaultPath;
    if (typeof configured === 'string' && configured.trim() !== '') return configured;
    // Sharing the Droplets workspace means sharing its markdown vault too.
    if (this.sharedWorkspace) return join(this.store.root, 'vault');
    return defaultVaultPath();
  }

  /**
   * The inbox always uses the native Droplets on-disk format
   * (inbox/<uuid>/{content.md, meta.json}). Shared mode points at the
   * workspace root so both apps process the same items; private mode keeps
   * the same layout inside the plugin's own storage dir.
   */
  createInbox() {
    const root = this.sharedWorkspace && this.store?.root ? this.store.root : join(storageDir(), 'inbox-workspace');
    return new WorkspaceInbox(root, this.ctx?.logger, () => this.fetcher);
  }

  vaultService() {
    const root = this.vaultRoot();
    if (this.vaultInstance === undefined || this.vaultInstance.root !== root) {
      const holder = {
        get: () => this.store.data.vaultCache,
        set: (value) => { this.store.data.vaultCache = value; },
        touch: () => this.store.touch(),
      };
      this.vaultInstance = new Vault(root, holder, this.ctx.logger);
      // Index backend choice follows the vault root: a shared Droplets
      // workspace gets the native index database (read-only); anything else
      // wraps the plugin cache. Recomputed when the root changes.
      this.vaultIndexPromise = createVaultIndex(this.vaultInstance, this.sharedWorkspace && this.store?.root ? this.store.root : null, this.ctx.logger);
      this.vaultIndex = null;
      void this.vaultIndexPromise.then((backend) => { this.vaultIndex = backend; }).catch(() => { this.vaultIndex = null; });
    }
    return this.vaultInstance;
  }

  /** The picked index backend (resolves once per vault root). */
  async indexBackend() {
    this.vaultService();
    if (this.vaultIndex !== null) return this.vaultIndex;
    return this.vaultIndexPromise ?? Promise.resolve(null);
  }

  async ensureVault(seed = true) {
    const root = this.vaultRoot();
    if (root === defaultVaultPath()) {
      try {
        await ensureDefaultVault(root);
      } catch (error) {
        this.ctx.logger?.warn?.(`droplets: cannot create default vault: ${String(error)}`);
      }
      if (seed && this.store.data.vaultCache?.path !== root) {
        await this.vaultService().reindex().catch(() => {});
      }
    }
  }

  // ------------------------------------------------------------------
  // Feed space
  // ------------------------------------------------------------------

  entriesOfFeed(sub) {
    return (sub.entries ?? []).map((entry) => ({ ...entry, channelKey: sub.id, channelName: sub.name }));
  }

  async listChannels() {
    await this.ready;
    const data = this.store.data;
    const countUnread = (entries) => entries.reduce((sum, entry) => (data.states[entry.key] ? sum : sum + 1), 0);
    const channels = [{
      key: 'all',
      kind: 'aggregate',
      name: '全部订阅',
      unread: countUnread(data.subscriptions.flatMap((sub) => this.entriesOfFeed(sub))),
      total: 0,
    }];
    const groups = new Map();
    for (const sub of data.subscriptions) {
      const key = sub.group ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sub);
    }
    for (const [group, subs] of groups) {
      if (group === '') continue;
      channels.push({
        key: `group:${group}`,
        kind: 'aggregate',
        name: group,
        unread: countUnread(subs.flatMap((sub) => this.entriesOfFeed(sub))),
        total: 0,
      });
    }
    for (const sub of data.subscriptions) {
      channels.push({
        key: sub.id,
        kind: 'feed',
        name: sub.name,
        group: sub.group,
        url: sub.url,
        unread: countUnread(sub.entries ?? []),
        total: (sub.entries ?? []).length,
        lastError: sub.lastError,
        lastFetchedAt: sub.lastFetchedAt,
      });
    }
    return { channels };
  }

  entriesOf(channel) {
    const data = this.store.data;
    if (channel === undefined || channel === 'all') {
      return data.subscriptions.flatMap((sub) => this.entriesOfFeed(sub));
    }
    if (channel.startsWith('group:')) {
      const wanted = channel.slice('group:'.length);
      return data.subscriptions.filter((sub) => (sub.group ?? '') === wanted).flatMap((sub) => this.entriesOfFeed(sub));
    }
    const sub = data.subscriptions.find((candidate) => candidate.id === channel);
    return sub ? this.entriesOfFeed(sub) : [];
  }

  entrySummary(entry) {
    const data = this.store.data;
    return {
      key: entry.key,
      channelKey: entry.channelKey,
      channelName: entry.channelName,
      title: entry.title,
      author: entry.author,
      summary: entry.summary,
      publishedAt: entry.publishedAt,
      url: entry.url,
      image: data.settings.showImages === false ? undefined : entry.image,
      read: data.states[entry.key] !== undefined,
      state: data.states[entry.key] ?? 'unseen',
      favorite: data.favorites[entry.key] !== undefined,
      hasBody: typeof entry.html === 'string' && entry.html !== '',
    };
  }

  // ------------------------------------------------------------------
  // droplets-shaped feed API (RssFeed / RssItemView semantics)
  // ------------------------------------------------------------------

  /** Feeds in the droplets RssFeed shape (groupName, enabled, counts). */
  async listFeeds() {
    await this.ready;
    const data = this.store.data;
    return {
      feeds: data.subscriptions.map((sub) => ({
        id: sub.id,
        title: sub.name,
        url: sub.url,
        groupName: sub.group ?? '',
        enabled: sub.enabled !== false,
        lastFetchAt: sub.lastFetchedAt ?? null,
        lastError: sub.lastError ?? null,
        unreadCount: (sub.entries ?? []).filter((entry) => data.states[entry.key] === undefined).length,
        itemCount: (sub.entries ?? []).length,
      })),
    };
  }

  /**
   * Items in the droplets RssItemView shape. sourceId undefined = all feeds
   * (aggregated view); groupName filters to one group (mutually exclusive
   * with sourceId, exactly like droplets).
   */
  async listItems(request) {
    const { sourceId, groupName, limit } = request ?? {};
    await this.ready;
    const data = this.store.data;
    // The list carries no article bodies (the reader fetches those on open),
    // so it can hold the whole scope instead of a 120-row window.
    const size = Math.min(Math.max(limit ?? 5000, 1), 8000);
    let pool = [];
    if (typeof sourceId === 'string' && sourceId) {
      const sub = data.subscriptions.find((candidate) => candidate.id === sourceId);
      pool = sub ? this.entriesOfFeed(sub) : [];
    } else if (typeof groupName === 'string') {
      pool = data.subscriptions
        .filter((sub) => (sub.group ?? '') === groupName)
        .flatMap((sub) => this.entriesOfFeed(sub));
    } else {
      pool = data.subscriptions.flatMap((sub) => this.entriesOfFeed(sub));
    }
    // Reading order: every unread item first, newest to oldest inside each
    // group — the order the list has to show on entry, for 全部源 as well.
    const isUnread = (entry) => (data.states[entry.key] === undefined ? 0 : 1);
    pool.sort((a, b) => isUnread(a) - isUnread(b) || sortByDate(a, b));
    return {
      items: pool.slice(0, size).map((entry) => ({
        sourceId: entry.channelKey,
        key: entry.key,
        title: entry.title,
        link: entry.url ?? '',
        // Excerpt only: bodies are fetched per article when opened.
        summary: (entry.summary ?? '').slice(0, 200),
        content: '',
        publishedAt: entry.publishedAt ?? null,
        state: data.states[entry.key] ?? 'unseen',
      })),
    };
  }

  /** Three-state item marking: 'seen' | 'skipped' | 'unseen' (clears). */
  async setItemState(request) {
    const { keys, state } = request ?? {};
    await this.ready;
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      if (typeof key !== 'string') continue;
      if (state === 'unseen') delete this.store.data.states[key];
      else if (state === 'seen' || state === 'skipped') this.store.data.states[key] = state;
    }
    this.pruneStateIds();
    this.store.touch();
    return { ok: true };
  }

  /** Keep the states map bounded like the legacy read map. */
  pruneStateIds() {
    const states = this.store.data.states;
    const keys = Object.keys(states);
    if (keys.length <= 10000) return;
    // No timestamps on states; keep insertion order and hard-cap the map.
    const ranked = keys;
    for (const key of ranked.slice(10000)) delete states[key];
  }

  /** Mark everything in a scope as seen (sourceId / groupName / all). */
  async markAllRead(request) {
    const { sourceId, groupName } = request ?? {};
    await this.ready;
    const states = this.store.data.states;
    let channel = 'all';
    if (typeof sourceId === 'string' && sourceId) channel = sourceId;
    else if (typeof groupName === 'string') channel = 'group:' + groupName;
    let count = 0;
    for (const entry of this.entriesOf(channel)) {
      if (states[entry.key] === undefined) {
        states[entry.key] = 'seen';
        count += 1;
      }
    }
    this.store.touch();
    return { marked: count };
  }

  /** Feed management patch: rename / regroup / enable-disable. */
  async setFeed(request) {
    const { id, patch } = request ?? {};
    await this.ready;
    const sub = this.store.data.subscriptions.find((candidate) => candidate.id === id);
    if (!sub) throw new Error(`no subscription ${id}`);
    if (typeof patch?.name === 'string' && patch.name.trim() !== '') sub.name = patch.name.trim();
    if (typeof patch?.group === 'string') sub.group = patch.group.trim() || undefined;
    if (typeof patch?.enabled === 'boolean') sub.enabled = patch.enabled;
    this.store.touch();
    await this.store.flush();
    return { ok: true };
  }

  async listEntries(request) {
    const { channel, filter, search, cursor, limit } = request ?? {};
    await this.ready;
    const size = Math.min(Math.max(limit ?? 30, 1), 100);
    let entries = this.entriesOf(channel);
    entries.sort(sortByDate);
    if (search && search.trim() !== '') {
      const needle = search.trim().toLowerCase();
      entries = entries.filter((entry) => entry.title.toLowerCase().includes(needle) || entry.summary?.toLowerCase().includes(needle));
    }
    if (filter === 'unread') entries = entries.filter((entry) => this.store.data.states[entry.key] === undefined);
    if (filter === 'favorite' || filter === 'favorites') entries = entries.filter((entry) => this.store.data.favorites[entry.key] !== undefined);
    const offset = typeof cursor === 'string' && cursor.startsWith('off:') ? Number(cursor.slice(4)) || 0 : 0;
    const page = entries.slice(offset, offset + size);
    const hasMore = offset + size < entries.length;
    return {
      entries: page.map((entry) => this.entrySummary(entry)),
      hasMore,
      ...(hasMore ? { nextCursor: `off:${offset + size}` } : {}),
    };
  }

  async getEntry(request) {
    const { key } = request ?? {};
    await this.ready;
    const entry = this.findEntry(key);
    if (!entry) throw new Error(`droplets: unknown entry ${key}`);
    return { entry: this.entrySummary(entry), html: entry.html, truncated: entry.truncated === true };
  }

  findEntry(key) {
    for (const sub of this.store.data.subscriptions) {
      const entry = (sub.entries ?? []).find((candidate) => candidate.key === key);
      if (entry) return { ...entry, channelKey: sub.id, channelName: sub.name };
    }
    return undefined;
  }

  async searchEntries(request) {
    const { query, limit } = request ?? {};
    await this.ready;
    const size = Math.min(Math.max(limit ?? 20, 1), 50);
    const needle = String(query ?? '').trim().toLowerCase();
    if (needle === '') return [];
    const seen = new Set();
    const out = [];
    for (const entry of this.entriesOf('all').sort(sortByDate)) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      if (entry.title.toLowerCase().includes(needle) || entry.summary?.toLowerCase().includes(needle)) {
        out.push(this.entrySummary(entry));
        if (out.length >= size) break;
      }
    }
    return out;
  }

  /** Legacy two-state marking kept for the agent tools; writes the states map. */
  async setRead(request) {
    const { keys, read } = request ?? {};
    await this.ready;
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      if (typeof key !== 'string') continue;
      if (read === false) delete this.store.data.states[key];
      else this.store.data.states[key] = 'seen';
    }
    this.store.touch();
    return { ok: true };
  }

  async setFavorite(request) {
    const { key, favorite } = request ?? {};
    await this.ready;
    if (typeof key !== 'string') throw new Error('无效条目');
    if (favorite === false) delete this.store.data.favorites[key];
    else this.store.data.favorites[key] = Date.now();
    this.store.touch();
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Subscriptions & OPML
  // ------------------------------------------------------------------

  async listSubscriptions() {
    await this.ready;
    return {
      subscriptions: this.store.data.subscriptions.map((sub) => ({
        id: sub.id,
        url: sub.url,
        name: sub.name,
        group: sub.group,
        addedAt: sub.addedAt,
        lastFetchedAt: sub.lastFetchedAt,
        lastError: sub.lastError,
        entryCount: (sub.entries ?? []).length,
      })),
    };
  }

  async addSubscription(request) {
    const { url, name, group } = request ?? {};
    await this.ready;
    const trimmed = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(trimmed)) throw new Error('订阅地址必须是 http(s) URL');
    if (this.store.data.subscriptions.length >= FEED_LIMITS.maxSubscriptions) {
      throw new Error(`订阅最多 ${FEED_LIMITS.maxSubscriptions} 个`);
    }
    const existing = this.store.data.subscriptions.find((sub) => sub.url === trimmed);
    if (existing) throw new Error(`该订阅已存在：${existing.name}`);
    const displayName = String(name ?? '').trim();
    // An unreachable feed is still worth subscribing to: record the failure
    // and let refresh() retry, like a temporarily down source.
    let entries = [];
    let status = 'ok';
    let lastError;
    let feedTitle;
    try {
      const xml = await this.fetchFeedText(trimmed);
      const parsed = parseFeed(xml, trimmed);
      entries = parsed.entries;
      feedTitle = parsed.title;
    } catch (error) {
      status = 'error';
      lastError = error instanceof Error ? error.message : String(error);
    }
    const sub = {
      id: subscriptionIdOf(trimmed),
      url: trimmed,
      name: displayName || feedTitle || trimmed,
      group: String(group ?? '').trim() || undefined,
      addedAt: Date.now(),
      lastFetchedAt: feedTitle ? Date.now() : undefined,
      status,
      lastError,
      entries,
    };
    this.store.data.subscriptions.push(sub);
    this.store.touch();
    await this.store.flush();
    return { id: sub.id, name: sub.name, entryCount: (sub.entries ?? []).length, status, lastError };
  }

  async removeSubscription(request) {
    const id = typeof request === 'string' ? request : request?.id;
    await this.ready;
    let target = this.store.data.subscriptions.find((sub) => sub.id === id);
    if (!target && typeof id === 'string' && /^https?:\/\//i.test(id)) target = this.store.data.subscriptions.find((sub) => sub.url === id);
    if (!target) return false;
    const index = this.store.data.subscriptions.indexOf(target);
    this.store.data.subscriptions.splice(index, 1);
    for (const entry of target.entries ?? []) {
      this.store.bodies.delete([entry.key]);
    }
    this.store.touch();
    await this.store.flush();
    return true;
  }

  async updateSubscription(request) {
    const { id, name, group } = request ?? {};
    await this.ready;
    const sub = this.store.data.subscriptions.find((candidate) => candidate.id === id);
    if (!sub) throw new Error(`no subscription ${id}`);
    if (typeof name === 'string' && name.trim() !== '') sub.name = name.trim();
    if (typeof group === 'string') sub.group = group.trim() || undefined;
    this.store.touch();
    await this.store.flush();
    return { id: sub.id, name: sub.name, group: sub.group };
  }

  async opmlPreview(request) {
    await this.ready;
    let xml = String(request?.xml ?? '');
    if (request?.url) {
      const url = new URL(request.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入 HTTP(S) OPML 地址');
      xml = await this.fetchFeedText(url.href);
    }
    if (xml.length > 5 * 1024 * 1024) throw new Error('OPML 超过 5 MB');
    const entries = parseOpml(xml).map((entry) => ({ ...entry, duplicate: this.store.data.subscriptions.some((sub) => sub.url === entry.url) }));
    if (entries.length === 0) throw new Error('未找到有效的 OPML 订阅');
    return { xml, entries };
  }

  async opmlImport(request) {
    const { xml, urls } = request ?? {};
    await this.ready;
    if (urls !== undefined && (!Array.isArray(urls) || urls.some((url) => typeof url !== 'string'))) throw new Error('无效的订阅选择');
    if (String(xml ?? '').length > 5 * 1024 * 1024) throw new Error('OPML 超过 5 MB');
    const stubs = parseOpml(String(xml ?? '')).filter((entry) => urls === undefined || urls.includes(entry.url));
    let added = 0;
    for (const stub of stubs) {
      if (this.store.data.subscriptions.length >= FEED_LIMITS.maxSubscriptions) break;
      if (this.store.data.subscriptions.some((sub) => sub.url === stub.url)) continue;
      this.store.data.subscriptions.push({
        id: subscriptionIdOf(stub.url),
        url: stub.url,
        name: stub.name ?? stub.url,
        group: stub.group,
        addedAt: Date.now(),
        entries: [],
      });
      added += 1;
    }
    this.store.touch();
    return { added, skipped: stubs.length - added };
  }

  async opmlExport() {
    await this.ready;
    return { xml: buildOpml(this.store.data.subscriptions) };
  }

  /** Per-feed fetch timeout, preferring the user's setting. */
  feedTimeoutMs() {
    const seconds = this.store.data.settings.fetchTimeoutSec;
    if (typeof seconds === 'number' && seconds >= 5 && seconds <= 300) return seconds * 1000;
    return FEED_TIMEOUT_MS;
  }

  async fetchFeedText(url) {
    const budget = this.feedTimeoutMs();
    const response = await this.fetcher.fetch(url, {
      connectTimeoutMs: budget,
      totalTimeoutMs: budget,
      maxBodyBytes: 5 * 1024 * 1024,
    });
    if (response.status >= 400) throw new Error(`HTTP ${response.status} for ${url}`);
    const contentType = String(response.headers['content-type'] ?? '');
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
    return new TextDecoder(charset ?? 'utf-8', { fatal: false }).decode(response.body);
  }

  // ------------------------------------------------------------------
  // Refresh
  // ------------------------------------------------------------------

  /** Live refresh progress for the UI (Remote: refreshStatus). */
  refreshProgress = { running: false, total: 0, done: 0, ok: 0, failed: 0, errors: [] };

  async refreshStatus() {
    await this.ready;
    // Before (or between) refreshes in this process there is no live run, so
    // derive the summary from what is already on disk: an app restart must
    // still tell the user how many feeds are healthy and WHY the others
    // failed — never an empty "no information" state.
    if (this.refreshProgress.running) return { ...this.refreshProgress };
    const feeds = this.store.data.subscriptions.filter((sub) => sub.enabled !== false);
    const errors = [];
    let ok = 0;
    let failed = 0;
    let fetched = 0;
    let finishedAt = this.refreshProgress.finishedAt;
    for (const sub of feeds) {
      // "done" means attempted, not succeeded: a feed that failed still
      // consumed a slot in the run and must show up in the ratio.
      const attempted = sub.lastAttemptAt ?? sub.lastFetchedAt;
      if (attempted) {
        fetched += 1;
        if (!finishedAt || attempted > finishedAt) finishedAt = attempted;
      }
      if (sub.lastError) {
        failed += 1;
        if (errors.length < 100) errors.push({ name: sub.name || sub.url, reason: sub.lastError });
      } else {
        ok += 1;
      }
    }
    return {
      running: false,
      total: feeds.length,
      done: fetched,
      ok,
      failed,
      errors,
      finishedAt,
    };
  }

  async refresh(request) {
    const { channel } = request ?? {};
    await this.ready;
    const outcome = { feeds: 0, entries: 0, errors: 0 };
    const subs = this.selectSubscriptions(channel);
    this.refreshProgress = { running: true, total: subs.length, done: 0, ok: 0, failed: 0, startedAt: Date.now(), errors: [] };
    const workers = Math.min(8, Math.max(1, Number(this.store.data.settings.refreshWorkers) || REFRESH_WORKERS));
    await this.forEachWithPool(subs, workers, async (sub) => {
      const count = await this.refreshSubscription(sub);
      outcome.feeds += 1;
      outcome.entries += count;
      const progress = this.refreshProgress;
      progress.done += 1;
      if (sub.lastError) {
        outcome.errors += 1;
        progress.failed += 1;
        if (progress.errors.length < 100) progress.errors.push({ name: sub.name, reason: sub.lastError });
      } else {
        progress.ok += 1;
      }
    });
    this.refreshProgress = { ...this.refreshProgress, running: false, finishedAt: Date.now() };
    // Only persist when something actually changed (refreshSubscription
    // touches per mutation); an idle instance must never flush over a
    // concurrent writer.
    this.pruneBodies();
    return outcome;
  }

  selectSubscriptions(channel) {
    // Disabled feeds never auto-refresh (droplets refresh strategy minimum).
    const subs = this.store.data.subscriptions.filter((sub) => sub.enabled !== false);
    if (typeof channel === 'string' && channel !== 'all' && !channel.startsWith('group:')) {
      const sub = subs.find((candidate) => candidate.id === channel);
      return sub ? [sub] : [];
    }
    if (typeof channel === 'string' && channel.startsWith('group:')) {
      const wanted = channel.slice('group:'.length);
      return subs.filter((sub) => (sub.group ?? '') === wanted);
    }
    return subs;
  }

  async refreshAllFeeds() {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      await this.refresh({});
    } finally {
      this.refreshing = false;
    }
  }

  async refreshSubscription(sub) {
    try {
      const xml = await this.fetchFeedText(sub.url);
      const parsed = parseFeed(xml, sub.url);
      sub.name = sub.name || parsed.title;
      const previous = sub.entries ?? [];
      const merged = mergeEntries(previous, parsed.entries);
      const changed = sub.lastError !== undefined
        || merged.length !== previous.length
        || (merged[0]?.key ?? '') !== (previous[0]?.key ?? '');
      sub.lastFetchedAt = Date.now();
      sub.lastAttemptAt = sub.lastFetchedAt;
      sub.lastError = undefined;
      sub.status = 'ok';
      sub.entries = merged;
      if (changed) this.store.touch();
      return parsed.entries.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (sub.lastError === message) return 0; // same failure, nothing new
      sub.lastError = message;
      sub.lastAttemptAt = Date.now();
      sub.status = 'error';
      this.store.touch();
      return 0;
    }
  }

  /** Bounded-concurrency iteration that never rejects. */
  async forEachWithPool(items, workers, worker) {
    let index = 0;
    const runners = Array.from({ length: Math.min(workers, Math.max(items.length, 1)) }, async () => {
      while (index < items.length) {
        const current = items[index];
        index += 1;
        try {
          await worker(current);
        } catch {
          // worker owns its error reporting
        }
      }
    });
    await Promise.all(runners);
  }

  /** Cap stored bodies; favorites and current entries stay pinned. */
  pruneBodies() {
    const metadata = new Set();
    const pinned = new Set();
    for (const sub of this.store.data.subscriptions) {
      for (const entry of sub.entries ?? []) {
        metadata.add(entry.key);
        if (this.store.data.favorites[entry.key] !== undefined) pinned.add(entry.key);
      }
    }
    // The inbox now lives on the workspace (meta/content on disk), so it no
    // longer registers bodies with the sidecar body store.
    this.store.bodies.prune(metadata, pinned);
    this.store.bodies.touch();
  }

  // ------------------------------------------------------------------
  // Inbox space (workspace-native: same files as the Droplets desktop app)
  // ------------------------------------------------------------------

  async inboxAddUrl(request) {
    await this.ready;
    const url = typeof request === 'string' ? request : request?.url;
    const { item, duplicate } = await this.inbox.addUrl(url);
    return { item, duplicate };
  }

  async inboxList(request) {
    await this.ready;
    const filter = typeof request === 'string' ? { status: request } : {
      status: request?.status,
      tag: request?.tag,
      query: request?.query,
    };
    const result = await this.inbox.list(filter);
    return { items: result.items, counts: result.counts, pendingIds: result.pendingIds };
  }

  /** Full read model for one item (native inbox:get shape). */
  async inboxGet(request) {
    await this.ready;
    const id = typeof request === 'string' ? request : request?.id;
    if (typeof id !== 'string' || id === '') throw new Error('无效条目');
    const existing = await this.inbox.get(id);
    if (!existing) return { item: null, content: null };
    return { item: existing.meta, content: existing.content };
  }

  /** PDF/EPUB original bytes for the client-side readers. */
  async inboxReadOriginal(request) {
    await this.ready;
    const id = typeof request === 'string' ? request : request?.id;
    if (typeof id !== 'string' || id === '') throw new Error('无效条目');
    return this.inbox.readOriginal(id);
  }

  /** Agent-tool read: item + plain text (markdown body or extracted layer). */
  async inboxRead(request) {
    await this.ready;
    const key = typeof request === 'string' ? request : request?.key;
    if (typeof key !== 'string' || key === '') throw new Error('无效条目');
    const existing = await this.inbox.get(key);
    if (!existing) throw new Error(`收件箱里没有这一条：${key}`);
    const text = await this.inbox.plainText(key).catch(() => '');
    return { item: existing.meta, content: existing.content, text };
  }

  /** Update status/tags/title (native inbox:update). */
  async inboxUpdate(request) {
    await this.ready;
    const id = typeof request === 'string' ? request : request?.id;
    const patch = request?.patch ?? {};
    if (typeof id !== 'string' || id === '') throw new Error('无效条目');
    if (patch.status !== undefined && !['unread', 'finished', 'fetch_failed'].includes(patch.status)) {
      throw new Error('无效状态');
    }
    if (patch.tags !== undefined && (!Array.isArray(patch.tags) || patch.tags.some((tag) => typeof tag !== 'string'))) {
      throw new Error('标签必须是字符串数组');
    }
    const item = await this.inbox.updateMeta(id, patch);
    return { item };
  }

  async inboxRetry(request) {
    await this.ready;
    const id = typeof request === 'string' ? request : request?.id;
    if (typeof id !== 'string' || id === '') throw new Error('无效条目');
    const item = await this.inbox.retry(id);
    return { item };
  }

  async inboxRetryAllFailed() {
    await this.ready;
    return this.inbox.retryAllFailed();
  }

  /** Markdown import (file content picked client-side). */
  async inboxImportMarkdown(request) {
    await this.ready;
    const content = request?.content;
    if (typeof content !== 'string' || content.trim() === '') throw new Error('导入内容为空');
    if (content.length > 2_000_000) throw new Error('文件过大（>2 MB）');
    const item = await this.inbox.importMarkdown({
      filename: request?.filename,
      content,
      title: typeof request?.title === 'string' ? request.title : undefined,
      tags: Array.isArray(request?.tags) ? request.tags : undefined,
    });
    return { item };
  }

  /** 处理完成 → 保留到资料库 (native library:move-from-inbox). */
  async inboxMoveToLibrary(request) {
    await this.ready;
    const id = typeof request === 'string' ? request : request?.id;
    if (typeof id !== 'string' || id === '') throw new Error('无效条目');
    const item = await this.inbox.moveToLibrary(id);
    return { item };
  }

  /** 处理完成 → 移入回收站 (native trash:add). */
  async inboxMoveToTrash(request) {
    await this.ready;
    const id = typeof request === 'string' ? request : request?.id;
    if (typeof id !== 'string' || id === '') throw new Error('无效条目');
    const entry = await this.inbox.moveToTrash(id);
    return { entry };
  }

  /** Legacy agent-tool name: 处理完成并删除 — now a recoverable trash move. */
  async inboxMarkDone(request) {
    await this.ready;
    const key = typeof request === 'string' ? request : request?.key;
    if (typeof key !== 'string' || key === '') throw new Error('无效条目');
    await this.inbox.moveToTrash(key);
    return { removed: true, trashed: true };
  }

  // ------------------------------------------------------------------
  // Vault space
  // ------------------------------------------------------------------

  async vaultStatus() {
    await this.ready;
    await this.ensureVault();
    const vault = this.vaultService();
    const stats = vault.stats();
    return {
      root: vault.root,
      files: stats.files,
      builtAt: stats.builtAt,
      configured: typeof this.config.vaultPath === 'string' && this.config.vaultPath.trim() !== '',
    };
  }

  async vaultReindex() {
    await this.ready;
    await this.ensureVault();
    return this.vaultService().reindex();
  }

  async vaultTree() {
    await this.ready;
    const vault = this.vaultService();
    if (!vault.cache() || vault.cache().path !== vault.root) await vault.reindex();
    return { tree: vault.tree(), stats: this.vaultStats(vault) };
  }

  vaultStats(vault) {
    const stats = vault.stats();
    return { root: vault.root, files: stats.files, builtAt: stats.builtAt };
  }

  async vaultRead(request) {
    await this.ready;
    const p = typeof request === 'string' ? request : request?.path;
    return this.vaultService().read(p);
  }

  /** Lazy directory listing for the tree panel (plan §7 vaultList). */
  async vaultList(request) {
    await this.ready;
    const dir = typeof request === 'string' ? request : request?.dir;
    return stripUndefined(await this.vaultService().list(dir ?? ''));
  }

  /** One-shot flat file index (quick switcher / filter / wikilinks). */
  async vaultIndexFiles() {
    await this.ready;
    return this.vaultService().indexFiles();
  }

  async vaultCreate(request) {
    await this.ready;
    await this.ensureVault();
    return stripUndefined(await this.vaultService().createNote(request?.dir ?? '', request?.title, { template: request?.template }));
  }

  async vaultCreateDir(request) {
    await this.ready;
    await this.ensureVault();
    return stripUndefined(await this.vaultService().createDir(request?.dir));
  }

  async vaultRename(request) {
    await this.ready;
    const from = typeof request === 'string' ? request : request?.from;
    // Folders ride the same RPC: no .md suffix → dir rename/move.
    if (typeof from === 'string' && !from.toLowerCase().endsWith('.md')) {
      return stripUndefined(await this.vaultService().renameDir(from, request?.to));
    }
    return stripUndefined(await this.vaultService().renameNote(from, request?.to, { updateLinks: request?.updateLinks !== false }));
  }

  async vaultCopyTo(request) {
    await this.ready;
    return stripUndefined(await this.vaultService().copyTo(request?.from, request?.toDir ?? ''));
  }

  async vaultCopyDirTo(request) {
    await this.ready;
    return stripUndefined(await this.vaultService().copyDir(request?.from, request?.toDir ?? ''));
  }

  /** 树右键「在 Finder 中显示」（reveal & select）。 */
  async vaultReveal(request) {
    await this.ready;
    const rel = typeof request === 'string' ? request : request?.path;
    const vault = this.vaultService();
    const target = rel.toLowerCase().endsWith('.md')
      ? await safeResolve(vault.root, rel)
      : await safeResolveDirShared(vault.root, rel);
    const { execFile } = await import('node:child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const args = process.platform === 'darwin'
      ? ['-R', target]
      : process.platform === 'win32'
        ? ['/select,', target]
        : [target];
    await new Promise((resolve, reject) => execFile(cmd, args, (error) => (error ? reject(error) : resolve())));
    return { revealed: true };
  }

  /** 复制绝对/相对路径到系统剪贴板（pbcopy / clip / xclip|wl-copy）。 */
  async vaultCopyPath(request) {
    await this.ready;
    const rel = typeof request === 'string' ? request : request?.path;
    const vault = this.vaultService();
    const absolute = join(vault.root, rel);
    const text = request?.relative ? rel : absolute;
    const { execFile } = await import('node:child_process');
    const candidates = process.platform === 'darwin'
      ? ['pbcopy']
      : process.platform === 'win32'
        ? ['clip']
        : ['xclip', '-selection', 'clipboard'];
    await new Promise((resolve, reject) => {
      const child = execFile(candidates[0], candidates.slice(1), (error) => (error ? reject(error) : resolve()));
      child.stdin?.end(text, 'utf8');
    });
    return { copied: text };
  }

  async vaultDuplicate(request) {
    await this.ready;
    const p = typeof request === 'string' ? request : request?.path;
    return stripUndefined(await this.vaultService().duplicate(p));
  }

  /** vaultDelete → .trash（Droplets 回收站可恢复）。 */
  async vaultDelete(request) {
    await this.ready;
    const p = typeof request === 'string' ? request : request?.path;
    return stripUndefined(await this.vaultService().trash(p));
  }

  /** Trash browser: list vault-origin entries (native naming included). */
  async vaultTrashList() {
    await this.ready;
    const entries = [];
    const names = await readdir(join(this.vaultRoot(), '.trash')).catch(() => []);
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const dir = join(this.vaultRoot(), '.trash', name);
      const metaRaw = await readFile(join(dir, 'trash-meta.json'), 'utf8').catch(() => null);
      let meta;
      try { meta = JSON.parse(metaRaw); } catch { meta = null; }
      entries.push({
        id: name,
        title: meta?.title ?? name,
        deletedAt: meta?.deletedAt,
        entryKind: meta?.entryKind ?? (existsSync(join(dir, 'payload')) && statSync(join(dir, 'payload')).isDirectory() ? 'directory' : 'file'),
        sizeBytes: meta?.sizeBytes,
        fileCount: meta?.fileCount,
      });
    }
    entries.sort((a, b) => String(b.deletedAt ?? '').localeCompare(String(a.deletedAt ?? '')));
    return stripUndefined({ entries });
  }

  /** Restore one trash entry back to its vault path (conflict → error). */
  async vaultTrashRestore(request) {
    await this.ready;
    const id = typeof request === 'string' ? request : request?.id;
    if (typeof id !== 'string' || id === '' || id.includes('/') || id.startsWith('.')) throw new Error('无效回收站条目');
    const trashDir = join(this.vaultRoot(), '.trash', id);
    const metaRaw = await readFile(join(trashDir, 'trash-meta.json'), 'utf8').catch(() => null);
    let meta = null;
    try { meta = metaRaw ? JSON.parse(metaRaw) : null; } catch { meta = null; }
    // originalRelPath was stored as 'vault/<rel>' or 'vault/<rel>/' by trash().
    const original = String(meta?.originalRelPath ?? '');
    const rel = original.startsWith('vault/') ? original.slice('vault/'.length).replace(/\/+$/, '') : '';
    if (rel === '') throw new Error('该条目缺少原始路径信息，无法自动恢复');
    const target = join(this.vaultRoot(), rel);
    if (existsSync(target)) throw new Error(`目标已存在，无法恢复：${rel}`);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(join(trashDir, 'payload'), target);
    await rm(trashDir, { recursive: true, force: true });
    return { restored: rel };
  }

  async vaultSearch(request) {
    await this.ready;
    const query = typeof request === 'string' ? request : request?.query;
    const limit = Math.min(Math.max(request?.limit ?? 30, 1), 100);
    // Preferred: the native index (exact counts with the desktop app).
    const backend = await this.indexBackend().catch(() => null);
    if (backend) {
      const result = await backend.search(query, { limit, offset: request?.offset ?? 0, tag: request?.tag }).catch(() => null);
      if (result !== null) {
        return {
          backend: 'native',
          results: result.hits.map((hit) => ({ path: hit.path, title: hit.title, tags: [], match: 'fts', excerpt: hit.snippet })),
          total: result.total,
        };
      }
    }
    const vault = this.vaultService();
    if (!vault.cache() || vault.cache().path !== vault.root) await vault.reindex();
    const results = await vault.search(query, limit);
    return { backend: 'local', results, total: results.length };
  }

  /** Tag cloud counts (plan §7 vaultTags). */
  async vaultTags() {
    await this.ready;
    const backend = await this.indexBackend().catch(() => null);
    if (backend) {
      const tags = await backend.tags().catch(() => null);
      if (tags !== null) return { backend: 'native', tags };
    }
    const vault = this.vaultService();
    if (!vault.cache() || vault.cache().path !== vault.root) await vault.reindex();
    const local = await import('./vault-index.js').then((mod) => new mod.LocalVaultIndex(vault));
    return { backend: 'local', tags: await local.tags() };
  }

  async vaultGraph() {
    await this.ready;
    const vault = this.vaultService();
    if (!vault.cache() || vault.cache().path !== vault.root) await vault.reindex();
    return stripUndefined(vault.graph());
  }

  async vaultBacklinks(request) {
    await this.ready;
    const p = typeof request === 'string' ? request : request?.path;
    const vault = this.vaultService();
    const record = vault.cache()?.files?.[p];
    const title = record?.title;
    const backend = await this.indexBackend().catch(() => null);
    if (backend) {
      const [links, unlinked] = await Promise.all([
        backend.backlinks(p, title).catch(() => null),
        typeof backend.unlinkedMentions === 'function' ? backend.unlinkedMentions(p, title).catch(() => []) : Promise.resolve([]),
      ]);
      if (links !== null) return stripUndefined({ backend: 'native', backlinks: links, unlinked });
    }
    return stripUndefined({ backend: 'local', backlinks: vault.backlinks(p, title), unlinked: [] });
  }

  async vaultWrite(request) {
    await this.ready;
    const { path: rel, content, expectedSha, createOnly } = request ?? {};
    return this.vaultService().write(rel, content, { expectedSha, createOnly });
  }

  // ------------------------------------------------------------------
  // Settings & storage
  // ------------------------------------------------------------------

  async getSettings() {
    await this.ready;
    return {
      settings: { ...this.store.data.settings },
      config: {
        vaultPath: this.config.vaultPath ?? '',
        refreshInterval: this.config.refreshInterval ?? 60_000,
        maxBodies: this.config.maxBodies ?? 300,
        enableTranslation: this.config.enableTranslation === true,
      },
    };
  }

  async saveSettings(request) {
    await this.ready;
    // The remote layer may deliver either { patch } or the patch itself;
    // accept both so the settings screen is not silently a no-op.
    const patch = request?.patch ?? request ?? {};
    const settings = this.store.data.settings;
    if (patch.showImages !== undefined) settings.showImages = patch.showImages !== false;
    for (const key of ['refreshOnStart', 'hoverPreview']) {
      if (patch[key] !== undefined) settings[key] = patch[key] === true;
    }
    if (patch.refreshMinutes !== undefined) {
      const minutes = Number(patch.refreshMinutes);
      if ([15, 30, 60, 180].includes(minutes)) settings.refreshMinutes = minutes;
    }
    if (patch.cacheDays !== undefined) {
      const days = Number(patch.cacheDays);
      if (Number.isFinite(days) && days >= 1 && days <= 3650) settings.cacheDays = Math.floor(days);
    }
    if (patch.refreshWorkers !== undefined) {
      const workers = Number(patch.refreshWorkers);
      if (Number.isFinite(workers) && workers >= 1 && workers <= 8) settings.refreshWorkers = Math.floor(workers);
    }
    if (patch.fetchTimeoutSec !== undefined) {
      const seconds = Number(patch.fetchTimeoutSec);
      if (Number.isFinite(seconds) && seconds >= 5 && seconds <= 300) settings.fetchTimeoutSec = Math.floor(seconds);
    }
    this.store.touch();
    await this.store.flush();
    return this.getSettings();
  }

  /** Read the persisted workspace pointer (null = private storage). */
  async readWorkspacePointer() {
    try {
      const raw = await readFile(this.workspacePointer, 'utf8');
      const parsed = JSON.parse(raw);
      return typeof parsed?.path === 'string' && parsed.path.trim() !== '' ? parsed.path : null;
    } catch {
      return null;
    }
  }

  /**
   * Switch the storage root at runtime. Accepts a Droplets workspace (one that
   * carries state/app.sqlite, or at least droplets.json) or '' to fall back to
   * the plugin's private storage. Persists the choice so the next boot honours
   * it without touching any profile YAML.
   */
  async setWorkspace(request) {
    await this.ready;
    const requested = String(request?.path ?? '').trim();
    let target = null;
    if (requested !== '') {
      const resolved = path.resolve(requested);
      const checks = await Promise.all([
        stat(join(resolved, 'state', 'app.sqlite')).catch(() => null),
        stat(join(resolved, 'droplets.json')).catch(() => null),
      ]);
      if (!checks[0] && !checks[1]) {
        throw new Error('droplets：这个目录不像 Droplets 工作区（缺少 state/app.sqlite 或 droplets.json）');
      }
      if (!checks[0]) throw new Error('droplets：缺少 state/app.sqlite，无法共用数据');
      target = resolved;
    }

    // Flush and release the current backend before swapping it out.
    await this.store.flush().catch(() => {});
    await this.store.dispose?.().catch?.(() => {});

    this.workspacePath = target;
    this.sharedWorkspace = Boolean(target);
    this.store = target
      ? new WorkspaceStore(this.ctx.logger, target, this.config.maxBodies ?? 300)
      : new DropletsStore(this.ctx.logger, this.config.maxBodies ?? 300);
    this.vaultInstance = undefined;
    this.inbox = this.createInbox();
    this.ready = this.store.load().then(async () => {
      this.store.setMaxBodies(this.config.maxBodies ?? 300);
      await ensureDefaultVault(this.vaultRoot());
    });
    await this.ready;

    await mkdir(storageDir(), { recursive: true });
    const temp = this.workspacePointer + '.' + process.pid + '.tmp';
    await writeFile(temp, JSON.stringify({ path: target ?? '' }), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.workspacePointer);

    return this.getWorkspace();
  }

  /** Workspace screen: where the data actually lives, its layout and git state. */
  async getWorkspace() {
    await this.ready;
    const shared = this.sharedWorkspace;
    const root = shared ? this.store.root : storageDir();
    if (shared) {
      const stats = await this.store.stats().catch(() => null);
      const directory = [];
      const probe = async (relPath, label, kind) => {
        const full = join(root, relPath);
        const info = await stat(full).catch(() => null);
        directory.push({
          path: relPath,
          label,
          kind,
          exists: Boolean(info),
          isDirectory: Boolean(info?.isDirectory?.()),
          bytes: info && info.isFile?.() ? info.size : undefined,
        });
      };
      await probe('state/app.sqlite', '订阅源与已读状态(Droplets 共享)', '内容');
      await probe('state/index.sqlite', '条目与全文索引(Droplets 共享)', '内容');
      await probe('vault', '知识库笔记(Droplets 共享)', '内容');
      await probe('inbox', '收件箱抓取的原件(Droplets 共享)', '内容');
      await probe('.droplets-dsh', '插件私有:设置/收藏/正文缓存', '派生');
      await probe('backups', '应用内备份归档', '派生');
      let git = null;
      try {
        const { execFile } = await import('node:child_process');
        const run = (args) => new Promise((resolveResult) => {
          execFile('git', args, { cwd: root, timeout: 3000 }, (error, stdout) => resolveResult(error ? '' : String(stdout).trim()));
        });
        const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
        if (branch) {
          const dirty = await run(['status', '--porcelain']);
          git = { branch, changed: dirty === '' ? 0 : dirty.split('\n').filter(Boolean).length };
        }
      } catch { /* git optional */ }
      return {
        shared: true,
        root,
        directory,
        storage: {
          documentBytes: stats?.appDbBytes ?? 0,
          entryBytes: stats?.indexDbBytes ?? 0,
          entryFiles: stats?.items ?? 0,
          subscriptionCount: stats?.feeds ?? 0,
        },
        git,
      };
    }
    const entryDir = entriesDir();
    const directory = [];
    const probe = async (relPath, label, kind) => {
      const full = join(root, relPath);
      const info = await stat(full).catch(() => null);
      directory.push({
        path: relPath,
        label,
        kind,
        exists: Boolean(info),
        isDirectory: Boolean(info?.isDirectory?.()),
        bytes: info && info.isFile?.() ? info.size : undefined,
      });
    };
    await probe('data.json', '订阅源与已读/收藏状态(元数据)', '内容');
    await probe('entries', '每个订阅源的条目(按源分文件)', '内容');
    await probe('bodies.json', '正文缓存', '内容');
    await probe('vault', '知识库笔记', '内容');
    await probe('inbox', '收件箱抓取的原件', '内容');
    await probe('backups', '应用内备份归档', '派生');
    await probe('.trash', '删除内容暂存', '派生');

    let documentBytes = 0;
    let entryBytes = 0;
    let entryFiles = 0;
    try {
      documentBytes = (await stat(this.store.path)).size;
    } catch { /* not written yet */ }
    try {
      for (const name of await readdir(entryDir)) {
        if (!name.endsWith('.json')) continue;
        entryFiles += 1;
        entryBytes += (await stat(join(entryDir, name))).size;
      }
    } catch { /* no entries yet */ }

    let git = null;
    try {
      const { execFile } = await import('node:child_process');
      const run = (args) => new Promise((resolve) => {
        execFile('git', args, { cwd: root, timeout: 3000 }, (error, stdout) => {
          resolve(error ? '' : String(stdout).trim());
        });
      });
      const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
      if (branch) {
        const dirty = await run(['status', '--porcelain']);
        git = {
          branch,
          changed: dirty === '' ? 0 : dirty.split('\n').filter(Boolean).length,
        };
      }
    } catch { /* git optional */ }

    return {
      root,
      directory,
      storage: { documentBytes, entryBytes, entryFiles, subscriptionCount: this.store.data.subscriptions.length },
      git,
    };
  }

  /** Reveal a path inside the storage root in the OS file manager. */
  async openPath(request) {
    await this.ready;
    const requested = String(request?.path ?? '');
    const root = storageDir();
    const target = requested === '' ? root : resolve(root, requested);
    // Never let the renderer ask the host to open an arbitrary path.
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error('droplets：只能打开数据目录内的位置');
    }
    const { execFile } = await import('node:child_process');
    await new Promise((resolve, reject) => {
      execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open',
        [target], (error) => (error ? reject(error) : resolve()));
    });
    return { opened: target };
  }

  async getStorageInfo() {
    await this.ready;
    const inboxItems = await this.inbox.items().catch(() => []);
    return {
      storageDir: this.sharedWorkspace ? this.store.root : storageDir(),
      sharedWorkspace: this.sharedWorkspace,
      vaultRoot: this.vaultRoot(),
      subscriptions: this.store.data.subscriptions.length,
      inbox: inboxItems.length,
      vaultFiles: this.vaultService().stats().files,
    };
  }

  async clearData() {
    await this.ready;
    // Never wipe a workspace another application owns.
    if (this.sharedWorkspace) throw new Error('droplets：正在与 Droplets 共用工作区，请勿在此清空数据');
    await this.store.destroy();
    await this.store.load();
    await this.ensureVault();
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Companion
  // ------------------------------------------------------------------

  async setReadingContext(request) {
    await this.ready;
    const sessionId = request?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length > 160 || sessionId === '') throw new Error('无效会话');
    const material = request?.material ?? {};
    const space = ['feed', 'inbox', 'vault', 'vault-search'].includes(material.space) ? material.space : 'vault';
    if (typeof material.title !== 'string' || material.title === '') throw new Error('材料缺少标题');
    for (const field of ['content', 'selection', 'excerpt']) {
      if (material[field] !== undefined && typeof material[field] !== 'string') throw new Error(`材料字段 ${field} 必须是字符串`);
    }
    if (typeof material.content === 'string' && material.content.length > 400_000) throw new Error('材料正文过长');
    const text = buildReadingContext({ ...material, space });
    storeContext(this.store.data.companionContexts ??= {}, sessionId, text);
    this.store.touch();
    return { ok: true };
  }

  /** Prompt used by client quick actions; returns the composed question. */
  async prepareChat(request) {
    await this.ready;
    const material = request?.material ?? {};
    return { prompt: buildAskPrompt(material, request?.question) };
  }
}

// Mark every public method above as Remote-exported.
{
  const names = [
    // feed
    'listChannels', 'listEntries', 'getEntry', 'searchEntries', 'setRead', 'setFavorite',
    'listFeeds', 'listItems', 'setItemState', 'markAllRead', 'setFeed', 'refreshStatus',
    'listSubscriptions', 'addSubscription', 'removeSubscription', 'updateSubscription',
    'opmlPreview', 'opmlImport', 'opmlExport', 'refresh',
    // inbox
    'inboxAddUrl', 'inboxList', 'inboxGet', 'inboxRead', 'inboxReadOriginal',
    'inboxUpdate', 'inboxRetry', 'inboxRetryAllFailed', 'inboxImportMarkdown',
    'inboxMoveToLibrary', 'inboxMoveToTrash', 'inboxMarkDone',
    // vault
    'vaultStatus', 'vaultReindex', 'vaultTree', 'vaultRead', 'vaultSearch', 'vaultGraph', 'vaultBacklinks', 'vaultWrite',
    'vaultList', 'vaultIndexFiles', 'vaultCreate', 'vaultCreateDir', 'vaultRename', 'vaultDuplicate', 'vaultDelete', 'vaultTags', 'vaultTrashList', 'vaultTrashRestore', 'vaultCopyTo', 'vaultCopyDirTo', 'vaultReveal', 'vaultCopyPath',
    // settings / companion
    'getSettings', 'saveSettings', 'getStorageInfo', 'getWorkspace', 'setWorkspace', 'openPath', 'clearData', 'setReadingContext', 'prepareChat',
  ];
  const prototype = DropletsService.prototype;
  for (const method of names) {
    Remote(method)(prototype[method], {
      name: method,
      private: false,
      static: false,
      addInitializer(fn) {
        fn.call(Object.create(prototype));
      },
    });
  }
}

export default DropletsService;
