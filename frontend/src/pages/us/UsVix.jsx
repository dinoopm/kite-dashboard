import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import useUsVix, { vixAsOf, vixTiming } from '../../hooks/useUsVix';
import usePointMeasurement from '../../hooks/usePointMeasurement';
import PriceMeasurementControls from '../../components/PriceMeasurementControls';
import RechartsPriceMeasurement from '../../components/RechartsPriceMeasurement';
import CnnFearGreedPanel from '../../components/CnnFearGreedPanel';
import UsRiskSeverityPanel from '../../components/UsRiskSeverityPanel';
import VixRiskTimeline from '../../components/VixRiskTimeline';
import { annotateSeverity, SEVERITY_COLORS } from '../../lib/severityTimeline';
import './UsVix.css';

const RANGES = { '1M': 31, '3M': 93, '6M': 186, '1Y': 366, '5Y': 5 * 366, '10Y': 10 * 366, MAX: null };
const fmt = value => value == null ? '—' : value.toFixed(2);
const signed = value => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
const dateLabel = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export default function UsVix() {
  const { data, error, retry } = useUsVix();
  const [range, setRange] = useState('1Y');
  const [severity, setSeverity] = useState(null);
  const model = usePointMeasurement(`us-vix:${range}`);
  const series = useMemo(() => {
    if (!data) return [];
    const cutoff = RANGES[range] == null ? '' : new Date(Date.parse(data.fetchedAt || data.asOf) - RANGES[range] * 864e5).toISOString().slice(0, 10);
    return annotateSeverity(data.series.filter(point => point.date >= cutoff), severity?.timeline);
  }, [data, range, severity]);
  const closes = series.map(point => point.close);
  const periodChange = series.length > 1 ? series.at(-1).close - series[0].close : null;
  return <div className="dashboard-layout us-vix-page">
    <header className="header" style={{ borderBottom: 'none', marginBottom: '1.25rem' }}>
      <div><Link to="/us" className="us-vix-back">← US Indices</Link><h1>US VIX</h1><p>Cboe Volatility Index · S&P 500 implied volatility</p></div>
    </header>
    {error && <div className="glass-panel us-vix-message" role="alert">{error} {data && 'The last loaded values remain below.'} <button type="button" onClick={retry}>Retry</button></div>}
    {!data && !error && <p role="status">Loading US VIX and daily history…</p>}
    {data && <>
      <section className="us-vix-stats" aria-label="US VIX summary">
        <div className="glass-panel us-vix-level"><span className="label">Cboe VIX · index points</span><strong>{fmt(data.current)}</strong><span className="us-vix-change">{signed(data.change)} pts ({signed(data.changePct)}%) <small>vs previous close</small></span><small>{vixTiming(data)} · {vixAsOf(data)}</small></div>
        <div className="glass-panel"><span className="label">Previous close</span><strong>{fmt(data.previousClose)}</strong><small>Prior trading session · points</small></div>
        <div className="glass-panel"><span className="label">{range} closing range</span><strong>{closes.length > 1 ? `${fmt(Math.min(...closes))} – ${fmt(Math.max(...closes))}` : '—'}</strong><small>Daily closes{series.at(-1)?.provisional ? ' + latest quote' : ''}</small></div>
        <div className="glass-panel"><span className="label">{range} change</span><strong>{signed(periodChange)}<small> pts</small></strong><small>{series.length > 1 ? `${dateLabel(series[0].date)} → ${dateLabel(series.at(-1).date)}` : 'History unavailable'}</small></div>
      </section>
    </>}
    <CnnFearGreedPanel />
    <UsRiskSeverityPanel showQuoteNote onData={setSeverity} />
    {data && <>
      {data.warnings.map(message => <p className="us-vix-message" key={message}>{message}</p>)}
      <section className="glass-panel us-vix-chart" aria-label="VIX historical chart">
        <div className="us-vix-chart-heading"><h2>VIX history</h2><div className="us-vix-ranges" aria-label="History range">{Object.keys(RANGES).map(value => <button type="button" key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{value}</button>)}</div></div>
        <div className="vix-risk-legend" aria-label="Risk timeline legend">{Object.entries(SEVERITY_COLORS).map(([label, color]) => <span key={label} style={{ color }}><i style={{ background: color }}/>{label}</span>)}</div>
        <PriceMeasurementControls model={model} disabled={series.length < 2} />
        {series.length > 1 ? <div style={{ height: 380, width: '100%' }}><ResponsiveContainer width="100%" height="100%"><AreaChart data={series} margin={{ top: 15, right: 18, left: 0, bottom: 10 }}>
          <defs><linearGradient id="us-vix-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#a78bfa" stopOpacity={0.3}/><stop offset="100%" stopColor="#a78bfa" stopOpacity={0.02}/></linearGradient></defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false}/>
          <XAxis dataKey="date" minTickGap={45} tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} tickFormatter={date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: ['5Y', '10Y', 'MAX'].includes(range) ? '2-digit' : undefined, day: ['5Y', '10Y', 'MAX'].includes(range) ? undefined : 'numeric', timeZone: 'UTC' })}/>
          <YAxis domain={['auto', 'auto']} tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} width={48}/>
          <Tooltip active={model.state.active ? false : undefined} labelFormatter={dateLabel} formatter={(value, name, item) => [`${fmt(value)} pts${item.payload.provisional ? ' · latest quote' : ' · close'} · ${item.payload.riskState === 'CRASH MODE' ? 'CRASH MODE · confirmation' : item.payload.riskState || 'Risk unavailable'}${item.payload.riskFlags?.divergence ? ' · credit divergence' : ''}`, 'VIX']} contentStyle={{ background: '#101b2d', border: '1px solid var(--border)', borderRadius: 8 }}/>
          <VixRiskTimeline data={series}/>
          <Area type="linear" dataKey="close" stroke="#a78bfa" strokeWidth={2} fill="url(#us-vix-fill)" dot={false} isAnimationActive={false}/>
          <RechartsPriceMeasurement model={model} data={series}/>
        </AreaChart></ResponsiveContainer></div> : <p role="status">Daily history is unavailable for this range.</p>}
        <p className="us-vix-source">{severity?.timeline?.fromDate ? <>Risk labels: {severity.timeline.fromDate} → {severity.timeline.toDate}. Historical reconstruction, not a point-in-time backtest. Publication timing and revisions are not recreated; blank periods lack complete inputs. The small step line shows the actual tier history.</> : severity ? 'Historical risk labels are unavailable for the loaded data.' : 'Loading historical risk labels…'}</p>
        <p className="us-vix-source">{data.source} · {vixTiming(data)}. History: <a href="https://www.cboe.com/tradable-products/vix/vix-historical-data/" target="_blank" rel="noreferrer">Cboe daily closes</a>{data.historyAsOf ? ` through ${data.historyAsOf}` : ''}. {data.kind === 'quote' && 'Final chart point is the latest available quote.'}</p>
      </section>
      <section className="glass-panel us-vix-explainer"><h2>Reading VIX</h2><p>VIX measures expected S&P 500 volatility over the next 30 days, expressed at an annualized rate. Higher readings imply larger expected price swings; lower readings imply smaller swings. It does not indicate the direction of the next move.</p><p>A change of +2 points is a change in the VIX level; the percentage beside it measures how much VIX itself changed from the previous close. <a href="https://www.cboe.com/tradable-products/volatility-trading/" target="_blank" rel="noreferrer">About VIX ↗</a></p></section>
    </>}
  </div>;
}
