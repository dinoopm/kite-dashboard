import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

const REFRESH_INTERVAL_MS = 60000

function Alerts() {
  const [alerts, setAlerts] = useState(null)
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
  const searchInputRef = useRef(null)

  useEffect(() => {
    let warmupPoll
    let refreshPoll

    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    const fetchAlerts = async () => {
      try {
        setError(null)
        const res = await fetch('/api/alerts')
        if (!res.ok) throw new Error('Failed to fetch alerts')
        const data = await res.json()
        setAlerts(data)
        setLastUpdated(new Date())
        setLoading(false)
      } catch (err) {
        setError(err.message)
        setLoading(false)
      }
    }

    const checkAndFetchAlerts = async () => {
      try {
        setError(null)
        const statusRes = await fetch('/api/cache-status')
        if (!statusRes.ok) throw new Error('Failed to check cache status')
        const status = await statusRes.json()

        if (!status.ready) {
          setCacheProgress(`Warming engines... (${status.instrumentsCached}/${status.totalHoldings || '?'})`)
          fetch('/api/alerts').catch(() => { })
          return
        }

        await fetchAlerts()
        setCacheProgress(null)
        clearInterval(warmupPoll)
        // Start periodic refresh once warm
        if (!refreshPoll) refreshPoll = setInterval(fetchAlerts, REFRESH_INTERVAL_MS)
      } catch (err) {
        setError(err.message)
        setLoading(false)
        clearInterval(warmupPoll)
      }
    }

    setLoading(true)
    checkAndFetchAlerts()
    warmupPoll = setInterval(checkAndFetchAlerts, 2000)

    return () => {
      clearInterval(warmupPoll)
      clearInterval(refreshPoll)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  // ESC key to close conviction modal
  useEffect(() => {
    const handleEsc = (e) => { if (e.key === 'Escape') setModalStock(null) }
    if (modalStock) window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [modalStock])

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
  const bullishCount = allAlertsList.filter(a => a.severity === 'bullish').length
  const bearishCount = allAlertsList.filter(a => a.severity === 'bearish').length
  const breakoutCount = (alerts || []).filter(s => s.isBreakout).length

  let filteredStocks = (alerts || [])
    .filter(s => s.symbol.toLowerCase().includes(searchQuery.toLowerCase()))
    .filter(s => {
      if (filter === 'all') return true
      return s.alerts.some(a => a.severity === filter)
    })
    .filter(s => filterBreakouts ? s.isBreakout : true)

  filteredStocks.sort((a, b) => {
    let vA, vB
    if (sortConfig.key === 'symbol') { vA = a.symbol; vB = b.symbol }
    if (sortConfig.key === 'vwap') { vA = a.vwapDeviation || 0; vB = b.vwapDeviation || 0 }
    if (sortConfig.key === 'aggressor') { vA = a.aggressorDelta || 0; vB = b.aggressorDelta || 0 }
    if (sortConfig.key === 'confidence') { vA = a.confidence || 0; vB = b.confidence || 0 }
    if (vA < vB) return sortConfig.direction === 'asc' ? -1 : 1
    if (vA > vB) return sortConfig.direction === 'asc' ? 1 : -1
    return 0
  })

  const requestSort = (key) => setSortConfig(prev => ({ key, direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc' }))
  const renderSortArrow = (key) => sortConfig.key === key ? (sortConfig.direction === 'asc' ? ' ↑' : ' ↓') : ''

  const formatClock = (d) => d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'

  const severityTabs = [
    { key: 'all', label: 'ALL', color: '#cbd5e1' },
    { key: 'bullish', label: '▲ BULL', color: '#10b981' },
    { key: 'bearish', label: '▼ BEAR', color: '#ef4444' },
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

          {filteredStocks.map(stock => {
            const isBullish = stock.alerts.some(a => a.severity === 'bullish')
            const isBearish = stock.alerts.some(a => a.severity === 'bearish')
            const dotColor = isBullish ? '#10b981' : isBearish ? '#ef4444' : '#f59e0b'
            const dotGlyph = isBullish ? '▲' : isBearish ? '▼' : '■'

            const dev = stock.vwapDeviation !== null && stock.vwapDeviation !== undefined ? stock.vwapDeviation : 0
            const devColor = dev > 0.5 ? '#10b981' : dev < -0.5 ? '#ef4444' : 'var(--text-secondary)'

            const rsiHistory = stock.rsiHistory || []
            const lastRsi = rsiHistory.length ? rsiHistory[rsiHistory.length - 1] : stock.rsi
            const sparkPoints = rsiHistory.map((val, idx) => {
              const x = (idx / (rsiHistory.length - 1 || 1)) * 40
              const y = 20 - ((val / 100) * 20)
              return `${x},${y}`
            }).join(' ')

            const agg = stock.aggressorDelta || 0
            const rectWidth = Math.abs(agg) * 50

            const tp = stock.tradePlan || { action: 'UNK', tgt: null, sl: null, rrRatio: null }
            const isBuyAction = tp.action === 'BUY SEEN'
            const isBreakoutAction = tp.action.includes('BREAKOUT')
            const isBearishAction = tp.action.includes('SELL') || tp.action === 'AVOID'
            const actColor = isBuyAction ? '#10b981'
              : isBearishAction ? '#ef4444'
                : isBreakoutAction ? '#fcd34d'
                  : '#f59e0b'
            const actGlyph = isBuyAction ? '▲ ' : isBearishAction ? '▼ ' : ''

            const trendLabel = stock.regime === 'STRONG TREND' && stock.trendDirection
              ? (stock.trendDirection === 'BULL' ? 'STRONG TREND ▲' : 'STRONG TREND ▼')
              : stock.regime

            return (
              <div key={stock.symbol} className="quant-row" style={{ display: 'flex', flexDirection: 'column' }}>

                {/* Main Content Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(200px, 1.2fr) minmax(240px, 1.5fr) minmax(140px, 1fr) minmax(120px, 0.6fr)', gap: '1rem', padding: '0.6rem 1.25rem', alignItems: 'center' }}>

                  {/* Symbol & Price */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ color: dotColor, fontSize: '0.7rem', fontWeight: 800, width: '10px', textAlign: 'center' }}>{dotGlyph}</span>
                      <Link to={`/instrument/${stock.token}?symbol=${stock.symbol}`} style={{ fontSize: '1rem', fontWeight: '800', color: '#f8fafc', textDecoration: 'none', letterSpacing: '0.5px' }}>
                        {stock.symbol}
                      </Link>
                      {stock.divergence && (
                        <span
                          title={`Price vs RSI divergence — ${stock.divergence === 'BUY SETUP' ? 'bullish reversal hint' : 'bearish reversal hint'}`}
                          style={{
                            fontSize: '0.5rem', fontWeight: 800, padding: '0.1rem 0.35rem',
                            border: `1px solid ${stock.divergence === 'BUY SETUP' ? '#a78bfa' : '#f472b6'}`,
                            color: stock.divergence === 'BUY SETUP' ? '#a78bfa' : '#f472b6',
                            borderRadius: '3px', letterSpacing: '0.5px'
                          }}
                        >
                          {stock.divergence === 'BUY SETUP' ? '↗ DIV' : '↘ DIV'}
                        </span>
                      )}
                    </div>
                    <div className="mono" style={{ fontSize: '0.85rem', color: '#cbd5e1', marginTop: '0.2rem', marginLeft: '1.2rem' }}>
                      {stock.price?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>

                  {/* Core Technicals */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span className="dotted-underline" style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }} title="20-day VWAP deviation: gap between current price and the 20-day volume-weighted average.">VWAP-20 DEV</span>
                      <span className="mono" style={{ fontSize: '0.9rem', color: devColor, fontWeight: 700 }}>
                        {dev > 0 ? '+' : ''}{dev.toFixed(2)}%
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span className="dotted-underline" style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }} title="Relative Strength Index (14 Days) with 10-day sparkline.">RSI (14)</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span className="mono" style={{ fontSize: '0.9rem', color: stock.rsi > 70 ? '#ef4444' : stock.rsi < 30 ? '#10b981' : 'var(--text-secondary)', fontWeight: 700 }}>
                          {stock.rsi}
                        </span>
                        {rsiHistory.length > 0 && (
                          <svg width="40" height="20" style={{ overflow: 'visible' }}>
                            <polyline points={sparkPoints} fill="none" stroke="#475569" strokeWidth="1.5" />
                            <circle cx="40" cy={20 - ((lastRsi / 100) * 20)} r="2" fill={lastRsi > 70 ? '#ef4444' : lastRsi < 30 ? '#10b981' : '#cbd5e1'} />
                          </svg>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Money Flow Gauge */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }} title="Chaikin-style money flow index: +1 = heavy accumulation, -1 = heavy distribution.">
                    <div style={{ width: '100%', maxWidth: '240px', height: '6px', background: '#1e293b', position: 'relative', borderRadius: '1px' }}>
                      <div style={{ position: 'absolute', left: '50%', top: '-2px', bottom: '-2px', width: '2px', background: '#64748b' }}></div>
                      {agg < 0 && (
                        <div style={{ position: 'absolute', right: '50%', top: 0, height: '100%', width: `${rectWidth}%`, background: '#FF3D00' }}></div>
                      )}
                      {agg > 0 && (
                        <div style={{ position: 'absolute', left: '50%', top: 0, height: '100%', width: `${rectWidth}%`, background: '#00E5FF' }}></div>
                      )}
                    </div>
                    <div className="mono" style={{ fontSize: '0.65rem', color: '#94a3b8', marginTop: '0.3rem', display: 'flex', justifyContent: 'space-between', width: '100%', maxWidth: '240px' }}>
                      <span>-1.0</span>
                      <span style={{ color: agg > 0 ? '#00E5FF' : agg < 0 ? '#FF3D00' : '#94a3b8' }}>{agg.toFixed(2)}</span>
                      <span>+1.0</span>
                    </div>
                    {stock.volSurge !== undefined && stock.volSurge > 0 && (
                      <div className="mono" style={{ fontSize: '0.55rem', color: stock.volumeConfirmed ? '#10b981' : '#94a3b8', marginTop: '0.2rem', letterSpacing: '0.5px' }}
                        title={stock.volumeConfirmed ? 'Volume confirmed: ≥1.5× 20-day average' : 'Volume below 1.5× 20-day average'}>
                        VOL {stock.volSurge.toFixed(1)}× {stock.volumeConfirmed ? '✓' : ''}
                      </div>
                    )}
                  </div>

                  {/* Trade Plan */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.2rem' }}>
                    <span title={tp.reason} style={{
                      fontSize: '0.65rem', fontWeight: 800, padding: '0.15rem 0.5rem',
                      border: `1px solid ${actColor}`, color: actColor, borderRadius: '4px',
                      textShadow: `0 0 4px rgba(${actColor === '#10b981' ? '16,185,129' : actColor === '#ef4444' ? '239,68,68' : '245,158,11'}, 0.2)`,
                      cursor: 'help', whiteSpace: 'nowrap'
                    }}>
                      {actGlyph}{tp.action}
                    </span>

                    {stock.isBreakout && (
                      <div style={{ fontSize: '0.55rem', fontWeight: 800, color: '#fcd34d', background: 'rgba(252,211,77,0.15)', padding: '0.1rem 0.4rem', borderRadius: '3px', marginTop: '0.2rem', letterSpacing: '0.5px' }} title="Price has crossed the 20-day resistance ceiling.">
                        🚀 BREAKOUT
                      </div>
                    )}

                    {(tp.tgt || tp.sl) && (
                      <div style={{ display: 'flex', gap: '0.6rem', fontSize: '0.55rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                        {tp.tgt && <span title="Target exit level">TG: ₹{tp.tgt}</span>}
                        {tp.sl && <span title="Suggested stop loss" style={{ color: '#ef4444' }}>SL: ₹{tp.sl}</span>}
                      </div>
                    )}

                    {tp.rrRatio !== null && tp.rrRatio !== undefined && (tp.tgt || tp.sl) && (
                      <div style={{
                        fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.5px',
                        color: tp.rrRatio >= 2 ? '#10b981' : tp.rrRatio >= 1.5 ? '#06b6d4' : '#94a3b8'
                      }} title="Reward-to-risk ratio: (TG − price) / (price − SL)">
                        R:R {tp.rrRatio}×
                      </div>
                    )}

                    <span style={{ fontSize: '0.5rem', color: '#64748b', fontWeight: 600, marginTop: '2px' }}>
                      ({trendLabel})
                    </span>
                  </div>

                  {/* Confidence Score — Click to open modal */}
                  <div
                    className="conviction-click"
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center', position: 'relative' }}
                    title="Click for conviction breakdown"
                    onClick={() => setModalStock(stock)}
                  >
                    {(() => {
                      const conf = stock.confidence
                      const cColor = conf > 75 ? '#10b981' : conf < 40 ? '#ef4444' : '#f59e0b'
                      const shadowAlpha = conf > 75 ? '16,185,129,0.4' : conf < 40 ? '239,68,68,0.4' : '245,158,11,0.4'
                      return (
                        <span className="mono" style={{ fontSize: '1.4rem', fontWeight: 800, color: cColor, textShadow: `0 0 8px rgba(${shadowAlpha})` }}>
                          {conf}%
                        </span>
                      )
                    })()}
                    <span style={{ fontSize: '0.55rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Conviction ⓘ</span>
                  </div>

                </div>

                {/* 20-Day Range Tracker */}
                <div style={{ width: '100%', padding: '0.4rem 1.25rem', background: 'rgba(0,0,0,0.15)', borderTop: '1px solid rgba(255,255,255,0.02)', display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.65rem', color: 'var(--text-secondary)', boxSizing: 'border-box' }} title="20-day Donchian price range (prior 20 days, excluding today)">
                  {(() => {
                    if (!stock.support || !stock.resistance) return <span style={{ paddingLeft: '1rem' }}>AWAITING MAP DATA</span>
                    const span = stock.resistance - stock.support
                    if (span <= 0) return null
                    const pPos = Math.max(0, Math.min(100, ((stock.price - stock.support) / span) * 100))

                    return (
                      <>
                        <span className="mono" style={{ color: '#f59e0b', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>S: ₹{stock.support.toFixed(1)}</span>
                        <div style={{ flex: 1, height: '4px', background: '#1e293b', borderRadius: '2px', position: 'relative' }}>
                          <div style={{ position: 'absolute', left: 0, width: `${pPos}%`, height: '100%', background: 'rgba(255,255,255,0.1)', borderRadius: '2px 0 0 2px' }}></div>
                          <div style={{ position: 'absolute', left: `${pPos}%`, top: '-4px', bottom: '-4px', width: '3px', background: '#f8fafc', borderRadius: '1px', transform: 'translateX(-50%)', boxShadow: '0 0 4px rgba(255,255,255,0.5)', zIndex: 5 }}></div>
                        </div>
                        <span className="mono" style={{ color: '#ef4444', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>R: ₹{stock.resistance.toFixed(1)}</span>
                      </>
                    )
                  })()}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Conviction Breakdown Modal */}
      {modalStock && (() => {
        // Reconstruct breakdown client-side if backend doesn't provide it
        const breakdown = modalStock.confBreakdown || (() => {
          const bd = [{ label: 'Base', value: 30 }]
          const rsi = modalStock.rsi
          if (rsi !== null && rsi !== undefined) {
            if (rsi > 40 && rsi < 70) bd.push({ label: 'RSI in healthy zone', value: 10 })
            if (rsi <= 30) bd.push({ label: 'RSI oversold (rebound setup)', value: 15 })
            if (rsi >= 75) bd.push({ label: 'RSI severely overbought', value: -10 })
          }
          if (modalStock.sma5 && modalStock.sma20) {
            if (modalStock.sma5 > modalStock.sma20) bd.push({ label: 'SMA5 > SMA20 (short-term momentum)', value: 15 })
            else bd.push({ label: 'SMA5 < SMA20 (short-term bearish)', value: -5 })
          }
          if (modalStock.sma50 && modalStock.sma200) {
            if (modalStock.sma50 > modalStock.sma200) bd.push({ label: 'SMA50 > SMA200 (golden state)', value: 10 })
            else {
              if (modalStock.price > modalStock.sma50 && modalStock.price > modalStock.sma200) bd.push({ label: 'Death cross (softened: price leads)', value: -5 })
              else bd.push({ label: 'Death cross', value: -10 })
            }
          }
          const vd = modalStock.vwapDeviation
          if (vd !== null && vd !== undefined) {
            if (vd > 0) bd.push({ label: 'Price above 20d VWAP', value: 10 })
            if (vd < -2) bd.push({ label: 'Deep below 20d VWAP', value: -10 })
          }
          const agg = modalStock.aggressorDelta || 0
          if (agg > 0.3) bd.push({ label: 'Strong accumulation (money flow)', value: 10 })
          if (agg < -0.2) bd.push({ label: 'Distribution (money flow)', value: -10 })
          if (modalStock.regime === 'STRONG TREND') bd.push({ label: 'Trending regime', value: 5 })
          if (modalStock.regime === 'WILD SWINGS') bd.push({ label: 'Volatile regime', value: -10 })
          if (modalStock.sma50 && modalStock.sma200 && modalStock.price > modalStock.sma50 && modalStock.price > modalStock.sma200) {
            bd.push({ label: 'Price leads both MAs', value: 10 })
          }
          return bd
        })()

        return (
        <div className="conv-modal-backdrop" onClick={() => setModalStock(null)} onKeyDown={(e) => e.key === 'Escape' && setModalStock(null)}>
          <div className="conv-modal" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="conv-modal-header">
              <div>
                <div style={{ fontSize: '0.65rem', color: '#94a3b8', letterSpacing: '1px', marginBottom: '0.25rem' }}>CONVICTION BREAKDOWN</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
                  <span style={{ fontSize: '1.1rem', fontWeight: 800, color: '#f8fafc' }}>{modalStock.symbol}</span>
                  {(() => {
                    const conf = modalStock.confidence
                    const cColor = conf > 75 ? '#10b981' : conf < 40 ? '#ef4444' : '#f59e0b'
                    return <span className="mono" style={{ fontSize: '1.6rem', fontWeight: 800, color: cColor }}>{conf}%</span>
                  })()}
                </div>
              </div>
              <button className="conv-modal-close" onClick={() => setModalStock(null)}>✕</button>
            </div>

            {/* Body */}
            <div className="conv-modal-body">
              {/* Score gauge arc */}
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.25rem' }}>
                {(() => {
                  const total = breakdown.reduce((sum, c) => sum + Math.abs(c.value), 0)
                  const positives = breakdown.filter(c => c.value > 0).reduce((s, c) => s + c.value, 0)
                  const negatives = breakdown.filter(c => c.value < 0).reduce((s, c) => s + Math.abs(c.value), 0)
                  return (
                    <div style={{ display: 'flex', gap: '2rem', alignItems: 'center' }}>
                      <div style={{ textAlign: 'center' }}>
                        <div className="mono" style={{ fontSize: '0.7rem', color: '#10b981', fontWeight: 700 }}>+{positives}</div>
                        <div style={{ fontSize: '0.55rem', color: '#64748b', marginTop: '2px' }}>BULLISH</div>
                      </div>
                      <div style={{ width: '120px' }}>
                        <div style={{ height: '8px', background: '#1e293b', borderRadius: '4px', overflow: 'hidden', display: 'flex' }}>
                          <div style={{ width: `${total > 0 ? (positives / total) * 100 : 50}%`, background: 'linear-gradient(90deg, #10b981, #34d399)', height: '100%' }}></div>
                          <div style={{ width: `${total > 0 ? (negatives / total) * 100 : 50}%`, background: 'linear-gradient(90deg, #f87171, #ef4444)', height: '100%' }}></div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '0.5rem', color: '#64748b' }}>
                          <span>Positive</span>
                          <span>Negative</span>
                        </div>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div className="mono" style={{ fontSize: '0.7rem', color: '#ef4444', fontWeight: 700 }}>−{negatives}</div>
                        <div style={{ fontSize: '0.55rem', color: '#64748b', marginTop: '2px' }}>BEARISH</div>
                      </div>
                    </div>
                  )
                })()}
              </div>

              {/* Component rows */}
              <div style={{ fontSize: '0.6rem', color: '#64748b', letterSpacing: '1px', fontWeight: 700, marginBottom: '0.5rem', display: 'grid', gridTemplateColumns: '1fr 50px 1fr', gap: '0.5rem' }}>
                <span>SIGNAL</span>
                <span style={{ textAlign: 'center' }}>PTS</span>
                <span style={{ textAlign: 'right' }}>IMPACT</span>
              </div>

              {breakdown.map((c, i) => {
                const isPositive = c.value > 0
                const isBase = c.label === 'Base'
                const barColor = isBase ? '#475569' : isPositive ? '#10b981' : '#ef4444'
                const barWidth = isBase ? 30 : Math.min(100, Math.abs(c.value) * 6.5)
                return (
                  <div key={i} className="conv-row">
                    <span style={{ fontSize: '0.72rem', color: isBase ? '#94a3b8' : '#cbd5e1', fontWeight: isBase ? 500 : 600 }}>
                      {isBase ? '🏁 ' : isPositive ? '✅ ' : '⚠️ '}{c.label}
                    </span>
                    <span className="mono" style={{
                      fontSize: '0.8rem', fontWeight: 800, textAlign: 'center',
                      color: isBase ? '#94a3b8' : isPositive ? '#10b981' : '#ef4444'
                    }}>
                      {isBase ? c.value : (isPositive ? '+' : '')}{isBase ? '' : c.value}
                    </span>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <div className="conv-bar-track" style={{ maxWidth: '140px' }}>
                        <div className="conv-bar-fill" style={{ width: `${barWidth}%`, background: barColor }}></div>
                      </div>
                    </div>
                  </div>
                )
              })}

              {/* Formula footer */}
              <div style={{
                marginTop: '1rem', padding: '0.75rem', background: 'rgba(255,255,255,0.02)',
                borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)'
              }}>
                <div style={{ fontSize: '0.6rem', color: '#64748b', letterSpacing: '1px', fontWeight: 700, marginBottom: '0.4rem' }}>HOW IT WORKS</div>
                <div style={{ fontSize: '0.7rem', color: '#94a3b8', lineHeight: 1.6 }}>
                  Score starts at <span className="mono" style={{ color: '#f8fafc', fontWeight: 700 }}>30</span> (base).
                  Each technical signal adds or subtracts points based on its strength.
                  Final score is clamped to <span className="mono" style={{ color: '#f8fafc' }}>0–100</span>.
                </div>
                <div className="mono" style={{ fontSize: '0.65rem', color: '#475569', marginTop: '0.5rem' }}>
                  {breakdown.map(c => (c.value >= 0 ? `+${c.value}` : `${c.value}`)).join(' ')} = <span style={{ color: '#f8fafc', fontWeight: 700 }}>{breakdown.reduce((s, c) => s + c.value, 0)}</span> → clamped to <span style={{ color: modalStock.confidence > 75 ? '#10b981' : modalStock.confidence < 40 ? '#ef4444' : '#f59e0b', fontWeight: 800 }}>{modalStock.confidence}%</span>
                </div>
              </div>

              {/* Key metrics context */}
              <div style={{ marginTop: '1rem', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.6rem' }}>
                {[
                  { label: 'RSI (14)', value: modalStock.rsi?.toFixed(1) || '—', color: modalStock.rsi > 70 ? '#ef4444' : modalStock.rsi < 30 ? '#10b981' : '#cbd5e1' },
                  { label: 'VWAP Dev', value: modalStock.vwapDeviation !== null ? `${modalStock.vwapDeviation > 0 ? '+' : ''}${modalStock.vwapDeviation.toFixed(2)}%` : '—', color: modalStock.vwapDeviation > 0 ? '#10b981' : '#ef4444' },
                  { label: 'Regime', value: modalStock.regime, color: modalStock.regime === 'STRONG TREND' ? '#10b981' : modalStock.regime === 'WILD SWINGS' ? '#ef4444' : '#f59e0b' },
                ].map((m, idx) => (
                  <div key={idx} style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '6px', padding: '0.5rem 0.6rem', border: '1px solid rgba(255,255,255,0.04)' }}>
                    <div style={{ fontSize: '0.55rem', color: '#64748b', letterSpacing: '0.5px', marginBottom: '0.2rem' }}>{m.label}</div>
                    <div className="mono" style={{ fontSize: '0.8rem', fontWeight: 700, color: m.color }}>{m.value}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        )
      })()}
    </div>
  )
}

export default Alerts
