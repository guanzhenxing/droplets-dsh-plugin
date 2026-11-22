import { useMemo, useState } from 'react';
import { Loader2, Pencil, Plus, X } from 'lucide-react';
import { sortManageFeeds } from './feed-sorting.js';
import { FeedBadge } from './SourcesPane.jsx';
import { formatWhenFull } from './format.js';

/**
 * Manage table, a 1:1 port of droplets' ManageTable (Inoreader-style wide
 * table occupying the middle+right columns while the sources pane stays as
 * context): back row, search + status segmented filter, batch bar (enable /
 * disable / move-to-group / retry / delete), sortable header, rows with
 * switch + badge + counts + last fetch + health dot + edit, stats footer,
 * add/edit dialogs and the batch-delete confirmation.
 */
export function ManageTable({ api, feeds, onBack, onChanged }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [checked, setChecked] = useState(() => new Set());
  const [sortKey, setSortKey] = useState('title');
  const [sortAsc, setSortAsc] = useState(true);
  const [groupMove, setGroupMove] = useState(null);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opmlBusy, setOpmlBusy] = useState('');

  const availableGroups = useMemo(
    () => [...new Set(feeds.map((f) => f.groupName).filter((g) => g !== ''))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    [feeds],
  );

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const rows = feeds.filter((f) =>
      (q.length === 0 || f.title.toLowerCase().includes(q) || f.url.toLowerCase().includes(q)) &&
      (status === 'all' ||
        (status === 'error' ? f.lastError !== null
          : status === 'disabled' ? !f.enabled
          : status === 'enabled' ? f.enabled
          : status === 'grouped' ? f.groupName !== ''
          : f.groupName === '')),
    );
    return sortManageFeeds(rows, sortKey, sortAsc);
  }, [feeds, q, status, sortKey, sortAsc]);

  const errorCount = feeds.filter((f) => f.lastError !== null).length;
  const disabledCount = feeds.filter((f) => !f.enabled).length;

  async function patch(ids, changes) {
    setBusy(true);
    try {
      for (const id of ids) await api.setFeed({ id, patch: changes });
      await onChanged();
    } finally { setBusy(false); }
  }

  async function retry(ids) {
    setBusy(true);
    try { await api.refresh(); await onChanged(); } finally { setBusy(false); }
  }

  async function removeBatch(ids) {
    setBusy(true);
    try {
      for (const id of ids) await api.removeSubscription(id);
      setChecked(new Set());
      setConfirmBatchDelete(false);
      await onChanged();
    } finally { setBusy(false); }
  }

  async function importOpml() {
    setOpmlBusy('import');
    try {
      const text = window.prompt('粘贴 OPML 内容或 OPML 地址');
      if (!text || text.trim() === '') return;
      const previewResult = await api.opmlPreview(text.trim().startsWith('http') ? { url: text.trim() } : { xml: text });
      await api.opmlImport(previewResult.xml);
      await onChanged();
    } catch (cause) { window.alert(String(cause?.message ?? cause)); }
    finally { setOpmlBusy(''); }
  }

  async function exportOpml() {
    setOpmlBusy('export');
    try {
      const { xml } = await api.opmlExport();
      const blob = new Blob([xml], { type: 'text/xml' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'droplets-subscriptions.opml';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } finally { setOpmlBusy(''); }
  }

  return (
    <section className="dpl-manage" aria-label="订阅源管理">
      <div className="dpl-manage-head">
        <button type="button" className="dpl-btn" onClick={onBack}>‹ 返回</button>
        <span className="dpl-manage-title">订阅源管理（{feeds.length}）</span>
        <span className="dpl-grow" />
        <button type="button" className="dpl-btn" onClick={() => setAdding(true)}><Plus size={14} /> 添加源</button>
        <button type="button" className="dpl-btn" disabled={opmlBusy === 'import'} onClick={() => void importOpml()}>
          {opmlBusy === 'import' ? <Loader2 size={14} className="dpl-spin" /> : null} 导入
        </button>
        <button type="button" className="dpl-btn" disabled={opmlBusy === 'export'} onClick={() => void exportOpml()}>
          {opmlBusy === 'export' ? <Loader2 size={14} className="dpl-spin" /> : null} 导出
        </button>
      </div>
      <div className="dpl-manage-filters">
        <input className="dpl-manage-search" placeholder="搜索名称 / URL" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="dpl-seg">
          {[
            ['all', '全部 ' + feeds.length],
            ['enabled', '启用 ' + feeds.filter((f) => f.enabled).length],
            ['error', '有问题 ' + errorCount],
            ['disabled', '已停用 ' + disabledCount],
            ['grouped', '分组'],
            ['ungrouped', '未分组'],
          ].map(([key, label]) => (
            <button key={key} type="button" className={'dpl-seg-item' + (status === key ? ' is-active' : '')} onClick={() => setStatus(key)}>{label}</button>
          ))}
        </div>
      </div>
      {checked.size > 0 ? (
        <div className="dpl-manage-batch">
          <span>已选 {checked.size}</span>
          <button type="button" className="dpl-btn dpl-sm" disabled={busy} onClick={() => void patch([...checked], { enabled: true })}>启用</button>
          <button type="button" className="dpl-btn dpl-sm" disabled={busy} onClick={() => void patch([...checked], { enabled: false })}>停用</button>
          <div className="dpl-relative">
            <button type="button" className="dpl-btn dpl-sm" onClick={() => setGroupMove(groupMove === null ? '' : null)}>移动分组…</button>
            {groupMove !== null ? (
              <div className="dpl-popover">
                <input autoFocus placeholder="目标分组名（空 = 未分组）" value={groupMove} onChange={(e) => setGroupMove(e.target.value)} />
                <button type="button" className="dpl-btn dpl-sm dpl-primary dpl-full" onClick={() => { void patch([...checked], { group: groupMove.trim() }); setGroupMove(null); }}>
                  移动 {checked.size} 个源
                </button>
              </div>
            ) : null}
          </div>
          <button type="button" className="dpl-btn dpl-sm" disabled={busy} onClick={() => void retry([...checked])}>重试</button>
          <button type="button" className="dpl-btn dpl-sm dpl-danger" onClick={() => setConfirmBatchDelete(true)}>删除…</button>
          <span className="dpl-grow" />
          <button type="button" className="dpl-btn dpl-sm" onClick={() => setChecked(new Set())}>取消选择</button>
        </div>
      ) : null}
      <div className="dpl-manage-grid dpl-manage-header">
        <label className="dpl-center">
          <input
            type="checkbox"
            checked={checked.size > 0 && checked.size === filtered.length}
            ref={(el) => { if (el) el.indeterminate = checked.size > 0 && checked.size < filtered.length; }}
            onChange={() => setChecked(checked.size === filtered.length ? new Set() : new Set(filtered.map((f) => f.id)))}
            aria-label="全选"
          />
        </label>
        <span>启用</span>
        {[
          ['title', '订阅源'],
          ['unread', '未读'],
          ['fetched', '最近抓取'],
          ['health', '健康'],
        ].map(([key, label], idx) => (
          <button key={key} type="button" className={'dpl-manage-sort' + (idx >= 2 ? ' dpl-right' : '') + (sortKey === key ? ' is-active' : '')} onClick={() => {
            if (sortKey === key) setSortAsc(!sortAsc);
            else { setSortKey(key); setSortAsc(true); }
          }}>
            {label}{sortKey === key ? <span>{sortAsc ? '↑' : '↓'}</span> : null}
          </button>
        ))}
        <span />
      </div>
      <div className="dpl-manage-rows">
        {filtered.map((feed) => (
          <div key={feed.id} className="dpl-manage-grid dpl-manage-row" onClick={() => setEditingId(feed.id)}>
            <label className="dpl-center" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={checked.has(feed.id)}
                onChange={() => setChecked((prev) => {
                  const next = new Set(prev);
                  if (next.has(feed.id)) next.delete(feed.id); else next.add(feed.id);
                  return next;
                })}
                aria-label={'选择 ' + feed.title}
              />
            </label>
            <label className="dpl-center" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                className="dpl-switch"
                checked={feed.enabled}
                title={feed.enabled ? '停用' : '启用'}
                onChange={() => void patch([feed.id], { enabled: !feed.enabled })}
              />
            </label>
            <div className="dpl-manage-name">
              <FeedBadge feed={feed} />
              <div className="dpl-min0">
                <div className={'dpl-truncate dpl-manage-title' + (feed.enabled ? '' : ' is-dim')}>{feed.title}</div>
                <div className="dpl-truncate dpl-manage-group">{feed.groupName || '未分组'}</div>
              </div>
            </div>
            <span className="dpl-right dpl-manage-count">{feed.unreadCount > 0 ? feed.unreadCount : '—'}/{feed.itemCount}</span>
            <span className="dpl-right dpl-manage-time">{feed.lastFetchAt ? formatWhenFull(feed.lastFetchAt) : '从未'}</span>
            <span className={'dpl-health' + (feed.lastError ? ' is-error' : feed.enabled ? ' is-ok' : ' is-off')} title={feed.lastError ?? (feed.enabled ? '正常' : '已停用')} />
            <button type="button" className="dpl-icon-btn" data-tip="编辑" aria-label="编辑" onClick={(e) => { e.stopPropagation(); setEditingId(feed.id); }}>
              <Pencil size={13} />
            </button>
          </div>
        ))}
        {filtered.length === 0 ? <div className="dpl-manage-empty">无匹配订阅源</div> : null}
      </div>
      <div className="dpl-manage-stats">
        <span>{feeds.length} 个源</span>
        <span>异常 {errorCount}</span>
        <span>停用 {disabledCount}</span>
        <span className="dpl-grow" />
        <span>最近刷新 {feeds.some((f) => f.lastFetchAt) ? formatWhenFull(Math.max(...feeds.map((f) => f.lastFetchAt ?? 0))) : '从未'}</span>
      </div>

      {adding ? <AddDialog api={api} onClose={() => setAdding(false)} onChanged={onChanged} /> : null}
      {editingId ? (
        <EditDialog
          api={api}
          feed={feeds.find((f) => f.id === editingId) ?? null}
          availableGroups={availableGroups}
          onClose={() => setEditingId(null)}
          onChanged={onChanged}
        />
      ) : null}
      {confirmBatchDelete ? (
        <div className="dpl-modal-backdrop" onClick={() => setConfirmBatchDelete(false)}>
          <div className="dpl-modal" onClick={(e) => e.stopPropagation()}>
            <div className="dpl-modal-title">删除订阅源</div>
            <p className="dpl-modal-text">将删除 <strong>{checked.size}</strong> 个源及其本地缓存条目（不影响已加入精读的内容）。此操作不可撤销。</p>
            <div className="dpl-form-row dpl-end">
              <button type="button" className="dpl-btn" onClick={() => setConfirmBatchDelete(false)}>取消</button>
              <button type="button" className="dpl-btn dpl-danger-solid" onClick={() => void removeBatch([...checked])}>删除</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function AddDialog({ api, onClose, onChanged }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.addSubscription({ url: url.trim(), name: name.trim() || undefined, group: group.trim() || undefined });
      await onChanged();
      onClose();
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  const lan = /^https?:\/\/(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|localhost)/i.test(url.trim());

  return (
    <div className="dpl-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dpl-modal">
        <div className="dpl-modal-title">添加订阅源 <button type="button" className="dpl-icon-btn" onClick={onClose}><X size={14} /></button></div>
        <div className="dpl-form-col">
          <label className="dpl-field">
            <span>订阅地址</span>
            <input autoFocus placeholder="https://example.com/feed.xml" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="dpl-field">
            <span>名称（可选）</span>
            <input placeholder="默认取 feed 标题" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="dpl-field">
            <span>分组（可选）</span>
            <input placeholder="如 Tech" value={group} onChange={(e) => setGroup(e.target.value)} />
          </label>
          {lan ? <p className="dpl-warn-text">该地址位于内网/回环段：允许添加，但请确认其可信。</p> : null}
          {error ? <p className="dpl-warn-text">{error}</p> : null}
        </div>
        <div className="dpl-form-row dpl-end">
          <button type="button" className="dpl-btn" onClick={onClose}>取消</button>
          <button type="button" className="dpl-btn dpl-primary-solid" disabled={busy || url.trim() === ''} onClick={() => void submit()}>
            {busy ? <Loader2 size={14} className="dpl-spin" /> : null} 添加
          </button>
        </div>
      </div>
    </div>
  );
}

function EditDialog({ api, feed, availableGroups, onClose, onChanged }) {
  const [name, setName] = useState(feed?.title ?? '');
  const [group, setGroup] = useState(feed?.groupName ?? '');
  const [enabled, setEnabled] = useState(feed?.enabled ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.setFeed({ id: feed.id, patch: { name, group, enabled } });
      await onChanged();
      onClose();
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!window.confirm('退订「' + feed.title + '」？本地缓存条目将一并删除，此操作不可撤销。')) return;
    setBusy(true);
    try {
      await api.removeSubscription(feed.id);
      await onChanged();
      onClose();
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  return (
    <div className="dpl-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dpl-modal">
        <div className="dpl-modal-title">编辑订阅源 <button type="button" className="dpl-icon-btn" onClick={onClose}><X size={14} /></button></div>
        <div className="dpl-form-col">
          <label className="dpl-field"><span>名称</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="dpl-field">
            <span>分组{availableGroups.length > 0 ? '（可选，已有：' + availableGroups.join('、' ) + '）' : '（可选）'}</span>
            <input value={group} onChange={(e) => setGroup(e.target.value)} />
          </label>
          <label className="dpl-field dpl-row">
            <input type="checkbox" className="dpl-switch" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>{enabled ? '启用（参与自动刷新与全部源聚合）' : '已停用（不刷新、不进聚合）'}</span>
          </label>
          <p className="dpl-dim-text">{feed.url}</p>
          {error ? <p className="dpl-warn-text">{error}</p> : null}
        </div>
        <div className="dpl-form-row dpl-between">
          <button type="button" className="dpl-btn dpl-danger" onClick={() => void remove()}>删除源…</button>
          <span className="dpl-grow" />
          <button type="button" className="dpl-btn" onClick={onClose}>取消</button>
          <button type="button" className="dpl-btn dpl-primary-solid" disabled={busy} onClick={() => void save()}>保存</button>
        </div>
      </div>
    </div>
  );
}
