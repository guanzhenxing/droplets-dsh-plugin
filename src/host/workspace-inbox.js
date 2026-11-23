/**
 * The inbox space on the Droplets workspace itself (data sharing, 1:1).
 *
 * Droplets persists every inbox object as plain files:
 *   inbox/<uuid>/meta.json       InboxMeta (2-space JSON)
 *   inbox/<uuid>/content.md      markdown body / document text layer
 *   inbox/<uuid>/source/original.{pdf,epub}
 *   state/inbox-originals/<id>.bin   staged raw HTML (for library 原件保留)
 *   library/<uuid>/…             after 保留到资料库 (space flipped)
 *   .trash/<id>/{trash-meta.json,payload/}   after 移入回收站
 *
 * This module reads and writes exactly those structures, so the plugin and
 * the Droplets desktop app see (and mutate) the same inbox. On-disk formats,
 * status machine (unread / finished / fetch_failed), fetch-outcome writes and
 * the library/trash transactions mirror the native implementation
 * (main/inbox/store.ts, main/inbox/service.ts, main/library/move.ts,
 * main/trash/service.ts) — including the inbox-to-library migration marker,
 * which lets the native app's reconcilePendingMoves finish a move this
 * plugin crashed midway through.
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { extractArticle } from './extract.js';
import { htmlToMarkdown } from './html-to-md.js';
import { htmlToText } from './sanitize.js';
import { epubPlainText } from './inbox.js';

export const WORKSPACE_INBOX_LIMITS = {
  maxBodyBytes: 50 * 1024 * 1024,
  maxDocumentBytes: 256 * 1024 * 1024,
  connectTimeoutMs: 20_000,
  totalTimeoutMs: 60_000,
  maxRedirects: 6,
};

/** Same id rules as the native PathGuard-backed store: one safe segment. */
const ID_PATTERN = /^[^/.][^/]*$/;

function invalidId(id) {
  return new Error(`非法对象 id：${id}`);
}

/** UUIDv7 (time-ordered, native inbox ids are v7). */
export function uuidv7() {
  const timestamp = Date.now();
  const bytes = new Uint8Array(16);
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  const random = randomUUID().replaceAll('-', '');
  for (let index = 6; index < 16; index += 1) {
    bytes[index] = parseInt(random.slice((index - 6) * 2, (index - 6) * 2 + 2), 16);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Parse meta.json with the native compat rule (reading → unread). */
export function parseInboxMetaCompat(raw) {
  const data = JSON.parse(raw);
  if (data?.status === 'reading') data.status = 'unread';
  if (typeof data !== 'object' || data === null) throw new Error('meta.json 不是对象');
  return {
    id: String(data.id ?? ''),
    objectType: data.objectType ?? 'article',
    space: data.space ?? 'inbox',
    status: data.status ?? 'unread',
    migration: data.migration,
    title: String(data.title ?? ''),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    source: data.source ?? { kind: 'markdown-import', addedAt: new Date().toISOString() },
    createdAt: data.createdAt ?? new Date().toISOString(),
    updatedAt: data.updatedAt ?? data.createdAt ?? new Date().toISOString(),
  };
}

async function atomicWriteFile(absolute, data) {
  const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, absolute);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function sha256File(absolute) {
  return createHash('sha256').update(await readFile(absolute)).digest('hex');
}

async function walkFiles(absolute, rel = '') {
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...await walkFiles(join(absolute, entry.name), rel ? `${rel}/${entry.name}` : entry.name));
    } else if (entry.isFile()) {
      files.push(rel ? `${rel}/${entry.name}` : entry.name);
    }
  }
  return files;
}

function guessTitleFrom(url, headers = {}) {
  const disposition = String(headers['content-disposition'] ?? '');
  const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(disposition)?.[1];
  if (filename) return decodeURIComponent(filename.trim());
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch { /* keep url */ }
  return url;
}

