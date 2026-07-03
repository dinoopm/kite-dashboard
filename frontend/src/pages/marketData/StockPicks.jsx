import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'

// ─── Quant Stock Picks ───────────────────────────────────────────────────────
// Deterministic factor ranking over the six market-data feeds for a chosen
// period (single-day snapshot OR multi-day lookback). The backend returns RAW
// per-stock factors; this page percentile-ranks them, applies user weights, and
// ranks client-side so the sliders re-rank instantly. ASM/GSM names are already
// excluded server-side; likely fake/HFT-inflated volume is down-weighted via a
// Volume-Authenticity score and flagged. The LLM brief only narrates the output.

const isoDay = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() - offset); return d.toISOString().slice(0, 10) }
const LOOKBACKS = [
  { key: '7d', label: 'Last 7 days', from: () => isoDay(7), to: () => isoDay(1) },
  { key: '30d', label: 'Last 30 days', from: () => isoDay(30), to: () => isoDay(1) },
  { key: '90d', label: 'Last 90 days', from: () => isoDay(90), to: () => isoDay(1) },
]
const FACTORS = [
  { key: 'momentum', raw: 'momentumRaw', label: 'Momentum', color: '#38bdf8', help: 'True 20-session return, skipping the latest week (short-term reversal adjusted). From the daily bhavcopy, ranked across the whole market.' },
  { key: 'volume', raw: 'volumeRaw', label: 'Volume', color: '#a78bfa', help: 'Last-week volume vs the stock\'s own 20-session baseline, authenticity-adjusted — price corroboration, persistence, churn and delivery % down-weight fake/intraday-churned volume.' },
  { key: 'fiftyTwo', raw: 'fiftyTwoRaw', label: '52-Wk', color: '#34d399', help: 'New 52-week highs + proximity to the 52-week high.' },
  { key: 'deals', raw: 'dealsRaw', label: 'Institutional', color: '#fbbf24', help: 'Net large-deal buy value + buyer breadth; round-tripped/offsetting deals (HFT churn) down-weighted by net-vs-gross conviction.' },
]
const DEFAULT_WEIGHTS = { momentum: 30, volume: 25, fiftyTwo: 20, deals: 25 }
const PRESETS = [
  { label: 'Balanced', w: DEFAULT_WEIGHTS },
  { label: 'Momentum', w: { momentum: 50, volume: 25, fiftyTwo: 15, deals: 10 } },
  { label: 'Breakout', w: { momentum: 25, volume: 25, fiftyTwo: 40, deals: 10 } },
  { label: 'Institutional', w: { momentum: 15, volume: 15, fiftyTwo: 10, deals: 60 } },
]

// Sliders/toggles survive reloads; the daily snapshot always uses DEFAULT_WEIGHTS.
const PREFS_KEY = 'stockPicks.prefs.v1'
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {} } catch { return {} } }

// Mid-rank percentile (0–100) of each value within the array. Ties share the
// MIDDLE of their block — most stocks sit at 0 on any given factor (e.g. no
// large deals), and max-rank ties would reward having no data at all.
function percentileRanks(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  return values.map(v => {
    let lo = 0, hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid }
    const first = lo // count of values < v
    hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid }
    return n ? ((first + lo) / 2 / n) * 100 : 0 // lo = count of values <= v
  })
}

