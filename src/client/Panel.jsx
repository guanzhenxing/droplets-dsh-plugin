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
  const [settings, setSettings] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

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
        <div className="dpl-header-actions">
          <button
            type="button"
            className={'dpl-btn' + (companionOpen ? ' is-on' : '')}
            onClick={() => setCompanionOpen((open) => !open)}
          >
            {t('companion.title')}
          </button>
          <button type="button" className="dpl-icon-btn" title={t('common.settings')} onClick={() => { setShowSettings(true); void api.getSettings?.().then(setSettings).catch(() => {}); }}>⚙</button>
        </div>
      </header>

      <div className={'dpl-body' + (companionOpen ? ' has-companion' : '')}>
        <div className="dpl-space">
          {space === 'feed' && <FeedView api={api} onMaterial={onMaterial} onJumpSpace={setSpace} />}
          {space === 'inbox' && <InboxView api={api} onMaterial={onMaterial} />}
          {space === 'vault' && <VaultView api={api} onMaterial={onMaterial} />}
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
      </div>

      {showSettings && (
        <SettingsDialog
          api={api}
          settings={settings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

function SettingsDialog({ api, settings, onClose }) {
  const [info, setInfo] = useState(null);
  const [savedAt, setSavedAt] = useState(0);
  useEffect(() => { void api.getStorageInfo?.().then(setInfo).catch(() => {}); }, [api, savedAt]);
  return (
    <Modal title={t('common.settings')} onClose={onClose}>
      {settings && (
        <section className="dpl-settings-block">
          <h3>{t('common.imagesOn')}</h3>
          <label className="dpl-toggle">
            <input
              type="checkbox"
              checked={settings.settings.showImages !== false}
              onChange={async (event) => {
                const next = await api.saveSettings({ patch: { showImages: event.target.checked } }).catch(() => null);
                if (next) setSettings(next);
              }}
            />
            <span>{settings.settings.showImages !== false ? t('common.imagesOn') : t('common.imagesOff')}</span>
          </label>
          <h3>{t('common.vaultPath')}</h3>
          <p className="dpl-hint">{t('common.vaultPathHint')}</p>
          <code className="dpl-path">{info?.vaultRoot ?? settings.config.vaultPath ?? ''}</code>
          <p className="dpl-hint">
            {t('vault.files')}: {info?.vaultFiles ?? '…'} · {t('feed.subscriptions')}: {info?.subscriptions ?? '…'} · {t('spaces.inbox')}: {info?.inbox ?? '…'}
          </p>
          <h3>{t('common.clearData')}</h3>
          <button
            type="button"
            className="dpl-btn is-danger"
            onClick={async () => {
              if (!window.confirm(t('common.clearDataConfirm'))) return;
              await api.clearData?.().catch(() => {});
              setSavedAt(Date.now());
            }}
          >
            {t('common.clearData')}
          </button>
        </section>
      )}
      {!settings && <div className="dpl-empty">{t('common.loading')}</div>}
    </Modal>
  );
}
