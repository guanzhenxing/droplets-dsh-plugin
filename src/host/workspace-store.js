/**
 * Share one storage with the Droplets desktop app.
 *
 * Droplets keeps its workspace on disk (default ~/WorkSpace/DropletsSpace):
 *   droplets.json            manifest
 *   state/app.sqlite         feeds + rss_item_state + plugin_state  (WAL)
 *   state/index.sqlite       rss_item + full-text index            (WAL)
 *   vault/                   0-Drafts … 4-Archives markdown
 *   inbox/<uuid>/            captured originals
 *
 * This store reads and writes exactly those tables, so both apps see the same
 * subscriptions, items and read states. Anything Droplets has no column for
 * (favorites, UI settings, companion contexts, cached bodies) lives in a small
 * sidecar directory .droplets-dsh/ inside the workspace.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BodyStore } from './body-store.js';
import { hashKey } from './feeds.js';

const SIDECAR = '.droplets-dsh';

function defaultsSidecar() {
  return {
    version: 1,
    settings: {
      showImages: true,
      refreshMinutes: 60,
      refreshOnStart: true,
      hoverPreview: false,
      cacheDays: 60,
      refreshWorkers: 3,
      fetchTimeoutSec: 20,
    },
    favorites: {},
    // RSS/News surface per feed id — SQLite has no column for it, so it
    // stays plugin-private like favorites and other sidecar fields.
    surfaces: {},
    inbox: [],
    vaultCache: null,
    companionContexts: {},
  };
}

async function loadSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  return DatabaseSync;
}

export function isDropletsWorkspace(root) {
  if (typeof root !== 'string' || root === '') return false;
  return true;
}

export class WorkspaceStore {
  #hashToFeedId = null; // lazy feed:<hash> -> native feed id map
  constructor(logger, root, maxBodies = 300) {
    this.logger = logger;
    this.root = root;
    this.dir = root;
    this.appDbPath = join(root, 'state', 'app.sqlite');
    this.indexDbPath = join(root, 'state', 'index.sqlite');
    this.sidecarDir = join(root, SIDECAR);
    this.path = join(this.sidecarDir, 'state.json');
    this.bodies = new BodyStore(join(this.sidecarDir, 'bodies.json'), maxBodies);
    this.data = { ...defaultsSidecar(), subscriptions: [], states: {}, read: {} };
    this.saveTimer = undefined;
    this.saving = Promise.resolve();
    this.lastKnownMtime = 0;
    this.appDb = null;
    this.indexDb = null;
    this.persistedFeed = new Map();   // feed id -> signature of item list
    this.persistedFeeds = new Map();  // feed id -> signature of feed columns
    this.persistedStates = new Map(); // item key -> state
  }

  setMaxBodies(maxBodies) {
    if (Number.isFinite(maxBodies) && maxBodies >= 10) this.bodies.maxBodies = Math.floor(maxBodies);
  }

  async cleanStaleTemps() {
    try {
      const { readdir } = await import('node:fs/promises');
      for (const name of await readdir(this.sidecarDir)) {
        if (!name.endsWith('.tmp')) continue;
        const full = join(this.sidecarDir, name);
        const info = await stat(full).catch(() => null);
        if (info && info.mtimeMs < Date.now() - 10 * 60 * 1000) await rm(full, { force: true });
      }
    } catch { /* first run */ }
  }

  async openDatabases() {
    const DatabaseSync = await loadSqlite();
    if (!this.appDb) {
      this.appDb = new DatabaseSync(this.appDbPath);
      this.appDb.exec('PRAGMA busy_timeout = 5000');
    }
    if (!this.indexDb) {
      this.indexDb = new DatabaseSync(this.indexDbPath);
      this.indexDb.exec('PRAGMA busy_timeout = 5000');
    }
  }

  closeDatabases() {
    try { this.appDb?.close(); } catch { /* already closed */ }
    try { this.indexDb?.close(); } catch { /* already closed */ }
    this.appDb = null;
    this.indexDb = null;
  }

  /** Feed row -> the subscription shape the rest of the plugin expects. */
  #toSubscription(row, entries) {
    return {
      id: row.id,
      url: row.url,
      name: row.title,
      group: row.group_name || undefined,
      enabled: row.enabled !== 0,
      siteUrl: row.site_url || undefined,
      refreshStrategy: row.refresh_strategy || 'follow',
      showUnreadBadge: row.show_unread_badge !== 0,
      includeInAll: row.include_in_all !== 0,
      note: row.note || undefined,
      createdAt: row.created_at ? Math.round(row.created_at * 1000) : undefined,
      lastFetchedAt: row.last_fetch_at ? Math.round(row.last_fetch_at * 1000) : undefined,
      lastError: row.last_error || undefined,
      entries,
    };
  }

  /** rss_item row -> the entry shape the reader/sorting code uses. */
  #toEntry(feedId, row) {
    const html = row.content_html || row.content || row.summary || '';
    return {
      key: feedId + '|' + row.item_key,
      guid: row.item_key,
      title: row.title,
      publishedAt: row.published_at || new Date((row.fetched_at ?? 0) * 1000).toISOString(),
      url: row.link || '',
      summary: row.summary || '',
      html,
      truncated: false,
    };
  }

  async load() {
    await this.openDatabases();
    await mkdir(this.sidecarDir, { recursive: true });

    const sidecar = await readFile(this.path, 'utf8')
      .then((raw) => JSON.parse(raw))
      .catch(() => null);
    const base = defaultsSidecar();
    this.data = {
      ...base,
      ...(sidecar ?? {}),
      settings: { ...base.settings, ...(sidecar?.settings ?? {}) },
      states: {},
      read: {},
    };
    if (!Array.isArray(this.data.inbox)) this.data.inbox = [];
    if (!this.data.favorites || typeof this.data.favorites !== 'object') this.data.favorites = {};
    if (!this.data.surfaces || typeof this.data.surfaces !== 'object') this.data.surfaces = {};
    if (!this.data.companionContexts || typeof this.data.companionContexts !== 'object') this.data.companionContexts = {};

    // Legacy pollution cleanup (bug class now fixed at the source): plugin
    // refreshes once merged feed:<hash>-keyed entries into native rows —
    // every refreshed article existed twice (one native URL-keyed row plus
    // one guid-keyed copy, all falsely unread) and read marks landed under
    // feed: source ids that never matched a live feed, silently reverting
    // read items on every reload. Idempotent; safe to run on every load.
    this.#dedupeLegacyItemRows();
    this.#migrateLegacyStateRows();

    const feedRows = this.appDb.prepare(
      'SELECT id, title, url, group_name, enabled, created_at, last_fetch_at, last_error, site_url, refresh_strategy, show_unread_badge, include_in_all, note, consecutive_failures, last_success_at FROM feeds ORDER BY created_at ASC',
    ).all();
    const itemsByFeed = new Map();
    const itemRows = this.indexDb.prepare(
      'SELECT source_id, item_key, title, link, summary, content, content_html, published_at, fetched_at FROM rss_item ORDER BY COALESCE(published_at, \'\') DESC, fetched_at DESC',
    ).all();
    for (const row of itemRows) {
      const list = itemsByFeed.get(row.source_id) ?? [];
      list.push(this.#toEntry(row.source_id, row));
      itemsByFeed.set(row.source_id, list);
    }

    this.data.subscriptions = feedRows.map((row) => this.#toSubscription(row, itemsByFeed.get(row.id) ?? []));
    for (const sub of this.data.subscriptions) {
      this.persistedFeed.set(sub.id, sub.entries.length);
      this.persistedFeeds.set(sub.id, this.#feedSignature(sub));
    }

    const stateRows = this.appDb.prepare('SELECT source_id, item_key, state FROM rss_item_state').all();
    for (const row of stateRows) {
      this.data.states[row.source_id + '|' + row.item_key] = row.state;
      this.persistedStates.set(row.source_id + '|' + row.item_key, row.state);
    }
    await this.cleanStaleTemps();
  }

  #feedSignature(sub) {
    return [sub.name, sub.url, sub.group ?? '', sub.enabled === false ? 0 : 1, sub.note ?? '', sub.siteUrl ?? '', sub.refreshStrategy ?? 'follow'].join('\u0000');
  }

  /**
   * Drop plugin-key-namespace rows leaked into rss_item: flush once wrote
   * item_key = entry.guid ?? entry.key, so guid-less feeds landed their
   * whole `feed:<32hex>|<hash>` plugin key as item_key — every refreshed
   * article existed twice (the native guid/URL-keyed row plus this copy,
   * all falsely unread). Deleted only when a same-feed same-title native
   * row exists; a lone plugin-keyed row is kept (it may be the only copy).
   */
  #dedupeLegacyItemRows() {
    try {
      const candidates = this.indexDb
        .prepare(`SELECT a.rowid AS rowid, a.item_key AS item_key FROM rss_item a
          WHERE a.item_key LIKE 'feed:%' AND EXISTS (
            SELECT 1 FROM rss_item b
            WHERE b.source_id = a.source_id AND b.title = a.title AND b.rowid != a.rowid
              AND b.item_key NOT LIKE 'feed:%'
          )`)
        .all()
        // Plugin keys are exactly feed:<32 lowercase hex>|<rest>; a real
        // feed guid could start with "feed:" but never this shape.
        .filter((row) => /^feed:[0-9a-f]{32}\|/.test(row.item_key));
      if (candidates.length === 0) return;
      const del = this.indexDb.prepare('DELETE FROM rss_item WHERE rowid = ?');
      this.indexDb.exec('BEGIN');
      try {
        for (const row of candidates) del.run(row.rowid);
      } finally {
        this.indexDb.exec('COMMIT');
      }
      this.logger?.info?.('droplets: removed %d plugin-keyed duplicate item rows', candidates.length);
    } catch (error) {
      this.logger?.warn?.('droplets: legacy item dedupe failed: %s', String(error));
    }
  }

  /**
   * Read marks written under feed:<hash> source ids never matched a live
   * feed (marks silently reverted on every reload). Best-effort migration
   * onto the native keying — the plugin wrote item_key = entry.guid, and
   * native rows key by URL, so marks whose guid was a URL migrate cleanly;
   * the rest are unmatchable and deleted (they were functionally dead
   * anyway). Runs BEFORE the state SELECT so the loaded view is clean.
   */
  #migrateLegacyStateRows() {
    try {
      const orphans = this.appDb
        .prepare("SELECT source_id, item_key, state FROM rss_item_state WHERE source_id LIKE 'feed:%'")
        .all();
      if (orphans.length === 0) return;
      const migrate = this.appDb.prepare(
        `INSERT INTO rss_item_state (source_id, item_key, state, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_id, item_key) DO NOTHING`,
      );
      this.appDb.exec('BEGIN');
      try {
        let migrated = 0;
        for (const row of orphans) {
          // Native rows key items by URL; only guid-is-URL marks can migrate.
          if (!/^(https?:\/\/|www\.)/i.test(row.item_key)) continue;
          const nativeId = this.#nativeSourceOfFeedHash(row.source_id);
          if (!nativeId) continue;
          migrate.run(nativeId, row.item_key, row.state, Date.now() / 1000);
          migrated += 1;
        }
        this.appDb.prepare("DELETE FROM rss_item_state WHERE source_id LIKE 'feed:%'").run();
        if (orphans.length > 0) {
          this.logger?.info?.('droplets: migrated %d/%d legacy read marks onto native ids', migrated, orphans.length);
        }
      } finally {
        this.appDb.exec('COMMIT');
      }
    } catch (error) {
      this.logger?.warn?.('droplets: legacy state migration failed: %s', String(error));
    }
  }

  /** Reverse-lookup: which live feed id does a feed:<hash> id stand for? */
  #nativeSourceOfFeedHash(feedHashId) {
    if (this.#hashToFeedId === null) {
      this.#hashToFeedId = new Map();
      const rows = this.appDb.prepare('SELECT id, url FROM feeds').all();
      for (const row of rows) this.#hashToFeedId.set(`feed:${hashKey(row.url)}`, row.id);
    }
    return this.#hashToFeedId.get(feedHashId);
  }

  touch() {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush().catch(() => {});
    }, 500);
  }

  async loadEntries(feedId) {
    return this.data.subscriptions.find((sub) => sub.id === feedId)?.entries;
  }

  async saveEntries(feedId, entries) {
    const sub = this.data.subscriptions.find((item) => item.id === feedId);
    if (sub) sub.entries = entries;
  }

  /** Persist the in-memory view back into the Droplets tables (transactional). */
  async flush() {
    this.saving = this.saving.catch(() => {}).then(async () => {
      try {
        await this.openDatabases();
        await mkdir(this.sidecarDir, { recursive: true });

        const liveIds = new Set(this.data.subscriptions.map((sub) => sub.id));
        const upsertFeed = this.appDb.prepare(
          `INSERT INTO feeds (id, title, url, group_name, enabled, created_at, last_fetch_at, last_error, site_url, refresh_strategy, show_unread_badge, include_in_all, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, url=excluded.url, group_name=excluded.group_name,
             enabled=excluded.enabled, last_fetch_at=excluded.last_fetch_at, last_error=excluded.last_error,
             site_url=excluded.site_url, refresh_strategy=excluded.refresh_strategy,
             show_unread_badge=excluded.show_unread_badge, include_in_all=excluded.include_in_all, note=excluded.note`,
        );
        const upsertItem = this.indexDb.prepare(
          `INSERT INTO rss_item (source_id, item_key, title, link, summary, content, content_html, published_at, source_title, fetched_at, item_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_id, item_key) DO UPDATE SET title=excluded.title, link=excluded.link,
             summary=excluded.summary, content=excluded.content, content_html=excluded.content_html,
             published_at=excluded.published_at, source_title=excluded.source_title`,
        );
        const upsertState = this.appDb.prepare(
          'INSERT INTO rss_item_state (source_id, item_key, state, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(source_id, item_key) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at',
        );
        const deleteState = this.appDb.prepare('DELETE FROM rss_item_state WHERE source_id = ? AND item_key = ?');

        this.appDb.exec('BEGIN');
        try {
          for (const sub of this.data.subscriptions) {
            const signature = this.#feedSignature(sub);
            if (this.persistedFeeds.get(sub.id) !== signature) {
              upsertFeed.run(
                sub.id, sub.name ?? '', sub.url ?? '', sub.group ?? '',
                sub.enabled === false ? 0 : 1, (sub.createdAt ?? Date.now()) / 1000,
                sub.lastFetchedAt ? sub.lastFetchedAt / 1000 : null,
                sub.lastError ?? null, sub.siteUrl ?? '', sub.refreshStrategy ?? 'follow',
                sub.showUnreadBadge === false ? 0 : 1, sub.includeInAll === false ? 0 : 1, sub.note ?? '',
              );
              this.persistedFeeds.set(sub.id, signature);
            }
          }
          for (const [key, state] of Object.entries(this.data.states)) {
            if (this.persistedStates.get(key) === state) continue;
            const split = key.indexOf('|');
            if (split === -1) continue;
            upsertState.run(key.slice(0, split), key.slice(split + 1), state, Date.now() / 1000);
            this.persistedStates.set(key, state);
          }
        } finally {
          this.appDb.exec('COMMIT');
        }

        const seenStates = new Set(Object.keys(this.data.states));
        this.appDb.exec('BEGIN');
        try {
          for (const key of [...this.persistedStates.keys()]) {
            if (seenStates.has(key)) continue;
            const split = key.indexOf('|');
            if (split === -1) continue;
            deleteState.run(key.slice(0, split), key.slice(split + 1));
            this.persistedStates.delete(key);
          }
        } finally {
          this.appDb.exec('COMMIT');
        }

        // Items: only feeds whose entry count changed get rewritten.
        this.indexDb.exec('BEGIN');
        try {
          for (const sub of this.data.subscriptions) {
            const entries = sub.entries ?? [];
            if (this.persistedFeed.get(sub.id) === entries.length) continue;
            const now = Date.now() / 1000;
            for (const entry of entries) {
              upsertItem.run(
                sub.id, entry.guid ?? entry.key, entry.title ?? '', entry.url ?? '',
                entry.summary ?? '', '', entry.html ?? '', entry.publishedAt ?? null,
                sub.name ?? '', now, null,
              );
            }
            this.persistedFeed.set(sub.id, entries.length);
          }
        } finally {
          this.indexDb.exec('COMMIT');
        }

        // Removed feeds: drop their rows so Droplets stops showing them too.
        const removed = [...this.persistedFeeds.keys()].filter((id) => !liveIds.has(id));
        if (removed.length > 0) {
          const deleteFeed = this.appDb.prepare('DELETE FROM feeds WHERE id = ?');
          const deleteItems = this.indexDb.prepare('DELETE FROM rss_item WHERE source_id = ?');
          const deleteFeedStates = this.appDb.prepare('DELETE FROM rss_item_state WHERE source_id = ?');
          this.appDb.exec('BEGIN');
          try {
            for (const id of removed) { deleteFeedStates.run(id); deleteFeed.run(id); this.persistedFeeds.delete(id); }
          } finally { this.appDb.exec('COMMIT'); }
          this.indexDb.exec('BEGIN');
          try { for (const id of removed) deleteItems.run(id); } finally { this.indexDb.exec('COMMIT'); }
        }

        // Sidecar: everything Droplets has no column for.
        const sidecar = {
          version: 1,
          settings: this.data.settings,
          favorites: this.data.favorites,
          surfaces: this.data.surfaces,
          inbox: this.data.inbox,
          vaultCache: this.data.vaultCache ?? null,
          companionContexts: this.data.companionContexts,
        };
        const temp = `${this.path}.${process.pid}.tmp`;
        try {
          await writeFile(temp, JSON.stringify(sidecar), { encoding: 'utf8', mode: 0o600 });
          await rename(temp, this.path);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => {});
          throw error;
        }
        this.lastKnownMtime = (await stat(this.path)).mtimeMs;
      } catch (error) {
        this.logger?.warn?.('droplets: failed to save workspace data: %s', String(error));
        throw error;
      }
    });
    return this.saving;
  }

  /** Release the SQLite handles (the service calls this on shutdown). */
  async dispose() {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.saving.catch(() => {});
    this.closeDatabases();
  }

  async stats() {
    const feeds = this.data.subscriptions.length;
    const items = this.data.subscriptions.reduce((sum, sub) => sum + (sub.entries?.length ?? 0), 0);
    const appInfo = await stat(this.appDbPath).catch(() => null);
    const indexInfo = await stat(this.indexDbPath).catch(() => null);
    return {
      feeds,
      items,
      appDbBytes: appInfo?.size ?? 0,
      indexDbBytes: indexInfo?.size ?? 0,
    };
  }
}
