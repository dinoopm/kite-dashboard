import { measurementDate } from '../lib/priceMeasurement';

const number = value => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = value => `${value >= 0 ? '+' : '−'}${number(Math.abs(value))}`;

export default function PriceMeasurementOverlay({ measurement }) {
  const { geometry, result, start, end, preview, active } = measurement;
  if (!geometry || !start) return null;
  const { from, to, width, height } = geometry;
  const color = (result?.change ?? 0) >= 0 ? '#34d399' : '#fb7185';
  const badgeWidth = Math.min(280, width - 16);
  const left = Math.max(8, Math.min(((from.x + (to?.x ?? from.x)) / 2) - badgeWidth / 2, width - badgeWidth - 8));
  const top = Math.max(8, Math.min(Math.min(from.y, to?.y ?? from.y) - 105, height - 110));
  const target = end || preview;
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 4, pointerEvents: 'none', overflow: 'hidden' }}>
      <svg width={width} height={height} style={{ display: 'block', overflow: 'hidden' }} aria-hidden="true">
        {to && <>
          <rect x={Math.min(from.x, to.x)} y={Math.min(from.y, to.y)} width={Math.abs(to.x - from.x)} height={Math.max(1, Math.abs(to.y - from.y))} fill={color} fillOpacity="0.12" stroke={color} strokeWidth="1" strokeDasharray="4 3" />
          <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth="2" />
          <circle cx={to.x} cy={to.y} r="5" fill={color} stroke="#131722" strokeWidth="2" />
        </>}
        <circle cx={from.x} cy={from.y} r="5" fill="#38bdf8" stroke="#131722" strokeWidth="2" />
      </svg>
      {result && target && <div data-testid="price-measurement-result" role="status" aria-live={active ? 'off' : 'polite'} style={{ position: 'absolute', top, left, width: badgeWidth, boxSizing: 'border-box', padding: '9px 12px', borderRadius: '7px', background: 'rgba(15,23,42,0.97)', border: `1px solid ${color}`, boxShadow: '0 4px 16px rgba(0,0,0,0.35)', color: '#cbd5e1', fontSize: '0.72rem', lineHeight: 1.5, fontVariantNumeric: 'tabular-nums' }}>
        <strong style={{ display: 'block', color, fontSize: '0.95rem' }}>{signed(result.percent)}% <span style={{ fontSize: '0.76rem' }}>({signed(result.change)})</span></strong>
        <div>{number(start.price)} → {number(target.price)}</div>
        <div>{start.label || measurementDate(start.time)} → {target.label || measurementDate(target.time)}</div>
        <div style={{ color: '#94a3b8' }}>{result.bars != null && `${result.bars} bars · `}{result.days != null && `${result.days} calendar days (~${(result.days / (365.25 / 12)).toLocaleString('en-US', { maximumFractionDigits: 1 })} months)`}{active ? ' · Preview' : ''}</div>
      </div>}
    </div>
  );
}
