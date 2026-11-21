import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from './i18n.js';
import { SafeHtml, formatBytes, formatDate } from './components.jsx';
import { openPdf } from './pdf-view.js';
import { openEpub } from './epub-view.js';

/**
 * The inbox space: entries (320) / reading + companion. Process and leave —
 * organize into the vault through the companion (source lands in frontmatter
 * via the agent tool) or delete after reading. Web pages render through the
 * sanitized SafeHtml path; PDF/EPUB originals render locally.
 *
 * @param {{api:object, onMaterial:function}} props
 */
export function InboxView({ api, onMaterial }) {
  const [items, setItems] = useState([]);
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState(null);
  const [doc, setDoc] = useState(null); // { kind, html?, pdf?, epub?, chapter }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const docRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const { items: next } = await api.inboxList({});
      setItems(next);
    } catch (cause) { setError(String(cause?.message ?? cause)); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => () => { docRef.current?.destroy?.(); }, []);

  async function addUrl() {
    const trimmed = url.trim();
    if (trimmed === '') return;
    setBusy(true);
    setError('');
    try {
      const { item, duplicate } = await api.inboxAddUrl({ url: trimmed });
      setUrl('');
      await load();
      if (!duplicate && item?.key) await open(item);
    } catch (cause) {
      setError(String(cause?.message ?? cause));
      await load();
    } finally { setBusy(false); }
  }

  async function open(item) {
    setSelected(item);
    setError('');
    docRef.current?.destroy?.();
    docRef.current = null;
    setDoc({ kind: 'loading' });
    try {
      const result = await api.inboxRead(item.key);
      if (result.item.kind === 'web') {
        setDoc({ kind: 'web', html: result.html ?? '', destroy: null });
        onMaterial({ space: 'inbox', key: item.key, title: result.item.title, url: result.item.url, content: plainOf(result.html ?? '') });
      } else if (result.item.kind === 'pdf') {
        const pdf = await openPdf(result.base64);
        docRef.current = pdf;
        setDoc({ kind: 'pdf', pdf, page: 1, destroy: () => pdf.destroy() });
        onMaterial({ space: 'inbox', key: item.key, title: result.item.title, url: result.item.url, content: '' });
      } else {
        const epub = openEpub(result.base64);
        docRef.current = epub;
        setDoc({ kind: 'epub', epub, chapter: 0, destroy: () => epub.destroy() });
        onMaterial({ space: 'inbox', key: item.key, title: result.item.title, url: result.item.url, content: epub.chapters.map((chapter) => plainOf(chapter.html)).join('\n').slice(0, 60000) });
      }
      await load();
    } catch (cause) {
      setError(String(cause?.message ?? cause));
      setDoc({ kind: 'error', message: String(cause?.message ?? cause) });
    }
  }

  async function markDone(item) {
    await api.inboxMarkDone(item.key).catch(() => {});
    if (selected?.key === item.key) { setSelected(null); setDoc(null); }
    await load();
  }

  function organize(item) {
    onMaterial({
      space: 'inbox',
      key: item.key,
      title: item.title,
      url: item.url,
      content: '',
      excerpt: item.excerpt,
      action: 'organize',
      prompt: t('inbox.organizePrompt'),
    });
  }

  function captureSelection() {
    const selection = String(window.getSelection?.() ?? '').trim();
    if (!selected || selection === '') return;
    onMaterial({ space: 'inbox', key: selected.key, title: selected.title, url: selected.url, selection, content: '' });
  }

  return (
    <div className="dpl-inbox">
      <aside className="dpl-col dpl-inbox-list" aria-label={t('spaces.inbox')}>
        <div className="dpl-inbox-add">
          <input
            type="url"
            placeholder={t('inbox.urlPlaceholder')}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void addUrl(); }}
          />
          <button type="button" className="dpl-btn" disabled={busy || url.trim() === ''} onClick={() => void addUrl()}>{busy ? t('inbox.fetching') : t('inbox.add')}</button>
        </div>
        {error && <div className="dpl-error" role="alert">{error}</div>}
        {items.length === 0 && !busy && (
          <div className="dpl-empty">
            <p>{t('inbox.empty')}</p>
            <p className="dpl-hint">{t('inbox.doneHint')}</p>
          </div>
        )}
        <ul className="dpl-entry-list">
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className={'dpl-entry' + (selected?.key === item.key ? ' is-active' : '') + (item.readAt ? '' : ' is-unread')}
                onClick={() => void open(item)}
              >
                <span className="dpl-entry-title">{item.title}</span>
                <span className="dpl-entry-meta">
                  {kindLabel(item.kind)} · {formatDate(item.addedAt)}{item.bytes ? ' · ' + formatBytes(item.bytes) : ''}
                </span>
                {item.status === 'error' && <span className="dpl-entry-meta dpl-warn">{item.error}</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="dpl-reader" onMouseUp={captureSelection}>
        {!selected && <div className="dpl-empty dpl-reader-empty"><p>{t('inbox.empty')}</p><p className="dpl-hint">{t('inbox.doneHint')}</p></div>}
        {selected && doc && (
          <>
            <header className="dpl-reader-toolbar">
              <h1>{selected.title}</h1>
              <div className="dpl-reader-actions">
                {selected.url ? <a className="dpl-btn" href={selected.url} target="_blank" rel="noreferrer">{t('inbox.openOriginal')} ↗</a> : null}
                <button type="button" className="dpl-btn" onClick={() => organize(selected)}>{t('inbox.organize')}</button>
                <button type="button" className="dpl-btn is-danger" onClick={() => void markDone(selected)}>{t('common.delete')}</button>
              </div>
            </header>
            {doc.kind === 'loading' && <div className="dpl-empty">{t('common.loading')}</div>}
            {doc.kind === 'error' && <div className="dpl-error" role="alert">{doc.message}</div>}
            {doc.kind === 'web' && <SafeHtml className="dpl-article-body" html={doc.html} />}
            {doc.kind === 'pdf' && <PdfReader doc={doc} setDoc={setDoc} />}
            {doc.kind === 'epub' && <EpubReader doc={doc} setDoc={setDoc} />}
          </>
        )}
      </section>
    </div>
  );
}

