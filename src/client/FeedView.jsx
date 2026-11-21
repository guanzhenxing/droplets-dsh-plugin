import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n.js';
import { Modal, SafeHtml, formatDate } from './components.jsx';

/**
 * The feed space: sources (240) / entries (320) / reading + companion.
 * Ordering is session-frozen (unread first, stable within the session via a
 * FrozenOrder the panel owns). Selection text becomes the companion's
 * default processing object.
 *
 * @param {{api:object, frozen:import('./frozen-sort.js').FrozenOrder,
 *          onMaterial:function}} props
 */
export function FeedView({ api, frozen, onMaterial }) {
  const [channels, setChannels] = useState([]);
  const [channel, setChannel] = useState('all');
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [html, setHtml] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [managing, setManaging] = useState(false);
  const [opml, setOpml] = useState(false);
  const loadSeq = useRef(0);

  const loadChannels = useCallback(async () => {
    try {
      const { channels: next } = await api.listChannels();
      setChannels(next);
    } catch (cause) { setError(String(cause?.message ?? cause)); }
  }, [api]);

  const loadEntries = useCallback(async (silent = false) => {
    const seq = ++loadSeq.current;
    if (!silent) setBusy(true);
    try {
      const page = await api.listEntries({ channel, filter: filter === 'all' ? undefined : filter, search: search || undefined, limit: 100 });
      if (seq !== loadSeq.current) return;
      setEntries(frozen.order(channel, page.entries));
    } catch (cause) {
      if (seq === loadSeq.current) setError(String(cause?.message ?? cause));
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  }, [api, channel, filter, search, frozen]);

  useEffect(() => { void loadChannels(); }, [loadChannels]);
  useEffect(() => { void loadEntries(); }, [loadEntries]);

  const unreadCount = useMemo(() => channels.find((item) => item.key === channel)?.unread ?? 0, [channels, channel]);

  async function openEntry(entry) {
    setSelected(entry);
    setHtml('');
    setError('');
    try {
      const result = await api.getEntry(entry.key);
      setHtml(result.html ?? '');
      onMaterial({ space: 'feed', key: entry.key, title: entry.title, url: entry.url, content: plainOf(result.html ?? '') });
      if (!entry.read) {
        setEntries((current) => current.map((item) => (item.key === entry.key ? { ...item, read: true } : item)));
        void api.setRead([entry.key], true).then(() => void loadChannels());
      }
    } catch (cause) {
      setError(String(cause?.message ?? cause));
    }
  }

  async function toggleFavorite(entry) {
    const favorite = !entry.favorite;
    setEntries((current) => current.map((item) => (item.key === entry.key ? { ...item, favorite } : item)));
    if (selected?.key === entry.key) setSelected({ ...selected, favorite });
    await api.setFavorite(entry.key, favorite).catch(() => {});
  }

  async function refresh() {
    setBusy(true);
    try {
      await api.refresh(channel === 'all' ? undefined : channel);
      await Promise.all([loadEntries(true), loadChannels()]);
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  function captureSelection() {
    const selection = String(window.getSelection?.() ?? '').trim();
    if (!selected || selection === '') return;
    onMaterial({ space: 'feed', key: selected.key, title: selected.title, url: selected.url, selection, content: '' });
  }

  const groupsList = useMemo(() => {
    const groups = new Map();
    for (const item of channels) {
      if (item.kind === 'aggregate' && item.key !== 'all') continue;
      const key = item.group ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.entries()];
  }, [channels]);

  return (
    <div className="dpl-feed">
      <aside className="dpl-col dpl-sources" aria-label={t('feed.all')}>
        <div className="dpl-col-head">
          <button type="button" className="dpl-btn" onClick={() => setManaging(true)}>{t('feed.manage')}</button>
          <button type="button" className="dpl-icon-btn" title={t('feed.importOpml')} onClick={() => setOpml(true)}>⇥</button>
          <button type="button" className="dpl-icon-btn" title={t('feed.exportOpml')} onClick={async () => {
            const { xml } = await api.opmlExport().catch(() => ({ xml: '' }));
            if (xml) download('droplets-subscriptions.opml', xml, 'text/xml');
          }}>⇤</button>
        </div>
        <button
          type="button"
          className={'dpl-source' + (channel === 'all' ? ' is-active' : '')}
          onClick={() => setChannel('all')}
        >
          <span>{t('feed.all')}</span>
          <em>{channels.find((item) => item.key === 'all')?.unread ?? 0}</em>
        </button>
        {groupsList.map(([group, items]) => (
          <div className="dpl-source-group" key={group || '__none__'}>
            {group !== '' && <div className="dpl-source-group-name">{group}</div>}
            {items.map((item) => (
              <button
                type="button"
                key={item.key}
                className={'dpl-source' + (channel === item.key ? ' is-active' : '') + (item.lastError ? ' has-error' : '')}
                title={item.lastError ? t('feed.lastError') + ': ' + item.lastError : item.name}
                onClick={() => setChannel(item.key)}
              >
                <span>{item.name}</span>
                <em>{item.unread > 0 ? item.unread : ''}</em>
              </button>
            ))}
          </div>
        ))}
      </aside>

      <section className="dpl-col dpl-entries" aria-label={t('spaces.feed')}>
        <div className="dpl-col-head">
          <button type="button" className={'dpl-chip' + (filter === 'all' ? ' is-active' : '')} onClick={() => setFilter('all')}>{t('feed.allEntries')}</button>
          <button type="button" className={'dpl-chip' + (filter === 'unread' ? ' is-active' : '')} onClick={() => setFilter('unread')}>{t('feed.unreadOnly')} {unreadCount > 0 ? unreadCount : ''}</button>
          <button type="button" className={'dpl-chip' + (filter === 'favorite' ? ' is-active' : '')} onClick={() => setFilter('favorite')}>{t('feed.favorites')}</button>
          <button type="button" className="dpl-icon-btn" title={t('common.refresh')} disabled={busy} onClick={() => void refresh()}>{busy ? '⋯' : '⟳'}</button>
        </div>
        <div className="dpl-search">
          <input
            type="search"
            placeholder={t('common.searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {error && <div className="dpl-error" role="alert">{error}</div>}
        {entries.length === 0 && !busy && <div className="dpl-empty">{t('feed.noEntries')}</div>}
        <ul className="dpl-entry-list">
          {entries.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                className={'dpl-entry' + (selected?.key === entry.key ? ' is-active' : '') + (entry.read ? '' : ' is-unread')}
                onClick={() => void openEntry(entry)}
              >
                <span className="dpl-entry-title">{entry.title}</span>
                <span className="dpl-entry-meta">
                  {entry.channelName} · {formatDate(entry.publishedAt)}
                </span>
              </button>
              <button
                type="button"
                className={'dpl-star' + (entry.favorite ? ' is-on' : '')}
                aria-label={entry.favorite ? t('common.unfavorite') : t('common.favorite')}
                onClick={() => void toggleFavorite(entry)}
              >{entry.favorite ? '★' : '☆'}</button>
            </li>
          ))}
        </ul>
      </section>

      <section className="dpl-reader" onMouseUp={captureSelection}>
        {!selected && <div className="dpl-empty dpl-reader-empty">{t('feed.noFeedSelected')}</div>}
        {selected && (
          <article className="dpl-article">
            <header>
              <h1>{selected.title}</h1>
              <div className="dpl-article-meta">
                {selected.author ? <span>{selected.author}</span> : null}
                {selected.publishedAt ? <time>{formatDate(selected.publishedAt)}</time> : null}
                {selected.url ? (
                  <a href={selected.url} target="_blank" rel="noreferrer">{t('common.openSource')} ↗</a>
                ) : null}
              </div>
            </header>
            <SafeHtml className="dpl-article-body" html={html} />
          </article>
        )}
      </section>

      {managing && (
        <SubscriptionManager
          api={api}
          onClose={() => setManaging(false)}
          onChanged={async () => { await loadChannels(); await loadEntries(true); }}
        />
      )}
      {opml && (
        <OpmlDialog
          api={api}
          onClose={() => setOpml(false)}
          onImported={async () => { await loadChannels(); await refresh(); }}
        />
      )}
    </div>
  );
}

function SubscriptionManager({ api, onClose, onChanged }) {
  const [subscriptions, setSubscriptions] = useState([]);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.listSubscriptions().then(({ subscriptions: items }) => setSubscriptions(items)).catch((cause) => setError(String(cause?.message ?? cause)));
  }, [api]);

  async function add() {
    setBusy(true);
    setError('');
    try {
      await api.addSubscription({ url, name, group });
      setUrl(''); setName(''); setGroup('');
      const { subscriptions: items } = await api.listSubscriptions();
      setSubscriptions(items);
      await onChanged();
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  async function remove(sub) {
    if (!window.confirm(t('feed.confirmRemove'))) return;
    await api.removeSubscription(sub.id).catch(() => {});
    setSubscriptions((current) => current.filter((item) => item.id !== sub.id));
    await onChanged();
  }

  return (
    <Modal title={t('feed.subscriptions')} onClose={onClose} wide>
      <div className="dpl-form-row">
        <input placeholder={t('feed.feedUrl')} value={url} onChange={(event) => setUrl(event.target.value)} />
        <input placeholder={t('feed.feedName')} value={name} onChange={(event) => setName(event.target.value)} />
        <input placeholder={t('feed.feedGroup')} value={group} onChange={(event) => setGroup(event.target.value)} />
        <button type="button" className="dpl-btn" disabled={busy || url.trim() === ''} onClick={() => void add()}>{t('feed.add')}</button>
      </div>
      {error && <div className="dpl-error" role="alert">{error}</div>}
      <ul className="dpl-sub-list">
        {subscriptions.map((sub) => (
          <li key={sub.id}>
            <span className="dpl-sub-name">{sub.name}{sub.group ? ' · ' + sub.group : ''}</span>
            <span className="dpl-sub-meta">{sub.entryCount}{sub.lastError ? ' · ' + t('feed.lastError') : ''}</span>
            <button type="button" className="dpl-btn is-danger" onClick={() => void remove(sub)}>{t('feed.remove')}</button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function OpmlDialog({ api, onClose, onImported }) {
  const [text, setText] = useState('');
  const [entries, setEntries] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function preview() {
    setBusy(true);
    setError('');
    try {
      const result = await api.opmlPreview(text.trim().startsWith('http') ? { url: text.trim() } : { xml: text });
      setEntries(result.entries);
      setPicked(new Set(result.entries.filter((entry) => !entry.duplicate).map((entry) => entry.url)));
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  async function importSelected() {
    setBusy(true);
    try {
      const { xml } = await api.opmlPreview(text.trim().startsWith('http') ? { url: text.trim() } : { xml: text });
      await api.opmlImport(xml, [...picked]);
      onClose();
      await onImported();
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={t('feed.importOpml')} onClose={onClose} wide>
      <textarea
        className="dpl-opml-input"
        placeholder={t('feed.opmlFile') + ' / ' + t('feed.opmlUrl')}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={4}
      />
      <div className="dpl-form-row">
        <button type="button" className="dpl-btn" disabled={busy || text.trim() === ''} onClick={() => void preview()}>{t('feed.importOpml')}</button>
      </div>
      {error && <div className="dpl-error" role="alert">{error}</div>}
      {entries && (
        <>
          <ul className="dpl-sub-list">
            {entries.map((entry) => (
              <li key={entry.url}>
                <label className={entry.duplicate ? 'is-dim' : ''}>
                  <input
                    type="checkbox"
                    checked={picked.has(entry.url)}
                    disabled={entry.duplicate}
                    onChange={(event) => {
                      const next = new Set(picked);
                      if (event.target.checked) next.add(entry.url); else next.delete(entry.url);
                      setPicked(next);
                    }}
                  />
                  <span className="dpl-sub-name">{entry.name ?? entry.url}</span>
                  {entry.group ? <span className="dpl-sub-meta"> · {entry.group}</span> : null}
                  {entry.duplicate ? <span className="dpl-sub-meta"> · {t('feed.duplicate')}</span> : null}
                </label>
              </li>
            ))}
          </ul>
          <div className="dpl-form-row">
            <button type="button" className="dpl-btn" disabled={busy || picked.size === 0} onClick={() => void importSelected()}>
              {t('feed.importSelected')} ({picked.size})
            </button>
          </div>
        </>
      )}
    </Modal>
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

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
