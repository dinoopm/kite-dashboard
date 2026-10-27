import { usePlotArea, useXAxisScale, ZIndexLayer, DefaultZIndexes } from 'recharts';
import { SEVERITY_COLORS, severitySegments } from '../lib/severityTimeline';

export default function VixRiskTimeline({ data }) {
  const plot = usePlotArea(), scale = useXAxisScale();
  if (!plot || !scale || !data.length) return null;
  const bands = severitySegments(data).flatMap(segment => {
    const first = Number(scale(data[segment.first].date)), last = Number(scale(data[segment.last].date));
    const left = segment.first === 0 ? plot.x : (Number(scale(data[segment.first - 1].date)) + first) / 2;
    const right = segment.last === data.length - 1 ? plot.x + plot.width : (last + Number(scale(data[segment.last + 1].date))) / 2;
    if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) return [];
    return [{ ...segment, left, width: right - left, color: SEVERITY_COLORS[segment.state] }];
  });
  // A step sparkline uses the same daily classifications. MIXED and missing
  // data break the line, rather than being drawn as a quiet/neutral reading.
  const ranks = { NEUTRAL: 0, CAUTION: 1, STRESS: 2, 'CRASH MODE': 3 };
  let sparkline = '', previous = null;
  data.forEach(point => {
    const rank = ranks[point.riskState], x = Number(scale(point.date));
    if (rank == null || !Number.isFinite(x)) { previous = null; return; }
    const y = plot.y + plot.height - 24 - rank * 6;
    sparkline += previous == null ? `M${x},${y}` : `H${x}V${y}`;
    previous = point;
  });
  // Short stress/crash episodes still need a readable label at wide ranges.
  // Deduplicate nearby callouts; every daily value remains in the tooltip.
  const lastCallout = {};
  const callouts = bands.filter(band => {
    if (!['STRESS', 'CRASH MODE'].includes(band.state) || band.width >= band.state.length * 6.1 + 12) return false;
    const center = band.left + band.width / 2;
    if (lastCallout[band.state] != null && center - lastCallout[band.state] < 100) return false;
    lastCallout[band.state] = center; return true;
  });
  return <>
    <ZIndexLayer zIndex={DefaultZIndexes.grid + 1}><g style={{ pointerEvents: 'none' }} aria-hidden="true">{bands.map(band => <rect key={band.from} x={band.left} y={plot.y} width={band.width} height={plot.height} fill={band.color} opacity={band.state === 'MIXED' ? 0.025 : 0.09}/>)}</g></ZIndexLayer>
    <ZIndexLayer zIndex={DefaultZIndexes.label}>{sparkline && <path d={sparkline} fill="none" stroke="#cbd5e1" strokeWidth={1.2} opacity={0.8} role="img" aria-label="Daily tier history sparkline; mixed and unavailable periods are gaps" style={{ pointerEvents: 'none' }}/>}<g aria-label="Historical severity timeline" style={{ pointerEvents: 'none' }}>{bands.map(band => <g key={band.from} aria-label={`${band.state}: ${band.from} to ${band.to}`}>
      <rect x={band.left} y={plot.y + plot.height - 18} width={band.width} height={18} fill={band.color} opacity={band.state === 'MIXED' ? 0.12 : 0.28}/>
      {band.width >= band.state.length * 6.1 + 12 && <text x={band.left + band.width / 2} y={plot.y + plot.height - 6} textAnchor="middle" fill={band.color} fontSize={10} fontWeight={700}>{band.state}</text>}
    </g>)}{callouts.map(band => {
      const width = band.state.length * 6.1 + 14;
      const center = band.left + band.width / 2;
      const x = Math.max(plot.x, Math.min(center - width / 2, plot.x + plot.width - width));
      const y = plot.y + (band.state === 'CRASH MODE' ? 6 : 29);
      return <g key={`callout-${band.from}`} aria-label={`${band.state} episode beginning ${band.from}`}>
        <line x1={center} x2={center} y1={y + 18} y2={plot.y + plot.height - 18} stroke={band.color} opacity={0.5} strokeDasharray="3 4"/>
        <rect x={x} y={y} width={width} height={18} rx={3} fill="#101b2d" stroke={band.color}/>
        <text x={x + width / 2} y={y + 12} textAnchor="middle" fill={band.color} fontSize={10} fontWeight={700}>{band.state}</text>
      </g>;
    })}</g></ZIndexLayer>
  </>;
}
