/**
 * Session-frozen ordering for entry lists: unread entries first, and the
 * relative order of known entries never reshuffles when a refresh updates
 * timestamps in place or flips read state. New keys (genuinely fresh
 * articles) enter ahead of older ones; the freeze map is per channel key so
 * switching channels starts a new window.
 */
export class FrozenOrder {
  constructor() {
    this.windows = new Map();
  }

  /**
   * Order entries for one channel: unread first; within each partition the
   * last displayed position is frozen (ranks are rewritten to the displayed
   * order after every call), and genuinely fresh keys enter ahead of the
   * known ones. Switching channels starts a new window.
   */
  order(channelKey, entries) {
    const stored = this.windows.get(channelKey) ?? new Map();
    const rankOf = (entry) => (stored.has(entry.key) ? stored.get(entry.key) : -1);
    const sorted = [...entries].sort((a, b) => {
      const unreadA = a.read ? 1 : 0;
      const unreadB = b.read ? 1 : 0;
      if (unreadA !== unreadB) return unreadA - unreadB; // unread first
      const rankA = rankOf(a);
      const rankB = rankOf(b);
      if (rankA !== rankB) return rankA - rankB; // unranked (new) ahead; then frozen
      return String(a.key).localeCompare(String(b.key));
    });
    stored.clear();
    sorted.forEach((entry, index) => stored.set(entry.key, index));
    this.windows.set(channelKey, stored);
    return sorted;
  }

  reset(channelKey) {
    if (channelKey === undefined) this.windows.clear();
    else this.windows.delete(channelKey);
  }
}
