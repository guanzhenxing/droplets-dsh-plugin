import { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import {
  ArrowLeftRight, ArrowUpDown, BookOpen, Check, ChevronDown, ChevronRight, ChevronsDownUp, CheckSquare, Code2, Eye,
  FileText, Filter, Folder, FolderOpen, FolderPlus, HelpCircle, ImagePlus,
  Link2, List, ListOrdered, Loader2, LocateFixed, Minus, Network, Plus, Quote,
  SquareCode, Table, Tags, Undo2, Redo2, X, Search,
} from 'lucide-react';
import { t } from './i18n.js';
import { PanelCollapseButton } from './feed/PanelGroup.jsx';
import { AuxRail } from './feed/AuxRail.jsx';
import { formatWhen } from './feed/format.js';
import { MarkdownView, Modal } from './components.jsx';
import { computeLayout } from './wiki-graph-layout.js';
import {
  createVaultEditor, outlineOf, scrollToHeading, activeOutlineIndex, openSearchPanel,
  wrapRange, toggleLinePrefixes, cycleHeading, insertAtCursor, insertTable, codeTransform,
} from './vault-editor.js';

/**
 * The vault space, aligned 1:1 with the droplets desktop app (plan P1–P3):
 * tree pane (笔记 header / 图谱·标签云 segmented / dot toolbar with hover
 * actions / native context menus / 整库问 AI foot) │ tabs + breadcrumb bar
 * (mode dropdown + … menu) + Vditor-order format toolbar + CM6 live/source
 * editing + backlinks drawer + AuxRail.
 */

const TABS_KEY = 'droplets.vault.tabs';
const EXPANDED_KEY = 'droplets.vault.expanded';
let fileIndexCache = null; // survives space switches

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
  for (let i = 1; i <= segments.length - 1; i += 1) {
    dirs.push(segments.slice(0, i).join('/'));
  }
  return dirs;
}

/** Pure (fix J): the note's own directory — 新建笔记 defaults here. */
export function dirOf(path) {
  return String(path ?? '').split('/').slice(0, -1).join('/');
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

/** h2–h6 outline from markdown source (fence-aware; read view anchors). */
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

/** Highlight the «…» snippet markers from the FTS backend (escaped first). */
function highlightSnippet(snippet) {
  const escaped = String(snippet)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/«([^»]*)»/g, '<mark>$1</mark>');
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Extract the subgraph within `depth` hops of `center` (plan P3a). */
export function neighborhoodOf(graph, center, depth = 2, limit = 300) {
  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source).push(edge.target);
    adjacency.get(edge.target).push(edge.source);
  }
  const keep = new Set([center]);
  let frontier = [center];
  for (let hop = 0; hop < depth; hop += 1) {
    const next = [];
    for (const node of frontier) {
      for (const neighbor of adjacency.get(node) ?? []) {
        if (!keep.has(neighbor)) { keep.add(neighbor); next.push(neighbor); }
      }
    }
    frontier = next;
    if (keep.size >= limit) break;
  }
  return sliceGraph(graph, keep, limit);
}

/** Global slice keeping the most-connected nodes. */
export function capByDegree(graph, limit = 300) {
  const degree = new Map();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const ranked = graph.nodes.filter((node) => !node.dangling).sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
  const keep = new Set(ranked.slice(0, limit).map((node) => node.id));
  return sliceGraph(graph, keep, limit);
}

function sliceGraph(graph, keep, limit) {
  const nodes = graph.nodes.filter((node) => keep.has(node.id)).slice(0, limit);
  const kept = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target));
  return { nodes, edges };
}

// ---------------------------------------------------------------------------