function contentTypeOf(headers, url) {
  const raw = String(headers['content-type'] ?? '').toLowerCase();
  if (raw.includes('application/pdf') || /\.pdf(\?|$)/i.test(url)) return 'pdf';
  if (raw.includes('epub') || /\.epub(\?|$)/i.test(url)) return 'epub';
  if (raw.includes('html') || raw.includes('xml')) return 'web';
  if (raw.includes('json')) return 'json';
  if (raw.startsWith('text/')) return 'text';
  return 'other';
}

/** User-mutable meta equality (same exclusions as the native move.ts). */
function metaUserFieldsEqual(a, b) {
  return a.title === b.title
    && JSON.stringify(a.tags) === JSON.stringify(b.tags)
    && a.status === b.status
    && JSON.stringify(a.source) === JSON.stringify(b.source);
}

/**
 * Workspace-backed inbox. `root` is the Droplets workspace root (shared
 * mode) or the plugin's private storage dir (private mode); objects live
 * under `<root>/inbox/` either way, in the native on-disk format.
 */
export class WorkspaceInbox {
  constructor(root, logger, fetcherProvider) {
    this.root = root;
    this.logger = logger;
    this.fetcherProvider = typeof fetcherProvider === 'function' ? fetcherProvider : () => fetcherProvider;
    /** In-flight background fetch ids (list() reports them as pendingIds). */
    this.pending = new Set();
    /** Per-object serialized chains (native R10: fetch/retry/move mutex). */
    this.chains = new Map();
  }

  get fetcher() { return this.fetcherProvider(); }

  dirOf(id, space = 'inbox') {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw invalidId(id);
    return join(this.root, space, id);
  }

  runExclusive(id, fn) {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.chains.set(id, next);
    // The cleanup promise is derived from `next`; give it its own catch so a
    // rejection passing through finally never becomes an unhandled rejection.
    next.finally(() => {
      if (this.chains.get(id) === next) this.chains.delete(id);
    }).catch(() => {});
    return next;
  }

  // ------------------------------------------------------------------
  // Store-level operations (native InboxStore semantics)
  // ------------------------------------------------------------------

