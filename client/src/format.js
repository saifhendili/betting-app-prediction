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
