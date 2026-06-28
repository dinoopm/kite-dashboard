import { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';
import { getVixZone } from '../components/vixZones';
import { VixGauge } from '../components/VixGauge';
import {
  ivRank, percentileRank, zScore, realizedVol, expectedMove, quantile,
  alignSeries, vixNiftyCorrelation, forwardReturnStudy, regimeReadout,
} from '../lib/vixAnalytics';

// ─── Main VIX Index Page ───────────────────────────────────────
function VixIndex() {
  const [vixQuote, setVixQuote] = useState(null);
  const [niftyQuote, setNiftyQuote] = useState(null);
  const [sensexQuote, setSensexQuote] = useState(null);
  const [history, setHistory] = useState([]);          // chart series (timeframe-driven)
  const [vixHist, setVixHist] = useState([]);          // ~4Y VIX closes for analytics
  const [niftyHist, setNiftyHist] = useState([]);      // ~4Y Nifty closes for analytics
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

  // Fetch VIX history for the chart (re-runs on timeframe change)
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
              return { date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, delta };
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

  // Fetch a deep (~4Y) window of VIX + Nifty closes for the analytics, independent
  // of the chart's timeframe selector. The forward-return study uses the full
  // depth (more samples = more robust base rates); the IV-rank / percentile /
  // z-score / range metrics slice the trailing ~1Y so they keep their standard
  // 252-day meaning.
  useEffect(() => {
    if (!vixQuote?.instrument_token || !niftyQuote?.instrument_token) return;
    const controller = new AbortController();
    (async () => {
      const fetchHist = async (token) => {
        const res = await fetchWithAbort(`/api/historical/${token}?tf=4Y`, { signal: controller.signal });
        const data = await res.json();
        const candles = data?.content?.[0]?.text ? JSON.parse(data.content[0].text) : [];
        return Array.isArray(candles) ? candles.map(c => ({ date: c.date, close: c.close })) : [];
      };
      try {
        const [v, n] = await Promise.all([
          fetchHist(vixQuote.instrument_token),
          fetchHist(niftyQuote.instrument_token),
        ]);
        setVixHist(v); setNiftyHist(n);
      } catch (err) { if (err.name !== 'AbortError') console.error('VIX analytics fetch:', err.message); }
    })();
    return () => controller.abort();
  }, [vixQuote, niftyQuote]);

  // ── Live readings ──
  const vixValue = vixQuote?.last_price || 0;
  const niftyValue = niftyQuote?.last_price || 0;
  const vixChange = vixQuote?.ohlc?.close ? ((vixValue - vixQuote.ohlc.close) / vixQuote.ohlc.close) * 100 : 0;
  const vixDayHigh = vixQuote?.ohlc?.high || 0;
  const vixDayLow = vixQuote?.ohlc?.low || 0;
  const vixDayRange = vixValue ? ((vixDayHigh - vixDayLow) / vixValue * 100) : 0;
  const zone = getVixZone(vixValue);

  // ── Analytics ──
  // Trailing ~1Y (252 sessions) for the standard rank/percentile/z-score/range
  // metrics; the full ~4Y series feeds the forward-return study + correlation.
  const vixCloses1Y = vixHist.map(c => c.close).slice(-252);
  const aligned = (vixHist.length && niftyHist.length) ? alignSeries(vixHist, niftyHist) : { dates: [], vix: [], nifty: [] };
  const hasAnalytics = vixCloses1Y.length > 30 && aligned.nifty.length > 30;
  const coverageYears = aligned.dates.length > 1
    ? (new Date(aligned.dates[aligned.dates.length - 1]) - new Date(aligned.dates[0])) / (365.25 * 86400000)
    : null;

  const ivPct = hasAnalytics ? percentileRank(vixCloses1Y, vixValue) : null;
  const ivr = hasAnalytics ? ivRank(vixCloses1Y, vixValue) : null;
  const vixZ = hasAnalytics ? zScore(vixCloses1Y, vixValue) : null;
  const rv20 = hasAnalytics ? realizedVol(aligned.nifty, 20) : null;
  const vrp = (rv20 != null) ? (vixValue - rv20) : null;
  const emDay = expectedMove(niftyValue, vixValue, 1);
  const emWeek = expectedMove(niftyValue, vixValue, 5);
  const corr20 = hasAnalytics ? vixNiftyCorrelation(aligned.vix, aligned.nifty, 20) : null;
  const study = hasAnalytics ? forwardReturnStudy(aligned.vix, aligned.nifty, vixValue, [5, 10, 20]) : null;
  const p25 = hasAnalytics ? quantile(vixCloses1Y, 0.25) : null;
  const p50 = hasAnalytics ? quantile(vixCloses1Y, 0.5) : null;
  const p75 = hasAnalytics ? quantile(vixCloses1Y, 0.75) : null;
  const yrLo = hasAnalytics ? Math.min(...vixCloses1Y) : null;
  const yrHi = hasAnalytics ? Math.max(...vixCloses1Y) : null;

  const ivColor = ivPct == null ? 'var(--text-primary)' : ivPct < 20 ? '#10b981' : ivPct > 80 ? '#ef4444' : '#eab308';
  // Treat a near-zero VRP as "in line" — don't tell the user to sell premium when there isn't any.
  const vrpState = vrp == null ? null : Math.abs(vrp) < 1 ? 'in' : vrp > 0 ? 'prem' : 'disc';
  const vrpColor = vrpState == null ? 'var(--text-primary)' : vrpState === 'prem' ? '#10b981' : vrpState === 'disc' ? '#f97316' : '#94a3b8';

  // Chart data + range markers
  const chartData = history.map(c => ({
    date: new Date(c.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
    vix: parseFloat(c.close.toFixed(2)),
    color: getVixZone(c.close).color,
  }));

  // Sorted table data
  const sortedHistory = [...history].sort((a, b) => {
    let vA = a[sortConfig.key], vB = b[sortConfig.key];
    if (sortConfig.key === 'date') { vA = new Date(vA); vB = new Date(vB); }
    if (vA < vB) return sortConfig.direction === 'asc' ? -1 : 1;
    if (vA > vB) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });
  const requestSort = (key) => setSortConfig(prev => ({ key, direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc' }));
  const renderSortIndicator = (key) => sortConfig.key === key ? (sortConfig.direction === 'asc' ? ' ↑' : ' ↓') : '';

  // Helpers
  const formatPrice = (p) => p ? p.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '-';
  const signed = (v, dp = 2, suf = '') => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(dp)}${suf}`;
  const changePill = (pct) => {
    const color = pct >= 0 ? '#10b981' : '#ef4444';
    const bg = pct >= 0 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
    return (
      <span style={{ fontSize: '0.8rem', fontWeight: 700, color, background: bg, padding: '0.15rem 0.5rem', borderRadius: '4px' }}>
        {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
      </span>
    );
  };

  // Dense blotter stat cell.
  const Stat = ({ label, value, color, sub }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '0 0.95rem', borderRight: '1px solid rgba(255,255,255,0.07)' }}>
      <span style={{ fontSize: '0.6rem', letterSpacing: '0.07em', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: '0.95rem', fontWeight: 700, color: color || 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {value}{sub && <span style={{ fontSize: '0.62rem', color: 'var(--text-secondary)', marginLeft: 4, fontWeight: 500 }}>{sub}</span>}
      </span>
    </div>
  );

  const tickPct = (v) => (yrLo == null || yrHi <= yrLo) ? 0 : ((v - yrLo) / (yrHi - yrLo)) * 100;

  if (loading) return <div className="loader"></div>;
  if (error) return (
    <div className="dashboard-layout">
      <div className="glass-panel"><p className="negative">{error}</p></div>
    </div>
  );

  return (
    <div className="dashboard-layout">
      <header className="header" style={{ marginBottom: '1.25rem', borderBottom: 'none' }}>
        <h1>India VIX — Volatility Cockpit</h1>
        <p>Where vol sits in its own distribution, what move it's pricing, and what's historically happened from here.</p>
      </header>

      {/* ─── Blotter strip ──────────────────────────────────── */}
      <section className="glass-panel" style={{ padding: '0.7rem 0.2rem', marginBottom: '1.25rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', rowGap: '0.6rem' }}>
        <Stat label="India VIX" value={vixValue.toFixed(2)} color={zone.color} sub={`${vixChange >= 0 ? '+' : ''}${vixChange.toFixed(2)}%`} />
        <Stat label="IV Rank" value={ivr != null ? Math.round(ivr) : '—'} color={ivColor} />
        <Stat label="%ile · 1Y" value={ivPct != null ? Math.round(ivPct) : '—'} color={ivColor} />
        <Stat label="Z-Score" value={vixZ != null ? `${vixZ > 0 ? '+' : ''}${vixZ.toFixed(2)}σ` : '—'} />
        <Stat label="1Y Range" value={yrLo != null ? `${yrLo.toFixed(1)}–${yrHi.toFixed(1)}` : '—'} />
        <Stat label="Nifty RV·20D" value={rv20 != null ? rv20.toFixed(1) : '—'} />
        <Stat label="VRP" value={signed(vrp, 1)} color={vrpColor} sub="impl−real" />
        <Stat label="Exp Move/D" value={emDay ? `±${emDay.pct.toFixed(2)}%` : '—'} />
        <Stat label="VIX·Nifty ρ" value={corr20 != null ? corr20.toFixed(2) : '—'} color={corr20 != null && corr20 > 0 ? '#ef4444' : 'var(--text-primary)'} sub="20D" />
      </section>

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

        {/* Velocity Chart + percentile bands + regime ribbon */}
        <section className="glass-panel" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>⚡ VIX Velocity{p50 != null && <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 500, marginLeft: '0.6rem' }}>1Y median {p50.toFixed(1)} · IQR {p25.toFixed(1)}–{p75.toFixed(1)}</span>}</h3>
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              {['1M', '3M', '6M', '1Y'].map(tf => (
                <button key={tf} onClick={() => setTimeframe(tf)} style={{
                  padding: '0.3rem 0.7rem', borderRadius: '6px', border: 'none', cursor: 'pointer',
                  fontSize: '0.8rem', fontWeight: 600,
                  background: timeframe === tf ? 'var(--accent)' : 'rgba(255,255,255,0.06)',
                  color: timeframe === tf ? '#fff' : 'var(--text-secondary)', transition: 'all 0.2s',
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
                {/* 1Y percentile context lines */}
                {p75 != null && <ReferenceLine y={p75} stroke="rgba(239,68,68,0.35)" strokeDasharray="3 3" label={{ value: `P75 ${p75.toFixed(1)}`, fill: '#ef4444', fontSize: 9, position: 'left' }} />}
                {p50 != null && <ReferenceLine y={p50} stroke="rgba(148,163,184,0.45)" strokeDasharray="3 3" label={{ value: `MED ${p50.toFixed(1)}`, fill: '#94a3b8', fontSize: 9, position: 'left' }} />}
                {p25 != null && <ReferenceLine y={p25} stroke="rgba(16,185,129,0.35)" strokeDasharray="3 3" label={{ value: `P25 ${p25.toFixed(1)}`, fill: '#10b981', fontSize: 9, position: 'left' }} />}
                <Area type="monotone" dataKey="vix" stroke={zone.color} fillOpacity={1} fill="url(#vixGrad)" strokeWidth={2} dot={false} name="India VIX" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {/* Regime ribbon — each day coloured by its VIX zone */}
          {chartData.length > 0 && (
            <div title="Volatility regime over the selected window" style={{ display: 'flex', height: '6px', borderRadius: '3px', overflow: 'hidden', marginTop: '0.5rem' }}>
              {chartData.map((d, i) => <div key={i} style={{ flex: 1, background: d.color }} />)}
            </div>
          )}
        </section>
      </div>

      {/* ─── Volatility analytics cards ─────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>

        {/* IV Rank / Percentile with position-in-range bar */}
        <div className="glass-panel" style={{ padding: '1.2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>IV Rank / Percentile</span>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: ivColor, background: `${ivColor}22`, padding: '0.1rem 0.45rem', borderRadius: '4px' }}>
              {ivPct == null ? '…' : ivPct < 20 ? 'VOL CHEAP' : ivPct > 80 ? 'VOL RICH' : 'MID-RANGE'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem' }}>
            <span style={{ fontSize: '1.8rem', fontWeight: 800, color: ivColor }}>{ivr != null ? Math.round(ivr) : '–'}</span>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>IVR · {ivPct != null ? `${Math.round(ivPct)}th %ile` : ''}</span>
          </div>
          {/* range bar */}
          <div style={{ position: 'relative', height: '8px', background: 'linear-gradient(90deg,#10b981,#eab308,#ef4444)', borderRadius: '4px', marginTop: '0.8rem', opacity: 0.85 }}>
            {[p25, p50, p75].map((p, i) => p != null && (
              <div key={i} style={{ position: 'absolute', left: `${tickPct(p)}%`, top: '-2px', width: '1px', height: '12px', background: 'rgba(255,255,255,0.5)' }} />
            ))}
            {hasAnalytics && (
              <div style={{ position: 'absolute', left: `${Math.min(100, Math.max(0, ivr))}%`, top: '-4px', transform: 'translateX(-50%)', width: '3px', height: '16px', background: '#fff', borderRadius: '2px', boxShadow: '0 0 6px rgba(255,255,255,0.7)' }} />
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '0.35rem' }}>
            <span>{yrLo != null ? yrLo.toFixed(1) : ''}</span><span>1Y range</span><span>{yrHi != null ? yrHi.toFixed(1) : ''}</span>
          </div>
        </div>

        {/* Expected move */}
        <div className="glass-panel" style={{ padding: '1.2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>Expected Move · Nifty</span>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>1σ implied</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.8rem', fontWeight: 800 }}>{emDay ? `±${emDay.pct.toFixed(2)}%` : '–'}</span>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>/ day{emDay ? ` · ±${Math.round(emDay.points)} pts` : ''}</span>
          </div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: '0.6rem' }}>
            This week: <strong style={{ color: 'var(--text-primary)' }}>{emWeek ? `±${emWeek.pct.toFixed(2)}%` : '–'}</strong>
            {emWeek && niftyValue ? <> → {Math.round(emWeek.lo).toLocaleString('en-IN')} – {Math.round(emWeek.hi).toLocaleString('en-IN')}</> : null}
          </div>
        </div>

        {/* Implied vs Realized (VRP) */}
        <div className="glass-panel" style={{ padding: '1.2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>Implied vs Realized</span>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: vrpColor, background: `${vrpColor}22`, padding: '0.1rem 0.45rem', borderRadius: '4px' }}>
              {vrpState == null ? '…' : vrpState === 'prem' ? 'PREMIUM' : vrpState === 'disc' ? 'DISCOUNT' : 'IN LINE'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.8rem', fontWeight: 800, color: vrpColor }}>{signed(vrp, 1)}</span>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>VRP (pts)</span>
          </div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: '0.6rem' }}>
            VIX <strong style={{ color: 'var(--text-primary)' }}>{vixValue.toFixed(1)}</strong> vs Nifty 20D realized <strong style={{ color: 'var(--text-primary)' }}>{rv20 != null ? rv20.toFixed(1) : '–'}</strong>
            <div style={{ marginTop: '0.2rem' }}>{vrpState == null ? '' : vrpState === 'prem' ? 'Sellers paid for risk — premium-selling favored.' : vrpState === 'disc' ? 'Options cheap vs. delivered move — buy optionality.' : 'Implied ≈ realized — no clear vol edge either way.'}</div>
          </div>
        </div>
      </div>

      {/* ─── Market Context Cards ───────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
        <div className="glass-panel" style={{ padding: '1.2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>Nifty 50</span>
            {niftyQuote && changePill(niftyQuote.ohlc?.close ? ((niftyQuote.last_price - niftyQuote.ohlc.close) / niftyQuote.ohlc.close * 100) : 0)}
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{niftyQuote ? formatPrice(niftyQuote.last_price) : '-'}</div>
        </div>

        <div className="glass-panel" style={{ padding: '1.2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>Sensex BSE</span>
            {sensexQuote && changePill(sensexQuote.ohlc?.close ? ((sensexQuote.last_price - sensexQuote.ohlc.close) / sensexQuote.ohlc.close * 100) : 0)}
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{sensexQuote ? formatPrice(sensexQuote.last_price) : '-'}</div>
        </div>

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
      </div>

      {/* ─── Regime + evidence ──────────────────────────────── */}
      <section className="glass-panel" style={{ padding: '1.5rem', marginBottom: '1.5rem', borderLeft: `3px solid ${zone.color}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
          <span style={{ fontSize: '2rem' }}>{zone.emoji}</span>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 800, color: zone.color, letterSpacing: '1px', textTransform: 'uppercase', background: zone.bg, padding: '0.2rem 0.6rem', borderRadius: '4px' }}>
                {zone.label}
              </span>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>VIX at {vixValue.toFixed(2)}</span>
            </div>
            <p style={{ margin: '0 0 0.4rem', fontSize: '0.95rem', lineHeight: '1.5', color: 'var(--text-primary)' }}>
              {hasAnalytics ? regimeReadout({ vix: vixValue, ivPct, ivr, vrp, z: vixZ }) : zone.signal}
            </p>
            <p style={{ margin: 0, fontSize: '0.82rem', lineHeight: '1.45', color: 'var(--text-secondary)' }}>{zone.signal}</p>

            {/* Evidence: forward Nifty returns from this VIX band */}
            {study && study.sampleDays > 5 && (
              <div style={{ marginTop: '1rem' }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                  📈 When India VIX has been in this band (<strong style={{ color: 'var(--text-primary)' }}>{study.bandLo.toFixed(1)}–{study.bandHi.toFixed(1)}</strong>, {study.sampleDays} sessions{coverageYears ? ` over ~${coverageYears.toFixed(1)} years` : ''}), Nifty's forward return:
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <thead>
                      <tr style={{ color: 'var(--text-secondary)' }}>
                        <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', fontWeight: 600 }}>Horizon</th>
                        <th style={{ padding: '0.35rem 0.5rem', fontWeight: 600 }}>n</th>
                        <th style={{ padding: '0.35rem 0.5rem', fontWeight: 600 }}>Avg</th>
                        <th style={{ padding: '0.35rem 0.5rem', fontWeight: 600 }}>Median</th>
                        <th style={{ padding: '0.35rem 0.5rem', fontWeight: 600 }}>Hit-rate</th>
                        <th style={{ padding: '0.35rem 0.5rem', fontWeight: 600 }}>Best</th>
                        <th style={{ padding: '0.35rem 0.5rem', fontWeight: 600 }}>Worst</th>
                      </tr>
                    </thead>
                    <tbody>
                      {study.horizons.map(h => (
                        <tr key={h.h} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                          <td style={{ textAlign: 'left', padding: '0.35rem 0.5rem', fontWeight: 600 }}>{h.h}d</td>
                          <td style={{ padding: '0.35rem 0.5rem', color: 'var(--text-secondary)' }}>{h.n}</td>
                          <td style={{ padding: '0.35rem 0.5rem', fontWeight: 700, color: h.mean == null ? 'var(--text-secondary)' : h.mean >= 0 ? '#10b981' : '#ef4444' }}>{signed(h.mean, 2, '%')}</td>
                          <td style={{ padding: '0.35rem 0.5rem', color: h.median == null ? 'var(--text-secondary)' : h.median >= 0 ? '#10b981' : '#ef4444' }}>{signed(h.median, 2, '%')}</td>
                          <td style={{ padding: '0.35rem 0.5rem' }}>{h.hitRate == null ? '—' : `${Math.round(h.hitRate)}%`}</td>
                          <td style={{ padding: '0.35rem 0.5rem', color: '#10b981' }}>{signed(h.best, 2, '%')}</td>
                          <td style={{ padding: '0.35rem 0.5rem', color: '#ef4444' }}>{signed(h.worst, 2, '%')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: '0.4rem', fontStyle: 'italic' }}>
                  Base rates from {coverageYears ? `~${coverageYears.toFixed(1)} years` : 'available history'} ({aligned.vix.length} sessions) — a regime-specific sample, not a forecast.
                </div>
              </div>
            )}
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
                <th onClick={() => requestSort('date')} style={{ textAlign: 'left', cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>Date{renderSortIndicator('date')}</th>
                <th onClick={() => requestSort('open')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>Open{renderSortIndicator('open')}</th>
                <th onClick={() => requestSort('high')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>High{renderSortIndicator('high')}</th>
                <th onClick={() => requestSort('low')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>Low{renderSortIndicator('low')}</th>
                <th onClick={() => requestSort('close')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>Close{renderSortIndicator('close')}</th>
                <th onClick={() => requestSort('delta')} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', padding: '0.5rem', color: 'var(--text-secondary)' }}>VIX Delta{renderSortIndicator('delta')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedHistory.length > 0 ? sortedHistory.map((row, idx) => (
                <tr key={idx} style={{ borderBottom: idx < sortedHistory.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', transition: 'background 0.15s' }}
                  onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                  onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                  <td style={{ textAlign: 'left', padding: '0.5rem', fontWeight: 600 }}>{new Date(row.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                  <td style={{ padding: '0.5rem' }}>{row.open.toFixed(2)}</td>
                  <td style={{ padding: '0.5rem', color: '#ef4444' }}>{row.high.toFixed(2)}</td>
                  <td style={{ padding: '0.5rem', color: '#10b981' }}>{row.low.toFixed(2)}</td>
                  <td style={{ padding: '0.5rem', fontWeight: 700 }}>{row.close.toFixed(2)}</td>
                  <td style={{ padding: '0.5rem' }}>
                    <span style={{ display: 'inline-block', padding: '0.15rem 0.5rem', borderRadius: '4px', fontWeight: 700, fontSize: '0.8rem',
                      color: row.delta > 0 ? '#ef4444' : '#10b981', background: row.delta > 0 ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)' }}>
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
