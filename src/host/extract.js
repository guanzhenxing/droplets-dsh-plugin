/**
 * Lightweight web-page content extraction (M2 decision: option ②, the
 * htmlToText-grade approach). No JSDOM: a tolerant scan pulls the title,
 * meta description and main-region HTML, then the shared allowlist
 * sanitizer renders the body. Good enough for companion reading and agent
 * organizing; keeps the host bundle small.
 */
import { decodeHtmlEntities, sanitizeHtml } from './sanitize.js';

function metaContent(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return decodeHtmlEntities(match[1]).trim();
  }
  return undefined;
}

function titleOf(html, fallback) {
  const titled = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const cleaned = titled ? decodeHtmlEntities(titled[1]).replace(/\s+/g, ' ').trim() : '';
  if (cleaned !== '') return cleaned;
  return metaContent(html, 'og:title') ?? metaContent(html, 'twitter:title') ?? fallback;
}

/** Strip leading navigation by preferring the densest <main>/<article> block. */
function mainRegion(html) {
  const candidates = [];
  const block = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = block.exec(html)) !== null) {
    const text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > 200) candidates.push({ html: match[2], score: text.length });
  }
  if (candidates.length === 0) return html;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].html;
}

/**
 * Extract a readable document from a fetched HTML page.
 * @returns {{title: string, description?: string, html: string, text: string}}
 */
export function extractArticle(html, baseUrl) {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const title = titleOf(withoutScripts, baseUrl ?? 'Untitled');
  const description = metaContent(withoutScripts, 'description') ?? metaContent(withoutScripts, 'og:description');
  const region = mainRegion(withoutScripts);
  const safe = sanitizeHtml(region, { baseUrl, maxLength: 300_000 });
  return { title, description, html: safe, text: '' };
}
