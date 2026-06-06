// Shared India-VIX "fear gauge" SVG dial, used by both the full VIX page
// (VixIndex) and the compact dashboard widget (VixWidget). Zone thresholds live
// in ./vixZones so this file only exports a component (keeps fast-refresh happy).
import { getVixZone } from './vixZones';

// ─── SVG Gauge Component ───────────────────────────────────────
export function VixGauge({ value }) {
  const min = 0, max = 50;
  const clamped = Math.max(min, Math.min(max, value));
  const pct = (clamped - min) / (max - min);
  const startAngle = -225;
  const endAngle = 45;
  const sweep = endAngle - startAngle;
  const needleAngle = startAngle + pct * sweep;

  const cx = 120, cy = 120, r = 95;
  const toRad = (deg) => (deg * Math.PI) / 180;

  const arcPath = (start, end) => {
    const s = toRad(start), e = toRad(end);
    const x1 = cx + r * Math.cos(s), y1 = cy + r * Math.sin(s);
    const x2 = cx + r * Math.cos(e), y2 = cy + r * Math.sin(e);
    const largeArc = (end - start) > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
  };

  // Zone boundaries on the arc
  const zones = [
    { pct: 15 / 50, color: '#10b981' },   // 0-15: Green
    { pct: 25 / 50, color: '#eab308' },   // 15-25: Yellow
    { pct: 50 / 50, color: '#ef4444' },   // 25-50: Red
  ];

  const zone = getVixZone(value);

  // Needle endpoint
  const nRad = toRad(needleAngle);
  const nx = cx + (r - 20) * Math.cos(nRad);
  const ny = cy + (r - 20) * Math.sin(nRad);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <svg width="240" height="160" viewBox="0 0 240 160">
        {/* Background track */}
        <path d={arcPath(startAngle, endAngle)} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="18" strokeLinecap="round" />

        {/* Zone arcs */}
        {(() => {
          let prevPct = 0;
          return zones.map((z, i) => {
            const a1 = startAngle + prevPct * sweep;
            const a2 = startAngle + z.pct * sweep;
            prevPct = z.pct;
            return <path key={i} d={arcPath(a1, a2)} fill="none" stroke={z.color} strokeWidth="18" strokeLinecap="round" opacity="0.35" />;
          });
        })()}

        {/* Active arc up to needle */}
        <path d={arcPath(startAngle, needleAngle)} fill="none" stroke={zone.color} strokeWidth="18" strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 8px ${zone.color}80)` }} />

        {/* Needle */}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="5" fill="#fff" />

        {/* Value text */}
        <text x={cx} y={cy + 2} textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize="32" fontWeight="800">{value.toFixed(2)}</text>
      </svg>
      <div style={{ marginTop: '-0.5rem', textAlign: 'center' }}>
        <span style={{
          fontSize: '0.85rem', fontWeight: 800, letterSpacing: '2px', color: zone.color,
          textTransform: 'uppercase',
          textShadow: `0 0 12px ${zone.color}60`
        }}>
          {zone.label}
        </span>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '1.5rem', marginTop: '0.75rem' }}>
          {[
            { label: 'CALM', range: '0 – 15', color: '#10b981' },
            { label: 'CAUTION', range: '15 – 25', color: '#eab308' },
            { label: 'FEAR', range: '25+', color: '#ef4444' },
          ].map(z => (
            <div key={z.label} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '0.65rem', fontWeight: 700, color: z.color, marginBottom: '0.15rem' }}>{z.label}</div>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}>{z.range}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