export function VaultView({ api, onMaterial, noteRequest, onNoteRequestHandled }) {
  // Root-cause fix behind A/B: nothing ever assigned `tab.dirty` — every
  // reader (autosave, conflict poll, flushSave guard, dirty dot, read-view
  // draft rendering) saw undefined, so drafts never saved and never raised
  // the conflict dialog. setDraft now keeps dirty in sync with the draft;
  // persisted tabs from older sessions are normalized here.
  const [tabs, setTabs] = useState(() => loadJson(TABS_KEY, []).map((tab) => ({
    ...tab,
    dirty: tab.dirty === true || (tab.dirty == null && tab.draft != null),
  })));
  const [activeTabId, setActiveTabId] = useState(() => loadJson(TABS_KEY + '.active', null));
  const [expanded, setExpanded] = useState(() => new Set(loadJson(EXPANDED_KEY, [])));
  const [leftMode, setLeftMode] = useState('tree'); // tree | graph | tags
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [sideData, setSideData] = useState({ backlinks: [], unlinked: [], tags: [] });
  // Fix H: two-layer graph cache — `graphFull` is the raw vaultGraph payload
  // (invalidated on mutations), the rendered slice is memoized off it so the
  // active note's neighborhood is always fresh without refetching.
  const [graphFull, setGraphFull] = useState(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState('name-asc');
  const [autoReveal, setAutoReveal] = useState(true);
  const autoRevealRef = useRef(true);
  const [clipboard, setClipboard] = useState(null); // { mode:'cut', path, name }
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, kind, path, name }
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [quick, setQuick] = useState(null);
  const [palette, setPalette] = useState(null);
  const [trash, setTrash] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [creating, setCreating] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [renamePreview, setRenamePreview] = useState(null);
  const [moveTarget, setMoveTarget] = useState(null); // { path, name, dir }
  const [notice, setNotice] = useState('');
  const [noticeIsError, setNoticeIsError] = useState(false); // fix C: danger-tinted notices
  const [error, setError] = useState('');
  const [stats, setStats] = useState({ files: 0 });
  const [fileIndex, setFileIndex] = useState([]);
  const [editOutline, setEditOutline] = useState(null);
  /** Active outline index reported by the CM6 anchor provider (edit modes). */
  const [editActive, setEditActive] = useState(-1);
  const [, setEditorScrollTick] = useState(0);
  const readerRef = useRef(null);
  const notePaneRef = useRef(null);
  const dirty = tabs.some((tab) => tab.dirty);
  const dirtyCount = tabs.filter((tab) => tab.dirty).length; // fix B: statusbar badge

  useEffect(() => { saveJson(TABS_KEY, tabs); }, [tabs]);
  useEffect(() => { saveJson(TABS_KEY + '.active', activeTabId); }, [activeTabId]);
  useEffect(() => { saveJson(EXPANDED_KEY, [...expanded]); }, [expanded]);

  // Mirrors `tabs` into a ref for async readers (flushSave, reloadTab, the
  // poll). Declared BEFORE the poll effect on purpose: when tabSignature
  // changes, React runs this sync first, so the poll's re-check compares
  // against the *new* tab state instead of a stale pre-reload sha/dirty —
  // otherwise a just-resolved conflict would be re-raised.
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  // External change watch (plan §3.4): poll the open tabs' on-disk stamps.
  // A foreign write (Obsidian, the Droplets desktop app, the agent tool)
  // with no local draft reloads the tab silently; a draft present raises
  // the standard conflict dialog instead of overwriting anything.
  const tabSignature = tabs.map((tab) => `${tab.id}:${tab.sha}:${tab.dirty ? 'd' : 'c'}`).join('|');
  useEffect(() => {
    if (tabs.length === 0) return undefined;
    let stopped = false;
    const check = async () => {
      for (const tab of tabsRef.current) {
        if (stopped) return;
        try {
          const { stat } = await api.vaultStat(tab.path);
          if (stopped || !stat || stat.sha === tab.sha) continue;
          const note = await api.vaultRead(tab.path);
          if (stopped) return;
          if (tab.dirty) {
            setConflict((current) => (current?.path === tab.path ? current : {
              path: tab.path,
              tabId: tab.id,
              currentSha: note.sha,
              currentExcerpt: String(note.content ?? '').slice(0, 300),
            }));
          } else {
            setTabs((current) => current.map((item) => (item.id === tab.id
              ? { ...item, content: note.content, sha: note.sha, title: note.title, tags: note.tags ?? [], wordCount: note.wordCount ?? 0, savedAt: null, draft: null, dirty: false }
              : item)));
          }
        } catch { /* stat hiccups are non-fatal */ }
      }
    };
    const timer = setInterval(() => { void check(); }, 5_000);
    const onFocus = () => { void check(); };
    window.addEventListener('focus', onFocus);
    void check();
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabSignature, api]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  const refreshIndex = useCallback(async () => {
    try {
      const status = await api.vaultStatus();
      setStats({ files: status.files });
    } catch { /* surfaced elsewhere */ }
    if (fileIndexCache) setFileIndex(fileIndexCache);
    try {
      const files = await api.vaultIndexFiles();
      fileIndexCache = files;
      setFileIndex(files);
    } catch { /* offline tolerated */ }
  }, [api]);

  useEffect(() => { void refreshIndex(); }, [refreshIndex]);

  /**
   * Locate the active note in the tree: expand its ancestors and scroll the
   * row into view. Used by the 自动定位 toolbar button so clicking it has an
   * immediate, visible effect (the toggle alone only changed a tint — the
   * button read as dead). Children load asynchronously, so the scroll
   * retries briefly until the row exists.
   */
  const revealActiveNote = useCallback(() => {
    const path = activeTab?.path;
    if (!path) return false;
    if (leftMode !== 'tree') setLeftMode('tree');
    setExpanded((current) => {
      const next = new Set(current);
      for (const dir of ancestorsOf(path)) next.add(dir);
      return next;
    });
    let attempts = 0;
    const tryScroll = () => {
      const row = document.querySelector('.dpl-vault2-row.is-active');
      if (row) { row.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); return; }
      if (attempts < 40) { attempts += 1; window.requestAnimationFrame?.(tryScroll); }
    };
    window.requestAnimationFrame?.(tryScroll);
    return true;
  }, [activeTab?.path, leftMode]);

  const flashNotice = useCallback((message) => {
    setNotice(message);
    setNoticeIsError(false);
    setTimeout(() => { setNotice((current) => (current === message ? '' : current)); }, 3500);
  }, []);

  /**
   * Fix C: failure feedback. Failures used to ride the same permanent green
   * notice as successes; they now tint danger and auto-clear after 8 s
   * (manual close still works — same dismiss button as flashNotice).
   */
  const flashError = useCallback((message) => {
    setNotice(message);
    setNoticeIsError(true);
    setTimeout(() => { setNotice((current) => (current === message ? '' : current)); }, 8000);
  }, []);

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
        draft: null,
        dirty: false,
        sha: note.sha,
        title: note.title,
        tags: note.tags ?? [],
        wordCount: note.wordCount ?? 0,
        savedAt: null,
        // fix G: editor prefs live on the tab so switching back restores the
        // same view/lineNumbers/wrap without remounting the note pane.
        view: 'read',
        lineNumbers: true,
        wrap: true,
      };
      setTabs((current) => [...current.filter((item) => item.id !== tab.id), tab]);
      setActiveTabId(tab.id);
      setSearchResults(null);
      if (autoRevealRef.current) {
        setExpanded((current) => {
          const next = new Set(current);
          for (const dir of ancestorsOf(path)) next.add(dir);
          return next;
        });
      }
      onMaterial({ space: 'vault', path: note.path, title: note.title, content: note.content.slice(0, 60000) });
    } catch (cause) { setError(String(cause?.message ?? cause)); }
  }, [api, tabs, onMaterial]);

  /**
   * Fix A: reload a tab straight from disk. The conflict dialog's「重载」used
   * to call openPath, which early-returns for an open tab — the button was a
   * no-op and the disk version never landed. This bypasses the early return:
   * fresh content/sha/title/tags/wordCount, draft cleared.
   */
  const reloadTab = useCallback(async (tabId) => {
    const tab = tabsRef.current.find((item) => item.id === tabId || item.path === tabId);
    if (!tab) return;
    // The tab is about to become clean: kill the pending autosave timer
    // first (it may be milliseconds from firing) so a mid-reload flush
    // cannot re-raise a conflict for a tab the user just resolved.
    clearTimeout(saveTimer.current);
    try {
      const note = await api.vaultRead(tab.path);
      setTabs((current) => current.map((item) => (item.id === tab.id ? {
        ...item,
        content: note.content,
        draft: null,
        dirty: false,
        sha: note.sha,
        title: note.title,
        tags: note.tags ?? [],
        wordCount: note.wordCount ?? 0,
        savedAt: null,
      } : item)));
      // A flush that was already in flight when the reload started may have
      // re-raised a conflict during the await — drop it: the tab now matches
      // disk, so any conflict for this path is stale by construction.
      setConflict((current) => (current && (current.tabId === tab.id || current.path === tab.path) ? null : current));
    } catch (cause) { setError(String(cause?.message ?? cause)); }
  }, [api]);

  /**
   * Fix A: conflict「另存副本」— keep both sides. Writes the local draft to a
   * 「xx 副本」sibling (create-only, incrementing, matching the service's
   * naming), then reloads the original tab from disk so the conflict is fully
   * resolved, and opens the copy. Chosen over vaultDuplicate-first because
   * duplicating the disk version would still leave the draft conflicting.
   */
  const saveConflictCopy = useCallback(async (conflictInfo) => {
    const tab = tabsRef.current.find((item) => item.id === conflictInfo.tabId || item.path === conflictInfo.path);
    if (!tab) return;
    const draft = tab.draft ?? tab.content;
    const dir = dirOf(tab.path);
    const stem = tab.name.replace(/\.md$/i, '');
    try {
      let copyPath = null;
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const suffix = attempt === 1 ? ' 副本' : ` 副本 ${attempt}`;
        const candidate = (dir === '' ? '' : dir + '/') + stem + suffix + '.md';
        const result = await api.vaultWrite({ path: candidate, content: draft, expectedSha: null });
        if (!result.conflict) { copyPath = result.path ?? candidate; break; }
      }
      if (!copyPath) { flashError('副本路径都被占用，请手动另存'); return; }
      setConflict(null);
      await reloadTab(tab.id);
      await openPath(copyPath);
      flashNotice(`草稿已另存：${copyPath}`);
      void refreshIndex();
    } catch (cause) { flashError(String(cause?.message ?? cause)); }
  }, [api, reloadTab, openPath, refreshIndex, flashError, flashNotice]);

  /** Fix G: write editor prefs (view/lineNumbers/wrap) back onto the tab. */
  const setTabPrefs = useCallback((tabId, patch) => {
    setTabs((current) => current.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)));
  }, []);

  // Cross-space hand-off: another space saved an article as a note and asks
  // the vault to open it (信息流/收件箱 → 知识库, plan 差异化 #3).
  useEffect(() => {
    if (!noteRequest?.path) return;
    void openPath(noteRequest.path).finally(() => { onNoteRequestHandled?.(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteRequest?.path, noteRequest?.nonce]);

  // First visit: restore the persisted active tab.
  const restoredOnce = useRef(false);
  useEffect(() => {
    if (restoredOnce.current || tabs.length === 0) return;
    restoredOnce.current = true;
    const target = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
    if (target?.path) void openPath(target.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.length > 0]);

  const loadSideData = useCallback(async (path) => {
    try {
      const [links, tags] = await Promise.all([
        api.vaultBacklinks(path).catch(() => ({ backlinks: [], unlinked: [] })),
        api.vaultTags().catch(() => ({ tags: [] })),
      ]);
      setSideData({ backlinks: links.backlinks ?? [], unlinked: links.unlinked ?? [], tags: tags.tags ?? [] });
    } catch { /* pane degrades to empty */ }
  }, [api]);

  useEffect(() => {
    if (activeTab?.path) void loadSideData(activeTab.path);
  }, [activeTab?.path, loadSideData]);

  useEffect(() => {
    if (leftMode === 'tags' && sideData.tags.length === 0) {
      void api.vaultTags().then((outcome) => setSideData((current) => ({ ...current, tags: outcome.tags ?? [] }))).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftMode]);

  const setDraft = useCallback((tabId, draft) => {
    setTabs((current) => current.map((tab) => (tab.id === tabId ? { ...tab, draft, dirty: draft != null } : tab)));
  }, []);

  const closeTab = useCallback(async (tabId) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (tab?.dirty) {
      if (!window.confirm(`「${tab.name}」有未保存的修改。确定放弃并关闭吗？`)) return;
    }
    setTabs((current) => {
      const next = current.filter((item) => item.id !== tabId);
      if (activeTabId === tabId) setActiveTabId(next[next.length - 1]?.id ?? null);
      return next;
    });
  }, [tabs, activeTabId]);

  const saveTimer = useRef(null);
  // Render-time mirror of the active tab id: lets the autosave cleanup tell
  // «torn down because we switched tabs» (flush the outgoing draft — fix B)
  // from «torn down because the draft changed» (keep the 800 ms debounce —
  // a naive unconditional flush would save on every keystroke).
  const activeTabIdAtRender = useRef(null);
  activeTabIdAtRender.current = activeTab?.id ?? null;
  useEffect(() => {
    if (!activeTab?.dirty) return undefined;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushSave(activeTab.id); }, 800);
    return () => {
      clearTimeout(saveTimer.current);
      // Fix B: only flush when the teardown is a tab switch. `activeTab` here
      // is the one this effect run was bound to — exactly the tab leaving.
      if (activeTab?.dirty && activeTabIdAtRender.current !== activeTab.id) void flushSave(activeTab.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.draft, activeTab?.id]);

  const flushSave = useCallback(async (tabId, { force = false } = {}) => {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab?.dirty && !force) return;
    try {
      const result = await api.vaultWrite({ path: tab.path, content: tab.draft ?? tab.content, expectedSha: force ? undefined : tab.sha });
      if (result.conflict) {
        // The tab may have been reloaded/discarded while the write was in
        // flight — a conflict for an already-clean tab is stale, drop it.
        if (!tabsRef.current.find((item) => item.id === tabId)?.dirty) return;
        // Fix A: carry the tab id so「重载/另存副本」resolve the right tab.
        setConflict({ path: tab.path, tabId: tab.id, currentSha: result.currentSha, currentExcerpt: result.currentExcerpt });
        return;
      }
      setTabs((current) => current.map((item) => (item.id === tabId ? {
        ...item,
        sha: result.sha,
        content: item.draft ?? item.content,
        draft: null,
        dirty: false,
        savedAt: new Date().toLocaleTimeString('zh-Hans-CN', { hour: '2-digit', minute: '2-digit' }),
      } : item)));
      setConflict(null);
      setGraphFull(null); // fix H: a saved note can change links — refetch the graph
    } catch (cause) { setError(String(cause?.message ?? cause)); }
  }, [api]);

  const runSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (query === '') { setSearchResults(null); return; }
    try {
      const outcome = await api.vaultSearch({ query, limit: 50 });
      setSearchResults(outcome);
    } catch (cause) { setError(String(cause?.message ?? cause)); }
  }, [api, searchQuery]);

  // Fix H: the rendered graph slice is a memo of the raw payload — switching
  // notes re-scopes without refetching; mutations null the raw payload so the
  // next open rebuilds instead of showing a stale slice.
  const graphData = useMemo(
    () => (graphFull ? (activeTab?.path ? neighborhoodOf(graphFull, activeTab.path, 2, 300) : capByDegree(graphFull, 300)) : null),
    [graphFull, activeTab?.path],
  );
  const graphFetching = useRef(false);
  const loadGraph = useCallback(async () => {
    if (graphFull || graphFetching.current) return;
    graphFetching.current = true;
    try { setGraphFull(await api.vaultGraph()); } finally { graphFetching.current = false; }
  }, [api, graphFull]);

  // Graph mode with an invalidated payload refetches (fix H: a save/rename
  // during graph view used to leave the pane spinning forever after the
  // invalidation, because only switchLeft ever triggered a fetch).
  useEffect(() => {
    if (leftMode === 'graph' && !graphFull) void loadGraph();
  }, [leftMode, graphFull, loadGraph]);

  const switchLeft = useCallback(async (mode) => {
    setLeftMode((current) => (current === mode ? 'tree' : mode));
    if (mode !== 'tree') setFilterOpen(false); // fix I: the filter row only exists in tree mode
    if (mode === 'graph') {
      try { await loadGraph(); } catch (cause) { setError(String(cause?.message ?? cause)); }
    }
    if (mode === 'tags' && sideData.tags.length === 0) {
      try {
        const outcome = await api.vaultTags();
        setSideData((current) => ({ ...current, tags: outcome.tags ?? [] }));
      } catch { /* degrade */ }
    }
  }, [loadGraph, sideData.tags.length, api]);

  // ------- create / rename / move / duplicate / trash / clipboard -------

  const submitCreate = useCallback(async () => {
    if (!creating) return;
    try {
      const name = creating.name.trim() || '未命名';
      const dir = (creating.dir ?? '').trim(); // fix J: 位置 is editable + datalist now
      if (creating.kind === 'dir') {
        // Adjacent fix found while adding the error field: this branch read
        // `creating.path`, which never exists in this flow — folder creation
        // always failed. Build the dir path like the note branch does.
        await api.vaultCreateDir({ dir: dir === '' ? name : `${dir}/${name}` });
      } else {
        const path = (dir === '' ? name : `${dir}/${name}`) + '.md';
        const result = await api.vaultWrite({ path, content: `---\nid: ${crypto.randomUUID()}\ntitle: ${name}\ncreated: ${new Date().toISOString()}\n---\n\n# ${name}\n\n`, expectedSha: null, createOnly: true });
        if (result.conflict) {
          // Fix D: the failure used to surface as a statusbar notice that the
          // modal covered; show it inline so the user can pick a new name.
          setCreating({ ...creating, error: `已存在：${path}` });
          return;
        }
        void openPath(path);
      }
      setCreating(null);
      await refreshIndex();
    } catch (cause) {
      setCreating({ ...creating, error: String(cause?.message ?? cause) });
      flashError(String(cause?.message ?? cause));
    }
  }, [creating, api, refreshIndex, openPath, flashError]);

  const startRename = useCallback((path) => {
    setRenaming({ path, name: path.split('/').pop() });
    setRenamePreview(null);
    if (path.toLowerCase().endsWith('.md')) {
      void (async () => {
        try {
          const outcome = await api.vaultBacklinks(path);
          setRenamePreview((outcome.backlinks ?? []).length);
        } catch { setRenamePreview(0); }
      })();
    } else {
      setRenamePreview(0);
    }
  }, [api]);

  const submitRename = useCallback(async (nextPath) => {
    if (!renaming) return;
    try {
      const result = await api.vaultRename({ from: renaming.path, to: nextPath, updateLinks: true });
      flashNotice(`已重命名${result.updatedLinks > 0 ? `，更新 ${result.updatedLinks} 处链接` : ''}`);
      setRenaming(null);
      setTabs((current) => current.map((tab) => (tab.path === renaming.path ? { ...tab, path: result.path, name: result.path.split('/').pop(), id: result.path } : tab)));
      if (activeTabId === renaming.path) setActiveTabId(result.path);
      setGraphFull(null); // fix H: links moved — rebuild the graph slice
      await refreshIndex();
    } catch (cause) { flashError(String(cause?.message ?? cause)); }
  }, [renaming, api, refreshIndex, activeTabId, flashNotice, flashError]);

  const submitMove = useCallback(async (dir) => {
    if (!moveTarget) return;
    const to = (dir === '' ? moveTarget.name : `${dir}/${moveTarget.name}`);
    try {
      const result = await api.vaultRename({ from: moveTarget.path, to, updateLinks: moveTarget.path.toLowerCase().endsWith('.md') });
      flashNotice(`已移动到 ${dir || '根目录'}${result.updatedLinks > 0 ? `，更新 ${result.updatedLinks} 处链接` : ''}`);
      setMoveTarget(null);
      setTabs((current) => current.map((tab) => (tab.path === moveTarget.path ? { ...tab, path: result.path, name: result.path.split('/').pop(), id: result.path } : tab)));
      if (activeTabId === moveTarget.path) setActiveTabId(result.path);
      setGraphFull(null); // fix H
      await refreshIndex();
    } catch (cause) { flashError(String(cause?.message ?? cause)); }
  }, [moveTarget, api, refreshIndex, activeTabId, flashNotice, flashError]);

  const trashPath = useCallback(async (path, name) => {
    if (!window.confirm(`把「${name}」移入回收站？可在 Droplets 回收站恢复。`)) return;
    try {
      await api.vaultDelete({ path });
      setTabs((current) => current.filter((tab) => tab.path !== path));
      flashNotice('已移入回收站');
      setGraphFull(null); // fix H
      await refreshIndex();
    } catch (cause) { flashError(String(cause?.message ?? cause)); }
  }, [api, refreshIndex, flashNotice, flashError]);

  const duplicatePath = useCallback(async (path) => {
    try {
      if (path.toLowerCase().endsWith('.md')) {
        const result = await api.vaultDuplicate({ path });
        void openPath(result.path);
      } else {
        const dir = path.split('/').slice(0, -1).join('/');
        await api.vaultCopyDirTo({ from: path, toDir: dir });
      }
      flashNotice('已创建副本');
      setGraphFull(null); // fix H
      await refreshIndex();
    } catch (cause) { flashError(String(cause?.message ?? cause)); }
  }, [api, refreshIndex, openPath, flashNotice, flashError]);

  const pasteInto = useCallback(async (dir) => {
    if (!clipboard) return;
    const name = clipboard.path.split('/').pop();
    try {
      if (clipboard.mode === 'cut') {
        const to = (dir === '' ? name : `${dir}/${name}`);
        const result = await api.vaultRename({ from: clipboard.path, to, updateLinks: clipboard.path.toLowerCase().endsWith('.md') });
        setTabs((current) => current.map((tab) => (tab.path === clipboard.path ? { ...tab, path: result.path, name: result.path.split('/').pop(), id: result.path } : tab)));
        if (activeTabId === clipboard.path) setActiveTabId(result.path);
        flashNotice('已粘贴（移动）');
        setGraphFull(null); // fix H
      } else if (clipboard.path.toLowerCase().endsWith('.md')) {
        await api.vaultCopyTo({ from: clipboard.path, toDir: dir });
        flashNotice('已粘贴（复制）');
      } else {
        await api.vaultCopyDirTo({ from: clipboard.path, toDir: dir });
        flashNotice('已粘贴（复制文件夹）');
      }
      setClipboard(null);
      await refreshIndex();
    } catch (cause) { flashError(String(cause?.message ?? cause)); }
  }, [clipboard, api, refreshIndex, activeTabId, flashNotice, flashError]);

  /** Convert the first bare mention in a note into a real wikilink. */
  const linkMention = useCallback(async (mention) => {
    if (!activeTab) return;
    try {
      const note = await api.vaultRead(mention.path);
      const stem = activeTab.path.split('/').pop().replace(/\.md$/i, '');
      const text = note.content;
      const pattern = new RegExp(`(^|[^\\[\\w])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w])`);
      const match = pattern.exec(text);
      if (!match) { flashError(`「${mention.title}」里没找到「${stem}」原文`); return; }
      const at = match.index + match[1].length;
      const next = text.slice(0, at) + `[[${stem}]]` + text.slice(at);
      const write = await api.vaultWrite({ path: mention.path, content: next, expectedSha: note.sha });
      if (write.conflict) { flashError(`「${mention.title}」有冲突，未改写`); return; }
      flashNotice(`已在「${mention.title}」建立链接`);
      await loadSideData(activeTab.path);
    } catch (cause) { flashError(String(cause?.message ?? cause)); }
  }, [activeTab, api, loadSideData, flashNotice, flashError]);

  /** Context-menu 问 AI（这篇）: open the companion with that note. */
  const askAiNote = useCallback(async (path) => {
    try {
      const note = await api.vaultRead(path);
      onMaterial({ space: 'vault', path: note.path, title: note.title, content: note.content.slice(0, 60000) }, { reveal: true });
    } catch (cause) { flashError(String(cause?.message ?? cause)); }
  }, [api, onMaterial, flashError]);

  /** 整库问 AI: native parity — a numbered library listing as the material. */
  const askWholeLibrary = useCallback(() => {
    const listing = (fileIndexCache ?? fileIndex).map((file, index) => `${index + 1}. ${file.path}`).join('\n');
    onMaterial({ space: 'vault', title: '知识库整库问答', content: listing.slice(0, 300000) }, { reveal: true });
  }, [fileIndex, onMaterial]);

  const exportActive = useCallback(async (format) => {
    if (!activeTab) { flashError('先打开一篇笔记'); return; }
    const text = activeTab.draft ?? activeTab.content;
    const stem = activeTab.name.replace(/\.md$/i, '');
    if (format === 'md') {
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${stem}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
      flashNotice('已导出 .md');
      return;
    }
    const rendered = readerRef.current?.querySelector('.dpl-vault2-body');
    if (!rendered) { flashError('请切到阅读视图再导出'); return; }
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(stem)}</title><style>body{max-width:720px;margin:40px auto;padding:0 24px;font:15px/1.75 -apple-system,'PingFang SC',sans-serif;color:#1a1a1a}h1,h2,h3{line-height:1.4}pre{background:#f5f5f5;padding:12px;border-radius:8px;overflow:auto}code{background:#f5f5f5;border-radius:4px;padding:1px 5px}img{max-width:100%}blockquote{border-left:3px solid #ddd;margin:0;padding:2px 14px;color:#555}table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:5px 10px}@media print{body{margin:0}}</style></head><body>${rendered.innerHTML}</body></html>`;
    if (format === 'pdf') {
      const frame = document.createElement('iframe');
      frame.style.position = 'fixed';
      frame.style.right = '0';
      frame.style.bottom = '0';
      frame.style.width = '0';
      frame.style.height = '0';
      frame.style.border = '0';
      document.body.appendChild(frame);
      frame.srcdoc = html;
      frame.onload = () => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { flashError('打印面板不可用，请用导出 HTML'); }
        setTimeout(() => frame.remove(), 60000);
      };
      flashNotice('已打开打印面板（可选「存储为 PDF」）');
      return;
    }
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${stem}.html`;
    anchor.click();
    URL.revokeObjectURL(url);
    flashNotice('已导出 .html');
  }, [activeTab, flashNotice, flashError]);

  const paletteActions = useMemo(() => ([
    // fix J: default to the active note's own directory (was ancestorsOf()[0] —
    // the top-level dir, one level too shallow).
    { id: 'new-note', label: '新建笔记', run: () => setCreating({ kind: 'note', name: '', dir: activeTab ? dirOf(activeTab.path) : '' }) },
    { id: 'new-folder', label: '新建文件夹', run: () => setCreating({ kind: 'dir', name: '', dir: activeTab ? dirOf(activeTab.path) : '' }) },
    { id: 'search', label: '全库搜索', run: () => setSearchOpen(true) },
    { id: 'graph', label: '图谱', run: () => void switchLeft('graph') },
    { id: 'tags', label: '标签云', run: () => void switchLeft('tags') },
    { id: 'backlinks', label: '反向链接', run: () => setBacklinksOpen(true) },
    { id: 'trash', label: '回收站（浏览与恢复）', run: () => void openTrash() },
    { id: 'export-md', label: '导出当前笔记 (.md)', run: () => void exportActive('md') },
    { id: 'export-html', label: '导出当前笔记 (.html)', run: () => void exportActive('html') },
    { id: 'reindex', label: '重扫索引', run: () => void api.vaultReindex().then(refreshIndex) },
    { id: 'close-tab', label: '关闭当前标签', run: () => { if (activeTabId) void closeTab(activeTabId); } },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ]), [activeTab, activeTabId, graphData]);


  // ------- keyboard: ⌘P / ⌘⇧F / ⌘⇧P -------

  useEffect(() => {
    const onKey = (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 'p' && !event.shiftKey) { event.preventDefault(); setQuick({ query: '', active: 0 }); }
      else if (key === 'f' && event.shiftKey) { event.preventDefault(); setSearchOpen(true); }
      else if (key === 'p' && event.shiftKey) { event.preventDefault(); setPalette({ query: '', active: 0 }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const paletteResults = useMemo(
    () => (palette && palette.query.trim() !== '' ? paletteActions.filter((action) => action.label.toLowerCase().includes(palette.query.trim().toLowerCase())) : paletteActions),
    [palette, paletteActions],
  );

  const quickResults = useMemo(
    () => (quick && quick.query.trim() !== '' ? filterFiles(fileIndex, quick.query, 20) : []),
    [quick, fileIndex],
  );

  const filteredIndex = useMemo(
    () => (filterOpen && filter.trim() !== '' ? filterFiles(fileIndex, filter, 30) : []),
    [filterOpen, filter, fileIndex],
  );

  /** Fix J: directory suggestions for the create dialog's 位置 datalist. */
  const vaultDirs = useMemo(() => {
    const dirs = new Set();
    for (const file of fileIndex) {
      const dir = dirOf(file.path);
      if (dir !== '') dirs.add(dir);
    }
    return [...dirs].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [fileIndex]);

  const graphLayout = useMemo(
    () => (leftMode === 'graph' && graphData ? computeLayout(graphData, 640, 760) : null),
    [leftMode, graphData],
  );

  const headings = useMemo(() => {
    if (editOutline !== null) return editOutline;
    return markdownHeadings(activeTab?.content ?? '');
  }, [editOutline, activeTab?.content]);

  const onVaultLink = useCallback((target) => {
    const wanted = String(target).replace(/\.md$/i, '').replace(/^\.?\//, '').split('#')[0];
    if (wanted === '') return;
    const hit = fileIndex.find((file) => file.path === `${wanted}.md`)
      ?? fileIndex.find((file) => file.path.replace(/\.md$/i, '').endsWith('/' + wanted) || file.path.replace(/\.md$/i, '') === wanted);
    if (hit) void openPath(hit.path);
    else {
      const base = activeTab?.path ? activeTab.path.split('/').slice(0, -1).join('/') : '';
      void openPath((base === '' ? '' : base + '/') + wanted + '.md');
    }
  }, [fileIndex, openPath, activeTab?.path]);

  /**
   * Image source resolver for the editor widget and the reading view.
   * Remote URLs pass through synchronously; local references (attachments,
   * note-relative paths, Obsidian ![[embed]] names) resolve against the
   * note's directory, the vault root and attachments/ in turn, loading the
   * bytes as a data URL. Unresolvable references fall back to raw text.
   */
  const resolveVaultImage = useCallback((src) => {
    const raw = String(src ?? '').trim();
    if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
    if (!activeTab?.path) return null;
    const noteDir = activeTab.path.split('/').slice(0, -1).join('/');
    const base = raw.replace(/^\.?\//, '');
    const name = base.split('/').pop();
    const candidates = [...new Set([
      (noteDir ? noteDir + '/' : '') + base,
      base,
      'attachments/' + name,
    ])];
    return (async () => {
      for (const candidate of candidates) {
        try {
          const result = await api.vaultReadAttachment?.(candidate);
          if (result?.dataUrl) return result.dataUrl;
        } catch { /* try the next candidate */ }
      }
      return null;
    })();
  }, [api, activeTab?.path]);

  /** Paste-image uploader: bytes → attachments/ → vault-relative reference. */
  const pasteVaultImage = useCallback(async (base64, name) => {
    try {
      const result = await api.vaultWriteAttachment?.({ bytes: base64, name });
      return result?.path ?? null;
    } catch (cause) {
      flashError(String(cause?.message ?? cause));
      return null;
    }
  }, [api, flashError]);

  const openTrash = useCallback(async () => {
    try {
      const outcome = await api.vaultTrashList();
      setTrash(outcome.entries ?? []);
    } catch (cause) { flashError(String(cause?.message ?? cause)); }
  }, [api, flashError]);

  const restoreTrash = useCallback(async (id) => {
    try {
      const result = await api.vaultTrashRestore(id);
      flashNotice(`已恢复：${result.restored}`);
      setTrash((current) => (current ?? []).filter((entry) => entry.id !== id));
      await refreshIndex();
    } catch (cause) { flashError(String(cause?.message ?? cause)); }
  }, [api, refreshIndex, flashNotice, flashError]);

  const captured = useRef(false);
  const captureSelection = (event) => {
    // Fix F: selections made inside the CM6 editor serve editing (replace,
    // wrap…), not the companion material — don't hijack them. Read view has
    // no .cm-editor, so it keeps the material-switch behaviour.
    if (event?.target?.closest?.('.cm-editor')) return;
    if (captured.current) return;
    const selection = String(window.getSelection?.() ?? '').trim();
    captured.current = true;
    setTimeout(() => { captured.current = false; }, 400);
    if (!activeTab || selection === '') return;
    onMaterial({ space: 'vault', path: activeTab.path, title: activeTab.title, selection, content: '' });
  };

  if (stats.files === 0 && fileIndex.length === 0) {
    return (
      <div className="dpl-vault2-empty">
        <Loader2 size={16} className="dpl-spin" />
        <p>{t('vault.noVault')}</p>
        <p className="dpl-hint">{t('vault.chooseVault')}</p>
      </div>
    );
  }

  return (
    <div className="dpl-vault2">
      <aside className="dpl-col dpl-vault2-tree">
        <div className="dpl-vault2-treehead">
          <span>笔记</span>
          <PanelCollapseButton />
        </div>
        <div className="dpl-vault2-seg">
          <button type="button" className={'dpl-pane-btn' + (leftMode === 'graph' ? ' is-active' : '')} onClick={() => void switchLeft('graph')} data-testid="vault-graph-toggle">
            <Network size={14} /> 图谱
          </button>
          <button type="button" className={'dpl-pane-btn' + (leftMode === 'tags' ? ' is-active' : '')} onClick={() => void switchLeft('tags')} data-testid="vault-tags-toggle">
            <Tags size={14} /> 标签云
          </button>
        </div>
        <TreeToolbar
          filterOpen={filterOpen}
          onToggleFilter={() => {
            // Fix I: the filename filter only drives the tree — opening it in
            // graph/tag mode did nothing. Snap back to the tree first.
            const next = !filterOpen;
            setFilterOpen(next);
            if (next && leftMode !== 'tree') setLeftMode('tree');
          }}
          sortKey={sortKey}
          onSort={(key) => { setSortKey(key); }}
          autoReveal={autoReveal}
          onToggleAutoReveal={() => {
            const next = !autoReveal;
            setAutoReveal(next);
            autoRevealRef.current = next;
            if (!next) {
              flashNotice('自动定位已关闭：打开笔记时不再展开定位');
              return;
            }
            if (revealActiveNote()) flashNotice(`已定位到 ${activeTab?.title ?? activeTab?.name ?? '当前笔记'}`);
            else flashNotice('当前没有打开的笔记可定位');
          }}
          onCollapseAll={() => setExpanded(new Set())}
          onNewNote={() => setCreating({ kind: 'note', name: '', dir: activeTab ? dirOf(activeTab.path) : '' })}
          onNewFolder={() => setCreating({ kind: 'dir', name: '', dir: activeTab ? dirOf(activeTab.path) : '' })}
        />
        {filterOpen ? (
          <div className="dpl-vault2-filter">
            <Search size={13} />
            <input autoFocus placeholder="过滤文件名…" value={filter} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setFilter(''); }} />
            {filter !== '' ? <button type="button" onClick={() => setFilter('')} aria-label="清除过滤"><X size={12} /></button> : null}
          </div>
        ) : null}
        <div className="dpl-vault2-treescroll">
          {leftMode === 'graph' ? (
            graphData && graphLayout
              ? <GraphPane graph={graphData} layout={graphLayout} onOpen={(path) => void openPath(path)} onClose={() => setLeftMode('tree')} />
              : <div className="dpl-vault2-empty"><Loader2 size={14} className="dpl-spin" /></div>
          ) : leftMode === 'tags' ? (
            <div className="dpl-vault2-tags">
              {sideData.tags.slice(0, 120).map((item) => (
                <button
                  key={item.tag} type="button"
                  onClick={() => { setSearchOpen(true); setSearchQuery(item.tag); void api.vaultSearch({ query: item.tag, limit: 50, tag: item.tag }).then(setSearchResults).catch(() => {}); }}
                >
                  #{item.tag} <span>{item.count}</span>
                </button>
              ))}
              {sideData.tags.length === 0 ? <div className="dpl-vault2-empty">暂无标签</div> : null}
            </div>
          ) : filterOpen && filter.trim() !== '' ? (
            <div className="dpl-vault2-flatlist">
              {filteredIndex.map((file) => (
                <div key={file.path} className={'dpl-vault2-row' + (activeTab?.path === file.path ? ' is-active' : '')}>
                  <button type="button" className="dpl-vault2-file" onClick={() => void openPath(file.path)}>
                    <FileText size={13} />
                    <span className="dpl-truncate">{file.name.replace(/\.md$/i, '')}</span>
                    <span className="dpl-vault2-filedir">{file.path.split('/').slice(0, -1).join('/')}</span>
                  </button>
                </div>
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
              onContextMenu={(event, kind, path, name) => {
                event.preventDefault();
                setCtxMenu({ x: event.clientX, y: event.clientY, kind, path, name });
              }}
            />
          )}
        </div>
        <button type="button" className="dpl-vault2-askall" onClick={askWholeLibrary} data-testid="vault-ask-ai">
          整库问 AI
        </button>
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
          {searchResults ? (
            <div className="dpl-vault2-searchresults">
              {searchResults.results.map((hit) => (
                <button key={hit.path} type="button" className="dpl-vault2-hit" onClick={() => void openPath(hit.path)}>
                  <strong>{hit.title}</strong>
                  <span className="dpl-vault2-filedir">{hit.path}</span>
                  {hit.excerpt ? <p dangerouslySetInnerHTML={{ __html: highlightSnippet(hit.excerpt) }} /> : null}
                </button>
              ))}
              {searchResults.results.length === 0 ? <div className="dpl-vault2-empty">无结果</div> : null}
            </div>
          ) : activeTab ? (
            // Fix G: no per-tab key — the pane persists across tab switches so
            // view/scroll survive; text loads through the setDoc effect below.
            <NoteReadPane
              ref={notePaneRef}
              tab={activeTab}
              onPrefChange={(patch) => setTabPrefs(activeTab.id, patch)}
              onDraft={(draft) => setDraft(activeTab.id, draft)}
              onSave={() => void flushSave(activeTab.id)}
              onDiscard={() => setDraft(activeTab.id, null)}
              onWikilink={onVaultLink}
              onMaterial={onMaterial}
              onOutlineChange={setEditOutline}
              onEditorScroll={(index) => {
                setEditorScrollTick((tick) => tick + 1);
                setEditActive(typeof index === 'number' ? index : -1);
              }}
              resolveImage={resolveVaultImage}
              pasteImage={pasteVaultImage}
              noteFiles={fileIndex}
              readerRef={readerRef}
              backlinksOpen={backlinksOpen}
              onToggleBacklinks={() => setBacklinksOpen(!backlinksOpen)}
              onExport={(format) => void exportActive(format)}
            />
          ) : (
            <div className="dpl-vault2-empty dpl-vault2-readerempty">在左侧选择一篇笔记开始阅读</div>
          )}

          {backlinksOpen && activeTab && !searchResults ? (
            <div className="dpl-vault2-bldrawer" data-testid="backlinks-drawer">
              <div className="dpl-vault2-bldrawhead">
                <span>反向链接（{sideData.backlinks.length}）{sideData.unlinked.length > 0 ? ` · 未链接 ${sideData.unlinked.length}` : ''}</span>
                <button type="button" className="dpl-icon-btn" onClick={() => setBacklinksOpen(false)} aria-label="关闭反向链接"><X size={13} /></button>
              </div>
              <div className="dpl-vault2-bldrawbody">
                {sideData.backlinks.map((item) => (
                  <button key={item.path} type="button" className="dpl-vault2-backlink" onClick={() => void openPath(item.path)}>
                    <span className="dpl-truncate">{item.title}</span>
                    <span className="dpl-vault2-filedir">{item.path}</span>
                  </button>
                ))}
                {sideData.backlinks.length === 0 ? <div className="dpl-vault2-empty">暂无反链</div> : null}
                {sideData.unlinked.length > 0 ? (
                  <>
                    <div className="dpl-vault2-unlinkedhead">未链接提及</div>
                    {sideData.unlinked.map((item) => (
                      <div key={item.path} className="dpl-vault2-unlinked">
                        <button type="button" className="dpl-vault2-backlink" onClick={() => void openPath(item.path)}>
                          <span className="dpl-truncate">{item.title}</span>
                          <span className="dpl-vault2-filedir">{item.path}</span>
                        </button>
                        <button type="button" className="dpl-vault2-unlinkbtn" title={`在 ${item.title} 里加 [[链接]]`} onClick={() => void linkMention(item)}>
                          <ArrowLeftRight size={12} />
                        </button>
                      </div>
                    ))}
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="dpl-vault2-statusbar">
          <span>{activeTab ? `${activeTab.wordCount.toLocaleString()} 字` : `${stats.files} 篇笔记`}</span>
          <span>{activeTab?.dirty ? '未保存' : activeTab?.savedAt ? `已保存 ${activeTab.savedAt}` : ''}</span>
          {dirtyCount > 1 ? <span className="dpl-vault2-statusbadge">{dirtyCount} 个未保存</span> : null}
          <button type="button" className="dpl-vault2-statuslink" onClick={() => setBacklinksOpen(!backlinksOpen)}>{sideData.backlinks.length} 反链</button>
          {notice ? (
            <span className={'dpl-vault2-statusnotice' + (noticeIsError ? ' is-error' : '')}>
              {notice}
              <button type="button" onClick={() => { setNotice(''); setNoticeIsError(false); }}><X size={11} /></button>
            </span>
          ) : null}
          {error ? <span className="dpl-vault2-statuserror">{error}<button type="button" onClick={() => setError('')}><X size={11} /></button></span> : null}
        </div>
      </section>

      {activeTab && !searchResults ? (
        <AuxRail
          headings={headings}
          containerRef={readerRef}
          onJumpToHeading={(index) => { notePaneRef.current?.jumpToHeading?.(index); }}
          activeIndex={editOutline !== null ? editActive : undefined}
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
              onChange={(event) => setQuick({ query: event.target.value, active: 0 })}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { setQuick(null); return; }
                // Fix E: arrow-key navigation (ring) + Enter runs the active row.
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  if (quickResults.length === 0) return;
                  event.preventDefault();
                  const delta = event.key === 'ArrowDown' ? 1 : -1;
                  const count = quickResults.length;
                  const next = (((quick.active ?? 0) + delta) % count + count) % count;
                  setQuick({ ...quick, active: next });
                  window.requestAnimationFrame?.(() => {
                    document.querySelector('[data-testid="vault-quicklist"] button.is-active')?.scrollIntoView?.({ block: 'nearest' });
                  });
                  return;
                }
                if (event.key === 'Enter' && quickResults[quick.active ?? 0]) {
                  const file = quickResults[quick.active ?? 0];
                  setQuick(null);
                  void openPath(file.path);
                }
              }}
            />
            <div className="dpl-vault2-quicklist" data-testid="vault-quicklist">
              {quickResults.map((file, index) => (
                <button
                  key={file.path} type="button"
                  className={index === (quick.active ?? 0) ? 'is-active' : ''}
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

      {palette ? (
        <div className="dpl-vault2-scrim" onClick={() => setPalette(null)}>
          <div className="dpl-vault2-quick" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus placeholder="命令：输入名称…" value={palette.query}
              onChange={(event) => setPalette({ query: event.target.value, active: 0 })}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { setPalette(null); return; }
                // Fix E: same ring navigation as the quick switcher.
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  if (paletteResults.length === 0) return;
                  event.preventDefault();
                  const delta = event.key === 'ArrowDown' ? 1 : -1;
                  const count = paletteResults.length;
                  const next = (((palette.active ?? 0) + delta) % count + count) % count;
                  setPalette({ ...palette, active: next });
                  window.requestAnimationFrame?.(() => {
                    document.querySelector('[data-testid="vault-palettelist"] button.is-active')?.scrollIntoView?.({ block: 'nearest' });
                  });
                  return;
                }
                if (event.key === 'Enter' && paletteResults[palette.active ?? 0]) {
                  const action = paletteResults[palette.active ?? 0];
                  setPalette(null);
                  action.run();
                }
              }}
            />
            <div className="dpl-vault2-quicklist" data-testid="vault-palettelist">
              {paletteResults.map((action, index) => (
                <button
                  key={action.id} type="button"
                  className={index === (palette.active ?? 0) ? 'is-active' : ''}
                  onClick={() => { setPalette(null); action.run(); }}
                >
                  <span className="dpl-truncate">{action.label}</span>
                </button>
              ))}
              {palette && palette.query.trim() !== '' && paletteResults.length === 0 ? <div className="dpl-vault2-empty">无匹配命令</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {trash ? (
        <div className="dpl-vault2-scrim" onClick={() => setTrash(null)}>
          <div className="dpl-vault2-quick dpl-vault2-trash" onClick={(event) => event.stopPropagation()}>
            <div className="dpl-vault2-trashhead">
              <strong>回收站 · {trash.length} 条</strong>
              <button type="button" className="dpl-icon-btn" onClick={() => setTrash(null)} aria-label="关闭"><X size={14} /></button>
            </div>
            <div className="dpl-vault2-quicklist">
              {trash.map((entry) => (
                <div key={entry.id} className="dpl-vault2-trashrow">
                  <div className="dpl-vault2-trashinfo">
                    <span className="dpl-truncate">{entry.title}</span>
                    <span className="dpl-vault2-filedir">{entry.entryKind === 'directory' ? '文件夹' : '文件'} · {entry.deletedAt ? new Date(entry.deletedAt).toLocaleString('zh-Hans-CN') : ''}</span>
                  </div>
                  <button type="button" className="dpl-btn dpl-sm" onClick={() => void restoreTrash(entry.id)}>恢复</button>
                </div>
              ))}
              {trash.length === 0 ? <div className="dpl-vault2-empty">回收站是空的</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {conflict ? (
        <Modal title="保存冲突" onClose={() => setConflict(null)}>
          <p>磁盘上的文件已被其他程序修改（可能是 Droplets 桌面端或 Agent）。</p>
          {conflict.currentExcerpt ? <blockquote className="dpl-conflict-excerpt">{conflict.currentExcerpt}</blockquote> : null}
          <div className="dpl-form-row">
            {/* Fix A: 重载 now reads the disk version into the tab (was a no-op
                openPath early-return); 另存副本 keeps both sides (see
                saveConflictCopy). */}
            <button type="button" className="dpl-btn" onClick={() => { const target = conflict.tabId ?? conflict.path; setConflict(null); void reloadTab(target); }}>重载</button>
            <button type="button" className="dpl-btn" onClick={() => { void saveConflictCopy(conflict); }}>另存副本</button>
            <button type="button" className="dpl-btn is-danger" onClick={() => { const tabId = conflict.tabId ?? activeTabId; setConflict(null); void flushSave(tabId, { force: true }); }}>覆盖保存</button>
          </div>
        </Modal>
      ) : null}

      {creating ? (
        <Modal title={creating.kind === 'dir' ? '新建文件夹' : '新建笔记'} onClose={() => setCreating(null)}>
          <div className="dpl-form-col">
            <div className="dpl-field">
              <span>位置</span>
              {/* Fix J: editable with a datalist of indexed dirs (was read-only
                  display). Empty string = vault 根. */}
              <input
                value={creating.dir ?? ''} placeholder="(vault 根)" list="vault-dirs" spellCheck={false}
                onChange={(event) => setCreating({ ...creating, dir: event.target.value, error: null })}
              />
              <datalist id="vault-dirs">
                {vaultDirs.map((dir) => <option key={dir} value={dir} />)}
              </datalist>
            </div>
            <div className="dpl-field">
              <span>名称</span>
              <input
                autoFocus value={creating.name}
                onChange={(event) => setCreating({ ...creating, name: event.target.value, error: null })}
                onKeyDown={(event) => { if (event.key === 'Enter') void submitCreate(); }}
              />
            </div>
            {/* Fix D: name collisions used to announce themselves only in the
                statusbar, which this very modal covers. */}
            {creating.error ? <p className="dpl-dialog-error">{creating.error}</p> : null}
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
              <span>新名称</span>
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
            {renaming.path.toLowerCase().endsWith('.md') ? (
              <p className="dpl-hint">
                {renamePreview === null ? '正在统计引用…' : renamePreview > 0 ? `将全库更新 ${renamePreview} 处指向它的 [[链接]]。` : '没有别的笔记引用它。'}
              </p>
            ) : <p className="dpl-hint">将移动整个文件夹（其中的笔记链接保持不变）。</p>}
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

      {moveTarget ? (
        <Modal title="移动到…" onClose={() => setMoveTarget(null)}>
          <div className="dpl-form-col">
            <div className="dpl-field">
              <span>目标文件夹（空 = vault 根）</span>
              <input
                autoFocus value={moveTarget.dir}
                onChange={(event) => setMoveTarget({ ...moveTarget, dir: event.target.value })}
                onKeyDown={(event) => { if (event.key === 'Enter') void submitMove(moveTarget.dir); }}
              />
            </div>
            <p className="dpl-hint">移动 .md 会同步更新全库指向它的 [[链接]]。</p>
          </div>
          <div className="dpl-form-row dpl-end">
            <button type="button" className="dpl-btn" onClick={() => setMoveTarget(null)}>取消</button>
            <button type="button" className="dpl-btn is-primary" onClick={() => void submitMove(moveTarget.dir)}>移动</button>
          </div>
        </Modal>
      ) : null}

      {ctxMenu ? (
        <VaultContextMenu
          menu={ctxMenu}
          clipboard={clipboard}
          onClose={() => setCtxMenu(null)}
          actions={{
            openFile: (path) => void openPath(path),
            toggleDir: (dir) => {
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(dir)) next.delete(dir); else next.add(dir);
                return next;
              });
            },
            rename: (path) => startRename(path),
            move: (path) => setMoveTarget({ path, name: path.split('/').pop(), dir: path.split('/').slice(0, -1).join('/') }),
            cut: (path) => setClipboard({ mode: 'cut', path, name: path.split('/').pop() }),
            duplicate: (path) => void duplicatePath(path),
            copyAbs: (path) => { void api.vaultCopyPath({ path, relative: false }).then(() => flashNotice('已复制路径')).catch((cause) => flashError(String(cause?.message ?? cause))); },
            copyRel: (path) => { void api.vaultCopyPath({ path, relative: true }).then(() => flashNotice('已复制相对路径')).catch((cause) => flashError(String(cause?.message ?? cause))); },
            copy: (path) => setClipboard({ mode: 'copy', path, name: path.split('/').pop() }),
            paste: (dir) => void pasteInto(dir),
            reveal: (path) => { void api.vaultReveal({ path }).catch((cause) => flashError(String(cause?.message ?? cause))); },
            askAi: (path) => void askAiNote(path),
            delete: trashPath,
            newNote: (dir) => setCreating({ kind: 'note', name: '', dir }),
            newFolder: (dir) => setCreating({ kind: 'dir', name: '', dir }),
          }}
        />
      ) : null}
    </div>
  );
}

/** Native-parity tree context menu (file/folder groupings, paste on cut). */
function VaultContextMenu({ menu, clipboard, onClose, actions }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const act = (fn) => () => { onClose(); fn(); };
  const t = menu;
  const isFile = t.kind === 'file';
  const items = [];
  if (isFile) {
    items.push(
      { label: '打开', run: () => actions.openFile(t.path) },
      { label: '重命名', run: () => actions.rename(t.path) },
      { label: '移动到…', run: () => actions.move(t.path) },
      { divider: true },
      { label: '剪切', run: () => actions.cut(t.path) },
      // Fix K: 复制 now means clipboard-copy (paste with the copy branch);
      // the old behavior — materialize a duplicate right here — moved to its
      // own 创建副本 item.
      { label: '复制', run: () => actions.copy(t.path) },
      { label: '创建副本', run: () => actions.duplicate(t.path) },
      { label: '复制路径', run: () => actions.copyAbs(t.path) },
      { label: '复制相对路径', run: () => actions.copyRel(t.path) },
      { divider: true },
      { label: '在 Finder 中显示', run: () => actions.reveal(t.path) },
      { label: '问 AI（这篇）', run: () => actions.askAi(t.path) },
      { divider: true },
      { label: '删除', danger: true, run: () => actions.delete(t.path, t.name) },
    );
  } else {
    const isRoot = t.path === '';
    items.push(
      { label: '新建笔记', run: () => actions.newNote(t.path) },
      { label: '新建文件夹', run: () => actions.newFolder(t.path) },
    );
    if (!isRoot) items.push({ label: '重命名', run: () => actions.rename(t.path) });
    items.push({ divider: true });
    if (!isRoot) items.push({ label: '剪切', run: () => actions.cut(t.path) });
    if (!isRoot) items.push({ label: '复制', run: () => actions.copy(t.path) });
    if (!isRoot) items.push({ label: '创建副本', run: () => actions.duplicate(t.path) });
    items.push({ label: '复制路径', run: () => actions.copyAbs(t.path) });
    if (!isRoot) items.push({ label: '复制相对路径', run: () => actions.copyRel(t.path) });
    // Fix K: paste works for any non-empty clipboard (copy included, not
    // just cut) — pasteInto's copy branch handles both files and folders.
    if (clipboard) items.push({ label: '粘贴', run: () => actions.paste(t.path) });
    items.push({ divider: true });
    items.push({ label: '在 Finder 中显示', run: () => actions.reveal(t.path) });
  }
  return (
    <div
      className="dpl-vault2-ctxmenu"
      style={{ left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 320) }}
      onMouseDown={(event) => event.stopPropagation()}
      data-testid="vault-context-menu"
    >
      {items.map((item, index) => (item.divider
        ? <div key={`d${index}`} className="dpl-vault2-ctxdivider" />
        : (
          <button
            key={item.label} type="button"
            className={'dpl-vault2-ctxitem' + (item.danger ? ' is-danger' : '')}
            onClick={act(item.run)}
          >
            {item.label}
          </button>
        )))}
    </div>
  );
}

/** Dot toolbar that reveals icon actions on hover (native tree toolbar). */
const SORT_MODES = [
  ['name-asc', '名称 ↑'],
  ['name-desc', '名称 ↓'],
  ['mtime-desc', '时间 ↓'],
  ['mtime-asc', '时间 ↑'],
];

function TreeToolbar({ filterOpen, onToggleFilter, sortKey, onSort, autoReveal, onToggleAutoReveal, onCollapseAll, onNewNote, onNewFolder }) {
  const [sortMenu, setSortMenu] = useState(null);
  const [help, setHelp] = useState(false);
  const sortLabel = SORT_MODES.find(([mode]) => mode === sortKey)?.[1] ?? '名称 ↑';
  return (
    <div className="dpl-vault2-tbrow" data-testid="vault-tree-toolbar">
      <div className="dpl-vault2-tbdots"><span /><span /><span /><span /><span /></div>
      <div className="dpl-vault2-tbactions" data-testid="vault-tree-toolbar-actions">
        <button type="button" title="新建笔记" onClick={onNewNote} data-testid="vault-tb-new-note"><Plus size={13} /></button>
        <button type="button" title="新建文件夹" onClick={onNewFolder} data-testid="vault-tb-new-folder"><FolderPlus size={13} /></button>
        <button type="button" title="帮助" onClick={() => setHelp(!help)} data-testid="vault-tb-help"><HelpCircle size={13} /></button>
        <button type="button" title="过滤" className={filterOpen ? 'is-on' : ''} onClick={onToggleFilter} data-testid="vault-tb-filter"><Filter size={13} /></button>
        <div className="dpl-relative">
          <button type="button" title={`排序：${sortLabel}`} onClick={() => setSortMenu(!sortMenu)} data-testid="vault-tb-sort"><ArrowUpDown size={13} /></button>
          {sortMenu ? (
            <PopMenu onClose={() => setSortMenu(null)}>
              {SORT_MODES.map(([mode, label]) => (
                <button key={mode} type="button" className="dpl-vault2-ctxitem" onClick={() => { onSort(mode); setSortMenu(null); }}>
                  {mode === sortKey ? <Check size={12} /> : null}
                  {label}
                </button>
              ))}
            </PopMenu>
          ) : null}
        </div>
        <button type="button" title="自动定位打开的笔记" className={autoReveal ? 'is-on' : ''} onClick={onToggleAutoReveal} data-testid="vault-tb-autoreveal"><LocateFixed size={13} /></button>
        <button type="button" title="全部折叠" onClick={onCollapseAll} data-testid="vault-tb-collapse-all"><ChevronsDownUp size={13} /></button>
      </div>
      {help ? (
        <PopMenu onClose={() => setHelp(false)} wide>
          <div className="dpl-vault2-helplist">
            <div className="dpl-vault2-helprow"><kbd>⌘P</kbd><span>快速切换</span></div>
            <div className="dpl-vault2-helprow"><kbd>⌘⇧F</kbd><span>全库搜索</span></div>
            <div className="dpl-vault2-helprow"><kbd>⌘⇧P</kbd><span>命令面板</span></div>
            <div className="dpl-vault2-helprow"><kbd>⌘E</kbd><span>切换视图</span></div>
            <div className="dpl-vault2-helprow is-plain"><span>右键文件/文件夹有完整操作</span></div>
          </div>
        </PopMenu>
      ) : null}
    </div>
  );
}

/** Small popover menu anchored to its wrapper (top-full right-0). */
function PopMenu({ onClose, children, wide }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('mousedown', close);
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div className={'dpl-vault2-popmenu' + (wide ? ' is-wide' : '')} onMouseDown={(event) => event.stopPropagation()}>
      {children}
    </div>
  );
}

/** Lazy tree: directories load on expand; state stays in the parent. */
function TreePane({ api, expanded, setExpanded, activePath, sortKey, onOpen, onContextMenu }) {
  const [roots, setRoots] = useState(null);
  const load = useCallback(async (dir) => {
    try {
      const { entries } = await api.vaultList(dir);
      setRoots((current) => ({ ...current, [dir]: entries }));
    } catch {
      // 失败也给空数组：spinner 不能永远转（重试走折叠再展开）。
      setRoots((current) => ({ ...current, [dir]: [] }));
    }
  }, [api]);

  useEffect(() => { void load(''); }, [load]);

  // 持久化恢复 / autoreveal 直接往 expanded 里加目录，但从未触发加载——
  // 任何「已展开但未加载」的目录都在这里补一次 load（幂等，roots 命中即跳过）。
  useEffect(() => {
    if (!roots) return;
    for (const dir of expanded) {
      if (roots[dir] === undefined) void load(dir);
    }
  }, [expanded, roots, load]);

  const toggle = (dir) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  };

  const sortEntries = (entries) => {
    const dirs = entries.filter((entry) => entry.kind === 'dir').sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    const files = entries.filter((entry) => entry.kind === 'file');
    const sorted = [...files].sort((a, b) => {
      switch (sortKey) {
        case 'name-desc': return b.name.localeCompare(a.name, 'zh-Hans-CN');
        case 'mtime-desc': return (b.mtime ?? 0) - (a.mtime ?? 0) || a.name.localeCompare(b.name);
        case 'mtime-asc': return (a.mtime ?? 0) - (b.mtime ?? 0) || a.name.localeCompare(b.name);
        default: return a.name.localeCompare(b.name, 'zh-Hans-CN');
      }
    });
    return [...dirs, ...sorted];
  };

  if (!roots || !roots['']) {
    return <div className="dpl-vault2-empty"><Loader2 size={14} className="dpl-spin" /> 加载中…</div>;
  }

  const renderEntries = (entries) => (
    <>
      {sortEntries(entries).map((entry) => (
        entry.kind === 'dir' ? (
          <div key={entry.path}>
            <div
              className={'dpl-vault2-row' + (expanded.has(entry.path) ? ' is-open' : '')}
              onContextMenu={(event) => onContextMenu(event, 'folder', entry.path, entry.name)}
            >
              <button type="button" className="dpl-vault2-dir" onClick={() => toggle(entry.path)}>
                <span className="dpl-vault2-chevron">{expanded.has(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                {expanded.has(entry.path) ? <FolderOpen size={13} /> : <Folder size={13} />}
                <span className="dpl-truncate">{entry.name}</span>
              </button>
            </div>
            {expanded.has(entry.path) ? (
              <div className="dpl-vault2-children">
                {roots[entry.path]
                  ? renderEntries(roots[entry.path])
                  : <div className="dpl-vault2-loading"><Loader2 size={11} className="dpl-spin" /></div>}
              </div>
            ) : null}
          </div>
        ) : (
          <div
            key={entry.path}
            className={'dpl-vault2-row' + (activePath === entry.path ? ' is-active' : '')}
            onContextMenu={(event) => onContextMenu(event, 'file', entry.path, entry.name)}
          >
            <button type="button" className="dpl-vault2-file" onClick={() => onOpen(entry.path)}>
              <FileText size={13} />
              <span className="dpl-truncate">{entry.name.replace(/\.md$/i, '')}</span>
            </button>
          </div>
        )
      ))}
    </>
  );

  return (
    <div className="dpl-vault2-treeroot">
      {renderEntries(roots[''])}
    </div>
  );
}

const MODE_ITEMS = [
  { id: 'source', label: '源码模式', Icon: SquareCode },
  { id: 'live', label: '实时预览', Icon: Eye },
  { id: 'read', label: '阅读视图', Icon: BookOpen },
];

/** One tab: breadcrumb bar (mode dropdown + … menu) + CM6/read + AuxRail hooks. */
const NoteReadPane = forwardRef(function NoteReadPane({
  tab, onDraft, onSave, onDiscard, onWikilink, onMaterial, onOutlineChange, onEditorScroll,
  resolveImage, pasteImage, noteFiles, readerRef, backlinksOpen, onToggleBacklinks, onExport,
  onPrefChange,
}, forwardedRef) {
  // Fix G: view/lineNumbers/wrap live on the tab (written back through
  // onPrefChange), so switching tabs preserves the editing mode instead of
  // remounting this pane with `key`. Known limitation: CM6 undo history is
  // NOT restored across tab switches — serializing EditorState is out of
  // scope for this fix round.
  const view = tab.view ?? 'read';
  const lineNumbers = tab.lineNumbers ?? true;
  const wrap = tab.wrap ?? true;
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [modeMenu, setModeMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const outlineRef = useRef([]);

  // Fix G: latest-callback indirection. The editor instance survives tab
  // switches now, but its extensions capture the props from creation time —
  // a stale onDraft would write the draft onto the *previous* tab. Routing
  // through this ref always hits the current tab's closures.
  const latestProps = useRef({});
  latestProps.current = { onDraft, onOutlineChange, onEditorScroll, resolveImage, pasteImage, onWikilink, noteFiles };

  /**
   * Fix G: per-tab scroll memory. Read view saves on the readerscroll div's
   * scroll event; editor modes save inside the (already debounced) CM6 scroll
   * handler. Restored on [tab.id, view] once the new DOM settles. Limitation:
   * memory lives in this component — leaving the vault space (unmount) drops
   * it, and only scrollTop is restored, never the undo stack.
   */
  const scrollMemory = useRef(new Map());
  const tabIdRef = useRef(tab.id);
  // Programmatic setDoc swaps (tab switches / external reloads) must not be
  // mistaken for user input — CM6's updateListener fires for dispatched
  // changes too, which would dirty the incoming tab with its own content.
  const suppressDocFeedback = useRef(false);

  const dirty = tab.dirty === true; // see the root-cause note on `tabs` above
  const text = dirty ? tab.draft : tab.content;
  const segments = tab.path.split('/');
  const ModeIcon = view === 'source' ? SquareCode : view === 'live' ? Eye : BookOpen;
  const viewLabel = MODE_ITEMS.find((item) => item.id === view)?.label ?? view;

  useEffect(() => {
    if (view === 'read' || !hostRef.current) {
      if (editorRef.current) { editorRef.current.destroy(); editorRef.current = null; }
      onOutlineChange(null);
      return undefined;
    }
    const editor = createVaultEditor(hostRef.current, {
      doc: text,
      mode: view,
      lineNumbers,
      wrap,
      resolveImage: (src) => latestProps.current.resolveImage?.(src),
      pasteImage: (base64, name) => latestProps.current.pasteImage?.(base64, name),
      // Proxy: the completion source reads the note list only when the
      // autocomplete runs, so forward property access to the latest array
      // without recreating the editor on every index refresh.
      noteFiles: new Proxy([], {
        get(target, prop, receiver) {
          const files = latestProps.current.noteFiles ?? [];
          const value = Reflect.get(files, prop, files);
          return typeof value === 'function' ? value.bind(files) : value;
        },
      }),
      onWikilink: (target) => latestProps.current.onWikilink?.(target),
      onChange: (next) => {
        if (suppressDocFeedback.current) return; // programmatic setDoc, not user input
        outlineRef.current = outlineOf(editorRef.current?.view.state ?? editor.view.state);
        latestProps.current.onOutlineChange?.(outlineRef.current);
        reportActive();
        latestProps.current.onDraft?.(next);
      },
    });
    editorRef.current = editor;
    outlineRef.current = outlineOf(editor.view.state);
    onOutlineChange(outlineRef.current);

    // Active-outline tracking for editor modes (plan §5.2): positions come
    // from the CM6 document model, never from DOM h-tags (CM6 renders none).
    // Debounced 120ms so fast scrolling stays cheap.
    const reportActive = () => {
      latestProps.current.onEditorScroll?.(activeOutlineIndex(editor.view, outlineRef.current ?? []));
    };
    let scrollTimer = null;
    const onEditorScrollDom = () => {
      if (scrollTimer !== null) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        scrollMemory.current.set(tabIdRef.current, editor.view.scrollDOM.scrollTop); // fix G
        reportActive();
      }, 120);
    };
    editor.view.scrollDOM.addEventListener('scroll', onEditorScrollDom, { passive: true });
    reportActive();

    return () => {
      clearTimeout(scrollTimer);
      editor.view.scrollDOM.removeEventListener('scroll', onEditorScrollDom);
      editor.destroy();
      editorRef.current = null;
      onOutlineChange(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Fix G: swap the document when the tab changes even if it is dirty (the
  // editor must never show another tab's text); while editing the same tab,
  // the draft equals the doc so this stays a no-op and the debounce lives on.
  const loadedTabIdRef = useRef(tab.id);
  useEffect(() => {
    const editor = editorRef.current;
    const docChanged = editor && editor.view.state.doc.toString() !== text;
    const tabChanged = loadedTabIdRef.current !== tab.id;
    if (docChanged && (!dirty || tabChanged)) {
      suppressDocFeedback.current = true;
      try { editor.setDoc(text); } finally { suppressDocFeedback.current = false; }
      outlineRef.current = outlineOf(editor.view.state);
      onOutlineChange(outlineRef.current);
      onEditorScroll(activeOutlineIndex(editor.view, outlineRef.current ?? []));
    }
    loadedTabIdRef.current = tab.id;
    tabIdRef.current = tab.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, dirty, tab.id]);

  // Fix G: restore the incoming tab's scroll position (read view element is
  // committed by now; the editor was created by the [view] effect above,
  // which runs before this one).
  useEffect(() => {
    const apply = () => {
      const el = view === 'read' ? readerRef?.current : editorRef.current?.view.scrollDOM;
      const top = scrollMemory.current.get(tab.id);
      if (el && typeof top === 'number') el.scrollTop = top;
    };
    apply();
    const raf = window.requestAnimationFrame?.(apply);
    return () => { if (raf) window.cancelAnimationFrame?.(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, view]);

  const setMode = (next) => {
    if (next === view) return;
    setModeMenu(false);
    onPrefChange?.({ view: next });
  };

  // ⌘E cycles read → live → source → read.
  // ⌘S forces an immediate flush of the active tab (plan D4: an insurance
  // path, not the regular save route — autosave already runs at 800 ms).
  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        setMode(view === 'read' ? 'live' : view === 'live' ? 'source' : 'read');
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSave?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // tab.id: the pane now persists across tab switches (fix G) — resubscribe
    // so ⌘E/⌘S act on the freshly active tab, not a stale closure.
  }, [view, onSave, tab.id]);

  const jumpTo = (index) => {
    if (view === 'read') {
      const heading = markdownHeadings(text)[index];
      if (!heading || !readerRef?.current) return;
      const nodes = readerRef.current.querySelectorAll('h2, h3, h4, h5, h6');
      const node = [...nodes].find((candidate) => candidate.textContent === heading.text)
        ?? [...nodes][index] ?? null;
      node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (editorRef.current) {
      const entry = outlineRef.current[index];
      if (entry) {
        scrollToHeading(editorRef.current.view, entry.from);
        onEditorScroll(activeOutlineIndex(editorRef.current.view, outlineRef.current ?? []));
      }
    }
  };

  useImperativeHandle(forwardedRef, () => ({ jumpToHeading: jumpTo }), [jumpTo]);

  const fmt = (Icon, title, run, extraClass = '') => (
    <button
      key={title} type="button" title={title}
      className={'dpl-vault2-fmtbtn ' + extraClass}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => { if (editorRef.current) run(editorRef.current.view); }}
    >
      <Icon size={14} />
    </button>
  );

  return (
    <div className="dpl-vault2-note" data-view={view}>
      <div className="dpl-vault2-crumbbar">
        <div className="dpl-vault2-crumb">
          {segments.map((segment, index) => (
            <span key={index} className={index === segments.length - 1 ? 'is-last' : ''}>
              {index > 0 ? <span className="dpl-vault2-crumbsep">/</span> : null}
              {segment.replace(/\.md$/i, '')}
            </span>
          ))}
        </div>
        <div className="dpl-vault2-crumbright">
          {dirty ? (
            <>
              <button type="button" className="dpl-btn dpl-sm dpl-primary-solid" onClick={onSave}>保存</button>
              <button type="button" className="dpl-btn dpl-sm" onClick={onDiscard}>放弃</button>
            </>
          ) : null}
          <div className="dpl-relative">
            <button
              type="button" className="dpl-vault2-crumbbtn dpl-vault2-modelabel" data-view-current={view} title={`切换视图 (⌘E) · 当前：${viewLabel}`}
              onClick={() => { setModeMenu(!modeMenu); setMoreMenu(false); }}
              data-testid="vault-mode"
            >
              <ModeIcon size={14} />
              <span className="dpl-vault2-modetext">{viewLabel}</span>
              <ChevronDown size={12} />
            </button>
            {modeMenu ? (
              <PopMenu onClose={() => setModeMenu(false)}>
                {MODE_ITEMS.map(({ id, label, Icon }) => (
                  <button key={id} type="button" className="dpl-vault2-ctxitem" onClick={() => setMode(id)} data-testid={`vault-mode-${id}`}>
                    <Icon size={13} /> {label} {view === id ? <Check size={12} /> : null}
                  </button>
                ))}
              </PopMenu>
            ) : null}
          </div>
          <div className="dpl-relative">
            <button
              type="button" className="dpl-vault2-crumbbtn" title="更多"
              onClick={() => { setMoreMenu(!moreMenu); setModeMenu(false); }}
              data-testid="vault-more"
            >
              <MoreIcon />
            </button>
            {moreMenu ? (
              <PopMenu onClose={() => setMoreMenu(false)}>
                <button type="button" className="dpl-vault2-ctxitem" onClick={() => { setMoreMenu(false); onToggleBacklinks(); }} data-testid="backlinks-toggle">
                  反向链接 {backlinksOpen ? <Check size={12} /> : null}
                </button>
                {view !== 'read' ? (
                  <button type="button" className="dpl-vault2-ctxitem" onClick={() => { setMoreMenu(false); if (editorRef.current) openSearchPanel(editorRef.current.view); }} data-testid="vault-more-find">
                    查找 / 替换
                  </button>
                ) : null}
                <div className="dpl-vault2-ctxdivider" />
                <button type="button" className="dpl-vault2-ctxitem" onClick={() => { setMoreMenu(false); onExport('pdf'); }} data-testid="vault-more-export-pdf">导出为 PDF…</button>
                <button type="button" className="dpl-vault2-ctxitem" onClick={() => { setMoreMenu(false); onExport('html'); }} data-testid="vault-more-export-html">导出为 HTML…</button>
                <div className="dpl-vault2-ctxdivider" />
                <button type="button" className="dpl-vault2-ctxitem" onClick={() => setToolbarVisible(!toolbarVisible)} data-testid="vault-more-toolbar">
                  格式工具栏 {toolbarVisible ? <Check size={12} /> : null}
                </button>
                {view !== 'read' ? (
                  <>
                    <button type="button" className="dpl-vault2-ctxitem" onClick={() => { onPrefChange?.({ lineNumbers: !lineNumbers }); editorRef.current?.setLineNumbers(!lineNumbers); }} data-testid="vault-more-line-numbers">
                      行号 {lineNumbers ? <Check size={12} /> : null}
                    </button>
                    <button type="button" className="dpl-vault2-ctxitem" onClick={() => { onPrefChange?.({ wrap: !wrap }); editorRef.current?.setWrap(!wrap); }} data-testid="vault-more-wrap">
                      自动换行 {wrap ? <Check size={12} /> : null}
                    </button>
                  </>
                ) : null}
              </PopMenu>
            ) : null}
          </div>
        </div>
      </div>

      {view !== 'read' && toolbarVisible ? (
        <div className="dpl-vault2-fmtbar" data-testid="vault-format-toolbar">
          {fmt(({ size }) => <span style={{ fontWeight: 700, fontSize: size - 1 }}>H</span>, '标题', cycleHeading)}
          {fmt(({ size }) => <span style={{ fontWeight: 700 }}>B</span>, '粗体', (view2) => wrapRange(view2, '**'))}
          {fmt(({ size }) => <span style={{ fontStyle: 'italic' }}>I</span>, '斜体', (view2) => wrapRange(view2, '*'))}
          {fmt(({ size }) => <span style={{ textDecoration: 'line-through' }}>S</span>, '删除线', (view2) => wrapRange(view2, '~~'))}
          {fmt(Link2, '链接', (view2) => {
            const sel = view2.state.sliceDoc(view2.state.selection.main.from, view2.state.selection.main.to) || '文本';
            insertAtCursor(view2, `[${sel}](url)`, (view2.state.selection.main.from) + sel.length + 3);
          })}
          {fmt(List, '无序列表', (view2) => toggleLinePrefixes(view2, '- '))}
          {fmt(ListOrdered, '有序列表', (view2) => toggleLinePrefixes(view2, '1. '))}
          {fmt(CheckSquare, '任务列表', (view2) => toggleLinePrefixes(view2, '- [ ] '))}
          {fmt(Quote, '引用', (view2) => toggleLinePrefixes(view2, '> '))}
          {fmt(Minus, '分隔线', (view2) => insertAtCursor(view2, '\n---\n'))}
          {fmt(Code2, '代码', codeTransform)}
          {fmt(Table, '表格', insertTable)}
          {fmt(Undo2, '撤销', (view2) => view2.undo?.())}
          {fmt(Redo2, '重做', (view2) => view2.redo?.())}
          {fmt(ImagePlus, '图片', (view2) => insertAtCursor(view2, '![描述](attachments/图片.png)', 3))}
          <div className="dpl-vault2-fmtmore">
            <button type="button" className="dpl-vault2-fmtbtn" title="更多格式" onMouseDown={(event) => event.preventDefault()} onClick={(event) => event.currentTarget.nextElementSibling?.classList.toggle('is-open')}>
              <MoreGlyph />
            </button>
            <div className="dpl-vault2-fmtmoremenu">
              {[
                { label: '高亮', run: (v) => wrapRange(v, '==') },
                { label: '双链', run: (v) => wrapRange(v, '[[', ']]') },
                { label: '嵌入', run: (v) => wrapRange(v, '![[' , ']]') },
                { label: 'Callout', run: (v) => toggleLinePrefixes(v, '> [!NOTE] ') },
                { label: '脚注', run: (v) => insertAtCursor(v, '[^1]', 1) },
                { label: '注释', run: (v) => wrapRange(v, '%%') },
              ].map((item) => (
                <button
                  key={item.label} type="button" className="dpl-vault2-ctxitem"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => { if (editorRef.current) item.run(editorRef.current.view); event.currentTarget.parentElement.classList.remove('is-open'); }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {view === 'read' ? (
        <div
          ref={readerRef} className="dpl-vault2-readerscroll"
          onScroll={(event) => scrollMemory.current.set(tab.id, event.currentTarget.scrollTop)}
        >
          <MarkdownView className="dpl-note-body dpl-vault2-body" markdown={text} onWikilink={onWikilink} resolveImage={resolveImage} />
          <div className="dpl-vault2-bodyend" />
        </div>
      ) : (
        <div className="dpl-vault2-editwrap">
          <div ref={hostRef} className="dpl-vault2-cmhost" data-testid="vault-editor" />
        </div>
      )}
    </div>
  );
});

function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

function MoreGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function GraphPane({ graph, layout, onOpen, onClose }) {
  const width = 640;
  const height = 760;
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
