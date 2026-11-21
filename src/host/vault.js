/**
 * The vault space: a plain directory of Markdown notes (single vault, no
 * workspace abstraction). Everything is files — data ownership stays with the
 * user, export is a directory copy.
 *
 * Indexing: only *.md files, excluding .obsidian/, .trash/, hidden
 * directories and non-Markdown files. The inverted cache stores per-file
 * mtime/size; searches spot-check those stamps and re-read changed files,
 * panel open / window focus triggers one light full rescan, and a vaultPath
 * change drops the whole cache. Search itself is an inverted title/tag lookup
 * plus a body substring scan — no tokenization, no FTS.
 *
 * Writes: path-safety is enforced segment by segment (lstat + realpath,
 * symlinks and escapes rejected) and guarded by an expected_sha optimistic
 * lock so concurrent editors (agent tool vs. the panel editor) get a
 * structured conflict instead of a silent overwrite.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const EXCLUDED_DIRS = new Set(['.obsidian', '.trash', '.stfolder', '.git']);
export const PARA_FOLDERS = ['0-Inbox', '1-Projects', '2-Areas', '3-Resources', '4-Archives'];

export class VaultError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    this.details = details;
  }
}

export function shaOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Normalize a user/agent-supplied path into a posix-style vault-relative key. */
export function normalizeVaultPath(input) {
  if (typeof input !== 'string') throw new VaultError('invalid_path', '路径必须是字符串');
  let cleaned = input.replace(/\\/g, '/').trim();
  if (cleaned.startsWith('/')) cleaned = cleaned.slice(1);
  const segments = [];
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new VaultError('path_escape', '不允许 .. 路径段');
    segments.push(segment);
  }
  if (segments.length === 0) throw new VaultError('invalid_path', '路径不能为空');
  const rel = segments.join('/');
  if (rel.split('/').some((s) => s.startsWith('.') && s !== '.') && rel.split('/').some((s) => EXCLUDED_DIRS.has(s))) {
    throw new VaultError('excluded_path', '该目录不在索引范围内');
  }
  if (!rel.toLowerCase().endsWith('.md')) throw new VaultError('not_markdown', '只支持 Markdown (.md) 文件');
  return rel;
}

/**
 * Resolve a vault-relative path to an absolute one, refusing symlinks and
 * escapes. Each existing segment is lstat-ed (symlink → reject); the final
 * realpath must stay inside the root.
 */
export async function safeResolve(root, rel) {
  // Resolve the root through realpath first: the vault root may sit behind
  // a symlinked parent (macOS /var -> /private/var temp dirs), and comparing
  // a realpathed root against unresolved targets would flag false escapes.
  // Inner segments are lstat-checked so symlinks never slip in.
  const realRoot = await realpath(path.resolve(root)).catch(() => path.resolve(root));
  const target = path.resolve(realRoot, rel);
  let current = realRoot;
  for (const segment of rel.split('/')) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info === null) continue; // new file
    if (info.isSymbolicLink()) {
      throw new VaultError('symlink_rejected', '不允许符号链接：' + segment);
    }
  }
  const realTarget = await realpath(target).catch(() => target);
  const relToRoot = path.relative(realRoot, realTarget);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new VaultError('path_escape', '路径越界：' + rel);
  }
  return target;
}

