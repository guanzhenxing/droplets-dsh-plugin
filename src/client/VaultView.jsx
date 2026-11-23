import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n.js';
import { MarkdownView, Modal, formatDate } from './components.jsx';
import { computeLayout } from './wiki-graph-layout.js';

/**
 * The vault space: file tree (240) / content (read or source-level edit) +
 * companion. Wikilinks are clickable; unresolved targets prompt creation.
 * Saves carry baseSha — a conflict offers reload / overwrite / save-as.
 * The graph view ports droplets' d3-force layout.
 *
 * @param {{api:object, onMaterial:function}} props
 */
export function VaultView({ api, onMaterial }) {
  const [tree, setTree] = useState(null);
  const [stats, setStats] = useState({ files: 0, builtAt: 0, root: '' });
  const [note, setNote] = useState(null); // { path, content, sha, title, tags, wordCount }
  const [mode, setMode] = useState('read');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState(null);
  const [backlinks, setBacklinks] = useState([]);
  const [graph, setGraph] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [creating, setCreating] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const readerRef = useRef(null);

  const loadTree = useCallback(async () => {
    try {
      const outcome = await api.vaultTree();
      setTree(outcome.tree);
      setStats(outcome.stats);
    } catch (cause) { setError(String(cause?.message ?? cause)); }
  }, [api]);

  useEffect(() => { void loadTree(); }, [loadTree]);

  const flatFiles = useMemo(() => {
    const files = [];
    const walk = (node) => {
      for (const file of node.files) files.push(file);
      for (const dir of node.dirs) walk(dir);
    };
    if (tree) walk(tree);
    return files;
  }, [tree]);

  async function openNote(path) {
    setError('');
    setResults(null);
    setGraph(null);
    try {
      const result = await api.vaultRead(path);
      setNote(result);
      setDraft(result.content);
      setMode('read');
      setBacklinks([]);
      onMaterial({ space: 'vault', path: result.path, title: result.title, content: result.content.slice(0, 60000) });
      void api.vaultBacklinks(result.path).then(({ backlinks: links }) => setBacklinks(links)).catch(() => {});
    } catch (cause) { setError(String(cause?.message ?? cause)); }
  }

  async function save(overwrite = false, saveAsPath) {
    if (!note) return;
    setBusy(true);
    setError('');
    try {
      const target = saveAsPath ?? note.path;
      const result = await api.vaultWrite({
        path: target,
        content: draft,
        expectedSha: overwrite ? undefined : note.sha,
      });
      if (result.conflict) {
        setConflict({ path: result.path, currentSha: result.currentSha, currentExcerpt: result.currentExcerpt });
        return;
      }
      setConflict(null);
      setNote({ ...note, path: result.path, sha: result.sha, content: draft });
      setMode('read');
      await loadTree();
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  async function runSearch() {
    const query = search.trim();
    if (query === '') { clearSearch(); return; }
    setBusy(true);
    try {
      const { results: found } = await api.vaultSearch({ query, limit: 30 });
      setResults(found);
      onMaterial({
        space: 'vault-search',
        title: t('companion.askVaultTitle') + ' · ' + query,
        matches: found.map((item) => ({ path: item.path, title: item.title, excerpt: item.excerpt })),
        content: '',
      });
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  function clearSearch() {
    setSearch('');
    setResults(null);
    setGraph(null);
  }

  async function openGraph() {
    setBusy(true);
    try {
      const data = await api.vaultGraph();
      setGraph(data);
      setResults(null);
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  function resolveTarget(target) {
    const wanted = String(target).replace(/\.md$/i, '').replace(/^\.?\//, '');
    const exact = flatFiles.find((file) => file.path === wanted + '.md');
    if (exact) return exact.path;
    const suffix = flatFiles.filter((file) => file.path.replace(/\.md$/i, '').endsWith('/' + wanted) || file.path.replace(/\.md$/i, '') === wanted);
    return suffix[0]?.path;
  }

  function onWikilink(target) {
    const resolved = resolveTarget(target);
    if (resolved) { void openNote(resolved); return; }
    setCreating({ name: String(target), path: suggestPath(target) });
  }

  function suggestPath(target) {
    const base = String(target).split('/').pop().replace(/\.md$/i, '');
    return (note?.path ? note.path.replace(/[^/]*$/, '') : '0-Inbox/') + base + '.md';
  }

  async function createNote() {
    if (!creating) return;
    const template = '---\ntitle: ' + creating.name + '\ncreated: ' + new Date().toISOString().slice(0, 10) + '\n---\n\n# ' + creating.name + '\n\n';
    try {
      const result = await api.vaultWrite({ path: creating.path, content: template, expectedSha: null });
      if (result.conflict) { setError('笔记已存在：' + creating.path); setCreating(null); return; }
      setCreating(null);
      await loadTree();
      await openNote(result.path);
    } catch (cause) { setError(String(cause?.message ?? cause)); }
  }

  function captureSelection() {
    const selection = String(window.getSelection?.() ?? '').trim();
    if (!note || selection === '') return;
    onMaterial({ space: 'vault', path: note.path, title: note.title, selection, content: '' });
  }

  if (!tree) {
    return (
      <div className="dpl-vault-empty">
        <p>{t('vault.noVault')}</p>
        <p className="dpl-hint">{t('vault.chooseVault')}</p>
      </div>
    );
  }

  return (
    <div className="dpl-vault">
      <aside className="dpl-col dpl-vault-tree" aria-label={t('vault.tree')}>
        <div className="dpl-search">
          <input
            type="search"
            placeholder={t('common.searchPlaceholder')}
            value={search}
            onChange={(event) => { setSearch(event.target.value); if (event.target.value.trim() === '') clearSearch(); }}
            onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }}
          />
        </div>
        <div className="dpl-col-head">
          <span className="dpl-tree-stats">{stats.files} {t('vault.files')}</span>
          <button type="button" className="dpl-icon-btn" title={t('vault.graph')} onClick={() => (graph ? setGraph(null) : void openGraph())}>◉</button>
          <button type="button" className="dpl-icon-btn" title={t('vault.createNote')} onClick={() => setCreating({ name: '', path: '0-Inbox/未命名.md' })}>＋</button>
        </div>
        {tree && <Tree node={tree} activePath={note?.path} onOpen={(path) => void openNote(path)} />}
      </aside>

      <section className="dpl-reader dpl-vault-reader" onMouseUp={captureSelection}>
        {graph && <GraphView graph={graph} onOpen={(path) => { setGraph(null); void openNote(path); }} />}
        {results && (
          <div className="dpl-search-results">
            <h2>
              {t('common.search')} · {results.length}
              <button type="button" className="dpl-btn dpl-sm" onClick={clearSearch}>{t('vault.clearSearch')}</button>
            </h2>
            <ul>
              {results.map((item) => (
                <li key={item.path}>
                  <button type="button" onClick={() => void openNote(item.path)}>
                    <strong>{item.title}</strong>
                    <span className="dpl-entry-meta">{item.path} · {item.match}</span>
                    {item.excerpt ? <p>{item.excerpt}</p> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!graph && !results && !note && <div className="dpl-empty dpl-reader-empty">{tree ? t('vault.tree') : t('common.loading')}</div>}
        {!graph && !results && note && (
          <article className="dpl-note" ref={readerRef}>
            <header className="dpl-reader-toolbar">
              <div>
                <h1>{note.title}</h1>
                <span className="dpl-entry-meta">{note.path} · {t('vault.wordCount', { count: note.wordCount })}{note.tags?.length ? ' · ' + note.tags.map((tag) => '#' + tag).join(' ') : ''}</span>
              </div>
              <div className="dpl-reader-actions">
                {mode === 'read' ? (
                  <button type="button" className="dpl-btn" onClick={() => setMode('edit')}>{t('vault.edit')}</button>
                ) : (
                  <>
                    <button type="button" className="dpl-btn" disabled={busy} onClick={() => void save(false)}>{t('common.save')}</button>
                    <button type="button" className="dpl-btn" onClick={() => { setDraft(note.content); setMode('read'); }}>{t('common.cancel')}</button>
                  </>
                )}
              </div>
            </header>
            {mode === 'read' ? (
              <>
                <MarkdownView className="dpl-note-body" markdown={note.content} onWikilink={onWikilink} />
                {backlinks.length > 0 && (
                  <section className="dpl-backlinks">
                    <h2>{t('vault.backlinks')} · {backlinks.length}</h2>
                    <ul>
                      {backlinks.map((item) => (
                        <li key={item.path}>
                          <button type="button" onClick={() => void openNote(item.path)}>{item.title}<span className="dpl-entry-meta"> · {item.path}</span></button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            ) : (
              <textarea
                className="dpl-note-editor"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck={false}
              />
            )}
          </article>
        )}
        {error && <div className="dpl-error" role="alert">{error}</div>}
      </section>

      {conflict && (
        <Modal title={t('vault.conflictTitle')} onClose={() => setConflict(null)}>
          <p>{t('vault.conflictBody')}</p>
          {conflict.currentExcerpt ? <blockquote className="dpl-conflict-excerpt">{conflict.currentExcerpt}</blockquote> : null}
          <div className="dpl-form-row">
            <button type="button" className="dpl-btn" onClick={async () => { setConflict(null); await openNote(conflict.path); }}>{t('vault.reload')}</button>
            <button type="button" className="dpl-btn" onClick={() => { setConflict(null); void save(true); }}>{t('vault.overwrite')}</button>
            <button type="button" className="dpl-btn" onClick={async () => {
              const next = window.prompt(t('vault.saveAs'), conflict.path.replace(/\.md$/i, '-copy.md'));
              setConflict(null);
              if (next) await save(true, next);
            }}>{t('vault.saveAs')}</button>
          </div>
        </Modal>
      )}
      {creating && (
        <Modal title={t('vault.createNote')} onClose={() => setCreating(null)}>
          <div className="dpl-form-row">
            <input
              placeholder={t('vault.noteName')}
              value={creating.name}
              onChange={(event) => setCreating({ ...creating, name: event.target.value, path: suggestPath(event.target.value || '未命名') })}
            />
            <input
              value={creating.path}
              onChange={(event) => setCreating({ ...creating, path: event.target.value })}
            />
            <button type="button" className="dpl-btn" disabled={creating.name.trim() === '' || !creating.path.endsWith('.md')} onClick={() => void createNote()}>{t('vault.create')}</button>
          </div>
          {creating.name.trim() !== '' && !resolveTarget(creating.name) ? <p className="dpl-hint">{t('vault.clickToCreate')}</p> : null}
        </Modal>
      )}
    </div>
  );
}

function Tree({ node, activePath, onOpen, depth = 0 }) {
  return (
    <div className="dpl-tree" style={{ '--dpl-depth': depth }}>
      {node.dirs.map((dir) => (
        <details key={dir.name} open={depth < 1}>
          <summary>{dir.name}</summary>
          <Tree node={dir} activePath={activePath} onOpen={onOpen} depth={depth + 1} />
        </details>
      ))}
      {node.files.map((file) => (
        <button
          type="button"
          key={file.path}
          className={'dpl-tree-file' + (activePath === file.path ? ' is-active' : '')}
          onClick={() => onOpen(file.path)}
        >
          <span>{file.title}</span>
        </button>
      ))}
    </div>
  );
}

function GraphView({ graph, onOpen }) {
  const width = 900;
  const height = 620;
  const positions = useMemo(() => computeLayout(graph, width, height), [graph]);
  const [hover, setHover] = useState(null);
  return (
    <div className="dpl-graph" aria-label={t('vault.graph')}>
      <svg viewBox={'0 0 ' + width + ' ' + height} role="img">
        {graph.edges.map((edge, index) => {
          const from = positions.get(edge.source);
          const to = positions.get(edge.target);
          if (!from || !to) return null;
          return <line key={index} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="dpl-graph-edge" />;
        })}
        {graph.nodes.map((node) => {
          const at = positions.get(node.id);
          if (!at) return null;
          const degree = graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id).length;
          const radius = node.dangling ? 3 : 4 + 1.6 * Math.sqrt(degree);
          return (
            <circle
              key={node.id}
              cx={at.x}
              cy={at.y}
              r={radius}
              className={'dpl-graph-node' + (node.dangling ? ' is-dangling' : '') + (hover === node.id ? ' is-hover' : '')}
              onMouseEnter={() => setHover(node.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => { if (!node.dangling) onOpen(node.id); }}
            >
              <title>{node.title}</title>
            </circle>
          );
        })}
      </svg>
      {hover && <div className="dpl-graph-label">{graph.nodes.find((node) => node.id === hover)?.title}</div>}
    </div>
  );
}
