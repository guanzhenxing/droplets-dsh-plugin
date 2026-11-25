/**
 * Durable plugin data: a metadata document (data.json) plus a lazily loaded
 * body file (bodies.json) under the harness home's storages directory, both
 * written atomically (tmp + rename) with a short debounce. Subscriptions,
 * read/favorite state, inbox metadata, the vault inverted index cache and
 * per-session companion contexts live in the metadata document; article and
 * inbox bodies live in bodies.json and are only read once opened.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { BodyStore } from './body-store.js';

export const STORAGE_FOLDER = 'droplets-dsh';

export function storageDir() {
  return join(resolveDshHome(), 'storages', STORAGE_FOLDER);
}

export function defaultVaultPath() {
  return join(storageDir(), 'vault');
}

/** Per-feed entry files live here so data.json stays small. */
export function entriesDir() {
  return join(storageDir(), 'entries');
}

function entryFileName(feedId) {
  // Feed ids are opaque and may contain ':' or '/'; encodeURIComponent keeps
  // the mapping reversible and filename-safe on every platform.
  return encodeURIComponent(feedId) + '.json';
}

/** Cheap change detector for an entry list: refresh only ever appends or
 * replaces the head of the list, so length + boundary keys are sufficient. */
function entrySignature(entries) {
  if (!entries || entries.length === 0) return '0';
  return entries.length + '|' + (entries[entries.length - 1]?.key ?? '') + '|' + (entries[0]?.key ?? '');
}

function defaults() {
  return {
    version: 1,
    settings: {
      showImages: true,
      // Feed preferences mirrored from the droplets settings screen.
      refreshMinutes: 60,
      refreshOnStart: true,
      hoverPreview: false,
      cacheDays: 60,
      refreshWorkers: 3,
      fetchTimeoutSec: 20,
    },
    subscriptions: [],
    read: {},
    states: {},
    favorites: {},
    // RSS/News surface per subscription id ('rss' | 'news'; absent = 'rss').
    surfaces: {},
    inbox: [],
    // { path, builtAt, files: { [relPath]: { mtimeMs, size, title, tags, links } } }
    vaultCache: null,
    companionContexts: {},
  };
}

export class DropletsStore {
  

  setMaxBodies(maxBodies) {
    if (Number.isFinite(maxBodies) && maxBodies >= 10) this.bodies.maxBodies = Math.floor(maxBodies);
  }

  /** File stamp of the last load/flush — detects foreign writers (every DSH
   * session process instantiates this service against the same data.json;
   * without merging, an idle instance's periodic flush wipes concurrent
   * imports). */
  constructor(logger, maxBodies = 300) {
    this.logger = logger;
    this.dir = storageDir();
    this.path = join(this.dir, 'data.json');
    this.bodies = new BodyStore(join(this.dir, 'bodies.json'), maxBodies);
    this.data = defaults();
    this.saveTimer = undefined;
    this.saving = Promise.resolve();
    this.lastKnownMtime = 0;
    // Signature of what is already persisted per feed, so a flush only rewrites
    // the feeds whose entries actually changed.
    this.persistedSignatures = new Map();
    this.tempSeq = 0;
  }

