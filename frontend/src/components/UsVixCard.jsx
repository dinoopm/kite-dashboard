import { Link } from 'react-router-dom';
import useUsVix, { vixAsOf, vixTiming } from '../hooks/useUsVix';

export default function UsVixCard() {
  const { data, error } = useUsVix();
  return <Link to="/us/vix" className="glass-panel stat-card" title="Open Cboe VIX history" style={{ flex: 1, minWidth: 200, padding: '1.25rem', textDecoration: 'none', color: 'var(--text-primary)', background: 'linear-gradient(145deg, rgba(30,41,59,0.8), rgba(15,23,42,0.9))' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: '0.5rem' }}>
      <span className="label" style={{ margin: 0 }}>US VIX</span>
      <span style={{ color: '#a78bfa', fontSize: '0.75rem', fontWeight: 600 }}>{data?.changePct != null ? `${data.changePct > 0 ? '+' : ''}${data.changePct.toFixed(2)}%` : '—'}</span>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap' }}><span className="value" style={{ fontSize: '1.75rem' }}>{data ? data.current.toFixed(2) : error ? 'Unavailable' : 'Loading…'}</span></div>
    <span className="label" style={{ margin: '0.25rem 0 0', textTransform: 'none', fontSize: '0.7rem' }}>{error ? 'Refresh failed · open for details' : data ? `${vixTiming(data)} · ${vixAsOf(data)}` : 'Cboe Volatility Index'}</span>
  </Link>;
}
