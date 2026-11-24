import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Loader2, RefreshCw, Search, Tag, X, GitBranch, CircleDot, Plus, FolderPlus, Pencil, Copy, Trash2, ArrowLeftRight, ArrowUp, Sparkles } from 'lucide-react';
import { t } from './i18n.js';
import { MarkdownView, Modal } from './components.jsx';
import { computeLayout } from './wiki-graph-layout.js';
import { PanelCollapseButton } from './feed/PanelGroup.jsx';
import { AuxRail } from './feed/AuxRail.jsx';
import { formatWhen } from './feed/format.js';

/**
 * The vault space, P0 of the Obsidian workbench plan:
 * tree(240, lazy) │ tabs + read view + AuxRail + backlinks/tags pane.
 * Edit stays source-level (textarea + sha lock) until P1 lands CM6.
 */

const TABS_KEY = 'droplets.vault.tabs';
const EXPANDED_KEY = 'droplets.vault.expanded';
const SIDEPANE_KEY = 'droplets.vault.sidepane';

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

/** Pure: list every ancestor dir path of a note (for autoreveal). */
export function ancestorsOf(path) {
  const segments = String(path ?? '').split('/');
  const dirs = [];
  // 'a/b/c.md' → ['a', 'a/b']: every prefix strictly before the file itself.
  for (let i = 1; i <= segments.length - 1; i += 1) {
    dirs.push(segments.slice(0, i).join('/'));
  }
  return dirs;
}

/** Pure: exact > prefix > substring filename ranking (dsh-notes-plugin parity). */
export function filterFiles(files, query, limit = 40) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return [];
  const ranked = [];
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (name === needle) ranked.push({ file, score: 0 });
    else if (name.startsWith(needle)) ranked.push({ file, score: 1 });
    else if (name.includes(needle)) ranked.push({ file, score: 2 });
  }
  ranked.sort((a, b) => a.score - b.score || a.file.name.localeCompare(b.file.name));
  return ranked.slice(0, limit).map((hit) => hit.file);
}

