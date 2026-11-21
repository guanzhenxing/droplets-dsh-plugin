/**
 * Durable plugin data: a metadata document (data.json) plus a lazily loaded
 * body file (bodies.json) under the harness home's storages directory, both
 * written atomically (tmp + rename) with a short debounce. Subscriptions,
 * read/favorite state, inbox metadata, the vault inverted index cache and
 * per-session companion contexts live in the metadata document; article and
 * inbox bodies live in bodies.json and are only read once opened.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
    favorites: {},
    inbox: [],
    // { path, builtAt, files: { [relPath]: { mtimeMs, size, title, tags, links } } }
    vaultCache: null,
    companionContexts: {},
  };
}

export class DropletsStore {
  constructor(logger, maxBodies = 300) {
    this.logger = logger;
    this.dir = storageDir();
    this.path = join(this.dir, 'data.json');
    this.bodies = new BodyStore(join(this.dir, 'bodies.json'), maxBodies);
    this.data = defaults();
    this.saveTimer = undefined;
    this.saving = Promise.resolve();
  }

  setMaxBodies(maxBodies) {
    if (Number.isFinite(maxBodies) && maxBodies >= 10) this.bodies.maxBodies = Math.floor(maxBodies);
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...defaults(), ...parsed };
      this.data.settings = { ...defaults().settings, ...(parsed.settings ?? {}) };
      if (!Array.isArray(this.data.subscriptions)) this.data.subscriptions = [];
      if (!Array.isArray(this.data.inbox)) this.data.inbox = [];
      if (!this.data.read || typeof this.data.read !== 'object') this.data.read = {};
      if (!this.data.favorites || typeof this.data.favorites !== 'object') this.data.favorites = {};
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

  /** Write the document through a temp file + rename, serialized. */
  async flush() {
    this.saving = this.saving.catch(() => {}).then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true });
        const temp = `${this.path}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.path);
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
