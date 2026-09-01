// ADX(14) trend-strength curve for a sector index/ETF. Presentational: it takes
// the daily OHLC bars the page already fetched and does its own arithmetic, no
// fetching and no shared state.
//
// The Indices table shows a single ADX number, which answers "is it trending?"
// but not "is that trend building or fading?" — a sector at 24 on the way up and
// one at 24 on the way down read identically there. Plotting the series is the
// whole point of this card, so the bands (chop / building / strong) are drawn
// behind the line rather than left to the reader's memory of the thresholds.
//
// ADX is direction-blind by construction, so the up/down colouring comes from
// price vs its own 50-day average — the same rule the Indices ADX badge uses, so
// a sector reads the same way on both screens.
import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceArea, ReferenceLine, ResponsiveContainer } from 'recharts';
import { adx14Series } from '../lib/indicators';
import { computeSMA } from '../lib/sectorAnalytics';

const GREEN = '#22c55e', RED = '#ef4444', AMBER = '#eab308', GREY = '#64748b';

// Wilder's conventional cut-offs, kept in one place so the bands, the badge and
// the summary line can never disagree about where "building" starts.
const STRONG = 25, BUILDING = 20;

const RANGES = [
  { label: '3M', bars: 63 },
  { label: '6M', bars: 126 },
  { label: '1Y', bars: 252 },
];

// Trailing window for the slope read. Five sessions is short enough to catch a
// turn while ignoring single-day noise, and matches the 1W lookback the rest of
// the page uses for rank deltas.
const SLOPE_BARS = 5;

const regimeOf = (adx, up) => {
  if (adx >= STRONG) return { text: up ? 'Strong ↑' : 'Strong ↓', color: up ? GREEN : RED };
  if (adx >= BUILDING) return { text: 'Building', color: AMBER };
  return { text: 'Chop', color: GREY };
};

const fmtDate = (d) => {
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? String(d).slice(0, 10)
    : dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
};

