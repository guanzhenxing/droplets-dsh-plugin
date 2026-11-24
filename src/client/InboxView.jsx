import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, CheckCheck, ChevronLeft, ChevronRight, Circle,
  CircleCheck, ExternalLink, FilePlus2, FileText, Link2, Loader2, Play,
  RefreshCw, Tags, X,
} from 'lucide-react';
import { PanelCollapseButton, PanelGroup, PanelRail } from './feed/PanelGroup.jsx';
import { AuxRail } from './feed/AuxRail.jsx';
import { formatWhen } from './feed/format.js';
import { MarkdownView, SafeHtml } from './components.jsx';
import { openPdf } from './pdf-view.js';
import { openEpub } from './epub-view.js';

/**
 * The inbox page, a 1:1 port of droplets' InboxPage:
 * 筛选 │ 条目 │ 阅读 (filter 250 / list 350 / reader), native status machine
 * (unread / finished / fetch_failed), tag chips with counts, sticky row
 * actions, 处理完成 → 保留到资料库 / 移入回收站, and the right-edge AuxRail.
 * All data lives in the shared Droplets workspace.
 */

/** 三态（droplets 2026-10-09 简化）：未读 / 已读 / 处理失败（驱动重试）。 */
const STATUS_VIEWS = [
  { label: '全部', status: undefined, dot: 'is-gray' },
  { label: '未读', status: 'unread', dot: 'is-accent' },
  { label: '已读', status: 'finished', dot: 'is-gray' },
  { label: '处理失败', status: 'fetch_failed', dot: 'is-danger' },
];

const STATUS_DOT = { unread: 'is-accent', finished: 'is-gray', fetch_failed: 'is-danger' };

/** 失败码 → 人读短标签（droplets ItemList 同款）。 */
function fetchFailLabel(fe) {
  if (!fe) return '抓取失败';
  if (fe.securityRejection) return '安全拒绝';
  if (fe.code === 'FETCH_TOO_MANY_REDIRECTS') return '抓取失败：重定向过多';
  if (fe.code === 'FETCH_NETWORK') {
    return /CERT|SSL_|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY|EPROTO/i.test(fe.message ?? '')
      ? '抓取失败：证书无效'
      : '抓取失败：网络';
  }
  return '抓取失败';
}

