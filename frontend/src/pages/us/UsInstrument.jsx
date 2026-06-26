import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ComposedChart, Area, Line, LineChart, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine, Legend,
} from 'recharts';

// US ETF/equity detail: company name, snapshot header, price chart with moving-
// average overlays, an RSI panel, and a technical-indicator summary — fed by Alpaca.

const RANGES = ['1D', '5D', '1M', '3M', '6M', '1Y', '5Y'];

const fmtPrice = (v) => (v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtPct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const pctColor = (v) => (v == null ? 'var(--text-secondary)' : v >= 0 ? 'var(--success)' : 'var(--danger)');

// ─── Indicator math ─────────────────────────────────────────────
const sma = (vals, p) => {
  const out = Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= p) sum -= vals[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
};
const emaFull = (vals, p) => {
  if (vals.length === 0) return [];
  const k = 2 / (p + 1);
  const out = [vals[0]];
  for (let i = 1; i < vals.length; i++) out.push(vals[i] * k + out[i - 1] * (1 - k));
  return out;
};
const rsiSeries = (vals, p = 14) => {
  const out = Array(vals.length).fill(null);
  if (vals.length < p + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = vals[i] - vals[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p;
  out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
};
const atr14 = (bars, p = 14) => {
  if (bars.length < p + 1) return null;
  const tr = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
  let a = tr.slice(1, p + 1).reduce((s, v) => s + v, 0) / p;
  for (let i = p + 1; i < bars.length; i++) a = (a * (p - 1) + tr[i]) / p;
  return a;
};
const lastNonNull = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };

function MaLegend() {
  const item = (color, label) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
      <span style={{ width: '14px', height: '2px', background: color, display: 'inline-block' }} />{label}
    </span>
  );
  return (
    <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
      {item('#22c55e', 'Close')}{item('#f59e0b', 'SMA 20')}{item('#a78bfa', 'SMA 50')}
    </div>
  );
}

// One indicator chip: label + value + optional colored sublabel.
function Chip({ label, value, sub, subColor }) {
  return (
    <div className="glass-panel" style={{ padding: '0.75rem 1rem', minWidth: '120px', flex: '1' }}>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 700, marginTop: '0.2rem' }}>{value}</div>
      {sub != null && <div style={{ fontSize: '0.75rem', marginTop: '0.1rem', color: subColor || 'var(--text-secondary)', fontWeight: 600 }}>{sub}</div>}
    </div>
  );
}

