/**
 * Per-subscription feed icons (favicons).
 *
 * Acquisition order for one subscription, first valid image wins:
 *   1. `<site-origin>/favicon.ico` — the site's canonical icon;
 *   2. `<link rel="icon">` declared in the site's HTML head (covers sites
 *      that only ship a modern icon and no legacy /favicon.ico);
 *   3. an icon/image URL declared by the feed itself (RSS `<image>`,
 *      Atom `<icon>`/`<logo>`, JSON Feed `favicon`/`icon`).
 *
 * The winner is stored as a data URL in its own file under
 * `storages/droplets-dsh/icons/<feedId>` (raw data-URL text), so the
 * metadata document stays small and one icon write never rewrites the
 * others. Failures are throttled per subscription via `iconErrorAt` in
 * data.json: retry at most once every 7 days.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 64 KB: real favicons are 1–15 KB; banners above this are rejected. */
const MAX_ICON_BYTES = 64 * 1024;
/** HTML head probing budget: <link rel=icon> lives in the first bytes. */
const MAX_HTML_BYTES = 256 * 1024;
const ICON_TIMEOUT_MS = 8_000;
const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Sniff the media type from magic bytes so non-typed responses still work.
 *  Also used by the vault attachment channel (png/jpg/gif/webp/svg). */
export function sniffImageType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1) return 'image/x-icon';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const head = bytes.toString('latin1', 0, Math.min(bytes.length, 512)).trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  return undefined;
}

function absoluteOf(href, base) {
  try {
    const url = new URL(String(href), base);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Site origin to probe: the feed's declared home page beats the feed host. */
export function siteOriginOf(sub, parsed) {
  const candidates = [
    typeof parsed?.link === 'string' ? parsed.link : undefined,
    typeof sub?.url === 'string' ? sub.url : undefined,
  ];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) return url.origin;
    } catch { /* not a URL */ }
  }
  return undefined;
}

/** Parse `<link rel=…icon… href=…>` from an HTML head snippet. */
export function iconLinkOfHtml(html, baseUrl) {
  const pattern = /<link\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(String(html ?? ''))) !== null) {
    const tag = match[0];
    if (!/\brel\s*=\s*["'][^"']*icon[^"']*["']/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) {
      const absolute = absoluteOf(href, baseUrl);
      if (absolute) return absolute;
    }
  }
  return undefined;
}

/**
 * Validate one fetched candidate as a usable icon; returns a data URL or
 * undefined (never throws — candidates are best-effort by design).
 */
export async function fetchIconDataUrl(fetcher, url) {
  try {
    const response = await fetcher.fetch(url, {
      connectTimeoutMs: ICON_TIMEOUT_MS,
      totalTimeoutMs: ICON_TIMEOUT_MS,
      maxBodyBytes: MAX_ICON_BYTES,
    });
    if (response.status >= 400) return undefined;
    const body = response.body;
    if (!body || body.length === 0 || body.length > MAX_ICON_BYTES) return undefined;
    const declared = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const mime = declared.startsWith('image/') ? declared : sniffImageType(body);
    if (!mime) return undefined;
    return `data:${mime};base64,${Buffer.from(body).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** Icon file store: one data-URL text file per feed, loaded once per process. */
export class FeedIconStore {
  constructor(dir, logger) {
    this.dir = dir;
    this.logger = logger;
    this.cache = null;
    this.writing = Promise.resolve();
  }

  /** All known icons as { feedId: dataUrl } (cached after the first read). */
  async all() {
    if (this.cache !== null) return this.cache;
    const map = {};
    try {
      for (const name of await readdir(this.dir)) {
        if (name.startsWith('.')) continue;
        const dataUrl = (await readFile(join(this.dir, name), 'utf8')).trim();
        if (dataUrl.startsWith('data:image/')) map[decodeURIComponent(name)] = dataUrl;
      }
    } catch { /* no icons yet */ }
    this.cache = map;
    return map;
  }

  save(feedId, dataUrl) {
    if (this.cache === null) this.cache = {};
    this.cache[feedId] = dataUrl;
    const target = join(this.dir, encodeURIComponent(feedId));
    this.writing = this.writing.catch(() => {}).then(async () => {
      const temp = `${target}.${process.pid}.tmp`;
      try {
        await mkdir(this.dir, { recursive: true });
        await writeFile(temp, dataUrl, { encoding: 'utf8', mode: 0o600 });
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        this.logger?.warn?.(`droplets: cannot store icon for ${feedId}: ${String(error)}`);
      }
    });
    return this.writing;
  }

  remove(feedId) {
    if (this.cache !== null) delete this.cache[feedId];
    return rm(join(this.dir, encodeURIComponent(feedId)), { force: true }).catch(() => {});
  }

  /** Backward compatibility: callers may check existence before saving. */
  async has(feedId) {
    return (await this.all())[feedId] !== undefined;
  }
}

/**
 * Resolve and persist the icon for one subscription. Pure orchestration:
 * never throws; mutates `sub.iconErrorAt` so the caller can persist the
 * throttle hint. Returns 'stored' when a fresh icon was saved, 'failed'
 * when every candidate was exhausted (throttle hint recorded), and
 * undefined when nothing changed (icon already cached or throttled).
 */
export async function ensureFeedIcon(sub, parsed, fetcher, store) {
  if (!sub?.id) return undefined;
  if (await store.has(sub.id)) return undefined;
  if (typeof sub.iconErrorAt === 'number' && Date.now() - sub.iconErrorAt < RETRY_AFTER_MS) return undefined;

  const origin = siteOriginOf(sub, parsed);
  const candidates = [];
  if (origin) candidates.push(origin + '/favicon.ico');

  // Probe the HTML head for <link rel=icon> (only when the origin is known).
  if (origin) {
    try {
      const response = await fetcher.fetch(origin + '/', {
        connectTimeoutMs: ICON_TIMEOUT_MS,
        totalTimeoutMs: ICON_TIMEOUT_MS,
        maxBodyBytes: MAX_HTML_BYTES,
      });
      if (response.status < 400 && typeof response.body?.toString === 'function') {
        const html = response.body.toString('utf8');
        const link = iconLinkOfHtml(html, origin + '/');
        if (link) candidates.push(link);
      }
    } catch { /* site unreachable: favicon.ico candidate already covers it */ }
  }
  for (const declared of parsed?.iconCandidates ?? []) {
    const absolute = absoluteOf(declared, typeof sub.url === 'string' ? sub.url : undefined);
    if (absolute) candidates.push(absolute);
  }

  for (const candidate of candidates) {
    const dataUrl = await fetchIconDataUrl(fetcher, candidate);
    if (dataUrl) {
      await store.save(sub.id, dataUrl);
      sub.iconErrorAt = undefined;
      return 'stored';
    }
  }
  sub.iconErrorAt = Date.now();
  return 'failed';
}
