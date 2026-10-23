export const pct = (p, digits = 0) => (Number.isFinite(p) ? `${(p * 100).toFixed(digits)}%` : '—');
export const pp = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}pp` : '—');
export const odds = (o) => (Number.isFinite(o) ? o.toFixed(2) : '—');

export function clockTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, tomorrow)) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

export function countdown(minutes) {
  if (minutes === null || minutes === undefined) return '';
  if (minutes < 0) return 'started';
  if (minutes < 1) return 'kick-off';
  if (minutes < 60) return `in ${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

export const confidenceBand = (c) =>
  c >= 72 ? 'high' : c >= 58 ? 'good' : c >= 45 ? 'fair' : 'low';

export const verdictLabel = { strong: 'Strong', lean: 'Lean', pass: 'Pass' };

/**
 * What "💡 Suggested bets" analyses. Each upcoming window is exclusive —
 * "Next 1 hour" means games kicking off within the hour, not games already on.
 * `mix` keeps live games alongside the next 12 hours (up to half the slots).
 */
export const SUGGEST_SCOPES = [
  { key: 'live', label: '🔴 Live now', window: 'live', live: true },
  { key: 'mix', label: 'Live + next 12h', window: '12h', live: true },
  { key: '1h', label: 'Next 1 hour', window: '1h', live: false },
  { key: '3h', label: 'Next 3 hours', window: '3h', live: false },
  { key: '6h', label: 'Next 6 hours', window: '6h', live: false },
  { key: '12h', label: 'Next 12 hours', window: '12h', live: false },
  { key: '24h', label: 'Next 24 hours', window: '24h', live: false },
  { key: 'today', label: 'Rest of today', window: 'today', live: false },
  { key: 'tomorrow', label: 'Tomorrow', window: 'tomorrow', live: false },
];

const LEGACY_WINDOW_LABELS = { all: 'Today + tomorrow', today: 'Today', '12h': 'Next 12h' };

/** Label for a stored run's scope (older runs stored the page's window key). */
export const scopeLabel = (key) =>
  SUGGEST_SCOPES.find((s) => s.key === key)?.label.replace('🔴 ', '') || LEGACY_WINDOW_LABELS[key] || key || '';
