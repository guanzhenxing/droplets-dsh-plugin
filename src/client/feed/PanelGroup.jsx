import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const RAIL_WIDTH = 20;
const MAX_PANEL_WIDTH = 720;
const STORAGE_KEY = 'droplets.layout.feed';

/**
 * Panel system ported from droplets' PanelGroup (panel-resize contract):
 * - separator drag resizes adjacent columns (window width unchanged), the
 *   last column absorbs the remainder
 * - double-click a separator (or the « button) collapses to a 20px rail;
 *   the preview column cannot fully collapse
 * - widths and collapsed flags persist per page+panel in localStorage
 * - the drag ceiling respects the container: left columns can never push
 *   the last (preview) column out of the viewport
 */
export function PanelGroup({ page = 'feed', panels }) {
  const [widths, setWidths] = useState(() => panels.map((p) => p.initialWidth));
  const [collapsed, setCollapsed] = useState(() => panels.map(() => false));
  const containerRef = useRef(null);
  const dragIndex = useRef(null);

  // Restore persisted layout once.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY + '.' + page) ?? 'null');
      if (saved && Array.isArray(saved.widths) && saved.widths.length === panels.length) {
        setWidths(saved.widths.map((w, i) => Math.max(panels[i].minWidth, Math.min(w, MAX_PANEL_WIDTH))));
        setCollapsed(panels.map((_, i) => saved.collapsed?.[i] === true));
      }
    } catch { /* fresh start */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // Persist (debounced by nature of state commits).
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY + '.' + page, JSON.stringify({ widths, collapsed })); } catch { /* ignore */ }
  }, [widths, collapsed, page]);

  const maxWidthFor = useCallback((index, currentWidths, currentCollapsed) => {
    const containerW = containerRef.current?.clientWidth ?? 0;
    if (containerW <= 0) return MAX_PANEL_WIDTH;
    let others = 0;
    for (let j = 0; j < panels.length; j += 1) {
      if (j === index || j === panels.length - 1) continue;
      others += currentCollapsed[j] ? RAIL_WIDTH : (currentWidths[j] ?? panels[j]?.initialWidth ?? 0);
    }
    const lastMin = panels[panels.length - 1]?.minWidth ?? 0;
    const separators = panels.length - 1;
    const self = panels[index];
    if (!self) return MAX_PANEL_WIDTH;
    return Math.max(self.minWidth, Math.min(MAX_PANEL_WIDTH, containerW - others - lastMin - separators));
  }, [panels]);

  const onPointerMove = useCallback((event) => {
    const index = dragIndex.current;
    if (index === null) return;
    const containerLeft = containerRef.current?.getBoundingClientRect().left ?? 0;
    let x = event.clientX - containerLeft;
    // Account for rails/collapsed columns before this separator.
    for (let j = 0; j <= index; j += 1) {
      if (collapsed[j]) x += (widths[j] ?? 0) - RAIL_WIDTH;
    }
    setWidths((prev) => {
      const next = [...prev];
      const desired = Math.max(panels[index].minWidth, Math.min(x, maxWidthFor(index, prev, collapsed)));
      next[index] = Math.round(desired);
      return next;
    });
  }, [collapsed, widths, panels, maxWidthFor]);

  const endDrag = useCallback(() => {
    if (dragIndex.current === null) return;
    dragIndex.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
    };
  }, [onPointerMove, endDrag]);

  const startDrag = (index) => (event) => {
    event.preventDefault();
    dragIndex.current = index;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const toggleCollapse = (index) => {
    if (!panels[index].collapsible) return;
    setCollapsed((prev) => prev.map((value, i) => (i === index ? !value : value)));
  };

  const collapse = (index) => () => toggleCollapse(index);

  // Interleave columns and separators so each divider truly sits between
  // its neighbors in the flex row.
  const children = [];
  panels.forEach((panel, index) => {
    const width = collapsed[index] ? RAIL_WIDTH : widths[index];
    const last = index === panels.length - 1;
    children.push(
      <div key={panel.id} className="dpl-panel" style={last ? { flex: '1 1 0%', minWidth: 0 } : { width, flex: '0 0 auto', minWidth: 0 }}>
        {panel.render({
          width,
          collapsed: collapsed[index],
          collapse: collapse(index),
          expand: collapse(index),
        })}
      </div>,
    );
    if (!last) {
      children.push(
        <div
          key={'sep-' + panel.id}
          className={'dpl-panel-separator' + (collapsed[index] || collapsed[index + 1] ? ' is-adjacent-collapsed' : '')}
          onPointerDown={startDrag(index)}
          onDoubleClick={() => toggleCollapse(index)}
          role="separator"
          aria-orientation="vertical"
        />,
      );
    }
  });
  return <div className="dpl-panel-group" ref={containerRef}>{children}</div>;
}

/** Uniform panel-head collapse button («). */
export function PanelCollapseButton({ onClick, label }) {
  return (
    <button type="button" className="dpl-icon-btn dpl-panel-collapse" onClick={onClick} title="收起面板" aria-label={label ?? '收起面板'}>
      <ChevronLeft size={15} />
    </button>
  );
}

/** The 20px rail shown for a collapsed column; click or › to expand. */
export function PanelRail({ onExpand, title }) {
  return (
    <button type="button" className="dpl-panel-rail" onClick={onExpand} title={'展开' + (title ?? '')} aria-label={'展开' + (title ?? '')}>
      <ChevronRight size={14} />
    </button>
  );
}
