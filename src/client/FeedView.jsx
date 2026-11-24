import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, CheckCheck, Circle, CircleCheck, ExternalLink, FileText, Inbox, Loader2,
  RefreshCw,
} from 'lucide-react';
import { PanelCollapseButton, PanelGroup, PanelRail } from './feed/PanelGroup.jsx';
import { SourcesPane, FeedBadge } from './feed/SourcesPane.jsx';
import { ManageTable } from './feed/ManageTable.jsx';
import { AuxRail, htmlHeadings } from './feed/AuxRail.jsx';
import { DEFAULT_FEED_SORT_MODE, partitionFeedItems, snapshotReadItems } from './feed/feed-sorting.js';
import { formatWhen, formatWhenFull } from './feed/format.js';
import { SafeHtml } from './components.jsx';
import { markdownToHtml } from './md.js';
import { t } from './i18n.js';

// droplets D09: open-on-hover is an opt-in setting; the default is click.
// Opening marks unseen → seen, so hover-opening by default would let a
// careless sweep of the list silently mutate read state (not undoable).
// Hover-to-open stays off unless enabled in settings (droplets default too).
const STATE_LABEL = { unseen: '未读', seen: '已读', skipped: '略过' };

/**
 * The feed page, a 1:1 port of droplets' FeedPage:
 * sources │ items │ preview (+ manage view swap), droplets state semantics
 * (sourceId/group mutually exclusive, three-state items, frozen partition,
 * new-entries pill, auto-select, sticky round actions, AuxRail).
 */
