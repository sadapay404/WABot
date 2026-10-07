/**
 * Nexus-WA — shared formatting helpers.
 *
 * Small, pure, and used by both the WhatsApp plugins and the web dashboard so
 * the two surfaces never disagree about how a duration or a timestamp looks.
 */

export function formatUptime(sec) {
  const s = Math.floor(Number(sec) || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Milliseconds since `ts` -> "3m ago" / "in 2h". */
export function timeAgo(ts, now = Date.now()) {
  if (!ts) return 'never';
  const diff = now - Number(ts);
  const abs = Math.abs(diff);
  const units = [
    ['d', 86400000],
    ['h', 3600000],
    ['m', 60000],
    ['s', 1000],
  ];
  for (const [suffix, ms] of units) {
    if (abs >= ms) {
      const v = Math.round(abs / ms);
      return diff >= 0 ? `${v}${suffix} ago` : `in ${v}${suffix}`;
    }
  }
  return 'just now';
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(1)} ${units[i]}`;
}

/** Compact table for terminal/Telegram output. */
export function pad(value, width) {
  const s = String(value ?? '');
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

export default { formatUptime, timeAgo, formatBytes, pad };