// 'NSE:NIFTY ENERGY' -> 'Energy'; 'NSE:NIFTY FIN SERVICE' -> 'Fin Service'.
const fmtSector = (s) => (!s ? '—' : s.replace(/^NSE:NIFTY\s*/i, '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) || '—')
const fmtCr = (v) => {
  if (v == null) return '—'
  const n = Number(v)
  // small deals shouldn't round to "₹0 cr" — keep 2 significant digits under 10
  const opts = Math.abs(n) >= 10 ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 2 }
  return `₹${n.toLocaleString('en-IN', opts)} cr`
}
const fmtNet = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })} cr`)

// Value-based size buckets (₹ crore) — context for liquidity/manipulation risk.
const MCAP_TAGS = [
  { max: 500, label: 'micro', color: '#fca5a5' },
  { max: 5000, label: 'small', color: '#fbbf24' },
  { max: 20000, label: 'mid', color: '#38bdf8' },
  { max: Infinity, label: 'large', color: '#34d399' },
]
const mcapTag = (cr) => (cr == null ? null : MCAP_TAGS.find(t => cr < t.max))
const fmtMcap = (cr) => (cr == null ? '—' : `₹${Number(cr).toLocaleString('en-IN', { maximumFractionDigits: 0 })} cr`)

// Quality guardrail from Yahoo fundamentals — display only, never in the composite.
function qualityChip(m) {
  if (!m) return null
  const f = (v, mul = 1, suf = '') => (v == null ? '—' : `${(v * mul).toFixed(1)}${suf}`)
  const tip = `ROE ${f(m.roe, 100, '%')} · D/E ${m.debtToEquity != null ? (m.debtToEquity / 100).toFixed(2) : '—'} · net margin ${f(m.profitMargins, 100, '%')} · P/E ~${f(m.trailingPE)} (Yahoo TTM, can lag a quarter) — context only, not part of the score`
  // Leverage rules don't apply to banks/NBFCs — borrowing IS their business.
  const financial = /financial/i.test(m.sector || '')
  if (m.profitMargins != null && m.profitMargins < 0) return { color: '#fca5a5', tip, text: 'loss-making' }
  if (!financial && m.debtToEquity != null && m.debtToEquity > 150) return { color: '#fbbf24', tip, text: `debt-heavy · D/E ${(m.debtToEquity / 100).toFixed(1)}` }
  if (m.roe != null && m.roe >= 0.15 && (financial || m.debtToEquity == null || m.debtToEquity < 100)) return { color: '#34d399', tip, text: `quality · ROE ${Math.round(m.roe * 100)}%` }
  return null
}

function Chip({ color = 'var(--text-secondary)', title, children }) {
  return (
    <span title={title} style={{ fontSize: '0.67rem', color, border: '1px solid rgba(255,255,255,0.14)', borderRadius: '4px', padding: '0.05rem 0.35rem', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  )
}

function Bar({ pct, color }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '4px', height: '8px', width: '64px', overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(2, pct)}%`, height: '100%', background: color, borderRadius: '4px' }} />
    </div>
  )
}

