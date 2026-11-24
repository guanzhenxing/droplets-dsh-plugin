/**
 * EPUB reading for the inbox: fflate unzip in the browser with the same
 * decompression triple limit as the host (single entry / total / count), then
 * chapter XHTML sanitized and rendered like any other HTML. Chapter titles
 * come from the document itself (h1-h6, then <title>), and image/css
 * references resolve against the unpacked resources as blob: URLs.
 */
import { unzipSync } from 'fflate';
import { purifyHtml } from './md.js';

export const EPUB_LIMITS = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileCount: 2000,
};

/** Resource files the reader can resolve into blob URLs (everything but XHTML). */
const RESOURCE_EXT = /\.(png|jpe?g|gif|webp|svg|css)$/i;
const RESOURCE_MIME = {
  css: 'text/css',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

export function openEpub(base64, limits = EPUB_LIMITS) {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  let files;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new Error('EPUB 解压失败：' + (error?.message ?? error));
  }
  const names = Object.keys(files);
  if (names.length > limits.maxFileCount) throw new Error('EPUB 文件数超过上限');
  let total = 0;
  for (const name of names) {
    const size = files[name].byteLength;
    if (size > limits.maxEntryBytes) throw new Error('EPUB 单文件解压超限：' + name);
    total += size;
    if (total > limits.maxTotalBytes) throw new Error('EPUB 总解压量超过上限');
  }
  const container = readFile(files, 'META-INF/container.xml');
  const opfPath = container ? /full-path="([^"]+)"/.exec(container)?.[1] : names.find((name) => name.endsWith('.opf'));
  const opf = opfPath ? readFile(files, opfPath) : '';
  const baseDir = opfPath ? opfPath.replace(/[^/]*$/, '') : '';
  const title = opf ? /<title[^>]*>([^<]*)<\/title>/i.exec(opf)?.[1] : undefined;
  const manifest = new Map();
  for (const item of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = item[0];
    const id = /id="([^"]+)"/.exec(tag)?.[1];
    const href = /href="([^"]+)"/.exec(tag)?.[1];
    const type = /media-type="([^"]+)"/.exec(tag)?.[1] ?? '';
    if (id && href) manifest.set(id, { href: decodeURIComponent(href), type });
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"[^>]*\/>/gi)].map((match) => manifest.get(match[1])).filter(Boolean)
    .filter((item) => /x?html/.test(item.type) || /\.x?html?$/i.test(item.href));

  // Non-XHTML resources keyed by their normalized path from the EPUB root;
  // chapter XHTML points at them with refs relative to the chapter file.
  const resources = new Map();
  for (const name of names) {
    if (RESOURCE_EXT.test(name)) resources.set(normalizePath(name), files[name]);
  }
  // Blob URLs are created once per resource (shared across chapters) and
  // tracked so destroy() can revoke them. Environments without
  // URL.createObjectURL (jsdom) skip the rewrite and keep the original refs.
  const canBlob = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined';
  const blobUrls = [];
  const blobUrlByKey = new Map();
  const resourceUrl = (key) => {
    if (!canBlob || blobUrlByKey.has(key)) return blobUrlByKey.get(key);
    const data = resources.get(key);
    if (!data) return undefined;
    const url = URL.createObjectURL(new Blob([data], { type: mimeFor(key) }));
    blobUrlByKey.set(key, url);
    blobUrls.push(url);
    return url;
  };
  const chapters = (spine.length > 0 ? spine : names.filter((name) => /\.x?html?$/i.test(name)).map((href) => ({ href, type: 'text/html' })))
    .map((item, index) => {
      const path = baseDir ? normalizePath(baseDir + item.href) : item.href;
      const raw = readFile(files, path) ?? '';
      const m = /<h[1-6][^>]*>([^<]+)<\/h[1-6]>/i.exec(raw) ?? /<title[^>]*>([^<]+)<\/title>/i.exec(raw);
      // Resource rewriting runs after sanitize: the sanitizer keeps relative
      // refs, and the final html carries the blob: URLs for the caller.
      const html = rewriteResourceRefs(purifyHtml(stripToBody(raw)), path.replace(/[^/]*$/, ''), resourceUrl);
      return { index, title: (m?.[1]?.trim() || ('第 ' + (index + 1) + ' 节')), html };
    })
    .filter((chapter) => chapter.html !== '');
  return {
    title: title ?? 'EPUB',
    chapters,
    destroy() {
      files = null;
      resources.clear();
      blobUrlByKey.clear();
      const urls = blobUrls.splice(0, blobUrls.length);
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        for (const url of urls) URL.revokeObjectURL(url);
      }
    },
  };
}

function readFile(files, name) {
  const file = files[name];
  if (!file) return undefined;
  return new TextDecoder('utf-8', { fatal: false }).decode(file);
}

function normalizePath(path) {
  const out = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

function stripToBody(xhtml) {
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(xhtml);
  return body ? body[1] : xhtml;
}

function mimeFor(path) {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return RESOURCE_MIME[ext] ?? 'application/octet-stream';
}

/**
 * Rewrite src/href attributes of one chapter's html: relative refs resolve
 * against the chapter's directory inside the EPUB and become blob: URLs when
 * they hit the resource map; misses and absolute URLs stay untouched.
 */
function rewriteResourceRefs(html, dir, resolveUrl) {
  return html.replace(/(src|href)="([^"]+)"/g, (whole, attr, value) => {
    const url = resourceUrlFor(value, dir, resolveUrl);
    return url === undefined ? whole : attr + '="' + url + '"';
  });
}

/** Resolve one attribute value against the chapter dir, or undefined. */
function resourceUrlFor(value, dir, resolveUrl) {
  let ref = String(value).trim();
  for (const mark of ['#', '?']) {
    const at = ref.indexOf(mark);
    if (at >= 0) ref = ref.slice(0, at);
  }
  if (ref === '' || ref.startsWith('//') || /^[a-z][a-z0-9+.\-]*:/i.test(ref)) return undefined;
  const rootRelative = ref.startsWith('/');
  if (rootRelative) ref = ref.slice(1);
  const base = rootRelative ? '' : dir;
  // The sanitizer re-escapes entities in attribute values, and zip entry
  // names may be raw or percent-encoded: try the decoded key, then the raw.
  const decoded = decodePath(decodeEntities(ref));
  return resolveUrl(normalizePath(base + decoded)) ?? resolveUrl(normalizePath(base + ref));
}

/** Decode the XML entities the sanitizer leaves escaped in attribute values. */
function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (whole, code) => {
      const point = Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    })
    .replace(/&amp;/g, '&');
}

/** Percent-decode a path, keeping the raw value on a malformed sequence. */
function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
