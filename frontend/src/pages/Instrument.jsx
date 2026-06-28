import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine, ReferenceDot } from 'recharts'
import { format, parseISO } from 'date-fns'
import { fetchWithAbort } from '../hooks/useFetchWithAbort'
import AlertRow from '../components/alerts/AlertRow'
import SignalChart from '../components/SignalChart'
import { generateSignals } from '../lib/signalEngine'
import ConvictionModal from '../components/alerts/ConvictionModal'
import TradePlanModal from '../components/alerts/TradePlanModal'
import ValuationPanel from '../components/ValuationPanel'

// Two-panel shareholding view: left selects a quarter and shows horizontal
// % bars per category; right selects a category and shows a vertical bar
// history across all available quarters.
function ShareholdingPanel({ payload, error }) {
  const quarters = Array.isArray(payload?.quarters)
    ? [...payload.quarters].sort((a, b) => a.sortKey - b.sortKey)
    : [];

  // Derive "Retail and Others" as Public + Others so the breakdown matches
  // the conventional Indian disclosure (retail investors + small bucket).
  const enriched = quarters.map(q => ({
    ...q,
    retailAndOthers: (q.public != null || q.others != null)
      ? +(((q.public || 0) + (q.others || 0)).toFixed(2))
      : null,
  }));

  // Display order + colors mirror the reference layout. Sub-rows like
  // Mutual Funds / Other Domestic Institutions are preferred when available;
  // we fall back to the parent DII total otherwise.
  const hasMF = enriched.some(q => q.mutualFunds != null && q.mutualFunds > 0);
  const hasODI = enriched.some(q => q.otherDIIs != null && q.otherDIIs > 0);

  // `alwaysShow` keeps core categories visible even when screener reports
  // them as 0 (e.g. HDFC Bank post-merger has 0% promoter holding — without
  // this flag the row silently disappears). Optional categories like
  // Government still get filtered out when uniformly zero to avoid clutter.
  const CATEGORIES = [
    { key: 'promoters',          label: 'Total Promoter Holding', color: '#4f8df9', alwaysShow: true },
    ...(hasMF
      ? [{ key: 'mutualFunds',         label: 'Mutual Funds',                color: '#4f8df9' }]
      : []),
    ...(hasODI
      ? [{ key: 'otherDIIs',           label: 'Other Domestic Institutions', color: '#bfdcff' }]
      : []),
    ...(!hasMF && !hasODI
      ? [{ key: 'diis',               label: 'Domestic Institutions',        color: '#4f8df9' }]
      : []),
    { key: 'fiis',               label: 'Foreign Institutions',  color: '#4f8df9', alwaysShow: true },
    { key: 'government',         label: 'Government',            color: '#bfdcff' },
    { key: 'retailAndOthers',    label: 'Retail and Others',     color: '#4f8df9', alwaysShow: true },
  ].filter(c => c.alwaysShow || enriched.some(q => q[c.key] != null && q[c.key] > 0));

  // Selection state. `null` means "use default" — resolved below by looking
  // up the latest quarter / preferred category at render time, so we don't
  // need an effect to seed defaults after payload arrives.
  const [selectedQuarterKey, setSelectedQuarterKey] = useState(null);
  const [selectedCategoryKey, setSelectedCategoryKey] = useState(null);

  if (quarters.length === 0) {
    return (
      <section className="glass-panel" style={{ marginTop: '1rem', padding: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem 0' }}>Shareholding</h2>
        <p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: '1rem' }}>
          {error
            ? `Shareholding unavailable: ${error}`
            : payload == null ? 'Loading from Screener.in…' : 'Shareholding data is not available for this instrument.'}
        </p>
      </section>
    );
  }

  // Quarter tab labels: show "Mon YYYY" (e.g. "Mar 2026") for the last 4 quarters
  const monthName = (m) => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
  const lastFourQuarters = enriched.slice(-4);
  const selectedQuarter = (selectedQuarterKey != null && enriched.find(q => q.sortKey === selectedQuarterKey))
    || enriched[enriched.length - 1];

  // Max % across visible categories in the selected quarter — for bar scaling
  const maxPct = Math.max(...CATEGORIES.map(c => selectedQuarter[c.key] || 0), 10);

  // Default to FIIs if present (matches reference layout), else first available
  const selectedCategory = (selectedCategoryKey != null && CATEGORIES.find(c => c.key === selectedCategoryKey))
    || CATEGORIES.find(c => c.key === 'fiis')
    || CATEGORIES[0];
  const historyData = enriched.map(q => ({
    label: `${monthName(q.month)} ${String(q.year).slice(-2)}`,
    fullLabel: `${monthName(q.month)} ${q.year}`,
    value: q[selectedCategory.key],
    sortKey: q.sortKey,
  }));

  return (
    <section className="glass-panel" style={{ marginTop: '1rem', padding: '1.5rem' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
        gap: '1.5rem',
      }}>
        {/* ── Left: snapshot for selected quarter ─────────────────── */}
        <div>
          <h3 style={{ margin: '0 0 0.85rem 0', fontSize: '1.1rem' }}>Shareholding Pattern</h3>

          {/* Quarter selector tabs */}
          <div style={{
            display: 'flex',
            gap: 0,
            padding: '4px',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            marginBottom: '1rem',
            flexWrap: 'wrap',
          }}>
            {lastFourQuarters.map(q => {
              const isSelected = q.sortKey === selectedQuarter.sortKey;
              return (
                <button
                  key={q.sortKey}
                  onClick={() => setSelectedQuarterKey(q.sortKey)}
                  style={{
                    flex: '1 1 auto',
                    padding: '0.5rem 0.75rem',
                    background: isSelected ? 'var(--text-primary)' : 'transparent',
                    color: isSelected ? 'var(--bg-dark)' : 'var(--text-secondary)',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '0.8rem',
                    fontWeight: isSelected ? 700 : 500,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    transition: 'all 0.15s',
                  }}
                >
                  {monthName(q.month)} {q.year}
                </button>
              );
            })}
          </div>

          {/* Horizontal % bars per category */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            {CATEGORIES.map(c => {
              const v = selectedQuarter[c.key];
              const pctOfMax = v == null ? 0 : (v / maxPct) * 100;
              return (
                <div key={c.key}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.3rem' }}>
                    {c.label}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                    <div style={{
                      flex: 1,
                      height: '12px',
                      background: 'rgba(255,255,255,0.04)',
                      borderRadius: '3px',
                      overflow: 'hidden',
                    }}>
                      <div style={{
                        width: `${pctOfMax}%`,
                        height: '100%',
                        background: c.color,
                        transition: 'width 0.3s',
                      }} />
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 600, minWidth: '52px', textAlign: 'right' }}>
                      {v == null ? '—' : `${v.toFixed(2)}%`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: history of selected category ─────────────────── */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Shareholding History</h3>
          </div>

          {/* Category selector dropdown */}
          <div style={{ marginBottom: '1rem' }}>
            <select
              value={selectedCategory.key}
              onChange={(e) => setSelectedCategoryKey(e.target.value)}
              style={{
                padding: '0.55rem 0.75rem',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
                outline: 'none',
                minWidth: '220px',
              }}
            >
              {CATEGORIES.map(c => (
                <option key={c.key} value={c.key} style={{ background: 'var(--bg-dark)' }}>{c.label}</option>
              ))}
            </select>
          </div>

          {/* Vertical bar chart of selected category over time */}
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={historyData} margin={{ top: 24, right: 8, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                  axisLine={{ stroke: 'var(--border)' }}
                  tickLine={false}
                />
                <YAxis
                  hide
                  domain={[0, (dataMax) => Math.max(dataMax * 1.18, 1)]}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--bg-dark)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                  formatter={(value) => [value == null ? '—' : `${Number(value).toFixed(2)}%`, selectedCategory.label]}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.fullLabel || ''}
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                />
                <Bar
                  dataKey="value"
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                  cursor="pointer"
                  onClick={(d) => d?.sortKey != null && setSelectedQuarterKey(d.sortKey)}
                  label={{
                    position: 'top',
                    fill: 'var(--text-primary)',
                    fontSize: 11,
                    fontWeight: 600,
                    formatter: (v) => v == null ? '' : `${Number(v).toFixed(2)}%`,
                  }}
                >
                  {historyData.map((d) => (
                    <Cell
                      key={d.sortKey}
                      fill={d.sortKey === selectedQuarter.sortKey ? '#34d3a4' : 'rgba(52,211,164,0.28)'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </section>
  );
}

// Detect support/resistance from the visible candles. Find swing pivots (a bar
// whose high/low is the extreme within ±k bars), cluster pivots that sit within
// ~1.5% of each other into a level (more touches = stronger), then split by the
// current price: levels below = support, above = resistance. Returns the
// nearest few on each side so the chart isn't cluttered.
function computeSupportResistance(data) {
  if (!Array.isArray(data) || data.length < 20) return { supports: [], resistances: [] };
  const highs = data.map(d => d.high ?? d.close);
  const lows = data.map(d => d.low ?? d.close);
  const k = Math.min(10, Math.max(3, Math.round(data.length / 40)));

  const pivots = [];
  for (let i = k; i < data.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (highs[j] > highs[i]) isHigh = false;
      if (lows[j] < lows[i]) isLow = false;
    }
    if (isHigh) pivots.push(highs[i]);
    if (isLow) pivots.push(lows[i]);
  }
  if (pivots.length === 0) return { supports: [], resistances: [] };

  // Cluster nearby pivot prices into levels.
  pivots.sort((a, b) => a - b);
  const tol = 0.015;
  const clusters = [];
  for (const p of pivots) {
    const last = clusters[clusters.length - 1];
    const lastAvg = last ? last.sum / last.count : null;
    if (last && Math.abs(p - lastAvg) / lastAvg <= tol) {
      last.sum += p; last.count++;
    } else {
      clusters.push({ sum: p, count: 1 });
    }
  }
  const levels = clusters.map(c => ({ price: +(c.sum / c.count).toFixed(2), touches: c.count }));

  const price = data[data.length - 1].close;

  // Score each level by how ACTIONABLE it is: nearness to the current price plus
  // how many times it's been tested. This is a hybrid — it prefers strong, near
  // levels (the ones that matter on a range-bound name) yet still surfaces recent
  // single-touch swings to fill the gap on a fast trender (e.g. TD Power), all
  // without letting distant bases or minor blips dominate. Each level keeps its
  // touch count so the chart can draw stronger levels more prominently.
  const minGap = 0.05; // 5% of current price
  const scoreOf = (l) => {
    const dist = Math.abs(l.price - price) / price;
    const nearness = Math.max(0, 1 - dist / 0.6);  // fades out ~60% away from price
    const strength = Math.min(l.touches, 4) / 4;   // 0.25 (1 touch) … 1 (4+ touches)
    return 0.6 * nearness + 0.4 * strength;
  };
  const pickSide = (cands, descending) => {
    const ranked = [...cands].sort((a, b) => scoreOf(b) - scoreOf(a));
    const picked = [];
    for (const l of ranked) {
      if (picked.every(p => Math.abs(p.price - l.price) / price >= minGap)) picked.push(l);
      if (picked.length >= 4) break;
    }
    return picked.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
  };
  const supports = pickSide(levels.filter(l => l.price < price * 0.995), true);
  const resistances = pickSide(levels.filter(l => l.price > price * 1.005), false);
  return { supports, resistances };
}

// Wilder's RSI(14), aligned to the closes array (null during warmup).
function rsi14Series(closes, period = 14) {
  const n = closes.length;
  const rsi = new Array(n).fill(null);
  if (n < period + 1) return rsi;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

const BREAKOUT_RSI_MIN = 55; // "strict momentum" gate

// Advanced breakout engine. A trigger is a close pushing above the prior
// `lookback`-bar high (dynamic resistance). It's flagged only if VOLUME clears
// `volMult`× its 20-bar average and — when strict momentum is on — RSI(14) is
// trending (≥ BREAKOUT_RSI_MIN). It's then classified by TIME confirmation:
//   confirmed — price held the broken level for `confirmPeriods` bars
//   failed    — price closed back below within `confirmPeriods` (a trap)
//   pending   — not enough bars elapsed yet to decide
// Each event carries the exact stats that triggered it (volume ×, RSI, hold).
function detectBreakoutsAdvanced(data, { volMult = 1.5, confirmPeriods = 3, strictMomentum = false, lookback = 30 } = {}) {
  const n = data.length;
  if (n < lookback + 2) return [];
  const highs = data.map(d => d.high ?? d.close);
  const closes = data.map(d => d.close);
  const vols = data.map(d => d.volume ?? 0);
  const hasVolume = vols.some(v => v > 0); // indices report 0 volume — bypass the gate
  const rsi = rsi14Series(closes);
  const VOL_P = 20;
  const volSMA = (i) => {
    if (i < VOL_P) return null;
    let s = 0; for (let j = i - VOL_P; j < i; j++) s += vols[j];
    return s / VOL_P;
  };
  const maxBefore = (end) => {
    let m = -Infinity;
    for (let j = Math.max(0, end - lookback); j < end; j++) if (highs[j] > m) m = highs[j];
    return m;
  };
  const cooldown = Math.max(3, Math.round(lookback / 3));
  const out = [];
  let last = -Infinity;
  for (let i = lookback; i < n; i++) {
    const level = maxBefore(i);
    // Trigger: this bar clears the channel that the previous bar hadn't.
    if (!(closes[i] > level && closes[i - 1] <= maxBefore(i - 1))) continue;
    if (i - last < cooldown) continue;
    // Volume confirmation — skipped for instruments with no volume (indices),
    // so their breakouts still surface on price + time + momentum.
    let volX = null;
    if (hasVolume) {
      const vsma = volSMA(i);
      volX = vsma ? vols[i] / vsma : null;
      if (volX == null || volX < volMult) continue;
    }
    // Momentum filter (optional).
    const r = rsi[i];
    if (strictMomentum && !(r != null && r >= BREAKOUT_RSI_MIN)) continue;
    // Time confirmation.
    let failedAt = null;
    const avail = Math.min(confirmPeriods, n - 1 - i);
    for (let k = 1; k <= avail; k++) {
      if (closes[i + k] < level) { failedAt = k; break; }
    }
    const status = failedAt != null ? 'failed' : (avail >= confirmPeriods ? 'confirmed' : 'pending');
    out.push({
      index: i, date: data[i].date, price: closes[i], level: +level.toFixed(2), status,
      volX: volX != null ? +volX.toFixed(2) : null,
      rsi: r != null ? Math.round(r) : null,
      heldPeriods: failedAt != null ? failedAt - 1 : avail,
      confirmPeriods,
    });
    last = i;
  }
  return out;
}

// A clean, readable price tag pinned to the right edge of a reference line —
// solid pill + dark text (like a charting platform's axis label) instead of
// bare coloured text that's unreadable over the dashed line.
function srPriceTag(price, color, opacity = 1) {
  return function SRTag({ viewBox }) {
    const { x, y, width } = viewBox;
    const text = `₹${price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    const w = text.length * 6.6 + 16;
    const lx = x + width + 6; // sit in the right margin, flush to the chart edge
    // Subtle slate pill with a coloured border + coloured text — reads like a
    // charting-platform axis tag rather than a loud solid sticker. Opacity drops
    // for weaker (fewer-touch) levels so the chart never implies a one-touch
    // blip is as significant as a multi-touch base.
    return (
      <g opacity={opacity}>
        <rect x={lx} y={y - 9} width={w} height={18} rx={4} fill="#0f172a" stroke={color} strokeWidth={1} fillOpacity={0.95} />
        <text x={lx + w / 2} y={y + 1} dominantBaseline="middle" textAnchor="middle" fill="#ffffff" fontSize={11} fontWeight={700}>
          {text}
        </text>
      </g>
    );
  };
}

// Line/tag emphasis by how many times a level has been tested.
function srStrength(touches) {
  if (touches >= 3) return { width: 2, opacity: 0.95, tag: 1 };
  if (touches === 2) return { width: 1.5, opacity: 0.8, tag: 0.85 };
  return { width: 1, opacity: 0.5, tag: 0.6 }; // single-touch swing — drawn faint
}

// Compact axis date: "Dec 19, 2025" → "Dec '25". Day-level precision lives in
// the tooltip; the axis just needs month/year to stay legible.
function fmtAxisDate(d) {
  const m = typeof d === 'string' && d.match(/^([A-Za-z]{3}) \d+, (\d{4})$/);
  return m ? `${m[1]} '${m[2].slice(2)}` : d;
}

function Instrument() {
  const { token } = useParams()
  const [searchParams] = useSearchParams()
  const symbol = searchParams.get('symbol')
  const navigate = useNavigate()

  // Resolve a peer's screener slug to its NSE instrument token, then open its
  // instrument page. Mirrors MarketDataTable's handler — the token is needed
  // for the chart, but the page degrades gracefully (token 0) if lookup fails.
  const peerTokenCacheRef = useRef(new Map())
  const openPeer = async (peerSymbol, peerName) => {
    if (!peerSymbol) return
    const nameParam = peerName ? `&name=${encodeURIComponent(peerName)}` : ''
    const cached = peerTokenCacheRef.current.get(peerSymbol)
    if (cached) {
      navigate(`/instrument/${cached}?symbol=${encodeURIComponent(peerSymbol)}${nameParam}`)
      return
    }
    try {
      const r = await fetch(`/api/instrument-info/${encodeURIComponent(peerSymbol)}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const info = await r.json()
      const tok = info?.instrument_token
      if (!tok) {
        navigate(`/instrument/0?symbol=${encodeURIComponent(peerSymbol)}${nameParam}`)
        return
      }
      peerTokenCacheRef.current.set(peerSymbol, tok)
      navigate(`/instrument/${tok}?symbol=${encodeURIComponent(peerSymbol)}${nameParam}`)
    } catch {
      navigate(`/instrument/0?symbol=${encodeURIComponent(peerSymbol)}${nameParam}`)
    }
  }

  const [data, setData] = useState([])
  const [quote, setQuote] = useState(null)
  const [indicators, setIndicators] = useState(null)
  const [fundamentals, setFundamentals] = useState(null)
  // cashflow state retired — both tabs now use screener-backed state below.
  // Company name sourced from Kite (search_instruments) — populates faster than
  // Yahoo fundamentals and is canonical for Indian tickers.
  const [kiteName, setKiteName] = useState(null)
  // Quarterly Results scraped from screener.in (richer + denser than Yahoo for
  // Indian tickers — no gaps, 13 quarters of history typically).
  const [screenerQuarterly, setScreenerQuarterly] = useState(null)
  const [screenerError, setScreenerError] = useState(null)
  // Annual P&L from the same screener page — fetched lazily when the user
  // toggles the Results view from Quarterly to Yearly.
  const [screenerAnnual, setScreenerAnnual] = useState(null)
  const [screenerAnnualError, setScreenerAnnualError] = useState(null)
  const [resultPeriod, setResultPeriod] = useState('quarterly') // 'quarterly' | 'yearly'
  // Annual cashflow scraped from the same screener page (separate cache entry).
  // Yahoo's quarterly cashflow was synthesised; Indian companies only file
  // annual cashflow in standalone disclosures anyway.
  const [screenerCashflow, setScreenerCashflow] = useState(null)
  const [screenerCashflowError, setScreenerCashflowError] = useState(null)
  const [screenerPeers, setScreenerPeers] = useState(null)
  const [screenerPeersError, setScreenerPeersError] = useState(null)
  // Peer-table sort. field=null keeps screener's natural order (by market cap).
  const [peersSort, setPeersSort] = useState({ field: null, dir: 'desc' })
  // Annual balance sheet — consolidated by default, server falls back to
  // standalone on 404 (small caps).
  const [screenerBalanceSheet, setScreenerBalanceSheet] = useState(null)
  const [screenerBalanceSheetError, setScreenerBalanceSheetError] = useState(null)
  // Quarterly shareholding pattern (Promoters / FIIs / DIIs / Public / Govt / Others).
  const [screenerShareholding, setScreenerShareholding] = useState(null)
  const [screenerShareholdingError, setScreenerShareholdingError] = useState(null)
  // Single-instrument technical alert (mirrors Alerts page rows)
  const [instrumentAlert, setInstrumentAlert] = useState(null)
  const [instrumentAlertError, setInstrumentAlertError] = useState(null)
  const [instrumentAlertLoading, setInstrumentAlertLoading] = useState(false)
  // Modals reused from Alerts page
  const [convictionStock, setConvictionStock] = useState(null)
  const [tradePlanStock, setTradePlanStock] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [timeframe, setTimeframe] = useState('1M')
  const [showSR, setShowSR] = useState(true) // support/resistance overlay
  const [showBreakouts, setShowBreakouts] = useState(true) // breakout markers
  const [showSignals, setShowSignals] = useState(false) // 10/50 MA-crossover Buy/Sell markers (off by default)
  // Breakout-engine parameters (drive live re-evaluation of the markers).
  const [volMult, setVolMult] = useState(1.5)
  const [confirmPeriods, setConfirmPeriods] = useState(3)
  const [strictMomentum, setStrictMomentum] = useState(false)
  const [activeTab, setActiveTab] = useState('technicals')
  // Free-text company notes (persisted per symbol in Supabase).
  const [note, setNote] = useState('')
  const [noteSavedAt, setNoteSavedAt] = useState(null)
  const [noteStatus, setNoteStatus] = useState('idle') // idle | loading | saving | saved | error
  const [noteError, setNoteError] = useState(null)
  const noteLoadedRef = useRef('')  // last value loaded/saved from server, to detect dirty
  // cashflowType toggle removed — screener has only annual cashflow.
  // Cashflow tab sub-view: bar chart vs. data table (toggled like a tab).
  const [cashflowView, setCashflowView] = useState('chart') // 'chart' | 'table'
  const [cashflowHelpOpen, setCashflowHelpOpen] = useState(false)
  // Esc closes the cashflow legend help modal (mirrors ConvictionModal/TradePlanModal).
  useEffect(() => {
    if (!cashflowHelpOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setCashflowHelpOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cashflowHelpOpen])

  // Fetch live quote
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort('/api/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruments: [`NSE:${symbol}`] }),
          signal: controller.signal
        });
        const resData = await res.json();
        if (resData?.content?.[0]?.text) {
          const parsed = JSON.parse(resData.content[0].text);
          const key = `NSE:${symbol}`;
          if (parsed[key]) setQuote(parsed[key]);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Fetch canonical company name from Kite (search_instruments)
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/instrument-info/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        const info = await res.json();
        if (info?.name) setKiteName(info.name);
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Fetch quarterly results from screener.in scrape (cached 12h server-side)
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/screener-quarterly/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.quarters) && data.quarters.length > 0) {
            setScreenerQuarterly(data);
          } else {
            setScreenerError('Screener returned no quarterly rows');
          }
        } else {
          const err = await res.json().catch(() => ({}));
          setScreenerError(err.error || `Screener fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setScreenerError(e.message);
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Reset annual P&L whenever the symbol changes so a stale previous-symbol
  // series never flashes before the lazy fetch below resolves.
  useEffect(() => {
    setScreenerAnnual(null);
    setScreenerAnnualError(null);
  }, [symbol])

  // Fetch annual P&L lazily — only once the user switches to the yearly view
  // (same screener page the quarterly call already warmed, so it's cheap).
  useEffect(() => {
    if (!symbol || resultPeriod !== 'yearly') return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/screener-annual/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.years) && data.years.length > 0) {
            setScreenerAnnual(data);
          } else {
            setScreenerAnnualError('Screener returned no annual rows');
          }
        } else {
          const err = await res.json().catch(() => ({}));
          setScreenerAnnualError(err.error || `Screener fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setScreenerAnnualError(e.message);
      }
    })();
    return () => controller.abort();
  }, [symbol, resultPeriod])

  // Fetch annual cashflow from screener.in (same page, separate parser).
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/screener-cashflow/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.years) && data.years.length > 0) {
            setScreenerCashflow(data);
          } else {
            setScreenerCashflowError('Screener returned no cashflow rows');
          }
        } else {
          const err = await res.json().catch(() => ({}));
          setScreenerCashflowError(err.error || `Screener fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setScreenerCashflowError(e.message);
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Fetch peer comparison from screener.in (the company's industry listing).
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/screener-peers/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.peers) && data.peers.length > 0) setScreenerPeers(data);
          else setScreenerPeersError('Screener returned no peers');
        } else {
          const err = await res.json().catch(() => ({}));
          setScreenerPeersError(err.error || `Screener fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setScreenerPeersError(e.message);
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Fetch annual consolidated balance sheet from screener.in.
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/screener-balance-sheet/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.years) && data.years.length > 0) {
            setScreenerBalanceSheet(data);
          } else {
            setScreenerBalanceSheetError('Screener returned no balance sheet rows');
          }
        } else {
          const err = await res.json().catch(() => ({}));
          setScreenerBalanceSheetError(err.error || `Screener fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setScreenerBalanceSheetError(e.message);
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Fetch quarterly shareholding pattern from screener.in.
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/screener-shareholding/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.quarters) && data.quarters.length > 0) {
            setScreenerShareholding(data);
          } else {
            setScreenerShareholdingError('Screener returned no shareholding rows');
          }
        } else {
          const err = await res.json().catch(() => ({}));
          setScreenerShareholdingError(err.error || `Screener fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setScreenerShareholdingError(e.message);
      }
    })();
    return () => controller.abort();
  }, [symbol])

  // Reset alert state whenever the instrument changes so the next fetch
  // doesn't get blocked by the dedup guard below and stale data from the
  // previous symbol doesn't flash on the screen.
  useEffect(() => {
    setInstrumentAlert(null);
    setInstrumentAlertError(null);
  }, [symbol, token])

  // Fetch per-instrument technical alert. Only when the Technicals tab is
  // active so we don't hit the MCP quote service on every page load.
  useEffect(() => {
    if (!symbol || !token) return;
    if (activeTab !== 'technicals') return;
    if (instrumentAlert || instrumentAlertError) return;
    const controller = new AbortController();
    (async () => {
      try {
        setInstrumentAlertLoading(true);
        const res = await fetchWithAbort(
          `/api/instrument-alert/${encodeURIComponent(token)}?symbol=${encodeURIComponent(symbol)}`,
          { signal: controller.signal }
        );
        if (res.ok) {
          const data = await res.json();
          setInstrumentAlert(data);
        } else {
          const err = await res.json().catch(() => ({}));
          setInstrumentAlertError(err.error || `Alert fetch failed (${res.status})`);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        setInstrumentAlertError(e.message);
      } finally {
        setInstrumentAlertLoading(false);
      }
    })();
    return () => controller.abort();
  }, [symbol, token, activeTab, instrumentAlert, instrumentAlertError])

  // Fetch indicators
  useEffect(() => {
    const controller = new AbortController();
    let retries = 0;
    const maxRetries = 2;
    let retryTimer = null;
    const fetchIndicators = async () => {
      try {
        const res = await fetchWithAbort(`/api/indicators/${token}`, { signal: controller.signal })
        if (res.ok) {
          const data = await res.json()
          setIndicators(data)
        } else if (res.status === 404 && retries < maxRetries) {
          // If backend is still warming the cache, try again once more in 3 seconds
          retries++;
          retryTimer = setTimeout(fetchIndicators, 3000);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (retries < maxRetries) {
          retries++;
          retryTimer = setTimeout(fetchIndicators, 3000);
        }
      }
    }
    fetchIndicators()
    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [token])

  // Fetch fundamentals
  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/fundamentals/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          setFundamentals(data);
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        console.error("Failed to fetch fundamentals", e);
      }
    })();
    return () => controller.abort();
  }, [symbol]);

  // Load the saved note for this symbol.
  useEffect(() => {
    if (!symbol) return;
    setNote(''); setNoteError(null); setNoteSavedAt(null); noteLoadedRef.current = '';
    setNoteStatus('loading');
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetchWithAbort(`/api/notes/${encodeURIComponent(symbol)}`, { signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Failed to load note (${res.status})`);
        setNote(data.note || '');
        noteLoadedRef.current = data.note || '';
        setNoteSavedAt(data.updatedAt || null);
        setNoteStatus('idle');
      } catch (e) {
        if (e.name === 'AbortError') return;
        setNoteError(e.message);
        setNoteStatus('error');
      }
    })();
    return () => controller.abort();
  }, [symbol]);

  const saveNote = async () => {
    if (!symbol) return;
    setNoteStatus('saving'); setNoteError(null);
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(symbol)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to save (${res.status})`);
      noteLoadedRef.current = data.note ?? note;
      setNoteSavedAt(data.updatedAt || new Date().toISOString());
      setNoteStatus('saved');
    } catch (e) {
      setNoteError(e.message);
      setNoteStatus('error');
    }
  };

  const deleteNote = async () => {
    if (!symbol) return;
    if (!window.confirm(`Delete your note on ${symbol}? This can't be undone.`)) return;
    setNoteStatus('saving'); setNoteError(null);
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to delete (${res.status})`);
      setNote('');
      noteLoadedRef.current = '';
      setNoteSavedAt(null);
      setNoteStatus('idle');
    } catch (e) {
      setNoteError(e.message);
      setNoteStatus('error');
    }
  };

  // (Yahoo /api/cashflow fetch was here — removed when both Quarterly Results
  // and Cashflow Chart switched to screener.in. Backend route stays around
  // for now in case anything else hits it.)

  // Fetch historical data
  useEffect(() => {
    const controller = new AbortController();
    const fetchHistoricalData = async () => {
      try {
        setLoading(true)
        setError(null)
        const res = await fetchWithAbort(`/api/historical/${token}?tf=${timeframe}&t=${Date.now()}`, { signal: controller.signal })
        const resData = await res.json()

        if (resData.isError || resData.error) {
          let msg = resData.content?.[0]?.text || resData.error || "Unknown error";
          if (msg.includes("Failed to get historical data")) {
            msg = "Market data for the selected timeframe is unavailable or restricted by Kite.";
          }
          setError(msg)
          return
        }

        if (resData?.content?.[0]?.text) {
          let parsed = JSON.parse(resData.content[0].text);

          if (Array.isArray(parsed)) {
            let fullChartData = parsed.map(c => {
              // Extract "2026-03-30" from "2026-03-30T00:00:00+05:30"
              const ymd = c.date.substring(0, 10);
              const [yyyy, mm, dd] = ymd.split('-');
              const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
              const safeDate = `${months[parseInt(mm, 10) - 1]} ${parseInt(dd, 10)}, ${yyyy}`;

              return {
                dateObj: new Date(c.date),
                date: timeframe === '1D'
                  ? c.date.substring(11, 16) // Extracts "09:15" directly from "2026-04-07T09:15:00+05:30"
                  : safeDate,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
                sma20: c.sma20,
                sma5: c.sma5
              };
            })

            if (timeframe === '1D' && fullChartData.length > 0) {
              const lastDateStr = fullChartData[fullChartData.length - 1].dateObj.toDateString();
              const todayData = fullChartData.filter(c => c.dateObj.toDateString() === lastDateStr);
              setData(todayData)
            } else {
              setData(fullChartData)
            }
          } else {
            setError('Unexpected historical data format.')
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        setError('Error connecting to backend API.')
      } finally {
        setLoading(false)
      }
    }

    fetchHistoricalData()
    return () => controller.abort();
  }, [token, timeframe])

  const tfOptions = ['1D', '1W', '1M', '3M', '6M', '1Y', '2Y', '3Y', '4Y', '5Y'];

  // Support/resistance levels for the chart overlay (intraday 1D excluded —
  // pivots there are noise). Recomputed whenever the visible candles change.
  const sr = useMemo(
    () => (timeframe === '1D' ? { supports: [], resistances: [] } : computeSupportResistance(data)),
    [data, timeframe]
  );
  const breakouts = useMemo(() => {
    if (timeframe === '1D') return [];
    // Longer channel = fewer, more significant breakouts.
    const lb = Math.min(45, Math.max(15, Math.round(data.length / 18)));
    return detectBreakoutsAdvanced(data, { volMult, confirmPeriods, strictMomentum, lookback: lb });
  }, [data, timeframe, volMult, confirmPeriods, strictMomentum]);

  // 10/50 SMA crossover Buy/Sell signals on the charted series. Needs ≥ slow-SMA
  // worth of bars, so it's empty on 1D and very short timeframes (1M ≈ 22 bars).
  const maSignals = useMemo(
    () => (timeframe === '1D' || data.length <= 50 ? [] : generateSignals(data, 10, 50).signals),
    [data, timeframe]
  );

  const todayChange = quote ? (quote.last_price - quote.ohlc.close) : null;
  const todayChangePct = quote && quote.ohlc.close ? ((todayChange / quote.ohlc.close) * 100).toFixed(2) : null;

  const fmtNum = (n) => n != null ? n.toFixed(2) : '—';

  const rsiColor = (val) => {
    if (val == null) return '';
    if (val >= 70) return 'negative';
    if (val <= 30) return 'positive';
    return '';
  };

  const rsiLabel = (val) => {
    if (val == null) return '';
    if (val >= 70) return 'Bearish (Overbought)';
    if (val <= 30) return 'Bullish (Oversold)';
    return 'Neutral';
  };

  // Generic MA signal
  const maSignal = (maVal) => {
    if (maVal == null || indicators?.currentPrice == null) return { text: '', color: '' };
    if (indicators.currentPrice > maVal) return { text: 'Bullish', color: 'positive' };
    if (indicators.currentPrice < maVal) return { text: 'Bearish', color: 'negative' };
    return { text: 'Neutral', color: '' };
  };

  // MACD signal
  const macdSignal = (macd, signal) => {
    if (macd == null || signal == null) return { text: '', color: '' };
    if (macd > signal) return { text: 'Bullish', color: 'positive' };
    if (macd < signal) return { text: 'Bearish', color: 'negative' };
    return { text: 'Neutral', color: '' };
  };

  // Bollinger Bands signals
  const bbUpperSignal = (bb) => {
    if (!bb || indicators?.currentPrice == null) return { text: 'Neutral', color: '' };
    if (indicators.currentPrice > bb.upper) return { text: 'Bearish (Overbought)', color: 'negative' };
    return { text: 'Neutral', color: '' };
  };

  const bbLowerSignal = (bb) => {
    if (!bb || indicators?.currentPrice == null) return { text: 'Neutral', color: '' };
    if (indicators.currentPrice < bb.lower) return { text: 'Bullish (Oversold)', color: 'positive' };
    return { text: 'Neutral', color: '' };
  };

  // MACD signals for Histogram and Signal line
  const macdHistSignal = (hist) => {
    if (hist == null) return { text: 'Neutral', color: '' };
    if (hist > 0) return { text: 'Bullish', color: 'positive' };
    if (hist < 0) return { text: 'Bearish', color: 'negative' };
    return { text: 'Neutral', color: '' };
  };

  const macdSignalLineStatus = (val) => {
    if (val == null) return { text: 'Neutral', color: '' };
    if (val > 0) return { text: 'Bullish', color: 'positive' };
    if (val < 0) return { text: 'Bearish', color: 'negative' };
    return { text: 'Neutral', color: '' };
  };

  const nameFromUrl = searchParams.get('name')

  if (loading) return <div className="loader"></div>;

  return (
    <div className="dashboard-layout">
      <header className="header" style={{ marginBottom: '1rem', borderBottom: 'none' }}>
        <div>
          <button onClick={() => navigate(-1)} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-primary)', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer', marginBottom: '1rem' }}>
            &larr; Back to Dashboard
          </button>
          <h1 style={{ margin: 0 }}>
            {kiteName
              || fundamentals?.price?.longName
              || fundamentals?.price?.shortName
              || nameFromUrl
              || symbol
              || 'Instrument'}
          </h1>
          {(kiteName || fundamentals?.price?.longName || fundamentals?.price?.shortName || nameFromUrl) && symbol && (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: '0.5px', marginTop: '0.25rem' }}>
              {symbol}
            </div>
          )}
        </div>
      </header>

      {/* Today's Change */}
      {quote && (
        <section className="grid" style={{ marginBottom: '1rem' }}>
          <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
            <span className="label" style={{ fontSize: '0.85rem' }}>Current Price</span>
            <span className="value" style={{ fontSize: '1.25rem' }}>₹{quote.last_price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
          </div>
          <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
            <span className="label" style={{ fontSize: '0.85rem' }}>Prev. Close</span>
            <span className="value" style={{ fontSize: '1.25rem' }}>₹{quote.ohlc.close.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
          </div>
          <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
            <span className="label" style={{ fontSize: '0.85rem' }}>Today's Change</span>
            <span className={`value ${todayChange >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.25rem' }}>
              {todayChange >= 0 ? '+' : ''}₹{todayChange.toFixed(2)} ({todayChangePct}%)
            </span>
          </div>
        </section>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '1rem', borderBottom: '1px solid var(--border)', marginBottom: '1.5rem', paddingBottom: '0.25rem' }}>
        <button
          onClick={() => setActiveTab('technicals')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'technicals' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'technicals' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'technicals' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Technicals
        </button>
        <button
          onClick={() => setActiveTab('fundamentals')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'fundamentals' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'fundamentals' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'fundamentals' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Fundamentals
        </button>
        <button
          onClick={() => setActiveTab('quarterly')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'quarterly' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'quarterly' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'quarterly' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          P&L
        </button>
        <button
          onClick={() => setActiveTab('cashflow')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'cashflow' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'cashflow' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'cashflow' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Cashflow Analysis
        </button>
        <button
          onClick={() => setActiveTab('balanceSheet')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'balanceSheet' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'balanceSheet' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'balanceSheet' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Balance Sheet
        </button>
        <button
          onClick={() => setActiveTab('shareholding')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'shareholding' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'shareholding' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'shareholding' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Shareholding
        </button>
        <button
          onClick={() => setActiveTab('peers')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'peers' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'peers' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'peers' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Peers
        </button>
        <button
          onClick={() => setActiveTab('signals')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'signals' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'signals' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'signals' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Signals
        </button>
        <button
          onClick={() => setActiveTab('notes')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'notes' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'notes' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'notes' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Notes
        </button>
        <button
          onClick={() => setActiveTab('valuation')}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'valuation' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'valuation' ? 'var(--text-primary)' : 'var(--text-secondary)',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontWeight: activeTab === 'valuation' ? 'bold' : 'normal',
            transition: 'all 0.2s',
            fontSize: '1rem'
          }}
        >
          Valuation
        </button>
      </div>

      {activeTab === 'valuation' && (
        <section style={{ marginBottom: '2rem' }}>
          <ValuationPanel symbol={symbol} token={token} />
        </section>
      )}

      {activeTab === 'peers' && (() => {
        const peers = screenerPeers?.peers || [];
        const median = screenerPeers?.median;
        const fmtN = (v, d = 2) => (v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: d }));
        const fmtCr = (v) => (v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
        const pctColor = (v) => (v == null ? 'var(--text-secondary)' : v > 0 ? '#10b981' : v < 0 ? '#ef4444' : 'var(--text-secondary)');
        const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
        const isSelf = (p) => symbol && p.slug && p.slug.toUpperCase() === symbol.toUpperCase();

        // Column metadata drives both the sortable headers and the sort itself.
        const columns = [
          { key: 'name', label: 'Name', numeric: false },
          { key: 'cmp', label: 'CMP ₹' },
          { key: 'pe', label: 'P/E' },
          { key: 'marketCap', label: 'Mkt Cap ₹Cr' },
          { key: 'divYield', label: 'Div Yld %' },
          { key: 'npQtr', label: 'NP Qtr ₹Cr' },
          { key: 'profitVar', label: 'Profit Var %' },
          { key: 'salesQtr', label: 'Sales Qtr ₹Cr' },
          { key: 'salesVar', label: 'Sales Var %' },
          { key: 'roce', label: 'ROCE %' },
        ];
        const sortPeersBy = (field, numeric) => setPeersSort((s) =>
          s.field === field
            ? { field, dir: s.dir === 'asc' ? 'desc' : 'asc' }
            : { field, dir: numeric === false ? 'asc' : 'desc' });
        const sortedPeers = peersSort.field
          ? [...peers].sort((a, b) => {
              let va = a[peersSort.field];
              let vb = b[peersSort.field];
              if (va == null && vb == null) return 0;
              if (va == null) return 1;   // nulls always sink to the bottom
              if (vb == null) return -1;
              if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
              if (va < vb) return peersSort.dir === 'asc' ? -1 : 1;
              if (va > vb) return peersSort.dir === 'asc' ? 1 : -1;
              return 0;
            })
          : peers;

        return (
          <section className="glass-panel" style={{ marginTop: '1rem', padding: '1.5rem' }}>
            <div style={{ marginBottom: '1rem' }}>
              <h2 style={{ margin: 0 }}>Peer Comparison</h2>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {screenerPeers?.industry ? `${screenerPeers.industry} · ` : ''}Screener.in
              </span>
            </div>

            {peers.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                {screenerPeersError
                  ? `Peers unavailable: ${screenerPeersError}`
                  : screenerPeers == null ? 'Loading from Screener.in…' : 'No peer data for this instrument.'}
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="interactive-table">
                  <thead>
                    <tr>
                      {columns.map((col) => {
                        const active = peersSort.field === col.key;
                        return (
                          <th
                            key={col.key}
                            onClick={() => sortPeersBy(col.key, col.numeric)}
                            title={`Sort by ${col.label}`}
                            style={{ cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}
                          >
                            {col.label}
                            <span style={{ marginLeft: '4px', opacity: active ? 1 : 0.3 }}>
                              {active ? (peersSort.dir === 'asc' ? '↑' : '↓') : '↕'}
                            </span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPeers.map((p) => (
                      <tr key={p.slug} style={isSelf(p) ? { background: 'rgba(56,189,248,0.10)' } : undefined}>
                        <td>
                          {isSelf(p) ? (
                            <strong>{p.name}</strong>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openPeer(p.slug, p.name)}
                              title={`Open ${p.name}`}
                              style={{
                                background: 'transparent', border: 'none', padding: 0,
                                font: 'inherit', fontWeight: 'bold', cursor: 'pointer',
                                color: 'var(--accent)', textAlign: 'left',
                              }}
                            >
                              {p.name}
                            </button>
                          )}
                        </td>
                        <td>{fmtN(p.cmp)}</td>
                        <td>{fmtN(p.pe)}</td>
                        <td>{fmtCr(p.marketCap)}</td>
                        <td>{fmtN(p.divYield)}</td>
                        <td>{fmtN(p.npQtr, 0)}</td>
                        <td style={{ color: pctColor(p.profitVar) }}>{fmtPct(p.profitVar)}</td>
                        <td>{fmtN(p.salesQtr, 0)}</td>
                        <td style={{ color: pctColor(p.salesVar) }}>{fmtPct(p.salesVar)}</td>
                        <td>{fmtN(p.roce)}</td>
                      </tr>
                    ))}
                    {median && (
                      <tr style={{ borderTop: '2px solid var(--border)' }}>
                        <td><strong>Median</strong></td>
                        <td>{fmtN(median.cmp)}</td>
                        <td>{fmtN(median.pe)}</td>
                        <td>{fmtCr(median.marketCap)}</td>
                        <td>{fmtN(median.divYield)}</td>
                        <td>{fmtN(median.npQtr, 0)}</td>
                        <td style={{ color: pctColor(median.profitVar) }}>{fmtPct(median.profitVar)}</td>
                        <td>{fmtN(median.salesQtr, 0)}</td>
                        <td style={{ color: pctColor(median.salesVar) }}>{fmtPct(median.salesVar)}</td>
                        <td>{fmtN(median.roce)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <div style={{ marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  {peers.length} companies in {screenerPeers?.industry || 'this industry'} · current company highlighted · Source: screener.in
                </div>
              </div>
            )}
          </section>
        );
      })()}

      {activeTab === 'signals' && (
        <SignalChart token={token} symbol={symbol} />
      )}

      {activeTab === 'notes' && (() => {
        const dirty = note !== noteLoadedRef.current;
        const statusText = noteStatus === 'loading' ? 'Loading…'
          : noteStatus === 'saving' ? 'Saving…'
          : noteStatus === 'error' ? `Error: ${noteError}`
          : dirty ? 'Unsaved changes'
          : noteSavedAt ? `Saved ${new Date(noteSavedAt).toLocaleString('en-IN')}`
          : 'No note yet';
        const statusColor = noteStatus === 'error' ? '#ef4444'
          : dirty ? '#f59e0b'
          : noteStatus === 'saved' || noteSavedAt ? '#10b981'
          : 'var(--text-secondary)';
        return (
          <section className="glass-panel" style={{ marginTop: '1rem', padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <h2 style={{ margin: 0 }}>Notes</h2>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Your private notes on {symbol}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontSize: '0.72rem', color: statusColor }}>{statusText}</span>
                {(noteSavedAt || noteLoadedRef.current) && (
                  <button
                    onClick={deleteNote}
                    disabled={noteStatus === 'saving' || noteStatus === 'loading'}
                    title={`Delete note on ${symbol}`}
                    style={{
                      padding: '0.45rem 1rem', borderRadius: '6px',
                      border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.08)',
                      color: '#ef4444', fontWeight: 700, fontSize: '0.85rem',
                      cursor: noteStatus === 'saving' ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Delete
                  </button>
                )}
                <button
                  onClick={saveNote}
                  disabled={!dirty || noteStatus === 'saving' || noteStatus === 'loading'}
                  style={{
                    padding: '0.45rem 1.1rem', borderRadius: '6px', border: 'none',
                    background: (!dirty || noteStatus === 'saving') ? 'rgba(56,189,248,0.15)' : 'var(--accent)',
                    color: (!dirty || noteStatus === 'saving') ? 'var(--text-secondary)' : '#04141f',
                    fontWeight: 700, fontSize: '0.85rem',
                    cursor: (!dirty || noteStatus === 'saving') ? 'not-allowed' : 'pointer',
                  }}
                >
                  Save
                </button>
              </div>
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveNote(); }}
              placeholder={`Write your thesis, catalysts, price levels, or anything to remember about ${symbol}…`}
              disabled={noteStatus === 'loading'}
              style={{
                width: '100%', minHeight: '320px', resize: 'vertical',
                padding: '1rem', borderRadius: '8px',
                border: '1px solid var(--border)', background: 'var(--bg-dark)',
                color: 'var(--text-primary)', fontSize: '0.9rem', lineHeight: 1.6,
                fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
              }}
            />
            <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              Tip: press ⌘/Ctrl + Enter to save.
            </div>
          </section>
        );
      })()}

      {activeTab === 'technicals' && (
        <>
          {/* Per-instrument technical alert — same AlertRow used on the
              Holdings Alerts page and Sector Drilldown. Holdings fields are
              hidden because this stock may not be in the user's portfolio. */}
          <section className="glass-panel terminal-alerts" style={{ marginBottom: '1rem', padding: '1.25rem' }}>
            <div style={{ marginBottom: '0.85rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Technical Alerts</h3>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                Live signal stack · ADX, SuperTrend, RSI, VWAP, volume surge, trade plan
              </span>
            </div>
            {instrumentAlertLoading && !instrumentAlert ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '1.25rem' }}>
                <div className="loader"></div>
              </div>
            ) : instrumentAlertError ? (
              <p style={{ margin: 0, color: 'var(--danger)', fontFamily: "'JetBrains Mono', monospace", fontSize: '0.85rem' }}>
                Alert unavailable: {instrumentAlertError}
              </p>
            ) : !instrumentAlert?.alert ? (
              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                {instrumentAlert?.reason || 'No actionable signals on the latest bar.'}
              </p>
            ) : (
              <AlertRow
                stock={instrumentAlert.alert}
                showHoldingsFields={false}
                onOpenConviction={() => setConvictionStock(instrumentAlert.alert)}
                onOpenTradePlan={() => setTradePlanStock(instrumentAlert.alert)}
              />
            )}
          </section>

          {/* Period stats */}
          {!loading && !error && data.length > 0 && timeframe !== '1D' && (
            <section className="grid" style={{ marginBottom: '1rem' }}>
              {(() => {
                const startPrice = data[0].close;
                const lastClose = data[data.length - 1].close;
                // Period Returns must stay internally consistent with the charted
                // series. Kite serves historical equity candles corporate-action
                // ADJUSTED, while the live quote is the RAW current price — so for a
                // stock with a recent split/consolidation the two live on different
                // scales (e.g. PFOCUS: adjusted history ~₹230 vs raw quote ₹580,
                // which wrongly read as +92% while the chart was falling). Only trust
                // the live quote as the endpoint when it agrees with the series' own
                // last close (within 25%, comfortably above a day's ±20% circuit);
                // otherwise fall back to the charted close so the % matches the chart.
                const liveConsistent = quote && lastClose > 0 &&
                  Math.abs(quote.last_price - lastClose) / lastClose <= 0.25;
                const endPrice = liveConsistent ? quote.last_price : lastClose;
                const maxHigh = Math.max(...data.map(d => d.high));
                const minLow = Math.min(...data.map(d => d.low));
                const ret = endPrice - startPrice;
                const retPct = ((ret / startPrice) * 100).toFixed(2);
                return (
                  <>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>Period High</span>
                      <span className="value" style={{ fontSize: '1.25rem' }}>₹{maxHigh.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>Period Low</span>
                      <span className="value" style={{ fontSize: '1.25rem' }}>₹{minLow.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>Period Returns</span>
                      <span className={`value ${ret >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.25rem' }}>
                        {ret >= 0 ? '+' : ''}₹{ret.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ({retPct}%)
                      </span>
                    </div>
                  </>
                );
              })()}
            </section>
          )}

          {/* Chart Configuration */}
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontWeight: 'bold', color: 'var(--text-secondary)', marginRight: '0.5rem' }}></span>
            {tfOptions.map(tf => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                style={{
                  background: timeframe === tf ? 'var(--accent)' : 'var(--bg-panel)',
                  color: timeframe === tf ? '#fff' : 'var(--text-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: '4px',
                  padding: '0.4rem 0.8rem',
                  cursor: 'pointer',
                  fontWeight: timeframe === tf ? 'bold' : 'normal',
                  transition: 'all 0.2s'
                }}
              >
                {tf}
              </button>
            ))}
            {timeframe !== '1D' && (
              <button
                onClick={() => setShowBreakouts(v => !v)}
                title="Toggle breakout markers — where price closed above its prior 20-bar high"
                style={{
                  marginLeft: 'auto',
                  background: showBreakouts ? 'rgba(251,191,36,0.14)' : 'var(--bg-panel)',
                  color: showBreakouts ? '#fbbf24' : 'var(--text-secondary)',
                  border: `1px solid ${showBreakouts ? '#fbbf24' : 'var(--border)'}`,
                  borderRadius: '4px',
                  padding: '0.4rem 0.8rem',
                  cursor: 'pointer',
                  fontWeight: showBreakouts ? 'bold' : 'normal',
                  transition: 'all 0.2s',
                }}
              >
                ▲ Breakouts
              </button>
            )}
            {timeframe !== '1D' && (
              <button
                onClick={() => setShowSR(v => !v)}
                title="Toggle auto-detected support (red) & resistance (green) levels"
                style={{
                  background: showSR ? 'rgba(56,189,248,0.12)' : 'var(--bg-panel)',
                  color: showSR ? 'var(--accent)' : 'var(--text-secondary)',
                  border: `1px solid ${showSR ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: '4px',
                  padding: '0.4rem 0.8rem',
                  cursor: 'pointer',
                  fontWeight: showSR ? 'bold' : 'normal',
                  transition: 'all 0.2s',
                }}
              >
                S/R Levels
              </button>
            )}
            {timeframe !== '1D' && (
              <button
                onClick={() => setShowSignals(v => !v)}
                title="Toggle 10/50 SMA crossover Buy/Sell signals (golden/death cross with RSI filter)"
                style={{
                  background: showSignals ? 'rgba(34,197,94,0.14)' : 'var(--bg-panel)',
                  color: showSignals ? '#22c55e' : 'var(--text-secondary)',
                  border: `1px solid ${showSignals ? '#22c55e' : 'var(--border)'}`,
                  borderRadius: '4px',
                  padding: '0.4rem 0.8rem',
                  cursor: 'pointer',
                  fontWeight: showSignals ? 'bold' : 'normal',
                  transition: 'all 0.2s',
                }}
              >
                ▲▼ Signals (10/50)
              </button>
            )}
          </div>

          {/* Breakout engine control panel */}
          {showBreakouts && timeframe !== '1D' && !loading && !error && data.length > 0 && (() => {
            const nConfirmed = breakouts.filter(b => b.status === 'confirmed').length;
            const nFailed = breakouts.filter(b => b.status === 'failed').length;
            const nPending = breakouts.filter(b => b.status === 'pending').length;
            const hasVolume = data.some(d => d.volume > 0); // false for indices
            const labelStyle = { display: 'flex', flexDirection: 'column', gap: '0.3rem', minWidth: '170px' };
            const capStyle = { fontSize: '0.72rem', color: 'var(--text-secondary)' };
            return (
              <div className="glass-panel" style={{ display: 'flex', gap: '1.75rem', alignItems: 'center', flexWrap: 'wrap', padding: '0.85rem 1.1rem', marginBottom: '0.75rem' }}>
                <span
                  className="info-icon"
                  title="Flags breakouts — where price closes above its recent ceiling (the highest high of the last ~30–45 bars) — then grades each as a real move or a trap. Use the filters to set how strict that grading is."
                  style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '1px', color: 'var(--text-secondary)', textTransform: 'uppercase', opacity: 1, cursor: 'help' }}
                >
                  Breakout Engine ⓘ
                </span>
                <label style={{ ...labelStyle, opacity: hasVolume ? 1 : 0.5 }}>
                  <span style={capStyle}>
                    Volume ≥ <strong style={{ color: 'var(--accent)' }}>{volMult.toFixed(1)}×</strong> 20-bar avg
                    <span className="info-icon" title="A real breakout usually comes on heavy volume. Only flag breakouts whose volume is at least this many times the 20-day average. Higher = fewer, higher-conviction signals.">{' '}ⓘ</span>
                  </span>
                  <input type="range" min="1" max="3" step="0.1" value={volMult} disabled={!hasVolume} onChange={e => setVolMult(+e.target.value)} style={{ accentColor: '#38bdf8', cursor: hasVolume ? 'pointer' : 'not-allowed' }} />
                  {!hasVolume && <span style={{ fontSize: '0.65rem', color: '#fbbf24' }}>No volume for indices — filter off</span>}
                </label>
                <label style={labelStyle}>
                  <span style={capStyle}>
                    Confirm over <strong style={{ color: 'var(--accent)' }}>{confirmPeriods}</strong> {confirmPeriods === 1 ? 'period' : 'periods'}
                    <span className="info-icon" title="After a breakout, price must STAY above the broken level for this many bars to count as Confirmed (green ▲). If it falls back below within the window, it's Failed (red ▼). More periods = a tougher test.">{' '}ⓘ</span>
                  </span>
                  <input type="range" min="1" max="5" step="1" value={confirmPeriods} onChange={e => setConfirmPeriods(+e.target.value)} style={{ accentColor: '#38bdf8', cursor: 'pointer' }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={strictMomentum} onChange={e => setStrictMomentum(e.target.checked)} style={{ accentColor: '#38bdf8', cursor: 'pointer', width: '15px', height: '15px' }} />
                  Strict momentum <span style={{ opacity: 0.7 }}>(RSI ≥ {BREAKOUT_RSI_MIN})</span>
                  <span className="info-icon" title={`When on, ignore breakouts where momentum was weak — RSI(14) below ${BREAKOUT_RSI_MIN} at the breakout bar. Filters out breaks that fire on fading momentum.`}>ⓘ</span>
                </label>
                <span style={{ marginLeft: 'auto', fontSize: '0.78rem', fontWeight: 700, display: 'flex', gap: '0.75rem' }}>
                  <span style={{ color: '#22c55e' }}>▲ {nConfirmed} confirmed</span>
                  <span style={{ color: '#ef4444' }}>▼ {nFailed} failed</span>
                  {nPending > 0 && <span style={{ color: '#fbbf24' }}>◆ {nPending} pending</span>}
                </span>
              </div>
            );
          })()}

          {/* Chart */}
          <section className="glass-panel" style={{ height: '500px', padding: '1.5rem 1rem 1rem 1rem' }}>
            {loading ? (
              <div className="loader"></div>
            ) : error ? (
              <p className="negative">{error}</p>
            ) : data.length === 0 ? (
              <p>No historical data available for this timeline.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 10, right: 78, left: 0, bottom: 0 }}>
                  <XAxis
                    dataKey="date"
                    stroke="var(--text-secondary)"
                    tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                    tickFormatter={fmtAxisDate}
                    interval="preserveStartEnd"
                    minTickGap={56}
                    tickMargin={8}
                  />
                  <YAxis domain={['auto', 'auto']} stroke="var(--text-secondary)" tick={{ fill: 'var(--text-secondary)' }} />
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'var(--bg-dark)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                    itemStyle={{ color: 'var(--accent)' }}
                  />
                  <Legend />
                  {showSR && sr.supports.map(l => {
                    const st = srStrength(l.touches);
                    return (
                      <ReferenceLine
                        key={`sup-${l.price}`}
                        y={l.price}
                        stroke="#f87171"
                        strokeDasharray="2 4"
                        strokeWidth={st.width}
                        strokeOpacity={st.opacity}
                        ifOverflow="extendDomain"
                        label={srPriceTag(l.price, '#f87171', st.tag)}
                      />
                    );
                  })}
                  {showSR && sr.resistances.map(l => {
                    const st = srStrength(l.touches);
                    return (
                      <ReferenceLine
                        key={`res-${l.price}`}
                        y={l.price}
                        stroke="#4ade80"
                        strokeDasharray="2 4"
                        strokeWidth={st.width}
                        strokeOpacity={st.opacity}
                        ifOverflow="extendDomain"
                        label={srPriceTag(l.price, '#4ade80', st.tag)}
                      />
                    );
                  })}
                  {showBreakouts && breakouts.map((b) => {
                    const isFail = b.status === 'failed';
                    const isPending = b.status === 'pending';
                    const c = isFail ? '#ef4444' : isPending ? '#fbbf24' : '#22c55e';
                    const tip = `${b.status.toUpperCase()} breakout @ ₹${b.price}\n`
                      + `Resistance: ₹${b.level}\n`
                      + `Volume: ${b.volX != null ? b.volX + '×' : '—'} avg · RSI: ${b.rsi ?? '—'}\n`
                      + `Held for: ${b.heldPeriods} / ${b.confirmPeriods} period${b.confirmPeriods === 1 ? '' : 's'}`;
                    return (
                      <ReferenceDot
                        key={`bo-${b.index}`}
                        x={b.date}
                        y={b.price}
                        ifOverflow="extendDomain"
                        shape={({ cx, cy }) => (
                          <g style={{ cursor: 'pointer' }}>
                            <title>{tip}</title>
                            {isFail
                              // Down-arrow above the peak.
                              ? <path d={`M ${cx} ${cy - 7} L ${cx - 7} ${cy - 19} L ${cx + 7} ${cy - 19} Z`} fill={c} stroke="#0f172a" strokeWidth={1} />
                              // Up-arrow on the series.
                              : <path d={`M ${cx} ${cy - 19} L ${cx - 7} ${cy - 7} L ${cx + 7} ${cy - 7} Z`} fill={c} stroke="#0f172a" strokeWidth={1} />}
                          </g>
                        )}
                        label={isFail ? { value: 'Breakout - failed', position: 'top', fill: c, fontSize: 10, fontWeight: 700 } : undefined}
                      />
                    );
                  })}
                  {showSignals && maSignals.map((s) => {
                    const buy = s.type === 'buy';
                    if (buy && s.deadCat) return null; // dead-cat bounce: not an actionable buy
                    const c = buy ? '#22c55e' : '#ef4444';
                    const tip = `${buy ? 'BUY' : 'SELL'} · 10/50 ${buy ? 'golden' : 'death'} cross\n`
                      + `Fast(10) ${buy ? 'crossed above' : 'crossed below'} Slow(50)\n`
                      + `RSI ${s.rsi.toFixed(1)} · ₹${s.bar.close}`;
                    return (
                      <ReferenceDot
                        key={`sig-${s.index}`}
                        x={s.bar.date}
                        y={s.bar.close}
                        ifOverflow="extendDomain"
                        shape={({ cx, cy }) => (
                          <g style={{ cursor: 'pointer' }}>
                            <title>{tip}</title>
                            {/* "Long" below the bar for buys, "Short" above for sells. */}
                            <text
                              x={cx}
                              y={buy ? cy + 20 : cy - 11}
                              textAnchor="middle"
                              fontSize={11}
                              fontWeight={700}
                              fill={c}
                              stroke="#0f172a"
                              strokeWidth={0.7}
                              paintOrder="stroke"
                            >
                              {buy ? 'Long' : 'Short'}
                            </text>
                          </g>
                        )}
                      />
                    );
                  })}
                  <Line type="monotone" name="Price" dataKey="close" stroke="var(--accent)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </section>

          {/* Chart marker legend */}
          {!loading && !error && data.length > 0 && timeframe !== '1D' && (showBreakouts || showSR || showSignals) && (
            <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.5rem 0.25rem 0', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              {showSignals && (
                <>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><strong style={{ color: '#22c55e' }}>Long</strong> (10/50 golden cross, RSI &gt; 50)</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><strong style={{ color: '#ef4444' }}>Short</strong> (10/50 death cross, RSI &lt; 50)</span>
                </>
              )}
              {showBreakouts && (
                <>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><span style={{ color: '#22c55e' }}>▲</span> Confirmed breakout (held)</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><span style={{ color: '#ef4444' }}>▼</span> Failed breakout (trap)</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><span style={{ color: '#fbbf24' }}>◆</span> Pending (too recent)</span>
                </>
              )}
              {showSR && (
                <>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><span style={{ color: '#f87171', letterSpacing: '-1px' }}>┈</span> Support</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}><span style={{ color: '#4ade80', letterSpacing: '-1px' }}>┈</span> Resistance</span>
                  <span style={{ opacity: 0.8 }}>(brighter line = more tested)</span>
                </>
              )}
              <span style={{ marginLeft: 'auto', fontStyle: 'italic', opacity: 0.8 }}>Hover any marker for its volume, RSI &amp; hold details</span>
            </div>
          )}

          {/* Technical Indicators */}
          {indicators && (
            <section className="glass-panel" style={{ marginTop: '1rem' }}>
              <h2 style={{ marginBottom: '1rem' }}>Technical Indicators (1D timeframe)</h2>
              <div className="grid" style={{ gap: '0.75rem' }}>
                {/* RSI */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>RSI (14)</span>
                  <span className={`value ${rsiColor(indicators.indicators.rsi.rsi14)}`} style={{ fontSize: '1.25rem' }}>
                    {fmtNum(indicators.indicators.rsi.rsi14)}
                  </span>
                  <span className="label" style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {rsiLabel(indicators.indicators.rsi.rsi14)}
                  </span>
                </div>

                {/* SMA 5 */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>SMA 5</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.sma.sma5)}</span>
                  <span className={`label ${maSignal(indicators.indicators.sma.sma5).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {maSignal(indicators.indicators.sma.sma5).text}
                  </span>
                </div>

                {/* SMA 20 */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>SMA 20</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.sma.sma20)}</span>
                  <span className={`label ${maSignal(indicators.indicators.sma.sma20).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {maSignal(indicators.indicators.sma.sma20).text}
                  </span>
                </div>

                {/* SMA 50 */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>SMA 50</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.sma.sma50)}</span>
                  <span className={`label ${maSignal(indicators.indicators.sma.sma50).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {maSignal(indicators.indicators.sma.sma50).text}
                  </span>
                </div>

                {/* SMA 200 */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>SMA 200</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.sma.sma200)}</span>
                  <span className={`label ${maSignal(indicators.indicators.sma.sma200).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {maSignal(indicators.indicators.sma.sma200).text}
                  </span>
                </div>

                {/* EMA 12 */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>EMA 12</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.ema.ema12)}</span>
                  <span className={`label ${maSignal(indicators.indicators.ema.ema12).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {maSignal(indicators.indicators.ema.ema12).text}
                  </span>
                </div>

                {/* EMA 26 */}
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>EMA 26</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.ema.ema26)}</span>
                  <span className={`label ${maSignal(indicators.indicators.ema.ema26).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {maSignal(indicators.indicators.ema.ema26).text}
                  </span>
                </div>

                {/* MACD */}
                {indicators.indicators.macd && (
                  <>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>MACD Line</span>
                      <span className={`value ${indicators.indicators.macd.MACD >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.25rem' }}>
                        {fmtNum(indicators.indicators.macd.MACD)}
                      </span>
                      <span className={`label ${macdSignal(indicators.indicators.macd.MACD, indicators.indicators.macd.signal).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {macdSignal(indicators.indicators.macd.MACD, indicators.indicators.macd.signal).text}
                      </span>
                    </div>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>MACD Signal</span>
                      <span className="value" style={{ fontSize: '1.25rem' }}>{fmtNum(indicators.indicators.macd.signal)}</span>
                      <span className={`label ${macdSignalLineStatus(indicators.indicators.macd.signal).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {macdSignalLineStatus(indicators.indicators.macd.signal).text}
                      </span>
                    </div>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>MACD Histogram</span>
                      <span className={`value ${indicators.indicators.macd.histogram >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.25rem' }}>
                        {fmtNum(indicators.indicators.macd.histogram)}
                      </span>
                      <span className={`label ${macdHistSignal(indicators.indicators.macd.histogram).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {macdHistSignal(indicators.indicators.macd.histogram).text}
                      </span>
                    </div>
                  </>
                )}

                {/* Bollinger Bands */}
                {indicators.indicators.bollingerBands && (
                  <>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>BB Upper</span>
                      <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.bollingerBands.upper)}</span>
                      <span className={`label ${bbUpperSignal(indicators.indicators.bollingerBands).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {bbUpperSignal(indicators.indicators.bollingerBands).text}
                      </span>
                    </div>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>BB Middle</span>
                      <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.bollingerBands.middle)}</span>
                      <span className={`label ${maSignal(indicators.indicators.bollingerBands.middle).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {maSignal(indicators.indicators.bollingerBands.middle).text}
                      </span>
                    </div>
                    <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                      <span className="label" style={{ fontSize: '0.85rem' }}>BB Lower</span>
                      <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(indicators.indicators.bollingerBands.lower)}</span>
                      <span className={`label ${bbLowerSignal(indicators.indicators.bollingerBands).color}`} style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                        {bbLowerSignal(indicators.indicators.bollingerBands).text}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {activeTab === 'technicals' && !indicators && !loading && !error && (
            <section className="glass-panel" style={{ marginTop: '1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <p>Calculated technical indicators are currently loading or unavailable for this instrument.</p>
            </section>
          )}

        </>
      )}

      {activeTab === 'fundamentals' && (
        <>
          {/* Fundamental Analysis */}
          {fundamentals ? (
            <section className="glass-panel" style={{ marginTop: '1rem', background: 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.01) 100%)' }}>
              <h2 style={{ marginBottom: '1rem' }}>Fundamental Analysis (Yahoo Finance)</h2>

              {fundamentals.assetProfile?.longBusinessSummary && (
                <div style={{ marginBottom: '1.5rem', padding: '1rem', background: 'var(--bg-dark)', borderRadius: '8px', lineHeight: '1.6', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  <strong style={{ color: 'var(--text-primary)', display: 'block', marginBottom: '0.5rem' }}>Company Overview</strong>
                  {fundamentals.assetProfile.longBusinessSummary}
                </div>
              )}

              {fundamentals.assetProfile?.website && (
                <div style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Website</span>
                  <a
                    href={fundamentals.assetProfile.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#7aa2f7', textDecoration: 'none', fontWeight: 600, wordBreak: 'break-all' }}
                  >
                    {fundamentals.assetProfile.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  </a>
                </div>
              )}

              <div className="grid" style={{ gap: '0.75rem' }}>
                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>Market Cap</span>
                  {(() => {
                    const mc = fundamentals.summaryDetail?.marketCap;
                    if (!mc) return <span className="value" style={{ fontSize: '1.25rem' }}>—</span>;
                    const cr = mc / 10000000;
                    // SEBI/AMFI basis: top 100 by market cap = Large, 101–250 = Mid,
                    // rest = Small. Approximated by ₹-cr cut-offs (the official list
                    // is rank-based and re-cut every 6 months, so these drift).
                    const cap = cr >= 85000
                      ? { label: 'Large Cap', color: '#34d3a4' }
                      : cr >= 35000
                        ? { label: 'Mid Cap', color: '#f5a623' }
                        : { label: 'Small Cap', color: '#7aa2f7' };
                    return (
                      <>
                        <span className="value" style={{ fontSize: '1.25rem' }}>
                          ₹{cr.toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr
                        </span>
                        <span
                          title="SEBI/AMFI basis: top 100 by market cap = Large, 101–250 = Mid, rest = Small (₹-cr thresholds approximate)"
                          style={{
                            alignSelf: 'flex-start',
                            marginTop: '0.4rem',
                            padding: '0.1rem 0.55rem',
                            fontSize: '0.7rem',
                            fontWeight: 700,
                            letterSpacing: '0.02em',
                            borderRadius: '999px',
                            color: cap.color,
                            background: `${cap.color}1f`,
                            border: `1px solid ${cap.color}55`,
                          }}
                        >
                          {cap.label}
                        </span>
                      </>
                    );
                  })()}
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>Trailing P/E</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>{fmtNum(fundamentals.summaryDetail?.trailingPE)}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>Forward P/E</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>{fmtNum(fundamentals.summaryDetail?.forwardPE)}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>Price to Book (P/B)</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>{fmtNum(fundamentals.defaultKeyStatistics?.priceToBook)}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>Dividend Yield</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>{fundamentals.summaryDetail?.dividendYield !== undefined ? `${(fundamentals.summaryDetail.dividendYield * 100).toFixed(2)}%` : '—'}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>PEG Ratio</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>{fmtNum(fundamentals.defaultKeyStatistics?.pegRatio)}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>52W High</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(fundamentals.summaryDetail?.fiftyTwoWeekHigh)}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>52W Low</span>
                  <span className="value" style={{ fontSize: '1.25rem' }}>₹{fmtNum(fundamentals.summaryDetail?.fiftyTwoWeekLow)}</span>
                </div>

                <div className="glass-panel stat-card" style={{ padding: '1rem' }}>
                  <span className="label" style={{ fontSize: '0.85rem' }}>Profit Margin</span>
                  <span className={`value ${fundamentals.financialData?.profitMargins >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '1.25rem' }}>
                    {fundamentals.financialData?.profitMargins !== undefined ? `${(fundamentals.financialData.profitMargins * 100).toFixed(2)}%` : '—'}
                  </span>
                </div>
              </div>
            </section>
          ) : (
            <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>Fundamental data is not available for this instrument.</p>
          )}
        </>
      )}

      {activeTab === 'quarterly' && (() => {
        // ── Quarterly Results — screener.in-backed ──────────────────────
        // Switched from Yahoo to screener.in for this view. Screener gives 13
        // consecutive quarters with no gaps (Yahoo's fundamentalsTimeSeries
        // randomly misses quarters for some Indian tickers — JIOFIN/HINDZINC
        // were both showing a missing Q2 FY26). Values arrive already in ₹ Cr.
        // Quarterly ↔ Yearly toggle. Both come from the same screener page;
        // yearly rows live under a different parser (`years`, FY-labelled).
        const isYearly = resultPeriod === 'yearly';
        const activeData = isYearly ? screenerAnnual : screenerQuarterly;
        const activeRows = isYearly ? activeData?.years : activeData?.quarters;
        const activeError = isYearly ? screenerAnnualError : screenerError;
        const periodNoun = isYearly ? 'years' : 'quarters';
        // Yearly gets a slightly longer window (5 FYs) than quarterly (4 Qs).
        const windowSize = isYearly ? 5 : 4;

        const isReady = Array.isArray(activeRows);
        const quarters = isReady ? [...activeRows].sort((a, b) => a.sortKey - b.sortKey) : [];

        const labelFromQFy = (q, fy) => `Q${q} FY${String(fy).slice(-2)}`;

        // Build label → row and label → index maps. Screener rows carry their
        // own label (e.g. "Q3 FY26" or "FY26").
        const byLabel = {};
        const idxByLabel = {};
        quarters.forEach((row, i) => { byLabel[row.label] = row; idxByLabel[row.label] = i; });

        // Primary growth comparison base for a given period column:
        //  • quarterly → same quarter, previous year (handles gaps via label lookup)
        //  • yearly    → the immediately preceding fiscal year (prior column)
        const yoyBaseOf = (period) => {
          if (!period) return null;
          if (isYearly) {
            const i = idxByLabel[period.label];
            return (i != null && i > 0) ? quarters[i - 1] : null;
          }
          return byLabel[labelFromQFy(period.q, period.fy - 1)] || null;
        };

        // Visible window — the most recent `windowSize` periods screener reports.
        // YoY lookups below reach outside this window via byLabel/idxByLabel, so
        // sparse history elsewhere stays handled.
        const columns = quarters.slice(-windowSize);

        // Operating Margin: screener exposes OPM directly as `opm` (percent
        // already). Fall back to computed margin if absent.
        const opMarginOf = (row) => {
          if (!row) return null;
          if (row.opm != null) return row.opm;
          if (row.totalIncome && row.operatingProfit != null) return (row.operatingProfit / row.totalIncome) * 100;
          return null;
        };

        // ── Formatters ────────────────────────────────────────────────
        // Screener serves numbers already in ₹ Cr (no /1e7 needed, unlike Yahoo).
        // A true 0 is rendered as ₹0 Cr — screener's parser only yields 0 when
        // the company reported zero (blank cells arrive as null), and zero
        // revenue years are real (e.g. dormant shells like SIGMAADV FY24-25).
        const fmtCr = (v) => {
          if (v == null) return '—';
          return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: Math.abs(v) < 1000 ? 1 : 0 })} Cr`;
        };
        const fmtEPS = (v) => v == null ? '—' : `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
        const fmtPct = (v) => v == null ? '—' : `${v.toFixed(1)}%`;

        // Pair growth = computed once per cell, colour-graded by magnitude.
        const growthPill = (curr, prev) => {
          if (curr == null || prev == null || prev === 0) return null;
          const pct = ((curr - prev) / Math.abs(prev)) * 100;
          const positive = pct >= 0;
          const abs = Math.abs(pct);
          let color;
          if (abs < 5)        color = positive ? '#34d399' : '#fca5a5';
          else if (abs < 15)  color = positive ? '#10b981' : '#ef4444';
          else                color = positive ? '#059669' : '#dc2626';
          return {
            label: `${positive ? '↑' : '↓'}${abs.toFixed(1)}%`,
            color,
            weight: abs >= 15 ? 800 : 700,
          };
        };
        // Expenses use inverted polarity — rising is bad, falling is good.
        // Expense pill uses sign + colour (no arrow). Rising expenses are bad,
        // and an upward arrow next to a red number reads as a contradiction
        // because every other row treats ↑ as good. Sign carries direction,
        // colour carries sentiment — no visual conflict.
        const expensePill = (curr, prev) => {
          const p = growthPill(curr, prev);
          if (!p) return null;
          const rising = p.label.startsWith('↑');
          const abs = parseFloat(p.label.slice(1));
          let color;
          if (abs < 5)        color = rising ? '#fca5a5' : '#34d399';
          else if (abs < 15)  color = rising ? '#ef4444' : '#10b981';
          else                color = rising ? '#dc2626' : '#059669';
          return { ...p, label: `${rising ? '+' : '−'}${abs.toFixed(1)}%`, color };
        };
        // Margin uses a percentage-points pill instead of relative growth.
        const marginPill = (curr, prev) => {
          if (curr == null || prev == null) return null;
          const diff = curr - prev;
          const positive = diff >= 0;
          const abs = Math.abs(diff);
          let color;
          if (abs < 1)        color = positive ? '#34d399' : '#fca5a5';
          else if (abs < 5)   color = positive ? '#10b981' : '#ef4444';
          else                color = positive ? '#059669' : '#dc2626';
          return {
            label: `${positive ? '+' : '−'}${abs.toFixed(1)} pp`,
            color,
            weight: abs >= 5 ? 800 : 700,
          };
        };

        // Row spec mapped to screener.in field names.
        const hasInterest = columns.some(c => {
          const r = byLabel[c.label];
          return r && r.interest != null && r.interest > 0;
        });

        const rows = [
          { key: 'totalIncome',     label: 'Sales',            fmt: fmtCr,  get: r => r?.totalIncome,     pill: growthPill },
          { key: 'expenses',        label: 'Expenses',         fmt: fmtCr,  get: r => r?.expenses,        pill: expensePill },
          { key: 'operatingProfit', label: 'Operating Profit', fmt: fmtCr,  get: r => r?.operatingProfit, pill: growthPill },
          { key: 'operatingMargin', label: 'Operating Margin', fmt: fmtPct, get: r => opMarginOf(r),     pill: marginPill },
          ...(hasInterest ? [{ key: 'interest', label: 'Interest', fmt: fmtCr, get: r => r?.interest, pill: expensePill }] : []),
          { key: 'netProfit',       label: 'Net Profit',       fmt: fmtCr,  get: r => r?.netProfit,       pill: growthPill },
          { key: 'eps',             label: 'EPS',              fmt: fmtEPS, get: r => r?.eps,             pill: growthPill },
        ];

        // Sparkline data per row (4 numbers, one per visible column; nulls allowed).
        // Values are already in their natural units (₹ Cr or ₹ for EPS).
        const sparklineFor = (row) => columns.map(c => {
          const r = byLabel[c.label];
          const v = row.get(r);
          return { v: v == null ? null : v };
        });

        // Lightweight sparkline — no axes, no grid, just the line + endpoint dot.
        const Sparkline = ({ points, invert = false }) => {
          const valid = points.filter(p => p.v != null);
          if (valid.length < 2) {
            return <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>—</span>;
          }
          const last = valid[valid.length - 1].v;
          const first = valid[0].v;
          const rising = last >= first;
          const good = invert ? !rising : rising;
          const color = good ? '#10b981' : '#ef4444';
          return (
            <div style={{ width: '70px', height: '28px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={points}>
                  <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          );
        };

        // ── Quarterly Snapshot — auto-generated trend insights ─────────
        // Programmatic summary (no LLM): YoY hit-rate, margin trajectory,
        // profit direction, and any cautionary flags derived from the last
        // 4–8 quarters of screener data.
        const snapshot = (() => {
          if (quarters.length < 2) return null;
          const last4 = quarters.slice(-windowSize);
          const prev4 = quarters.slice(-2 * windowSize, -windowSize);

          // YoY hit-rate for sales over the visible window
          let salesYoYWins = 0, salesYoYConsidered = 0, latestSalesYoY = null;
          last4.forEach((q, i) => {
            const py = yoyBaseOf(q);
            if (py && py.totalIncome != null && q.totalIncome != null && py.totalIncome !== 0) {
              salesYoYConsidered += 1;
              const pct = ((q.totalIncome - py.totalIncome) / Math.abs(py.totalIncome)) * 100;
              if (pct > 0) salesYoYWins += 1;
              if (i === last4.length - 1) latestSalesYoY = pct;
            }
          });

          // OPM trajectory — two distinct comparisons kept separate:
          //  • card → latest quarter's OPM vs the trailing-4Q average, so the
          //           headline value matches the latest column in the grid below
          //           (component sync) instead of showing the 4Q mean itself.
          //  • flag → trailing-4Q average vs prior-4Q average (a smoother
          //           TTM-vs-TTM signal) used only for the compression warning.
          const avg = (arr) => {
            const v = arr.filter(x => x != null);
            return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
          };
          const opm4qAvg = avg(last4.map(opMarginOf));
          const opmPrev4qAvg = avg(prev4.map(opMarginOf));
          const opmTtmDelta = (opm4qAvg != null && opmPrev4qAvg != null) ? opm4qAvg - opmPrev4qAvg : null;
          const latestOpm = opMarginOf(last4[last4.length - 1]);
          const opmCardDelta = (latestOpm != null && opm4qAvg != null) ? latestOpm - opm4qAvg : null;
          // Latest *sequential* OPM move (QoQ for quarterly, prior-FY step for
          // yearly). The card headline above is "latest vs trailing-avg", which can
          // read green while the most recent move was down — we surface this so the
          // overview acknowledges a sequential dip instead of masking it.
          const prevPeriodRow = quarters.length >= 2 ? quarters[quarters.length - 2] : null;
          const prevPeriodOpm = opMarginOf(prevPeriodRow);
          const opmSeqDelta = (latestOpm != null && prevPeriodOpm != null) ? latestOpm - prevPeriodOpm : null;
          const opmSeqLabel = prevPeriodRow?.label || null;

          // Net Profit YoY hit-rate + latest YoY
          let npYoYWins = 0, npYoYConsidered = 0, latestNpYoY = null;
          last4.forEach((q, i) => {
            const py = yoyBaseOf(q);
            if (py && py.netProfit != null && q.netProfit != null && py.netProfit !== 0) {
              npYoYConsidered += 1;
              const pct = ((q.netProfit - py.netProfit) / Math.abs(py.netProfit)) * 100;
              if (pct > 0) npYoYWins += 1;
              if (i === last4.length - 1) latestNpYoY = pct;
            }
          });

          // Cautionary flags
          const flags = [];
          // Two consecutive YoY revenue declines
          if (last4.length >= 2) {
            const tail = last4.slice(-2);
            const declines = tail.filter(q => {
              const py = yoyBaseOf(q);
              return py && py.totalIncome != null && q.totalIncome != null && q.totalIncome < py.totalIncome;
            }).length;
            if (declines === 2) flags.push(`Revenue declined YoY in the last 2 ${periodNoun}`);
          }
          // Margin compression > 3pp (trailing-window avg vs prior-window avg)
          if (opmTtmDelta != null && opmTtmDelta < -3) {
            const periodNounSingular = isYearly ? 'year' : 'quarter';
            flags.push(`Operating margin compressed by ${Math.abs(opmTtmDelta).toFixed(1)}pp vs prior ${windowSize}-${periodNounSingular} average`);
          }
          // Net loss in latest period
          const latest = last4[last4.length - 1];
          if (latest?.netProfit != null && latest.netProfit < 0) {
            flags.push(`Net loss of ₹${Math.abs(latest.netProfit).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr in ${latest.label}`);
          }
          // Sharp interest-cost rise (>30% YoY) — debt-service signal
          if (latest?.interest != null) {
            const py = yoyBaseOf(latest);
            if (py?.interest != null && py.interest > 0) {
              const intYoY = ((latest.interest - py.interest) / Math.abs(py.interest)) * 100;
              if (intYoY > 30) flags.push(`Interest cost up ${intYoY.toFixed(0)}% YoY in ${latest.label}`);
            }
          }
          // EPS integrity — the implied share count (net profit ÷ EPS) should be
          // roughly stable quarter to quarter. A sharp jump usually means a
          // split/bonus changed the equity base, which screener's as-reported
          // EPS row may not retro-adjust — distorting the EPS trendline/sparkline.
          // We have no corporate-actions feed, so we DETECT and caveat rather than
          // silently restate (fabricating an adjustment factor would be worse).
          const impliedShares = (row) => {
            if (!row || row.eps == null || row.eps === 0 || row.netProfit == null) return null;
            return (row.netProfit * 1e7) / row.eps; // netProfit ₹Cr, eps ₹/share
          };
          const shareCounts = last4.map(impliedShares).filter(x => x != null && x > 0);
          if (shareCounts.length >= 2) {
            const maxSh = Math.max(...shareCounts);
            const minSh = Math.min(...shareCounts);
            if (maxSh / minSh > 1.2) {
              flags.push(`EPS may not be split/bonus-adjusted across these ${periodNoun} — the implied share base shifted; verify the EPS trend against exchange filings`);
            }
          }

          return {
            salesYoY: { wins: salesYoYWins, considered: salesYoYConsidered, latest: latestSalesYoY },
            opm: { latest: latestOpm, avg4q: opm4qAvg, prevAvg4q: opmPrev4qAvg, cardDelta: opmCardDelta, ttmDelta: opmTtmDelta, seqDelta: opmSeqDelta, seqLabel: opmSeqLabel },
            np: { wins: npYoYWins, considered: npYoYConsidered, latest: latestNpYoY },
            flags,
            latestLabel: latest?.label,
          };
        })();

        // Visual helpers for the snapshot cards
        const trendColor = (v, neutralBand = 0) => {
          if (v == null) return 'var(--text-secondary)';
          if (Math.abs(v) <= neutralBand) return 'var(--text-secondary)';
          return v > 0 ? '#10b981' : '#ef4444';
        };
        const arrow = (v, neutralBand = 0) => {
          if (v == null) return '·';
          if (Math.abs(v) <= neutralBand) return '→';
          return v > 0 ? '↑' : '↓';
        };

        return (
          <section className="glass-panel" style={{ marginTop: '1rem', padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
              <div>
                <h2 style={{ margin: 0 }}>{isYearly ? 'Annual Results' : 'Quarterly Results'}</h2>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {isYearly
                    ? `Last ${windowSize} fiscal years · YoY · Screener.in (standalone)`
                    : `Last ${windowSize} consecutive quarters · YoY · QoQ · Screener.in (standalone)`}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {/* Quarterly ↔ Yearly toggle */}
                <div role="tablist" aria-label="Results period" style={{ display: 'inline-flex', borderRadius: '8px', border: '1px solid var(--border)', overflow: 'hidden' }}>
                  {[['quarterly', 'Quarterly'], ['yearly', 'Yearly']].map(([key, label]) => {
                    const active = resultPeriod === key;
                    return (
                      <button
                        key={key}
                        role="tab"
                        aria-selected={active}
                        onClick={() => setResultPeriod(key)}
                        style={{
                          background: active ? 'var(--accent)' : 'transparent',
                          color: active ? '#04141f' : 'var(--text-secondary)',
                          border: 'none',
                          padding: '0.35rem 0.9rem',
                          cursor: 'pointer',
                          fontSize: '0.78rem',
                          fontWeight: active ? 700 : 500,
                          transition: 'all 0.15s',
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                {columns.length > 0 && (
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {columns[0].label} → {columns[columns.length - 1].label}
                  </span>
                )}
              </div>
            </div>

            {snapshot && (
              <div style={{
                marginBottom: '1.25rem',
                padding: '1rem 1.1rem',
                borderRadius: '10px',
                background: 'rgba(56,189,248,0.04)',
                border: '1px solid rgba(56,189,248,0.18)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {isYearly ? 'Annual Snapshot' : 'Quarterly Snapshot'}
                  </span>
                  {snapshot.latestLabel && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      · latest {snapshot.latestLabel}
                    </span>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
                  {/* Sales trend */}
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sales YoY</div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(snapshot.salesYoY.latest), marginTop: '0.2rem' }}>
                      {arrow(snapshot.salesYoY.latest)} {snapshot.salesYoY.latest == null ? '—' : `${snapshot.salesYoY.latest >= 0 ? '+' : ''}${snapshot.salesYoY.latest.toFixed(1)}%`}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                      {snapshot.salesYoY.considered > 0
                        ? `Grew in ${snapshot.salesYoY.wins} of last ${snapshot.salesYoY.considered} ${periodNoun}`
                        : 'Insufficient YoY history'}
                    </div>
                  </div>

                  {/* Operating margin trajectory */}
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>OPM Trajectory</div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(snapshot.opm.cardDelta, 0.5), marginTop: '0.2rem' }}>
                      {arrow(snapshot.opm.cardDelta, 0.5)} {snapshot.opm.cardDelta == null ? '—' : `${snapshot.opm.cardDelta >= 0 ? '+' : ''}${snapshot.opm.cardDelta.toFixed(1)} pp`}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                      {snapshot.opm.latest != null && snapshot.opm.avg4q != null
                        ? `${snapshot.opm.latest.toFixed(1)}% latest vs ${snapshot.opm.avg4q.toFixed(1)}% (${windowSize}${isYearly ? 'Y' : 'Q'} avg)`
                        : `Needs ≥ ${windowSize} ${periodNoun}`}
                    </div>
                    {/* Acknowledge a sequential move that contradicts the headline
                        (e.g. card reads "above average / green" but the latest
                        quarter actually slipped vs the prior one). */}
                    {snapshot.opm.seqDelta != null && snapshot.opm.cardDelta != null
                      && Math.abs(snapshot.opm.seqDelta) >= 0.5
                      && Math.sign(snapshot.opm.seqDelta) !== Math.sign(snapshot.opm.cardDelta) && (
                      <div style={{ fontSize: '0.68rem', color: '#fbbf24', marginTop: '0.2rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span>{snapshot.opm.seqDelta < 0 ? '↓' : '↑'}</span>
                        <span>
                          {`${Math.abs(snapshot.opm.seqDelta).toFixed(1)} pp ${isYearly ? 'YoY' : 'QoQ'}`}
                          {snapshot.latestLabel ? ` in ${snapshot.latestLabel}` : ''}
                          {snapshot.opm.seqDelta < 0 ? ' — latest cooled vs prior' : ' — latest improved vs prior'}
                          {snapshot.opm.seqLabel ? ` (${snapshot.opm.seqLabel})` : ''}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Net Profit trend */}
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Net Profit YoY</div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(snapshot.np.latest), marginTop: '0.2rem' }}>
                      {arrow(snapshot.np.latest)} {snapshot.np.latest == null ? '—' : `${snapshot.np.latest >= 0 ? '+' : ''}${snapshot.np.latest.toFixed(1)}%`}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                      {snapshot.np.considered > 0
                        ? `Grew in ${snapshot.np.wins} of last ${snapshot.np.considered} ${periodNoun}`
                        : 'Insufficient YoY history'}
                    </div>
                  </div>
                </div>

                {snapshot.flags.length > 0 && (
                  <div style={{ marginTop: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                    {snapshot.flags.map((f, i) => (
                      <div key={i} style={{
                        fontSize: '0.75rem',
                        color: '#fca5a5',
                        background: 'rgba(239,68,68,0.08)',
                        border: '1px solid rgba(239,68,68,0.22)',
                        padding: '0.3rem 0.55rem',
                        borderRadius: '6px',
                      }}>
                        ⚠ {f}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!isReady || columns.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: '1.5rem' }}>
                {activeError
                  ? `Screener.in data unavailable: ${activeError}`
                  : activeData == null
                    ? 'Loading from Screener.in…'
                    : `${isYearly ? 'Annual' : 'Quarterly'} comparison data is not available for this instrument.`}
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.9rem' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '0.65rem 0.75rem', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.5px', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                        Metric
                      </th>
                      {columns.map(col => (
                        <th key={col.label} style={{ textAlign: 'right', padding: '0.65rem 0.75rem', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.5px', borderBottom: '1px solid var(--border)' }}>
                          {col.label}
                        </th>
                      ))}
                      <th style={{ textAlign: 'right', padding: '0.65rem 0.75rem', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.5px', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                        Trend
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      const sparkPoints = sparklineFor(row);
                      return (
                        <tr key={row.key}>
                          <td style={{ textAlign: 'left', padding: '0.85rem 0.75rem', color: 'var(--text-primary)', fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            {row.label}
                          </td>
                          {columns.map((col, idx) => {
                            const currRow = byLabel[col.label];
                            const value = row.get(currRow);
                            // QoQ → prior column in the visible window (quarterly only)
                            const qoqCol = idx > 0 ? columns[idx - 1] : null;
                            const qoqValue = qoqCol ? row.get(byLabel[qoqCol.label]) : undefined;
                            // YoY → quarterly: same quarter previous year; yearly:
                            // the preceding fiscal year. Looked up regardless of visibility.
                            const yoyValue = row.get(yoyBaseOf(col));
                            const yoyPill = row.pill(value, yoyValue);
                            // Yearly's YoY already IS the sequential change, so the
                            // QoQ pill is dropped to avoid a redundant second figure.
                            const qoqPill = (!isYearly && qoqValue !== undefined) ? row.pill(value, qoqValue) : null;

                            return (
                              <td key={col.label} style={{ textAlign: 'right', padding: '0.85rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)', verticalAlign: 'top' }}>
                                <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                                  {row.fmt(value)}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.1rem', marginTop: '0.2rem', fontSize: '0.7rem' }}>
                                  {yoyPill ? (
                                    <span title="Year-on-Year" style={{ color: yoyPill.color, fontWeight: yoyPill.weight }}>
                                      <span style={{ color: 'var(--text-secondary)', fontWeight: 500, marginRight: '3px' }}>YoY</span>
                                      {yoyPill.label}
                                    </span>
                                  ) : (
                                    <span style={{ color: 'var(--text-secondary)' }}>YoY —</span>
                                  )}
                                  {!isYearly && (qoqPill ? (
                                    <span title="Quarter-on-Quarter" style={{ color: qoqPill.color, fontWeight: qoqPill.weight }}>
                                      <span style={{ color: 'var(--text-secondary)', fontWeight: 500, marginRight: '3px' }}>QoQ</span>
                                      {qoqPill.label}
                                    </span>
                                  ) : (
                                    idx > 0 && <span style={{ color: 'var(--text-secondary)' }}>QoQ —</span>
                                  ))}
                                </div>
                              </td>
                            );
                          })}
                          <td style={{ textAlign: 'right', padding: '0.85rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <div style={{ display: 'inline-block' }}>
                              <Sparkline points={sparkPoints} invert={row.key === 'expenses'} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  Source: screener.in (standalone, ₹ Cr). Operating Margin uses percentage-point change. {isYearly ? 'Annual figures show completed fiscal years (TTM column excluded).' : ''} Results refresh once every 12 hours.
                </div>
              </div>
            )}
          </section>
        );
      })()}

      {activeTab === 'cashflow' && (() => {
        // ── Annual cashflow — screener.in-backed (CFO/CFI/CFF/Net + FCF) ──
        // Indian companies file only annual standalone cashflow, so this is a
        // yearly series. Two sub-views (toggled like a tab): a grouped bar
        // chart and a full data table with YoY, trend sparklines, and a
        // programmatic quality snapshot.
        const years = Array.isArray(screenerCashflow?.years) ? screenerCashflow.years : [];
        const visible = years.slice(-8); // chart/table window (older years get unreadable)

        // Series metadata drives the legend help, chart bars, and table rows so
        // colours/labels live in one place. `chart:false` keeps Net out of the
        // 4-bar chart (it's a derived total) but still shows it in the table.
        const SERIES = [
          { key: 'operatingCashFlow', label: 'Operating (CFO)', color: 'var(--accent)',          chart: true,  help: 'Cash generated by core business operations — the engine of the business.' },
          { key: 'investingCashFlow', label: 'Investing (CFI)', color: '#a29bfe',                chart: true,  help: 'Cash spent on / received from investments (capex, acquisitions, asset sales). Negative is normal for a growing company.' },
          { key: 'financingCashFlow', label: 'Financing (CFF)', color: 'var(--danger)',          chart: true,  help: 'Cash from / returned to financiers (debt, equity, dividends, buybacks). Negative = returning cash to investors.' },
          { key: 'netCashFlow',       label: 'Net Cash Flow',   color: 'var(--text-secondary)', chart: false, help: 'CFO + CFI + CFF — the net change in cash for the year.' },
          { key: 'freeCashFlow',      label: 'Free Cash Flow',  color: 'var(--success)',         chart: true,  help: 'CFO minus capex — discretionary cash for dividends, buybacks, or debt paydown.' },
        ];

        // Local helpers — per-tab copies, matching how trendColor/arrow are
        // already duplicated across the P&L and Balance Sheet blocks.
        const fmtCr = (v) => {
          if (v == null) return '—';
          const sign = v < 0 ? '−' : '';
          return `${sign}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: Math.abs(v) < 1000 ? 1 : 0 })} Cr`;
        };
        const cfColor = (v) => v == null ? 'var(--text-secondary)' : v > 0 ? '#10b981' : v < 0 ? '#ef4444' : 'var(--text-primary)';
        const growthPill = (curr, prev) => {
          if (curr == null || prev == null || prev === 0) return null;
          const pct = ((curr - prev) / Math.abs(prev)) * 100;
          const positive = pct >= 0;
          const abs = Math.abs(pct);
          let color;
          if (abs < 5)        color = positive ? '#34d399' : '#fca5a5';
          else if (abs < 15)  color = positive ? '#10b981' : '#ef4444';
          else                color = positive ? '#059669' : '#dc2626';
          return { label: `${positive ? '↑' : '↓'}${abs.toFixed(1)}%`, color, weight: abs >= 15 ? 800 : 700 };
        };
        const trendColor = (v, band = 0) => v == null ? 'var(--text-secondary)' : Math.abs(v) <= band ? 'var(--text-secondary)' : v > 0 ? '#10b981' : '#ef4444';
        const arrow = (v, band = 0) => v == null ? '·' : Math.abs(v) <= band ? '→' : v > 0 ? '↑' : '↓';
        const Sparkline = ({ points }) => {
          const valid = points.filter(p => p.v != null);
          if (valid.length < 2) return <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>—</span>;
          const rising = valid[valid.length - 1].v >= valid[0].v;
          const color = rising ? '#10b981' : '#ef4444';
          return (
            <div style={{ width: '70px', height: '28px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={points}>
                  <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          );
        };

        // Cashflow-quality snapshot — pure arithmetic over the full series.
        const snap = (() => {
          if (years.length < 2) return null;
          const n = years.length;
          const latest = years[n - 1];
          const earliest = years[0];
          const fcfPos = years.filter(y => (y.freeCashFlow ?? 0) > 0).length;
          // CFO "covered" investing when CFO + CFI >= 0 (operating cash absorbed the investing outflow).
          const capexCov = years.filter(y => y.operatingCashFlow != null && y.investingCashFlow != null && (y.operatingCashFlow + y.investingCashFlow) >= 0).length;
          const cfoTrendPct = (earliest.operatingCashFlow != null && earliest.operatingCashFlow !== 0 && latest.operatingCashFlow != null)
            ? ((latest.operatingCashFlow - earliest.operatingCashFlow) / Math.abs(earliest.operatingCashFlow)) * 100 : null;
          let caution = null;
          if ((latest.operatingCashFlow ?? 0) < 0) caution = `Operating cash flow was negative in ${latest.fyLabel}`;
          else if ((latest.freeCashFlow ?? 0) < 0) caution = `Free cash flow was negative in ${latest.fyLabel}`;
          return { n, fcfPos, capexCov, cfoTrendPct, range: `${earliest.fyLabel}–${latest.fyLabel}`, caution };
        })();

        const empty = visible.length === 0;
        const cardStyle = { flex: '1 1 160px', padding: '0.85rem 1rem', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid var(--border)' };
        const cardLabel = { fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' };

        return (
          <>
          <section className="glass-panel" style={{ marginTop: '1rem', padding: '1.5rem' }}>
            {/* Header + Chart/Table toggle */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <h2 style={{ margin: 0 }}>Cashflow Analysis</h2>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Annual cashflow statement · Screener.in (standalone, ₹ Cr)
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <button
                  onClick={() => setCashflowHelpOpen(true)}
                  title="What do these cash-flow terms mean?"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-secondary)', padding: '0.35rem 0.7rem', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}
                >
                  <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '15px', height: '15px', borderRadius: '50%', border: '1px solid currentColor', fontSize: '0.62rem', fontWeight: 800, lineHeight: 1 }}>?</span>
                  Legend
                </button>
                <div role="tablist" aria-label="Cashflow view" style={{ display: 'inline-flex', borderRadius: '8px', border: '1px solid var(--border)', overflow: 'hidden' }}>
                  {[['chart', 'Chart'], ['table', 'Table']].map(([key, label]) => {
                    const active = cashflowView === key;
                    return (
                      <button
                        key={key}
                        role="tab"
                        aria-selected={active}
                        onClick={() => setCashflowView(key)}
                        style={{ background: active ? 'var(--accent)' : 'transparent', color: active ? '#04141f' : 'var(--text-secondary)', border: 'none', padding: '0.35rem 0.9rem', cursor: 'pointer', fontSize: '0.78rem', fontWeight: active ? 700 : 500, transition: 'all 0.15s' }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                {visible.length > 0 && (
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {visible[0].fyLabel} → {visible[visible.length - 1].fyLabel}
                  </span>
                )}
              </div>
            </div>

            {empty ? (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                {screenerCashflowError
                  ? `Cashflow unavailable: ${screenerCashflowError}`
                  : screenerCashflow == null ? 'Loading from Screener.in…' : 'Cashflow data is not available for this instrument.'}
              </p>
            ) : cashflowView === 'chart' ? (
              <div style={{ height: '360px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={visible} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="fyLabel" stroke="var(--text-secondary)" />
                    <YAxis
                      stroke="var(--text-secondary)"
                      tickFormatter={(val) => `₹${val.toLocaleString('en-IN', { maximumFractionDigits: 0 })}Cr`}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'var(--bg-dark)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                      formatter={(value, name) => [
                        value == null ? '—' : `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`,
                        name,
                      ]}
                      labelFormatter={(label) => `Fiscal Year ${label}`}
                    />
                    <Legend />
                    {SERIES.filter(s => s.chart).map(s => (
                      <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <>
                {/* Quality snapshot */}
                {snap && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.25rem' }}>
                    <div style={cardStyle}>
                      <div style={cardLabel}>FCF Track Record</div>
                      <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(snap.fcfPos * 2 - snap.n), marginTop: '0.2rem' }}>
                        {snap.fcfPos} / {snap.n} yrs
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Free cash flow positive</div>
                    </div>
                    <div style={cardStyle}>
                      <div style={cardLabel}>CFO Trend</div>
                      <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(snap.cfoTrendPct, 1), marginTop: '0.2rem' }}>
                        {arrow(snap.cfoTrendPct, 1)} {snap.cfoTrendPct == null ? '—' : `${snap.cfoTrendPct >= 0 ? '+' : ''}${snap.cfoTrendPct.toFixed(0)}%`}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Operating cash · {snap.range}</div>
                    </div>
                    <div style={cardStyle}>
                      <div style={cardLabel}>Capex Coverage</div>
                      <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(snap.capexCov * 2 - snap.n), marginTop: '0.2rem' }}>
                        {snap.capexCov} / {snap.n} yrs
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>CFO covered investing</div>
                    </div>
                  </div>
                )}
                {snap?.caution && (
                  <div style={{ marginBottom: '1rem', padding: '0.6rem 0.9rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '8px', fontSize: '0.78rem', color: '#fca5a5' }}>
                    ⚠ {snap.caution}
                  </div>
                )}

                {/* Data table */}
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.9rem' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: '0.65rem 0.75rem', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.5px', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                          Cash Flow
                        </th>
                        {visible.map(col => (
                          <th key={col.fyLabel} style={{ textAlign: 'right', padding: '0.65rem 0.75rem', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.5px', borderBottom: '1px solid var(--border)' }}>
                            {col.fyLabel}
                          </th>
                        ))}
                        <th style={{ textAlign: 'right', padding: '0.65rem 0.75rem', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.5px', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                          Trend
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {SERIES.map(s => {
                        const sparkPoints = visible.map(y => ({ v: y[s.key] ?? null }));
                        return (
                          <tr key={s.key}>
                            <td style={{ textAlign: 'left', padding: '0.85rem 0.75rem', color: 'var(--text-primary)', fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                              <span style={{ display: 'inline-block', width: '9px', height: '9px', borderRadius: '2px', background: s.color, marginRight: '0.5rem', border: s.key === 'netCashFlow' ? '1px solid var(--text-secondary)' : 'none' }} />
                              {s.label}
                            </td>
                            {visible.map((col, idx) => {
                              const value = col[s.key] ?? null;
                              const prev = idx > 0 ? (visible[idx - 1][s.key] ?? null) : null;
                              const pill = growthPill(value, prev);
                              return (
                                <td key={col.fyLabel} style={{ textAlign: 'right', padding: '0.85rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)', verticalAlign: 'top' }}>
                                  <div style={{ color: cfColor(value), fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                                    {fmtCr(value)}
                                  </div>
                                  <div style={{ marginTop: '0.2rem', fontSize: '0.7rem', textAlign: 'right' }}>
                                    {pill ? (
                                      <span title="Year-on-Year" style={{ color: pill.color, fontWeight: pill.weight }}>
                                        <span style={{ color: 'var(--text-secondary)', fontWeight: 500, marginRight: '3px' }}>YoY</span>{pill.label}
                                      </span>
                                    ) : (
                                      <span style={{ color: 'var(--text-secondary)' }}>YoY —</span>
                                    )}
                                  </div>
                                </td>
                              );
                            })}
                            <td style={{ textAlign: 'right', padding: '0.85rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                              <div style={{ display: 'inline-block' }}><Sparkline points={sparkPoints} /></div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div style={{ marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                    Source: screener.in (standalone, ₹ Cr). Net = CFO + CFI + CFF. Free Cash Flow = CFO − capex. Refreshes every 12h.
                  </div>
                </div>
              </>
            )}
          </section>

          {/* Legend help modal — opened by the “? Legend” button in the header.
              Rendered as a sibling of (not inside) the glass-panel: that class
              has backdrop-filter + a hover transform, which would otherwise trap
              the position:fixed overlay inside the panel. */}
          {cashflowHelpOpen && (
            <div className="conv-modal-backdrop" onClick={() => setCashflowHelpOpen(false)}>
              <div className="conv-modal" style={{ width: '560px', maxWidth: '100%' }} onClick={(e) => e.stopPropagation()}>
                <div className="conv-modal-header">
                  <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Cashflow legend</h2>
                  <button className="conv-modal-close" onClick={() => setCashflowHelpOpen(false)} aria-label="Close">✕</button>
                </div>
                <div className="conv-modal-body">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {SERIES.map(s => (
                      <div key={s.key} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }}>
                        <span style={{ width: '12px', height: '12px', borderRadius: '3px', background: s.color, marginTop: '3px', flexShrink: 0, border: s.key === 'netCashFlow' ? '1px solid var(--text-secondary)' : 'none' }} />
                        <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                          <strong style={{ color: 'var(--text-primary)' }}>{s.label}</strong> — {s.help}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)', fontSize: '0.72rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                    Net = CFO + CFI + CFF · Free Cash Flow = CFO − capex · Annual, standalone (₹ Cr).
                  </div>
                </div>
              </div>
            </div>
          )}
          </>
        );
      })()}

      {activeTab === 'balanceSheet' && (() => {
        // ── Annual balance sheet — screener.in-backed (consolidated) ────
        // Server defaults to /company/<SLUG>/consolidated/ and falls back to
        // standalone when consolidated is missing. Latest year is rightmost
        // so the eye reads left → right as oldest → newest.
        const years = Array.isArray(screenerBalanceSheet?.years)
          ? [...screenerBalanceSheet.years].sort((a, b) => a.sortKey - b.sortKey)
          : [];
        const basis = screenerBalanceSheet?.basis;

        // Rows to display in order. Each row is { key, label, group } where
        // group is 'liab' / 'asset' / 'derived' for sectioning.
        const ROWS = [
          { key: 'equityCapital',     label: 'Equity Capital',     group: 'liab' },
          { key: 'reserves',          label: 'Reserves',           group: 'liab' },
          { key: 'netWorth',          label: 'Net Worth',          group: 'liab', emphasis: true },
          { key: 'borrowings',        label: 'Borrowings',         group: 'liab' },
          { key: 'deposits',          label: 'Deposits',           group: 'liab' },
          { key: 'otherLiabilities',  label: 'Other Liabilities',  group: 'liab' },
          { key: 'totalLiabilities',  label: 'Total Equity & Liabilities',  group: 'liab', emphasis: true },
          { key: 'fixedAssets',       label: 'Fixed Assets',       group: 'asset' },
          { key: 'cwip',              label: 'CWIP',               group: 'asset' },
          { key: 'investments',       label: 'Investments',        group: 'asset' },
          { key: 'loans',             label: 'Loans',              group: 'asset' },
          { key: 'otherAssets',       label: 'Other Assets',       group: 'asset' },
          { key: 'totalAssets',       label: 'Total Assets',       group: 'asset', emphasis: true },
        ];

        const hasAnyValue = (key) => years.some(y => y[key] != null);
        const visibleRows = ROWS.filter(r => hasAnyValue(r.key));

        const fmt = (v) => v == null
          ? <span style={{ color: 'var(--text-secondary)' }}>—</span>
          : v.toLocaleString('en-IN', { maximumFractionDigits: 0 });

        // YoY % change vs prior column. Shown as a small badge under the value
        // for emphasised rows (Net Worth, Total Liabilities, Total Assets).
        const yoy = (curr, prev) => {
          if (curr == null || prev == null || prev === 0) return null;
          return ((curr - prev) / Math.abs(prev)) * 100;
        };

        // ── Balance Sheet Snapshot — programmatic insights ─────────────
        // Derives leverage, capital-structure trend, capex signal, and any
        // cautionary flags from the multi-year series. No LLM, just arithmetic
        // over the parsed numbers so the conclusions match the visible data.
        const bsSnapshot = (() => {
          if (years.length < 2) return null;
          const latest = years[years.length - 1];
          const prior = years[years.length - 2];
          const earliest = years[0];

          // Leverage: prefer borrowings (corp) but fall back to deposits (bank)
          const debtField = latest.borrowings != null ? 'borrowings' : (latest.deposits != null ? 'deposits' : null);
          const debt = debtField ? latest[debtField] : null;
          const debtPrior = debtField ? prior[debtField] : null;

          const de = (debt != null && latest.netWorth != null && latest.netWorth !== 0)
            ? debt / latest.netWorth
            : null;
          const debtYoY = (debt != null && debtPrior != null && debtPrior !== 0)
            ? ((debt - debtPrior) / Math.abs(debtPrior)) * 100
            : null;

          // Net Worth CAGR over the visible range. Both endpoints must be
          // positive — CAGR is undefined when net worth crosses zero (you
          // can't compound from positive into negative), and Math.pow() of a
          // negative ratio to a fractional power returns NaN. The Vodafone
          // Idea case (₹23k Cr → -₹35k Cr) triggered exactly this. Caller
          // surfaces a "Turned negative" hint below when this returns null.
          const nwValidYears = years.filter(y => y.netWorth != null);
          const nwEarliest = nwValidYears.length > 0 ? nwValidYears[0] : null;
          const nwLatest = nwValidYears.length > 0 ? nwValidYears[nwValidYears.length - 1] : null;
          
          const nwCAGR = (() => {
            if (!nwEarliest || !nwLatest) return null;
            if (nwEarliest.netWorth <= 0 || nwLatest.netWorth <= 0) return null;
            const yrs = nwLatest.fy - nwEarliest.fy;
            if (yrs <= 0) return null;
            return {
              val: (Math.pow(nwLatest.netWorth / nwEarliest.netWorth, 1 / yrs) - 1) * 100,
              earliestLabel: nwEarliest.fyLabel,
              latestLabel: nwLatest.fyLabel
            };
          })();
          const nwTurnedNegative = (
            nwEarliest != null && nwLatest != null
            && nwEarliest.netWorth > 0 && nwLatest.netWorth <= 0
          );

          // Total Assets YoY (latest)
          const assetsYoY = (latest.totalAssets != null && prior.totalAssets != null && prior.totalAssets !== 0)
            ? ((latest.totalAssets - prior.totalAssets) / Math.abs(prior.totalAssets)) * 100
            : null;

          // CWIP YoY — large jumps signal an active capex cycle
          const cwipYoY = (latest.cwip != null && prior.cwip != null && prior.cwip > 0)
            ? ((latest.cwip - prior.cwip) / Math.abs(prior.cwip)) * 100
            : null;

          // ── Cautionary flags ─────────────────────────────────────────
          const flags = [];
          if (latest.netWorth != null && latest.netWorth < 0) {
            flags.push(`Negative net worth of ₹${Math.abs(latest.netWorth).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr — solvency risk`);
          }
          if (de != null && de > 2) {
            flags.push(`High leverage — D/E of ${de.toFixed(2)}× (debt ₹${debt.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr vs net worth ₹${latest.netWorth.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr)`);
          }
          if (debtYoY != null && debtYoY > 30) {
            flags.push(`${debtField === 'borrowings' ? 'Borrowings' : 'Deposits'} jumped +${debtYoY.toFixed(0)}% in ${latest.fyLabel}`);
          }
          // Net worth declining for 2+ consecutive years
          if (years.length >= 3) {
            const a = years[years.length - 3].netWorth;
            const b = prior.netWorth;
            const c = latest.netWorth;
            if (a != null && b != null && c != null && c < b && b < a) {
              flags.push(`Net worth declining for 2+ consecutive years (${years[years.length - 3].fyLabel} → ${latest.fyLabel})`);
            }
          }
          if (cwipYoY != null && cwipYoY > 100 && latest.cwip > 50) {
            flags.push(`CWIP ballooned +${cwipYoY.toFixed(0)}% — large capex cycle in progress, watch for execution risk`);
          }

          return { latest, debtField, debt, de, debtYoY, nwCAGR, nwTurnedNegative, assetsYoY, cwipYoY, flags };
        })();

        const trendColor = (v, band = 0) => {
          if (v == null) return 'var(--text-secondary)';
          if (Math.abs(v) <= band) return 'var(--text-secondary)';
          return v > 0 ? '#10b981' : '#ef4444';
        };
        const arrow = (v, band = 0) => {
          if (v == null) return '·';
          if (Math.abs(v) <= band) return '→';
          return v > 0 ? '↑' : '↓';
        };

        return (
          <section className="glass-panel" style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <h2 style={{ margin: 0 }}>Balance Sheet</h2>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Annual · Screener.in{basis ? ` (${basis}` : ''}{basis ? ', ₹ Cr)' : ' (₹ Cr)'}
                </span>
              </div>
              {years.length > 0 && (
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {years[0].fyLabel} → {years[years.length - 1].fyLabel}
                </span>
              )}
            </div>

            {years.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                {screenerBalanceSheetError
                  ? `Balance sheet unavailable: ${screenerBalanceSheetError}`
                  : screenerBalanceSheet == null ? 'Loading from Screener.in…' : 'Balance sheet data is not available for this instrument.'}
              </p>
            ) : (
              <>
                {bsSnapshot && (
                  <div style={{
                    marginBottom: '1.25rem',
                    padding: '1rem 1.1rem',
                    borderRadius: '10px',
                    background: 'rgba(56,189,248,0.04)',
                    border: '1px solid rgba(56,189,248,0.18)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                      <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Balance Sheet Snapshot
                      </span>
                      {bsSnapshot.latest?.fyLabel && (
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                          · latest {bsSnapshot.latest.fyLabel}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
                      {/* Leverage */}
                      <div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Debt-to-Equity</div>
                        <div style={{
                          fontSize: '1.05rem', fontWeight: 700, marginTop: '0.2rem',
                          color: bsSnapshot.de == null ? 'var(--text-secondary)'
                            : bsSnapshot.de > 2 ? '#ef4444'
                            : bsSnapshot.de > 1 ? '#f59e0b'
                            : '#10b981',
                        }}>
                          {bsSnapshot.de == null ? '—' : `${bsSnapshot.de.toFixed(2)}×`}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                          {bsSnapshot.debt != null && bsSnapshot.latest.netWorth != null
                            ? `₹${bsSnapshot.debt.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr ${bsSnapshot.debtField === 'borrowings' ? 'debt' : 'deposits'} / ₹${bsSnapshot.latest.netWorth.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr net worth`
                            : 'Insufficient data'}
                        </div>
                      </div>

                      {/* Net Worth CAGR */}
                      <div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Net Worth CAGR</div>
                        <div style={{
                          fontSize: '1.05rem', fontWeight: 700, marginTop: '0.2rem',
                          color: bsSnapshot.nwTurnedNegative ? '#ef4444' : trendColor(bsSnapshot.nwCAGR?.val, 0.5),
                        }}>
                          {bsSnapshot.nwTurnedNegative
                            ? '↓ n/a'
                            : bsSnapshot.nwCAGR == null
                              ? '—'
                              : `${arrow(bsSnapshot.nwCAGR.val, 0.5)} ${bsSnapshot.nwCAGR.val >= 0 ? '+' : ''}${bsSnapshot.nwCAGR.val.toFixed(1)}% /yr`}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                          {bsSnapshot.nwTurnedNegative
                            ? `Turned negative by ${bsSnapshot.latest.fyLabel}`
                            : bsSnapshot.nwCAGR != null
                              ? `${bsSnapshot.nwCAGR.earliestLabel} → ${bsSnapshot.nwCAGR.latestLabel}`
                              : 'Needs ≥ 2 years'}
                        </div>
                      </div>

                      {/* Debt trend */}
                      <div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{bsSnapshot.debtField === 'deposits' ? 'Deposits' : 'Debt'} YoY</div>
                        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(bsSnapshot.debtYoY == null ? null : -bsSnapshot.debtYoY, 2), marginTop: '0.2rem' }}>
                          {arrow(bsSnapshot.debtYoY, 0)} {bsSnapshot.debtYoY == null ? '—' : `${bsSnapshot.debtYoY >= 0 ? '+' : ''}${bsSnapshot.debtYoY.toFixed(1)}%`}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                          {bsSnapshot.debtYoY == null
                            ? 'Insufficient data'
                            : bsSnapshot.debtYoY > 0 ? 'Adding leverage' : 'Deleveraging'}
                        </div>
                      </div>

                      {/* Total Assets growth */}
                      <div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Total Assets YoY</div>
                        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: trendColor(bsSnapshot.assetsYoY, 0.5), marginTop: '0.2rem' }}>
                          {arrow(bsSnapshot.assetsYoY, 0.5)} {bsSnapshot.assetsYoY == null ? '—' : `${bsSnapshot.assetsYoY >= 0 ? '+' : ''}${bsSnapshot.assetsYoY.toFixed(1)}%`}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                          {bsSnapshot.cwipYoY != null && Math.abs(bsSnapshot.cwipYoY) > 10
                            ? `CWIP ${bsSnapshot.cwipYoY >= 0 ? '+' : ''}${bsSnapshot.cwipYoY.toFixed(0)}% — capex signal`
                            : 'Balance sheet expansion'}
                        </div>
                      </div>
                    </div>

                    {bsSnapshot.flags.length > 0 && (
                      <div style={{ marginTop: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                        {bsSnapshot.flags.map((f, i) => (
                          <div key={i} style={{
                            fontSize: '0.75rem',
                            color: '#fca5a5',
                            background: 'rgba(239,68,68,0.08)',
                            border: '1px solid rgba(239,68,68,0.22)',
                            padding: '0.3rem 0.55rem',
                            borderRadius: '6px',
                          }}>
                            ⚠ {f}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

              <div style={{ overflowX: 'auto' }}>
                <table className="interactive-table" style={{ minWidth: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', position: 'sticky', left: 0, background: 'var(--bg-card)', zIndex: 1 }}>Metric</th>
                      {years.map(y => (
                        <th key={y.sortKey} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{y.fyLabel}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map(row => (
                      <tr key={row.key} style={row.emphasis ? { background: 'rgba(56,189,248,0.04)', fontWeight: 700 } : undefined}>
                        <td style={{ position: 'sticky', left: 0, background: row.emphasis ? 'rgba(56,189,248,0.04)' : 'var(--bg-card)', zIndex: 1, fontWeight: row.emphasis ? 700 : 500 }}>
                          {row.label}
                        </td>
                        {years.map((y, i) => {
                          const v = y[row.key];
                          const prev = i > 0 ? years[i - 1][row.key] : null;
                          const delta = row.emphasis ? yoy(v, prev) : null;
                          return (
                            <td key={y.sortKey} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                              <div>{fmt(v)}</div>
                              {delta != null && (
                                <div className={delta >= 0 ? 'positive' : 'negative'} style={{ fontSize: '0.7rem', fontWeight: 500 }}>
                                  {delta >= 0 ? '+' : ''}{delta.toFixed(1)}%
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.75rem', marginBottom: 0 }}>
                  Net Worth = Equity Capital + Reserves. Total Equity &amp; Liabilities always equals Total Assets — that's the accounting identity, not a bug. Banks/NBFCs may report Deposits and Loans instead of Borrowings. Empty cells (—) mean the field wasn't disclosed for that year.
                </p>
              </div>
              </>
            )}
          </section>
        );
      })()}

      {activeTab === 'shareholding' && (
        <ShareholdingPanel
          payload={screenerShareholding}
          error={screenerShareholdingError}
        />
      )}

      <ConvictionModal stock={convictionStock} onClose={() => setConvictionStock(null)} />
      <TradePlanModal stock={tradePlanStock} onClose={() => setTradePlanStock(null)} />
    </div>
  )
}

export default Instrument
