/**
 * Vault index backends (plan §3.2): one interface, two implementations.
 *
 * - NativeVaultIndex reads the Droplets desktop app's own index database
 *   (state/index.sqlite, FTS5 trigram + wiki_links + doc_tags) through a
 *   read-only node:sqlite connection. Zero indexing cost; counts match the
 *   desktop app exactly. Trigram requires queries ≥3 characters — shorter
 *   queries fall back to a LIKE scan over the stored columns.
 * - LocalVaultIndex wraps the Vault class's own JSON cache (private mode,
 *   no Droplets workspace) with the same interface.
 *
 * The backend never writes: the desktop app's watcher rebuilds this database
 * from disk, and its writer process owns the SQLite handle.
 */
import path from 'node:path';

const DOC_PREFIX = 'vault:';
/** content_index.path carries a workspace-relative 'vault/' prefix. */
const PATH_PREFIX = 'vault/';

function docIdOf(rel) {
  return DOC_PREFIX + rel;
}

/** content_index.path ('vault/x/y.md') → vault-relative path ('x/y.md'). */
function relOfIndexPath(indexPath) {
  const clean = String(indexPath ?? '');
  return clean.startsWith(PATH_PREFIX) ? clean.slice(PATH_PREFIX.length) : clean;
}

function relOfDocId(docId) {
  return typeof docId === 'string' && docId.startsWith(DOC_PREFIX) ? docId.slice(DOC_PREFIX.length) : docId;
}

/** The bare wikilink targets a note stem responds to: stem and title variants. */
function linkTargetsFor(rel, title) {
  const stem = path.basename(rel, '.md');
  const targets = new Set([stem]);
  if (title && title !== stem) targets.add(title);
  return [...targets];
}