export default function StockPicks() {
  const navigate = useNavigate()
  const prefs = useRef(loadPrefs()).current
  const [mode, setMode] = useState(prefs.mode === 'snapshot' ? 'snapshot' : 'lookback')
  const [lookback, setLookback] = useState(LOOKBACKS.some(l => l.key === prefs.lookback) ? prefs.lookback : '30d')
  const [snapDate, setSnapDate] = useState(isoDay(1))
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [weights, setWeights] = useState({ ...DEFAULT_WEIGHTS, ...(prefs.weights || {}) })
  const [topN, setTopN] = useState([10, 25, 50].includes(prefs.topN) ? prefs.topN : 25)
  const [excludeTraps, setExcludeTraps] = useState(prefs.excludeTraps !== false)
  const [hideMicro, setHideMicro] = useState(prefs.hideMicro === true)
  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ mode, lookback, weights, topN, excludeTraps, hideMicro })) } catch { /* private mode */ }
  }, [mode, lookback, weights, topN, excludeTraps, hideMicro])
  const [summary, setSummary] = useState(null)
  const [summarizing, setSummarizing] = useState(false)
  const [metaMap, setMetaMap] = useState({}) // symbol -> { sector, name } (Yahoo, resolved for visible rows)
  const metaReqRef = useRef(new Set())
  const [held, setHeld] = useState(() => new Set()) // tradingsymbols in Kite holdings
  const [history, setHistory] = useState(null)      // { available, dates: [{date, picks}] } newest-first

  // Portfolio overlap: mark picks already held (MCP result → { content:[{text}] }).
  useEffect(() => {
    fetch('/api/holdings').then(r => r.json()).then(j => {
      let arr = j
      if (typeof j?.content?.[0]?.text === 'string') arr = JSON.parse(j.content[0].text)
      arr = arr?.data || arr
      if (Array.isArray(arr)) setHeld(new Set(arr.map(h => h.tradingsymbol).filter(Boolean)))
    }).catch(() => { })
  }, [])

  useEffect(() => {
    fetch('/api/stock-picks/history?days=45').then(r => r.json()).then(setHistory).catch(() => { })
  }, [])

  // Diff of the two latest daily snapshots (default weights) + top-25 streaks.
  const hist = useMemo(() => {
    const dates = history?.dates || []
    if (!dates.length) return null
    const [latest, prev] = dates
    const latestSet = new Set(latest.picks.map(p => p.symbol))
    const prevSet = prev ? new Set(prev.picks.map(p => p.symbol)) : null
    const entrants = prevSet ? latest.picks.filter(p => !prevSet.has(p.symbol)) : []
    const dropouts = prevSet ? prev.picks.filter(p => !latestSet.has(p.symbol)) : []
    const prevTop10 = new Set(prev ? prev.picks.filter(p => p.rank <= 10).map(p => p.symbol) : [])
    const newTop10 = new Set(prev ? latest.picks.filter(p => p.rank <= 10 && !prevTop10.has(p.symbol)).map(p => p.symbol) : [])
    const streaks = {}
    for (const p of latest.picks) {
      let n = 0
      for (const d of dates) { if (d.picks.some(q => q.symbol === p.symbol)) n++; else break }
      streaks[p.symbol] = n
    }
    return { latest, prev, entrants, dropouts, newTop10, streaks }
  }, [history])
  const [sort, setSort] = useState({ key: 'composite', dir: 'desc' }) // table display sort

  // Resolve symbol → Kite instrument_token before opening the instrument page,
  // otherwise the technical chart (which needs the token) won't load. Cached.
  const tokenCacheRef = useRef(new Map())
  const openInstrument = useCallback(async (symbol) => {
    if (!symbol) return
    const go = (tok) => navigate(`/instrument/${tok}?symbol=${encodeURIComponent(symbol)}`)
    const cached = tokenCacheRef.current.get(symbol)
    if (cached) return go(cached)
    try {
      const r = await fetch(`/api/instrument-info/${encodeURIComponent(symbol)}`)
      const info = r.ok ? await r.json() : null
      const token = info?.instrument_token
      if (token) { tokenCacheRef.current.set(symbol, token); return go(token) }
    } catch { /* fall through */ }
    go(0) // soft-fall: page still loads quote/fundamentals; only the chart needs the token
  }, [navigate])

  const period = useMemo(() => {
    if (mode === 'snapshot') return { from: snapDate, to: snapDate }
    const lb = LOOKBACKS.find(l => l.key === lookback)
    return { from: lb.from(), to: lb.to() }
  }, [mode, lookback, snapDate])

  const load = useCallback(async () => {
    setLoading(true); setError(null); setSummary(null)
    try {
      const qs = period.from === period.to ? `date=${period.from}` : `from=${period.from}&to=${period.to}`
      const r = await fetch(`/api/stock-picks?${qs}`)
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setData(j)
    } catch (e) { setError(e.message); setData(null) } finally { setLoading(false) }
  }, [period])
  useEffect(() => { load() }, [load])

  // Client-side: percentile-rank each factor, weight, rank.
  const ranked = useMemo(() => {
    if (!data?.stocks?.length) return []
    const stocks = excludeTraps ? data.stocks.filter(s => !s.factors.trapRisk) : data.stocks
    const cols = {}
    for (const f of FACTORS) cols[f.key] = percentileRanks(stocks.map(s => s.factors[f.raw] ?? 0))
    const sumW = FACTORS.reduce((a, f) => a + (weights[f.key] || 0), 0) || 1
    const rows = stocks.map((s, i) => {
      const pct = {}; let composite = 0
      for (const f of FACTORS) { pct[f.key] = cols[f.key][i]; composite += (weights[f.key] / sumW) * pct[f.key] }
      return { ...s, pct, composite }
    })
    rows.sort((a, b) => b.composite - a.composite)
    return rows.map((r, i) => ({ ...r, rank: i + 1 }))
  }, [data, weights, excludeTraps])

  const top = ranked.slice(0, topN)

  // Display sort — reorders the top-N set only (the picks & AI brief stay by
  // composite). Strings sort A→Z by default, numbers high→low.
  const sortVal = (r, key) => {
    if (key === 'symbol') return r.symbol
    if (key === 'sector') return (metaMap[r.symbol]?.sector || fmtSector(r.sector) || '')
    if (key === 'composite') return r.composite
    if (key === 'mcap') return metaMap[r.symbol]?.marketCapCr ?? -1
    return r.pct[key] ?? 0
  }
  const displayed = useMemo(() => {
    // hide-micro is a display filter on the ranked set (unknown mcap stays visible)
    const arr = hideMicro
      ? top.filter(r => { const cr = metaMap[r.symbol]?.marketCapCr; return cr == null || cr >= 500 })
      : [...top]
    arr.sort((a, b) => {
      const av = sortVal(a, sort.key), bv = sortVal(b, sort.key)
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top, sort, metaMap, hideMicro])
  const toggleSort = (key) => setSort(s => s.key === key
    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: (key === 'symbol' || key === 'sector') ? 'asc' : 'desc' })
  const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '')

  // The engine's sector/name (from sector_constituents) only covers index
  // members, so resolve real sector + company name (Yahoo, like the screener)
  // for the visible rows on demand. Cached across periods (both are static).
  useEffect(() => {
    const missing = ranked.slice(0, topN).map(r => r.symbol).filter(s => !metaReqRef.current.has(s))
    if (!missing.length) return
    missing.forEach(s => metaReqRef.current.add(s))
    fetch('/api/stock-picks/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbols: missing }) })
      .then(r => r.json()).then(m => setMetaMap(prev => ({ ...prev, ...m }))).catch(() => { })
  }, [ranked, topN])

  // Crowding check: warn when one sector dominates the visible top-N.
  const sectorWarn = useMemo(() => {
    if (top.length < 10) return null
    const counts = {}
    for (const r of top) {
      const s = metaMap[r.symbol]?.sector || fmtSector(r.sector)
      if (s && s !== '—') counts[s] = (counts[s] || 0) + 1
    }
    const [name, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || []
    const share = n ? n / top.length : 0
    return share >= 0.4 ? { name, share: Math.round(share * 100) } : null
  }, [top, metaMap])

  const exportCsv = () => {
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const head = ['rank', 'symbol', 'name', 'sector', 'market_cap_cr', 'composite', 'momentum_pct', 'volume_pct', 'fifty_two_pct', 'deals_pct', 'gainer_days', 'loser_days', 'made_new_high', 'vol_authenticity', 'deals_net_cr', 'trap_risk', 'held', 'roe', 'debt_to_equity', 'net_margin', 'pe', 'last_ltp']
    const lines = [head.join(',')]
    for (const r of displayed) {
      const m = metaMap[r.symbol] || {}
      lines.push([
        r.rank, r.symbol, m.name || r.name, m.sector || fmtSector(r.sector), m.marketCapCr,
        r.composite.toFixed(1), Math.round(r.pct.momentum), Math.round(r.pct.volume), Math.round(r.pct.fiftyTwo), Math.round(r.pct.deals),
        r.factors.gainerDays, r.factors.loserDays, r.factors.madeNewHigh, r.factors.authenticity,
        r.factors.dealsNetValueCr, r.factors.trapRisk, held.has(r.symbol),
        m.roe != null ? (m.roe * 100).toFixed(1) : null, m.debtToEquity != null ? (m.debtToEquity / 100).toFixed(2) : null,
        m.profitMargins != null ? (m.profitMargins * 100).toFixed(1) : null, m.trailingPE != null ? m.trailingPE.toFixed(1) : null,
        r.lastLtp,
      ].map(esc).join(','))
    }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    a.download = `stock-picks_${period.from}_${period.to}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // Forward-return validation (backend reconstructs past picks vs what happened).
  const [bt, setBt] = useState(null)
  const [btLoading, setBtLoading] = useState(false)
  const [btError, setBtError] = useState(null)
  const runValidation = async () => {
    setBtLoading(true); setBtError(null)
    try {
      const r = await fetch('/api/stock-picks/backtest')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setBt(j)
    } catch (e) { setBtError(e.message) } finally { setBtLoading(false) }
  }

  const genSummary = async () => {
    setSummarizing(true); setSummary(null)
    try {
      const picks = top.slice(0, 25).map(r => ({
        rank: r.rank, symbol: r.symbol, composite: +r.composite.toFixed(1),
        momentumPct: Math.round(r.pct.momentum), volumePct: Math.round(r.pct.volume),
        fiftyTwoPct: Math.round(r.pct.fiftyTwo), dealsPct: Math.round(r.pct.deals),
        gainerDays: r.factors.gainerDays, loserDays: r.factors.loserDays,
        mom20_5Pct: r.factors.mom205Pct, volSurgePct: r.factors.volSurgePct,
        madeNewHigh: r.factors.madeNewHigh, authenticity: r.factors.authenticity,
        dealsNetValueCr: r.factors.dealsNetValueCr, trapRisk: r.factors.trapRisk, trapReason: r.factors.trapReason,
        dealChurn: r.factors.dealChurn, dealChurnReason: r.factors.dealChurnReason,
        circuitLadder: r.factors.circuitLadder, circuitReason: r.factors.circuitReason,
        distribution: r.factors.distribution, distributionReason: r.factors.distributionReason,
        deliveryPct: r.factors.deliveryPct,
      }))
      const r = await fetch('/api/stock-picks/summary', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: data.period, regime: data.regime, weights, picks }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setSummary(j.summary)
    } catch (e) { setSummary(`*Failed to generate brief: ${e.message}*`) } finally { setSummarizing(false) }
  }

  const regime = data?.regime
  const riskOff = regime && (regime.score != null ? regime.score < 0 : regime.totalNet < -5000)
  const btn = (active) => ({ padding: '0.4rem 0.9rem', borderRadius: '8px', cursor: 'pointer', fontSize: '0.82rem', fontWeight: active ? 700 : 500, border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, background: active ? 'var(--accent)' : 'transparent', color: active ? '#04141f' : 'var(--text-secondary)' })

  return (
    <div style={{ padding: '0.5rem 0' }}>
      <h2 style={{ margin: '0 0 0.25rem' }}>Quant Stock Picks</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 1.25rem', maxWidth: '900px' }}>
        Deterministic factor ranking from FII/DII, large deals, 52-week highs, top gainers and volume gainers for a chosen period.
        Surveillance (ASM/GSM) names are excluded; likely fake/HFT-inflated volume is down-weighted and flagged. Adjust the factor
        weights to re-rank instantly. <strong>For research only — not investment advice.</strong>
      </p>

      {/* Period controls */}
      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={() => setMode('lookback')} style={btn(mode === 'lookback')}>Lookback</button>
          <button onClick={() => setMode('snapshot')} style={btn(mode === 'snapshot')}>Snapshot</button>
        </div>
        {mode === 'lookback' ? (
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {LOOKBACKS.map(l => <button key={l.key} onClick={() => setLookback(l.key)} style={btn(lookback === l.key)}>{l.label}</button>)}
          </div>
        ) : (
          <input type="date" value={snapDate} max={isoDay(0)} onChange={e => setSnapDate(e.target.value)}
            style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', padding: '0.4rem 0.7rem', fontSize: '0.85rem' }} />
        )}
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          {period.from === period.to ? period.from : `${period.from} → ${period.to}`}
        </span>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={excludeTraps} onChange={e => setExcludeTraps(e.target.checked)} style={{ accentColor: '#ef4444' }} />
          Exclude volume-trap names
        </label>
        <label title="Display filter on the visible rows — names with unknown market cap stay visible" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={hideMicro} onChange={e => setHideMicro(e.target.checked)} style={{ accentColor: '#fca5a5' }} />
          Hide micro-caps (&lt;₹500 cr)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          Top
          <select value={topN} onChange={e => setTopN(+e.target.value)} style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', padding: '0.25rem 0.4rem' }}>
            {[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      {/* Weight sliders */}
      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.75rem' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)', marginRight: '0.5rem' }}>Presets</span>
          {PRESETS.map(p => {
            const active = FACTORS.every(f => weights[f.key] === p.w[f.key])
            return <button key={p.label} onClick={() => setWeights({ ...p.w })} style={{ ...btn(active), padding: '0.25rem 0.7rem', fontSize: '0.75rem' }}>{p.label}</button>
          })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
        {FACTORS.map(f => (
          <label key={f.key} title={f.help} style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              <span style={{ display: 'inline-block', width: '9px', height: '9px', borderRadius: '2px', background: f.color, marginRight: '0.4rem' }} />
              {f.label} weight <strong style={{ color: 'var(--text-primary)' }}>{weights[f.key]}</strong>
            </span>
            <input type="range" min="0" max="100" step="5" value={weights[f.key]}
              onChange={e => setWeights(w => ({ ...w, [f.key]: +e.target.value }))} style={{ accentColor: f.color }} />
          </label>
        ))}
        </div>
      </div>

      {/* Regime banner */}
      {regime && (
        <div className="glass-panel" style={{ padding: '0.85rem 1.25rem', marginBottom: '1rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center', border: `1px solid ${riskOff ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.25)'}` }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: riskOff ? '#fca5a5' : '#6ee7b7' }}>Market Regime</span>
          <span style={{ fontWeight: 700 }}>{regime.label}</span>
          <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>FII {fmtNet(regime.fiiNet)} · DII {fmtNet(regime.diiNet)} · Net {fmtNet(regime.totalNet)}</span>
          {regime.derivatives && (
            <span title={`FII index-futures positioning as of ${regime.derivatives.date}: ${regime.derivatives.futLong?.toLocaleString('en-IN')} long / ${regime.derivatives.futShort?.toLocaleString('en-IN')} short contracts (Δ net ${regime.derivatives.deltaNet?.toLocaleString('en-IN')} over the period)`}
              style={{ fontSize: '0.82rem', color: regime.derivatives.lean === 'net long' ? '#6ee7b7' : regime.derivatives.lean === 'net short' ? '#fca5a5' : 'var(--text-secondary)' }}>
              FII idx-fut {regime.derivatives.lean} · L/S {regime.derivatives.ratio ?? '—'}
            </span>
          )}
          {data && <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{data.universeSize} stocks · {data.excludedCount} surveillance excluded</span>}
        </div>
      )}

      {/* Daily-snapshot diff (default weights) — what changed since the last snapshot */}
      {hist?.prev && (
        <div className="glass-panel" style={{ padding: '0.85rem 1.25rem', marginBottom: '1rem', fontSize: '0.8rem', display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)' }}
            title="Daily default-weight top-25 snapshots — independent of your slider settings">
            Snapshot {hist.latest.date} vs {hist.prev.date}
          </span>
          <span>
            New:{' '}
            {hist.entrants.length ? hist.entrants.map((p, i) => (
              <span key={p.symbol}>{i > 0 && ', '}<span onClick={() => openInstrument(p.symbol)} style={{ color: '#6ee7b7', fontWeight: 700, cursor: 'pointer' }}>{p.symbol}</span><span style={{ color: 'var(--text-secondary)' }}> #{p.rank}</span></span>
            )) : <span style={{ color: 'var(--text-secondary)' }}>none</span>}
          </span>
          <span>
            Dropped:{' '}
            {hist.dropouts.length ? hist.dropouts.map((p, i) => (
              <span key={p.symbol}>{i > 0 && ', '}<span onClick={() => openInstrument(p.symbol)} style={{ color: '#fca5a5', cursor: 'pointer' }}>{p.symbol}</span></span>
            )) : <span style={{ color: 'var(--text-secondary)' }}>none</span>}
          </span>
          {hist.newTop10.size > 0 && (
            <span style={{ color: '#fbbf24', fontWeight: 700 }}>⚡ New in top 10: {[...hist.newTop10].join(', ')}</span>
          )}
        </div>
      )}
      {history?.available === false && (
        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0 0 1rem', fontStyle: 'italic' }}>
          Pick history is off — {history.hint}
        </p>
      )}

      {loading ? <div className="loader" /> : error ? (
        <div className="glass-panel" style={{ padding: '1.5rem', color: '#ef4444' }}>Failed to load: {error}</div>
      ) : !top.length ? (
        <div className="glass-panel" style={{ padding: '1.5rem', color: 'var(--text-secondary)' }}>No stocks for this period. Try a wider lookback or a different date.</div>
      ) : (
        <>
          {/* AI brief + export + crowding warning */}
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <button onClick={genSummary} disabled={summarizing} style={{ ...btn(false), background: summarizing ? 'rgba(56,189,248,0.2)' : 'var(--accent)', color: summarizing ? 'var(--text-secondary)' : '#04141f', fontWeight: 700 }}>
              {summarizing ? 'Generating…' : '✨ Generate AI brief'}
            </button>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Narrates the deterministic top {Math.min(topN, 25)} — does not change the ranking.</span>
            <button onClick={exportCsv} style={{ ...btn(false), marginLeft: 'auto' }}>⬇ CSV</button>
            {sectorWarn && (
              <span title="Crowded momentum in one sector is a concentration risk — the composite doesn't penalize it"
                style={{ fontSize: '0.78rem', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.35)', borderRadius: '6px', padding: '0.25rem 0.6rem' }}>
                ⚠ {sectorWarn.share}% of top {top.length} is {sectorWarn.name}
              </span>
            )}
          </div>
          {summary && (
            <div className="glass-panel" style={{ padding: '1.1rem 1.4rem', marginBottom: '1.25rem', lineHeight: 1.6, fontSize: '0.9rem' }}>
              <ReactMarkdown>{summary}</ReactMarkdown>
            </div>
          )}

          {/* Ranked table */}
          <div className="glass-panel" style={{ padding: '0.4rem', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
                  {(() => { const sTh = { padding: '0.55rem 0.7rem', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }; return (<>
                  <th style={{ padding: '0.55rem 0.7rem' }}>#</th>
                  <th style={sTh} onClick={() => toggleSort('symbol')}>Symbol{arrow('symbol')}</th>
                  <th style={sTh} onClick={() => toggleSort('sector')}>Sector{arrow('sector')}</th>
                  <th style={sTh} title="Yahoo market cap — context only, not part of the score" onClick={() => toggleSort('mcap')}>Mkt Cap{arrow('mcap')}</th>
                  <th style={sTh} onClick={() => toggleSort('composite')}>Score{arrow('composite')}</th>
                  {FACTORS.map(f => <th key={f.key} style={sTh} title={f.help} onClick={() => toggleSort(f.key)}>{f.label}{arrow(f.key)}</th>)}
                  <th style={{ padding: '0.55rem 0.7rem' }}>Signals</th>
                  </>) })()}
                </tr>
              </thead>
              <tbody>
                {displayed.map((r, idx) => (
                  <tr key={r.symbol} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '0.5rem 0.7rem', color: 'var(--text-secondary)', fontWeight: 700 }} title={`Composite rank #${r.rank}`}>{idx + 1}</td>
                    <td style={{ padding: '0.5rem 0.7rem' }}>
                      <span onClick={() => openInstrument(r.symbol)} style={{ color: 'var(--accent)', fontWeight: 700, cursor: 'pointer' }}>{r.symbol}</span>
                      {held.has(r.symbol) && <span title="In your Kite holdings" style={{ marginLeft: '0.4rem', fontSize: '0.65rem', color: '#6ee7b7', border: '1px solid rgba(16,185,129,0.4)', borderRadius: '4px', padding: '0 0.3rem' }}>held</span>}
                      {hist?.newTop10.has(r.symbol) && <span title={`Entered the daily default-weight top 10 on ${hist.latest.date}`} style={{ marginLeft: '0.4rem', fontSize: '0.65rem', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.4)', borderRadius: '4px', padding: '0 0.3rem' }}>new↑10</span>}
                      {r.factors.trapRisk && <span title={r.factors.trapReason} style={{ marginLeft: '0.4rem', fontSize: '0.65rem', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '4px', padding: '0 0.3rem' }}>⚠ trap</span>}
                      {(() => { const nm = metaMap[r.symbol]?.name || (r.name !== r.symbol ? r.name : null); return nm ? <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nm}</div> : null })()}
                    </td>
                    <td style={{ padding: '0.5rem 0.7rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{metaMap[r.symbol]?.sector || fmtSector(r.sector)}</td>
                    <td style={{ padding: '0.5rem 0.7rem', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
                      {(() => {
                        const cr = metaMap[r.symbol]?.marketCapCr
                        const tag = mcapTag(cr)
                        return (<>
                          <span style={{ color: 'var(--text-secondary)' }}>{fmtMcap(cr)}</span>
                          {tag && <span style={{ marginLeft: '0.35rem', fontSize: '0.62rem', color: tag.color, border: `1px solid ${tag.color}44`, borderRadius: '4px', padding: '0 0.25rem' }}>{tag.label}</span>}
                        </>)
                      })()}
                    </td>
                    <td style={{ padding: '0.5rem 0.7rem', fontWeight: 800, color: 'var(--accent)' }}>{r.composite.toFixed(1)}</td>
                    {FACTORS.map(f => (
                      <td key={f.key} style={{ padding: '0.5rem 0.7rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <Bar pct={r.pct[f.key]} color={f.color} />
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', minWidth: '20px' }}>{Math.round(r.pct[f.key])}</span>
                        </div>
                      </td>
                    ))}
                    <td style={{ padding: '0.5rem 0.7rem' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                        {r.factors.mom205Pct != null && (
                          <Chip color={r.factors.mom205Pct > 0 ? '#34d399' : r.factors.mom205Pct < 0 ? '#fca5a5' : undefined}
                            title="The momentum factor's raw input: 20-session price return excluding the most recent week (short-term reversal adjusted)">
                            {r.factors.mom205Pct > 0 ? '+' : ''}{r.factors.mom205Pct}% mom
                          </Chip>
                        )}
                        {(r.factors.gainerDays > 0 || r.factors.loserDays > 0) && (
                          <Chip title={`Appeared among NSE top gainers on ${r.factors.gainerDays} day(s) and top losers on ${r.factors.loserDays} day(s) in this period${r.factors.avgGainPct ? ` · avg gain ${r.factors.avgGainPct}%` : ''}`}>
                            {r.factors.gainerDays} up / {r.factors.loserDays} down days
                          </Chip>
                        )}
                        {r.factors.madeNewHigh && <Chip color="#34d399" title="Set a fresh 52-week high during this period">fresh 52w high</Chip>}
                        {r.factors.madeNewLow && <Chip color="#ef4444" title="Set a fresh 52-week low during this period">fresh 52w low</Chip>}
                        {r.factors.authenticity != null && (
                          <Chip color={r.factors.authenticity >= 70 ? '#34d399' : r.factors.authenticity >= 45 ? '#fbbf24' : '#fca5a5'}
                            title={`Volume authenticity — price corroboration, persistence across days, gainer/loser churn${r.factors.deliveryPct != null ? ` and delivery (avg ${r.factors.deliveryPct}% of traded shares actually delivered)` : ''}. Low = possibly fake/HFT-inflated volume.`}>
                            vol quality {r.factors.authenticity}%
                          </Chip>
                        )}
                        {r.factors.circuitLadder && (
                          <Chip color="#fca5a5" title={`Possible circuit-ladder ramp — ${r.factors.circuitReason}. Classic low-float FOMO setup: you can't buy until the operators sell to you.`}>
                            circuit ladder
                          </Chip>
                        )}
                        {r.factors.distribution && (
                          <Chip color="#fbbf24" title={`Possible distribution — ${r.factors.distributionReason}.`}>
                            delivery fading
                          </Chip>
                        )}
                        {r.factors.dealsNetValueCr ? (
                          <Chip color={r.factors.dealsNetValueCr > 0 ? '#34d399' : '#ef4444'}
                            title={`Net bulk/block-deal value over the period (buys − sells)${r.factors.dealsGrossCr ? ` · gross ${fmtCr(r.factors.dealsGrossCr)} both ways · conviction ${r.factors.dealConviction}%` : ''}${r.factors.dealBuyers ? ` · ${r.factors.dealBuyers} client(s) with ≥₹1 cr net accumulation` : ''}`}>
                            deals {r.factors.dealsNetValueCr > 0 ? '+' : ''}{fmtCr(r.factors.dealsNetValueCr)}
                          </Chip>
                        ) : null}
                        {r.factors.dealChurn && (
                          <Chip color="#fca5a5" title={`Likely wash/HFT deal churn — ${r.factors.dealChurnReason}. The Institutional factor is scaled down accordingly.`}>
                            deal churn
                          </Chip>
                        )}
                        {(hist?.streaks[r.symbol] ?? 0) >= 2 && (
                          <Chip color="#fbbf24" title={`In the daily default-weight top-25 snapshot for ${hist.streaks[r.symbol]} consecutive days`}>
                            top-25 ×{hist.streaks[r.symbol]}d
                          </Chip>
                        )}
                        {(() => { const q = qualityChip(metaMap[r.symbol]); return q ? <Chip color={q.color} title={q.tip}>{q.text}</Chip> : null })()}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.75rem', fontStyle: 'italic' }}>
            Factors percentile-ranked across {ranked.length} active stocks for {period.from === period.to ? period.from : `${period.from} → ${period.to}`}; composite = your weighted blend.
            Hover any signal chip for its full explanation. Deterministic signal summary — not investment advice.
          </p>
        </>
      )}

      {/* Model validation — did past picks actually outperform? */}
      <div className="glass-panel" style={{ marginTop: '1.5rem', padding: '1rem 1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)' }}>Model Validation</span>
          <button onClick={runValidation} disabled={btLoading} style={btn(false)}>
            {btLoading ? 'Running…' : bt ? '↻ Re-run' : 'Run forward-return backtest'}
          </button>
          {bt && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              {bt.period.evalDates} eval dates · {bt.period.firstEval} → {bt.period.lastEval} · default weights, traps excluded{bt.cached ? ' · cached' : ''}
            </span>
          )}
          {btError && <span style={{ color: '#ef4444', fontSize: '0.8rem' }}>{btError}</span>}
          {!bt && !btLoading && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Reconstructs past top-25s and measures 5/10/20-day forward returns vs the universe median, plus per-factor predictive power.
            </span>
          )}
        </div>
        {bt && (() => {
          const fLabel = { momentum: 'Momentum', volume: 'Volume', fiftyTwo: '52-Wk', deals: 'Institutional', composite: 'Composite' }
          const sign = (v, suffix = '%') => (v == null ? '—' : <span style={{ color: v > 0 ? '#34d399' : v < 0 ? '#fca5a5' : 'var(--text-secondary)' }}>{v > 0 ? '+' : ''}{v}{suffix}</span>)
          const cell = { padding: '0.35rem 0.6rem', fontSize: '0.8rem' }
          const th = { ...cell, color: 'var(--text-secondary)', textAlign: 'left', fontWeight: 600 }
          return (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem', marginTop: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>Top-25 forward returns vs universe median</div>
                  <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                    <thead><tr><th style={th}>Horizon</th><th style={th} title="mean top-25 return minus universe median return, averaged across eval dates">Excess</th><th style={th} title="share of picks beating the universe median">Hit rate</th><th style={th}>Picks</th><th style={th} title="mean return per composite quintile, Q1 = top-ranked fifth">Q1…Q5</th></tr></thead>
                    <tbody>
                      {bt.summary.map(s => (
                        <tr key={s.horizon} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                          <td style={cell}>{s.horizon}d</td>
                          <td style={cell}>{sign(s.meanExcessPct)}</td>
                          <td style={cell}>{s.hitRatePct == null ? '—' : `${s.hitRatePct}%`}</td>
                          <td style={{ ...cell, color: 'var(--text-secondary)' }}>{s.pickObs}</td>
                          <td style={{ ...cell, fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{s.quintileMeansPct.map(q => (q == null ? '—' : q)).join(' / ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>Factor predictive power (10-day Spearman IC)</div>
                  <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                    <thead><tr><th style={th}>Factor</th><th style={th} title="mean rank correlation between factor percentile and forward return; >0.05 is meaningful, sign matters">Mean IC</th><th style={th} title="|t| > 2 ≈ statistically distinguishable from zero">t-stat</th></tr></thead>
                    <tbody>
                      {bt.ics.map(r => (
                        <tr key={r.factor} style={{ borderTop: '1px solid rgba(255,255,255,0.06)', fontWeight: r.factor === 'composite' ? 700 : 400 }}>
                          <td style={cell}>{fLabel[r.factor] || r.factor}</td>
                          <td style={cell}>{sign(r.meanIC, '')}</td>
                          <td style={{ ...cell, color: Math.abs(r.tStat) >= 2 ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{r.tStat ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <ul style={{ margin: '0.85rem 0 0', paddingLeft: '1.1rem', fontSize: '0.7rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                {bt.caveats.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </>
          )
        })()}
      </div>
    </div>
  )
}
