import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Sparkles } from 'lucide-react';
import { planTicks, visibleActiveIndex, RAIL_CHROME } from './tick-plan.js';

/** Tick length per heading level (h2 longest → h6 shortest). */
const TICK_LEVEL = [4, 2.5, 2, 1.5, 1];

/**
 * Right-edge reading rail ported from droplets' AuxRail (T26): outline ticks
 * for the headings of the rendered article, back-to-top, and ask-AI. Overlay
 * position matches the original: absolute, vertically centered, no border
 * column or separate background.
 *
 * Beyond the original: the tick column is density-adaptive (planTicks) —
 * when the outline is too long for the available height it first drops the
 * deep levels (a dated work log collapses to its date ticks; every heading
 * stays one hover away in the popover) and compresses the rhythm rather
 * than overflowing past the viewport. `onJumpToHeading`, when provided
 * (the vault), replaces the DOM scroll so ticks also work in edit mode.
 * `activeIndex`, when provided (the vault's CM6 anchor provider, plan §5.2),
 * drives the active highlight from the document model — DOM scraping cannot
 * see headings in editor modes, where CM6 renders no h-tags.
 */
export function AuxRail({ headings, containerRef, onAskAi, onJumpToHeading, activeIndex }) {
  const [internalActive, setInternalActive] = useState(-1);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const [popover, setPopover] = useState(false);
  const [railBudget, setRailBudget] = useState(0);
  const scrollRef = useRef(null);
  const popoverRef = useRef(null);
  const externalActive = typeof activeIndex === 'number';
  const activeIdx = externalActive ? activeIndex : internalActive;

  const headingSelector = useMemo(
    () => [...new Set(headings.map((h) => 'h' + h.level))].join(','),
    [headings],
  );

  // The budget is whatever height the scroll container actually has (minus
  // the rail's round buttons), re-measured on resize so window changes adapt.
  // Layout effect: measure before paint so ticks never pop in a frame late.
  useLayoutEffect(() => {
    const el = containerRef?.current;
    if (!el) return undefined;
    const measure = () => setRailBudget(Math.max(160, el.clientHeight - RAIL_CHROME));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef?.current;
    if (!container || !headingSelector || externalActive) return undefined;
    const onScroll = () => {
      const nodes = container.querySelectorAll(headingSelector);
      let current = -1;
      nodes.forEach((node, index) => {
        if (node.getBoundingClientRect().top <= 48) current = index;
      });
      setInternalActive(current);
    };
    onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [containerRef, headingSelector, externalActive, scrollRef.current]);

  const scrollToHeading = (index) => {
    const container = containerRef?.current;
    if (!container) return;
    const nodes = container.querySelectorAll(headingSelector);
    let node = nodes[index] ?? null;
    if (!node && nodes.length !== headings.length) {
      node = [...nodes].find((candidate) => candidate.textContent === headings[index]?.text) ?? null;
    }
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // The vault provides its own jump (CM6 offsets in edit mode); everyone
  // else falls back to the DOM scroll above.
  const jumpTo = (index) => {
    if (typeof onJumpToHeading === 'function') onJumpToHeading(index);
    else scrollToHeading(index);
  };

  const scrollTop = () => {
    (scrollRef.current ?? containerRef?.current)?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const plan = useMemo(() => planTicks(headings, railBudget), [headings, railBudget]);
  const activeTick = useMemo(() => visibleActiveIndex(plan.items, activeIdx), [plan.items, activeIdx]);

  // Opening the popover scrolls it to the current heading so a 45-entry
  // outline starts where you are reading.
  useEffect(() => {
    if (!popover) return undefined;
    const frame = requestAnimationFrame(() => {
      const row = popoverRef.current?.querySelector?.('.is-active');
      row?.scrollIntoView?.({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [popover, headings]);

  if (headings.length === 0 && !onAskAi) return null;

  return (
    <div
      className={'dpl-aux-rail' + (popover ? ' has-popover' : '')}
      style={{ gap: plan.gap + 'px' }}
      onMouseEnter={() => setPopover(true)}
      onMouseLeave={() => { setPopover(false); setHoverIdx(-1); }}
    >
      {popover && headings.length > 0 ? (
        <div className="dpl-aux-popover" ref={popoverRef} role="list">
          {plan.filtered ? (
            <div className="dpl-aux-popcount">共 {plan.total} 个标题 · 轨道显示 {plan.items.length} 个</div>
          ) : null}
          {headings.map((heading, index) => (
            <button
              key={index}
              type="button"
              className={'dpl-aux-pop' + (index === activeIdx ? ' is-active' : '')}
              style={{ paddingLeft: 8 + (heading.level - 2) * 12 }}
              onMouseEnter={() => setHoverIdx(index)}
              onClick={() => jumpTo(index)}
            >{heading.text}</button>
          ))}
        </div>
      ) : null}
      {plan.items.map((item) => (
        <button
          key={item.index}
          type="button"
          className={'dpl-aux-tick' + (item.index === activeTick ? ' is-active' : '')}
          style={{ height: plan.tickH + 'px' }}
          aria-label={'跳转到 ' + item.text}
          aria-current={item.index === activeTick ? 'true' : 'false'}
          onMouseEnter={() => setHoverIdx(item.index)}
          onClick={() => jumpTo(item.index)}
        >
          <span className="dpl-aux-bar" style={{ width: TICK_LEVEL[Math.min(Math.max(item.level - 2, 0), 4)] * 4 }} />
        </button>
      ))}
      {headings.length > 0 ? (
        <button type="button" className="dpl-aux-round" onClick={scrollTop} data-tip="回到顶部" aria-label="回到顶部">
          <ArrowUp size={14} />
        </button>
      ) : null}
      {onAskAi ? (
        <button type="button" className="dpl-aux-ask" onClick={onAskAi} data-tip="问 AI" aria-label="问 AI">
          <Sparkles size={14} />
        </button>
      ) : null}
    </div>
  );
}

/** Extract h2/h3 headings from sanitized HTML (droplets: feed parses h2/h3). */
export function htmlHeadings(html) {
  const out = [];
  const pattern = /<h([23])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = pattern.exec(String(html ?? ''))) !== null) {
    const text = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text !== '') out.push({ level: Number(match[1]), text });
  }
  return out;
}
