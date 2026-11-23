import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, ExternalLink, Folder, Loader2 } from 'lucide-react';
import { t } from './i18n.js';

/**
 * Settings screen modelled on droplets: a left section menu plus a content
 * pane. Sections are limited to what the plugin can actually show — Workspace
 * (where the data lives) and 信息流 (refresh/cache behaviour) — plus 外观, 数据
 * and 关于 for the settings that already existed.
 */
const SECTIONS = [
  { id: 'workspace', label: () => t('settings.workspace') },
  { id: 'feed', label: () => t('settings.feed') },
  { id: 'appearance', label: () => t('settings.appearance') },
  { id: 'data', label: () => t('settings.data') },
  { id: 'about', label: () => t('settings.about') },
];

const REFRESH_CHOICES = [15, 30, 60, 180];

export function SettingsView({ api, onClose }) {
  const [section, setSection] = useState('workspace');
  const [workspace, setWorkspace] = useState(null);
  const [settings, setSettings] = useState(null);
  const [storage, setStorage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedFlash, setSavedFlash] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPath, setPickerPath] = useState('');
  const [pickerError, setPickerError] = useState('');
  const [pickerBusy, setPickerBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [workspaceResult, settingsResult, storageResult] = await Promise.all([
        api.getWorkspace?.() ?? Promise.resolve(null),
        api.getSettings(),
        api.getStorageInfo?.() ?? Promise.resolve(null),
      ]);
      setWorkspace(workspaceResult);
      setSettings(settingsResult);
      setStorage(storageResult);
    } catch (cause) {
      setError(String(cause?.message ?? cause));
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const patch = useCallback(async (next) => {
    setBusy(true);
    setError('');
    try {
      const result = await api.saveSettings(next);
      setSettings(result);
      setSavedFlash('已保存');
      setTimeout(() => setSavedFlash(''), 1500);
    } catch (cause) {
      setError(String(cause?.message ?? cause));
    } finally {
      setBusy(false);
    }
  }, [api]);

  const applyWorkspace = useCallback(async (nextPath) => {
    setPickerBusy(true);
    setPickerError('');
    try {
      await api.setWorkspace({ path: nextPath });
      setPickerOpen(false);
      await load();
      setSavedFlash('工作区已切换');
      setTimeout(() => setSavedFlash(''), 2000);
    } catch (cause) {
      setPickerError(String(cause?.message ?? cause));
    } finally {
      setPickerBusy(false);
    }
  }, [api, load]);

  const openPath = useCallback(async (relative) => {
    try {
      await api.openPath({ path: relative });
    } catch (cause) {
      setError(String(cause?.message ?? cause));
    }
  }, [api]);

  const feedSettings = settings?.settings ?? {};
  const formatBytes = useMemo(() => (bytes) => {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }, []);

  return (
    <div className="dpl-settings">
      <aside className="dpl-settings-nav">
        <div className="dpl-settings-navhead">
          <button type="button" className="dpl-icon-btn" onClick={onClose} aria-label={t('common.back')}>
            <ArrowLeft size={14} />
          </button>
          <strong>{t('settings.title')}</strong>
        </div>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={'dpl-settings-navitem' + (section === item.id ? ' is-active' : '')}
            onClick={() => setSection(item.id)}
          >
            {item.label()}
          </button>
        ))}
      </aside>

      <section className="dpl-settings-body">
        {error ? <div className="dpl-error" role="alert">{error}</div> : null}

        {section === 'workspace' ? (
          <div className="dpl-settings-section">
            <h2>{t('settings.workspace')}</h2>
            {workspace?.shared ? (
              <div className="dpl-settings-shared" role="status">
                <Check size={13} />
                正在与 Droplets 桌面端共用同一个工作区：订阅源、条目、已读状态与知识库都是同一份数据,两边实时一致。
              </div>
            ) : null}
            <div className="dpl-settings-card">
              <div className="dpl-settings-rowname">根目录</div>
              <div className="dpl-settings-pathrow">
                <code>{workspace?.root ?? storage?.storageDir ?? '—'}</code>
                <button type="button" className="dpl-btn dpl-sm" onClick={() => void openPath('')}>
                  <ExternalLink size={12} /> 在 Finder 中打开
                </button>
                <button
                  type="button"
                  className="dpl-btn dpl-sm dpl-primary-solid"
                  onClick={() => { setPickerPath(workspace?.root ?? ''); setPickerError(''); setPickerOpen(true); }}
                >
                  更改工作区…
                </button>
              </div>
              {storage ? (
                <p className="dpl-settings-hint">
                  {storage.subscriptions} 个订阅源 · 收件箱 {storage.inbox} 条 · 知识库 {storage.vaultFiles} 篇
                </p>
              ) : null}
            </div>

            <div className="dpl-settings-card">
              <div className="dpl-settings-rowname">目录结构</div>
              <div className="dpl-settings-dirs">
                {(workspace?.directory ?? []).map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className={'dpl-settings-dir' + (item.exists ? '' : ' is-missing')}
                    onClick={() => void openPath(item.path)}
                    title={item.exists ? item.path : '尚未创建'}
                  >
                    <Folder size={14} />
                    <span className="dpl-settings-dirname">{item.path}</span>
                    <em>{item.kind}</em>
                    <span className="dpl-settings-dirlabel">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {workspace ? (
              <div className="dpl-settings-card">
                <div className="dpl-settings-rowname">存储占用</div>
                <div className="dpl-settings-metrics">
                  <div>
                    <span>{workspace.shared ? 'state/app.sqlite(订阅源/已读)' : '元数据 data.json'}</span>
                    <strong>{formatBytes(workspace.storage.documentBytes)}</strong>
                  </div>
                  <div>
                    <span>{workspace.shared ? 'state/index.sqlite(条目)' : 'entries/'}</span>
                    <strong>{formatBytes(workspace.storage.entryBytes)}</strong>
                  </div>
                  <div>
                    <span>订阅源</span>
                    <strong>{workspace.storage.subscriptionCount}</strong>
                  </div>
                </div>
              </div>
            ) : null}

            {workspace?.git ? (
              <div className="dpl-settings-card">
                <div className="dpl-settings-rowname">Git 状态(只读)</div>
                <p className="dpl-settings-hint">分支 {workspace.git.branch} · 未提交 {workspace.git.changed} 项</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {section === 'feed' ? (
          <div className="dpl-settings-section">
            <h2>{t('settings.feed')}</h2>
            <div className="dpl-settings-card">
              <div className="dpl-settings-rowname">定时刷新</div>
              <div className="dpl-settings-segmented">
                {REFRESH_CHOICES.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className={'dpl-settings-seg' + ((feedSettings.refreshMinutes ?? 60) === minutes ? ' is-active' : '')}
                    onClick={() => void patch({ refreshMinutes: minutes })}
                  >
                    每 {minutes} 分钟
                  </button>
                ))}
              </div>
            </div>

            <div className="dpl-settings-card">
              <label className="dpl-settings-toggle">
                <input
                  type="checkbox"
                  checked={feedSettings.refreshOnStart !== false}
                  onChange={(event) => void patch({ refreshOnStart: event.target.checked })}
                />
                <span>启动时刷新(「仅手动」源除外)</span>
              </label>
              <label className="dpl-settings-toggle">
                <input
                  type="checkbox"
                  checked={feedSettings.hoverPreview === true}
                  onChange={(event) => void patch({ hoverPreview: event.target.checked })}
                />
                <span>鼠标悬停自动打开阅读(停留约 0.5 秒)</span>
              </label>
              <label className="dpl-settings-toggle">
                <input
                  type="checkbox"
                  checked={feedSettings.showImages !== false}
                  onChange={(event) => void patch({ showImages: event.target.checked })}
                />
                <span>正文显示图片</span>
              </label>
            </div>

            <div className="dpl-settings-card">
              <label className="dpl-settings-field">
                <span>缓存保留(天,超期条目在刷新后清理)</span>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={feedSettings.cacheDays ?? 60}
                  onChange={(event) => void patch({ cacheDays: Number(event.target.value) })}
                />
              </label>
              <label className="dpl-settings-field">
                <span>单轮刷新并发数(1–8)</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={feedSettings.refreshWorkers ?? 3}
                  onChange={(event) => void patch({ refreshWorkers: Number(event.target.value) })}
                />
              </label>
              <label className="dpl-settings-field">
                <span>单源抓取超时(秒,5–300)</span>
                <input
                  type="number"
                  min={5}
                  max={300}
                  value={feedSettings.fetchTimeoutSec ?? 20}
                  onChange={(event) => void patch({ fetchTimeoutSec: Number(event.target.value) })}
                />
              </label>
            </div>
          </div>
        ) : null}

        {section === 'appearance' ? (
          <div className="dpl-settings-section">
            <h2>{t('settings.appearance')}</h2>
            <div className="dpl-settings-card">
              <p className="dpl-settings-hint">
                界面沿用 DeepSeek Harness 的主题令牌,颜色、圆角与按钮样式随宿主外观自动适配,不提供独立配色。
              </p>
            </div>
          </div>
        ) : null}

        {section === 'data' ? (
          <div className="dpl-settings-section">
            <h2>{t('settings.data')}</h2>
            <div className="dpl-settings-card">
              <div className="dpl-settings-metrics">
                <div><span>数据目录</span><strong className="dpl-settings-mono">{storage?.storageDir ?? '—'}</strong></div>
                <div><span>知识库</span><strong className="dpl-settings-mono">{storage?.vaultRoot ?? '—'}</strong></div>
              </div>
            </div>
          </div>
        ) : null}

        {section === 'about' ? (
          <div className="dpl-settings-section">
            <h2>{t('settings.about')}</h2>
            <div className="dpl-settings-card">
              <p className="dpl-settings-hint">
                Droplets for DSH — 信息流、收件箱与知识库三空间。界面使用宿主主题令牌,交互与布局对齐 droplets。
              </p>
            </div>
          </div>
        ) : null}

        {pickerOpen ? (
          <div className="dpl-dialog-backdrop" onClick={() => { if (!pickerBusy) setPickerOpen(false); }}>
            <div className="dpl-dialog dpl-edit-dialog" onClick={(event) => event.stopPropagation()}>
              <div className="dpl-dialog-headline">
                <span className="dpl-dialog-title">选择工作区</span>
                <span className="dpl-grow" />
                <button type="button" className="dpl-icon-btn dpl-round" onClick={() => setPickerOpen(false)} aria-label="关闭">✕</button>
              </div>
              <div className="dpl-dialog-body">
                <p className="dpl-settings-hint">
                  填一个 Droplets 工作区目录即可与 Droplets 共用订阅源、条目、已读状态和知识库。
                  路径下必须存在 <code>state/app.sqlite</code>。
                </p>
                <label className="dpl-dialog-field">
                  <span>工作区路径</span>
                  <input
                    autoFocus
                    value={pickerPath}
                    placeholder="/Users/you/WorkSpace/DropletsSpace"
                    onChange={(event) => setPickerPath(event.target.value)}
                    spellCheck={false}
                  />
                </label>
                <div className="dpl-settings-presets">
                  <button type="button" className="dpl-btn dpl-sm" onClick={() => setPickerPath('/Users/' + 'jesen' + '/WorkSpace/DropletsSpace')}>
                    填入 DropletsSpace
                  </button>
                  <button type="button" className="dpl-btn dpl-sm" onClick={() => setPickerPath('')}>
                    改回插件独立存储
                  </button>
                </div>
                {pickerError ? <div className="dpl-dialog-error">{pickerError}</div> : null}
              </div>
              <div className="dpl-dialog-footer">
                <span className="dpl-grow" />
                <button type="button" className="dpl-btn dpl-sm" disabled={pickerBusy} onClick={() => setPickerOpen(false)}>取消</button>
                <button
                  type="button"
                  className="dpl-btn dpl-sm dpl-primary-solid"
                  disabled={pickerBusy}
                  onClick={() => void applyWorkspace(pickerPath.trim())}
                >
                  {pickerBusy ? <Loader2 size={13} className="dpl-spin" /> : null} 确定
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {busy ? <div className="dpl-settings-busy"><Loader2 size={13} className="dpl-spin" /> 处理中…</div> : null}
        {savedFlash ? <div className="dpl-settings-saved"><Check size={13} /> {savedFlash}</div> : null}
      </section>
    </div>
  );
}
