import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpNarrowWide, ChevronDown, ChevronsDownUp, ListTree, Loader2,
  RefreshCw, ScanSearch, TriangleAlert,
} from 'lucide-react';
import { PanelCollapseButton, PanelRail } from './PanelGroup.jsx';
import { DEFAULT_FEED_SORT_MODE, groupAndSortFeeds } from './feed-sorting.js';

/**
 * Sources pane, a 1:1 port of droplets' FeedSourcesPane:
 * - head row: 「订阅源」 + collapse button
 * - action row: 刷新 (refresh all, spinner) + 管理 (equal halves)
 * - toolbar row (h-7): three placeholder dots, hover reveals session sort
 *   menu / auto-reveal toggle / collapse-all — exactly the knowledge-base
 *   tree pattern
 * - 全部源 row, groups (row click filters to group, chevron collapses,
 *   group unread count), feed rows (badge, error triangle or unread count,
 *   disabled feeds dimmed)
 * - default sort unread-desc; ungrouped bucket always last.
 */
function useRefreshProgress(api) {
  const [progress, setProgress] = useState(null);
  useEffect(() => {
    if (!api?.refreshStatus) return undefined;
    let stopped = false;
    let timer = null;
    const poll = async () => {
      let delay = 5000;
      try {
        const status = await api.refreshStatus();
        if (!stopped) setProgress(status);
        if (status?.running) delay = 1500;
      } catch { /* host not ready */ }
      if (!stopped) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [api]);
  return progress;
}

export function SourcesPane({
  api, feeds, sourceId, selectedGroup, spinning, onRefresh, onManage,
  onSelectSource, onSelectGroup, collapsed, onExpand, onCollapse,
}) {
  const progress = useRefreshProgress(api);
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [sortMode, setSortMode] = useState(DEFAULT_FEED_SORT_MODE);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [autoReveal, setAutoReveal] = useState(false);
  const host = useRef(null);

  const toggleGroup = (group) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  };

  const groups = useMemo(() => groupAndSortFeeds(feeds, sortMode), [feeds, sortMode]);

  // Auto-reveal (knowledge-base parity): when the selected feed's group is
  // collapsed, expand it and scroll the feed row into view.
  useEffect(() => {
    if (!autoReveal || !sourceId) return;
    const group = feeds.find((f) => f.id === sourceId)?.groupName ?? '';
    setCollapsedGroups((prev) => {
      if (!prev.has(group)) return prev;
      const next = new Set(prev);
      next.delete(group);
      return next;
    });
    const frame = requestAnimationFrame(() => {
      host.current?.querySelector('[data-feed-id="' + CSS.escape(sourceId) + '"]')?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [autoReveal, sourceId, feeds, collapsedGroups]);

  const groupNames = groups.map(([name]) => name);
  const anyGroupExpanded = groupNames.some((name) => !collapsedGroups.has(name));
  const aggregated = feeds.filter((f) => f.enabled);
  const totalUnread = aggregated.reduce((sum, f) => sum + f.unreadCount, 0);
  const totalCount = aggregated.reduce((sum, f) => sum + f.itemCount, 0);

  if (collapsed) {
    return <PanelRail onExpand={onExpand} title="订阅源" />;
  }

  return (
    <aside className="dpl-pane dpl-sources" aria-label="订阅源">
      <div className="dpl-pane-head">
        <span className="dpl-pane-title">订阅源</span>
        <span className="dpl-flex-fill" />
        <PanelCollapseButton onClick={onCollapse} />
      </div>
      <div className="dpl-sources-actions">
        <button type="button" className="dpl-btn dpl-grow" disabled={spinning} onClick={onRefresh} title="刷新全部：后台重抓所有启用源">
          {spinning ? <Loader2 size={14} className="dpl-spin" /> : <RefreshCw size={14} />} 刷新
        </button>
        <button type="button" className="dpl-btn dpl-grow" onClick={onManage} title="管理订阅源（添加/编辑/删除源）">
          <ListTree size={14} /> 管理
        </button>
      </div>
      <div className="dpl-sources-toolbar">
        <div className="dpl-toolbar-dots" aria-hidden="true">
          <span /><span /><span />
        </div>
        <div className="dpl-toolbar-actions">
          <div className="dpl-relative">
            <button type="button" className="dpl-icon-btn dpl-tb" data-tip="排序（会话内；「未分组」恒排最后）" onClick={() => setSortMenuOpen((v) => !v)}>
              <ArrowUpNarrowWide size={14} />
            </button>
            {sortMenuOpen ? (
              <div className="dpl-menu">
                {[
                  ['unread-desc', '未读 多→少（默认）'],
                  ['default', '订阅顺序'],
                  ['name-asc', '名称 A→Z'],
                  ['name-desc', '名称 Z→A'],
                ].map(([mode, label]) => (
                  <button key={mode} type="button" className="dpl-menu-item" onClick={() => { setSortMode(mode); setSortMenuOpen(false); }}>
                    {sortMode === mode ? '✓ ' : ''}{label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" className={'dpl-icon-btn dpl-tb' + (autoReveal ? ' is-toggled' : '')} data-tip="自动定位（选中源变化时展开其所在组并滚动到该源）" onClick={() => setAutoReveal(!autoReveal)}>
            <ScanSearch size={14} />
          </button>
          <button type="button" className="dpl-icon-btn dpl-tb" title={anyGroupExpanded ? '全部折叠' : '全部展开'} onClick={() => setCollapsedGroups(anyGroupExpanded ? new Set(groupNames) : new Set())}>
            <ChevronsDownUp size={14} />
          </button>
        </div>
      </div>
      {progress && progress.total > 0 ? <RefreshProgressLine progress={progress} /> : null}
      <div className="dpl-sources-list" ref={host}>
        <button
          type="button"
          className={'dpl-source' + (sourceId === null && selectedGroup === null ? ' is-selected' : '')}
          onClick={() => onSelectSource(null)}
        >
          <span className="dpl-grow dpl-truncate">全部源</span>
          {totalUnread > 0 ? <em title={'共 ' + totalCount + ' 条'}>{totalUnread}</em> : null}
        </button>
        {groups.map(([group, groupFeeds]) => {
          const isCollapsed = collapsedGroups.has(group);
          const label = group === '' ? '未分组' : group;
          const groupUnread = groupFeeds.reduce((s, f) => s + f.unreadCount, 0);
          const groupTotal = groupFeeds.reduce((s, f) => s + f.itemCount, 0);
          const isGroupSelected = selectedGroup === group;
          return (
            <div key={group} className="dpl-source-group">
              <div className="dpl-relative dpl-group-row">
                <button
                  type="button"
                  className={'dpl-group-head' + (isGroupSelected ? ' is-selected' : '')}
                  onClick={() => onSelectGroup(isGroupSelected ? null : group)}
                  aria-pressed={isGroupSelected}
                  aria-label={'筛选到分组 ' + label}
                >
                  <span className="dpl-grow dpl-truncate">{label}</span>
                  {groupUnread > 0 ? <em title={'共 ' + groupTotal + ' 条'}>{groupUnread}</em> : null}
                </button>
                <button
                  type="button"
                  className="dpl-group-chevron"
                  onClick={() => toggleGroup(group)}
                  aria-expanded={!isCollapsed}
                  aria-label={isCollapsed ? '展开分组 ' + label : '收起分组 ' + label}
                >
                  <ChevronDown size={14} className={isCollapsed ? 'is-rotated' : undefined} />
                </button>
              </div>
              {!isCollapsed ? groupFeeds.map((feed) => (
                <button
                  type="button"
                  key={feed.id}
                  data-feed-id={feed.id}
                  className={'dpl-source dpl-in-group' + (sourceId === feed.id ? ' is-selected' : '') + (feed.enabled ? '' : ' is-disabled')}
                  onClick={() => onSelectSource(feed.id)}
                >
                  <FeedBadge feed={feed} />
                  <span className="dpl-grow dpl-truncate" title={feed.title}>{feed.title}</span>
                  {feed.lastError ? (
                    <span className="dpl-source-error" title={feed.lastError}><TriangleAlert size={13} /></span>
                  ) : feed.unreadCount > 0 ? (
                    <em title={'未读 ' + feed.unreadCount + '，共 ' + feed.itemCount + ' 条'}>{feed.unreadCount}</em>
                  ) : null}
                </button>
              )) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** 16px badge: letter with a seed-hued background (badgeColorOf port). */
const BADGE_HUES = [145, 212, 262, 0, 175, 245, 25, 330];
function badgeHueOf(seed) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return BADGE_HUES[h % BADGE_HUES.length];
}

export function FeedBadge({ feed }) {
  const letter = ([...String(feed.title ?? '').trim()][0] ?? '?').toUpperCase();
  const hue = badgeHueOf(feed.id ?? feed.title ?? '');
  return (
    <span
      className="dpl-badge"
      aria-hidden="true"
      style={{ background: 'oklch(0.58 0.14 ' + hue + ')', color: '#fff' }}
    >{letter}</span>
  );
}

function RefreshProgressLine({ progress }) {
  const [open, setOpen] = useState(false);
  const done = progress.done ?? 0;
  const total = progress.total ?? 0;
  const failed = progress.failed ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="dpl-refresh-progress">
      <button type="button" className="dpl-refresh-progress-head" onClick={() => { if (failed > 0) setOpen((v) => !v); }} aria-expanded={open}>
        {progress.running
          ? <><Loader2 size={12} className="dpl-spin" /> 抓取中 {done}/{total}{failed > 0 ? <> · 失败 {failed}</> : null}</>
          : <>上次抓取 成功 {progress.ok ?? 0}{failed > 0 ? <> · 失败 {failed}</> : null}{progress.finishedAt ? ' · ' + new Date(progress.finishedAt).toLocaleTimeString('zh-Hans-CN', { hour: '2-digit', minute: '2-digit' }) : ''}</>}
      </button>
      <div className="dpl-refresh-bar"><div className="dpl-refresh-bar-fill" style={{ width: pct + '%' }} /></div>
      {open && failed > 0 ? (
        <div className="dpl-refresh-errors" role="list">
          {(progress.errors ?? []).slice(0, 60).map((error, index) => (
            <div key={index} className="dpl-refresh-error" role="listitem">
              <span className="dpl-truncate">{error.name}</span>
              <em>{String(error.reason).slice(0, 90)}</em>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
