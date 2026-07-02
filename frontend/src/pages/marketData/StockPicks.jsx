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
  { key: 'momentum', raw: 'momentumRaw', label: 'Momentum', color: '#38bdf8', help: 'Net gainer days + average gain — sustained upside appearances.' },
  { key: 'volume', raw: 'volumeRaw', label: 'Volume', color: '#a78bfa', help: 'Authenticity-adjusted volume surge (faked/churned volume down-weighted).' },
  { key: 'fiftyTwo', raw: 'fiftyTwoRaw', label: '52-Wk', color: '#34d399', help: 'New 52-week highs + proximity to the 52-week high.' },
  { key: 'deals', raw: 'dealsRaw', label: 'Institutional', color: '#fbbf24', help: 'Net large-deal buy value + buyer breadth.' },
]
const DEFAULT_WEIGHTS = { momentum: 30, volume: 25, fiftyTwo: 20, deals: 25 }

// Percentile rank (0–100) of each value within the array; ties share the rank.
function percentileRanks(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  return values.map(v => {
    // fraction of values <= v
    let lo = 0, hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid }
    return n ? (lo / n) * 100 : 0
  })
}

// 'NSE:NIFTY ENERGY' -> 'Energy'; 'NSE:NIFTY FIN SERVICE' -> 'Fin Service'.
const fmtSector = (s) => (!s ? '—' : s.replace(/^NSE:NIFTY\s*/i, '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) || '—')
const fmtCr = (v) => (v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })} cr`)
const fmtNet = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })} cr`)

function Bar({ pct, color }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '4px', height: '8px', width: '64px', overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(2, pct)}%`, height: '100%', background: color, borderRadius: '4px' }} />
    </div>
  )
}

export default function StockPicks() {
  const navigate = useNavigate()
  const [mode, setMode] = useState('lookback')        // 'lookback' | 'snapshot'
  const [lookback, setLookback] = useState('30d')
  const [snapDate, setSnapDate] = useState(isoDay(1))
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS)
  const [topN, setTopN] = useState(25)
  const [excludeTraps, setExcludeTraps] = useState(true)
  const [summary, setSummary] = useState(null)
  const [summarizing, setSummarizing] = useState(false)
  const [metaMap, setMetaMap] = useState({}) // symbol -> { sector, name } (Yahoo, resolved for visible rows)
  const metaReqRef = useRef(new Set())
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
    return r.pct[key] ?? 0
  }
  const displayed = useMemo(() => {
    const arr = [...top]
    arr.sort((a, b) => {
      const av = sortVal(a, sort.key), bv = sortVal(b, sort.key)
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top, sort, metaMap])
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

  const genSummary = async () => {
    setSummarizing(true); setSummary(null)
    try {
      const picks = top.slice(0, 25).map(r => ({
        rank: r.rank, symbol: r.symbol, composite: +r.composite.toFixed(1),
        momentumPct: Math.round(r.pct.momentum), volumePct: Math.round(r.pct.volume),
        fiftyTwoPct: Math.round(r.pct.fiftyTwo), dealsPct: Math.round(r.pct.deals),
        gainerDays: r.factors.gainerDays, loserDays: r.factors.loserDays,
        madeNewHigh: r.factors.madeNewHigh, authenticity: r.factors.authenticity,
        dealsNetValueCr: r.factors.dealsNetValueCr, trapRisk: r.factors.trapRisk, trapReason: r.factors.trapReason,
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
  const riskOff = regime && regime.totalNet < -5000
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
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          Top
          <select value={topN} onChange={e => setTopN(+e.target.value)} style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', padding: '0.25rem 0.4rem' }}>
            {[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      {/* Weight sliders */}
      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
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

      {/* Regime banner */}
      {regime && (
        <div className="glass-panel" style={{ padding: '0.85rem 1.25rem', marginBottom: '1rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center', border: `1px solid ${riskOff ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.25)'}` }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: riskOff ? '#fca5a5' : '#6ee7b7' }}>Market Regime</span>
          <span style={{ fontWeight: 700 }}>{regime.label}</span>
          <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>FII {fmtNet(regime.fiiNet)} · DII {fmtNet(regime.diiNet)} · Net {fmtNet(regime.totalNet)}</span>
          {data && <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{data.universeSize} stocks · {data.excludedCount} surveillance excluded</span>}
        </div>
      )}

      {loading ? <div className="loader" /> : error ? (
        <div className="glass-panel" style={{ padding: '1.5rem', color: '#ef4444' }}>Failed to load: {error}</div>
      ) : !top.length ? (
        <div className="glass-panel" style={{ padding: '1.5rem', color: 'var(--text-secondary)' }}>No stocks for this period. Try a wider lookback or a different date.</div>
      ) : (
        <>
          {/* AI brief */}
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem' }}>
            <button onClick={genSummary} disabled={summarizing} style={{ ...btn(false), background: summarizing ? 'rgba(56,189,248,0.2)' : 'var(--accent)', color: summarizing ? 'var(--text-secondary)' : '#04141f', fontWeight: 700 }}>
              {summarizing ? 'Generating…' : '✨ Generate AI brief'}
            </button>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Narrates the deterministic top {Math.min(topN, 25)} — does not change the ranking.</span>
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
                      {r.factors.trapRisk && <span title={r.factors.trapReason} style={{ marginLeft: '0.4rem', fontSize: '0.65rem', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '4px', padding: '0 0.3rem' }}>⚠ trap</span>}
                      {(() => { const nm = metaMap[r.symbol]?.name || (r.name !== r.symbol ? r.name : null); return nm ? <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nm}</div> : null })()}
                    </td>
                    <td style={{ padding: '0.5rem 0.7rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{metaMap[r.symbol]?.sector || fmtSector(r.sector)}</td>
                    <td style={{ padding: '0.5rem 0.7rem', fontWeight: 800, color: 'var(--accent)' }}>{r.composite.toFixed(1)}</td>
                    {FACTORS.map(f => (
                      <td key={f.key} style={{ padding: '0.5rem 0.7rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <Bar pct={r.pct[f.key]} color={f.color} />
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', minWidth: '20px' }}>{Math.round(r.pct[f.key])}</span>
                        </div>
                      </td>
                    ))}
                    <td style={{ padding: '0.5rem 0.7rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                      {r.factors.gainerDays > 0 && <span title="gainer/loser days">{r.factors.gainerDays}↑/{r.factors.loserDays}↓ </span>}
                      {r.factors.madeNewHigh && <span style={{ color: '#34d399' }}>52wH </span>}
                      {r.factors.authenticity != null && <span title="volume authenticity">vA{r.factors.authenticity} </span>}
                      {r.factors.dealsNetValueCr ? <span style={{ color: r.factors.dealsNetValueCr > 0 ? '#34d399' : '#ef4444' }}>{fmtCr(r.factors.dealsNetValueCr)}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.75rem', fontStyle: 'italic' }}>
            Factors percentile-ranked across {ranked.length} active stocks for {period.from === period.to ? period.from : `${period.from} → ${period.to}`}; composite = your weighted blend.
            "vA" = volume authenticity (lower = more likely fake/churned). Deterministic signal summary — not investment advice.
          </p>
        </>
      )}
    </div>
  )
}