export default function SectorAdxChart({ bars }) {
  const [range, setRange] = useState('6M');

  const series = useMemo(() => adx14Series(bars || []), [bars]);

  // Direction is a property of price, not of ADX. Computed off the same bars so
  // it can never drift from the series plotted beside it.
  const aboveSma50 = useMemo(() => {
    if (!bars?.length) return null;
    const closes = bars.map(b => b.close);
    const sma50 = computeSMA(closes, 50);
    return sma50 == null ? null : closes[closes.length - 1] >= sma50;
  }, [bars]);

  const view = useMemo(() => {
    const n = RANGES.find(r => r.label === range)?.bars ?? 126;
    return series.slice(-n).map(p => ({ date: p.date, adx: +p.adx.toFixed(2) }));
  }, [series, range]);

  // ADX needs 2p+1 = 29 bars before it produces anything. A freshly listed ETF
  // (WQTM was 212 bars old at launch) clears that easily, but a synthetic
  // composite has no true high/low at all and never reaches here with bars.
  if (series.length === 0) {
    return (
      <div className="glass-panel" style={{ padding: '1.5rem', marginBottom: '1rem' }}>
        <h3 style={{ margin: '0 0 0.2rem 0', fontSize: '1rem' }}>Trend Strength — ADX(14)</h3>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
          Needs at least 29 daily bars with true high/low. Not available for this sector.
        </p>
      </div>
    );
  }

  const current = series[series.length - 1].adx;
  const prior = series.length > SLOPE_BARS ? series[series.length - 1 - SLOPE_BARS].adx : null;
  const delta = prior == null ? null : current - prior;
  const regime = regimeOf(current, aboveSma50);

  // Deterministic read of two already-computed numbers — the level and the
  // 5-session change. Deliberately describes what the curve has done, and makes
  // no claim about what price does next.
  const slopeWord = delta == null ? null : delta > 1 ? 'rising' : delta < -1 ? 'falling' : 'flat';
  const summary = delta == null ? null
    : current >= STRONG
      ? (slopeWord === 'rising' ? 'Trending hard and still strengthening.'
        : slopeWord === 'falling' ? 'Still a real trend, but strength is draining out of it.'
        : 'Trending, with strength holding steady.')
    : current >= BUILDING
      ? (slopeWord === 'rising' ? 'Strength is building — not yet a confirmed trend.'
        : 'Trend strength is slipping back toward chop.')
      : (slopeWord === 'rising' ? 'Waking up from chop, but still below the trend threshold.'
        : 'Choppy and directionless — breakouts fail more often here.');

  const yMax = Math.max(40, Math.ceil(Math.max(...view.map(p => p.adx)) / 10) * 10);

  return (
    <div className="glass-panel" style={{ padding: '1.5rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: '0 0 0.2rem 0', fontSize: '1rem' }}>Trend Strength — ADX(14)</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
            How hard the sector is trending, not which way. Direction is price vs its 50-day average.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span style={{
            display: 'inline-block', padding: '0.25rem 0.6rem', borderRadius: '6px',
            fontSize: '0.9rem', fontWeight: 700, whiteSpace: 'nowrap',
            background: `${regime.color}26`, color: regime.color,
            border: `1px solid ${regime.color}4d`,
          }}>
            {current.toFixed(1)}
            <span style={{ fontSize: '0.7rem', fontWeight: 500, marginLeft: '0.35rem', opacity: 0.9 }}>{regime.text}</span>
          </span>
          {delta != null && (
            <span title={`Change over the last ${SLOPE_BARS} sessions`} style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              {delta >= 0 ? '+' : ''}{delta.toFixed(1)} / {SLOPE_BARS}d
            </span>
          )}
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {RANGES.map(r => (
              <button
                key={r.label}
                onClick={() => setRange(r.label)}
                style={{
                  padding: '0.2rem 0.55rem', borderRadius: '6px', cursor: 'pointer',
                  fontSize: '0.75rem', fontWeight: 600,
                  background: range === r.label ? 'rgba(255,255,255,0.12)' : 'transparent',
                  color: range === r.label ? 'var(--text-primary)' : 'var(--text-secondary)',
                  border: '1px solid rgba(255,255,255,0.12)',
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginTop: '0.9rem' }}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={view} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
            {/* Regime bands behind the line: chop / building / trending. */}
            <ReferenceArea y1={0} y2={BUILDING} fill="rgba(100,116,139,0.10)" stroke="none" />
            <ReferenceArea y1={BUILDING} y2={STRONG} fill="rgba(234,179,8,0.10)" stroke="none" />
            <ReferenceArea y1={STRONG} y2={yMax} fill={aboveSma50 === false ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)'} stroke="none" />
            <ReferenceLine y={BUILDING} stroke="rgba(234,179,8,0.45)" strokeDasharray="3 3" />
            <ReferenceLine y={STRONG} stroke="rgba(34,197,94,0.45)" strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickFormatter={fmtDate}
              minTickGap={40}
              tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
              axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
              tickLine={false}
            />
            <YAxis
              domain={[0, yMax]}
              ticks={[0, BUILDING, STRONG, yMax]}
              width={34}
              tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(v) => [`${v.toFixed(1)} — ${regimeOf(v, aboveSma50).text}`, 'ADX(14)']}
              labelFormatter={fmtDate}
              contentStyle={{ background: '#0f1117', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, fontSize: '0.82rem', color: '#fff', padding: '0.5rem 0.75rem' }}
              labelStyle={{ color: '#fff', fontWeight: 700, marginBottom: '0.2rem' }}
              itemStyle={{ color: '#94a3b8' }}
              cursor={{ stroke: 'rgba(255,255,255,0.25)' }}
            />
            <Line type="monotone" dataKey="adx" stroke={regime.color} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {summary && (
        <p style={{ margin: '0.6rem 0 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          <span style={{ color: regime.color, fontWeight: 700 }}>{regime.text}</span> · {summary}{' '}
          <span style={{ opacity: 0.75 }}>Under {BUILDING} is chop, {BUILDING}–{STRONG} is a trend forming, {STRONG}+ is a trend worth trading.</span>
        </p>
      )}
    </div>
  );
}
