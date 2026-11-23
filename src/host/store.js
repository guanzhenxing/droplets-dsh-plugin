/**
 * Durable plugin data: a metadata document (data.json) plus a lazily loaded
 * body file (bodies.json) under the harness home's storages directory, both
 * written atomically (tmp + rename) with a short debounce. Subscriptions,
 * read/favorite state, inbox metadata, the vault inverted index cache and
 * per-session companion contexts live in the metadata document; article and
 * inbox bodies live in bodies.json and are only read once opened.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

function defaults() {
  return {
    version: 1,
    settings: {
      showImages: true,
    },
    subscriptions: [],
    read: {},
    states: {},
    favorites: {},
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
      // migration: legacy read map -> 'seen' states (droplets three-state model)
      for (const [key, value] of Object.entries(this.data.read)) {
        if (this.data.states[key] === undefined) this.data.states[key] = 'seen';
        delete this.data.read[key];
      }
      if (!this.data.companionContexts || typeof this.data.companionContexts !== 'object') this.data.companionContexts = {};
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
    for (const key of ['states', 'favorites', 'read']) {
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
        // Keep the previous good copy for recovery before replacing.
        try {
          const previous = await readFile(this.path, 'utf8');
          if (previous.length > 2) await writeFile(this.path + '.bak', previous, 'utf8');
        } catch { /* first write */ }
        const temp = `${this.path}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.path);
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
