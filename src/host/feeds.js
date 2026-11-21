/**
 * Feed normalization: RSS 2.x, RSS 1.0 (RDF), Atom 1.0 and JSON Feed 1.1
 * documents become a common entry shape. Entry identity is stable within one
 * subscription: `feedId + (guid || link hash)` per the dedup key contract —
 * a repeated refresh updates entries in place and read/favorite state is
 * carried by that key, never duplicated.
 */
import { createHash } from 'node:crypto';
import { attrOf, childrenOf, find, findAll, parseXml, textOf } from './xml.js';
import { firstImageUrl, sanitizeHtml } from './sanitize.js';

const MAX_BODY_CHARS = 100_000;
const MAX_ENTRIES_INSPECTED = 200;
/** Per-feed entry cap from the plan: 100. */
const MAX_ENTRIES_KEPT = 100;
const MAX_BODY_BYTES_TOTAL = 4_000_000;

export function hashKey(...parts) {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 32);
}

/** Stable subscription id derived from the feed URL. */
export function subscriptionIdOf(url) {
  return `feed:${hashKey(url)}`;
}

/** Dedup key: feedId + (guid || hash(link)). */
export function entryKeyOf(feedId, entry) {
  const guid = String(entry.guid ?? '').trim();
  if (guid !== '') return `${feedId}|${guid}`;
  const link = String(entry.link ?? '').trim();
  return `${feedId}|${hashKey(link)}`;
}

/** Pick the article URL from a normalized entry node. */
function linkOf(node, isAtom) {
  if (isAtom) {
    for (const link of childrenOf(node, 'link')) {
      const rel = attrOf(link, 'rel');
      const href = attrOf(link, 'href');
      if (href && (rel === undefined || rel === 'alternate')) return href;
    }
    return attrOf(find(node, 'link'), 'href');
  }
  const link = find(node, 'link');
  const text = textOf(link).trim();
  if (text !== '') return text;
  return attrOf(find(node, 'link'), 'href');
}

