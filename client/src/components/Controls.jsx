export function Segmented({ options, value, onChange, prefix = '' }) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={prefix ? `${prefix}${o.key}` : undefined}
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          title={o.title || o.label}
        >
          {o.icon ? <span aria-hidden="true">{o.icon}</span> : null}
          {o.label}
          {o.count !== undefined && o.count !== null ? <span className="count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function ConfidenceRing({ value, size = 94, band = 'good' }) {
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pctValue = Math.max(0, Math.min(100, value || 0));
  const colors = { high: 'var(--green)', good: 'var(--accent)', fair: 'var(--amber)', low: 'var(--red)' };
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-soft)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={colors[band]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (pctValue / 100) * c}
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
      </svg>
      <div className="ring-label">
        <strong>{Math.round(pctValue)}</strong>
        <span>Confidence</span>
      </div>
    </div>
  );
}

export function ProbBar({ value, tone }) {
  const p = Math.max(0, Math.min(1, value || 0));
  const cls = tone || (p >= 0.68 ? 'green' : p >= 0.5 ? '' : p >= 0.35 ? 'amber' : 'red');
  return (
    <div className={`prob-bar ${cls}`}>
      <div style={{ width: `${p * 100}%` }} />
    </div>
  );
}
