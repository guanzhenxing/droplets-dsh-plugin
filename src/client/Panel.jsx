import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n.js';
import { DropletIcon, Modal } from './components.jsx';
import { FeedView } from './FeedView.jsx';
import { InboxView } from './InboxView.jsx';
import { VaultView } from './VaultView.jsx';
import { SettingsView } from './SettingsView.jsx';
import { Settings } from 'lucide-react';
import { Companion } from './Companion.jsx';

// RSS 与 News 是同一订阅池的两个分区(surface):同一个 FeedView,不同
// 的 surface 过滤;收件箱不变;知识库留在本包,直到独立知识库插件落地。
const SPACES = [
  { id: 'rss', label: () => 'RSS' },
  { id: 'news', label: () => 'News' },
  { id: 'inbox', label: () => t('spaces.inbox') },
  { id: 'vault', label: () => t('spaces.vault') },
];

/**
 * The droplets main panel: one sidebar entry, three spaces inside. The
 * companion is an enhancement — every client call is guarded, and when the
 * chain breaks the three data spaces keep working with a visible notice.
 */
export function DropletsPanel({ api, SessionProvider, renderSlot }) {
  const [space, setSpace] = useState('rss');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [companionOpen, setCompanionOpen] = useState(false);
  // Docked = a real flex pane that squeezes the spaces (never covers the
  // article); floating = the draggable fixed window. Panel owns the form so
  // it can place the component in the right DOM position for each shape.
  const [companionForm, setCompanionForm] = useState(() => localStorage.getItem('droplets.ai.form') ?? 'docked');
  const changeCompanionForm = useCallback((next) => {
    setCompanionForm(next);
    try { localStorage.setItem('droplets.ai.form', next); } catch { /* ignore */ }
  }, []);
  const [material, setMaterial] = useState({ space: 'feed', title: '' });
  /** Cross-space hand-off: 文章存为笔记 asks the vault to open the new note. */
  const [vaultNoteRequest, setVaultNoteRequest] = useState(null);
  const openVaultNote = useCallback((notePath) => {
    if (typeof notePath === 'string' && notePath !== '') {
      setVaultNoteRequest({ path: notePath, nonce: Date.now() });
      setSpace('vault');
    }
  }, []);

  // Window focus triggers a light vault rescan (index staleness guard).
  const onFocus = useCallback(() => { void api.vaultReindex?.().catch(() => {}); }, [api]);
  useEffect(() => {
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [onFocus]);

  const onMaterial = useCallback((next, options = {}) => {
    setMaterial(next);
    // Only an explicit 问 AI reveals the companion. Switching articles keeps
    // the context fresh but must never resurrect a pane the user closed.
    if (options.reveal) setCompanionOpen(true);
  }, []);

  // Global tooltip layer (droplets TooltipLayer parity): one fixed div at the
  // body level, fed by delegated pointerover/out on [data-tip]. Solves two
  // things the pure-CSS ::after cannot: tooltips inside scroll containers
  // were clipped, and their invisible text polluted scrollWidth metrics.
  useEffect(() => {
    const tip = document.createElement('div');
    tip.className = 'dpl-gtip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    let current = null;
    const place = (target) => {
      const rect = target.getBoundingClientRect();
      tip.style.top = (rect.bottom + 6) + 'px';
      const left = rect.left + rect.width / 2;
      const half = Math.min(tip.offsetWidth / 2, 160);
      tip.style.left = Math.max(8 + half, Math.min(window.innerWidth - 8 - half, left)) + 'px';
      tip.style.transform = 'translateX(-50%)';
    };
    const onOver = (event) => {
      const target = event.target?.closest?.('[data-tip]');
      if (!target || target === current) return;
      current = target;
      const text = target.getAttribute('data-tip');
      if (!text) { tip.style.opacity = '0'; return; }
      tip.textContent = text;
      place(target);
      tip.style.opacity = '1';
    };
    const onOut = (event) => {
      const target = event.target?.closest?.('[data-tip]');
      if (!target || target !== current) return;
      current = null;
      tip.style.opacity = '0';
    };
    const onKey = () => { current = null; tip.style.opacity = '0'; };
    const root = document.body;
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    window.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
      window.removeEventListener('keydown', onKey);
      tip.remove();
    };
  }, []);

  return (
    <div className="dpl-root">
      <header className="dpl-header">
        <div className="dpl-brand">
          <DropletIcon />
          <strong>{t('title')}</strong>
          <nav className="dpl-spaces" role="tablist">
            {SPACES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={space === item.id}
                className={'dpl-space-tab' + (space === item.id ? ' is-active' : '')}
                onClick={() => setSpace(item.id)}
              >
                {item.label()}
              </button>
            ))}
          </nav>
        </div>
        <button
          type="button"
          className={'dpl-header-gear' + (settingsOpen ? ' is-active' : '')}
          onClick={() => setSettingsOpen((value) => !value)}
          aria-label={t('settings.open')}
          aria-pressed={settingsOpen}
          data-tip={t('settings.open')}
        >
          <Settings size={15} />
        </button>
      </header>

      <div className={'dpl-body' + (companionOpen && companionForm === 'docked' ? ' has-docked' : '')}>
        <div className="dpl-space">
          {settingsOpen ? (
            <SettingsView api={api} onClose={() => setSettingsOpen(false)} />
          ) : (
            <>
              {(space === 'rss' || space === 'news') && (
                <FeedView api={api} surface={space} onMaterial={onMaterial} onJumpSpace={setSpace} onOpenVaultNote={openVaultNote} />
              )}
              {space === 'inbox' && <InboxView api={api} onMaterial={onMaterial} onOpenVaultNote={openVaultNote} />}
              {space === 'vault' && (
                <VaultView
                  api={api} onMaterial={onMaterial}
                  noteRequest={vaultNoteRequest}
                  onNoteRequestHandled={() => setVaultNoteRequest(null)}
                />
              )}
            </>
          )}
        </div>
        {companionOpen && companionForm === 'docked' && (
          <Companion
            api={api}
            material={material}
            form="docked"
            onFormChange={setCompanionForm}
            onClose={() => setCompanionOpen(false)}
            SessionProvider={SessionProvider}
            renderSlot={renderSlot}
          />
        )}
      </div>

      {companionOpen && companionForm === 'floating' && (
        <Companion
          api={api}
          material={material}
          form="floating"
          onFormChange={setCompanionForm}
          onClose={() => setCompanionOpen(false)}
          SessionProvider={SessionProvider}
          renderSlot={renderSlot}
        />
      )}
    </div>
  );
}

