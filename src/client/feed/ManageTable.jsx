import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, ChevronDown, ClipboardPaste, FileUp, Link, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
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
  // Batch outcome notice (B): partial failures must be visible, never silent.
  const [batchNotice, setBatchNotice] = useState('');
  const noticeTimer = useRef(null);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);
  const showBatchNotice = (text) => {
    setBatchNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => { noticeTimer.current = null; setBatchNotice(''); }, 6000);
  };

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
    const failures = [];
    try {
      // Per-item try/catch: one failing feed must not abandon the rest.
      for (const id of ids) {
        try { await api.setFeed({ id, patch: changes }); }
        catch (cause) { failures.push(String(cause?.message ?? cause)); }
      }
      await onChanged();
      if (failures.length > 0) {
        showBatchNotice(`成功 ${ids.length - failures.length} 个，失败 ${failures.length} 个：${failures[0]}`);
      }
    } finally { setBusy(false); }
  }

  async function retry(ids) {
    setBusy(true);
    try {
      // Retry exactly the selected sources (C): single → channel, several →
      // the channels array (host selectSubscriptions scopes the refresh);
      // never a full refresh of every subscription.
      await api.refresh(ids.length === 1 ? ids[0] : { channels: ids });
      await onChanged();
    } catch (cause) {
      showBatchNotice('重试失败：' + String(cause?.message ?? cause));
    } finally { setBusy(false); }
  }

  async function removeBatch(ids) {
    setBusy(true);
    const failures = [];
    const failedIds = new Set();
    try {
      for (const id of ids) {
        try { await api.removeSubscription(id); }
        catch (cause) {
          failedIds.add(id);
          failures.push(String(cause?.message ?? cause));
        }
      }
      if (failures.length === 0) {
        setChecked(new Set());
      } else {
        // Keep the failed rows checked (retry-ready); drop the ones already
        // removed so the selection matches what still exists.
        setChecked((prev) => {
          const next = new Set(prev);
          for (const id of ids) if (!failedIds.has(id)) next.delete(id);
          return next;
        });
        showBatchNotice(`成功 ${ids.length - failures.length} 个，失败 ${failures.length} 个：${failures[0]}`);
      }
      setConfirmBatchDelete(false);
      await onChanged();
    } finally { setBusy(false); }
  }

  // OPML import dialog (window.prompt is not supported in the sandboxed
  // renderer): paste XML or a URL, preview, then import everything.
  const [importOpen, setImportOpen] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  async function importOpml() {
    setImportOpen(true);
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
      {importNotice ? (
        <div className="dpl-import-successbar" role="status">
          <CheckCheck size={14} />
          <span>{importNotice}</span>
          <button type="button" className="dpl-icon-btn" aria-label="关闭提示" onClick={() => setImportNotice('')}>✕</button>
        </div>
      ) : null}
      {batchNotice ? (
        <div className="dpl-notice dpl-manage-batch-notice" role="status">{batchNotice}</div>
      ) : null}
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
      {importOpen ? (
        <ImportDialog
          api={api}
          onClose={() => setImportOpen(false)}
          onImported={async (count) => {
            await onChanged();
            if (count > 0) {
              setImportNotice('已导入 ' + count + ' 个源,正在后台抓取条目…');
              setTimeout(() => setImportNotice(''), 6000);
            }
          }}
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
  const [lanWarning, setLanWarning] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.addSubscription({ url: url.trim(), name: name.trim() || undefined, group: group.trim() || undefined });
      await onChanged();
      if (isLanUrl(url.trim())) {
        setLanWarning('该源允许访问内网/回环地址，请确认来源可信。');
        return;
      }
      onClose();
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  return (
    <div className="dpl-dialog-backdrop" onClick={onClose}>
      <div className="dpl-dialog dpl-add-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dpl-dialog-headline">
          <span className="dpl-dialog-title">添加订阅源</span>
          <span className="dpl-grow" />
          <button type="button" className="dpl-icon-btn dpl-round" onClick={onClose} aria-label="关闭"><X size={15} /></button>
        </div>
        <div className="dpl-dialog-body">
          <label className="dpl-dialog-field">
            <span>Feed 地址</span>
            <input autoFocus placeholder="https://…（支持 RSS / Atom / JSON Feed）" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="dpl-dialog-field">
            <span>名称（可选）</span>
            <input placeholder="留空自动使用源标题" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="dpl-dialog-field">
            <span>分组（可选）</span>
            <input placeholder="如：Tech" value={group} onChange={(e) => setGroup(e.target.value)} />
          </label>
          <div className="dpl-dialog-hint">添加时验证源并自动抓取标题与首批条目。</div>
          {error ? <div className="dpl-dialog-error">{error}</div> : null}
          {lanWarning ? <div className="dpl-dialog-warn">{lanWarning}</div> : null}
        </div>
        <div className="dpl-dialog-footer">
          <span className="dpl-grow" />
          {lanWarning ? (
            <button type="button" className="dpl-btn dpl-sm" onClick={onClose}>我知道了，关闭</button>
          ) : (
            <button type="button" className="dpl-btn dpl-sm dpl-primary-solid" disabled={busy || url.trim().length === 0} onClick={() => void submit()}>
              {busy ? <Loader2 size={13} className="dpl-spin" /> : null} 订阅
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EditDialog({ api, feed, availableGroups, onClose, onChanged }) {
  const [name, setName] = useState(feed?.title ?? '');
  const [group, setGroup] = useState(feed?.groupName ?? '');
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  // Enabled is an immediate-effect control in droplets (toggle.mutate on
  // change, never part of the save payload); keep a local mirror for render.
  const [enabled, setEnabled] = useState(feed?.enabled ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function toggleEnabled() {
    const next = !enabled;
    setEnabled(next);
    try {
      await api.setFeed({ id: feed.id, patch: { enabled: next } });
      await onChanged();
    } catch (cause) {
      setEnabled(!next);
      setError(String(cause?.message ?? cause));
    }
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.setFeed({ id: feed.id, patch: { name: name.trim(), group: group.trim() } });
      await onChanged();
      onClose();
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.removeSubscription(feed.id);
      await onChanged();
      onClose();
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  return (
    <div className="dpl-dialog-backdrop" onClick={onClose}>
      <div className="dpl-dialog dpl-edit-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dpl-dialog-headline">
          <span className="dpl-dialog-badge"><FeedBadge feed={feed} /></span>
          <div className="dpl-min0 dpl-grow">
            <div className="dpl-dialog-name">{feed.title}</div>
            <div className="dpl-dialog-sub">{feed.groupName || '未分组'}，共 {feed.itemCount} 条，未读 {feed.unreadCount}</div>
          </div>
          <button type="button" className="dpl-icon-btn dpl-round" onClick={onClose} aria-label="关闭"><X size={15} /></button>
        </div>
        {feed.lastError ? (
          <div className="dpl-dialog-error dpl-dialog-errorpanel">
            <div className="dpl-dialog-errortitle">最近一次抓取失败</div>
            <div className="dpl-dialog-errortext">{feed.lastError}</div>
            <div className="dpl-dialog-errormeta">最近尝试 {feed.lastFetchAt ? formatWhenFull(feed.lastFetchAt) : '从未'}；可在源管理中重试</div>
          </div>
        ) : null}
        <div className="dpl-dialog-rows">
          <div className="dpl-dialog-row">
            <span className="dpl-dialog-label">名称</span>
            <input className="dpl-grow" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="dpl-dialog-row">
            <span className="dpl-dialog-label">分组</span>
            <div className="dpl-relative dpl-grow dpl-row-flex">
              <input className="dpl-grow" placeholder="选择或输入分组（空 = 未分组）" value={group} onChange={(e) => setGroup(e.target.value)} />
              <button type="button" className="dpl-icon-btn" data-tip="选择已有分组" aria-label="选择已有分组" aria-expanded={groupMenuOpen} onClick={() => setGroupMenuOpen((v) => !v)}>
                <ChevronDown size={14} className={groupMenuOpen ? 'is-flipped' : undefined} />
              </button>
              {groupMenuOpen ? (
                <div className="dpl-menu dpl-group-menu">
                  <button type="button" className="dpl-menu-item" onClick={() => { setGroup(''); setGroupMenuOpen(false); }}>{group === '' ? '✓ ' : ''}未分组</button>
                  {availableGroups.map((g) => (
                    <button key={g} type="button" className="dpl-menu-item" onClick={() => { setGroup(g); setGroupMenuOpen(false); }}>{group === g ? '✓ ' : ''}{g}</button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <div className="dpl-dialog-row">
            <span className="dpl-dialog-label">Feed 地址</span>
            <span className="dpl-dialog-url">{feed.url}</span>
          </div>
          <div className="dpl-dialog-row">
            <span className="dpl-dialog-label">启用</span>
            <input type="checkbox" className="dpl-switch" checked={enabled} title={enabled ? '停用' : '启用'} onChange={() => void toggleEnabled()} />
            <span className="dpl-dialog-switch-hint">{enabled ? '参与自动刷新与全部源聚合（即时生效）' : '已停用（不刷新、不进聚合）'}</span>
          </div>
        </div>
        {error ? <div className="dpl-dialog-error dpl-dialog-pad">{error}</div> : null}
        <div className="dpl-dialog-footer">
          <button type="button" className={'dpl-btn dpl-sm' + (confirmDelete ? ' dpl-danger' : '')} disabled={busy} onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}>
            <Trash2 size={13} /> {confirmDelete ? '确认删除' : '删除源'}
          </button>
          <span className="dpl-grow" />
          <button type="button" className="dpl-btn dpl-sm dpl-primary-solid" disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 size={13} className="dpl-spin" /> : null} 保存
          </button>
        </div>
      </div>
    </div>
  );
}

function isLanUrl(u) {
  return /^https?:\/\/(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|localhost)/i.test(String(u ?? ''));
}

function ImportDialog({ api, onClose, onImported }) {
  // Three entry modes (file picker / paste XML / URL) -> preview with
  // per-source checkboxes -> import. Shared dialog system styling; no
  // native prompts (unsupported in the sandboxed renderer).
  const [mode, setMode] = useState(null);
  const [text, setText] = useState('');
  const [entries, setEntries] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const previewOf = (result) => {
    setEntries(result.entries);
    setPicked(new Set(result.entries.filter((entry) => !entry.duplicate).map((entry) => entry.url)));
  };

  const loadXml = async (xml) => {
    setBusy(true);
    setError('');
    try { previewOf(await api.opmlPreview({ xml })); }
    catch (cause) {
      const message = String(cause?.message ?? cause);
      setError(message);
      // file mode has no visible body — mirror the failure into its status area
      if (mode === 'file') setFileError(message);
    }
    finally { setBusy(false); }
  };

  const loadUrl = async () => {
    setBusy(true);
    setError('');
    try { previewOf(await api.opmlPreview({ url: text.trim() })); }
    catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  };

  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState('');
  const [parsing, setParsing] = useState(false);
  const onFile = (event) => {
    const file = event.target.files?.[0];
    // allow re-picking the same file
    event.target.value = '';
    if (!file) return;
    setMode('file');
    setFileName(file.name);
    setFileError('');
    setParsing(true);
    const reader = new FileReader();
    reader.onload = () => {
      const xml = String(reader.result ?? '');
      if (xml.trim() === '') {
        setParsing(false);
        setFileError('文件是空的');
        return;
      }
      void loadXml(xml).finally(() => setParsing(false));
    };
    reader.onerror = () => { setParsing(false); setFileError('读取文件失败'); };
    reader.readAsText(file);
  };

  const toggle = (url, duplicate) => {
    if (duplicate) return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  };

  const importPicked = async () => {
    setBusy(true);
    setError('');
    try {
      if (mode === 'url') {
        const fresh = await api.opmlPreview({ url: text.trim() });
        await api.opmlImport(fresh.xml, [...picked]);
      } else {
        await api.opmlImport(text, [...picked]);
      }
      await onImported(picked.size);
      onClose();
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  };

  const duplicates = entries ? entries.filter((entry) => entry.duplicate).length : 0;

  return (
    <div className="dpl-dialog-backdrop" onClick={onClose}>
      <div className="dpl-dialog dpl-import-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dpl-dialog-headline">
          <span className="dpl-dialog-title">导入订阅源</span>
          <span className="dpl-grow" />
          <button type="button" className="dpl-icon-btn dpl-round" onClick={onClose} aria-label="关闭"><X size={15} /></button>
        </div>

        {!mode || (mode === 'file' && !entries) ? (
          <div className="dpl-import-filestatus">
            {parsing ? (
              <div className="dpl-import-parsing"><Loader2 size={16} className="dpl-spin" /> 正在解析 {fileName}…</div>
            ) : fileError ? (
              <div className="dpl-dialog-error">
                解析 {fileName} 失败:{fileError}
                <button type="button" className="dpl-btn dpl-sm" onClick={() => { setMode(null); setFileError(''); }}>重新选择</button>
              </div>
            ) : null}
          </div>
        ) : null}

        {!mode ? (
          <div className="dpl-import-choices">
            <button type="button" className="dpl-import-choice" onClick={() => fileRef.current?.click()}>
              <FileUp size={20} />
              <strong>选择 OPML 文件</strong>
              <span>从本机选取 .opml 文件</span>
            </button>
            <button type="button" className="dpl-import-choice" onClick={() => setMode('paste')}>
              <ClipboardPaste size={20} />
              <strong>粘贴 OPML 内容</strong>
              <span>直接粘贴 XML 文本</span>
            </button>
            <button type="button" className="dpl-import-choice" onClick={() => setMode('url')}>
              <Link size={20} />
              <strong>从地址导入</strong>
              <span>填一个 http(s) OPML 链接</span>
            </button>
            <input ref={fileRef} type="file" accept=".opml,.xml,text/xml,application/xml" style={{ display: 'none' }} onChange={onFile} />
          </div>
        ) : null}

        {mode && !entries ? (
          <div className="dpl-dialog-body">
            {mode === 'paste' ? (
              <label className="dpl-dialog-field">
                <span>OPML 内容</span>
                <textarea autoFocus rows={8} placeholder="粘贴 OPML XML" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />
              </label>
            ) : (
              <label className="dpl-dialog-field">
                <span>OPML 地址</span>
                <input autoFocus placeholder="https://example.com/subscriptions.opml" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />
              </label>
            )}
            {error ? <div className="dpl-dialog-error">{error}</div> : null}
          </div>
        ) : null}

        {entries ? (
          <div className="dpl-import-preview">
            <div className="dpl-import-summary">
              <span>共 {entries.length} 个源 · 已存在 {duplicates} · 将导入 <strong>{picked.size}</strong></span>
              <button type="button" className="dpl-btn dpl-sm" onClick={() => { setEntries(null); setPicked(new Set()); }}>重选来源</button>
            </div>
            <div className="dpl-import-list">
              {entries.map((entry) => (
                <label key={entry.url} className={'dpl-import-row' + (entry.duplicate ? ' is-dim' : '')}>
                  <input type="checkbox" checked={picked.has(entry.url)} disabled={entry.duplicate} onChange={() => toggle(entry.url, entry.duplicate)} />
                  <FeedBadge feed={{ id: entry.url, title: entry.name ?? entry.url }} />
                  <span className="dpl-truncate dpl-import-name">{entry.name ?? entry.url}</span>
                  {entry.group ? <span className="dpl-import-group">{entry.group}</span> : null}
                  {entry.duplicate ? <span className="dpl-import-dup">已订阅</span> : null}
                </label>
              ))}
            </div>
            {error ? <div className="dpl-dialog-error">{error}</div> : null}
          </div>
        ) : null}

        <div className="dpl-dialog-footer">
          {mode && !entries ? <button type="button" className="dpl-btn dpl-sm" onClick={() => { setMode(null); setText(''); setError(''); }}>返回</button> : null}
          <span className="dpl-grow" />
          {mode === 'paste' && !entries ? (
            <button type="button" className="dpl-btn dpl-sm dpl-primary-solid" disabled={busy || text.trim() === ''} onClick={() => void loadXml(text)}>
              {busy ? <Loader2 size={13} className="dpl-spin" /> : null} 下一步
            </button>
          ) : null}
          {mode === 'url' && !entries ? (
            <button type="button" className="dpl-btn dpl-sm dpl-primary-solid" disabled={busy || text.trim() === ''} onClick={() => void loadUrl()}>
              {busy ? <Loader2 size={13} className="dpl-spin" /> : null} 下一步
            </button>
          ) : null}
          {entries ? (
            <button type="button" className="dpl-btn dpl-sm dpl-primary-solid" disabled={busy || picked.size === 0} onClick={() => void importPicked()}>
              {busy ? <Loader2 size={13} className="dpl-spin" /> : null} 导入 {picked.size} 个源
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