/** h2/h3 outline from markdown source (droplets Reader parses ## / ###). */
function markdownHeadings(content) {
  const out = [];
  for (const line of String(content ?? '').split('\n')) {
    const match = line.trim().match(/^(##|###)\s+(.+)$/);
    if (match) out.push({ level: match[1] === '##' ? 2 : 3, text: match[2].trim() });
  }
  return out;
}

function sourceUrlOf(item) {
  if (!item) return null;
  return item.source?.kind === 'url' || item.source?.kind === 'rss' ? item.source.url : null;
}

/** 短正文分类（droplets classifyShortBody：视频 enclosure / rss 短正文 / url 短抽取）。 */
function classifyShortBody(item, plainChars) {
  if (!item || plainChars >= 200) return null;
  const enclosure = item.source?.kind === 'rss' ? item.source.enclosure : undefined;
  if (enclosure && /video/i.test(enclosure.type ?? '')) return 'video';
  if (item.source?.kind === 'rss') return 'rss';
  return 'short';
}

export function InboxView({ api, onMaterial }) {
  const [filter, setFilter] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [data, setData] = useState({ items: [], counts: { byStatus: {}, byTag: {}, total: 0 }, pendingIds: [] });
  const [loading, setLoading] = useState(true);
  const [retryingAll, setRetryingAll] = useState(false);
  const everSelected = useRef(false);
  const listScrollTop = useRef(0);

  const load = useCallback(async () => {
    try {
      const result = await api.inboxList({
        status: filter.status,
        tag: filter.tag,
      });
      setData(result ?? { items: [], counts: { byStatus: {}, byTag: {}, total: 0 }, pendingIds: [] });
    } catch { /* list stays; errors surface where actionable */ }
    finally { setLoading(false); }
  }, [api, filter.status, filter.tag]);

  useEffect(() => { void load(); }, [load]);

  // Background fetch completion: poll while the host reports pending fetches
  // (the native app gets an inbox:updated push; the plugin polls instead).
  const pendingIds = data.pendingIds ?? [];
  useEffect(() => {
    if (pendingIds.length === 0) return undefined;
    const timer = setInterval(() => { void load(); }, 1500);
    return () => clearInterval(timer);
  }, [pendingIds.length > 0, load]);

  // Window focus: pick up changes made by the Droplets desktop app itself.
  useEffect(() => {
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // 阅读空态自动选中（与信息流条目列同款）：从未选中过时纯选中首条。
  const firstItem = loading ? undefined : (data.items ?? [])[0];
  useEffect(() => {
    if (!firstItem || everSelected.current) return;
    everSelected.current = true;
    setSelectedId(firstItem.id);
  }, [firstItem]);

  const select = (id) => {
    everSelected.current = true;
    setSelectedId(id);
  };

  const retryAll = async () => {
    setRetryingAll(true);
    try { await api.inboxRetryAllFailed(); } catch { /* per-item failures already landed */ }
    finally {
      setRetryingAll(false);
      await load();
    }
  };

  return (
    <PanelGroup
      page="inbox"
      panels={[
        {
          id: 'filter',
          initialWidth: 250,
          minWidth: 205,
          collapsible: true,
          render: ({ collapsed, expand, collapse }) => (collapsed
            ? <PanelRail onExpand={expand} title="筛选" />
            : <FilterPane api={api} filter={filter} setFilter={setFilter} counts={data.counts} onChanged={load} onCollapse={collapse} />),
        },
        {
          id: 'list',
          initialWidth: 350,
          minWidth: 260,
          collapsible: true,
          render: ({ collapsed, expand, collapse }) => (collapsed
            ? <PanelRail onExpand={expand} title="条目" />
            : (
              <ItemList
                api={api}
                items={data.items} loading={loading} filter={filter}
                selectedId={selectedId} onSelect={select}
                retryingAll={retryingAll} onRetryAll={() => void retryAll()}
                onChanged={load} scrollTopRef={listScrollTop} onCollapse={collapse}
              />
            )),
        },
        {
          id: 'reader',
          initialWidth: 700,
          minWidth: 420,
          collapsible: false,
          render: () => (
            <Reader
              api={api} selectedId={selectedId} items={data.items}
              onMaterial={onMaterial} onChanged={load}
            />
          ),
        },
      ]}
    />
  );
}

/** 筛选列：状态视图（计数）+ 标签区 + 添加 URL / 导入。 */
function FilterPane({ api, filter, setFilter, counts, onChanged, onCollapse }) {
  const [urlInput, setUrlInput] = useState(null);
  const [addError, setAddError] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);
  const tags = useMemo(
    () => Object.entries(counts?.byTag ?? {}).sort((a, b) => b[1] - a[1]),
    [counts],
  );

  const submitUrl = async () => {
    const url = String(urlInput ?? '').trim();
    if (url === '') return;
    setUrlInput(null);
    try {
      await api.inboxAddUrl({ url });
    } catch (error) {
      setAddError(String(error?.message ?? error));
    }
    await onChanged();
  };

  const importFiles = async (fileList) => {
    const files = [...fileList];
    if (files.length === 0) return;
    setImporting(true);
    setAddError(null);
    try {
      for (const file of files) {
        const content = await file.text();
        await api.inboxImportMarkdown({ filename: file.name, content });
      }
      await onChanged();
    } catch (error) {
      setAddError(String(error?.message ?? error));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="dpl-pane dpl-ib-filter" data-testid="filter-pane">
      <div className="dpl-ib-panehead">
        <span className="dpl-ib-pansub">筛选</span>
        <PanelCollapseButton onClick={onCollapse} />
      </div>
      <div className="dpl-ib-actions">
        {urlInput === null ? (
          <>
            <button type="button" className="dpl-pane-btn" onClick={() => setUrlInput('')} data-testid="add-url-button">
              <Link2 size={14} /> 添加 URL
            </button>
            <button
              type="button" className="dpl-pane-btn" disabled={importing}
              onClick={() => fileRef.current?.click()} data-testid="import-button"
            >
              {importing ? <Loader2 size={14} className="dpl-spin" /> : <FilePlus2 size={14} />} 导入
            </button>
            <input
              ref={fileRef} type="file" accept=".md,.markdown,.txt" multiple hidden
              onChange={(event) => void importFiles(event.target.files ?? [])}
            />
          </>
        ) : (
          <div className="dpl-ib-urlrow">
            <input
              autoFocus type="url" placeholder="https://…" value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitUrl();
                if (event.key === 'Escape') setUrlInput(null);
              }}
              data-testid="url-input"
            />
            <button type="button" className="dpl-ib-cancelurl" onClick={() => setUrlInput(null)} aria-label="取消添加 URL">
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      {addError ? (
        <div className="dpl-ib-adderror" role="alert" data-testid="add-url-error">
          <span>添加失败：{addError}</span>
          <button type="button" onClick={() => setAddError(null)} aria-label="关闭错误"><X size={12} /></button>
        </div>
      ) : null}

      <div className="dpl-ib-scroll">
        <div className="dpl-ib-statusviews" data-testid="status-views">
          {STATUS_VIEWS.map((view) => {
            const count = view.status === undefined
              ? (counts?.total ?? 0)
              : (counts?.byStatus?.[view.status] ?? 0);
            const active = (filter.status ?? undefined) === view.status && filter.tag === undefined;
            return (
              <button
                key={view.label} type="button"
                className={'dpl-ib-statusrow' + (active ? ' is-active' : '')}
                onClick={() => setFilter({ status: view.status })}
                data-testid={`filter-${view.status ?? 'all'}`}
              >
                <span className={'dpl-dot ' + view.dot} />
                <span className="dpl-ib-statuslabel">{view.label}</span>
                <span className="dpl-ib-statuscount">{count}</span>
              </button>
            );
          })}
        </div>

        {tags.length > 0 ? (
          <>
            <div className="dpl-ib-tagstitle">标签</div>
            <div className="dpl-ib-tags" data-testid="tag-zone">
              {tags.map(([tag, count]) => (
                <button
                  key={tag} type="button"
                  className={'dpl-ib-tag' + (filter.tag === tag ? ' is-active' : '')}
                  onClick={() => setFilter(filter.tag === tag ? {} : { tag })}
                  data-testid={`tag-${tag}`}
                >
                  {tag} <span>{count}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** 条目列标签弹层：Enter / 确认提交，Escape 关闭。 */
function TagEditor({ item, onClose, onCommit }) {
  const [value, setValue] = useState(item.tags.join(', '));
  const commit = () => {
    const tags = value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    onCommit(tags);
    onClose();
  };
  return (
    <div className="dpl-ib-tageditor" onClick={(event) => event.stopPropagation()} data-testid="tag-editor">
      <input
        autoFocus placeholder="标签，逗号分隔" value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') onClose();
        }}
      />
      <div className="dpl-ib-tageditorfoot">
        <span>Enter 确认</span>
        <button type="button" className="dpl-ib-tagconfirm" onClick={commit}>
          <Check size={12} /> 确认
        </button>
      </div>
    </div>
  );
}

/** 收件箱条目列：卡片 + 选中态 + 排序（最新）+ 标签弹层 + 滚动位置记忆。 */
function ItemList({ api, items, loading, selectedId, onSelect, retryingAll, onRetryAll, onChanged, scrollTopRef, onCollapse }) {
  const listRef = useRef(null);
  const [tagEditorFor, setTagEditorFor] = useState(null);

  // 恢复滚动位置：数据到达后再恢复（无缓存首载时列表为空，挂载瞬间恢复会丢失）
  useEffect(() => {
    const el = listRef.current;
    if (!el || loading) return;
    el.scrollTop = scrollTopRef.current ?? 0;
  }, [loading, items, scrollTopRef]);

  const hasFailed = (items ?? []).some((item) => item.status === 'fetch_failed');

  const commitTags = async (id, tags) => {
    try { await api.inboxUpdate({ id, patch: { tags } }); } catch { /* surfaced by refresh */ }
    await onChanged();
  };

  return (
    <div className="dpl-pane dpl-ib-list" data-testid="item-list">
      <div className="dpl-ib-listhead">
        <span className="dpl-truncate">{(items ?? []).length} 条，最新优先</span>
        {hasFailed ? (
          <button
            type="button" className="dpl-ib-retryall" disabled={retryingAll}
            onClick={onRetryAll} data-testid="retry-all-failed"
          >
            {retryingAll ? '重试中…' : '重试全部失败'}
          </button>
        ) : null}
        <PanelCollapseButton onClick={onCollapse} />
      </div>
      <div
        ref={listRef}
        className="dpl-ib-listscroll"
        onScroll={(event) => { scrollTopRef.current = event.currentTarget.scrollTop; }}
        data-testid="item-scroll"
      >
        {!loading && (items ?? []).length === 0 ? (
          <div className="dpl-ib-listempty">暂无内容。左上角「添加 URL」或「导入」开始收集。</div>
        ) : null}
        {loading ? <div className="dpl-ib-listempty">加载中…</div> : null}
        {(items ?? []).map((item) => (
          <div
            key={item.id}
            className={'dpl-ib-row' + (selectedId === item.id ? ' is-active' : '')}
            onClick={() => onSelect(item.id)}
            data-testid={`item-${item.id}`}
          >
            <div className="dpl-ib-rowmain">
              <span className={'dpl-dot ' + (STATUS_DOT[item.status] ?? 'is-gray')} />
              <div className="dpl-ib-rowbody">
                <div
                  className={'dpl-ib-rowtitle' + (item.status === 'finished' ? ' is-done' : '')}
                  title={item.title}
                  data-testid={`item-title-${item.id}`}
                >
                  {item.title}
                </div>
                <div className="dpl-ib-rowmeta">
                  {item.source?.kind === 'url' ? <Link2 size={12} /> : <FileText size={12} />}
                  <span>{formatWhen(Date.parse(item.createdAt))}</span>
                  {item.source?.kind === 'url' && item.source.fetchError ? (
                    <span className="dpl-ib-faillabel" data-testid={`item-failed-${item.id}`}>
                      {fetchFailLabel(item.source.fetchError)}
                    </span>
                  ) : null}
                </div>
                {item.tags.length > 0 ? (
                  <div className="dpl-ib-rowtags">
                    {item.tags.map((tag) => (
                      <span key={tag} className="dpl-ib-rowtag">{tag}</span>
                    ))}
                  </div>
                ) : null}
              </div>
              <button
                type="button" className="dpl-ib-rowtagbtn" title="设置标签" aria-label="设置标签"
                onClick={(event) => {
                  event.stopPropagation();
                  setTagEditorFor(tagEditorFor === item.id ? null : item.id);
                }}
                data-testid={`tag-button-${item.id}`}
              >
                <Tags size={14} />
              </button>
            </div>
            {tagEditorFor === item.id ? (
              <TagEditor
                item={item} onClose={() => setTagEditorFor(null)}
                onCommit={(tags) => void commitTags(item.id, tags)}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 标签编辑浮层（阅读列）：Enter 提交（空值=清空标签），Escape 不保存关闭。 */
function TagEditPopup({ item, onCommit, onClose }) {
  const boxRef = useRef(null);
  const commit = (raw) => {
    const tags = raw.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    onCommit(tags);
    onClose();
  };
  // 点击外部提交关闭；触发按钮自身不算外部（避免 toggle 叠加「关了又开」）
  useEffect(() => {
    const onPointerDown = (event) => {
      const target = event.target;
      if (boxRef.current?.contains(target)) return;
      if (target?.closest?.('[data-testid="reader-tags"]')) return;
      const input = boxRef.current?.querySelector('input');
      commit(input?.value ?? '');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);
  return (
    <div ref={boxRef} className="dpl-ib-tagpopup" data-testid="reader-tag-edit">
      <input
        autoFocus defaultValue={item.tags.join(', ')} placeholder="标签，逗号分隔"
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget.value);
          if (event.key === 'Escape') onClose();
        }}
        data-testid="reader-tag-input"
      />
    </div>
  );
}

/** PDF 阅读器（droplets PdfReader 形状：顶部页导航 + 滚动画布）。 */
function PdfPane({ doc, setDoc }) {
  const canvasRef = useRef(null);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRendering(true);
    void (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        await doc.pdf.renderPage(doc.page, canvas);
      } catch {
        if (!cancelled) setDoc({ ...doc, error: 'PDF 渲染失败' });
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();
    return () => { cancelled = true; };
  }, [doc, setDoc]);

  if (doc.error) {
    return <div className="dpl-ib-readercenter">{doc.error}</div>;
  }

  return (
    <div className="dpl-ib-docpane" data-testid="pdf-reader">
      <div className="dpl-ib-docnav">
        <button type="button" className="dpl-btn dpl-ib-docnavbtn" disabled={doc.page <= 1} onClick={() => setDoc({ ...doc, page: doc.page - 1 })} data-testid="pdf-prev">
          <ChevronLeft size={14} /> 上一页
        </button>
        <span data-testid="pdf-page-indicator">{doc.page} / {doc.pdf.numPages}</span>
        <button type="button" className="dpl-btn dpl-ib-docnavbtn" disabled={doc.page >= doc.pdf.numPages} onClick={() => setDoc({ ...doc, page: doc.page + 1 })} data-testid="pdf-next">
          下一页 <ChevronRight size={14} />
        </button>
        {rendering ? <Loader2 size={12} className="dpl-spin" /> : null}
      </div>
      <div className="dpl-ib-docscroll">
        <canvas ref={canvasRef} className="dpl-ib-pdfcanvas" data-testid="pdf-canvas" />
      </div>
    </div>
  );
}

/** EPUB 阅读器（droplets EpubReader 形状：顶部章节导航 + 正文滚动）。 */
function EpubPane({ doc, setDoc }) {
  const chapters = doc.epub.chapters;
  const chapter = chapters[Math.min(doc.chapter, chapters.length - 1)];
  if (chapters.length === 0) {
    return <div className="dpl-ib-readercenter">EPUB 无可读章节</div>;
  }
  return (
    <div className="dpl-ib-docpane" data-testid="epub-reader">
      <div className="dpl-ib-docnav">
        <button type="button" className="dpl-btn dpl-ib-docnavbtn" disabled={doc.chapter <= 0} onClick={() => setDoc({ ...doc, chapter: doc.chapter - 1 })}>
          <ChevronLeft size={14} /> 上一章
        </button>
        <span className="dpl-truncate">{chapter?.title || chapter?.href || ''}（{doc.chapter + 1}/{chapters.length}）</span>
        <button type="button" className="dpl-btn dpl-ib-docnavbtn" disabled={doc.chapter >= chapters.length - 1} onClick={() => setDoc({ ...doc, chapter: doc.chapter + 1 })}>
          下一章 <ChevronRight size={14} />
        </button>
      </div>
      <div className="dpl-ib-docscroll dpl-ib-epubscroll">
        <SafeHtml className="dpl-ib-epubbody" html={chapter?.html ?? ''} />
      </div>
    </div>
  );
}

/** 阅读器：Markdown 渲染 + 头部动作 + fetch_failed 占位 + 右缘辅助轨道 + 处理完成弹层。 */
function Reader({ api, selectedId, onMaterial, onChanged }) {
  const [detail, setDetail] = useState(null); // { item, content }
  const [detailLoading, setDetailLoading] = useState(false);
  const [doc, setDoc] = useState(null); // pdf/epub viewer state
  const [docError, setDocError] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [doneResult, setDoneResult] = useState(null);
  const [tagEdit, setTagEdit] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const contentScrollRef = useRef(null);
  const docRef = useRef(null);

  const item = detail?.item ?? null;
  const content = detail?.content ?? '';

  // 切换条目时正文回顶：滚动位置不跨条目残留
  useEffect(() => {
    contentScrollRef.current?.scrollTo?.({ top: 0 });
    docRef.current?.destroy?.();
    docRef.current = null;
    setDoc(null);
    setDocError('');
    setTagEdit(false);
    setShowDone(false);
    setDoneResult(null);
    if (selectedId === null) {
      setDetail(null);
      setDetailLoading(false);
      return undefined;
    }
    let cancelled = false;
    setDetailLoading(true);
    void (async () => {
      try {
        const result = await api.inboxGet(selectedId);
        if (cancelled) return;
        setDetail(result?.item ? { item: result.item, content: result.content ?? '' } : null);
      } catch (error) {
        if (!cancelled) setDetail({ item: null, content: '', error: String(error?.message ?? error) });
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [api, selectedId]);

  useEffect(() => () => { docRef.current?.destroy?.(); }, []);

  // PDF/EPUB originals: fetch base64 and open the viewer.
  useEffect(() => {
    if (!item || (item.objectType !== 'pdf' && item.objectType !== 'epub')) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const original = await api.inboxReadOriginal(item.id);
        if (cancelled) return;
        if (item.objectType === 'pdf') {
          const pdf = await openPdf(original.base64);
          docRef.current = pdf;
          setDoc({ kind: 'pdf', pdf, page: 1 });
        } else {
          const epub = openEpub(original.base64);
          docRef.current = epub;
          setDoc({ kind: 'epub', epub, chapter: 0 });
        }
      } catch (error) {
        if (!cancelled) setDocError(String(error?.message ?? error));
      }
    })();
    return () => { cancelled = true; };
  }, [api, item?.id, item?.objectType]);

  const headings = useMemo(() => markdownHeadings(content), [content]);

  const isFailed = item?.status === 'fetch_failed';
  const fetchError = item?.source?.kind === 'url' ? item.source.fetchError : undefined;
  const sourceUrl = sourceUrlOf(item);
  const enclosure = item?.source?.kind === 'rss' ? item.source.enclosure : undefined;
  const plainChars = content.replace(/\s+/g, '').length;
  const shortKind = item && !isFailed ? classifyShortBody(item, plainChars) : null;
  const isPdf = item?.objectType === 'pdf';
  const isEpub = item?.objectType === 'epub';

  const refreshDetail = async () => {
    if (!selectedId) return;
    const result = await api.inboxGet(selectedId).catch(() => null);
    setDetail(result?.item ? { item: result.item, content: result.content ?? '' } : null);
  };

  const update = async (patch) => {
    try {
      await api.inboxUpdate({ id: item.id, patch });
    } catch { /* refreshed anyway */ }
    await Promise.all([refreshDetail(), onChanged()]);
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await api.inboxRetry(item.id);
    } catch { /* outcome lands in meta regardless */ }
    finally {
      setRetrying(false);
      await Promise.all([refreshDetail(), onChanged()]);
    }
  };

  const archive = async (target) => {
    if (!item) return;
    setDoneResult('moving');
    try {
      if (target === 'library') {
        await api.inboxMoveToLibrary(item.id);
        setDoneResult('已保留到资料库（ID 不变）');
      } else {
        await api.inboxMoveToTrash(item.id);
        setDoneResult('已移入回收站');
      }
      await onChanged();
    } catch (error) {
      setDoneResult(`操作失败：${String(error?.message ?? error)}`);
    }
  };

  const askAi = () => {
    if (!item) return;
    onMaterial({
      space: 'inbox',
      key: item.id,
      title: item.title,
      url: sourceUrl ?? '',
      content: content.slice(0, 60000),
    }, { reveal: true });
  };

  let body;
  if (selectedId === null) {
    body = <div className="dpl-ib-readercenter" data-testid="reader-empty">在中间列表选择一条内容开始阅读</div>;
  } else if (detailLoading) {
    body = <div className="dpl-ib-readercenter">载入中…</div>;
  } else if (!item) {
    // 条目已归档/移入回收站：列表刷新后 item 为 null
    body = <div className="dpl-ib-readercenter" data-testid="reader-archived">该条目已离开收件箱</div>;
  } else {
    body = (
      <>
        <div className="dpl-ib-readerhead">
          <span className="dpl-ib-readertitle" data-testid="reader-title">{item.title}</span>
          <button
            type="button" className="dpl-icon-btn dpl-ib-headbtn" title="设置标签" aria-label="设置标签"
            onClick={() => setTagEdit(!tagEdit)} data-testid="reader-tags"
          >
            <Tags size={15} />
          </button>
          {!isFailed ? (
            <button
              type="button" className={'dpl-icon-btn dpl-ib-headbtn' + (item.status === 'finished' ? ' is-accent' : '')}
              title={item.status === 'unread' ? '标记已读' : '标为未读'}
              aria-label={item.status === 'unread' ? '标记已读' : '标为未读'}
              onClick={() => void update({ status: item.status === 'unread' ? 'finished' : 'unread' })}
              data-testid="mark-read-toggle"
            >
              {item.status === 'unread' ? <Circle size={15} /> : <CircleCheck size={15} />}
            </button>
          ) : null}
          {sourceUrl !== null ? (
            <button
              type="button" className="dpl-icon-btn dpl-ib-headbtn" title="打开原文（新窗口）" aria-label="打开原文"
              onClick={() => window.open(sourceUrl, '_blank', 'noopener,noreferrer')}
              data-testid="open-original"
            >
              <ExternalLink size={15} />
            </button>
          ) : null}
          <button
            type="button" className="dpl-btn dpl-primary-solid dpl-ib-donebtn" onClick={() => setShowDone(true)}
            data-tip="归档这条内容：保留到资料库或移入回收站" data-testid="done-button"
          >
            <CheckCheck size={14} /> 处理完成
          </button>
          {tagEdit ? (
            <TagEditPopup
              item={item}
              onCommit={(tags) => void update({ tags })}
              onClose={() => setTagEdit(false)}
            />
          ) : null}
        </div>

        {isFailed ? (
          <div className="dpl-ib-readerfill" data-testid="reader-failed">
            <div className="dpl-ib-failedcard">
              <AlertTriangle size={30} className="dpl-ib-warnicon" />
              <h3>抓取失败</h3>
              <p className="dpl-ib-failedmsg" data-testid="fetch-error-message">{fetchError?.message ?? '未知原因'}</p>
              <p className="dpl-ib-failedhint">
                {fetchError?.securityRejection
                  ? '安全拒绝（内网/回环/非法协议）不会自动重试；该 URL 已保留，可人工重试。'
                  : '可人工重试抓取。'}
              </p>
              <button
                type="button" className="dpl-btn dpl-ib-retrybtn" disabled={retrying} onClick={() => void retry()}
                data-testid="retry-button"
              >
                {retrying ? <Loader2 size={14} className="dpl-spin" /> : <RefreshCw size={14} />} 重试
              </button>
            </div>
          </div>
        ) : isPdf ? (
          doc
            ? <PdfPane doc={doc} setDoc={setDoc} />
            : <div className="dpl-ib-readercenter">{docError || '载入中…'}</div>
        ) : isEpub ? (
          doc
            ? <EpubPane doc={doc} setDoc={setDoc} />
            : <div className="dpl-ib-readercenter">{docError || '载入中…'}</div>
        ) : (
          <div ref={contentScrollRef} className="dpl-ib-contentscroll" data-testid="reader-content">
            {shortKind !== null ? (
              <div
                className={'dpl-ib-shortnotice ' + (shortKind === 'video' ? 'is-info' : 'is-warn')}
                data-testid={shortKind === 'video' ? 'reader-video-notice' : 'reader-short-notice'}
              >
                {shortKind === 'video' ? (
                  <>
                    <Play size={13} />
                    <span>视频条目：暂不内嵌播放视频，完整内容请去原文观看。</span>
                    {enclosure?.url ? (
                      <button type="button" className="dpl-inline-link" onClick={() => window.open(enclosure.url, '_blank', 'noopener,noreferrer')}>打开视频</button>
                    ) : null}
                    {sourceUrl !== null ? (
                      <button type="button" className="dpl-inline-link" onClick={() => window.open(sourceUrl, '_blank', 'noopener,noreferrer')}>去原文</button>
                    ) : null}
                  </>
                ) : shortKind === 'rss' ? (
                  <>
                    <AlertTriangle size={13} />
                    <span>正文较短，完整内容请查看原文。</span>
                    {sourceUrl !== null ? (
                      <button type="button" className="dpl-inline-link" onClick={() => window.open(sourceUrl, '_blank', 'noopener,noreferrer')}>查看原文</button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <AlertTriangle size={13} /> 正文较短（约 {plainChars} 字），抽取可能不完整。
                  </>
                )}
              </div>
            ) : null}
            <article className="dpl-ib-article" data-testid="reader-article">
              <MarkdownView className="dpl-ib-articlebody" markdown={content} />
            </article>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="dpl-pane dpl-ib-reader">
      <div className="dpl-ib-readerbody">{body}</div>
      {/* 右缘辅助轨道只在 Markdown 阅读面存在时渲染（droplets D12） */}
      {item !== null && !isFailed && !isPdf && !isEpub ? (
        <AuxRail headings={headings} containerRef={contentScrollRef} onAskAi={askAi} />
      ) : null}

      {showDone ? (
        <div className="dpl-ib-donescrim" data-testid="done-dialog">
          <div className="dpl-ib-donedialog">
            <div className="dpl-ib-donedialoghead">
              <h3>处理完成</h3>
              <button
                type="button" className="dpl-icon-btn" aria-label="关闭处理完成弹层"
                onClick={() => { setShowDone(false); setDoneResult(null); }}
                data-testid="done-cancel"
              >
                <X size={15} />
              </button>
            </div>
            {item ? (
              <>
                <p className="dpl-ib-donesub">这条内容接下来去哪里？</p>
                <div className="dpl-ib-donebtns">
                  <button
                    type="button" className="dpl-btn dpl-primary-solid" disabled={doneResult !== null}
                    onClick={() => void archive('library')} data-testid="done-keep-library"
                  >
                    保留到资料库
                  </button>
                  <button
                    type="button" className="dpl-btn dpl-ib-outlinebtn" disabled={doneResult !== null}
                    onClick={() => void archive('trash')} data-testid="done-to-trash"
                  >
                    移入回收站
                  </button>
                </div>
              </>
            ) : null}
            {doneResult !== null && doneResult !== 'moving' ? (
              <p className="dpl-ib-doneresult" data-testid="done-result">{doneResult}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
