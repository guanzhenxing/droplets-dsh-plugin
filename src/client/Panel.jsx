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

      <div className="dpl-body">
        <div className="dpl-space">
          {space === 'feed' && <FeedView api={api} onMaterial={onMaterial} onJumpSpace={setSpace} />}
          {space === 'inbox' && <InboxView api={api} onMaterial={onMaterial} />}
          {space === 'vault' && <VaultView api={api} onMaterial={onMaterial} />}
        </div>
      </div>

      {companionOpen && (
        <Companion
          api={api}
          material={material}
          onClose={() => setCompanionOpen(false)}
          SessionProvider={SessionProvider}
          renderSlot={renderSlot}
        />
      )}

        />
      )}
    </div>
  );
}

