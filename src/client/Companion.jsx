import { useEffect, useRef, useState } from 'react';
import { t } from './i18n.js';

/**
 * The native companion panel. The material on the left is whatever the
 * space renders; the Harness conversation stays mounted on the right inside
 * the host-provided SessionProvider.
 *
 * Lifecycle contract (the four release paths): closing the panel (unmount),
 * switching material (re-bind, one live reference), a request being
 * superseded (generation counter), and error paths (release on throw). Input
 * guards throw visible errors instead of silently skipping; a draft that
 * fails to sync within 1200 ms degrades to a manual-send notice.
 *
 * @param {{api:object, material:object, onClose:function, SessionProvider?:Function,
 *          renderSlot?:Function, storagePrefix?:string}} props
 */
export function Companion({ api, material, onClose, SessionProvider, renderSlot, storagePrefix = 'droplets' }) {
  const [workspaceId, setWorkspaceId] = useState(() => api.defaultChatWorkspace?.());
  const [chat, setChat] = useState(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(true);
  const [attached, setAttached] = useState('');
  const [notice, setNotice] = useState('');
  const [sendingPrompt, setSendingPrompt] = useState(false);
  const sending = useRef(false);
  const owned = useRef(null);
  const generation = useRef(0);
  const started = useRef(false);
  const bindingQueue = useRef(Promise.resolve());

  const materialKey = [material.space, material.key ?? material.path ?? '', material.selection || ''].join('|');

  const bindContext = (request) => {
    const pending = bindingQueue.current.catch(() => {}).then(() => api.setReadingContext(request));
    bindingQueue.current = pending;
    return pending;
  };

  useEffect(() => {
    if (workspaceId) return;
    return api.watchChatWorkspaces?.(() => setWorkspaceId(api.defaultChatWorkspace?.()));
  }, [api, workspaceId]);

  // Unmount: release (path 1 - closing the panel).
  useEffect(() => () => { generation.current += 1; owned.current?.release(); }, []);

  useEffect(() => { setActionError(''); setNotice(''); }, [materialKey]);

  async function start(fresh = false) {
    if (!workspaceId) return;
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setActionError('');
    let acquired;
    try {
      const storeKey = `${storagePrefix}.chat.${workspaceId}.${material.space}`;
      const saved = fresh ? null : localStorage.getItem(storeKey);
      try {
        acquired = await api.openChat({ workspaceId, sessionId: saved || undefined });
      } catch (cause) {
        if (!saved) throw cause;
        localStorage.removeItem(storeKey);
        acquired = await api.openChat({ workspaceId });
      }
      if (current !== generation.current) { acquired.release(); return; } // superseded (path 3)
      await bindContext({ sessionId: acquired.sessionId, material });
      if (current !== generation.current) { acquired.release(); return; }
      owned.current?.release(); // material switch keeps one live reference (path 2)
      owned.current = acquired;
      setChat(acquired);
      setAttached(materialKey);
      localStorage.setItem(storeKey, acquired.sessionId);
      acquired = null;
    } catch (cause) {
      acquired?.release(); // error path (path 4)
      setError(cause?.message ?? String(cause));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!workspaceId || started.current) return;
    started.current = true;
    void start();
  }, [workspaceId]);

  // One-shot automation prompt (e.g. "organize into the vault"): submitted
  // once per material, only after the context binding has settled.
  const autoPrompt = material.action === 'organize' && typeof material.prompt === 'string' ? material.prompt : '';
  const autoSentFor = useRef('');
  useEffect(() => {
    if (!chat || attached !== materialKey || autoPrompt === '' || autoSentFor.current === materialKey) return;
    autoSentFor.current = materialKey;
    void chat.submitPrompt(autoPrompt).catch((cause) => {
      const message = cause?.message ?? String(cause);
      if (message.includes('手动发送')) setNotice(message);
      else if (message.includes('已有草稿')) setActionError(t('companion.draftPending'));
      else setActionError(t('companion.sendFailed') + '：' + message);
    });
  }, [chat, attached, materialKey, autoPrompt]);

  // Material switch: re-bind the same session, keep composer/shell mounted.
  useEffect(() => {
    if (!chat || attached === materialKey) return;
    let stale = false;
    setError('');
    bindContext({ sessionId: chat.sessionId, material })
      .then(() => { if (!stale) setAttached(materialKey); })
      .catch((cause) => { if (!stale) setError(cause?.message ?? String(cause)); });
    return () => { stale = true; };
  }, [chat, materialKey]);

  async function sendPrompt() {
    if (sending.current || !chat || attached !== materialKey) return;
    sending.current = true;
    setSendingPrompt(true);
    setActionError('');
    try {
      const prompt = material.selection
        ? `请解释选中段落的含义与上下文：\n${material.selection.slice(0, 2000)}`
        : '请总结这篇材料的主要观点、论据与值得追问的问题。';
      await chat.submitPrompt(prompt);
    } catch (cause) {
      const message = cause?.message ?? String(cause);
      if (message.includes('手动发送')) setNotice(message);
      else if (message.includes('已有草稿')) setActionError(t('companion.draftPending'));
      else setActionError(`${t('companion.sendFailed')}：${message}`);
    } finally {
      setSendingPrompt(false);
      sending.current = false;
    }
  }

  return (
    <aside className="dpl-companion" aria-label={t('companion.title')}>
      <header className="dpl-companion-header">
        <strong>{material.space === 'vault-search' ? t('companion.askVaultTitle') : t('companion.title')}</strong>
        <button className="dpl-icon-btn" title={t('companion.newChat')} aria-label={t('companion.newChat')} onClick={() => void start(true)} disabled={busy || !workspaceId}>＋</button>
        <button className="dpl-icon-btn" title={t('companion.close')} aria-label={t('companion.close')} onClick={onClose}>✕</button>
      </header>
      <div className="dpl-companion-context">
        <strong>{material.title}</strong>
        <small>
          {material.selection ? t('companion.contextSelection') : t('companion.contextArticle')}
          {material.url ? ` · ${hostOf(material.url)}` : ''}
        </small>
      </div>
      {error && (
        <div className="dpl-companion-error" role="alert">
          <strong>{error.includes('不支持') ? t('companion.unsupported') : t('companion.connectionFailed')}</strong>
          <p>{error}</p>
          <button type="button" onClick={() => void start()}>{t('companion.reconnect')}</button>
        </div>
      )}
      {actionError && (
        <div className="dpl-companion-notice" role="status">
          <span>{actionError}</span>
          <button type="button" aria-label={t('common.close')} onClick={() => setActionError('')}>✕</button>
        </div>
      )}
      {notice && (
        <div className="dpl-companion-notice" role="status">
          <span>{t('companion.manualSend')}</span>
          <button type="button" aria-label={t('common.close')} onClick={() => setNotice('')}>✕</button>
        </div>
      )}
      {!chat && !error && <div className="dpl-companion-loading" role="status">{workspaceId ? t('companion.opening') : t('companion.connecting')}</div>}
      {chat && attached !== materialKey && !error && <div className="dpl-companion-loading" role="status">{t('companion.syncing')}</div>}
      {chat && SessionProvider && renderSlot && (
        <div className="dpl-native-chat">
          <SessionProvider session={chat.reference}>{renderSlot('droplets.chat', {})}</SessionProvider>
        </div>
      )}
      {material.selection && (
        <section className="dpl-companion-quote" aria-label={t('companion.quote')} aria-busy={attached !== materialKey}>
          <strong>{t('companion.quote')} · {Array.from(material.selection).length} {t('companion.characters')}</strong>
          <blockquote>{material.selection}</blockquote>
        </section>
      )}
      <div className="dpl-companion-prompt-strip" role="group" aria-label={t('companion.title')}>
        <button
          type="button"
          className="dpl-prompt-ghost"
          disabled={sendingPrompt || attached !== materialKey}
          onClick={() => void sendPrompt()}
        >
          {material.selection ? t('companion.askSelection') : t('companion.askArticle')}
        </button>
      </div>
    </aside>
  );
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}
