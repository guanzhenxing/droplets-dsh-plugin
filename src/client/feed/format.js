/** Time formatting helpers ported from droplets' formatTime (full form). */
export function formatWhen(ts) {
  if (!Number.isFinite(ts)) return '';
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-Hans-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-Hans-CN', { month: 'numeric', day: 'numeric' });
}

export function formatWhenFull(ts) {
  if (!Number.isFinite(ts)) return '';
  const date = new Date(ts);
  const now = new Date();
  const time = date.toLocaleTimeString('zh-Hans-CN', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return '今天 ' + time;
  return date.toLocaleDateString('zh-Hans-CN', { year: 'numeric', month: 'numeric', day: 'numeric' }) + ' ' + time;
}
