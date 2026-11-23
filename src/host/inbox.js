/**
 * The inbox space: process-and-leave. add_url fetches through guardedFetch
 * (first-byte 20 s / total 60 s / >50 MB aborts), dispatches on content type
 * (web page → sanitized body in the body store; PDF/EPUB ≤256 MB → original
 * kept under storages/droplets-dsh/inbox-files/), and every read path
 * enforces the EPUB decompression triple limit (single entry / total bytes /
 * file count) against zip bombs.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { guardedFetch } from './guarded-fetch.js';
import { extractArticle } from './extract.js';
import { htmlToText, sanitizeHtml } from './sanitize.js';
import { hashKey } from './feeds.js';

export const INBOX_LIMITS = {
  maxBodyBytes: 50 * 1024 * 1024, // abort beyond 50 MB
  maxDocumentBytes: 256 * 1024 * 1024, // PDF/EPUB per-file cap
  connectTimeoutMs: 20_000, // first-byte
  totalTimeoutMs: 60_000,
  maxItems: 500,
  epub: {
    maxEntryBytes: 64 * 1024 * 1024, // single decompressed entry
    maxTotalBytes: 256 * 1024 * 1024, // total decompressed
    maxFileCount: 2000,
  },
};

function keyOf(url) {
  return `inbox:${hashKey(url)}`;
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

function guessTitle(url, headers) {
  const disposition = String(headers['content-disposition'] ?? '');
  const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(disposition)?.[1];
  if (filename) return decodeURIComponent(filename.trim());
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch { /* keep url */ }
  return url;
}

/**
 * The inbox manager. Persists item metadata through the store's inbox array
 * and bodies through its body store; originals live under inbox-files/.
 */
export class Inbox {
  constructor(store, logger, fetcher = guardedFetch) {
    this.store = store;
    this.logger = logger;
    // A provider keeps test injection live even after service swaps its own
    // fetcher post-construction.
    this.fetcherProvider = typeof fetcher === 'function' && fetcher.fetch === undefined ? fetcher : () => fetcher;
    this.filesDir = path.join(store.dir, 'inbox-files');
  }

  get fetcher() {
    return this.fetcherProvider();
  }

  items() {
    return this.store.data.inbox;
  }

  find(key) {
    return this.items().find((item) => item.key === key);
  }

