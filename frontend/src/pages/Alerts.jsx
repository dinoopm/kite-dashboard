import { useState, useEffect, useRef } from 'react'
import AlertRow from '../components/alerts/AlertRow'
import ConvictionModal from '../components/alerts/ConvictionModal'
import TradePlanModal from '../components/alerts/TradePlanModal'
import { biasClass } from '../components/alerts/biasClass'
import { fetchWithAbort } from '../hooks/useFetchWithAbort'

const REFRESH_INTERVAL_MS = 60000

function Alerts() {
  const [alerts, setAlerts] = useState(null)
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')
  const [filterBreakouts, setFilterBreakouts] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [cacheProgress, setCacheProgress] = useState(null)
  const [sortConfig, setSortConfig] = useState({ key: 'confidence', direction: 'desc' })
  const [showLegend, setShowLegend] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [modalStock, setModalStock] = useState(null)
  const [tradePlanModalStock, setTradePlanModalStock] = useState(null)
  const searchInputRef = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    let warmupPoll
    let refreshPoll

    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    const fireIfVisible = (fn) => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') fn()
    }

    const fetchAlerts = async () => {
      try {
        setError(null)
        const res = await fetchWithAbort('/api/alerts', { signal: controller.signal })
        if (!res.ok) throw new Error('Failed to fetch alerts')
        const data = await res.json()
        // Backend now returns { alerts, summary }; tolerate the legacy array shape
        // so the FE doesn't break if a stale build is deployed.
        if (Array.isArray(data)) {
          setAlerts(data)
          setSummary(null)
        } else {
          setAlerts(data.alerts || [])
          setSummary(data.summary || null)
        }
        setLastUpdated(new Date())
        setLoading(false)
      } catch (err) {
        if (err.name === 'AbortError') return
        if (err.name === 'RateLimitedError') return
        setError(err.message)
        setLoading(false)
      }
    }

    const checkAndFetchAlerts = async () => {
      try {
        setError(null)
        const statusRes = await fetchWithAbort('/api/cache-status', { signal: controller.signal })
        if (!statusRes.ok) throw new Error('Failed to check cache status')
        const status = await statusRes.json()

        if (!status.ready) {
          setCacheProgress(`Warming engines... (${status.instrumentsCached}/${status.totalHoldings || '?'})`)
          fetchWithAbort('/api/alerts', { signal: controller.signal }).catch(() => { })
          return
        }

        await fetchAlerts()
        setCacheProgress(null)
        clearInterval(warmupPoll)
        // Start periodic refresh once warm; pause when tab is hidden.
        if (!refreshPoll) refreshPoll = setInterval(() => fireIfVisible(fetchAlerts), REFRESH_INTERVAL_MS)
      } catch (err) {
        if (err.name === 'AbortError') return
        if (err.name === 'RateLimitedError') return
        setError(err.message)
        setLoading(false)
        clearInterval(warmupPoll)
      }
    }

    setLoading(true)
    checkAndFetchAlerts()
    warmupPoll = setInterval(() => fireIfVisible(checkAndFetchAlerts), 2000)

    return () => {
      controller.abort()
      clearInterval(warmupPoll)
      clearInterval(refreshPoll)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  if (loading || cacheProgress) return (
    <div className="dashboard-layout" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '50vh', gap: '1rem' }}>
      <div className="loader"></div>
      {cacheProgress && <p style={{ color: 'var(--accent)', fontWeight: 'bold', fontFamily: "'JetBrains Mono', 'Roboto Mono', monospace" }}>{cacheProgress}</p>}
    </div>
  )

  if (error) return (
    <div className="dashboard-layout">
      <div className="glass-panel" style={{ padding: '2rem', color: 'var(--danger)', fontFamily: "'JetBrains Mono', monospace" }}>{error}</div>
    </div>
  )

  const allAlertsList = (alerts || []).flatMap(s => s.alerts.map(a => ({ ...a, symbol: s.symbol, price: s.price, rsi: s.rsi })))
  const bullishCount = (alerts || []).filter(s => biasClass(s) === 'bullish').length
  const bearishCount = (alerts || []).filter(s => biasClass(s) === 'bearish').length
  const breakoutCount = (alerts || []).filter(s => s.isBreakout).length

  let filteredStocks = (alerts || [])
    .filter(s => s.symbol.toLowerCase().includes(searchQuery.toLowerCase()))
    .filter(s => {
      if (filter === 'all') return true
      if (filter === 'hurting') return (s.dayChangePct ?? 0) < -2
      if (filter === 'runners') return (s.dayChangePct ?? 0) > 2
      return biasClass(s) === filter
    })
    .filter(s => filterBreakouts ? s.isBreakout : true)

  // Effective sort direction:
  //   - BEAR tab: confidence ascending (most-bearish on top).
  //   - HURTING tab: dayChangeRupee ascending (biggest cash loss on top).
  //   - RUNNERS tab: dayChangeRupee descending (biggest cash gain on top).
  //   - Otherwise: respect the user's chosen direction.
  let effectiveDir = sortConfig.direction
  let effectiveKey = sortConfig.key
  if (filter === 'bearish' && sortConfig.key === 'confidence') {
    effectiveDir = sortConfig.direction === 'desc' ? 'asc' : 'desc'
  }
  if (filter === 'hurting' && sortConfig.key === 'confidence') {
    effectiveKey = 'dayChangeRupee'
    effectiveDir = 'asc'
  }
  if (filter === 'runners' && sortConfig.key === 'confidence') {
    effectiveKey = 'dayChangeRupee'
    effectiveDir = 'desc'
  }

  filteredStocks.sort((a, b) => {
    let vA, vB
    if (effectiveKey === 'symbol') { vA = a.symbol; vB = b.symbol }
    if (effectiveKey === 'vwap') { vA = a.vwapDeviation || 0; vB = b.vwapDeviation || 0 }
    if (effectiveKey === 'aggressor') { vA = a.aggressorDelta || 0; vB = b.aggressorDelta || 0 }
    if (effectiveKey === 'confidence') { vA = a.confidence || 0; vB = b.confidence || 0 }
    if (effectiveKey === 'dayChangeRupee') { vA = a.dayChangeRupee || 0; vB = b.dayChangeRupee || 0 }
    if (vA < vB) return effectiveDir === 'asc' ? -1 : 1
    if (vA > vB) return effectiveDir === 'asc' ? 1 : -1
    return 0
  })

  const requestSort = (key) => setSortConfig(prev => ({ key, direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc' }))
  const renderSortArrow = (key) => sortConfig.key === key ? (sortConfig.direction === 'asc' ? ' ↑' : ' ↓') : ''

  const formatClock = (d) => d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'

  const severityTabs = [
    { key: 'all', label: 'ALL', color: '#cbd5e1' },
    { key: 'bullish', label: '▲ BULL', color: '#10b981' },
    { key: 'bearish', label: '▼ BEAR', color: '#ef4444' },
    { key: 'hurting', label: '🔥 HURTING', color: '#ef4444' },
    { key: 'runners', label: '🏆 RUNNERS', color: '#10b981' },
  ]

  return (
    <div className="dashboard-layout terminal-alerts" style={{ maxWidth: '1200px', margin: '0 auto' }}>

      <style>{`
        .quant-row {
          position: relative;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.05);
          border-radius: 8px;
          margin-bottom: 0.75rem;
          transition: background 0.15s, border-color 0.15s;
          overflow: visible;
        }
        .quant-row:hover { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.1); }
        .sort-header { cursor: pointer; user-select: none; transition: color 0.2s; display: flex; align-items: center; gap: 0.3rem }
        .sort-header:hover { color: #f8fafc; }
        .info-icon { opacity: 0.6; font-size: 0.8rem; cursor: help; }
        .info-icon:hover { opacity: 1; }
        .dotted-underline { border-bottom: 1px dotted rgba(255,255,255,0.4); text-decoration: none; cursor: help; }
        .sev-tab { font-size: 0.7rem; padding: 0.3rem 0.55rem; background: transparent; border-radius: 4px; cursor: pointer; transition: all 0.15s; font-family: 'JetBrains Mono', monospace; }

        /* Conviction Modal */
        .conv-modal-backdrop {
          position: fixed; inset: 0; z-index: 1000;
          background: rgba(0,0,0,0.65); backdrop-filter: blur(6px);
          display: flex; align-items: center; justify-content: center;
          animation: convFadeIn 0.2s ease;
        }
        @keyframes convFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes convSlideUp { from { opacity: 0; transform: translateY(20px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .conv-modal {
          background: linear-gradient(165deg, #0f172a 0%, #1a1f35 100%);
          border: 1px solid #334155; border-radius: 12px;
          padding: 0; min-width: 420px; max-width: 520px; width: 90vw;
          box-shadow: 0 20px 60px rgba(0,0,0,0.7), 0 0 40px rgba(16,185,129,0.06);
          font-family: 'JetBrains Mono', 'Roboto Mono', monospace;
          animation: convSlideUp 0.25s ease;
          overflow: hidden;
        }
        .conv-modal-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 1.25rem 1.5rem; border-bottom: 1px solid #1e293b;
          background: rgba(255,255,255,0.02);
        }
        .conv-modal-body { padding: 1.25rem 1.5rem; }
        .conv-row {
          display: grid; grid-template-columns: 1fr 50px 1fr; gap: 0.5rem;
          align-items: center; padding: 0.6rem 0;
          border-bottom: 1px solid rgba(255,255,255,0.04);
          transition: background 0.15s;
        }
        .conv-row:hover { background: rgba(255,255,255,0.02); }
        .conv-row:last-child { border-bottom: none; }
        .conv-bar-track {
          width: 100%; height: 6px; background: #1e293b; border-radius: 3px;
          overflow: hidden; position: relative;
        }
        .conv-bar-fill {
          height: 100%; border-radius: 3px;
          transition: width 0.5s ease;
        }
        .conv-modal-close {
          background: transparent; border: 1px solid #334155; color: #94a3b8;
          width: 28px; height: 28px; border-radius: 6px; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          transition: all 0.15s; font-size: 1rem;
        }
        .conv-modal-close:hover { background: #1e293b; color: #f8fafc; border-color: #475569; }
        .conviction-click {
          cursor: pointer; transition: transform 0.15s, filter 0.15s;
        }
        .conviction-click:hover { transform: scale(1.08); filter: brightness(1.2); }
      `}</style>

      {/* Holdings Summary Banner */}
      {summary && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.6rem',
          marginBottom: '1rem', padding: '0.65rem 0.85rem',
          background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '6px', fontFamily: "'JetBrains Mono', monospace", fontSize: '0.7rem'
        }}>
          <span style={{
            display: 'inline-flex', alignItems: 'baseline', gap: '0.4rem',
            padding: '0.25rem 0.55rem', borderRadius: '4px',
            background: summary.todayPnlRupee >= 0 ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
            border: `1px solid ${summary.todayPnlRupee >= 0 ? '#10b981' : '#ef4444'}`,
          }} title="Sum of today's rupee impact across every holding">
            <span style={{ fontSize: '0.55rem', color: '#94a3b8', letterSpacing: '0.5px' }}>TODAY</span>
            <span style={{ fontWeight: 800, color: summary.todayPnlRupee >= 0 ? '#10b981' : '#ef4444' }}>
              {summary.todayPnlRupee >= 0 ? '+' : '−'}₹{Math.abs(summary.todayPnlRupee).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </span>
          </span>
          <span style={{ color: '#cbd5e1' }}>
            <span style={{ color: '#94a3b8' }}>HOLDINGS</span>{' '}
            <span style={{ fontWeight: 800, color: '#f8fafc' }}>{summary.totalHoldings}</span>
          </span>
          {summary.flagCounts?.add > 0 && (
            <button
              onClick={() => setFilter('all')}
              style={{
                padding: '0.2rem 0.5rem', border: '1px solid #10b981',
                color: '#10b981', background: 'rgba(16,185,129,0.1)',
                borderRadius: '4px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.65rem', fontWeight: 700
              }}
              title="Holdings flagged as ADD — already-owned breakouts"
            >
              ▲ ADD {summary.flagCounts.add}
            </button>
          )}
          {summary.flagCounts?.trim > 0 && (
            <button
              onClick={() => setFilter('all')}
              style={{
                padding: '0.2rem 0.5rem', border: '1px solid #06b6d4',
                color: '#06b6d4', background: 'rgba(6,182,212,0.1)',
                borderRadius: '4px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.65rem', fontWeight: 700
              }}
              title="Holdings up ≥25% with stretched RSI — book partial profits"
            >
              ✂ TRIM {summary.flagCounts.trim}
            </button>
          )}
          {summary.flagCounts?.avoid > 0 && (
            <button
              onClick={() => setFilter('bearish')}
              style={{
                padding: '0.2rem 0.5rem', border: '1px solid #ef4444',
                color: '#ef4444', background: 'rgba(239,68,68,0.1)',
                borderRadius: '4px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.65rem', fontWeight: 700
              }}
              title="Holdings flagged AVOID — broken technicals or wild swings"
            >
              ▼ AVOID {summary.flagCounts.avoid}
            </button>
          )}
          {summary.sectorConcentration?.length > 0 && summary.sectorConcentration.map(sc => (
            <span
              key={sc.sector}
              style={{
                padding: '0.2rem 0.5rem', border: '1px solid #f59e0b',
                color: '#f59e0b', background: 'rgba(245,158,11,0.1)',
                borderRadius: '4px', fontSize: '0.65rem', fontWeight: 700
              }}
              title={`Flagged tickers: ${sc.symbols.join(', ')}`}
            >
              ⚠ {sc.sector}: {sc.flagged} flagged
            </span>
          ))}
        </div>
      )}

      {/* Terminal Header */}
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '1px solid #1e293b', paddingBottom: '1rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.2rem', color: '#fff', letterSpacing: '1px', textTransform: 'uppercase' }}>Technical Alerts</h1>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', fontSize: '0.75rem', fontFamily: "'JetBrains Mono', monospace", color: '#94a3b8', flexWrap: 'wrap' }}>
            <span>ACTIVE: <span style={{ color: '#fff' }}>{allAlertsList.length}</span></span>
            <span>▲ BULL: <span style={{ color: '#00E5FF' }}>{bullishCount}</span></span>
            <span>▼ BEAR: <span style={{ color: '#FF3D00' }}>{bearishCount}</span></span>
            <span title={lastUpdated ? lastUpdated.toLocaleString() : ''}>UPDATED: <span style={{ color: '#10b981' }}>{formatClock(lastUpdated)}</span></span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search (Cmd+K)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              padding: '0.4rem 0.6rem', borderRadius: '2px', border: '1px solid #1e293b',
              background: '#0f172a', color: '#f8fafc', width: '200px', outline: 'none',
              fontSize: '0.75rem', fontFamily: "'JetBrains Mono', monospace"
            }}
          />
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            {severityTabs.map(tab => (
              <button
                key={tab.key}
                className="sev-tab"
                onClick={() => setFilter(tab.key)}
                style={{
                  border: `1px solid ${filter === tab.key ? tab.color : '#334155'}`,
                  color: filter === tab.key ? tab.color : '#cbd5e1',
                  fontWeight: filter === tab.key ? 800 : 500,
                  background: filter === tab.key ? `${tab.color}1A` : 'transparent',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', fontFamily: "'JetBrains Mono', monospace" }}>
            <button
              onClick={() => setFilterBreakouts(!filterBreakouts)}
              style={{ fontSize: '0.7rem', fontWeight: filterBreakouts ? '800' : '500', padding: '0.3rem 0.6rem', background: filterBreakouts ? 'rgba(16,185,129,0.2)' : 'transparent', color: filterBreakouts ? '#10b981' : '#cbd5e1', border: `1px solid ${filterBreakouts ? '#10b981' : '#334155'}`, borderRadius: '4px', cursor: 'pointer', transition: 'all 0.2s', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
              title="Show only stocks breaking above their 20-day resistance ceilings"
            >
              🚀 Breakouts
              {breakoutCount > 0 && (
                <span style={{
                  background: filterBreakouts ? '#10b981' : '#fcd34d',
                  color: '#0f172a',
                  fontSize: '0.6rem',
                  fontWeight: 800,
                  padding: '0.05rem 0.35rem',
                  borderRadius: '9px',
                  minWidth: '16px',
                  textAlign: 'center',
                  lineHeight: '1.3',
                  boxShadow: `0 0 6px ${filterBreakouts ? 'rgba(16,185,129,0.4)' : 'rgba(252,211,77,0.4)'}`,
                  transition: 'all 0.2s'
                }}>
                  {breakoutCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setShowLegend(!showLegend)}
              style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem', background: showLegend ? '#1e293b' : 'transparent', color: '#cbd5e1', border: '1px solid #334155', borderRadius: '4px', cursor: 'pointer' }}
            >
              {showLegend ? 'Close Guide' : '📖 How to read this'}
            </button>
          </div>
        </div>
      </header>

      {/* Educational Cheatsheet Legend */}
      {showLegend && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', padding: '1.25rem', marginBottom: '1.5rem', color: '#cbd5e1', fontSize: '0.8rem', lineHeight: '1.5' }}>
          <h3 style={{ margin: '0 0 0.75rem 0', color: '#f8fafc', fontSize: '0.9rem' }}>Terminal Cheat Sheet</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
            <div>
              <strong style={{ color: '#00E5FF' }}>VWAP-20 DEV:</strong> Gap between current price and the 20-day volume-weighted average. Positive = trading above institutional average cost; negative = trading below.<br /><em>Look for:</em> Deep below (-2% or more) suggests selling pressure; strong positive values confirm support.
            </div>
            <div>
              <strong style={{ color: '#FF3D00' }}>MONEY FLOW:</strong> Chaikin-style accumulation/distribution over 14 days. Right (Cyan) = accumulation; left (Red) = distribution.<br /><em>Look for:</em> +0.30 to +1.0 generally confirms healthy demand; below -0.20 signals heavy selling.
            </div>
            <div>
              <strong style={{ color: '#10b981' }}>MOMENTUM SCORE & REGIME:</strong> 0-100 score mixing trend alignment, RSI, and money flow. Regime: STRONG TREND (directional), WILD SWINGS (volatile), RANGE-BOUND (sideways). Hover the score for a component breakdown.
            </div>
            <div>
              <strong style={{ color: '#f59e0b' }}>PRICE LEVEL MAP (S/R):</strong> Shows current price between the 20-day Donchian support floor and resistance ceiling (both computed on the prior 20 days, excluding today).
            </div>
            <div style={{ gridColumn: '1 / -1', borderTop: '1px solid #334155', paddingTop: '1rem', marginTop: '0.25rem' }}>
              <strong style={{ color: '#ec4899', fontSize: '0.85rem' }}>TRADE PLAN — What Each Tag Means & What To Do:</strong>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginTop: '0.75rem' }}>
                <div>
                  <span style={{ color: '#10b981', fontWeight: 800 }}>▲ BUY SEEN</span> — Momentum, trend, volume, and reward/risk (≥1.5×) all align.<br />
                  <em>Action:</em> Consider entering. Use TG (Target) as profit goal and SL (Stop Loss) as safety exit.
                </div>
                <div>
                  <span style={{ color: '#fcd34d', fontWeight: 800 }}>BREAKOUT (CAUTION)</span> — Price punched above the 20-day ceiling but either conviction is moderate or volume didn't confirm (≥1.5× avg).<br />
                  <em>Action:</em> Watch 1-2 days. If price holds with rising volume, the breakout confirms.
                </div>
                <div>
                  <span style={{ color: '#fcd34d', fontWeight: 800 }}>BREAKOUT (WEAK)</span> — Price crossed resistance but technicals AND volume are weak. High chance of a bull trap.<br />
                  <em>Action:</em> Do NOT buy. Wait for score &gt; 60% and volume surge.
                </div>
                <div>
                  <span style={{ color: '#f59e0b', fontWeight: 800 }}>HOLD / WAIT</span> — No clear edge, or reward/risk is below 1.5×.<br />
                  <em>Action:</em> If you own it, hold. If looking to buy, wait for a better setup.
                </div>
                <div>
                  <span style={{ color: '#f59e0b', fontWeight: 800 }}>HOLD (OVERBOUGHT)</span> — Momentum strong, but RSI stretched above 70.<br />
                  <em>Action:</em> Hold if you own. Do NOT buy new shares — wait for RSI to cool below 65.
                </div>
                <div>
                  <span style={{ color: '#ef4444', fontWeight: 800 }}>▼ SELL (AT RANGE)</span> — Range-bound stock hitting the ceiling. Ceiling usually pushes price back.<br />
                  <em>Action:</em> Book partial profits if in position. Do NOT buy here.
                </div>
                <div>
                  <span style={{ color: '#ef4444', fontWeight: 800 }}>▼ AVOID</span> — Technical health is severely broken or regime is WILD SWINGS.<br />
                  <em>Action:</em> Stay away. If you own, tight stop-loss.
                </div>
                <div>
                  <span style={{ color: '#a78bfa', fontWeight: 800 }}>DIVERGENCE</span> — A BUY/SELL SETUP badge means price and RSI are moving opposite directions (classic reversal hint).
                </div>
                <div>
                  <span style={{ color: '#06b6d4', fontWeight: 800 }}>R:R</span> — Reward-to-risk ratio: (TG − price) / (price − SL). A BUY SEEN must clear 1.5×; higher is better.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {filteredStocks.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>NO SIGNALS MATCH QUERY</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Column Headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(200px, 1.2fr) minmax(240px, 1.5fr) minmax(140px, 1fr) minmax(120px, 0.6fr)', gap: '1rem', padding: '0 1rem 0.5rem 1rem', fontSize: '0.65rem', color: 'var(--text-secondary)', letterSpacing: '1px', fontWeight: 700 }}>
            <div onClick={() => requestSort('symbol')} className="sort-header" title="Filter alphabetically or by raw asset price">SYMBOL / PRICE {renderSortArrow('symbol')}</div>
            <div onClick={() => requestSort('vwap')} className="sort-header" title="20-day VWAP deviation and RSI trends">CORE TECHNICALS <span className="info-icon">ⓘ</span> {renderSortArrow('vwap')}</div>
            <div onClick={() => requestSort('aggressor')} className="sort-header" style={{ justifyContent: 'center' }} title="Chaikin-style money flow: right (Cyan) = accumulation, left (Red) = distribution">MONEY FLOW <span className="info-icon">ⓘ</span> {renderSortArrow('aggressor')}</div>
            <div style={{ textAlign: 'center' }} title="Algorithmic entry and exit positioning">TRADE PLAN <span className="info-icon">ⓘ</span></div>
            <div onClick={() => requestSort('confidence')} className="sort-header" style={{ justifyContent: 'flex-end' }} title="Momentum conviction score (0-100)">MOMENTUM {renderSortArrow('confidence')}</div>
          </div>

          {filteredStocks.map(stock => (
            <AlertRow
              key={stock.symbol}
              stock={stock}
              showHoldingsFields
              onOpenConviction={() => setModalStock(stock)}
              onOpenTradePlan={() => setTradePlanModalStock(stock)}
            />
          ))}
        </div>
      )}

      <ConvictionModal stock={modalStock} onClose={() => setModalStock(null)} />
      <TradePlanModal stock={tradePlanModalStock} onClose={() => setTradePlanModalStock(null)} />
    </div>
  )
}

export default Alerts
