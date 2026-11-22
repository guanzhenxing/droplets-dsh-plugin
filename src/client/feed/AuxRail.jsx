import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Sparkles } from 'lucide-react';

/** Tick length per heading level (h2 longest → h6 shortest). */
const TICK_LEVEL = [4, 2.5, 2, 1.5, 1];

/**
 * Right-edge reading rail ported from droplets' AuxRail (T26): outline ticks
 * for the headings of the rendered article, back-to-top, and ask-AI. Overlay
 * position matches the original: absolute, vertically centered, no border
 * column or separate background.
 */
export function AuxRail({ headings, containerRef, onAskAi }) {
  const [activeIdx, setActiveIdx] = useState(-1);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const [popover, setPopover] = useState(false);
  const scrollRef = useRef(null);

  const headingSelector = useMemo(
    () => [...new Set(headings.map((h) => 'h' + h.level))].join(','),
    [headings],
  );

  useEffect(() => {
    const container = containerRef?.current;
    if (!container || !headingSelector) return undefined;
    const onScroll = () => {
      const nodes = container.querySelectorAll(headingSelector);
      let current = -1;
      nodes.forEach((node, index) => {
        if (node.getBoundingClientRect().top <= 48) current = index;
      });
      setActiveIdx(current);
    };
    onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [containerRef, headingSelector, scrollRef.current]);

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

  const scrollTop = () => {
    (scrollRef.current ?? containerRef?.current)?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (headings.length === 0 && !onAskAi) return null;

  return (
    <div
      className={'dpl-aux-rail' + (popover ? ' has-popover' : '')}
      onMouseEnter={() => setPopover(true)}
      onMouseLeave={() => { setPopover(false); setHoverIdx(-1); }}
    >
      {popover && headings.length > 0 ? (
        <div className="dpl-aux-popover" role="list">
          {headings.map((heading, index) => (
            <button
              key={index}
              type="button"
              className={'dpl-aux-pop' + (index === activeIdx ? ' is-active' : '')}
              style={{ paddingLeft: 8 + (heading.level - 2) * 12 }}
              onMouseEnter={() => setHoverIdx(index)}
              onClick={() => scrollToHeading(index)}
            >{heading.text}</button>
          ))}
        </div>
      ) : null}
      {headings.map((heading, index) => (
        <button
          key={index}
          type="button"
          className={'dpl-aux-tick' + (index === activeIdx ? ' is-active' : '')}
          style={{ width: TICK_LEVEL[Math.min(Math.max(heading.level - 2, 0), 4)] * 4 }}
          title={heading.text}
          aria-label={'跳转到 ' + heading.text}
          onMouseEnter={() => setHoverIdx(index)}
          onClick={() => scrollToHeading(index)}
        />
      ))}
      {headings.length > 0 ? (
        <button type="button" className="dpl-aux-tick is-action" onClick={scrollTop} data-tip="回到顶部" aria-label="回到顶部">
          <ArrowUp size={11} />
        </button>
      ) : null}
      {onAskAi ? (
        <button type="button" className="dpl-aux-ask" onClick={onAskAi} data-tip="问 AI" aria-label="问 AI">
          <Sparkles size={13} />
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