  /** Fetch and store one URL. Long operation: bounded by the fetch limits. */
  async addUrl(rawUrl) {
    const url = String(rawUrl ?? '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('请输入 http(s) URL');
    const existing = this.items().find((item) => item.url === url && item.status !== 'error');
    if (existing) return { item: this.summarize(existing), duplicate: true };
    const key = keyOf(url);
    const item = {
      key,
      url,
      title: guessTitle(url, {}),
      kind: 'web',
      addedAt: Date.now(),
      readAt: null,
      doneAt: null,
      bytes: 0,
      file: null,
      status: 'fetching',
      error: undefined,
      excerpt: '',
    };
    this.items().unshift(item);
    if (this.items().length > INBOX_LIMITS.maxItems) this.items().length = INBOX_LIMITS.maxItems;
    this.store.touch();
    try {
      const response = await this.fetcher.fetch(url, {
        connectTimeoutMs: INBOX_LIMITS.connectTimeoutMs,
        totalTimeoutMs: INBOX_LIMITS.totalTimeoutMs,
        maxBodyBytes: INBOX_LIMITS.maxBodyBytes,
        maxRedirects: 6,
      });
      if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
      const kind = contentTypeOf(response.headers, response.finalUrl);
      const finalUrl = response.finalUrl;
      item.bytes = response.body.byteLength;
      if (kind === 'pdf' || kind === 'epub') {
        if (response.body.byteLength > INBOX_LIMITS.maxDocumentBytes) {
          throw new Error(`文件超过 ${Math.round(INBOX_LIMITS.maxDocumentBytes / 1024 / 1024)} MB 上限`);
        }
        await mkdir(this.filesDir, { recursive: true });
        const ext = kind === 'pdf' ? 'pdf' : 'epub';
        const file = `${key.slice('inbox:'.length)}.${ext}`;
        await writeFile(path.join(this.filesDir, file), response.body);
        item.kind = kind;
        item.file = file;
        item.title = guessTitle(finalUrl, response.headers);
        item.status = 'ready';
      } else if (kind === 'web' || kind === 'json' || kind === 'text' || kind === 'other') {
        const contentType = String(response.headers['content-type'] ?? '');
        const charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
        const text = new TextDecoder(charset ?? 'utf-8', { fatal: false }).decode(response.body);
        if (kind === 'json') {
          const parsed = safeJson(text);
          const pretty = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
          const html = `<pre><code>${escapePre(pretty.slice(0, 400_000))}</code></pre>`;
          this.store.bodies.set(key, html);
          item.kind = 'web';
          item.title = guessTitle(finalUrl, response.headers);
          item.excerpt = excerptOf(html);
          item.status = 'ready';
        } else {
          const extracted = extractArticle(text, finalUrl);
          this.store.bodies.set(key, extracted.html);
          item.kind = 'web';
          item.title = extracted.title;
          item.excerpt = excerptOf(extracted.html);
          item.status = 'ready';
        }
      } else {
        throw new Error(`不支持的内容类型：${contentTypeOf(response.headers, finalUrl)}`);
      }
    } catch (error) {
      item.status = 'error';
      item.error = String(error?.message ?? error);
      this.store.touch();
      throw error;
    }
    this.store.touch();
    this.store.bodies.touch();
    return { item: this.summarize(item), duplicate: false };
  }

  summarize(item) {
    return {
      key: item.key,
      url: item.url,
      title: item.title,
      kind: item.kind,
      addedAt: item.addedAt,
      readAt: item.readAt,
      bytes: item.bytes,
      status: item.status,
      error: item.error,
      excerpt: item.excerpt,
      hasBody: item.kind === 'web' && this.store.bodies.has(item.key),
      hasFile: Boolean(item.file),
    };
  }

  list({ filter } = {}) {
    // Done check must treat both null and undefined as "not done": older
    // records persist an explicit doneAt: null and were being hidden.
    const items = this.items().filter((item) => item.doneAt == null);
    const sorted = [...sortedByAdded(items)];
    if (filter === 'unread') return sorted.filter((item) => !item.readAt).map((item) => this.summarize(item));
    return sorted.map((item) => this.summarize(item));
  }

  /** Full read model for one item; marks it read. */
  async read(key) {
    const item = this.find(key);
    if (!item) throw new Error(`收件箱里没有这一条：${key}`);
    if (item.status === 'error') throw new Error(`抓取失败：${item.error}`);
    if (!item.readAt) {
      item.readAt = Date.now();
      this.store.touch();
    }
    const result = { item: this.summarize(item) };
    if (item.kind === 'web') {
      await this.store.bodies.load();
      result.html = this.store.bodies.get(key) ?? '';
      result.text = htmlToText(result.html);
    } else if (item.kind === 'pdf' || item.kind === 'epub') {
      const absolute = path.join(this.filesDir, item.file);
      const bytes = await readFile(absolute).catch(() => null);
      if (bytes === null) throw new Error('原件文件缺失，请重新抓取');
      result.base64 = bytes.toString('base64');
      result.bytes = bytes.byteLength;
      if (item.kind === 'epub') {
        result.text = epubPlainText(bytes);
      } else {
        result.text = '';
      }
    }
    return result;
  }

  /** PDF text extraction for the agent tool (lazy pdfjs import). */
  async pdfText(key, { maxPages = 400 } = {}) {
    const item = this.find(key);
    if (!item || item.kind !== 'pdf') throw new Error('不是 PDF 条目');
    const bytes = await readFile(path.join(this.filesDir, item.file));
    const [{ getDocument }, { WorkerMessageHandler }] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
    ]);
    globalThis.pdfjsWorker = { WorkerMessageHandler };
    const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
    try {
      const pdf = await task.promise;
      const pages = Math.min(pdf.numPages, maxPages);
      const parts = [];
      for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        parts.push(content.items.map((entry) => entry.str || '').join(' '));
      }
      return { pages: pdf.numPages, text: parts.join('\n\n') };
    } finally {
      await task.destroy();
    }
  }

  /** Remove an item with its body and original file (process-and-leave). */
  async markDone(key) {
    const index = this.items().findIndex((item) => item.key === key);
    if (index === -1) return false;
    const [item] = this.items().splice(index, 1);
    this.store.bodies.delete([key]);
    if (item.file) {
      await rm(path.join(this.filesDir, item.file), { force: true }).catch(() => {});
    }
    this.store.touch();
    this.store.bodies.touch();
    return true;
  }

  async fileSize(item) {
    if (!item.file) return 0;
    const info = await stat(path.join(this.filesDir, item.file)).catch(() => null);
    return info?.size ?? 0;
  }
}

function sortedByAdded(items) {
  return items.sort((a, b) => b.addedAt - a.addedAt);
}

function excerptOf(html, limit = 200) {
  const text = String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function escapePre(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * EPUB plain text with the decompression triple limit. Throws a typed error
 * on zip-bomb patterns instead of exhausting memory.
 */
export function epubPlainText(bytes, limits = INBOX_LIMITS.epub, { maxChars = 400_000 } = {}) {
  let files;
  try {
    files = unzipSync(new Uint8Array(bytes), { filter: (file) => {
      if (files === undefined) files = 0;
      return true;
    } });
  } catch (error) {
    throw new Error(`EPUB 解压失败：${error.message}`);
  }
  const names = Object.keys(files);
  if (names.length > limits.maxFileCount) {
    throw new Error(`EPUB 文件数超过上限（${names.length} > ${limits.maxFileCount}）`);
  }
  let total = 0;
  for (const name of names) {
    const size = files[name].byteLength;
    if (size > limits.maxEntryBytes) throw new Error(`EPUB 单文件解压超限：${name}`);
    total += size;
    if (total > limits.maxTotalBytes) throw new Error('EPUB 总解压量超过上限，疑似压缩炸弹');
  }
  const documents = names
    .filter((name) => /\.x?html?$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const parts = [];
  let chars = 0;
  for (const name of documents) {
    const html = new TextDecoder('utf-8', { fatal: false }).decode(files[name]);
    const text = htmlToText(sanitizeHtml(html, { maxLength: 200_000 }), 100_000);
    parts.push(text);
    chars += text.length;
    if (chars >= maxChars) break;
  }
  return parts.join('\n\n').slice(0, maxChars);
}

/** Key helper shared with tests. */
export { keyOf as inboxKeyOf };