/** Walk the vault collecting Markdown files (exclusions per the plan). */
export async function walkVault(root, dir = '', out = []) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkVault(root, rel, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(rel);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frontmatter & wikilinks
// ---------------------------------------------------------------------------

const WIKILINK = /\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g;
const TAG_LINE = /(?:^|\s)(#[^\s#]+)/g;

/** Parse a light YAML frontmatter block (flat keys; tags as list or CSV). */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text, hasFrontmatter: false };
  const data = {};
  let listKey;
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (/^\s*#/.test(rawLine) || rawLine.trim() === '') continue;
    if (/^\s+-\s+/.test(rawLine) && listKey) {
      const value = rawLine.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, '');
      if (Array.isArray(data[listKey])) data[listKey].push(value);
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine);
    if (!kv) { listKey = undefined; continue; }
    const key = kv[1];
    const value = kv[2].trim();
    if (value === '') {
      data[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(value)) {
      data[key] = value.slice(1, -1).split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter((item) => item !== '');
      listKey = undefined;
    } else {
      data[key] = value.replace(/^["']|["']$/g, '');
      listKey = undefined;
    }
  }
  return { data, body: text.slice(match[0].length), hasFrontmatter: true };
}

export function extractWikilinks(body) {
  const links = [];
  WIKILINK.lastIndex = 0;
  let match;
  while ((match = WIKILINK.exec(body)) !== null) {
    const raw = match[1].trim();
    if (raw === '') continue;
    const [target, heading] = raw.split('#');
    links.push({ target: target.trim(), heading: heading || undefined, raw: match[0] });
  }
  return links;
}

export function extractTags(body) {
  const tags = new Set();
  TAG_LINE.lastIndex = 0;
  let match;
  while ((match = TAG_LINE.exec(body)) !== null) {
    const tag = match[1].slice(1).replace(/[.,;:!?"')\]]+$/, '');
    if (tag.length > 0 && tag.length <= 64) tags.add(tag);
  }
  return [...tags];
}

export function titleOf(rel, data, body) {
  if (typeof data.title === 'string' && data.title.trim() !== '') return data.title.trim();
  const heading = /^#{1,6}\s+(.+)$/m.exec(body);
  if (heading) return heading[1].trim().slice(0, 200);
  return path.basename(rel, '.md');
}

/** Index one file into a cache record. */
export async function indexFile(root, rel, previous) {
  const absolute = path.join(root, rel);
  const info = await lstat(absolute);
  if (previous && previous.mtimeMs === info.mtimeMs && previous.size === info.size) return null; // unchanged
  const text = await readFile(absolute, 'utf8');
  return recordOf(rel, text, info.mtimeMs, info.size);
}

export function recordOf(rel, text, mtimeMs, size) {
  const { data, body } = parseFrontmatter(text);
  const frontTags = Array.isArray(data.tags) ? data.tags : typeof data.tags === 'string' && data.tags !== '' ? [data.tags] : [];
  const bodyTags = extractTags(body);
  return {
    path: rel,
    mtimeMs,
    size,
    title: titleOf(rel, data, body),
    tags: [...new Set([...frontTags.map(String), ...bodyTags])],
    links: extractWikilinks(body).map((link) => link.target),
    sha: shaOf(text),
    wordCount: body.replace(/\s+/g, '').length,
  };
}

/**
 * The vault service bound to one root directory with a persistent cache
 * document (provided by the caller's store).
 */
export class Vault {
  constructor(root, cacheHolder, logger) {
    this.root = root;
    this.cacheHolder = cacheHolder; // { get(), set(value) } persisted in data.json
    this.logger = logger;
  }

  cache() {
    return this.cacheHolder.get();
  }

  /** Full light rescan: reindex new/changed files, drop deleted ones. */
  async reindex() {
    const files = await walkVault(this.root);
    const previous = this.cache()?.files ?? {};
    const next = {};
    for (const rel of files) {
      const cached = previous[rel];
      const record = await indexFile(this.root, rel, cached).catch((error) => {
        this.logger?.warn?.('droplets: index failed for %s: %s', rel, String(error));
        return null;
      });
      next[rel] = record ?? cached ?? null;
    }
    const builtAt = Date.now();
    this.cacheHolder.set({ path: this.root, builtAt, files: next });
    return { files: Object.keys(next).length, builtAt };
  }

  /** Spot-check stamps for the files touched by a query; re-read changes. */
  async ensureFresh(rels) {
    const cache = this.cache();
    if (!cache || cache.path !== this.root) {
      await this.reindex();
      return;
    }
    const files = cache.files;
    let changed = false;
    for (const rel of rels) {
      const cached = files[rel];
      const info = await lstat(path.join(this.root, rel)).catch(() => null);
      if (info === null) {
        if (cached) { delete files[rel]; changed = true; }
        continue;
      }
      if (!cached || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
        const record = await indexFile(this.root, rel, cached).catch(() => null);
        if (record) { files[rel] = record; changed = true; }
      }
    }
    if (changed) this.cacheHolder.touch();
  }

  stats() {
    const cache = this.cache();
    if (!cache) return { files: 0, builtAt: 0 };
    return { files: Object.keys(cache.files).length, builtAt: cache.builtAt };
  }

  /** Resolve a wikilink target to a vault path using the index. */
  resolveLink(target) {
    const files = this.cache()?.files ?? {};
    const wanted = target.replace(/\.md$/i, '').replace(/^\.?\//, '');
    if (files[`${wanted}.md`]) return `${wanted}.md`;
    const matches = Object.keys(files).filter((rel) => {
      const stem = rel.replace(/\.md$/i, '');
      return stem === wanted || stem.endsWith(`/${wanted}`);
    });
    return matches[0];
  }

  /**
   * Search: inverted title/tag hit plus a body substring scan over candidate
   * files (cap applies). Files whose stamps changed are re-read first.
   */
  async search(query, limit = 30) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (needle === '') return [];
    await this.ensureFresh(Object.keys(this.cache()?.files ?? {}).slice(0, 500));
    const files = this.cache()?.files ?? {};
    const results = [];
    const ranked = [];
    for (const [rel, record] of Object.entries(files)) {
      if (!record) continue;
      const title = String(record.title ?? '').toLowerCase();
      const tags = (record.tags ?? []).map((tag) => String(tag).toLowerCase());
      let score = 0;
      if (title === needle) score = 100;
      else if (title.includes(needle)) score = 60;
      else if (tags.some((tag) => tag.includes(needle))) score = 40;
      if (score > 0) ranked.push({ rel, record, score, where: 'title/tag' });
    }
    ranked.sort((a, b) => b.score - a.score);
    for (const candidate of ranked) {
      if (results.length >= limit) break;
      const text = await this.readRaw(candidate.rel).catch(() => null);
      if (text === null) continue;
      results.push({ path: candidate.rel, title: candidate.record.title, tags: candidate.record.tags, match: candidate.where, excerpt: excerptAround(text, needle) });
    }
    if (results.length < limit) {
      // Body substring scan across the corpus (a few hundred 10 KB files).
      for (const rel of Object.keys(files)) {
        if (results.length >= limit) break;
        if (ranked.some((item) => item.rel === rel)) continue;
        const text = await this.readRaw(rel).catch(() => null);
        if (text === null) continue;
        const at = text.toLowerCase().indexOf(needle);
        if (at === -1) continue;
        results.push({ path: rel, title: files[rel]?.title ?? path.basename(rel), tags: files[rel]?.tags ?? [], match: 'body', excerpt: excerptAround(text, needle) });
      }
    }
    return results;
  }

  async readRaw(rel) {
    const absolute = await safeResolve(this.root, rel);
    return readFile(absolute, 'utf8');
  }

  async read(rel) {
    const normalized = normalizeVaultPath(rel);
    const text = await this.readRaw(normalized).catch((error) => {
      if (error?.code === 'VaultError') throw error;
      if (error?.code === 'ENOENT') throw new VaultError('not_found', `笔记不存在：${normalized}`);
      throw new VaultError('read_failed', `读取失败：${error.message}`);
    });
    const info = await lstat(path.join(this.root, normalized)).catch(() => null);
    const record = recordOf(normalized, text, info?.mtimeMs ?? 0, info?.size ?? Buffer.byteLength(text));
    const cached = this.cache()?.files;
    if (cached && (!cached[normalized] || cached[normalized].sha !== record.sha)) {
      cached[normalized] = record;
      this.cacheHolder.touch();
    }
    return { path: normalized, content: text, sha: record.sha, title: record.title, tags: record.tags, wordCount: record.wordCount };
  }

  /**
   * Write with an expected_sha optimistic lock. On mismatch the caller gets
   * { conflict, currentSha, currentExcerpt } and must re-read before writing.
   */
  async write(rel, content, options = {}) {
    const expectedSha = options.expectedSha ?? undefined;
    const createOnly = options.createOnly === true;
    const normalized = normalizeVaultPath(rel);
    if (typeof content !== 'string') throw new VaultError('invalid_content', '内容必须是字符串');
    if (content.length > 2_000_000) throw new VaultError('too_large', '笔记内容超过 2 MB 上限');
    const absolute = await safeResolve(this.root, normalized);
    const existing = await readFile(absolute, 'utf8').catch(() => null);
    if (existing !== null) {
      const currentSha = shaOf(existing);
      if (expectedSha !== undefined && expectedSha !== currentSha) {
        return { conflict: true, path: normalized, currentSha, currentExcerpt: excerptOf(existing) };
      }
      if (createOnly) throw new VaultError('exists', `笔记已存在：${normalized}`);
    } else if (expectedSha !== undefined) {
      return { conflict: true, path: normalized, currentSha: null, currentExcerpt: '' };
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    const temp = `${absolute}.tmp-${process.pid}-${Date.now().toString(36)}`;
    await writeFile(temp, content, 'utf8');
    await rename(temp, absolute);
    const info = await lstat(absolute);
    const record = recordOf(normalized, content, info.mtimeMs, info.size);
    const cache = this.cache();
    if (cache) {
      cache.files[normalized] = record;
      this.cacheHolder.touch();
    }
    return { conflict: false, path: normalized, sha: record.sha, title: record.title, created: existing === null };
  }

  /** Files whose wikilinks point at rel (resolved through the index). */
  backlinks(rel) {
    const normalized = normalizeVaultPath(rel);
    const files = this.cache()?.files ?? {};
    const out = [];
    for (const [source, record] of Object.entries(files)) {
      if (!record || source === normalized) continue;
      for (const target of record.links ?? []) {
        if (this.resolveLink(target) === normalized) {
          out.push({ path: source, title: record.title });
          break;
        }
      }
    }
    return out;
  }

  /** Graph: one node per file plus dangling nodes for unresolved targets. */
  graph() {
    const files = this.cache()?.files ?? {};
    const nodes = [];
    const edges = [];
    const byPath = new Map();
    for (const [rel, record] of Object.entries(files)) {
      byPath.set(rel, nodes.length);
      nodes.push({ id: rel, title: record?.title ?? path.basename(rel), dangling: false });
    }
    for (const [rel, record] of Object.entries(files)) {
      for (const target of record?.links ?? []) {
        const resolved = this.resolveLink(target);
        if (resolved) {
          edges.push({ source: rel, target: resolved });
          continue;
        }
        const id = `dangling:${target}`;
        if (!byPath.has(id)) {
          byPath.set(id, nodes.length);
          nodes.push({ id, title: target, dangling: true });
        }
        edges.push({ source: rel, target: id });
      }
    }
    return { nodes, edges };
  }

  /** Directory tree for the file panel. */
  tree() {
    const files = this.cache()?.files ?? {};
    const root = { name: '', dirs: new Map(), files: [] };
    for (const rel of Object.keys(files).sort()) {
      const segments = rel.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i];
        if (!node.dirs.has(segment)) node.dirs.set(segment, { name: segment, dirs: new Map(), files: [] });
        node = node.dirs.get(segment);
      }
      node.files.push({ path: rel, title: files[rel]?.title ?? segments[segments.length - 1], wordCount: files[rel]?.wordCount ?? 0 });
    }
    const serialize = (node) => ({
      name: node.name,
      dirs: [...node.dirs.values()].map(serialize).sort((a, b) => a.name.localeCompare(b.name)),
      files: node.files,
    });
    return serialize(root);
  }
}

function excerptAround(text, needle, radius = 60) {
  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) return excerptOf(text, 140);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + needle.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

function excerptOf(text, limit = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Ensure the default vault skeleton exists (only for the default location). */
export async function ensureDefaultVault(root) {
  await mkdir(root, { recursive: true });
  for (const folder of PARA_FOLDERS) {
    await mkdir(path.join(root, folder), { recursive: true });
  }
}