export function VaultView({ api, onMaterial }) {
  const [tabs, setTabs] = useState(() => loadJson(TABS_KEY, []));
  const [activeTabId, setActiveTabId] = useState(() => loadJson(TABS_KEY + '.active', null));
  const [expanded, setExpanded] = useState(() => new Set(loadJson(EXPANDED_KEY, [])));
  const [sidePane, setSidePane] = useState(() => loadJson(SIDEPANE_KEY, 'backlinks'));
  const [sideData, setSideData] = useState({ backlinks: [], unlinked: [], tags: [] });
  const [graph, setGraph] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [quick, setQuick] = useState(null); // { query }
  const [fileIndex, setFileIndex] = useState([]); // [{path, name}]
  const [conflict, setConflict] = useState(null);
  const [creating, setCreating] = useState(null); // { name, dir, kind: 'note'|'dir' }
  const [renaming, setRenaming] = useState(null); // { path, name }
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [stats, setStats] = useState({ files: 0 });
  const [sortKey, setSortKey] = useState('name');
  const [filter, setFilter] = useState('');
  const readerRef = useRef(null);
  const dirty = tabs.some((tab) => tab.dirty);

  // Persist tab/expand/sidePane state (restored when the panel is unmounted).
  useEffect(() => { saveJson(TABS_KEY, tabs); }, [tabs]);
  useEffect(() => { saveJson(TABS_KEY + '.active', activeTabId); }, [activeTabId]);
  useEffect(() => { saveJson(EXPANDED_KEY, [...expanded]); }, [expanded]);
  useEffect(() => { saveJson(SIDEPANE_KEY, sidePane); }, [sidePane]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  const refreshIndex = useCallback(async () => {
    try {
      const status = await api.vaultStatus();
      setStats({ files: status.files });
    } catch { /* surfaced elsewhere */ }
    try {
      const walk = async (dir, visiting) => {
        // Cycle/depth guard: a stub or symlink loop must not spin forever.
        if (visiting.has(dir) || visiting.size > 32) return [];
        visiting.add(dir);
        const { entries } = await api.vaultList(dir);
        const files = entries.filter((entry) => entry.kind === 'file');
        const dirs = entries.filter((entry) => entry.kind === 'dir');
        for (const child of dirs) files.push(...await walk(child.path, visiting));
        return files;
      };
      setFileIndex(await walk('', new Set()));
    } catch { /* offline tolerated: search falls back to tree filter */ }
  }, [api]);

  useEffect(() => { void refreshIndex(); }, [refreshIndex]);

  const openPath = useCallback(async (path, { forceNew = false } = {}) => {
    const existing = tabs.find((tab) => tab.path === path);
    if (existing && !forceNew) {
      setActiveTabId(existing.id);
      return;
    }
    setError('');
    try {
      const note = await api.vaultRead(path);
      const tab = {
        id: forceNew && existing ? `t-${Date.now()}` : path,
        path,
        name: path.split('/').pop(),
        content: note.content,
        draft: null, // null = clean, string = dirty buffer
        sha: note.sha,
        title: note.title,
        tags: note.tags ?? [],
        wordCount: note.wordCount ?? 0,
        savedAt: null,
      };
      setTabs((current) => {
        const base = forceNew && existing ? [...current] : current.filter((item) => item.path !== path || item.id === path);
        return [...base.filter((item) => item.id !== tab.id), tab];
      });
      setActiveTabId(tab.id);
      setGraph(null);
      setSearchResults(null);
      // autoreveal: expand ancestors of the opened note
      setExpanded((current) => {
        const next = new Set(current);
        for (const dir of ancestorsOf(path)) next.add(dir);
        return next;
      });
      onMaterial({ space: 'vault', path: note.path, title: note.title, content: note.content.slice(0, 60000) });
    } catch (cause) { setError(String(cause?.message ?? cause)); }
  }, [api, tabs, onMaterial]);

  // First visit: restore the persisted active tab, else empty state.
  useEffect(() => {
    if (activeTab?.content !== undefined || tabs.length === 0) return;
    const target = activeTab ?? tabs[0];
    if (target?.path) void openPath(target.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.length > 0]);

  const loadSideData = useCallback(async (path) => {
    try {
      const [links, tags] = await Promise.all([
        api.vaultBacklinks(path).catch(() => ({ backlinks: [] })),
        api.vaultTags().catch(() => ({ tags: [] })),
      ]);
      setSideData({ backlinks: links.backlinks ?? [], unlinked: [], tags: tags.tags ?? [] });
    } catch { /* pane degrades to empty */ }
  }, [api]);

  useEffect(() => {
    if (activeTab?.path) void loadSideData(activeTab.path);
  }, [activeTab?.path, loadSideData]);

  const setDraft = useCallback((tabId, draft) => {
    setTabs((current) => current.map((tab) => (tab.id === tabId ? { ...tab, draft } : tab)));
  }, []);

  const closeTab = useCallback(async (tabId) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (tab?.dirty) {
      const choice = window.confirm(`「${tab.name}」有未保存的修改。确定放弃并关闭吗？`);
      if (!choice) return;
    }
    setTabs((current) => {
      const next = current.filter((item) => item.id !== tabId);
      if (activeTabId === tabId) setActiveTabId(next[next.length - 1]?.id ?? null);
      return next;
    });
  }, [tabs, activeTabId]);

  /** Debounced autosave of the active dirty tab (plan §4.4). */
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!activeTab?.dirty) return undefined;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushSave(activeTab.id); }, 800);
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.draft, activeTab?.id]);

  const flushSave = useCallback(async (tabId, { force = false } = {}) => {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab?.dirty && !force) return;
    try {
      const result = await api.vaultWrite({ path: tab.path, content: tab.draft ?? tab.content, expectedSha: force ? undefined : tab.sha });
      if (result.conflict) {
        setConflict({ path: tab.path, currentSha: result.currentSha, currentExcerpt: result.currentExcerpt });
        return;
      }
      setTabs((current) => current.map((item) => (item.id === tabId ? {
        ...item,
        sha: result.sha,
        content: item.draft ?? item.content,
        draft: null,
        savedAt: new Date().toLocaleTimeString('zh-Hans-CN', { hour: '2-digit', minute: '2-digit' }),
      } : item)));
      setConflict(null);
    } catch (cause) {
      setError(String(cause?.message ?? cause));
    }
  }, [api]);

  // A ref mirror so timers/closures always see fresh tabs without re-binding.
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  const runSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (query === '') { setSearchResults(null); return; }
    try {
      const outcome = await api.vaultSearch({ query, limit: 50 });
      setSearchResults(outcome);
      if (outcome.backend === 'local') {
        onMaterial({
          space: 'vault-search',
          title: t('companion.askVaultTitle') + ' · ' + query,
          matches: outcome.results.map((item) => ({ path: item.path, title: item.title, excerpt: item.excerpt })),
          content: '',
        }, { reveal: true });
      }
    } catch (cause) { setError(String(cause?.message ?? cause)); }
  }, [api, searchQuery, onMaterial]);

  // ------- create / rename / duplicate / trash -------

  const submitCreate = useCallback(async () => {
    if (!creating) return;
    try {
      if (creating.kind === 'dir') {
        await api.vaultCreateDir({ dir: creating.path });
      } else {
        const name = creating.name.trim() || '未命名';
        const dir = creating.dir === '' ? '' : creating.dir;
        const path = (dir === '' ? name : `${dir}/${name}`) + '.md';
        await api.vaultWrite({ path, content: `---\ntitle: ${name}\ncreated: ${new Date().toISOString()}\n---\n\n# ${name}\n\n`, expectedSha: null, createOnly: true }).then(async (result) => {
          if (result.conflict) { setNotice(`已存在：${path}`); return null; }
          return path;
        }).then((created) => { if (created) void openPath(created); });
      }
      setCreating(null);
      await refreshIndex();
    } catch (cause) { setNotice(String(cause?.message ?? cause)); }
  }, [creating, api, refreshIndex, openPath]);

  const submitRename = useCallback(async (nextPath) => {
    if (!renaming) return;
    try {
      const result = await api.vaultRename({ from: renaming.path, to: nextPath, updateLinks: true });
      setNotice(`已重命名${result.updatedLinks > 0 ? `，更新 ${result.updatedLinks} 处链接` : ''}`);
      setRenaming(null);
      // Retarget any open tab of the old path.
      setTabs((current) => current.map((tab) => (tab.path === renaming.path ? { ...tab, path: result.path, name: result.path.split('/').pop(), id: result.path } : tab)));
      if (activeTabId === renaming.path) setActiveTabId(result.path);
      await refreshIndex();
    } catch (cause) { setNotice(String(cause?.message ?? cause)); }
  }, [renaming, api, refreshIndex, activeTabId]);

  const trashPath = useCallback(async (path, name) => {
    if (!window.confirm(`把「${name}」移入回收站？可在 Droplets 回收站恢复。`)) return;
    try {
      await api.vaultDelete({ path });
      setTabs((current) => current.filter((tab) => tab.path !== path));
      setNotice('已移入回收站');
      await refreshIndex();
    } catch (cause) { setNotice(String(cause?.message ?? cause)); }
  }, [api, refreshIndex]);

  const duplicatePath = useCallback(async (path) => {
    try {
      const result = await api.vaultDuplicate({ path });
      setNotice('已创建副本');
      await refreshIndex();
      void openPath(result.path);
    } catch (cause) { setNotice(String(cause?.message ?? cause)); }
  }, [api, refreshIndex, openPath]);

  // ------- render -------

  const activeDirty = Boolean(activeTab?.dirty);
  const headings = useMemo(() => markdownHeadings(activeTab?.content ?? ''), [activeTab?.content]);

  const filteredIndex = useMemo(
    () => (filter.trim() === '' ? [] : filterFiles(fileIndex, filter, 30)),
    [filter, fileIndex],
  );

  const quickResults = useMemo(
    () => (quick && quick.query.trim() !== '' ? filterFiles(fileIndex, quick.query, 20) : []),
    [quick, fileIndex],
  );

  const graphLayout = useMemo(
    () => (graph ? computeLayout(graph, 900, 620) : null),
    [graph],
  );

  const captured = useRef(false);
  const captureSelection = () => {
    if (captured.current) return;
    const selection = String(window.getSelection?.() ?? '').trim();
    captured.current = true;
    setTimeout(() => { captured.current = false; }, 400);
    if (!activeTab || selection === '') return;
    onMaterial({ space: 'vault', path: activeTab.path, title: activeTab.title, selection, content: '' });
  };

  if (stats.files === 0 && fileIndex.length === 0) {
    // First paint while the index warms up.
    return (
      <div className="dpl-vault-empty">
        <Loader2 size={16} className="dpl-spin" />
        <p>{t('vault.noVault')}</p>
        <p className="dpl-hint">{t('vault.chooseVault')}</p>
      </div>
    );
  }

  return (
    <div className="dpl-vault2">
      <aside className="dpl-col dpl-vault2-tree">
        <div className="dpl-ib-panehead">
          <span className="dpl-ib-pansub">{t('vault.tree')}</span>
          <div className="dpl-vault2-treeactions">
            <button type="button" className="dpl-icon-btn" title="新建笔记" onClick={() => setCreating({ kind: 'note', name: '', dir: activeTab ? ancestorsOf(activeTab.path)[0] ?? '' : '' })}><Plus size={14} /></button>
            <button type="button" className="dpl-icon-btn" title="新建文件夹" onClick={() => setCreating({ kind: 'dir', name: '', dir: activeTab ? ancestorsOf(activeTab.path)[0] ?? '' : '' })}><FolderPlus size={14} /></button>
            <button type="button" className="dpl-icon-btn" title="重扫索引" onClick={() => void api.vaultReindex().then(refreshIndex)}><RefreshCw size={13} /></button>
            <PanelCollapseButton />
          </div>
        </div>
        <div className="dpl-vault2-filter">
          <Search size={13} />
          <input placeholder="过滤文件名…" value={filter} onChange={(event) => setFilter(event.target.value)} />
          {filter !== '' ? <button type="button" onClick={() => setFilter('')} aria-label="清除过滤"><X size={12} /></button> : null}
        </div>
        <div className="dpl-vault2-treescroll">
          {filter.trim() !== '' ? (
            <div className="dpl-vault2-flatlist">
              {filteredIndex.map((file) => (
                <button key={file.path} type="button" className={'dpl-vault2-file' + (activeTab?.path === file.path ? ' is-active' : '')} onClick={() => void openPath(file.path)}>
                  <FileText size={13} />
                  <span className="dpl-truncate">{file.name.replace(/\.md$/i, '')}</span>
                  <span className="dpl-vault2-filedir">{file.path.split('/').slice(0, -1).join('/')}</span>
                </button>
              ))}
              {filteredIndex.length === 0 ? <div className="dpl-vault2-empty">无匹配文件</div> : null}
            </div>
          ) : (
            <TreePane
              api={api}
              expanded={expanded}
              setExpanded={setExpanded}
              activePath={activeTab?.path}
              sortKey={sortKey}
              onOpen={(path) => void openPath(path)}
              onRename={(path) => setRenaming({ path, name: path.split('/').pop() })}
              onDuplicate={(path) => void duplicatePath(path)}
              onTrash={trashPath}
              onNewNote={(dir) => setCreating({ kind: 'note', name: '', dir })}
              onNewDir={(dir) => setCreating({ kind: 'dir', name: '', dir })}
            />
          )}
        </div>
        <div className="dpl-vault2-sidepane">
          <div className="dpl-vault2-sidetabs">
            <button type="button" className={sidePane === 'backlinks' ? 'is-active' : ''} onClick={() => setSidePane('backlinks')}>反链</button>
            <button type="button" className={sidePane === 'tags' ? 'is-active' : ''} onClick={() => setSidePane('tags')}>标签</button>
          </div>
          {sidePane === 'backlinks' ? (
            <div className="dpl-vault2-sidebody">
              {activeTab ? (
                sideData.backlinks.length > 0 ? sideData.backlinks.map((item) => (
                  <button key={item.path} type="button" className="dpl-vault2-backlink" onClick={() => void openPath(item.path)}>
                    <span className="dpl-truncate">{item.title}</span>
                    <span className="dpl-vault2-filedir">{item.path}</span>
                  </button>
                )) : <div className="dpl-vault2-empty">暂无反链</div>
              ) : <div className="dpl-vault2-empty">先打开一篇笔记</div>}
            </div>
          ) : (
            <div className="dpl-vault2-sidebody dpl-vault2-tags">
              {sideData.tags.slice(0, 80).map((item) => (
                <button
                  key={item.tag} type="button"
                  onClick={() => { setSearchQuery(item.tag); setSearchOpen(true); void api.vaultSearch({ query: item.tag, limit: 50, tag: item.tag }).then(setSearchResults).catch(() => {}); }}
                >
                  #{item.tag} <span>{item.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      <section className="dpl-col dpl-vault2-main">
        <div className="dpl-vault2-tabstrip">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={'dpl-vault2-tab' + (tab.id === activeTabId ? ' is-active' : '') + (tab.dirty ? ' is-dirty' : '')}
              onClick={() => setActiveTabId(tab.id)}
              onAuxClick={(event) => { if (event.button === 1) void closeTab(tab.id); }}
              title={tab.path}
            >
              <FileText size={12} />
              <span className="dpl-truncate">{tab.name.replace(/\.md$/i, '')}</span>
              <button
                type="button" className="dpl-vault2-tabclose" aria-label="关闭"
                onClick={(event) => { event.stopPropagation(); void closeTab(tab.id); }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <div className="dpl-vault2-tabspring" />
          <button type="button" className="dpl-icon-btn" title="全库搜索 (⌘⇧F)" onClick={() => setSearchOpen(!searchOpen)}><Search size={14} /></button>
          <button type="button" className={'dpl-icon-btn' + (graph ? ' is-toggled' : '')} title="图谱" onClick={() => void toggleGraph()}><CircleDot size={14} /></button>
        </div>

        {searchOpen ? (
          <div className="dpl-vault2-searchbar">
            <Search size={13} />
            <input
              autoFocus placeholder="全文检索（≥3 字；2 字走模糊）…" value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); if (event.key === 'Escape') setSearchOpen(false); }}
            />
            <button type="button" className="dpl-btn dpl-sm" onClick={() => void runSearch()}>搜索</button>
            {searchResults ? <span className="dpl-vault2-searchcount">{searchResults.total} 条 · {searchResults.backend === 'native' ? '全文索引' : '本地索引'}</span> : null}
            <button type="button" className="dpl-icon-btn" onClick={() => { setSearchOpen(false); setSearchResults(null); }} aria-label="关闭搜索"><X size={13} /></button>
          </div>
        ) : null}

        <div className="dpl-vault2-content" onMouseUp={captureSelection}>
          {graph ? (
            <GraphPane graph={graph} layout={graphLayout} onOpen={(path) => { setGraph(null); void openPath(path); }} onClose={() => setGraph(null)} />
          ) : searchResults ? (
            <div className="dpl-vault2-searchresults">
              {searchResults.results.map((hit) => (
                <button key={hit.path} type="button" className="dpl-vault2-hit" onClick={() => void openPath(hit.path)}>
                  <strong>{hit.title}</strong>
                  <span className="dpl-vault2-filedir">{hit.path}</span>
                  {hit.excerpt ? <p>{hit.excerpt}</p> : null}
                </button>
              ))}
              {searchResults.results.length === 0 ? <div className="dpl-vault2-empty">无结果</div> : null}
            </div>
          ) : activeTab ? (
            <NoteReadPane
              key={activeTab.id}
              tab={activeTab}
              onDraft={(draft) => setDraft(activeTab.id, draft)}
              onSave={() => void flushSave(activeTab.id)}
              onDiscard={() => setDraft(activeTab.id, null)}
              onWikilink={(target) => {
                const wanted = String(target).replace(/\.md$/i, '').replace(/^\.?\//, '');
                const hit = fileIndex.find((file) => file.path === `${wanted}.md`)
                  ?? fileIndex.find((file) => file.path.replace(/\.md$/i, '').endsWith('/' + wanted) || file.path.replace(/\.md$/i, '') === wanted);
                if (hit) void openPath(hit.path);
                else void openPath((activeTab.path.split('/').slice(0, -1).join('/') === '' ? '' : activeTab.path.split('/').slice(0, -1).join('/') + '/') + wanted + '.md');
              }}
              onMaterial={onMaterial}
              readerRef={readerRef}
            />
          ) : (
            <div className="dpl-vault2-empty dpl-vault2-readerempty">在左侧选择一篇笔记开始阅读</div>
          )}
        </div>

        <div className="dpl-vault2-statusbar">
          <span>{activeTab ? `${activeTab.wordCount.toLocaleString()} 字` : `${stats.files} 篇笔记`}</span>
          <span>{activeTab?.dirty ? '未保存' : activeTab?.savedAt ? `已保存 ${activeTab.savedAt}` : ''}</span>
          <button type="button" className="dpl-vault2-statuslink" onClick={() => setSidePane('backlinks')}>{sideData.backlinks.length} 反链</button>
          {notice ? <span className="dpl-vault2-statusnotice">{notice}<button type="button" onClick={() => setNotice('')}><X size={11} /></button></span> : null}
          {error ? <span className="dpl-vault2-statuserror">{error}<button type="button" onClick={() => setError('')}><X size={11} /></button></span> : null}
        </div>
      </section>

      {/* 右缘大纲：只在 read 面存在时 */}
      {activeTab && !graph && !searchResults ? (
        <AuxRail
          headings={headings}
          containerRef={readerRef}
          onAskAi={() => {
            if (!activeTab) return;
            onMaterial({ space: 'vault', path: activeTab.path, title: activeTab.title, content: (activeTab.draft ?? activeTab.content).slice(0, 60000) }, { reveal: true });
          }}
        />
      ) : null}

      {quick ? (
        <div className="dpl-vault2-scrim" onClick={() => setQuick(null)}>
          <div className="dpl-vault2-quick" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus placeholder="快速切换：输入文件名…" value={quick.query}
              onChange={(event) => setQuick({ query: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuick(null);
                if (event.key === 'Enter' && quickResults[0]) { setQuick(null); void openPath(quickResults[0].path); }
              }}
            />
            <div className="dpl-vault2-quicklist">
              {quickResults.map((file, index) => (
                <button
                  key={file.path} type="button"
                  className={index === 0 ? 'is-first' : ''}
                  onClick={() => { setQuick(null); void openPath(file.path); }}
                >
                  <span className="dpl-truncate">{file.name.replace(/\.md$/i, '')}</span>
                  <span className="dpl-vault2-filedir">{file.path}</span>
                </button>
              ))}
              {quick && quick.query.trim() !== '' && quickResults.length === 0 ? <div className="dpl-vault2-empty">无匹配</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {conflict ? (
        <Modal title="保存冲突" onClose={() => setConflict(null)}>
          <p>磁盘上的文件已被其他程序修改（可能是 Droplets 桌面端或 Agent）。</p>
          {conflict.currentExcerpt ? <blockquote className="dpl-conflict-excerpt">{conflict.currentExcerpt}</blockquote> : null}
          <div className="dpl-form-row">
            <button type="button" className="dpl-btn" onClick={() => { const path = conflict.path; setConflict(null); void openPath(path); }}>重载</button>
            <button type="button" className="dpl-btn is-danger" onClick={() => { setConflict(null); void flushSave(activeTabId, { force: true }); }}>覆盖保存</button>
          </div>
        </Modal>
      ) : null}

      {creating ? (
        <Modal title={creating.kind === 'dir' ? '新建文件夹' : '新建笔记'} onClose={() => setCreating(null)}>
          <div className="dpl-form-col">
            <div className="dpl-field">
              <span>位置</span>
              <input value={creating.dir === '' ? '(vault 根)' : creating.dir} readOnly />
            </div>
            <div className="dpl-field">
              <span>名称</span>
              <input
                autoFocus value={creating.name}
                onChange={(event) => setCreating({ ...creating, name: event.target.value })}
                onKeyDown={(event) => { if (event.key === 'Enter') void submitCreate(); }}
              />
            </div>
          </div>
          <div className="dpl-form-row dpl-end">
            <button type="button" className="dpl-btn" onClick={() => setCreating(null)}>取消</button>
            <button type="button" className="dpl-btn is-primary" onClick={() => void submitCreate()}>创建</button>
          </div>
        </Modal>
      ) : null}

      {renaming ? (
        <Modal title="重命名（自动更新链接）" onClose={() => setRenaming(null)}>
          <div className="dpl-form-col">
            <div className="dpl-field">
              <span>新路径</span>
              <input
                autoFocus value={renaming.name}
                onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    const dir = renaming.path.split('/').slice(0, -1).join('/');
                    void submitRename((dir === '' ? renaming.name : `${dir}/${renaming.name}`));
                  }
                }}
              />
            </div>
            <p className="dpl-hint">改名后将全库更新指向它的 [[链接]]。</p>
          </div>
          <div className="dpl-form-row dpl-end">
            <button type="button" className="dpl-btn" onClick={() => setRenaming(null)}>取消</button>
            <button
              type="button" className="dpl-btn is-primary"
              onClick={() => {
                const dir = renaming.path.split('/').slice(0, -1).join('/');
                void submitRename((dir === '' ? renaming.name : `${dir}/${renaming.name}`));
              }}
            >重命名</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );

  async function toggleGraph() {
    if (graph) { setGraph(null); return; }
    try {
      setGraph(await api.vaultGraph());
    } catch (cause) { setError(String(cause?.message ?? cause)); }
  }
}

/** h2–h6 outline from markdown source (vault parses deeper than feed/inbox). */
function markdownHeadings(content) {
  const out = [];
  let inFence = false;
  for (const line of String(content ?? '').split('\n')) {
    if (/^\s*(```+|~~~+)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = line.match(/^#{2,6}\s+(.+?)\s*#*$/);
    if (match) out.push({ level: match[0].match(/^#+/)[0].length, text: match[1].trim() });
  }
  return out;
}

/** Lazy tree: directories load on expand; state stays in the parent. */
function TreePane({ api, expanded, setExpanded, activePath, sortKey, onOpen, onRename, onDuplicate, onTrash, onNewNote, onNewDir }) {
  const [roots, setRoots] = useState(null); // entries at one level, keyed by dir
  const load = useCallback(async (dir) => {
    const { entries } = await api.vaultList(dir);
    setRoots((current) => ({ ...current, [dir]: entries }));
  }, [api]);

  useEffect(() => { void load(''); }, [load]);

  const toggle = (dir) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
    if (!expanded.has(dir)) void load(dir);
  };

  if (!roots || !roots['']) {
    return <div className="dpl-vault2-empty"><Loader2 size={14} className="dpl-spin" /> 加载中…</div>;
  }

  const renderEntries = (entries, dir) => {
    const dirs = entries.filter((entry) => entry.kind === 'dir');
    const files = entries.filter((entry) => entry.kind === 'file');
    const sort = (list, key) => (key === 'mtime'
      ? [...list].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
      : [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')));
    return (
      <>
        {sort(dirs, sortKey).map((entry) => (
          <div key={entry.path}>
            <div className={'dpl-vault2-row' + (expanded.has(entry.path) ? ' is-open' : '')}>
              <button type="button" className="dpl-vault2-dir" onClick={() => toggle(entry.path)}>
                <span className="dpl-vault2-chevron">{expanded.has(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                {expanded.has(entry.path) ? <FolderOpen size={13} /> : <Folder size={13} />}
                <span className="dpl-truncate">{entry.name}</span>
              </button>
              <div className="dpl-vault2-rowactions">
                <button type="button" title="新建笔记" onClick={(event) => { event.stopPropagation(); onNewNote(entry.path); }}><Plus size={12} /></button>
                <button type="button" title="重命名" onClick={(event) => { event.stopPropagation(); onRename(entry.path); }}><Pencil size={11} /></button>
                <button type="button" title="删除" onClick={(event) => { event.stopPropagation(); onTrash(entry.path, entry.name); }}><Trash2 size={11} /></button>
              </div>
            </div>
            {expanded.has(entry.path) ? (
              <div className="dpl-vault2-children">
                {roots[entry.path]
                  ? renderEntries(roots[entry.path], entry.path)
                  : <div className="dpl-vault2-loading"><Loader2 size={11} className="dpl-spin" /></div>}
              </div>
            ) : null}
          </div>
        ))}
        {sort(files, sortKey).map((entry) => (
          <div key={entry.path} className={'dpl-vault2-row' + (activePath === entry.path ? ' is-active' : '')}>
            <button type="button" className="dpl-vault2-file" onClick={() => onOpen(entry.path)}>
              <FileText size={13} />
              <span className="dpl-truncate">{entry.name.replace(/\.md$/i, '')}</span>
              {sortKey === 'mtime' && entry.mtime ? <span className="dpl-vault2-filemtime">{formatWhen(entry.mtime)}</span> : null}
            </button>
            <div className="dpl-vault2-rowactions">
              <button type="button" title="重命名" onClick={(event) => { event.stopPropagation(); onRename(entry.path); }}><Pencil size={11} /></button>
              <button type="button" title="创建副本" onClick={(event) => { event.stopPropagation(); onDuplicate(entry.path); }}><Copy size={11} /></button>
              <button type="button" title="移入回收站" onClick={(event) => { event.stopPropagation(); onTrash(entry.path, entry.name); }}><Trash2 size={11} /></button>
            </div>
          </div>
        ))}
      </>
    );
  };

  return (
    <div className="dpl-vault2-treeroot">
      <div className="dpl-vault2-sortrow">
        <span className="dpl-ib-pansub">排序</span>
        <button type="button" className={'dpl-vault2-sortbtn' + (sortKey === 'name' ? ' is-active' : '')} onClick={() => {}}>名称</button>
        <button type="button" className={'dpl-vault2-sortbtn' + (sortKey === 'mtime' ? ' is-active' : '')} onClick={() => {}}>时间</button>
      </div>
      {renderEntries(roots[''], '')}
      <div className="dpl-vault2-treefoot">
        <button type="button" className="dpl-vault2-footbtn" onClick={() => onNewNote('')}><Plus size={12} /> 根笔记</button>
        <button type="button" className="dpl-vault2-footbtn" onClick={() => onNewDir('')}><FolderPlus size={12} /> 根文件夹</button>
      </div>
    </div>
  );
}

/** Read view of one tab: rendered markdown + wikilink click + dirty editing. */
function NoteReadPane({ tab, onDraft, onSave, onDiscard, onWikilink, onMaterial, readerRef }) {
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  useEffect(() => { editingRef.current = editing; }, [editing]);

  const dirty = tab.dirty !== null && tab.dirty !== undefined;
  const text = dirty ? tab.draft : tab.content;

  return (
    <div className="dpl-vault2-note">
      <div className="dpl-vault2-notehead">
        <h1>{tab.title}</h1>
        <div className="dpl-vault2-noteactions">
          <button type="button" className="dpl-btn dpl-sm" onClick={() => setEditing(!editing)}>{editing ? '预览' : '编辑'}</button>
          {dirty ? (
            <>
              <button type="button" className="dpl-btn dpl-sm dpl-primary-solid" onClick={onSave}>保存</button>
              <button type="button" className="dpl-btn dpl-sm" onClick={onDiscard}>放弃修改</button>
            </>
          ) : null}
        </div>
      </div>
      <div className="dpl-vault2-notemeta">{tab.path}{tab.tags.length > 0 ? ' · ' + tab.tags.map((tag) => '#' + tag).join(' ') : ''}</div>
      {editing ? (
        <textarea
          className="dpl-vault2-editor"
          value={text}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); onSave(); }
          }}
          spellCheck={false}
          data-testid="vault-editor"
        />
      ) : (
        <div ref={readerRef} className="dpl-vault2-readerscroll">
          <MarkdownView className="dpl-note-body dpl-vault2-body" markdown={text} onWikilink={onWikilink} />
          <div className="dpl-vault2-bodyend" />
        </div>
      )}
    </div>
  );
}

function GraphPane({ graph, layout, onOpen, onClose }) {
  const width = 900;
  const height = 620;
  const [hover, setHover] = useState(null);
  return (
    <div className="dpl-graph">
      <div className="dpl-vault2-graphhead">
        <span>{graph.nodes.length} 节点 · {graph.edges.length} 边</span>
        <button type="button" className="dpl-icon-btn" onClick={onClose} aria-label="关闭图谱"><X size={13} /></button>
      </div>
      <svg viewBox={'0 0 ' + width + ' ' + height} role="img">
        {graph.edges.map((edge, index) => {
          const from = layout.get(edge.source);
          const to = layout.get(edge.target);
          if (!from || !to) return null;
          return <line key={index} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="dpl-graph-edge" />;
        })}
        {graph.nodes.map((node) => {
          const at = layout.get(node.id);
          if (!at) return null;
          const degree = graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id).length;
          const radius = node.dangling ? 3 : 4 + 1.6 * Math.sqrt(degree);
          return (
            <circle
              key={node.id}
              cx={at.x} cy={at.y} r={radius}
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
      {hover ? <div className="dpl-graph-label">{graph.nodes.find((node) => node.id === hover)?.title}</div> : null}
    </div>
  );
}