/** Escape a string for FTS5 MATCH (double quotes doubled, wrapped in quotes). */
function ftsQuote(text) {
  return '"' + String(text).replace(/"/g, '""') + '"';
}


/** content_index times are microseconds on this schema; normalize to ms. */
function normalizeMtime(raw) {
  const value = Number(raw ?? 0);
  return value > 1e14 ? Math.round(value / 1000) : Math.round(value);
}

export class NativeVaultIndex {
  constructor(dbPath, logger) {
    this.dbPath = dbPath;
    this.logger = logger;
    this.db = null;
    this.failed = false;
  }

  async available() {
    if (this.failed) return false;
    if (this.db !== null) return true;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      this.db.exec('PRAGMA busy_timeout = 5000');
      // Schema probe: an old/new database without our tables degrades cleanly.
      this.db.prepare('SELECT path FROM content_index LIMIT 1').get();
      return true;
    } catch (error) {
      this.failed = true;
      this.logger?.info?.('droplets: native vault index unavailable: %s', String(error?.message ?? error));
      return false;
    }
  }

  async search(query, { limit = 30, offset = 0, tag } = {}) {
    if (!(await this.available())) return { hits: [], total: 0 };
    const needle = String(query ?? '').trim();
    if (needle === '' && !tag) return { hits: [], total: 0 };
    const cap = Math.min(Math.max(limit, 1), 100);
    const skip = Math.max(offset, 0);
    if (needle.length < 3) {
      // trigram tokenizer cannot match <3 chars: LIKE scan over stored columns
      const like = '%' + needle.replace(/[%_]/g, '\\$&') + '%';
      const sql = `SELECT ci.path, ci.title, ci.mtime,
        substr(cf.body, max(1, instr(lower(cf.body), lower(?)) - 40), 120) AS snippet
        FROM content_index ci JOIN content_fts cf ON cf.path = ci.path
        WHERE (cf.title LIKE ? ESCAPE '\\' OR cf.body LIKE ? ESCAPE '\\' OR cf.path LIKE ? ESCAPE '\\')${tag ? ' AND ci.path IN (SELECT doc_id FROM doc_tags WHERE tag = ?)' : ''}
        ORDER BY ci.mtime DESC LIMIT ? OFFSET ?`;
      const params = [needle, like, like, like];
      if (tag) params.push(tag);
      params.push(cap, skip);
      const rows = this.db.prepare(sql).all(...params);
      const totalRow = this.db.prepare(
        `SELECT COUNT(*) AS c FROM content_index ci JOIN content_fts cf ON cf.path = ci.path
         WHERE (cf.title LIKE ? ESCAPE '\\' OR cf.body LIKE ? ESCAPE '\\' OR cf.path LIKE ? ESCAPE '\\')${tag ? ' AND ci.path IN (SELECT doc_id FROM doc_tags WHERE tag = ?)' : ''}`,
      ).all(...(tag ? [like, like, like, tag] : [like, like, like]));
      return { hits: rows.map((row) => ({ path: relOfIndexPath(row.path), title: row.title || path.basename(row.path), snippet: row.snippet || '', mtime: normalizeMtime(row.mtime) })), total: totalRow[0]?.c ?? 0 };
    }
    const match = ftsQuote(needle);
    const tagClause = tag ? ' AND ci.path IN (SELECT doc_id FROM doc_tags WHERE tag = ?)' : '';
    const rows = this.db.prepare(
      `SELECT ci.path, ci.title, ci.mtime,
        snippet(content_fts, 1, '«', '»', '…', 12) AS snippet
        FROM content_index ci JOIN content_fts ON content_fts.path = ci.path
        WHERE content_fts MATCH ?${tagClause}
        ORDER BY rank LIMIT ? OFFSET ?`,
    ).all(...(tag ? [match, tag, cap, skip] : [match, cap, skip]));
    const total = this.db.prepare(
      `SELECT COUNT(*) AS c FROM content_index ci JOIN content_fts ON content_fts.path = ci.path
       WHERE content_fts MATCH ?${tagClause}`,
    ).all(...(tag ? [match, tag] : [match]));
    return { hits: rows.map((row) => ({ path: relOfIndexPath(row.path), title: row.title || path.basename(row.path), snippet: row.snippet || '', mtime: normalizeMtime(row.mtime) })), total: total[0]?.c ?? 0 };
  }

  /** wiki_links stores bare targets; resolve against the note's stem/title. */
  async backlinks(rel, title) {
    if (!(await this.available())) return [];
    const normalized = relOfDocId(rel);
    const targets = linkTargetsFor(normalized, title);
    const rows = this.db.prepare(
      `SELECT ci.path, ci.title FROM wiki_links l
       JOIN content_index ci ON ci.id = l.source_doc_id
       WHERE l.target IN (${targets.map(() => '?').join(',')})
       ORDER BY ci.mtime DESC LIMIT 100`,
    ).all(...targets);
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const sourceRel = relOfDocId(row.path ?? row.source_doc_id);
      if (sourceRel === normalized || seen.has(sourceRel)) continue;
      seen.add(sourceRel);
      out.push({ path: sourceRel, title: row.title || path.basename(sourceRel) });
    }
    return out;
  }

  /**
   * Unlinked mentions (plan §7): notes whose text says the note's stem/title
   * but carry no matching wiki_links row. FTS on the stem (≥3 chars) or a
   * LIKE scan; the wiki-links membership check filters true mentions.
   */
  async unlinkedMentions(rel, title) {
    if (!(await this.available())) return [];
    const normalized = relOfDocId(rel);
    const targets = linkTargetsFor(normalized, title);
    const linkedRows = this.db.prepare(
      'SELECT source_doc_id FROM wiki_links WHERE target IN (' + targets.map(() => '?').join(',') + ')',
    ).all(...targets);
    const linked = new Set(linkedRows.map((row) => relOfDocId(row.source_doc_id)));

    const candidates = new Map();
    const stem = path.basename(normalized, '.md');
    if (stem.length >= 3) {
      for (const target of targets) {
        if (target.length < 3) continue;
        const rows = this.db.prepare(
          `SELECT ci.path, ci.title FROM content_fts f
           JOIN content_index ci ON ci.path = f.path
           WHERE content_fts MATCH ? LIMIT 60`,
        ).all(ftsQuote(target));
        for (const row of rows) {
          const relPath = relOfIndexPath(row.path);
          if (relPath === normalized || linked.has(relPath)) continue;
          if (!candidates.has(relPath)) candidates.set(relPath, { path: relPath, title: row.title || path.basename(relPath) });
        }
      }
    } else {
      // Short stem (<3 chars): LIKE scan, capped.
      const like = '%' + stem.replace(/[%_]/g, '\\$&') + '%';
      const rows = this.db.prepare(
        `SELECT ci.path, ci.title FROM content_fts f
         JOIN content_index ci ON ci.path = f.path
         WHERE f.body LIKE ? ESCAPE '\\' LIMIT 40`,
      ).all(like);
      for (const row of rows) {
        const relPath = relOfIndexPath(row.path);
        if (relPath === normalized || linked.has(relPath)) continue;
        candidates.set(relPath, { path: relPath, title: row.title || path.basename(relPath) });
      }
    }
    return [...candidates.values()].slice(0, 40);
  }

  async tags() {
    if (!(await this.available())) return [];
    return this.db.prepare('SELECT tag, COUNT(*) AS count FROM doc_tags GROUP BY tag ORDER BY count DESC, tag').all()
      .map((row) => ({ tag: row.tag, count: row.count }));
  }

  /** Used by the service to verify index freshness vs disk (delta repair).
   * content_index stores times in microseconds → normalize to ms. */
  async docsMeta() {
    if (!(await this.available())) return [];
    return this.db.prepare(
      "SELECT path, mtime, size FROM content_index WHERE path LIKE 'vault/%'",
    ).all().map((row) => {
      const raw = Number(row.mtime ?? 0);
      const mtime = raw > 1e14 ? Math.round(raw / 1000) : Math.round(raw);
      return { path: relOfIndexPath(row.path), mtime, size: row.size ?? 0 };
    });
  }
}

/** Local fallback over the Vault cache with the same interface. */
export class LocalVaultIndex {
  constructor(vault) {
    this.vault = vault;
  }

  async available() { return true; }

  async search(query, { limit = 30 } = {}) {
    const results = await this.vault.search(query, limit);
    return { hits: results.map((hit) => ({ path: hit.path, title: hit.title, snippet: hit.excerpt ?? '', mtime: this.vault.cache()?.files?.[hit.path]?.mtimeMs ?? 0 })), total: results.length };
  }

  async backlinks(rel, title) {
    return this.vault.backlinks(rel, title);
  }

  async tags() {
    const files = this.vault.cache()?.files ?? {};
    const counts = new Map();
    for (const record of Object.values(files)) {
      for (const tag of record?.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  async docsMeta() {
    return Object.entries(this.vault.cache()?.files ?? {}).map(([rel, record]) => ({ path: rel, mtime: record.mtimeMs, size: record.size }));
  }
}

/**
 * Pick the backend for one vault root. Shared Droplets workspace → native
 * index at <workspace>/state/index.sqlite when it opens cleanly; anything
 * else → the local cache wrapper.
 */
export async function createVaultIndex(vault, workspaceRoot, logger) {
  if (workspaceRoot) {
    const native = new NativeVaultIndex(path.join(workspaceRoot, 'state', 'index.sqlite'), logger);
    if (await native.available()) return native;
  }
  return new LocalVaultIndex(vault);
}
