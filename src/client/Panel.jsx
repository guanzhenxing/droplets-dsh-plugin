import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n.js';
import { DropletIcon, Modal } from './components.jsx';
import { FeedView } from './FeedView.jsx';
import { InboxView } from './InboxView.jsx';
import { VaultView } from './VaultView.jsx';
import { Companion } from './Companion.jsx';

const SPACES = [
  { id: 'feed', label: () => t('spaces.feed') },
  { id: 'inbox', label: () => t('spaces.inbox') },
  { id: 'vault', label: () => t('spaces.vault') },
];

/**
 * The droplets main panel: one sidebar entry, three spaces inside. The
 * companion is an enhancement — every client call is guarded, and when the
 * chain breaks the three data spaces keep working with a visible notice.
 */
export function DropletsPanel({ api, SessionProvider, renderSlot }) {
  const [space, setSpace] = useState('feed');
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

  // Window focus triggers a light vault rescan (index staleness guard).
  const onFocus = useCallback(() => { void api.vaultReindex?.().catch(() => {}); }, [api]);
  useEffect(() => {
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [onFocus]);

  const onMaterial = useCallback((next) => {
    setMaterial(next);
    setCompanionOpen(true);
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
      </header>

      <div className={'dpl-body' + (companionOpen && companionForm === 'docked' ? ' has-docked' : '')}>
        <div className="dpl-space">
          {space === 'feed' && <FeedView api={api} onMaterial={onMaterial} onJumpSpace={setSpace} />}
          {space === 'inbox' && <InboxView api={api} onMaterial={onMaterial} />}
          {space === 'vault' && <VaultView api={api} onMaterial={onMaterial} />}
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