export function FeedView({ api, onMaterial, onJumpSpace, onOpenVaultNote }) {
  const [feeds, setFeeds] = useState([]);
  const [managing, setManaging] = useState(false);
  const [sourceId, setSourceId] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [selected, setSelected] = useState(null);
  const [spinning, setSpinning] = useState(false);
  const refreshTick = useRef(0);
  // Bumped after a successful refresh so ItemList reloads its items and the
  // 「新增 N 条」 pill can count entries that arrived with the refresh.
  const [itemsVersion, setItemsVersion] = useState(0);

  // Optimistic unread adjustment: the source badge and the 全部源 total must
  // drop the moment an item is read, not after the host round-trip. loadFeeds
  // reconciles the authoritative numbers right after.
  const bumpUnread = useCallback((feedId, delta) => {
    if (typeof feedId !== 'string' || !delta) return;
    setFeeds((current) => current.map((feed) => (
      feed.id === feedId
        ? { ...feed, unreadCount: Math.max(0, (feed.unreadCount ?? 0) + delta) }
        : feed
    )));
  }, []);

  const loadFeeds = useCallback(async () => {
    try {
      const { feeds: next } = await api.listFeeds();
      setFeeds(next);
    } catch { /* surfaced by list load */ }
  }, [api]);

  // Per-feed favicons: one batched RPC (id → data URL), cached in state.
  // Reloaded after feeds change and once more shortly after a refresh so
  // icons acquired in the background during that refresh show up too.
  const [icons, setIcons] = useState({});
  const loadIcons = useCallback(async () => {
    try {
      const result = await api.feedIcons?.();
      if (result?.icons) setIcons(result.icons);
    } catch { /* icons are decorative */ }
  }, [api]);
  useEffect(() => { void loadIcons(); }, [loadIcons]);
  useEffect(() => { void loadIcons(); }, [loadIcons, feeds]);

  // Settings → 信息流「鼠标悬停自动打开阅读」
  const [hoverPreviewEnabled, setHoverPreviewEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    void api.getSettings?.().then((result) => {
      if (alive) setHoverPreviewEnabled(result?.settings?.hoverPreview === true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [api]);

  // Sources-pane sort mode & collapsed groups, held here so both views
  // (reading / managing) share them, persisted through the settings channel
  // the same way hoverPreview is read (sourcesSortMode / sourcesCollapsedGroups).
  const [sourcesSortMode, setSourcesSortMode] = useState(DEFAULT_FEED_SORT_MODE);
  const [sourcesCollapsedGroups, setSourcesCollapsedGroups] = useState(() => new Set());
  useEffect(() => {
    let alive = true;
    void api.getSettings?.().then((result) => {
      if (!alive) return;
      const settings = result?.settings ?? {};
      if (typeof settings.sourcesSortMode === 'string') setSourcesSortMode(settings.sourcesSortMode);
      if (Array.isArray(settings.sourcesCollapsedGroups)) {
        setSourcesCollapsedGroups(new Set(settings.sourcesCollapsedGroups.filter((group) => typeof group === 'string')));
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [api]);
  const changeSourcesSortMode = useCallback((mode) => {
    setSourcesSortMode(mode);
    void api.saveSettings?.({ sourcesSortMode: mode }).catch(() => {});
  }, [api]);
  const changeSourcesCollapsedGroups = useCallback((groups) => {
    setSourcesCollapsedGroups(groups);
    void api.saveSettings?.({ sourcesCollapsedGroups: [...groups] }).catch(() => {});
  }, [api]);

  useEffect(() => { void loadFeeds(); }, [loadFeeds]);

  const selectSource = (id) => { setSelectedGroup(null); setSourceId(id); setSelected(null); };
  const selectGroup = (group) => { setSourceId(null); setSelectedGroup(group === null ? null : group); setSelected(null); };

  const refresh = useCallback(async () => {
    const tick = ++refreshTick.current;
    setSpinning(true);
    try {
      await api.refresh();
      if (tick !== refreshTick.current) return;
      await loadFeeds();
      if (tick !== refreshTick.current) return;
      // Reload the item list for the current scope so new entries show up
      // (the list effect keys on this version). Selection is untouched.
      setItemsVersion((value) => value + 1);
      // Icons are fetched best-effort in the background during refresh;
      // give them a moment, then pick up whatever landed.
      setTimeout(() => { if (tick === refreshTick.current) void loadIcons(); }, 12_000);
    } finally {
      if (tick === refreshTick.current) setSpinning(false);
    }
  }, [api, loadFeeds, loadIcons]);

  const onChanged = useCallback(async () => { await loadFeeds(); }, [loadFeeds]);

  if (managing) {
    return (
      <PanelGroup
        page="feed-manage"
        panels={[
          { id: 'sources', initialWidth: 240, minWidth: 205, collapsible: true, render: ({ collapsed, expand, collapse }) => (
            <SourcesPane
              api={api} feeds={feeds} icons={icons} sourceId={sourceId} selectedGroup={selectedGroup}
              spinning={spinning} onRefresh={() => void refresh()}
              onManage={() => setManaging(false)}
              onSelectSource={selectSource} onSelectGroup={selectGroup}
              sortMode={sourcesSortMode} onSortModeChange={changeSourcesSortMode}
              collapsedGroups={sourcesCollapsedGroups} onCollapsedGroupsChange={changeSourcesCollapsedGroups}
              collapsed={collapsed} onExpand={expand} onCollapse={collapse}
            />
          ) },
          { id: 'manage', initialWidth: 900, minWidth: 480, collapsible: false, render: () => (
            <ManageTable api={api} feeds={feeds} onBack={() => setManaging(false)} onChanged={onChanged} />
          ) },
        ]}
      />
    );
  }

  return (
    <PanelGroup
      page="feed"
      panels={[
        { id: 'sources', initialWidth: 240, minWidth: 205, collapsible: true, render: ({ collapsed, expand, collapse }) => (
          <SourcesPane
            api={api} feeds={feeds} icons={icons} sourceId={sourceId} selectedGroup={selectedGroup}
            spinning={spinning} onRefresh={() => void refresh()}
            onManage={() => setManaging(true)}
            onSelectSource={selectSource} onSelectGroup={selectGroup}
            sortMode={sourcesSortMode} onSortModeChange={changeSourcesSortMode}
            collapsedGroups={sourcesCollapsedGroups} onCollapsedGroupsChange={changeSourcesCollapsedGroups}
            collapsed={collapsed} onExpand={expand} onCollapse={collapse}
          />
        ) },
        { id: 'items', initialWidth: 320, minWidth: 240, collapsible: true, render: ({ collapsed, expand, collapse }) => (
          <ItemList
            api={api} feeds={feeds} icons={icons} sourceId={sourceId} selectedGroup={selectedGroup}
            itemsVersion={itemsVersion}
            selected={selected} onSelect={setSelected} onMaterial={onMaterial}
            onUnreadChange={bumpUnread}
            spinning={spinning} onRefresh={() => void refresh()} onFeedsChanged={loadFeeds}
            onManage={() => setManaging(true)}
            collapsed={collapsed} onExpand={expand} onCollapse={collapse}
          />
        ) },
        { id: 'preview', initialWidth: 700, minWidth: 420, collapsible: false, render: () => (
          <Preview api={api} feeds={feeds} icons={icons} item={selected} onMaterial={onMaterial} onJumpSpace={onJumpSpace} onOpenVaultNote={onOpenVaultNote} onMarked={loadFeeds} onUnreadChange={bumpUnread} />
        ) },
      ]}
    />
  );
}

/** Items pane: title + pill + refresh + three-state filter + mark-all + «. */
function ItemList(props) {
  const { api, feeds, icons, sourceId, selectedGroup, itemsVersion, selected, onSelect, onMaterial, onUnreadChange, spinning, onRefresh, onFeedsChanged, onManage, collapsed, onExpand, onCollapse } = props;
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewFilter, setViewFilter] = useState('all');
  const [confirmMarkAllRead, setConfirmMarkAllRead] = useState(false);
  const [pill, setPill] = useState(0);
  const [notice, setNotice] = useState('');
  const listScroll = useRef(null);
  const hoverTimer = useRef(null);
  const visibleItems = useRef([]);
  const sessionKey = JSON.stringify([sourceId, selectedGroup, viewFilter]);
  const readSnapshot = useRef({ session: '', read: new Set() });
  const baseline = useRef({ session: '', keys: new Set() });

  const listTitle = selectedGroup !== null
    ? (selectedGroup === '' ? '未分组' : selectedGroup)
    : sourceId
      ? (feeds.find((f) => f.id === sourceId)?.title ?? '文章')
      : '文章';
  const feedsById = useMemo(() => new Map(feeds.map((f) => [f.id, f])), [feeds]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await api.listItems({
          sourceId: selectedGroup === null && sourceId ? sourceId : undefined,
          groupName: selectedGroup ?? undefined,
        });
        if (cancelled) return;
        setItems(result.items ?? []);
      } catch { if (!cancelled) setItems([]); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
    // itemsVersion: a refresh bumps it so the list reloads; selected stays
    // as-is (auto-select only fills an empty selection).
  }, [api, sourceId, selectedGroup, itemsVersion]);

  const partitioned = useMemo(() => {
    if (!loading && readSnapshot.current.session !== sessionKey) {
      readSnapshot.current = { session: sessionKey, read: snapshotReadItems(items) };
    }
    const filtered = viewFilter === 'all' ? items : items.filter((item) => item.state === viewFilter);
    return partitionFeedItems(filtered, readSnapshot.current.read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, loading, viewFilter, sessionKey]);

  visibleItems.current = partitioned;

  const newCount = useMemo(() => {
    if (loading) return 0;
    if (baseline.current.session !== sessionKey) {
      if (items.length === 0) return 0;
      baseline.current = { session: sessionKey, keys: new Set(items.map((item) => item.sourceId + ':' + item.key)) };
      return 0;
    }
    let count = 0;
    for (const item of items) if (!baseline.current.keys.has(item.sourceId + ':' + item.key)) count += 1;
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, loading, sessionKey, pill]);

  // Empty-selection auto-select: pure selection, never marks read.
  const firstItem = partitioned[0];
  useEffect(() => {
    if (!firstItem || selected !== null) return;
    onSelect({ ...firstItem });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstItem?.sourceId, firstItem?.key]);

  const unseenCount = items.filter((item) => item.state === 'unseen').length;

  // The dialog must quote the number the action will actually change. The
  // loaded list is capped (listItems ≤ 120/500), so counting its rows
  // under-reports a big feed — use the feed table's authoritative unread
  // count for the current scope instead.
  const scopeUnseen = (() => {
    if (typeof feeds?.[0]?.unreadCount !== 'number') return unseenCount;
    if (typeof sourceId === 'string' && sourceId) {
      const feed = feeds.find((entry) => entry.id === sourceId);
      return feed?.unreadCount ?? unseenCount;
    }
    if (selectedGroup !== null && selectedGroup !== undefined) {
      return feeds.filter((feed) => (feed.group ?? '') === selectedGroup)
        .reduce((sum, feed) => sum + (feed.unreadCount ?? 0), 0);
    }
    return feeds.reduce((sum, feed) => sum + (feed.unreadCount ?? 0), 0);
  })();

  // Optimistic-write rollback (D): when the host rejects a state change,
  // restore the row to its previous state — but only if the row still holds
  // the value this call wrote (idempotent: a newer action wins), and undo
  // the unread-count adjustment that went with it. The rollback request is
  // applied in an effect so the check runs against the post-optimistic
  // render; mirroring Preview's notice channel for the message.
  const [rollback, setRollback] = useState(null);
  useEffect(() => {
    if (!rollback) return;
    const { item, previous, state, cause } = rollback;
    setRollback(null);
    const row = items.find((entry) => entry.key === item.key && entry.sourceId === item.sourceId);
    if (!row || row.state !== state) return; // superseded by a newer action
    setItems((current) => current.map((entry) => (entry.key === item.key && entry.sourceId === item.sourceId ? { ...entry, state: previous } : entry)));
    if (previous === 'unseen' && state !== 'unseen') onUnreadChange?.(item.sourceId, 1);
    else if (previous !== 'unseen' && state === 'unseen') onUnreadChange?.(item.sourceId, -1);
    setNotice('标记失败：' + String(cause?.message ?? cause));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rollback]);
  const rollbackItemState = (item, previous, state, cause) => {
    setRollback({ item, previous, state, cause });
  };

  const markState = async (item, state) => {
    const previous = item.state;
    setItems((current) => current.map((entry) => (entry.key === item.key && entry.sourceId === item.sourceId ? { ...entry, state } : entry)));
    // unseen -> read removes one from the unread count, and vice versa.
    if (previous === 'unseen' && state !== 'unseen') onUnreadChange?.(item.sourceId, -1);
    else if (previous !== 'unseen' && state === 'unseen') onUnreadChange?.(item.sourceId, 1);
    try {
      await api.setItemState({ keys: [item.key], state });
      void onFeedsChanged();
    } catch (cause) {
      rollbackItemState(item, previous, state, cause);
    }
  };

  const openItem = (item) => {
    onSelect(item);
    onMaterial({ space: 'feed', key: item.key, title: item.title, url: item.link, content: '' });
    if (item.state === 'unseen') {
      const previous = item.state;
      setItems((current) => current.map((entry) => (entry.key === item.key && entry.sourceId === item.sourceId ? { ...entry, state: 'seen' } : entry)));
      onUnreadChange?.(item.sourceId, -1);
      void api.setItemState({ keys: [item.key], state: 'seen' })
        .then(() => onFeedsChanged())
        .catch((cause) => { rollbackItemState(item, previous, 'seen', cause); });
      onSelect({ ...item, state: 'seen' });
    }
  };

  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
  };
  useEffect(() => clearHoverTimer, []);

  // Keyboard navigation (M): j/k move the selection (cyclic), o/空格 open,
  // s 略过, m 标回未读, r 刷新. Plain keys only — modified keys stay with
  // the system; typing in an input never triggers list shortcuts.
  const currentEntry = () => {
    const list = visibleItems.current;
    if (list.length === 0) return null;
    if (selected !== null) {
      const match = list.find((entry) => entry.key === selected.key && entry.sourceId === selected.sourceId);
      if (match) return match;
    }
    return list[0];
  };

  const entryRow = (entry) => listScroll.current?.querySelector(
    '[data-entry="' + String(entry.sourceId + ':' + entry.key).replace(/"/g, '\\"') + '"]',
  );

  const handleListKeyDown = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const key = event.key;
    if (key === 'j' || key === 'k') {
      event.preventDefault();
      const list = visibleItems.current;
      if (list.length === 0) return;
      const delta = key === 'j' ? 1 : -1;
      const currentIndex = selected !== null
        ? list.findIndex((entry) => entry.key === selected.key && entry.sourceId === selected.sourceId)
        : -1;
      const nextIndex = currentIndex === -1
        ? (delta > 0 ? 0 : list.length - 1)
        : (currentIndex + delta + list.length) % list.length;
      const next = list[nextIndex];
      if (!next) return;
      onSelect({ ...next });
      entryRow(next)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (key === 'o' || key === ' ') {
      event.preventDefault();
      const current = currentEntry();
      if (current) openItem(current);
      return;
    }
    if (key === 's') {
      event.preventDefault();
      const current = currentEntry();
      if (current) void markState(current, 'skipped');
      return;
    }
    if (key === 'm') {
      event.preventDefault();
      const current = currentEntry();
      if (current) void markState(current, 'unseen');
      return;
    }
    if (key === 'r') {
      event.preventDefault();
      onRefresh();
    }
  };

  const markAllRead = async () => {
    setConfirmMarkAllRead(false);
    await api.markAllRead({
      sourceId: selectedGroup === null && sourceId ? sourceId : undefined,
      groupName: selectedGroup ?? undefined,
    }).catch(() => {});
    setItems((current) => current.map((item) => ({ ...item, state: 'seen' })));
    void onFeedsChanged();
  };

  if (collapsed) return <PanelRail onExpand={onExpand} title="文章" />;

  return (
    <section className="dpl-pane dpl-items" aria-label="文章列表">
      <div className="dpl-pane-head">
        <span className="dpl-pane-title dpl-grow dpl-truncate">{listTitle}</span>
        {newCount > 0 ? (
          <button type="button" className="dpl-new-pill" onClick={() => {
            listScroll.current?.scrollTo({ top: 0 });
            baseline.current = { session: sessionKey, keys: new Set(items.map((item) => item.sourceId + ':' + item.key)) };
            setPill((value) => value + 1);
          }}>新增 {newCount} 条</button>
        ) : null}
        <button type="button" className="dpl-icon-btn" data-tip="刷新全部" aria-label="刷新全部" disabled={spinning} onClick={onRefresh}>
          {spinning ? <Loader2 size={15} className="dpl-spin" /> : <RefreshCw size={15} />}
        </button>
        <button type="button" className={'dpl-icon-btn' + (viewFilter === 'unseen' ? ' is-toggled' : '')} data-tip="只显示未读" aria-label="只显示未读" aria-pressed={viewFilter === 'unseen'} onClick={() => setViewFilter(viewFilter === 'unseen' ? 'all' : 'unseen')}>
          <Circle size={15} className={viewFilter === 'unseen' ? 'dpl-fill' : undefined} />
        </button>
        <button type="button" className={'dpl-icon-btn' + (viewFilter === 'seen' ? ' is-toggled' : '')} data-tip="只显示已读" aria-label="只显示已读" aria-pressed={viewFilter === 'seen'} onClick={() => setViewFilter(viewFilter === 'seen' ? 'all' : 'seen')}>
          <CircleCheck size={15} />
        </button>
        <button type="button" className={'dpl-icon-btn' + (viewFilter === 'skipped' ? ' is-toggled' : '')} data-tip="只显示略过" aria-label="只显示略过" aria-pressed={viewFilter === 'skipped'} onClick={() => setViewFilter(viewFilter === 'skipped' ? 'all' : 'skipped')}>
          <Archive size={15} />
        </button>
        <button type="button" className="dpl-icon-btn" data-tip="标记全部为已读" aria-label="标记全部为已读" disabled={scopeUnseen === 0} onClick={() => setConfirmMarkAllRead(true)}>
          <CheckCheck size={15} />
        </button>
        <span className="dpl-flex-fill" />
        <PanelCollapseButton onClick={onCollapse} />
      </div>
      {notice ? <div className="dpl-notice dpl-items-notice" role="status">{notice}</div> : null}
      <div className="dpl-entry-scroll" ref={listScroll} tabIndex={0} onKeyDown={handleListKeyDown}>
        {loading ? <div className="dpl-list-loading"><Loader2 size={17} className="dpl-spin" /></div> : null}
        {!loading && partitioned.length === 0 ? (
          <div className="dpl-list-empty">
            <p>{feeds.length === 0 ? '还没有订阅源。' : '暂无条目。'}</p>
            <button type="button" className="dpl-btn dpl-sm dpl-primary-solid" onClick={onManage}>
              {feeds.length === 0 ? '去添加源' : '管理订阅源'}
            </button>
          </div>
        ) : null}
        {partitioned.map((item) => {
          const feed = feedsById.get(item.sourceId);
          return (
            <div
              key={item.sourceId + ':' + item.key}
              data-entry={item.sourceId + ':' + item.key}
              className={'dpl-entry-row' + (selected?.key === item.key && selected?.sourceId === item.sourceId ? ' is-active' : '')}
              onMouseEnter={() => {
                if (!hoverPreviewEnabled) return;
                clearHoverTimer();
                hoverTimer.current = setTimeout(() => {
                  hoverTimer.current = null;
                  const current = visibleItems.current.find((entry) => entry.sourceId === item.sourceId && entry.key === item.key);
                  if (current) openItem(current);
                }, 500);
              }}
              onMouseLeave={clearHoverTimer}
              tabIndex={0}
              role="button"
              aria-current={selected?.key === item.key && selected?.sourceId === item.sourceId ? 'true' : undefined}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  clearHoverTimer();
                  openItem(item);
                }
              }}
              onClick={() => { clearHoverTimer(); openItem(item); }}
            >
              <div className="dpl-entry-src">
                {feed ? <FeedBadge feed={feed} icon={icons?.[feed.id]} /> : null}
                <span className="dpl-truncate">{feed?.title ?? ''}</span>
                {item.publishedAt ? <>, <span>{formatWhen(Date.parse(item.publishedAt))}</span></> : null}
              </div>
              <div className="dpl-entry-main">
                <span className={'dpl-dot is-' + item.state} data-state={item.state} />
                <span className={'dpl-truncate dpl-grow ' + (item.state === 'unseen' ? 'is-unread' : '')}>{item.title}</span>
              </div>
              {item.summary ? <p className="dpl-entry-sum">{item.summary}</p> : null}
            </div>
          );
        })}
      </div>
      {confirmMarkAllRead ? (
        <div className="dpl-modal-backdrop" onClick={() => setConfirmMarkAllRead(false)}>
          <div className="dpl-modal" onClick={(e) => e.stopPropagation()}>
            <div className="dpl-modal-title">标记全部为已读</div>
            <p className="dpl-modal-text">将当前范围的 <strong>{scopeUnseen}</strong> 条未读全部标记为已读，已略过的条目不受影响。此操作无法批量撤销。</p>
            <div className="dpl-form-row dpl-end">
              <button type="button" className="dpl-btn" onClick={() => setConfirmMarkAllRead(false)}>取消</button>
              <button type="button" className="dpl-btn dpl-primary-solid" onClick={() => void markAllRead()}>标记</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Preview pane: sticky round actions + header meta + body + AuxRail. */
function Preview({ api, feeds, icons, item, onMaterial, onJumpSpace, onOpenVaultNote, onMarked, onUnreadChange }) {
  const [html, setHtml] = useState('');
  const [notice, setNotice] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const scrollRef = useRef(null);
  // Translation state: cached record (from host), the 生成/查看 toggle, and
  // the in-flight generation flag. `hasTranslation` comes with getEntry so
  // the button can offer 查看 without a round-trip.
  const [translation, setTranslation] = useState(null);
  const [hasTranslation, setHasTranslation] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const [translating, setTranslating] = useState(false);
  const feed = useMemo(() => feeds.find((f) => f.id === item?.sourceId) ?? null, [feeds, item?.sourceId]);

  useEffect(() => {
    setHtml('');
    setNotice('');
    setTranslation(null);
    setHasTranslation(false);
    setShowTranslation(false);
    setTranslating(false);
    scrollRef.current?.scrollTo({ top: 0 });
    if (!item) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getEntry(item.key);
        if (cancelled) return;
        setHtml(result.html ?? '');
        setHasTranslation(result.hasTranslation === true);
        onMaterial({ space: 'feed', key: item.key, title: item.title, url: item.link, content: plainOf(result.html ?? '') });
      } catch { /* keep header; body stays empty */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.sourceId, item?.key]);

  // 翻译: first click generates (spinner), later clicks toggle 原文↔译文.
  const translate = async () => {
    if (!item || translating) return;
    if (translation) { setShowTranslation((value) => !value); return; }
    setTranslating(true);
    try {
      const result = await api.translateEntry(item.key);
      setTranslation(result?.translation ?? null);
      setHasTranslation(true);
      setShowTranslation(true);
    } catch (cause) {
      setNotice(String(cause?.message ?? cause));
    } finally {
      setTranslating(false);
    }
  };

  const headings = useMemo(() => htmlHeadings(showTranslation && translation ? markdownToHtml(translation.markdown) : html), [html, showTranslation, translation]);
  const plainLength = html ? html.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length : 0;
  const shortKind = item && !html ? 'empty' : (item && plainLength > 0 && plainLength < 80 ? 'short' : null);

  const addToInbox = async () => {
    if (!item?.link) return;
    setBusyAction('inbox');
    try {
      await api.inboxAddUrl({ url: item.link });
      onJumpSpace?.('inbox');
    } catch (cause) { setNotice(String(cause?.message ?? cause)); }
    finally { setBusyAction(''); }
  };

  // 存为笔记 (plan 差异化 #3): convert this entry's HTML to Markdown and
  // land it as a new vault note, then jump to the vault with it open.
  const saveAsNote = async () => {
    if (!item) return;
    setBusyAction('note');
    try {
      const result = await api.saveAsNote({ source: 'feed', key: item.key, title: item.title });
      onOpenVaultNote?.(result?.path);
    } catch (cause) { setNotice(String(cause?.message ?? cause)); }
    finally { setBusyAction(''); }
  };

  const skip = async () => {
    if (!item) return;
    setBusyAction('skip');
    try {
      await api.setItemState({ keys: [item.key], state: 'skipped' });
      if (item.state === 'unseen') onUnreadChange?.(item.sourceId, -1);
      void onMarked();
    }
    catch (cause) { setNotice(String(cause?.message ?? cause)); }
    finally { setBusyAction(''); }
  };

  const captureSelection = () => {
    const selection = String(window.getSelection?.() ?? '').trim();
    if (!item || selection === '') return;
    onMaterial({ space: 'feed', key: item.key, title: item.title, url: item.link, selection, content: '' });
  };

  if (!item) {
    return <div className="dpl-preview-empty">在中间列表选择一条内容预览</div>;
  }

  const translateTitle = translating
    ? t('feed.translating')
    : translation
      ? (showTranslation ? t('feed.showOriginal') : t('feed.showTranslation'))
      : (hasTranslation ? t('feed.showTranslation') : t('feed.translate'));

  return (
    <div className="dpl-pane dpl-preview">
      <div className="dpl-preview-scroll" ref={scrollRef} onMouseUp={captureSelection}>
        <div className="dpl-reader-actions-float">
          <button
            type="button"
            data-testid="feed-translate"
            className={'dpl-round-btn' + (showTranslation ? ' is-on' : '')}
            disabled={translating}
            title={translateTitle}
            aria-label={translateTitle}
            data-tip={translateTitle}
            onClick={() => void translate()}
          >
            {translating ? <Loader2 size={14} className="dpl-spin" /> : <span className="dpl-lang-mark">文</span>}
          </button>
          {item.link ? (
            <a className="dpl-round-btn" href={item.link} target="_blank" rel="noreferrer" title="打开原文" aria-label="打开原文">
              <ExternalLink size={15} />
            </a>
          ) : null}
          <button type="button" className="dpl-round-btn" data-tip="加入精读" aria-label="加入精读" disabled={busyAction === 'inbox'} onClick={() => void addToInbox()}>
            {busyAction === 'inbox' ? <Loader2 size={15} className="dpl-spin" /> : <Inbox size={15} />}
          </button>
          <button type="button" className="dpl-round-btn" data-tip="存为笔记" aria-label="存为笔记" disabled={busyAction === 'note'} onClick={() => void saveAsNote()}>
            {busyAction === 'note' ? <Loader2 size={15} className="dpl-spin" /> : <FileText size={15} />}
          </button>
          <button type="button" className="dpl-round-btn" data-tip="略过" aria-label="略过" disabled={busyAction === 'skip'} onClick={() => void skip()}>
            {busyAction === 'skip' ? <Loader2 size={15} className="dpl-spin" /> : <Archive size={15} />}
          </button>
        </div>
        {notice ? <div className="dpl-notice dpl-reader-notice" role="status">{notice}</div> : null}
        {showTranslation && translation ? (
          <div className="dpl-translation-notice" role="status">
            {t('feed.translationNotice')} · {new Date(translation.generatedAt).toLocaleString('zh-Hans-CN')}
            <button type="button" className="dpl-inline-btn" onClick={() => setShowTranslation(false)}>{t('feed.showOriginal')}</button>
          </div>
        ) : null}
        <header className="dpl-article-head">
          <h1>{showTranslation && translation ? (translation.title || item.title) : item.title}</h1>
          <div className="dpl-article-meta">
            {feed ? (
              <>
                <FeedBadge feed={feed} icon={icons?.[feed.id]} />
                <span className="dpl-meta-source">{feed.title}</span>
                <span aria-hidden>，</span>
              </>
            ) : null}
            {item.publishedAt ? <span>{formatWhenFull(Date.parse(item.publishedAt))}</span> : null}
            {item.state !== 'unseen' ? <span className="dpl-meta-state">{STATE_LABEL[item.state]}</span> : null}
          </div>
        </header>
        {shortKind !== null ? (
          <div className={'dpl-short-notice ' + (shortKind === 'empty' ? 'is-empty' : '')}>
            {shortKind === 'empty' ? '该条目暂无正文，完整内容请查看原文。' : '正文较短，完整内容请查看原文。'}
            {item.link ? (
              <a href={item.link} target="_blank" rel="noreferrer" className="dpl-inline-link">查看原文</a>
            ) : null}
          </div>
        ) : null}
        <div className="dpl-article-body-wrap">
          {showTranslation && translation ? (
            <article><SafeHtml className="dpl-article-body" html={markdownToHtml(translation.markdown)} /></article>
          ) : html ? (
            <article><SafeHtml className="dpl-article-body" html={html} /></article>
          ) : (
            <div className="dpl-article-plain">{item.summary || '（无内容）'}</div>
          )}
        </div>
      </div>
      <AuxRail
        headings={headings}
        containerRef={scrollRef}
        onAskAi={() => onMaterial({ space: 'feed', key: item.key, title: item.title, url: item.link, content: plainOf(html) }, { reveal: true })}
      />
    </div>
  );
}

function plainOf(html) {
  try {
    const parsed = new DOMParser().parseFromString('<!doctype html><body>' + String(html ?? ''), 'text/html');
    return (parsed.body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40000);
  } catch {
    return '';
  }
}
