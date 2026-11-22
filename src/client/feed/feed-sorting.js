/**
 * Feed ordering rules, a faithful port of droplets'
 * apps/desktop/src/renderer/pages/feedSorting.ts (D05: #5/#9/#10).
 * - Sources pane: unread-desc by default; 'default' = subscription order.
 * - Manage table: disabled feeds always sink to the bottom; column sorting
 *   happens inside the enabled/disabled layers.
 * - Items: read-state partition frozen on list entry (2026-10-28 decision) —
 *   marking read/skipped or a refresh never reshuffles; re-entering the list
 *   re-partitions with a fresh snapshot.
 * Ties always keep input order (stable sort).
 */

/** Sources pane sort mode (session-only, never persisted). */
export const DEFAULT_FEED_SORT_MODE = 'unread-desc';

const byTitle = (a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN');

/** In-group source sort; 'default' returns input as-is. */
export function sortFeedList(feeds, sortMode) {
  if (sortMode === 'default') return feeds;
  const sorted = [...feeds];
  if (sortMode === 'name-asc') sorted.sort((a, b) => byTitle(a, b));
  else if (sortMode === 'name-desc') sorted.sort((a, b) => byTitle(b, a));
  else sorted.sort((a, b) => b.unreadCount - a.unreadCount);
  return sorted;
}

/**
 * Group by groupName ('' = ungrouped) and sort: same rule between and inside
 * groups; the ungrouped bucket always sinks last (established behavior).
 */
export function groupAndSortFeeds(feeds, sortMode) {
  const map = new Map();
  let ungrouped = null;
  for (const feed of feeds) {
    if (feed.groupName === '') {
      (ungrouped ??= []).push(feed);
      continue;
    }
    const list = map.get(feed.groupName);
    if (list) list.push(feed);
    else map.set(feed.groupName, [feed]);
  }
  if (ungrouped) map.set('', ungrouped);
  const entries = [...map.entries()].map(([name, list]) => [name, sortFeedList(list, sortMode)]);
  if (sortMode === 'default') return entries;
  return entries.sort((a, b) => {
    if (a[0] === '') return 1;
    if (b[0] === '') return -1;
    if (sortMode === 'name-asc') return a[0].localeCompare(b[0], 'zh-Hans-CN');
    if (sortMode === 'name-desc') return b[0].localeCompare(a[0], 'zh-Hans-CN');
    return b[1].reduce((s, f) => s + f.unreadCount, 0) - a[1].reduce((s, f) => s + f.unreadCount, 0);
  });
}

/** Manage table sort (D05 #9): disabled rows sink; ties keep input order. */
export function sortManageFeeds(feeds, sortKey, asc) {
  const dir = asc ? 1 : -1;
  const healthRank = (f) => (f.lastError !== null ? 0 : f.enabled ? 1 : 2);
  return [...feeds].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (sortKey === 'title') return a.title.localeCompare(b.title) * dir;
    if (sortKey === 'unread') return (a.unreadCount - b.unreadCount) * dir;
    if (sortKey === 'fetched') return ((a.lastFetchAt ?? 0) - (b.lastFetchAt ?? 0)) * dir;
    return (healthRank(a) - healthRank(b)) * dir;
  });
}

const itemKey = (item) => item.sourceId + ':' + item.key;

/** Snapshot the read (seen/skipped) keys at list entry. */
export function snapshotReadItems(items) {
  const read = new Set();
  for (const item of items) {
    if (item.state !== 'unseen') read.add(itemKey(item));
  }
  return read;
}

const EMPTY_READ_SNAPSHOT = new Set();

/**
 * Partition by snapshot: unread first, snapshot-read behind, input order kept
 * inside each partition (the host list is already time-desc). Items missing
 * from the snapshot (newly marked, freshly arrived) stay in the unread
 * partition — they never jump.
 */
export function partitionFeedItems(items, readAtEntry) {
  const snapshot = readAtEntry ?? EMPTY_READ_SNAPSHOT;
  const unread = [];
  const read = [];
  for (const item of items) {
    (snapshot.has(itemKey(item)) ? read : unread).push(item);
  }
  return [...unread, ...read];
}
