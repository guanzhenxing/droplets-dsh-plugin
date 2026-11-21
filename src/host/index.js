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
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DropletsStore, defaultVaultPath, storageDir } from './store.js';
import { Inbox } from './inbox.js';
import { Vault, ensureDefaultVault } from './vault.js';
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
const CONFIG_KEYS = new Set(['vaultPath', 'refreshInterval', 'maxBodies', 'enableTranslation']);

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
    this.store = new DropletsStore(ctx.logger, config.maxBodies ?? 300);
    // The strict shared instance by default; tests (and only tests) may swap
    // this for a permissive factory to exercise the full flow on loopback.
    this.fetcher = guardedFetch;
    this.inbox = new Inbox(this.store, ctx.logger, () => this.fetcher);
    this.refreshing = false;
    this.tickTimer = undefined;
    this.stopped = false;
    this.ready = this.store.load().then(async () => {
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
    return typeof configured === 'string' && configured.trim() !== '' ? configured : defaultVaultPath();
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
    }
    return this.vaultInstance;
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
    const countUnread = (entries) => entries.reduce((sum, entry) => (data.read[entry.key] ? sum : sum + 1), 0);
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
      read: data.read[entry.key] !== undefined,
      favorite: data.favorites[entry.key] !== undefined,
      hasBody: typeof entry.html === 'string' && entry.html !== '',
    };
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
    if (filter === 'unread') entries = entries.filter((entry) => this.store.data.read[entry.key] === undefined);
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

  async setRead(request) {
    const { keys, read } = request ?? {};
    await this.ready;
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      if (typeof key !== 'string') continue;
      if (read === false) delete this.store.data.read[key];
      else this.store.data.read[key] = Date.now();
    }
    this.pruneReadIds();
    this.store.touch();
    return { ok: true };
  }

  /** Keep the read map bounded: favorites and the newest N survive. */
  pruneReadIds() {
    const data = this.store.data;
    const keys = Object.keys(data.read);
    if (keys.length <= 5000) return;
    const ranked = keys.sort((a, b) => data.read[b] - data.read[a]);
    for (const key of ranked.slice(5000)) {
      if (!data.favorites[key]) delete data.read[key];
    }
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

  async fetchFeedText(url) {
    const response = await this.fetcher.fetch(url, {
      connectTimeoutMs: FEED_TIMEOUT_MS,
      totalTimeoutMs: FEED_TIMEOUT_MS,
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

  async refresh(request) {
    const { channel } = request ?? {};
    await this.ready;
    const outcome = { feeds: 0, entries: 0, errors: 0 };
    const subs = this.selectSubscriptions(channel);
    await this.forEachWithPool(subs, REFRESH_WORKERS, async (sub) => {
      const count = await this.refreshSubscription(sub);
      outcome.feeds += 1;
      outcome.entries += count;
      if (sub.lastError) outcome.errors += 1;
    });
    this.store.touch();
    this.pruneBodies();
    return outcome;
  }

  selectSubscriptions(channel) {
    const subs = this.store.data.subscriptions;
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
      sub.lastFetchedAt = Date.now();
      sub.lastError = undefined;
      sub.status = 'ok';
      sub.entries = mergeEntries(sub.entries ?? [], parsed.entries);
      this.store.touch();
      return parsed.entries.length;
    } catch (error) {
      sub.lastError = error instanceof Error ? error.message : String(error);
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
    for (const item of this.store.data.inbox) {
      if (item.key) metadata.add(item.key);
    }
    this.store.bodies.prune(metadata, pinned);
    this.store.bodies.touch();
  }

  // ------------------------------------------------------------------
  // Inbox space (thin Remote forwarding with request validation)
  // ------------------------------------------------------------------

  async inboxAddUrl(request) {
    await this.ready;
    const url = typeof request === 'string' ? request : request?.url;
    const { item, duplicate } = await this.inbox.addUrl(url);
    return { item, duplicate };
  }

  async inboxList(request) {
    await this.ready;
    return { items: this.inbox.list({ filter: request?.filter }) };
  }

  async inboxRead(request) {
    await this.ready;
    const key = typeof request === 'string' ? request : request?.key;
    if (typeof key !== 'string' || key === '') throw new Error('无效条目');
    return this.inbox.read(key);
  }

  async inboxMarkDone(request) {
    await this.ready;
    const key = typeof request === 'string' ? request : request?.key;
    if (typeof key !== 'string' || key === '') throw new Error('无效条目');
    const removed = await this.inbox.markDone(key);
    return { removed };
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

  async vaultSearch(request) {
    await this.ready;
    const vault = this.vaultService();
    if (!vault.cache() || vault.cache().path !== vault.root) await vault.reindex();
    return { results: await vault.search(request?.query, Math.min(Math.max(request?.limit ?? 30, 1), 100)) };
  }

  async vaultGraph() {
    await this.ready;
    const vault = this.vaultService();
    if (!vault.cache() || vault.cache().path !== vault.root) await vault.reindex();
    return vault.graph();
  }

  async vaultBacklinks(request) {
    await this.ready;
    const p = typeof request === 'string' ? request : request?.path;
    const vault = this.vaultService();
    return { backlinks: vault.backlinks(p) };
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
    const patch = request?.patch ?? {};
    if (patch.showImages !== undefined) this.store.data.settings.showImages = patch.showImages !== false;
    this.store.touch();
    await this.store.flush();
    return this.getSettings();
  }

  async getStorageInfo() {
    await this.ready;
    return {
      storageDir: storageDir(),
      vaultRoot: this.vaultRoot(),
      subscriptions: this.store.data.subscriptions.length,
      inbox: this.inbox.items().filter((item) => item.doneAt === undefined).length,
      vaultFiles: this.vaultService().stats().files,
    };
  }

  async clearData() {
    await this.ready;
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
    'listSubscriptions', 'addSubscription', 'removeSubscription', 'updateSubscription',
    'opmlPreview', 'opmlImport', 'opmlExport', 'refresh',
    // inbox
    'inboxAddUrl', 'inboxList', 'inboxRead', 'inboxMarkDone',
    // vault
    'vaultStatus', 'vaultReindex', 'vaultTree', 'vaultRead', 'vaultSearch', 'vaultGraph', 'vaultBacklinks', 'vaultWrite',
    // settings / companion
    'getSettings', 'saveSettings', 'getStorageInfo', 'clearData', 'setReadingContext', 'prepareChat',
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
