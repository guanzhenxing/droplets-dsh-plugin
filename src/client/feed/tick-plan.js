/**
 * Adaptive tick plan for the AuxRail: decide which headings the right-edge
 * tick column shows, and at what rhythm, so a 45-entry work log never
 * overflows the rail again.
 *
 * Rules, in order:
 * 1. Everything fits at the comfortable 15px pitch (12px tick + 3px gap) →
 *    show all headings, unchanged behaviour.
 * 2. Too many → prefer DROPPING deep levels over squeezing: keep the
 *    deepest level prefix (h2-only, h2+h3, …) that still fits at the
 *    comfortable pitch. For a dated work log this collapses 45 ticks to
 *    its 17 date ticks; the hover popover still lists every heading.
 * 3. Whatever set remains is compressed (tick height + gap) down to the
 *    5px floor so it fits the measured budget.
 *
 * Items keep their ORIGINAL heading index so clicks and the active
 * highlight keep addressing the full outline.
 */

/** Comfortable rhythm: 12px tick + 3px gap. */
export const PITCH_NORMAL = 15;
/** Below this pitch, dropping deep levels beats squeezing everything. */
export const PITCH_COMFY = 12;
/** The squeeze floor: 4px tick + 1px gap. */
export const PITCH_MIN = 5;
/** Rail space reserved for the 回到顶部 / 问 AI buttons and margins. */
export const RAIL_CHROME = 96;

/**
 * @param {{level:number, text:string}[]} headings full outline, document order.
 * @param {number} budget vertical pixels the tick column may occupy.
 * @returns {{items:{level:number,text:string,index:number}[], tickH:number,
 *            gap:number, filtered:boolean, total:number}}
 */
export function planTicks(headings, budget) {
  const indexed = (headings ?? []).map((heading, index) => ({ ...heading, index }));
  const total = indexed.length;
  if (total === 0 || !(budget > 0)) {
    return { items: [], tickH: 12, gap: 3, filtered: false, total };
  }
  if (total * PITCH_NORMAL <= budget) {
    return { items: indexed, tickH: 12, gap: 3, filtered: false, total };
  }
  // Prefer the deepest level prefix that still fits comfortably.
  const levels = [...new Set(indexed.map((heading) => heading.level))].sort((a, b) => a - b);
  let items = indexed.filter((heading) => heading.level <= levels[0]);
  for (let depth = levels.length - 1; depth >= 1; depth -= 1) {
    const candidate = indexed.filter((heading) => heading.level <= levels[depth]);
    if (candidate.length * PITCH_COMFY <= budget) { items = candidate; break; }
  }
  const filtered = items.length !== total;
  const pitch = Math.max(PITCH_MIN, Math.min(PITCH_NORMAL, Math.floor(budget / items.length)));
  const gap = Math.max(1, Math.round(pitch * 0.2));
  return { items, tickH: Math.max(4, pitch - gap), gap, filtered, total };
}

/**
 * Map a full-outline active index onto the visible (possibly filtered)
 * ticks: the current section highlights its nearest visible ancestor —
 * inside an h4 entry, the enclosing h3 date tick lights up.
 * @returns {number} the visible item's original index, or -1.
 */
export function visibleActiveIndex(items, activeIdx) {
  if (activeIdx < 0 || items.length === 0) return -1;
  let last = -1;
  for (const item of items) {
    if (item.index <= activeIdx) last = item.index;
    else break;
  }
  return last;
}