function kindLabel(kind) {
  if (kind === 'pdf') return t('inbox.pdf');
  if (kind === 'epub') return t('inbox.epub');
  return t('inbox.webpage');
}

function PdfReader({ doc, setDoc }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        await doc.pdf.renderPage(doc.page, canvas);
      } catch {
        if (!cancelled) setDoc({ ...doc, kind: 'error', message: 'PDF 渲染失败' });
      }
    })();
    return () => { cancelled = true; };
  }, [doc, setDoc]);

  return (
    <div className="dpl-pdf">
      <div className="dpl-pager">
        <button type="button" className="dpl-btn" disabled={doc.page <= 1} onClick={() => setDoc({ ...doc, page: doc.page - 1 })}>←</button>
        <span>{doc.page} / {doc.pdf.numPages}</span>
        <button type="button" className="dpl-btn" disabled={doc.page >= doc.pdf.numPages} onClick={() => setDoc({ ...doc, page: doc.page + 1 })}>→</button>
      </div>
      <canvas ref={canvasRef} className="dpl-pdf-canvas" />
    </div>
  );
}

function EpubReader({ doc, setDoc }) {
  const chapters = doc.epub.chapters;
  const chapter = chapters[Math.min(doc.chapter, chapters.length - 1)];
  return (
    <div className="dpl-epub">
      <div className="dpl-pager">
        <button type="button" className="dpl-btn" disabled={doc.chapter <= 0} onClick={() => setDoc({ ...doc, chapter: doc.chapter - 1 })}>←</button>
        <span>{doc.chapter + 1} / {chapters.length}</span>
        <button type="button" className="dpl-btn" disabled={doc.chapter >= chapters.length - 1} onClick={() => setDoc({ ...doc, chapter: doc.chapter + 1 })}>→</button>
      </div>
      <SafeHtml className="dpl-article-body" html={chapter?.html ?? ''} />
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
