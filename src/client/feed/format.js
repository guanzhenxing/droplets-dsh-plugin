/** Time formatting helpers ported from droplets' formatTime (full form). */
export function formatWhen(ts) {
  if (!Number.isFinite(ts)) return '';
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-Hans-CN', { hour: '2-digit', minute: '2-digit' });
  }
  // 跨年条目带年份,同年维持 M/D(与 droplets formatWhen 口径一致)。
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('zh-Hans-CN', sameYear
    ? { month: 'numeric', day: 'numeric' }
    : { year: 'numeric', month: 'numeric', day: 'numeric' });
}

export function formatWhenFull(ts) {
  if (!Number.isFinite(ts)) return '';
  const date = new Date(ts);
  const now = new Date();
  const time = date.toLocaleTimeString('zh-Hans-CN', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return '今天 ' + time;
  // 同上:仅跨年才带年份,同年维持 M/D。
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('zh-Hans-CN', sameYear
    ? { month: 'numeric', day: 'numeric' }
    : { year: 'numeric', month: 'numeric', day: 'numeric' }) + ' ' + time;
}