  async get(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw invalidId(id);
    try {
      const meta = parseInboxMetaCompat(await readFile(join(this.root, 'inbox', id, 'meta.json'), 'utf8'));
      const content = await readFile(join(this.root, 'inbox', id, 'content.md'), 'utf8');
      return { meta, content };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async create({ title, content, tags, source, status = 'unread' }) {
    const id = uuidv7();
    const dir = this.dirOf(id);
    await mkdir(dir, { recursive: true }).catch(async (error) => {
      if (error?.code !== 'EEXIST') throw error;
      throw new Error(`对象已存在：inbox/${id}`);
    });
    const now = new Date().toISOString();
    const meta = {
      id,
      objectType: 'article',
      space: 'inbox',
      status,
      title,
      tags: tags ?? [],
      source,
      createdAt: now,
      updatedAt: now,
    };
    await atomicWriteFile(join(dir, 'content.md'), content ?? '');
    await atomicWriteFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  async updateMeta(id, patch) {
    const existing = await this.get(id);
    if (!existing) throw new Error(`对象不存在：inbox/${id}`);
    const clean = Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined));
    const next = {
      ...existing.meta,
      ...clean,
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteFile(join(this.root, 'inbox', id, 'meta.json'), JSON.stringify(next, null, 2));
    return next;
  }

  /**
   * One-shot fetch outcome write (native T22): success content/document or
   * a fetch_failed placeholder, meta + content each written atomically.
   */
  async setFetchOutcome(id, outcome) {
    const existing = await this.get(id);
    if (!existing) throw new Error(`对象不存在：inbox/${id}`);
    if (existing.meta.source.kind !== 'url') throw new Error('非 URL 来源对象');
    const dir = join(this.root, 'inbox', id);
    let next;
    if (outcome.ok) {
      const { fetchError, ...source } = existing.meta.source;
      const isDoc = 'document' in outcome;
      next = {
        ...existing.meta,
        objectType: isDoc ? outcome.document.ext : existing.meta.objectType,
        status: 'unread',
        title: (isDoc ? outcome.document.title : outcome.title) ?? existing.meta.title,
        source,
        updatedAt: new Date().toISOString(),
      };
      if (isDoc) {
        await mkdir(join(dir, 'source'), { recursive: true });
        await writeFile(join(dir, 'source', `original.${outcome.document.ext}`), outcome.document.original);
        await atomicWriteFile(join(dir, 'content.md'), outcome.document.text);
      } else {
        await atomicWriteFile(join(dir, 'content.md'), outcome.content);
        if (outcome.originalHtml !== undefined) {
          const staging = join(this.root, 'state', 'inbox-originals');
          await mkdir(staging, { recursive: true });
          await writeFile(join(staging, `${id}.bin`), outcome.originalHtml, 'utf8');
        }
      }
    } else {
      next = {
        ...existing.meta,
        status: 'fetch_failed',
        source: { ...existing.meta.source, fetchError: outcome.fetchError },
        updatedAt: new Date().toISOString(),
      };
    }
    await atomicWriteFile(join(dir, 'meta.json'), JSON.stringify(next, null, 2));
    return next;
  }

  /** List + counts (native list semantics: newest first, tag/status filter). */
  async list(filter = {}) {
    let ids = [];
    try {
      ids = await readdir(join(this.root, 'inbox'));
    } catch {
      return { items: [], counts: { byStatus: {}, byTag: {}, total: 0 }, pendingIds: [] };
    }
    const items = [];
    for (const id of ids) {
      if (id.startsWith('.')) continue;
      try {
        items.push(parseInboxMetaCompat(await readFile(join(this.root, 'inbox', id, 'meta.json'), 'utf8')));
      } catch { /* broken/missing meta: skip, disk is the truth */ }
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const byStatus = {};
    const byTag = {};
    for (const item of items) {
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      for (const tag of new Set(item.tags)) byTag[tag] = (byTag[tag] ?? 0) + 1;
    }

    let filtered = items;
    if (filter.status) filtered = filtered.filter((item) => item.status === filter.status);
    if (filter.tag) filtered = filtered.filter((item) => item.tags.includes(filter.tag));
    if (filter.query) {
      const needle = String(filter.query).toLowerCase();
      filtered = await filterByQuery(this.root, filtered, needle);
    }
    return { items: filtered, counts: { byStatus, byTag, total: items.length }, pendingIds: [...this.pending] };
  }

  async items() {
    const { items } = await this.list();
    return items;
  }

  async readOriginal(id) {
    const existing = await this.get(id);
    if (!existing) throw new Error(`对象不存在：inbox/${id}`);
    if (existing.meta.objectType !== 'pdf' && existing.meta.objectType !== 'epub') {
      throw new Error('该条目没有原件文件');
    }
    const ext = existing.meta.objectType;
    const bytes = await readFile(join(this.root, 'inbox', id, 'source', `original.${ext}`)).catch(() => null);
    if (bytes === null) throw new Error('原件文件缺失，请重新抓取');
    return { base64: bytes.toString('base64'), bytes: bytes.byteLength, ext };
  }

  // ------------------------------------------------------------------
  // Service-level operations (native InboxService semantics)
  // ------------------------------------------------------------------

  /** Create the unread placeholder, then fetch in the background. */
  async addUrl(rawUrl) {
    const url = String(rawUrl ?? '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('请输入 http(s) URL');
    const { items } = await this.list();
    const existing = items.find((item) => item.source?.kind === 'url' && item.source.url === url && item.status !== 'fetch_failed');
    if (existing) return { item: existing, duplicate: true };
    const meta = await this.create({
      title: url,
      content: '',
      source: { kind: 'url', url, addedAt: new Date().toISOString() },
    });
    void this.fetchInto(meta.id, url).catch((error) => {
      this.logger?.warn?.('droplets: inbox background fetch crashed: %s', String(error?.message ?? error));
    });
    return { item: meta, duplicate: false };
  }

  /** Markdown import (native inbox:import-markdown, content from the client). */
  async importMarkdown({ filename, content, title, tags }) {
    const name = typeof filename === 'string' && filename !== '' ? filename : undefined;
    const heading = /^#{1,6}\s+(.+)$/m.exec(String(content ?? ''));
    const derivedTitle = title || heading?.[1]?.trim() || name || '导入的 Markdown';
    return this.create({
      title: derivedTitle,
      content: String(content ?? ''),
      tags,
      source: { kind: 'markdown-import', addedAt: new Date().toISOString(), originalFilename: name },
    });
  }

  async retry(id) {
    const existing = await this.get(id);
    if (!existing) throw new Error(`对象不存在：inbox/${id}`);
    if (existing.meta.source.kind !== 'url') throw new Error('仅 URL 来源对象可重试抓取');
    return this.fetchInto(id, existing.meta.source.url);
  }

  async retryAllFailed() {
    const failed = (await this.list({ status: 'fetch_failed' })).items;
    let retried = 0;
    let failedCount = 0;
    for (const item of failed) {
      try {
        await this.retry(item.id);
        retried += 1;
      } catch { failedCount += 1; }
    }
    return { total: failed.length, retried, failed: failedCount };
  }

  async fetchInto(id, url) {
    this.pending.add(id);
    try {
      return await this.runExclusive(id, () => this.#fetchIntoInner(id, url));
    } finally {
      this.pending.delete(id);
    }
  }

  async #fetchIntoInner(id, url) {
    try {
      const response = await this.fetcher.fetch(url, {
        connectTimeoutMs: WORKSPACE_INBOX_LIMITS.connectTimeoutMs,
        totalTimeoutMs: WORKSPACE_INBOX_LIMITS.totalTimeoutMs,
        maxBodyBytes: WORKSPACE_INBOX_LIMITS.maxBodyBytes,
        maxRedirects: WORKSPACE_INBOX_LIMITS.maxRedirects,
      });
      if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
      const kind = contentTypeOf(response.headers, response.finalUrl ?? url);
      if (kind === 'pdf' || kind === 'epub') {
        if (response.body.byteLength > WORKSPACE_INBOX_LIMITS.maxDocumentBytes) {
          throw new Error(`文件超过 ${Math.round(WORKSPACE_INBOX_LIMITS.maxDocumentBytes / 1024 / 1024)} MB 上限`);
        }
        const document = kind === 'pdf'
          ? await extractPdf(response.body, response.finalUrl ?? url, response.headers)
          : await extractEpub(response.body);
        return this.setFetchOutcome(id, { ok: true, document });
      }
      // Web / json / text / other: decode then article-extract to markdown.
      const charset = /charset=([\w-]+)/i.exec(String(response.headers['content-type'] ?? ''))?.[1];
      const text = new TextDecoder(charset ?? 'utf-8', { fatal: false }).decode(response.body);
      if (kind === 'json') {
        const parsed = safeJson(text);
        const pretty = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
        const markdown = '```json\n' + pretty.slice(0, 400_000) + '\n```\n';
        return this.setFetchOutcome(id, {
          ok: true,
          content: markdown,
          title: guessTitleFrom(response.finalUrl ?? url, response.headers),
        });
      }
      const extracted = extractArticle(text, response.finalUrl ?? url);
      const markdown = htmlToMarkdown(extracted.html);
      return this.setFetchOutcome(id, {
        ok: true,
        content: markdown,
        title: extracted.title,
        originalHtml: text,
      });
    } catch (error) {
      const fetchError = toFetchError(error);
      this.logger?.info?.('droplets: inbox fetch failed (%s): %s', fetchError.code, fetchError.message);
      return this.setFetchOutcome(id, { ok: false, fetchError });
    }
  }

  // ------------------------------------------------------------------
  // 处理完成 destinations (native move.ts / trash service)
  // ------------------------------------------------------------------

  /** inbox → .trash staging commit (native addFromInbox). */
  async moveToTrash(id) {
    return this.runExclusive(id, async () => {
      const existing = await this.get(id);
      if (!existing) throw new Error(`对象不存在：inbox/${id}`);
      const sourceDir = join(this.root, 'inbox', id);
      const trashDir = join(this.root, '.trash', id);
      const stagingDir = join(this.root, '.trash', `.staging-${id}-${randomUUID()}`);
      await mkdir(stagingDir, { recursive: true });
      const { sizeBytes, fileCount } = await dirStats(sourceDir);
      const meta = {
        id,
        originalRelPath: `inbox/${id}`,
        deletedFrom: 'inbox',
        entryKind: 'directory',
        sizeBytes,
        fileCount,
        deletedAt: new Date().toISOString(),
        title: existing.meta.title,
      };
      await atomicWriteFile(join(stagingDir, 'trash-meta.json'), JSON.stringify(meta, null, 2));
      let sourceMoved = false;
      try {
        await rename(sourceDir, join(stagingDir, 'payload'));
        sourceMoved = true;
        await rename(stagingDir, trashDir);
      } catch (error) {
        if (sourceMoved) await rename(join(stagingDir, 'payload'), sourceDir).catch(() => undefined);
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      await rm(join(this.root, 'state', 'inbox-originals', `${id}.bin`), { force: true }).catch(() => {});
      return meta;
    });
  }

  /** inbox → library transaction (native moveInboxToLibrary, crash-safe). */
  async moveToLibrary(id) {
    return this.runExclusive(id, () => this.#moveToLibraryInner(id));
  }

  async #moveToLibraryInner(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw invalidId(id);
    const existing = await this.get(id);
    if (!existing) throw new Error(`对象不存在：inbox/${id}`);
    if (existing.meta.space !== 'inbox') throw new Error(`对象不在 inbox（当前 space=${existing.meta.space}）`);

    await mkdir(join(this.root, 'library'), { recursive: true });
    const libDir = join(this.root, 'library', id);
    let targetExists = await stat(libDir).then((info) => info.isDirectory()).catch(() => false);
    if (targetExists && (await readdir(libDir).catch(() => ['x'])).length === 0) {
      try {
        await rmdir(libDir);
        targetExists = false;
      } catch (error) {
        if (error?.code === 'ENOENT') targetExists = false;
        else if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') throw error;
      }
    }
    if (targetExists) {
      let ownPartial = false;
      try {
        const onDisk = JSON.parse(await readFile(join(libDir, 'meta.json'), 'utf8'));
        ownPartial = onDisk?.migration?.phase === 'inbox-to-library'
          && existing.meta.migration?.phase === 'inbox-to-library'
          && (onDisk.migration.txnId === undefined || onDisk.migration.txnId === existing.meta.migration.txnId);
      } catch { ownPartial = false; }
      if (!ownPartial) throw new Error(`资料库已存在同 ID 对象：library/${id}（可能来自恢复或同步复制），已拒绝覆盖`);
    }
    if (!targetExists) {
      try {
        await mkdir(libDir);
      } catch (error) {
        if (error?.code === 'EEXIST') throw new Error(`资料库目标在迁移期间被外部创建：library/${id}`);
        throw error;
      }
    }

    const marker = {
      phase: 'inbox-to-library',
      startedAt: existing.meta.migration?.startedAt ?? new Date().toISOString(),
      txnId: existing.meta.migration?.txnId ?? randomUUID(),
    };

    // 1. marker on the source
    const inboxMetaPath = join(this.root, 'inbox', id, 'meta.json');
    const marked = { ...existing.meta, migration: marker };
    await atomicWriteFile(inboxMetaPath, JSON.stringify(marked, null, 2));

    // 2. copy into library (marker retained on the copy)
    await mkdir(join(libDir, 'source'), { recursive: true });
    const libMeta = { ...existing.meta, space: 'library', migration: marker };
    await atomicWriteFile(join(libDir, 'meta.json'), JSON.stringify(libMeta, null, 2));
    await atomicWriteFile(join(libDir, 'content.md'), existing.content);
    const sourceDir = join(this.root, 'inbox', id);
    const sourceFiles = await walkFiles(sourceDir);
    const hasLegacyOriginal = sourceFiles.includes('original.html');
    for (const rel of sourceFiles) {
      if (rel === 'meta.json' || rel === 'content.md') continue;
      const targetRel = rel === 'original.html' ? join('source', 'original.html') : rel;
      await mkdir(join(libDir, dirname(targetRel)), { recursive: true });
      await copyFile(join(sourceDir, rel), join(libDir, targetRel));
    }
    const stagedOriginal = join(this.root, 'state', 'inbox-originals', `${id}.bin`);
    const hasStagedOriginal = await stat(stagedOriginal).then((info) => info.isFile()).catch(() => false);
    if (hasStagedOriginal && !hasLegacyOriginal) {
      await copyFile(stagedOriginal, join(libDir, 'source', 'original.html'));
    }

    // 3. hash verify, then delete the source
    const sourceRelForTarget = new Map();
    for (const rel of sourceFiles) {
      if (rel === 'meta.json') continue;
      sourceRelForTarget.set(rel === 'original.html' ? 'source/original.html' : rel, join(sourceDir, rel));
    }
    if (hasStagedOriginal && !hasLegacyOriginal) sourceRelForTarget.set('source/original.html', stagedOriginal);
    for (const [targetRel, sourceAbs] of sourceRelForTarget) {
      if (await sha256File(sourceAbs) !== await sha256File(join(libDir, targetRel))) {
        await rm(libDir, { recursive: true, force: true });
        await this.#clearSourceMarker(id);
        throw new Error('迁移校验失败：副本与源 hash 不一致，已回滚');
      }
    }

    // 3b. meta user-field final verify (disk reread, like the native move)
    const sourceMetaNow = parseInboxMetaCompat(await readFile(inboxMetaPath, 'utf8'));
    if (!metaUserFieldsEqual(sourceMetaNow, libMeta)) {
      await rm(libDir, { recursive: true, force: true });
      await this.#clearSourceMarker(id);
      throw new Error('迁移校验失败：源元数据在复制期间被修改，已回滚，请重试移动');
    }

    // 4. delete the inbox source
    await rm(sourceDir, { recursive: true, force: true });

    // 5. clear the library marker + drop the staged original
    const finalMeta = { ...libMeta, migration: undefined };
    await atomicWriteFile(join(libDir, 'meta.json'), JSON.stringify(finalMeta, null, 2));
    await rm(stagedOriginal, { force: true }).catch(() => {});
    return finalMeta;
  }

  async #clearSourceMarker(id) {
    const metaPath = join(this.root, 'inbox', id, 'meta.json');
    const meta = parseInboxMetaCompat(await readFile(metaPath, 'utf8'));
    const cleared = { ...meta, migration: undefined };
    await atomicWriteFile(metaPath, JSON.stringify(cleared, null, 2));
  }

  /** Text for the agent tool / companion context. */
  async plainText(id) {
    const existing = await this.get(id);
    if (!existing) throw new Error(`对象不存在：inbox/${id}`);
    if (existing.meta.objectType === 'epub') {
      const original = await this.readOriginal(id).catch(() => null);
      if (original) {
        return epubPlainText(Buffer.from(original.base64, 'base64')).catch(() => existing.content);
      }
    }
    return existing.content;
  }

  /** Compat shape for the reading-context / storage-info paths. */
  summarize(item) {
    return {
      key: item.id,
      id: item.id,
      url: item.source?.kind === 'url' ? item.source.url : '',
      title: item.title,
      kind: item.objectType === 'pdf' ? 'pdf' : item.objectType === 'epub' ? 'epub' : 'web',
      addedAt: Date.parse(item.createdAt) || Date.now(),
      readAt: item.status === 'finished' ? Date.parse(item.updatedAt) || null : null,
      bytes: 0,
      status: item.status,
      error: item.source?.kind === 'url' ? item.source.fetchError?.message : undefined,
      excerpt: '',
      hasBody: true,
      hasFile: item.objectType === 'pdf' || item.objectType === 'epub',
    };
  }
}

async function dirStats(absolute) {
  let sizeBytes = 0;
  let fileCount = 0;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) {
        const info = await stat(abs);
        sizeBytes += info.size;
        fileCount += 1;
      }
    }
  };
  await walk(absolute);
  return { sizeBytes, fileCount };
}

/** Query filter: title/tags/url match from meta; body match reads content.md. */
async function filterByQuery(root, items, needle) {
  const out = [];
  for (const item of items) {
    const haystack = [
      item.title,
      item.tags.join(' '),
      item.source?.kind === 'url' ? item.source.url : '',
      item.source?.kind === 'rss' ? item.source.url : '',
    ].join('\n').toLowerCase();
    if (haystack.includes(needle)) {
      out.push(item);
      continue;
    }
    try {
      const content = await readFile(join(root, 'inbox', item.id, 'content.md'), 'utf8');
      if (content.toLowerCase().includes(needle)) out.push(item);
    } catch { /* unreadable body: meta match only */ }
  }
  return out;
}

/** Normalize fetch failures to the native fetchError triple. */
function toFetchError(error) {
  if (error && error.name === 'SecurityRejectionError') {
    return { code: 'FETCH_REJECTED', message: error.message || '安全拒绝', securityRejection: true };
  }
  if (error && typeof error.code === 'string' && error.code.startsWith('FETCH_')) {
    return { code: error.code, message: error.message || '网络请求失败', securityRejection: false };
  }
  if (error && error.name === 'AbortError') {
    return { code: 'FETCH_TIMEOUT', message: error.message || '请求超时', securityRejection: false };
  }
  if (/HTTP \d{3}/.test(String(error?.message ?? ''))) {
    return { code: 'FETCH_STATUS', message: error.message, securityRejection: false };
  }
  return { code: 'FETCH_NETWORK', message: error?.message || '网络请求失败', securityRejection: false };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

/** PDF text layer + best-effort title (native pdfText worker parity). */
async function extractPdf(body, url, headers) {
  const [{ getDocument }, { WorkerMessageHandler }] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ]);
  globalThis.pdfjsWorker = { WorkerMessageHandler };
  const task = getDocument({ data: body.slice(), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    let title = null;
    try {
      const info = (await pdf.getMetadata())?.info;
      if (typeof info?.Title === 'string' && info.Title.trim() !== '') title = info.Title.trim();
    } catch { /* metadata optional */ }
    const parts = [];
    const pages = Math.min(pdf.numPages, 400);
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      parts.push(content.items.map((entry) => entry.str || '').join(' '));
    }
    return {
      original: body,
      ext: 'pdf',
      text: parts.join('\n\n'),
      title: title ?? guessTitleFrom(url, headers) ?? url,
      pages: pdf.numPages,
    };
  } finally {
    await task.destroy();
  }
}

/** EPUB text layer (reuses the bomb-guarded extractor). */
async function extractEpub(body) {
  const text = epubPlainText(body);
  let title = null;
  try {
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(body));
    const container = new TextDecoder().decode(files['META-INF/container.xml'] ?? '');
    const opfsPath = /full-path="([^"]+)"/.exec(container)?.[1];
    const opf = opfsPath ? new TextDecoder().decode(files[opfsPath] ?? '') : '';
    title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(opf)?.[1]
      ?? /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1];
  } catch { /* title optional */ }
  return {
    original: body,
    ext: 'epub',
    text,
    title: title?.trim() || 'EPUB',
    pages: 0,
  };
}
