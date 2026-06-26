import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

// US ETF/equity detail: snapshot header + historical price chart, fed by Alpaca.

const RANGES = ['1D', '5D', '1M', '3M', '6M', '1Y', '5Y'];

const fmtPrice = (v) => (v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtPct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const pctColor = (v) => (v == null ? 'var(--text-secondary)' : v >= 0 ? 'var(--success)' : 'var(--danger)');

export default function UsInstrument() {
  const { symbol } = useParams();
  const sym = (symbol || '').toUpperCase();
  const [snap, setSnap] = useState(null);
  const [bars, setBars] = useState([]);
  const [range, setRange] = useState('6M');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadSnap = useCallback(async () => {
    try {
      const res = await fetch(`/api/us/snapshot/${sym}`);
      const json = await res.json();
      if (res.ok) setSnap(json);
    } catch { /* non-fatal */ }
  }, [sym]);

  const loadBars = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/us/bars/${sym}?range=${range}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setBars(json.bars || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [sym, range]);

  useEffect(() => { loadSnap(); }, [loadSnap]);
  useEffect(() => { loadBars(); }, [loadBars]);

  const q = snap?.quote || {};
  const label = snap?.meta?.label || sym;
  const intraday = range === '1D' || range === '5D';
  const fmtAxis = (d) => {
    const dt = new Date(d);
    return intraday
      ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const up = (q.changePct ?? 0) >= 0;
  const chartColor = up ? '#22c55e' : '#ef4444';

  return (
    <div style={{ padding: '0.5rem 0' }}>
      <Link to="/us" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: '0.85rem' }}>← US Markets</Link>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', margin: '0.75rem 0 1.25rem', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{label}</h2>
        <span style={{ color: 'var(--text-secondary)' }}>{sym}</span>
        {snap?.meta?.proxyFor && <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>· {snap.meta.proxyFor}</span>}
      </div>

      <div className="glass-panel" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '2rem', fontWeight: 700 }}>{fmtPrice(q.last)}</span>
          <span style={{ color: pctColor(q.changePct), fontWeight: 600, fontSize: '1.1rem' }}>
            {q.change != null ? `${q.change >= 0 ? '+' : ''}${fmtPrice(q.change)}` : '—'} ({fmtPct(q.changePct)})
          </span>
        </div>
        <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
          <span>Open {fmtPrice(q.open)}</span>
          <span>High {fmtPrice(q.high)}</span>
          <span>Low {fmtPrice(q.low)}</span>
          <span>Prev close {fmtPrice(q.prevClose)}</span>
          <span>Vol {q.volume != null ? q.volume.toLocaleString('en-US') : '—'}</span>
        </div>
      </div>

      {/* Range selector */}
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {RANGES.map(r => (
          <button
            key={r}
            onClick={() => setRange(r)}
            style={{
              padding: '0.35rem 0.8rem', borderRadius: '6px', cursor: 'pointer',
              border: '1px solid var(--border)', fontWeight: 600, fontSize: '0.8rem',
              background: range === r ? 'var(--accent)' : 'transparent',
              color: range === r ? '#fff' : 'var(--text-secondary)',
            }}
          >{r}</button>
        ))}
      </div>

      <div className="glass-panel" style={{ padding: '1rem', height: '420px' }}>
        {loading ? (
          <div className="loader" />
        ) : error ? (
          <div style={{ color: 'var(--danger)', padding: '1rem' }}>Failed to load chart: {error}</div>
        ) : bars.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', padding: '1rem' }}>No data for this range.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={bars} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="usFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={chartColor} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={chartColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="date" tickFormatter={fmtAxis} tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} minTickGap={40} />
              <YAxis domain={['auto', 'auto']} tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} width={55} tickFormatter={(v) => v.toFixed(0)} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px' }}
                labelFormatter={(d) => new Date(d).toLocaleString('en-US')}
                formatter={(v) => [fmtPrice(v), 'Close']}
              />
              <Area type="monotone" dataKey="close" stroke={chartColor} strokeWidth={2} fill="url(#usFill)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
