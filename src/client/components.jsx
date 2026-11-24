import { useCallback, useEffect, useRef } from 'react';
import { markdownToHtml, purifyHtml } from './md.js';

/**
 * Render sanitized HTML without ever assigning innerHTML with markup: the
 * fragment goes through DOMParser (a real document context, scripts never
 * execute there) and the parsed nodes are adopted into the live tree.
 */
export function SafeHtml({ html, className, onLinkClick, onMount }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    node.replaceChildren();
    const clean = purifyHtml(String(html ?? ''));
    const parsed = new DOMParser().parseFromString('<!doctype html><body>' + clean, 'text/html');
    node.append(...[...parsed.body.childNodes]);
    onMount?.(node);
    if (onLinkClick) {
      const handler = (event) => {
        const anchor = event.target?.closest?.('a');
        if (anchor) onLinkClick(anchor, event);
      };
      node.addEventListener('click', handler);
      return () => node.removeEventListener('click', handler);
    }
    return undefined;
  }, [html, onLinkClick, onMount]);
  return <div className={className} ref={ref} />;
}

/** Markdown reading view (vault notes, companion text). */
export function MarkdownView({ markdown, className, onWikilink, resolveImage }) {
  const handleLink = onWikilink
    ? (anchor, event) => {
        const href = anchor.getAttribute('href') ?? '';
        const target = anchor.getAttribute('data-dpl-target');
        if (href.startsWith('dpl-note:') || target) {
          event.preventDefault();
          onWikilink(target ?? decodeURIComponent(href.slice('dpl-note:'.length)), anchor);
        }
      }
    : undefined;

  // Local image references (vault attachments / Obsidian embeds) render as
  // data URLs: after the sanitized tree lands, rewrite every non-remote
  // <img> through the caller's resolver. Remote URLs pass straight through.
  const onMount = resolveImage
    ? useCallback((node) => {
        const images = [...node.querySelectorAll('img')];
        for (const img of images) {
          const raw = img.getAttribute('src') ?? '';
          if (!raw || /^(https?:|data:|blob:)/i.test(raw)) continue;
          img.removeAttribute('src');
          img.dataset.pendingSrc = raw;
          Promise.resolve(resolveImage(raw))
            .then((url) => { if (url) { img.src = url; delete img.dataset.pendingSrc; } })
            .catch(() => { /* unresolvable: keep the empty img */ });
        }
      }, [resolveImage])
    : undefined;

  return <SafeHtml className={className} html={markdownToHtml(markdown)} onLinkClick={handleLink} onMount={onMount} />;
}

export function DropletIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2.7c3.2 3.9 6.3 7.6 6.3 11.2A6.3 6.3 0 0 1 12 20.3a6.3 6.3 0 0 1-6.3-6.4C5.7 10.3 8.8 6.6 12 2.7Z" fill="currentColor" fillOpacity=".9" />
      <path d="M9.2 13.8a2.8 2.8 0 0 0 2.4 2.7" stroke="#fff" strokeOpacity=".85" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dpl-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className={'dpl-modal' + (wide ? ' is-wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <strong>{title}</strong>
          <button type="button" className="dpl-icon-btn" aria-label="关闭" onClick={onClose}>✕</button>
        </header>
        <div className="dpl-modal-body">{children}</div>
      </div>
    </div>
  );
}

export function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
