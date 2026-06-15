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
const BB_COLOR = '#a78bfa';   // violet — distinct from the SMA blue/orange
const DEADCAT_COLOR = '#fbbf24'; // amber — flagged/ignored buy
const SQUEEZE_COLOR = '#ec4899'; // magenta — BB-width squeeze highlight
const BB_PERIOD = 20;
const BB_MULT = 2;
const SQUEEZE_LOOKBACK = 30;     // "lowest in the last 30 days" window
const SQUEEZE_TOL = 1.05;        // within 5% of the 30-day low counts as squeezed

// Bollinger Bands: SMA(period) ± mult × population std-dev, over `closes`.
// Returns arrays aligned to `closes` (null during the warmup window).
function bollinger(closes, period = BB_PERIOD, mult = BB_MULT) {
  const upper = new Array(closes.length).fill(null);
  const middle = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const m = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    middle[i] = m; upper[i] = m + mult * sd; lower[i] = m - mult * sd;
  }
  return { upper, middle, lower };
}

const barTimeStr = (b) => {
  const d = b.dateObj || new Date(b.date);
  return `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
};

const barTime = (b) => {
  const d = b.dateObj || new Date(b.date);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
  };
};

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
  const [showBB, setShowBB] = useState(false);

  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleRef = useRef(null);
  const fastRef = useRef(null);
  const slowRef = useRef(null);
  const bbUpperRef = useRef(null);
  const bbMiddleRef = useRef(null);
  const bbLowerRef = useRef(null);
  const bbUpperSqRef = useRef(null);
  const bbLowerSqRef = useRef(null);
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
            // lightweight-charts setData() throws on out-of-order or duplicate
            // timestamps — which silently leaves an empty chart with no axis. So
            // drop unparseable dates, sort ascending, and collapse same-day dupes.
            const mapped = parsed
              .filter(c => c.open != null && c.close != null)
              .map(c => ({ dateObj: new Date(c.date), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
              .filter(b => !Number.isNaN(b.dateObj.getTime()))
              .sort((a, b) => a.dateObj - b.dateObj);
            const clean = [];
            for (const b of mapped) {
              const prev = clean[clean.length - 1];
              if (prev && barTimeStr(prev) === barTimeStr(b)) {
                clean[clean.length - 1] = b; // same day — keep the later candle
              } else clean.push(b);
            }
            if (clean.length === 0) setError('No price data for this instrument.');
            else setBars(clean);
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

  // Bollinger Bands recompute only when the price series changes (fixed 20, 2).
  const bb = useMemo(
    () => (bars.length ? bollinger(bars.map(b => b.close)) : { upper: [], middle: [], lower: [] }),
    [bars]
  );

  // Bollinger Bandwidth = (Upper − Lower) ÷ Middle × 100. A "squeeze" is when
  // bandwidth sits at (or within 5% of) its lowest level over the last 30 bars —
  // statistically a precursor to a volatility breakout. `mask[i]` flags squeezed
  // bars so the chart can recolor those band segments.
  const squeeze = useMemo(() => {
    const n = bars.length;
    const bbw = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (bb.middle[i] != null && bb.middle[i] !== 0) bbw[i] = ((bb.upper[i] - bb.lower[i]) / bb.middle[i]) * 100;
    }
    const mask = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      if (bbw[i] == null) continue;
      let mn = Infinity;
      for (let j = Math.max(0, i - SQUEEZE_LOOKBACK + 1); j <= i; j++) if (bbw[j] != null) mn = Math.min(mn, bbw[j]);
      if (mn !== Infinity && bbw[i] <= mn * SQUEEZE_TOL) mask[i] = true;
    }
    let current = null, isSqueezeNow = false;
    for (let i = n - 1; i >= 0; i--) { if (bbw[i] != null) { current = bbw[i]; isSqueezeNow = mask[i]; break; } }
    return { bbw, mask, current, isSqueezeNow };
  }, [bb, bars]);

  // Only the signals inside the zoomed window. The chart loads 5Y so the SMAs
  // stay warm, but markers (and the counts) must be scoped to what's on screen —
  // otherwise old low-price signals from years ago render clamped at the bottom
  // edge and the tally won't match the view.
  const visibleSignals = useMemo(() => {
    if (bars.length === 0) return [];
    const days = VIEW_DAYS[view];
    if (!days) return engine.signals;
    const lastTime = (bars[bars.length - 1].dateObj || new Date(bars[bars.length - 1].date)).getTime();
    const fromT = lastTime - days * 86400000;
    return engine.signals.filter(s => (s.bar.dateObj || new Date(s.bar.date)).getTime() >= fromT);
  }, [engine, view, bars]);

  // Create the chart once per bars set (timeframe change). Sets candle data,
  // resize observer, and the crosshair tooltip handler.
  useEffect(() => {
    if (!containerRef.current || bars.length === 0) return;

    const el = containerRef.current;
    const chart = createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight,
      layout: { background: { color: BG }, textColor: '#c3cce0', fontSize: 12 },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      crosshair: { mode: 0 },
      // Leave head-room top & bottom so aboveBar / belowBar markers (the S/B
      // arrows) always have space to render and never clip at the chart edge.
      rightPriceScale: { borderColor: GRID, scaleMargins: { top: 0.12, bottom: 0.18 } },
      timeScale: { borderColor: GRID, rightOffset: 6 },
    });
    const candle = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });
    // setData throws on bad time ordering — surface a clear error rather than
    // leaving a silent empty chart (no candles, no x-axis).
    try {
      candle.setData(bars.map(b => ({ time: barTime(b), open: b.open, high: b.high, low: b.low, close: b.close })));
    } catch {
      chart.remove();
      setError('Could not render price data for this instrument.');
      return;
    }

    // Bollinger band lines (added first so the SMAs + markers draw on top).
    // Middle band is the SMA(20) basis — dashed to distinguish it from the
    // crossover SMAs. Data is pushed (or cleared) by the toggle effect below.
    const bandOpts = { color: BB_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    const bbUpper = chart.addLineSeries(bandOpts);
    const bbLower = chart.addLineSeries(bandOpts);
    const bbMiddle = chart.addLineSeries({ ...bandOpts, lineStyle: 2 /* dashed */, color: 'rgba(167,139,250,0.6)' });
    // Squeeze overlay: same band coordinates, drawn thicker in magenta but only
    // on bars where bandwidth is at its 30-day low — so the band "lights up"
    // exactly where volatility is compressed.
    const sqOpts = { color: SQUEEZE_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    const bbUpperSq = chart.addLineSeries(sqOpts);
    const bbLowerSq = chart.addLineSeries(sqOpts);

    const fast = chart.addLineSeries({ color: FAST_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const slow = chart.addLineSeries({ color: SLOW_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

    chart.timeScale().fitContent();

    // Crosshair tooltip — show the signal explanation when hovering its bar.
    chart.subscribeCrosshairMove((param) => {
      const tip = tooltipRef.current;
      if (!tip) return;
      const sig = param.time != null ? signalByTimeRef.current.get(param.time) : null;
      if (!sig || !param.point) { tip.style.display = 'none'; return; }
      if (sig.type === 'buy' && sig.deadCat) {
        tip.innerHTML = `<strong style="color:${DEADCAT_COLOR}">Dead Cat Bounce — buy ignored</strong><br/>`
          + `Golden cross fired below the ${BB_PERIOD}-bar middle band (₹${sig.mid.toFixed(1)}) after a sharp drop.<br/>`
          + `Likely a failed bounce in a downtrend.`;
        tip.style.display = 'block';
        const cwd = containerRef.current.clientWidth;
        tip.style.left = `${Math.min(Math.max(param.point.x + 14, 8), cwd - 190)}px`;
        tip.style.top = `${Math.max(param.point.y - 10, 8)}px`;
        return;
      }
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
    bbUpperRef.current = bbUpper;
    bbMiddleRef.current = bbMiddle;
    bbLowerRef.current = bbLower;
    bbUpperSqRef.current = bbUpperSq;
    bbLowerSqRef.current = bbLowerSq;

    // Keep the chart sized to its container (explicit, so the time axis always
    // gets its full height and the date labels aren't clipped at the bottom).
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
    });
    ro.observe(el);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [bars]);

  // Push the SMA overlay lines whenever the engine recomputes (e.g. slider drag).
  useEffect(() => {
    if (!fastRef.current || bars.length === 0) return;
    const toLine = (arr) => bars.map((b, i) => (arr[i] == null ? null : { time: barTime(b), value: arr[i] })).filter(Boolean);
    fastRef.current.setData(toLine(engine.fast));
    slowRef.current.setData(toLine(engine.slow));
  }, [engine, bars]);

  // Push (or clear) the Bollinger band lines on toggle / recompute.
  useEffect(() => {
    if (!bbUpperRef.current || bars.length === 0) return;
    const toLine = (arr) => bars.map((b, i) => (arr[i] == null ? null : { time: barTime(b), value: arr[i] })).filter(Boolean);
    // Gapped: a value only on squeezed bars, whitespace ({time}) elsewhere so the
    // magenta overlay draws disconnected segments exactly over the squeeze runs.
    const toGapped = (arr) => bars.map((b, i) => (squeeze.mask[i] && arr[i] != null ? { time: barTime(b), value: arr[i] } : { time: barTime(b) }));
    if (showBB) {
      bbUpperRef.current.setData(toLine(bb.upper));
      bbMiddleRef.current.setData(toLine(bb.middle));
      bbLowerRef.current.setData(toLine(bb.lower));
      bbUpperSqRef.current.setData(toGapped(bb.upper));
      bbLowerSqRef.current.setData(toGapped(bb.lower));
    } else {
      bbUpperRef.current.setData([]);
      bbMiddleRef.current.setData([]);
      bbLowerRef.current.setData([]);
      bbUpperSqRef.current.setData([]);
      bbLowerSqRef.current.setData([]);
    }
  }, [bb, squeeze, showBB, bars]);

  // Push the Buy/Sell markers (scoped to the visible window). Hot path on slider
  // drag and view change — only setMarkers, no chart rebuild.
  useEffect(() => {
    if (!candleRef.current || bars.length === 0) return;
    const map = new Map();
    const markers = visibleSignals.map((s) => {
      const time = barTime(s.bar);
      map.set(time, s);
      // Dead-cat-bounce buys are flagged, not acted on: amber circle below the
      // bar instead of a green buy arrow.
      if (s.type === 'buy' && s.deadCat) {
        return { time, position: 'belowBar', color: DEADCAT_COLOR, shape: 'circle', text: 'DC' };
      }
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
    
    const lastObj = bars[bars.length - 1].dateObj || new Date(bars[bars.length - 1].date);
    const targetTime = lastObj.getTime() - days * 86400000;
    
    // Find the closest valid bar >= targetTime
    let fromBar = bars[0];
    for (let i = 0; i < bars.length; i++) {
      if ((bars[i].dateObj || new Date(bars[i].date)).getTime() >= targetTime) {
        fromBar = bars[i];
        break;
      }
    }
    
    const to = barTime(bars[bars.length - 1]);
    const from = barTime(fromBar);
    
    try {
      ts.setVisibleRange({ from, to });
    } catch (e) {
      ts.fitContent(); // Fallback if setVisibleRange fails (e.g. invalid TimeRange)
    }
  }, [view, bars]);

  // Dead-cat buys are excluded from the actionable buy tally and counted apart.
  const buyCount = visibleSignals.filter(s => s.type === 'buy' && !s.deadCat).length;
  const sellCount = visibleSignals.filter(s => s.type === 'sell').length;
  const deadCatCount = visibleSignals.filter(s => s.type === 'buy' && s.deadCat).length;
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
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={showBB} onChange={e => setShowBB(e.target.checked)} style={{ accentColor: BB_COLOR, cursor: 'pointer', width: '15px', height: '15px' }} />
          <span style={{ color: BB_COLOR }}>━</span> Bollinger Bands <span style={{ opacity: 0.7 }}>({BB_PERIOD}, {BB_MULT})</span>
        </label>
        {showBB && squeeze.current != null && (
          <span
            title={`Bollinger Bandwidth = (Upper − Lower) ÷ Middle. A ${SQUEEZE_LOOKBACK}-bar low (squeeze) signals compressed volatility — a breakout is statistically more likely to follow.`}
            style={{
              fontSize: '0.76rem', fontWeight: 700, padding: '0.25rem 0.65rem', borderRadius: '6px', whiteSpace: 'nowrap',
              color: squeeze.isSqueezeNow ? '#0f172a' : 'var(--text-secondary)',
              background: squeeze.isSqueezeNow ? SQUEEZE_COLOR : 'transparent',
              border: `1px solid ${squeeze.isSqueezeNow ? SQUEEZE_COLOR : 'var(--border)'}`,
            }}
          >
            Bandwidth: {squeeze.current.toFixed(1)}%{squeeze.isSqueezeNow ? ` · ⚠ Squeeze (${SQUEEZE_LOOKBACK}-day low) — breakout likely` : ''}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '0.78rem', fontWeight: 700, display: 'flex', gap: '0.75rem' }}>
          <span style={{ color: BUY_COLOR }}>▲ {buyCount} buy</span>
          <span style={{ color: SELL_COLOR }}>▼ {sellCount} sell</span>
          {deadCatCount > 0 && <span style={{ color: DEADCAT_COLOR }} title="Golden-cross buys ignored as likely dead-cat bounces (below the 20-bar middle band after a sharp drop)">⊘ {deadCatCount} dead-cat</span>}
        </span>
      </div>

      {/* Chart */}
      <div style={{ position: 'relative', height: '480px' }}>
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
        <span><span style={{ color: DEADCAT_COLOR }}>● DC</span> = Dead-cat bounce (buy ignored: below {BB_PERIOD}-bar mid after sharp drop)</span>
        <span><span style={{ color: FAST_COLOR }}>━</span> Fast SMA · <span style={{ color: SLOW_COLOR }}>━</span> Slow SMA</span>
        {showBB && <span><span style={{ color: BB_COLOR }}>━</span> Bollinger ({BB_PERIOD}, {BB_MULT})</span>}
        {showBB && <span><span style={{ color: SQUEEZE_COLOR }}>━</span> Squeeze ({SQUEEZE_LOOKBACK}-day bandwidth low)</span>}
        <span style={{ fontStyle: 'italic', opacity: 0.8 }}>Hover a marker for the trigger detail</span>
      </div>
    </section>
  );
}

export default SignalChart;
