import { useState, useEffect, useRef, useMemo } from 'react';
import { createChart } from 'lightweight-charts';
import { fetchWithAbort } from '../hooks/useFetchWithAbort';
import { generateSignals } from '../lib/signalEngine';

// ─── MA-crossover + RSI signal chart (TradingView Lightweight Charts) ─────────
// Candlestick price with Fast/Slow SMA overlays and algorithmic Buy/Sell markers.
// The math lives in ../lib/signalEngine; this file is the rendering layer only.

const BG = '#131722';        // institutional charcoal/navy
const GRID = '#1e2230';
const FAST_COLOR = '#38bdf8'; // bright blue
const SLOW_COLOR = '#f59e0b'; // orange
const BUY_COLOR = '#22c55e';
const SELL_COLOR = '#ef4444';

const barTime = (b) => Math.floor(new Date(b.dateObj || b.date).getTime() / 1000);

// View = how much recent history to ZOOM to. Full 5Y is loaded up front so the
// Slow SMA stays warm even on a 1-month view; these only pan/zoom the time axis.
const VIEW_DAYS = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '3Y': 1095, '5Y': null };

function SignalChart({ token, symbol }) {
  const [view, setView] = useState('1Y');
  const [bars, setBars] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Reactive controls
  const [fastPeriod, setFastPeriod] = useState(10);
  const [slowPeriod, setSlowPeriod] = useState(50);
  const [strict, setStrict] = useState(false);

  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleRef = useRef(null);
  const fastRef = useRef(null);
  const slowRef = useRef(null);
  const tooltipRef = useRef(null);
  const signalByTimeRef = useRef(new Map()); // time -> signal, read by the crosshair handler

  // Fetch a deep OHLCV history ONCE (5Y) so the moving averages are warm at any
  // zoom level. The view buttons only change the visible range, not the data.
  useEffect(() => {
    if (!token || token === '0') { setLoading(false); setError('Live token required for the candlestick chart.'); return; }
    const controller = new AbortController();
    setLoading(true); setError(null);
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/historical/${token}?tf=5Y`, { signal: controller.signal });
        const json = await res.json();
        if (json?.content?.[0]?.text) {
          const parsed = JSON.parse(json.content[0].text);
          if (Array.isArray(parsed)) {
            // Ascending, unique-per-day; lightweight-charts requires sorted times.
            const clean = parsed
              .filter(c => c.open != null && c.close != null)
              .map(c => ({ dateObj: new Date(c.date), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
            setBars(clean);
          } else setError('Unexpected data format.');
        } else setError(json?.error || 'No data.');
      } catch (e) {
        if (e.name !== 'AbortError') setError('Failed to load price data.');
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [token]);

  // Recompute the engine output whenever bars or the control params change.
  const engine = useMemo(
    () => (bars.length ? generateSignals(bars, fastPeriod, slowPeriod) : { fast: [], slow: [], signals: [] }),
    [bars, fastPeriod, slowPeriod]
  );

  // Only the signals inside the zoomed window. The chart loads 5Y so the SMAs
  // stay warm, but markers (and the counts) must be scoped to what's on screen —
  // otherwise old low-price signals from years ago render clamped at the bottom
  // edge and the tally won't match the view.
  const visibleSignals = useMemo(() => {
    if (bars.length === 0) return [];
    const days = VIEW_DAYS[view];
    if (!days) return engine.signals;
    const fromT = barTime(bars[bars.length - 1]) - days * 86400;
    return engine.signals.filter(s => barTime(s.bar) >= fromT);
  }, [engine, view, bars]);

  // Create the chart once per bars set (timeframe change). Sets candle data,
  // resize observer, and the crosshair tooltip handler.
  useEffect(() => {
    if (!containerRef.current || bars.length === 0) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: BG }, textColor: '#9aa4b8', fontSize: 11 },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      crosshair: { mode: 0 },
      // Leave head-room top & bottom so aboveBar / belowBar markers (the S/B
      // arrows) always have space to render and never clip at the chart edge.
      rightPriceScale: { borderColor: GRID, scaleMargins: { top: 0.12, bottom: 0.18 } },
      timeScale: { borderColor: GRID, timeVisible: false, rightOffset: 6 },
    });
    const candle = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });
    candle.setData(bars.map(b => ({ time: barTime(b), open: b.open, high: b.high, low: b.low, close: b.close })));

    const fast = chart.addLineSeries({ color: FAST_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const slow = chart.addLineSeries({ color: SLOW_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

    chart.timeScale().fitContent();

    // Crosshair tooltip — show the signal explanation when hovering its bar.
    chart.subscribeCrosshairMove((param) => {
      const tip = tooltipRef.current;
      if (!tip) return;
      const sig = param.time != null ? signalByTimeRef.current.get(param.time) : null;
      if (!sig || !param.point) { tip.style.display = 'none'; return; }
      const verb = sig.type === 'buy' ? 'Buy' : 'Sell';
      const dir = sig.type === 'buy' ? 'crossed above' : 'crossed below';
      tip.innerHTML = `<strong style="color:${sig.type === 'buy' ? BUY_COLOR : SELL_COLOR}">${verb} Signal Triggered</strong><br/>`
        + `Fast MA (${sig.fastPeriod}) ${dir} Slow MA (${sig.slowPeriod})<br/>`
        + `RSI at ${sig.rsi.toFixed(1)}`;
      tip.style.display = 'block';
      const cw = containerRef.current.clientWidth;
      const left = Math.min(Math.max(param.point.x + 14, 8), cw - 190);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(param.point.y - 10, 8)}px`;
    });

    chartRef.current = chart;
    candleRef.current = candle;
    fastRef.current = fast;
    slowRef.current = slow;

    return () => { chart.remove(); chartRef.current = null; };
  }, [bars]);

  // Push the SMA overlay lines whenever the engine recomputes (e.g. slider drag).
  useEffect(() => {
    if (!fastRef.current || bars.length === 0) return;
    const toLine = (arr) => bars.map((b, i) => (arr[i] == null ? null : { time: barTime(b), value: arr[i] })).filter(Boolean);
    fastRef.current.setData(toLine(engine.fast));
    slowRef.current.setData(toLine(engine.slow));
  }, [engine, bars]);

  // Push the Buy/Sell markers (scoped to the visible window). Hot path on slider
  // drag and view change — only setMarkers, no chart rebuild.
  useEffect(() => {
    if (!candleRef.current || bars.length === 0) return;
    const map = new Map();
    const markers = visibleSignals.map((s) => {
      const time = barTime(s.bar);
      map.set(time, s);
      const buy = s.type === 'buy';
      return {
        time,
        position: buy ? 'belowBar' : 'aboveBar',
        color: buy ? BUY_COLOR : SELL_COLOR,
        shape: buy ? 'arrowUp' : 'arrowDown',
        text: strict ? (buy ? 'Long' : 'Short') : (buy ? 'B' : 'S'),
      };
    });
    signalByTimeRef.current = map;
    candleRef.current.setMarkers(markers);
  }, [visibleSignals, strict, bars]);

  // Zoom the time axis to the chosen view (runs after chart creation since both
  // depend on `bars`, and on its own when the view button changes).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || bars.length === 0) return;
    const ts = chart.timeScale();
    const days = VIEW_DAYS[view];
    if (!days) { ts.fitContent(); return; }
    const last = barTime(bars[bars.length - 1]);
    const from = Math.max(barTime(bars[0]), last - days * 86400);
    ts.setVisibleRange({ from, to: last });
  }, [view, bars]);

  const buyCount = visibleSignals.filter(s => s.type === 'buy').length;
  const sellCount = visibleSignals.filter(s => s.type === 'sell').length;
  const sliderStyle = { accentColor: FAST_COLOR, cursor: 'pointer', width: '150px' };
  const capStyle = { fontSize: '0.72rem', color: 'var(--text-secondary)' };

  return (
    <section className="glass-panel" style={{ marginTop: '1rem', padding: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <h2 style={{ margin: 0 }}>Signal Engine</h2>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            MA crossover + RSI momentum · {symbol}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {['1M', '3M', '6M', '1Y', '3Y', '5Y'].map(t => (
            <button key={t} onClick={() => setView(t)} title="Zoom the view (5Y of history is always loaded so the SMAs stay accurate)" style={{
              padding: '0.3rem 0.7rem', borderRadius: '4px', fontSize: '0.75rem', cursor: 'pointer',
              border: `1px solid ${view === t ? 'var(--accent)' : 'var(--border)'}`,
              background: view === t ? 'rgba(56,189,248,0.12)' : 'transparent',
              color: view === t ? 'var(--accent)' : 'var(--text-secondary)', fontWeight: view === t ? 700 : 400,
            }}>{t}</button>
          ))}
        </div>
      </div>

      {/* Control panel */}
      <div className="glass-panel" style={{ display: 'flex', gap: '1.75rem', alignItems: 'center', flexWrap: 'wrap', padding: '0.85rem 1.1rem', marginBottom: '0.75rem' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={capStyle}><span style={{ color: FAST_COLOR }}>━</span> Fast SMA: <strong style={{ color: 'var(--accent)' }}>{fastPeriod}</strong></span>
          <input type="range" min="5" max="50" step="1" value={fastPeriod} onChange={e => setFastPeriod(Math.min(+e.target.value, slowPeriod - 1))} style={sliderStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={capStyle}><span style={{ color: SLOW_COLOR }}>━</span> Slow SMA: <strong style={{ color: 'var(--accent)' }}>{slowPeriod}</strong></span>
          <input type="range" min="20" max="200" step="1" value={slowPeriod} onChange={e => setSlowPeriod(Math.max(+e.target.value, fastPeriod + 1))} style={{ ...sliderStyle, accentColor: SLOW_COLOR }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={strict} onChange={e => setStrict(e.target.checked)} style={{ accentColor: FAST_COLOR, cursor: 'pointer', width: '15px', height: '15px' }} />
          Strict Compliance Mode <span style={{ opacity: 0.7 }}>(B/S → Long/Short)</span>
        </label>
        <span style={{ marginLeft: 'auto', fontSize: '0.78rem', fontWeight: 700, display: 'flex', gap: '0.75rem' }}>
          <span style={{ color: BUY_COLOR }}>▲ {buyCount} buy</span>
          <span style={{ color: SELL_COLOR }}>▼ {sellCount} sell</span>
        </span>
      </div>

      {/* Chart */}
      <div style={{ position: 'relative', height: '460px' }}>
        {loading ? (
          <div className="loader" style={{ position: 'absolute', top: '50%', left: '50%' }}></div>
        ) : error ? (
          <p className="negative" style={{ padding: '2rem', textAlign: 'center' }}>{error}</p>
        ) : (
          <>
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
            <div
              ref={tooltipRef}
              style={{
                display: 'none', position: 'absolute', zIndex: 5, pointerEvents: 'none',
                background: 'rgba(15,23,42,0.96)', border: '1px solid var(--border)', borderRadius: '6px',
                padding: '0.5rem 0.7rem', fontSize: '0.72rem', color: '#cbd5e1', lineHeight: 1.5,
                width: '180px', boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
              }}
            />
          </>
        )}
      </div>
      <div style={{ marginTop: '0.6rem', fontSize: '0.72rem', color: 'var(--text-secondary)', display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
        <span><span style={{ color: BUY_COLOR }}>▲ B</span> = Buy (golden cross, RSI &gt; 50)</span>
        <span><span style={{ color: SELL_COLOR }}>▼ S</span> = Sell (death cross, RSI &lt; 50)</span>
        <span><span style={{ color: FAST_COLOR }}>━</span> Fast SMA · <span style={{ color: SLOW_COLOR }}>━</span> Slow SMA</span>
        <span style={{ fontStyle: 'italic', opacity: 0.8 }}>Hover a marker for the trigger detail</span>
      </div>
    </section>
  );
}

export default SignalChart;
