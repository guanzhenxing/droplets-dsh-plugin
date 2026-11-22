import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, CheckCheck, Circle, CircleCheck, Download, ExternalLink, Inbox,
  ListPlus, Loader2, Plus, RefreshCw, TriangleAlert, Upload,
} from 'lucide-react';
import { t } from './i18n.js';
import { Modal, SafeHtml, formatDate } from './components.jsx';

/**
 * The feed space, interaction model ported from droplets' FeedPage:
 * sources (favicon badges, collapsible groups) / Folo-style entry rows
 * (source+date line, state dot + title, one-line summary) / preview with a
 * sticky round action group (translate slot reserved, open original, add to
 * inbox, skip). Ordering is session-frozen; a pill surfaces entries that
 * arrived through the background refresh; the first entry is selected (not
 * opened) so auto-selection never marks anything read.
 *
 * @param {{api:object, frozen:import('./frozen-sort.js').FrozenOrder,
 *          onMaterial:function, onJumpSpace?:function}} props
 */
export function FeedView({ api, frozen, onMaterial, onJumpSpace }) {
  const [channels, setChannels] = useState([]);
  const [channel, setChannel] = useState('all');
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [html, setHtml] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [managing, setManaging] = useState(false);
  const [opml, setOpml] = useState(false);
  const [confirmReadAll, setConfirmReadAll] = useState(false);
  const [favBusy, setFavBusy] = useState('');
  const loadSeq = useRef(0);
  const listScroll = useRef(null);
  const autoSelected = useRef(false);

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
      const page = await api.listEntries({ channel, filter: unreadOnly ? 'unread' : undefined, search: search || undefined, limit: 100 });
      if (seq !== loadSeq.current) return;
      setEntries(frozen.order(channel, page.entries));
    } catch (cause) {
      if (seq === loadSeq.current) setError(String(cause?.message ?? cause));
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  }, [api, channel, unreadOnly, search, frozen]);

  useEffect(() => { void loadChannels(); }, [loadChannels]);
  useEffect(() => { autoSelected.current = false; void loadEntries(); }, [loadEntries]);

  // New-entries pill: baseline = first page of each session (channel/filter);
  // background-refresh arrivals (not in baseline) count until acknowledged.
  const sessionKey = channel + '|' + (unreadOnly ? 'u' : 'a') + '|' + search;
  const baseline = useRef({ session: '', keys: new Set() });
  const [pillEpoch, setPillEpoch] = useState(0);
  const newCount = useMemo(() => {
    if (busy) return 0;
    if (baseline.current.session !== sessionKey) {
      // Never baseline an empty (still-loading) list: that would count every
      // entry as new. A genuinely empty list keeps newCount at 0 anyway.
      if (entries.length === 0) return 0;
      baseline.current = { session: sessionKey, keys: new Set(entries.map((entry) => entry.key)) };
      return 0;
    }
    let count = 0;
    for (const entry of entries) if (!baseline.current.keys.has(entry.key)) count += 1;
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, sessionKey, busy, pillEpoch]);

  const unreadCount = useMemo(() => channels.find((item) => item.key === channel)?.unread ?? 0, [channels, channel]);
  const listTitle = useMemo(() => {
    if (channel === 'all') return t('feed.articles');
    return channels.find((item) => item.key === channel)?.name ?? t('feed.articles');
  }, [channel, channels]);
  const channelNameOf = useCallback((key) => {
    const found = channels.find((item) => item.key === key);
    return found?.name ?? '';
  }, [channels]);

  // Load one entry into the preview; markRead only on genuine user opens.
  const openEntry = useCallback(async (entry, { markRead = true } = {}) => {
    setSelected(entry);
    setHtml('');
    setError('');
    try {
      const result = await api.getEntry(entry.key);
      setHtml(result.html ?? '');
      onMaterial({ space: 'feed', key: entry.key, title: entry.title, url: entry.url, content: plainOf(result.html ?? '') });
      if (markRead && !entry.read) {
        setEntries((current) => current.map((item) => (item.key === entry.key ? { ...item, read: true } : item)));
        void api.setRead([entry.key], true).then(() => void loadChannels());
        setSelected({ ...entry, read: true });
      }
    } catch (cause) {
      setError(String(cause?.message ?? cause));
    }
  }, [api, onMaterial, loadChannels]);

  // Empty-selection auto-select (droplets): pure selection, never marks read.
  useEffect(() => {
    if (autoSelected.current || selected !== null || entries.length === 0) return;
    autoSelected.current = true;
    void openEntry(entries[0], { markRead: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  async function toggleFavorite(entry) {
    const favorite = !entry.favorite;
    setFavBusy(entry.key);
    setEntries((current) => current.map((item) => (item.key === entry.key ? { ...item, favorite } : item)));
    if (selected?.key === entry.key) setSelected({ ...selected, favorite });
    await api.setFavorite(entry.key, favorite).catch(() => {});
    setFavBusy('');
  }

  async function refresh() {
    setBusy(true);
    try {
      await api.refresh(channel === 'all' ? undefined : channel);
      await Promise.all([loadEntries(true), loadChannels()]);
    } catch (cause) { setError(String(cause?.message ?? cause)); }
    finally { setBusy(false); }
  }

  async function markAllRead() {
    const keys = entries.filter((entry) => !entry.read).map((entry) => entry.key);
    if (keys.length === 0) return;
    setConfirmReadAll(false);
    setEntries((current) => current.map((entry) => (entry.read ? entry : { ...entry, read: true })));
    await api.setRead(keys, true).catch(() => {});
    await loadChannels().catch(() => {});
  }

  async function addToInbox(entry) {
    if (!entry.url) return;
    setNotice('');
    try {
      await api.inboxAddUrl({ url: entry.url });
      setNotice(t('feed.sentToInbox'));
      onJumpSpace?.('inbox');
    } catch (cause) { setNotice(String(cause?.message ?? cause)); }
  }

  async function skipEntry(entry) {
    if (!entry.read) {
      setEntries((current) => current.map((item) => (item.key === entry.key ? { ...item, read: true } : item)));
      await api.setRead([entry.key], true).catch(() => {});
      void loadChannels();
    }
    const index = entries.findIndex((item) => item.key === entry.key);
    const next = entries.slice(index + 1).find((item) => !item.read) ?? entries[index + 1];
    if (next) void openEntry(next);
  }

  function captureSelection() {
    const selection = String(window.getSelection?.() ?? '').trim();
    if (!selected || selection === '') return;
    onMaterial({ space: 'feed', key: selected.key, title: selected.title, url: selected.url, selection, content: '' });
  }

  const groupsList = useMemo(() => {
    const groups = new Map();
    for (const item of channels) {
      if (item.kind !== 'feed') continue;
      const key = item.group ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.entries()];
  }, [channels]);

  return (
    <div className="dpl-feed">
      <aside className="dpl-col dpl-sources" aria-label={t('feed.sources')}>
        <div className="dpl-col-head">
          <span className="dpl-pane-title">{t('feed.sources')}</span>
          <span className="dpl-flex-fill" />
          <button type="button" className="dpl-icon-btn" title={t('feed.addSubscription')} aria-label={t('feed.addSubscription')} onClick={() => setManaging(true)}><Plus size={16} /></button>
          <button type="button" className="dpl-icon-btn" title={t('feed.manage')} aria-label={t('feed.manage')} onClick={() => setManaging(true)}><ListPlus size={16} /></button>
          <button type="button" className="dpl-icon-btn" title={t('feed.exportOpml')} aria-label={t('feed.exportOpml')} onClick={async () => {
            const { xml } = await api.opmlExport().catch(() => ({ xml: '' }));
            if (xml) download('droplets-subscriptions.opml', xml, 'text/xml');
          }}><Download size={16} /></button>
        </div>
        <div className="dpl-source-tools">
          <div className="dpl-search">
            <input type="search" placeholder={t('common.searchPlaceholder')} value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <button type="button" className="dpl-icon-btn" title={t('common.refresh')} aria-label={t('common.refresh')} disabled={busy} onClick={() => void refresh()}>
            {busy ? <Loader2 size={16} className="dpl-spin" /> : <RefreshCw size={16} />}
          </button>
        </div>
        <div className="dpl-sources-list">
          <button type="button" className={'dpl-source' + (channel === 'all' ? ' is-active' : '')} onClick={() => setChannel('all')}>
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
                  className={'dpl-source' + (channel === item.key ? ' is-active' : '')}
                  title={item.lastError ? t('feed.lastError') + ': ' + item.lastError : item.name}
                  onClick={() => setChannel(item.key)}
                >
                  <SourceBadge name={item.name} />
                  <span>{item.name}</span>
                  {item.lastError ? <TriangleAlert size={13} className="dpl-source-error" /> : null}
                  <em>{item.unread > 0 ? item.unread : ''}</em>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <section className="dpl-col dpl-entries" aria-label={t('spaces.feed')}>
        <div className="dpl-col-head">
          <span className="dpl-pane-title dpl-truncate">{listTitle}</span>
          <span className="dpl-flex-fill" />
          <button type="button" className={'dpl-icon-btn' + (unreadOnly ? ' is-on' : '')} title={t('feed.unreadOnly')} aria-label={t('feed.unreadOnly')} aria-pressed={unreadOnly} onClick={() => setUnreadOnly((value) => !value)}>
            <Circle size={15} className={unreadOnly ? 'dpl-fill' : undefined} />
          </button>
          <button type="button" className={'dpl-icon-btn' + (!unreadOnly ? ' is-on' : '')} title={t('feed.readOnly')} aria-label={t('feed.readOnly')} aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>
            <CircleCheck size={16} />
          </button>
          <button type="button" className="dpl-icon-btn" title={t('feed.markAllRead')} aria-label={t('feed.markAllRead')} disabled={unreadCount === 0} onClick={() => setConfirmReadAll(true)}>
            <CheckCheck size={16} />
          </button>
          <button type="button" className="dpl-icon-btn" title={t('feed.importOpml')} aria-label={t('feed.importOpml')} onClick={() => setOpml(true)}><Upload size={16} /></button>
        </div>
        {newCount > 0 && (
          <button type="button" className="dpl-new-pill" onClick={() => {
            listScroll.current?.scrollTo({ top: 0 });
            baseline.current = { session: sessionKey, keys: new Set(entries.map((entry) => entry.key)) };
            setPillEpoch((epoch) => epoch + 1);
          }}>
            {t('feed.newItems', { count: newCount })}
          </button>
        )}
        {error && <div className="dpl-error" role="alert">{error}</div>}
        <div className="dpl-entry-scroll" ref={listScroll}>
          {entries.length === 0 && !busy && <div className="dpl-empty">{t('feed.noEntries')}</div>}
          {entries.map((entry) => (
            <div
              key={entry.key}
              className={'dpl-entry-row' + (selected?.key === entry.key ? ' is-active' : '')}
              onClick={() => void openEntry(entry)}
            >
              <div className="dpl-entry-src">
                <SourceBadge name={entry.channelName ?? channelNameOf(entry.channelKey)} />
                <span className="dpl-truncate">{entry.channelName ?? channelNameOf(entry.channelKey)}</span>
                {entry.publishedAt ? <>, <span>{formatDate(entry.publishedAt)}</span></> : null}
                <span className="dpl-flex-fill" />
                <button
                  type="button"
                  className={'dpl-star' + (entry.favorite ? ' is-on' : '')}
                  aria-label={entry.favorite ? t('common.unfavorite') : t('common.favorite')}
                  disabled={favBusy === entry.key}
                  onClick={(event) => { event.stopPropagation(); void toggleFavorite(entry); }}
                >{entry.favorite ? '★' : '☆'}</button>
              </div>
              <div className="dpl-entry-main">
                <span className={'dpl-dot' + (entry.read ? ' is-read' : '')} data-state={entry.read ? 'seen' : 'unseen'} />
                <span className={'dpl-truncate ' + (entry.read ? '' : 'is-unread')}>{entry.title}</span>
              </div>
              {entry.summary ? <p className="dpl-entry-sum">{entry.summary}</p> : null}
            </div>
          ))}
        </div>
      </section>

      <section className="dpl-reader" onMouseUp={captureSelection}>
        {!selected && <div className="dpl-empty dpl-reader-empty">{t('feed.pickToPreview')}</div>}
        {selected && (
          <>
            <div className="dpl-reader-actions-float">
              {selected.url ? (
                <a className="dpl-round-btn" href={selected.url} target="_blank" rel="noreferrer" title={t('common.openSource')} aria-label={t('common.openSource')}>
                  <ExternalLink size={15} />
                </a>
              ) : null}
              <button type="button" className="dpl-round-btn" title={t('feed.addToInbox')} aria-label={t('feed.addToInbox')} onClick={() => void addToInbox(selected)}>
                <Inbox size={15} />
              </button>
              <button type="button" className="dpl-round-btn" title={t('feed.skip')} aria-label={t('feed.skip')} onClick={() => void skipEntry(selected)}>
                <Archive size={15} />
              </button>
            </div>
            {notice && <div className="dpl-notice" role="status">{notice}</div>}
            <article className="dpl-article">
              <header>
                <h1>{selected.title}</h1>
                <div className="dpl-article-meta">
                  <SourceBadge name={selected.channelName ?? ''} />
                  <span>{selected.channelName}</span>
                  {selected.author ? <span>{selected.author}</span> : null}
                  {selected.publishedAt ? <time>{formatDate(selected.publishedAt)}</time> : null}
                  <span>{selected.read ? t('feed.stateRead') : t('feed.stateUnread')}</span>
                </div>
              </header>
              <SafeHtml className="dpl-article-body" html={html} />
            </article>
          </>
        )}
      </section>

      {confirmReadAll && (
        <Modal title={t('feed.markAllRead')} onClose={() => setConfirmReadAll(false)}>
          <p>{t('feed.markAllReadConfirm', { count: unreadCount })}</p>
          <div className="dpl-form-row">
            <button type="button" className="dpl-btn" onClick={() => setConfirmReadAll(false)}>{t('common.cancel')}</button>
            <button type="button" className="dpl-btn is-primary" onClick={() => void markAllRead()}>{t('common.done')}</button>
          </div>
        </Modal>
      )}

      {managing && (
        <SubscriptionManager api={api} onClose={() => setManaging(false)} onChanged={async () => { await loadChannels(); await loadEntries(true); }} />
      )}
      {opml && (
        <OpmlDialog api={api} onClose={() => setOpml(false)} onImported={async () => { await loadChannels(); await refresh(); }} />
      )}
    </div>
  );
}

/** Deterministic pastel badge (droplets badgeColorOf port, DSW-toned). */
const BADGE_HUES = [212, 262, 292, 322, 352, 22, 52, 142, 172];
export function SourceBadge({ name }) {
  const label = String(name ?? '').trim();
  const letter = (label[0] ?? '?').toUpperCase();
  let seed = 0;
  for (const ch of label) seed = (seed * 31 + ch.codePointAt(0)) >>> 0;
  const hue = BADGE_HUES[seed % BADGE_HUES.length];
  return (
    <span
      className="dpl-badge"
      aria-hidden="true"
      style={{ background: 'oklch(0.9 0.05 ' + hue + ')', color: 'oklch(0.45 0.11 ' + hue + ')' }}
    >{letter}</span>
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
        <button type="button" className="dpl-btn is-primary" disabled={busy || url.trim() === ''} onClick={() => void add()}>{busy ? <Loader2 size={14} className="dpl-spin" /> : t('feed.add')}</button>
      </div>
      {error && <div className="dpl-error" role="alert">{error}</div>}
      <ul className="dpl-sub-list">
        {subscriptions.map((sub) => (
          <li key={sub.id}>
            <SourceBadge name={sub.name} />
            <span className="dpl-sub-name">{sub.name}{sub.group ? ' · ' + sub.group : ''}</span>
            <span className="dpl-sub-meta">{sub.entryCount}{sub.lastError ? ' · ' + t('feed.lastError') : ''}</span>
            <button type="button" className="dpl-icon-btn" title={t('feed.remove')} aria-label={t('feed.remove')} onClick={() => void remove(sub)}>✕</button>
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
      <textarea className="dpl-opml-input" placeholder={t('feed.opmlFile') + ' / ' + t('feed.opmlUrl')} value={text} onChange={(event) => setText(event.target.value)} rows={4} />
      <div className="dpl-form-row">
        <button type="button" className="dpl-btn is-primary" disabled={busy || text.trim() === ''} onClick={() => void preview()}>{busy ? <Loader2 size={14} className="dpl-spin" /> : t('feed.importOpml')}</button>
      </div>
      {error && <div className="dpl-error" role="alert">{error}</div>}
      {entries && (
        <>
          <ul className="dpl-sub-list">
            {entries.map((entry) => (
              <li key={entry.url}>
                <label className={entry.duplicate ? 'is-dim' : ''}>
                  <input type="checkbox" checked={picked.has(entry.url)} disabled={entry.duplicate} onChange={(event) => {
                    const next = new Set(picked);
                    if (event.target.checked) next.add(entry.url); else next.delete(entry.url);
                    setPicked(next);
                  }} />
                  <SourceBadge name={entry.name ?? entry.url} />
                  <span className="dpl-sub-name">{entry.name ?? entry.url}</span>
                  {entry.group ? <span className="dpl-sub-meta"> · {entry.group}</span> : null}
                  {entry.duplicate ? <span className="dpl-sub-meta"> · {t('feed.duplicate')}</span> : null}
                </label>
              </li>
            ))}
          </ul>
          <div className="dpl-form-row">
            <button type="button" className="dpl-btn is-primary" disabled={busy || picked.size === 0} onClick={() => void importSelected()}>
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
