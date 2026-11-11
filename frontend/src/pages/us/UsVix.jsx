import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts';
import useUsVix, { vixAsOf, vixTiming } from '../../hooks/useUsVix';
import usePointMeasurement from '../../hooks/usePointMeasurement';
import PriceMeasurementControls from '../../components/PriceMeasurementControls';
import RechartsPriceMeasurement from '../../components/RechartsPriceMeasurement';
import CnnFearGreedPanel from '../../components/CnnFearGreedPanel';
import UsRiskSeverityPanel from '../../components/UsRiskSeverityPanel';
import VixRiskTimeline from '../../components/VixRiskTimeline';
import { annotateSeverity, SEVERITY_COLORS } from '../../lib/severityTimeline';
import { percentileBelow, impliedDailyMovePct, etDate, freshnessRows } from '../../lib/vixPage';
import { fetchWithAbort } from '../../hooks/useFetchWithAbort';
import './UsVix.css';

const RANGES = { '1M': 31, '3M': 93, '6M': 186, '1Y': 366, '2Y': 2 * 366, '3Y': 3 * 366, '5Y': 5 * 366, '10Y': 10 * 366, MAX: null };
const fmt = value => value == null ? '—' : value.toFixed(2);
const signed = value => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
const dateLabel = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export default function UsVix() {
  const { data, error, retry } = useUsVix();
  const [range, setRange] = useState('1Y');
  const [severity, setSeverity] = useState(null);
  const [cnn, setCnn] = useState(null);
  const [provisional, setProvisional] = useState(null);
  // When the quote is newer than the assessment's closing date, ask what the
  // same rule says with only VIX swapped for the number shown at the top of
  // this page. Read-only on the server and never recorded.
  const quoteDay = data ? (data.kind === 'daily-close' ? data.asOf : etDate(data.asOf)) : null;
  useEffect(() => {
    if (!Number.isFinite(data?.current) || !severity?.asOf || !quoteDay || quoteDay <= severity.asOf) { setProvisional(null); return; }
    const controller = new AbortController();
    fetchWithAbort(`/api/us/risk-severity/provisional?vix=${data.current}`, { signal: controller.signal, timeoutMs: 30_000 })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (!controller.signal.aborted) setProvisional(j?.provisional || null); })
      .catch(() => { if (!controller.signal.aborted) setProvisional(null); });
    return () => controller.abort();
  }, [data?.current, quoteDay, severity?.asOf]);
  const model = usePointMeasurement(`us-vix:${range}`);
  const series = useMemo(() => {
    if (!data) return [];
    const cutoff = RANGES[range] == null ? '' : new Date(Date.parse(data.fetchedAt || data.asOf) - RANGES[range] * 864e5).toISOString().slice(0, 10);
    return annotateSeverity(data.series.filter(point => point.date >= cutoff), severity?.timeline);
  }, [data, range, severity]);
  const closes = series.map(point => point.close);
  // Ranked against settled closes only — the provisional quote is the thing
  // being ranked, so it must not also sit in the sample.
  const rank = percentileBelow(series.filter(point => !point.provisional).map(point => point.close), data?.current);
  const dailyMove = impliedDailyMovePct(data?.current);
  const fresh = data ? freshnessRows({ vix: data, severity, cnn }) : [];
  const rules = severity?.rules;
  return <div className="dashboard-layout us-vix-page">
    <header className="header" style={{ borderBottom: 'none', marginBottom: '1.25rem' }}>
      <div><Link to="/us" className="us-vix-back">← US Indices</Link><h1>US VIX</h1><p>Cboe Volatility Index · S&P 500 implied volatility</p></div>
    </header>
    {/* Each block on this page has its own as-of date. Stated once, here,
        with how far each trails — and amber only where that is more than the
        source's normal lag. */}
    {fresh.length > 0 && <div className="us-vix-freshness" aria-label="Data freshness">{fresh.map(row => <span key={row.id} className={row.stale ? 'stale' : ''}><strong>{row.label}</strong> {row.date}{row.behind > 0 ? ` · ${row.behind} ${row.behind === 1 ? 'session' : 'sessions'} behind` : ' · current'}{row.note ? ` · ${row.note}` : ''}</span>)}</div>}
    {error && <div className="glass-panel us-vix-message" role="alert">{error} {data && 'The last loaded values remain below.'} <button type="button" onClick={retry}>Retry</button></div>}
    {!data && !error && <p role="status">Loading US VIX and daily history…</p>}
    {data && <>
      <section className="us-vix-stats" aria-label="US VIX summary">
        <div className="glass-panel us-vix-level"><span className="label">Cboe VIX · index points</span><strong>{fmt(data.current)}</strong><span className="us-vix-change">{signed(data.change)} pts ({signed(data.changePct)}%) <small>vs previous close {fmt(data.previousClose)}</small></span><small>{vixTiming(data)} · {vixAsOf(data)}</small></div>
        <div className="glass-panel"><span className="label">{range} closing range</span><strong>{closes.length > 1 ? `${fmt(Math.min(...closes))} – ${fmt(Math.max(...closes))}` : '—'}</strong><small>Daily closes{series.at(-1)?.provisional ? ' + latest quote' : ''}{series.length > 1 ? ` · ${dateLabel(series[0].date)} → ${dateLabel(series.at(-1).date)}` : ''}</small></div>
        {/* Replaces "1Y change": VIX reverts to its mean, so where today sits
            in the range says more than where it sat a year ago. */}
        <div className="glass-panel"><span className="label">Rank in {range}</span><strong>{rank == null ? '—' : `${rank}%`}</strong><small>of {range} closes were below today's level</small></div>
        {/* Replaces "Previous close", which repeated card one. VIX is
            annualised; VIX / sqrt(252) is the one-standard-deviation daily
            S&P 500 move it prices — the definition restated, not a forecast. */}
        <div className="glass-panel"><span className="label">Implied daily S&amp;P move</span><strong>{dailyMove == null ? '—' : `±${dailyMove.toFixed(2)}%`}</strong><small>One standard deviation · VIX ÷ √252 · says nothing about direction</small></div>
      </section>
    </>}
    <CnnFearGreedPanel onData={setCnn} />
    <UsRiskSeverityPanel showQuoteNote onData={setSeverity} provisional={provisional} />
    {data && <>
      {data.warnings.map(message => <p className="us-vix-message" key={message}>{message}</p>)}
      <section className="glass-panel us-vix-chart" aria-label="VIX historical chart">
        <div className="us-vix-chart-heading"><h2>VIX history</h2><div className="us-vix-ranges" aria-label="History range">{Object.keys(RANGES).map(value => <button type="button" key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{value}</button>)}</div></div>
        <div className="vix-risk-legend" aria-label="Risk timeline legend">{Object.entries(SEVERITY_COLORS).map(([label, color]) => <span key={label} style={{ color }}><i style={{ background: label === 'MIXED' ? 'transparent' : color, border: label === 'MIXED' ? `1px solid ${color}` : undefined }}/>{label === 'MIXED' ? 'MIXED · no tier, unshaded' : label}</span>)}{rules && <span style={{ color: 'var(--text-secondary)' }}>— dashed lines: the rule's VIX thresholds</span>}</div>
        <PriceMeasurementControls model={model} disabled={series.length < 2} />
        {series.length > 1 ? <div style={{ height: 380, width: '100%' }}><ResponsiveContainer width="100%" height="100%"><AreaChart data={series} margin={{ top: 15, right: 18, left: 0, bottom: 10 }}>
          <defs><linearGradient id="us-vix-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#a78bfa" stopOpacity={0.3}/><stop offset="100%" stopColor="#a78bfa" stopOpacity={0.02}/></linearGradient></defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false}/>
          <XAxis dataKey="date" minTickGap={45} tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} tickFormatter={date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: ['2Y', '3Y', '5Y', '10Y', 'MAX'].includes(range) ? '2-digit' : undefined, day: ['2Y', '3Y', '5Y', '10Y', 'MAX'].includes(range) ? undefined : 'numeric', timeZone: 'UTC' })}/>
          <YAxis domain={['auto', 'auto']} tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} width={48}/>
          <Tooltip active={model.state.active || model.state.dragging ? false : undefined} labelFormatter={dateLabel} formatter={(value, name, item) => [`${fmt(value)} pts${item.payload.provisional ? ' · latest quote' : ' · close'} · ${item.payload.riskState === 'CRASH MODE' ? 'CRASH MODE · confirmation' : item.payload.riskState || 'Risk unavailable'}${item.payload.riskFlags?.divergence ? ' · credit divergence' : ''}`, 'VIX']} contentStyle={{ background: '#101b2d', border: '1px solid var(--border)', borderRadius: 8 }}/>
          <VixRiskTimeline data={series}/>
          {/* The tiers are defined on these VIX levels, so the reader can see a
              threshold crossing directly — e.g. a quote just above 20 has left
              CAUTION's band. Outside the visible range they are not drawn. */}
          {rules && [[rules.vixNeutralMax, `${rules.vixNeutralMax} · NEUTRAL below`, SEVERITY_COLORS.NEUTRAL], [rules.vixCautionMax, `${rules.vixCautionMax} · CAUTION below`, SEVERITY_COLORS.CAUTION], [rules.vixCrashAbove, `${rules.vixCrashAbove} · CRASH MODE above`, SEVERITY_COLORS['CRASH MODE']]]
            .filter(([y]) => Number.isFinite(y))
            .map(([y, label, color]) => <ReferenceLine key={y} y={y} stroke={color} strokeOpacity={0.55} strokeDasharray="4 4" label={{ value: label, position: 'insideTopRight', fill: color, fontSize: 10 }}/>)}
          <Area type="linear" dataKey="close" stroke="#a78bfa" strokeWidth={2} fill="url(#us-vix-fill)" dot={false} isAnimationActive={false}/>
          <RechartsPriceMeasurement model={model} data={series}/>
        </AreaChart></ResponsiveContainer></div> : <p role="status">Daily history is unavailable for this range.</p>}
        <p className="us-vix-source">{severity?.timeline?.fromDate ? <>Risk labels: {severity.timeline.fromDate} → {severity.timeline.toDate}. Historical reconstruction, not a point-in-time backtest. Publication timing and revisions are not recreated; blank periods lack complete inputs or matched no tier (MIXED). The small step line shows the actual tier history.</> : severity ? 'Historical risk labels are unavailable for the loaded data.' : 'Loading historical risk labels…'}</p>
        <p className="us-vix-source">{data.source} · {vixTiming(data)}. History: <a href="https://www.cboe.com/tradable-products/vix/vix-historical-data/" target="_blank" rel="noreferrer">Cboe daily closes</a>{data.historyAsOf ? ` through ${data.historyAsOf}` : ''}. {data.kind === 'quote' && 'Final chart point is the latest available quote.'}</p>
      </section>
      <section className="glass-panel us-vix-explainer"><h2>Reading VIX</h2><p>VIX measures expected S&P 500 volatility over the next 30 days, expressed at an annualized rate. Higher readings imply larger expected price swings; lower readings imply smaller swings. It does not indicate the direction of the next move.</p><p>A change of +2 points is a change in the VIX level; the percentage beside it measures how much VIX itself changed from the previous close. <a href="https://www.cboe.com/tradable-products/volatility-trading/" target="_blank" rel="noreferrer">About VIX ↗</a></p></section>
    </>}
  </div>;
}