export default function UsInstrument() {
  const { symbol } = useParams();
  const sym = (symbol || '').toUpperCase();
  const [snap, setSnap] = useState(null);
  const [bars, setBars] = useState([]);
  const [dailyBars, setDailyBars] = useState([]); // 1Y daily, for stable indicator chips
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

  // A fixed 1Y daily series so the indicator chips don't change with the chart range.
  const loadDaily = useCallback(async () => {
    try {
      const res = await fetch(`/api/us/bars/${sym}?range=1Y`);
      const json = await res.json();
      if (res.ok) setDailyBars(json.bars || []);
    } catch { /* non-fatal */ }
  }, [sym]);

  useEffect(() => { loadSnap(); }, [loadSnap]);
  useEffect(() => { loadBars(); }, [loadBars]);
  useEffect(() => { loadDaily(); }, [loadDaily]);

  const q = snap?.quote || {};
  const companyName = snap?.name || snap?.meta?.label || sym;
  const intraday = range === '1D' || range === '5D';

  // Chart series with MA overlays + RSI computed on the visible bars.
  const chartData = useMemo(() => {
    const closes = bars.map(b => b.close);
    const s20 = sma(closes, 20), s50 = sma(closes, 50), rsi = rsiSeries(closes, 14);
    return bars.map((b, i) => ({ ...b, sma20: s20[i], sma50: s50[i], rsi: rsi[i] }));
  }, [bars]);
  const showMa = !intraday && bars.length >= 20;

  // Stable indicator summary from the 1Y daily series.
  const ind = useMemo(() => {
    const closes = dailyBars.map(b => b.close);
    if (closes.length < 15) return null;
    const price = closes[closes.length - 1];
    const ema12 = emaFull(closes, 12), ema26 = emaFull(closes, 26);
    const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
    const signal = emaFull(macdLine, 9);
    const macd = macdLine[macdLine.length - 1];
    const sig = signal[signal.length - 1];
    const window = closes.slice(-252);
    return {
      price,
      rsi: lastNonNull(rsiSeries(closes, 14)),
      sma20: lastNonNull(sma(closes, 20)),
      sma50: lastNonNull(sma(closes, 50)),
      sma200: lastNonNull(sma(closes, 200)),
      atr: atr14(dailyBars, 14),
      macd, signal: sig, hist: macd - sig,
      high52: Math.max(...window),
      low52: Math.min(...window),
    };
  }, [dailyBars]);

  const fmtAxis = (d) => {
    const dt = new Date(d);
    return intraday
      ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const up = (q.changePct ?? 0) >= 0;
  const chartColor = up ? '#22c55e' : '#ef4444';

  const maPos = (maVal) => {
    if (ind == null || maVal == null) return { sub: '—', color: 'var(--text-secondary)' };
    const above = ind.price >= maVal;
    return { sub: `${above ? '▲ above' : '▼ below'} · ${fmtPrice(maVal)}`, color: above ? 'var(--success)' : 'var(--danger)' };
  };
  const rsiState = (r) => r == null ? { sub: '', color: '' }
    : r >= 70 ? { sub: 'Overbought', color: 'var(--danger)' }
    : r <= 30 ? { sub: 'Oversold', color: 'var(--success)' }
    : { sub: 'Neutral', color: 'var(--text-secondary)' };

  return (
    <div style={{ padding: '0.5rem 0' }}>
      <Link to="/us" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: '0.85rem' }}>← US Markets</Link>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', margin: '0.75rem 0 1.25rem', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{companyName}</h2>
        <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{sym}</span>
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

      {/* Technical indicator chips (stable 1Y daily basis) */}
      {ind && (
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
          <Chip label="RSI (14)" value={ind.rsi != null ? ind.rsi.toFixed(1) : '—'} sub={rsiState(ind.rsi).sub} subColor={rsiState(ind.rsi).color} />
          <Chip label="SMA 20" value={fmtPrice(ind.sma20)} sub={maPos(ind.sma20).sub} subColor={maPos(ind.sma20).color} />
          <Chip label="SMA 50" value={fmtPrice(ind.sma50)} sub={maPos(ind.sma50).sub} subColor={maPos(ind.sma50).color} />
          <Chip label="SMA 200" value={fmtPrice(ind.sma200)} sub={maPos(ind.sma200).sub} subColor={maPos(ind.sma200).color} />
          <Chip label="MACD" value={ind.macd != null ? ind.macd.toFixed(2) : '—'} sub={ind.hist != null ? `hist ${ind.hist >= 0 ? '+' : ''}${ind.hist.toFixed(2)}` : ''} subColor={ind.hist >= 0 ? 'var(--success)' : 'var(--danger)'} />
          <Chip label="ATR (14)" value={ind.atr != null ? fmtPrice(ind.atr) : '—'} />
          <Chip label="52W High" value={fmtPrice(ind.high52)} sub={ind.high52 ? `${(((ind.price - ind.high52) / ind.high52) * 100).toFixed(1)}% away` : ''} />
          <Chip label="52W Low" value={fmtPrice(ind.low52)} sub={ind.low52 ? `+${(((ind.price - ind.low52) / ind.low52) * 100).toFixed(1)}% above` : ''} subColor="var(--success)" />
        </div>
      )}

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

      <div className="glass-panel" style={{ padding: '1rem' }}>
        {loading ? (
          <div className="loader" />
        ) : error ? (
          <div style={{ color: 'var(--danger)', padding: '1rem' }}>Failed to load chart: {error}</div>
        ) : bars.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', padding: '1rem' }}>No data for this range.</div>
        ) : (
          <>
            {showMa && <MaLegend />}
            <div style={{ height: '380px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
                    formatter={(v, name) => [fmtPrice(v), name === 'close' ? 'Close' : name.toUpperCase()]}
                  />
                  <Area type="monotone" dataKey="close" stroke={chartColor} strokeWidth={2} fill="url(#usFill)" isAnimationActive={false} />
                  {showMa && <Line type="monotone" dataKey="sma20" stroke="#f59e0b" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />}
                  {showMa && <Line type="monotone" dataKey="sma50" stroke="#a78bfa" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* RSI sub-panel */}
            {!intraday && bars.length >= 15 && (
              <div style={{ height: '110px', marginTop: '0.5rem' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>RSI (14)</div>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={fmtAxis} tick={{ fill: 'var(--text-secondary)', fontSize: 10 }} minTickGap={40} />
                    <YAxis domain={[0, 100]} ticks={[30, 50, 70]} tick={{ fill: 'var(--text-secondary)', fontSize: 10 }} width={55} />
                    <ReferenceLine y={70} stroke="var(--danger)" strokeDasharray="4 4" />
                    <ReferenceLine y={30} stroke="var(--success)" strokeDasharray="4 4" />
                    <Tooltip
                      contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '8px' }}
                      labelFormatter={(d) => new Date(d).toLocaleDateString('en-US')}
                      formatter={(v) => [v == null ? '—' : v.toFixed(1), 'RSI']}
                    />
                    <Line type="monotone" dataKey="rsi" stroke="#38bdf8" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