function contentOf(node, isAtom) {
  const encoded = find(node, 'encoded'); // content:encoded
  const content = find(node, 'content');
  if (isAtom && content) {
    const type = attrOf(content, 'type') ?? 'text';
    const body = textOf(content);
    return type.includes('html') || type.includes('xhtml') ? body : `<p>${escapeHtml(body)}</p>`;
  }
  if (encoded) return textOf(encoded);
  if (content) return textOf(content);
  const description = find(node, 'description') ?? find(node, 'summary');
  return description ? textOf(description) : '';
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain-text list excerpt: strip tags, collapse whitespace, cap the length. */
export function excerptOf(html, limit = 180) {
  const text = String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function mediaAssetOf(node) {
  const asset = {};
  for (const name of ['thumbnail', 'content']) {
    for (const media of findAll(node, name)) {
      const url = attrOf(media, 'url');
      const medium = attrOf(media, 'medium');
      const type = attrOf(media, 'type') ?? '';
      if (url && !asset.image && (medium === 'image' || type.startsWith('image/') || name === 'thumbnail')) asset.image = url;
    }
  }
  for (const enclosure of childrenOf(node, 'enclosure')) {
    const url = attrOf(enclosure, 'url');
    const type = attrOf(enclosure, 'type') ?? '';
    if (url && !asset.image && type.startsWith('image/')) asset.image = url;
  }
  return asset;
}

function dateOf(node, isAtom) {
  const raw = textOf(isAtom ? find(node, 'updated') ?? find(node, 'published') : find(node, 'pubdate') ?? find(node, 'date'));
  const parsed = raw ? new Date(raw) : undefined;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function authorOf(node) {
  const atom = find(node, 'author');
  if (atom) {
    const name = find(atom, 'name');
    if (name) return textOf(name).trim();
  }
  return textOf(find(node, 'creator')).trim() || undefined; // dc:creator
}

function normalizeItem(node, isAtom, feedId) {
  const title = textOf(find(node, 'title')).trim();
  const link = linkOf(node, isAtom);
  const guid = textOf(isAtom ? find(node, 'id') : find(node, 'guid')).trim() || undefined;
  if (title === '' && !link && !guid) return undefined;
  const rawHtml = contentOf(node, isAtom);
  const asset = mediaAssetOf(node);
  const html = sanitizeHtml(rawHtml, { baseUrl: link, maxLength: MAX_BODY_CHARS });
  const key = entryKeyOf(feedId, { guid, link });
  return {
    key,
    guid,
    title: title || '(untitled)',
    author: authorOf(node),
    publishedAt: dateOf(node, isAtom),
    url: link,
    image: asset.image ?? firstImageUrl(html, link),
    summary: excerptOf(html),
    html,
    truncated: rawHtml.length > MAX_BODY_CHARS,
  };
}

/**
 * Parse one syndication document into entries plus feed metadata.
 * Detects RSS/Atom XML or JSON Feed by content.
 * @param {string} sourceText - raw feed text (≤ 5 MB).
 * @param {string} feedUrl - subscription URL, part of the stable entry id.
 * @returns {{title: string, link?: string, description?: string, entries: object[]}}
 */
export function parseFeed(sourceText, feedUrl) {
  const trimmed = sourceText.trimStart();
  if (trimmed.startsWith('{')) return parseJsonFeed(sourceText, feedUrl);
  return parseXmlFeed(sourceText, feedUrl);
}

function parseXmlFeed(xmlText, feedUrl) {
  const root = parseXml(xmlText);
  const channel = find(root, 'channel') ?? find(find(root, 'rss'), 'channel');
  const atomFeed = find(root, 'feed');
  const rdf = find(root, 'rdf');
  const feedId = subscriptionIdOf(feedUrl);

  let title = '';
  let link;
  let description;
  let items;

  if (channel) {
    title = textOf(find(channel, 'title')).trim();
    link = linkOf(channel, false);
    description = textOf(find(channel, 'description')).trim() || undefined;
    items = findAll(channel, 'item');
    // RSS 1.0 RDF keeps <item> as a sibling of <channel>.
    if (items.length === 0 && rdf) items = findAll(rdf, 'item');
  } else if (atomFeed) {
    title = textOf(find(atomFeed, 'title')).trim();
    link = linkOf(atomFeed, true);
    const subtitle = find(atomFeed, 'subtitle');
    description = subtitle ? textOf(subtitle).trim() || undefined : undefined;
    items = findAll(atomFeed, 'entry');
  } else {
    throw new Error('feed contains no channel/entry records');
  }

  return {
    title: title || feedUrl,
    link,
    description,
    entries: collectEntries(items.map((item) => normalizeItem(item, Boolean(atomFeed), feedId))),
  };
}

function parseJsonFeed(sourceText, feedUrl) {
  let parsed;
  try {
    parsed = JSON.parse(sourceText);
  } catch (error) {
    throw new Error(`malformed JSON Feed (${error.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    throw new Error('JSON Feed has no items array');
  }
  const feedId = subscriptionIdOf(feedUrl);
  const homeUrl = typeof parsed.home_page_url === 'string' ? parsed.home_page_url : undefined;
  const entries = parsed.items.slice(0, MAX_ENTRIES_INSPECTED).map((item) => {
    const link = typeof item.url === 'string' ? item.url : homeUrl;
    const guid = typeof item.id === 'string' && item.id !== '' ? item.id : undefined;
    const rawHtml = typeof item.content_html === 'string' && item.content_html !== ''
      ? item.content_html
      : typeof item.summary === 'string' && item.summary !== ''
        ? `<p>${escapeHtml(item.summary)}</p>`
        : typeof item.content_text === 'string'
          ? `<p>${escapeHtml(item.content_text)}</p>`
          : '';
    const html = sanitizeHtml(rawHtml, { baseUrl: link, maxLength: MAX_BODY_CHARS });
    const author = Array.isArray(item.authors) && typeof item.authors[0]?.name === 'string' ? item.authors[0].name : undefined;
    const published = item.date_published && !Number.isNaN(Date.parse(item.date_published)) ? new Date(item.date_published).toISOString() : undefined;
    const image = typeof item.image === 'string' ? item.image : firstImageUrl(html, link);
    return {
      key: entryKeyOf(feedId, { guid, link }),
      guid,
      title: String(item.title ?? '').trim() || '(untitled)',
      author,
      publishedAt: published,
      url: link,
      image,
      summary: excerptOf(html),
      html,
      truncated: rawHtml.length > MAX_BODY_CHARS,
    };
  });
  return {
    title: String(parsed.title ?? '').trim() || feedUrl,
    link: homeUrl,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    entries: collectEntries(entries),
  };
}

function collectEntries(candidates) {
  const entries = [];
  let totalBytes = 0;
  for (const entry of candidates) {
    if (!entry) continue;
    totalBytes += entry.html.length;
    if (totalBytes > MAX_BODY_BYTES_TOTAL) break;
    entries.push(entry);
    if (entries.length >= MAX_ENTRIES_KEPT) break;
  }
  return entries;
}

/**
 * Parse an OPML 2.0 outline into subscription stubs.
 * Nested group outlines become path names (`Tech / AI`).
 * @param {string} xmlText - OPML document.
 * @returns {{name?: string, group?: string, url: string}[]}
 */
export function parseOpml(xmlText) {
  const root = parseXml(xmlText);
  const body = findAll(root, 'body')[0] ?? root;
  const out = [];
  const visit = (node, group) => {
    for (const child of childrenOf(node, 'outline')) {
      const url = attrOf(child, 'xmlUrl') ?? attrOf(child, 'xmlurl');
      const text = attrOf(child, 'text') ?? attrOf(child, 'title');
      if (url) {
        out.push({ url, name: text?.trim() || undefined, group: group?.trim() || undefined });
      } else if (text) {
        visit(child, group ? `${group} / ${text.trim()}` : text.trim());
      }
    }
  };
  visit(body ?? root, undefined);
  const seen = new Set();
  return out.filter((item) => {
    const normalized = item.url.replace(/\/+$/, '');
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return /^https?:\/\//i.test(item.url);
  });
}

/** Render current subscriptions into an OPML 2.0 document. */
export function buildOpml(subscriptions) {
  const escape = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head><title>Droplets subscriptions</title></head>',
    '  <body>',
  ];
  const groups = new Map();
  for (const sub of subscriptions) {
    const key = sub.group ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sub);
  }
  for (const [group, subs] of groups) {
    if (group !== '') lines.push(`    <outline text="${escape(group)}">`);
    for (const sub of subs) {
      const indent = group !== '' ? '      ' : '    ';
      const name = sub.name ?? sub.url;
      lines.push(`${indent}<outline type="rss" text="${escape(name)}" title="${escape(name)}" xmlUrl="${escape(sub.url)}"/>`);
    }
    if (group !== '') lines.push('    </outline>');
  }
  lines.push('  </body>', '</opml>');
  return lines.join('\n');
}

/**
 * Merge fresh entries ahead of cached ones by stable key. Fresh wins on
 * content fields; a fresh entry without a body keeps the cached body so an
 * excerpt-only refresh never blanks a readable article.
 */
export function mergeEntries(cached, fresh, cap = MAX_ENTRIES_KEPT) {
  const merged = new Map();
  for (const entry of fresh) {
    if (entry && !merged.has(entry.key)) merged.set(entry.key, entry);
  }
  for (const entry of cached) {
    if (!entry) continue;
    const winner = merged.get(entry.key);
    if (winner === undefined) {
      merged.set(entry.key, entry);
      continue;
    }
    // A refresh that came back without a body keeps the cached body so an
    // excerpt-only feed never blanks a readable article.
    if ((winner.html === '' || winner.html === undefined) && entry.html) {
      merged.set(entry.key, { ...winner, html: entry.html, truncated: entry.truncated });
    }
  }
  return [...merged.values()].sort(sortByDate).slice(0, cap);
}

export function sortByDate(left, right) {
  const a = left.publishedAt ? Date.parse(left.publishedAt) : 0;
  const b = right.publishedAt ? Date.parse(right.publishedAt) : 0;
  return b - a;
}

export const FEED_LIMITS = {
  maxSubscriptions: 200,
  maxEntriesKept: MAX_ENTRIES_KEPT,
  maxBodyChars: MAX_BODY_CHARS,
};