  /** Remove temp files a killed process left behind (atomic writes are
   * tmp+rename; a SIGKILL between them strands the whole document). */
  async cleanStaleTemps() {
    try {
      const names = await readdir(this.dir);
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const name of names) {
        if (!/\.tmp$/.test(name) && !/\.json\.\d+\.tmp$/.test(name)) continue;
        const full = join(this.dir, name);
        try {
          const info = await stat(full);
          if (info.mtimeMs < cutoff) await rm(full, { force: true });
        } catch { /* raced with another instance */ }
      }
    } catch { /* first run: no directory yet */ }
  }

  /** Load one feed's entries from its own file. */
  async loadEntries(feedId) {
    try {
      const raw = await readFile(join(entriesDir(), entryFileName(feedId)), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return undefined;
    }
  }

  /** Write one feed's entries; no-op when the signature is unchanged. */
  async saveEntries(feedId, entries) {
    const signature = entrySignature(entries);
    if (this.persistedSignatures.get(feedId) === signature) return;
    // An empty feed with no file yet needs none; record that so we do not
    // recreate hundreds of empty files on every flush.
    if (signature === '0') {
      const existing = await stat(join(entriesDir(), entryFileName(feedId))).catch(() => null);
      if (!existing) {
        this.persistedSignatures.set(feedId, signature);
        return;
      }
    }
    await mkdir(entriesDir(), { recursive: true });
    const target = join(entriesDir(), entryFileName(feedId));
    // Unique per call: two overlapping flushes for the same feed must not
    // share a temp path, or the first rename steals the second's file (ENOENT).
    const temp = `${target}.${process.pid}.${++this.tempSeq}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 });
      await rename(temp, target);
      this.persistedSignatures.set(feedId, signature);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      this.lastKnownMtime = (await stat(this.path)).mtimeMs;
      this.data = { ...defaults(), ...parsed };
      this.data.settings = { ...defaults().settings, ...(parsed.settings ?? {}) };
      if (!Array.isArray(this.data.subscriptions)) this.data.subscriptions = [];
      if (!Array.isArray(this.data.inbox)) this.data.inbox = [];
      if (!this.data.read || typeof this.data.read !== 'object') this.data.read = {};
      if (!this.data.states || typeof this.data.states !== 'object') this.data.states = {};
      if (!this.data.favorites || typeof this.data.favorites !== 'object') this.data.favorites = {};
      if (!this.data.surfaces || typeof this.data.surfaces !== 'object') this.data.surfaces = {};
      // migration: legacy read map -> 'seen' states (droplets three-state model)
      for (const [key, value] of Object.entries(this.data.read)) {
        if (this.data.states[key] === undefined) this.data.states[key] = 'seen';
        delete this.data.read[key];
      }
      if (!this.data.companionContexts || typeof this.data.companionContexts !== 'object') this.data.companionContexts = {};
      // Hydrate entries from their own files. Legacy documents carried entries
      // inline; those stay in memory and get split out on the next flush.
      await mkdir(entriesDir(), { recursive: true });
      for (const sub of this.data.subscriptions) {
        const inline = Array.isArray(sub.entries) ? sub.entries : [];
        const stored = await this.loadEntries(sub.id);
        if (stored !== undefined) {
          sub.entries = stored;
          this.persistedSignatures.set(sub.id, entrySignature(stored));
        } else {
          // Legacy document: entries exist only inline. Keep them in memory and
          // leave the signature UNSET so the next flush writes the per-feed
          // file — data.json is written without them from now on.
          sub.entries = inline;
        }
      }
      await this.cleanStaleTemps();
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error('droplets: cannot read saved data; refusing to overwrite it', { cause: error });
      }
      this.data = defaults();
    }
  }

  /** Schedule a debounced atomic save (500 ms). */
  touch() {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush().catch(() => {});
    }, 500);
  }

  /**
   * Union-merge collections a foreign writer may have advanced: subscriptions
   * by id (ours win on conflict, theirs added), state maps by key. Prevents
   * an instance with stale memory from erasing a concurrent import.
   */
  mergeForeign(foreign) {
    if (!foreign || typeof foreign !== 'object') return;
    const mine = this.data;
    if (Array.isArray(foreign.subscriptions)) {
      const byId = new Map(mine.subscriptions.map((sub) => [sub.id, sub]));
      for (const sub of foreign.subscriptions) {
        if (sub && typeof sub.id === 'string' && !byId.has(sub.id)) mine.subscriptions.push(sub);
      }
    }
    for (const key of ['states', 'favorites', 'read', 'surfaces']) {
      const theirs = foreign[key];
      if (theirs && typeof theirs === 'object') {
        mine[key] ??= {};
        for (const [k, v] of Object.entries(theirs)) {
          if (mine[key][k] === undefined) mine[key][k] = v;
        }
      }
    }
    if (Array.isArray(foreign.inbox)) {
      const keys = new Set(mine.inbox.map((item) => item.key));
      for (const item of foreign.inbox) {
        if (item && typeof item.key === 'string' && !keys.has(item.key)) mine.inbox.push(item);
      }
    }
  }

  /** Write the document through a temp file + rename, serialized. */
  async flush() {
    this.saving = this.saving.catch(() => {}).then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true });
        // Foreign writer? (session processes share this file) — merge first.
        try {
          const info = await stat(this.path);
          if (info.mtimeMs > this.lastKnownMtime) {
            try {
              this.mergeForeign(JSON.parse(await readFile(this.path, 'utf8')));
            } catch { /* unreadable foreign file: proceed with ours */ }
          }
        } catch { /* no file yet */ }
        // Hydrate entries for subscriptions a foreign writer added (their own
        // documents never carry entries).
        for (const sub of this.data.subscriptions) {
          if (!Array.isArray(sub.entries)) sub.entries = (await this.loadEntries(sub.id)) ?? [];
        }
        // Entries go to per-feed files; only changed feeds are rewritten.
        for (const sub of this.data.subscriptions) {
          await this.saveEntries(sub.id, sub.entries ?? []);
        }
        // data.json now holds metadata only — small enough that a rewrite is
        // cheap and a crash can never strand a 40 MB document.
        const document = {
          ...this.data,
          subscriptions: this.data.subscriptions.map(({ entries, ...rest }) => rest),
        };
        // Keep the previous good copy for recovery before replacing.
        try {
          const previous = await readFile(this.path, 'utf8');
          if (previous.length > 2) await writeFile(this.path + '.bak', previous, 'utf8');
        } catch { /* first write */ }
        const temp = `${this.path}.${process.pid}.tmp`;
        try {
          await writeFile(temp, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 });
          await rename(temp, this.path);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => {});
          throw error;
        }
        this.lastKnownMtime = (await stat(this.path)).mtimeMs;
      } catch (error) {
        this.logger?.warn?.('droplets: failed to save data: %s', String(error));
        throw error;
      }
    });
    return this.saving;
  }

  async dispose() {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.flush();
    await this.bodies.dispose();
  }

  /** Remove every stored file (settings "clear plugin data" path). */
  async destroy() {
    this.data = defaults();
    await this.bodies.destroy();
    await rm(this.path, { force: true });
  }
}
