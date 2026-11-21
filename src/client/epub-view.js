/**
 * EPUB reading for the inbox: fflate unzip in the browser with the same
 * decompression triple limit as the host (single entry / total / count), then
 * chapter XHTML sanitized and rendered like any other HTML.
 */
import { unzipSync } from 'fflate';
import { purifyHtml } from './md.js';

export const EPUB_LIMITS = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileCount: 2000,
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
  const chapters = (spine.length > 0 ? spine : names.filter((name) => /\.x?html?$/i.test(name)).map((href) => ({ href, type: 'text/html' })))
    .map((item, index) => {
      const path = baseDir ? normalizePath(baseDir + item.href) : item.href;
      const raw = readFile(files, path) ?? '';
      return { index, title: '第 ' + (index + 1) + ' 节', html: purifyHtml(stripToBody(raw)) };
    })
    .filter((chapter) => chapter.html !== '');
  return { title: title ?? 'EPUB', chapters, destroy() { files = null; } };
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
