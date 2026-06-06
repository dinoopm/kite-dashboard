import { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';
import { getVixZone } from '../components/vixZones';
import { VixGauge } from '../components/VixGauge';

// ─── Main VIX Index Page ───────────────────────────────────────
function VixIndex() {
  const [vixQuote, setVixQuote] = useState(null);
  const [niftyQuote, setNiftyQuote] = useState(null);
  const [sensexQuote, setSensexQuote] = useState(null);
  const [history, setHistory] = useState([]);
  const [timeframe, setTimeframe] = useState('1M');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortConfig, setSortConfig] = useState({ key: 'date', direction: 'desc' });

  // Fetch quotes
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort('/api/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruments: ['NSE:INDIA VIX', 'NSE:NIFTY 50', 'BSE:SENSEX'] }),
          signal: controller.signal
        });
        const data = await res.json();
        if (data?.content?.[0]?.text) {
          const q = JSON.parse(data.content[0].text);
          setVixQuote(q['NSE:INDIA VIX'] || null);
          setNiftyQuote(q['NSE:NIFTY 50'] || null);
          setSensexQuote(q['BSE:SENSEX'] || null);
          setLoading(false);
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        setError(err.message);
      }
    })();
    return () => controller.abort();
  }, []);

  // Fetch VIX history
  useEffect(() => {
    if (!vixQuote) return;
    const controller = new AbortController();
    (async () => {
      try {
        const token = vixQuote.instrument_token;
        const res = await fetchWithAbort(`/api/historical/${token}?tf=${timeframe}`, { signal: controller.signal });
        const data = await res.json();
        if (data?.content?.[0]?.text) {
          const candles = JSON.parse(data.content[0].text);
          if (Array.isArray(candles)) {
            const processed = candles.map((c, i) => {
              const prevClose = i > 0 ? candles[i - 1].close : c.open;
              const delta = prevClose ? ((c.close - prevClose) / prevClose) * 100 : 0;
              return {
                date: c.date,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                delta,
              };
            });
            setHistory(processed);
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('VIX history fetch error:', err);
      }
    })();
    return () => controller.abort();
  }, [vixQuote, timeframe]);

  // Compute derived metrics
  const vixValue = vixQuote?.last_price || 0;
  const vixChange = vixQuote?.ohlc?.close ? ((vixValue - vixQuote.ohlc.close) / vixQuote.ohlc.close) * 100 : 0;
  const vixDayHigh = vixQuote?.ohlc?.high || 0;
  const vixDayLow = vixQuote?.ohlc?.low || 0;
  const vixDayRange = vixValue ? ((vixDayHigh - vixDayLow) / vixValue * 100) : 0;
  const zone = getVixZone(vixValue);

  // VIX vs 20-day average
  const last20 = history.slice(-20);
  const avg20 = last20.length > 0 ? last20.reduce((s, c) => s + c.close, 0) / last20.length : null;
  const vixVsAvg = avg20 ? ((vixValue - avg20) / avg20 * 100) : null;

  // Chart data
  const chartData = history.map(c => ({
    date: new Date(c.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
    vix: parseFloat(c.close.toFixed(2)),
  }));

  // Sorted table data
  const sortedHistory = [...history].sort((a, b) => {
    let vA = a[sortConfig.key], vB = b[sortConfig.key];
    if (sortConfig.key === 'date') { vA = new Date(vA); vB = new Date(vB); }
    if (vA < vB) return sortConfig.direction === 'asc' ? -1 : 1;
    if (vA > vB) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

  const requestSort = (key) => {
    setSortConfig(prev => ({ key, direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc' }));
  };
  const renderSortIndicator = (key) => sortConfig.key === key ? (sortConfig.direction === 'asc' ? ' ↑' : ' ↓') : '';

  // Helpers
  const formatPrice = (p) => p ? p.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '-';
  const changePill = (pct) => {
    const color = pct >= 0 ? '#10b981' : '#ef4444';
    const bg = pct >= 0 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
    return (
      <span style={{ fontSize: '0.8rem', fontWeight: 700, color, background: bg, padding: '0.15rem 0.5rem', borderRadius: '4px' }}>
        {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
      </span>
    );
  };

  if (loading) return <div className="loader"></div>;
  if (error) return (
    <div className="dashboard-layout">
      <div className="glass-panel"><p className="negative">{error}</p></div>
    </div>
  );

  return (
    <div className="dashboard-layout">
      <header className="header" style={{ marginBottom: '1.5rem', borderBottom: 'none' }}>
        <h1>India VIX — Fear & Greed Index</h1>
        <p>Real-time volatility gauge with automated strategy signals</p>
      </header>

      {/* ─── Top Row: Gauge + Velocity Chart ────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '1.5rem', marginBottom: '1.5rem' }}>
        
        {/* Gauge */}
        <section className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <VixGauge value={vixValue} />
          <div style={{ marginTop: '1rem', display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: '1.5rem' }}>{vixValue.toFixed(2)}</span>
            {changePill(vixChange)}
          </div>
        </section>

        {/* Velocity Chart */}
        <section className="glass-panel" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>⚡ VIX Velocity</h3>
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              {['1M', '3M', '6M', '1Y'].map(tf => (
                <button key={tf} onClick={() => setTimeframe(tf)} style={{
                  padding: '0.3rem 0.7rem', borderRadius: '6px', border: 'none', cursor: 'pointer',
                  fontSize: '0.8rem', fontWeight: 600,
                  background: timeframe === tf ? 'var(--accent)' : 'rgba(255,255,255,0.06)',
                  color: timeframe === tf ? '#fff' : 'var(--text-secondary)',
                  transition: 'all 0.2s',
                }}>{tf}</button>
              ))}
            </div>
          </div>
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <defs>
                  <linearGradient id="vixGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={zone.color} stopOpacity={0.35} />
                    <stop offset="95%" stopColor={zone.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} axisLine={false} tickLine={false} domain={['auto', 'auto']} />
                <Tooltip
                  contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '8px', fontSize: '0.85rem' }}
                  labelStyle={{ color: 'var(--text-secondary)' }}
                  itemStyle={{ color: zone.color, fontWeight: 700 }}
                />
                <ReferenceLine y={20} stroke="rgba(234,179,8,0.3)" strokeDasharray="4 4" label={{ value: '20', fill: '#eab308', fontSize: 10, position: 'right' }} />
                <Area type="monotone" dataKey="vix" stroke={zone.color} fillOpacity={1} fill="url(#vixGrad)" strokeWidth={2} dot={false} name="India VIX" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      {/* ─── Market Context Cards ───────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
        {/* Nifty 50 */}
        <div className="glass-panel" style={{ padding: '1.2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>Nifty 50</span>
            {niftyQuote && changePill(niftyQuote.ohlc?.close ? ((niftyQuote.last_price - niftyQuote.ohlc.close) / niftyQuote.ohlc.close * 100) : 0)}
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{niftyQuote ? formatPrice(niftyQuote.last_price) : '-'}</div>
        </div>

        {/* Sensex */}
        <div className="glass-panel" style={{ padding: '1.2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>Sensex BSE</span>
            {sensexQuote && changePill(sensexQuote.ohlc?.close ? ((sensexQuote.last_price - sensexQuote.ohlc.close) / sensexQuote.ohlc.close * 100) : 0)}
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{sensexQuote ? formatPrice(sensexQuote.last_price) : '-'}</div>
        </div>

        {/* VIX Day Range */}
        <div className="glass-panel" style={{ padding: '1.2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>VIX Day Range</span>
            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: vixDayRange > 10 ? '#ef4444' : '#eab308' }}>{vixDayRange.toFixed(1)}% spread</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontSize: '1rem', color: '#10b981', fontWeight: 700 }}>{vixDayLow.toFixed(2)}</span>
            <div style={{ flex: 1, height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', position: 'relative' }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, height: '100%', borderRadius: '3px',
                width: `${Math.min(100, ((vixValue - vixDayLow) / (vixDayHigh - vixDayLow || 1)) * 100)}%`,
                background: 'linear-gradient(90deg, #10b981, #eab308, #ef4444)',
              }} />
            </div>
            <span style={{ fontSize: '1rem', color: '#ef4444', fontWeight: 700 }}>{vixDayHigh.toFixed(2)}</span>
          </div>
        </div>

        {/* VIX vs 20-Day Avg */}
        <div className="glass-panel" style={{ padding: '1.2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>VIX vs 20D Avg</span>
            {vixVsAvg !== null && (
              <span style={{
                fontSize: '0.8rem', fontWeight: 700,
                color: vixVsAvg > 0 ? '#ef4444' : '#10b981',
                background: vixVsAvg > 0 ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)',
                padding: '0.1rem 0.4rem', borderRadius: '4px'
              }}>{vixVsAvg > 0 ? '▲ ABOVE' : '▼ BELOW'}</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.6rem', fontWeight: 800 }}>{vixVsAvg !== null ? `${vixVsAvg > 0 ? '+' : ''}${vixVsAvg.toFixed(1)}%` : '-'}</span>
            {avg20 && <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>avg: {avg20.toFixed(2)}</span>}
          </div>
        </div>
      </div>

      {/* ─── Strategy Signal ────────────────────────────────── */}
      <section className="glass-panel" style={{ padding: '1.5rem', marginBottom: '1.5rem', borderLeft: `3px solid ${zone.color}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
          <span style={{ fontSize: '2rem' }}>{zone.emoji}</span>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.4rem' }}>
              <span style={{
                fontSize: '0.85rem', fontWeight: 800, color: zone.color, letterSpacing: '1px', textTransform: 'uppercase',
                background: zone.bg, padding: '0.2rem 0.6rem', borderRadius: '4px',
              }}>
                {zone.label}
              </span>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>VIX at {vixValue.toFixed(2)}</span>
            </div>
            <p style={{ margin: 0, fontSize: '0.95rem', lineHeight: '1.5', color: 'var(--text-primary)' }}>
              {zone.signal}
            </p>
          </div>
        </div>
      </section>

      {/* ─── Historical VIX Table ───────────────────────────── */}
      <section className="glass-panel" style={{ padding: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>📊 Daily Historical VIX</h3>
        </div>
        <div style={{ overflowX: 'auto', maxHeight: '450px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'right', fontSize: '0.85rem' }}>
            <thead style={{ position: 'sticky', top: 0, background: '#1a1a2e', zIndex: 5 }}>
              <tr>
                <th onClick={() => requestSort('date')} style={{ textAlign: 'left', cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                  Date{renderSortIndicator('date')}
                </th>
                <th onClick={() => requestSort('open')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                  Open{renderSortIndicator('open')}
                </th>
                <th onClick={() => requestSort('high')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                  High{renderSortIndicator('high')}
                </th>
                <th onClick={() => requestSort('low')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                  Low{renderSortIndicator('low')}
                </th>
                <th onClick={() => requestSort('close')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                  Close{renderSortIndicator('close')}
                </th>
                <th onClick={() => requestSort('delta')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                  VIX Delta{renderSortIndicator('delta')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedHistory.length > 0 ? sortedHistory.map((row, idx) => (
                <tr key={idx} style={{
                  borderBottom: idx < sortedHistory.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                  transition: 'background 0.15s',
                }}
                  onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                  onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={{ textAlign: 'left', padding: '0.5rem', fontWeight: 600 }}>
                    {new Date(row.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                  <td style={{ padding: '0.5rem' }}>{row.open.toFixed(2)}</td>
                  <td style={{ padding: '0.5rem', color: '#ef4444' }}>{row.high.toFixed(2)}</td>
                  <td style={{ padding: '0.5rem', color: '#10b981' }}>{row.low.toFixed(2)}</td>
                  <td style={{ padding: '0.5rem', fontWeight: 700 }}>{row.close.toFixed(2)}</td>
                  <td style={{ padding: '0.5rem' }}>
                    <span style={{
                      display: 'inline-block', padding: '0.15rem 0.5rem', borderRadius: '4px', fontWeight: 700,
                      fontSize: '0.8rem',
                      // VIX rising = bad for market (red), VIX falling = good (green)
                      color: row.delta > 0 ? '#ef4444' : '#10b981',
                      background: row.delta > 0 ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)',
                    }}>
                      {row.delta > 0 ? '+' : ''}{row.delta.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan="6" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>Loading VIX history...</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default VixIndex;
