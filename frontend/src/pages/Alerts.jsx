import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

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
  const searchInputRef = useRef(null)

  useEffect(() => {
    let pollInterval;
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)

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

        const res = await fetch('/api/alerts')
        if (!res.ok) throw new Error('Failed to fetch alerts')
        const data = await res.json()
        setAlerts(data)
        setCacheProgress(null)
        setLoading(false)
        clearInterval(pollInterval)
      } catch (err) {
        setError(err.message)
        setLoading(false)
        clearInterval(pollInterval)
      }
    }

    setLoading(true)
    checkAndFetchAlerts()
    pollInterval = setInterval(checkAndFetchAlerts, 2000)

    return () => {
      clearInterval(pollInterval)
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

  // Aggregate simple counts for the header stats (even if we are dropping the big cards to save space, we keep them as tiny terminal stats)
  const bullishCount = allAlertsList.filter(a => a.severity === 'bullish').length
  const bearishCount = allAlertsList.filter(a => a.severity === 'bearish').length

  let filteredStocks = (alerts || [])
    .filter(s => s.symbol.toLowerCase().includes(searchQuery.toLowerCase()))
    .filter(s => {
      if (filter === 'all') return true;
      return s.alerts.some(a => a.severity === filter)
    })
    .filter(s => {
      return filterBreakouts ? s.isBreakout : true;
    })

  // Apply Sorting
  filteredStocks.sort((a, b) => {
    let vA, vB;
    if (sortConfig.key === 'symbol') { vA = a.symbol; vB = b.symbol; }
    if (sortConfig.key === 'vwap') { vA = a.vwapDeviation || 0; vB = b.vwapDeviation || 0; }
    if (sortConfig.key === 'aggressor') { vA = a.aggressorDelta || 0; vB = b.aggressorDelta || 0; }
    if (sortConfig.key === 'confidence') { vA = a.confidence || 0; vB = b.confidence || 0; }

    if (vA < vB) return sortConfig.direction === 'asc' ? -1 : 1;
    if (vA > vB) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

  const requestSort = (key) => setSortConfig(prev => ({ key, direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc' }))
  const renderSortArrow = (key) => sortConfig.key === key ? (sortConfig.direction === 'asc' ? ' ↑' : ' ↓') : ''

  return (
    <div className="dashboard-layout terminal-alerts" style={{ maxWidth: '1200px', margin: '0 auto' }}>

      {/* Required base CSS for the UI */}
      <style>{`
        .quant-row {
          position: relative;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.05);
          border-radius: 8px;
          margin-bottom: 0.75rem;
          transition: background 0.15s, border-color 0.15s;
          overflow: hidden;
        }
        .quant-row:hover {
          background: rgba(255,255,255,0.04);
          border-color: rgba(255,255,255,0.1);
        }
        .sort-header { cursor: pointer; user-select: none; transition: color 0.2s; display: flex; align-items: center; gap: 0.3rem }
        .sort-header:hover { color: #f8fafc; }
        .info-icon { opacity: 0.6; font-size: 0.8rem; cursor: help; }
        .info-icon:hover { opacity: 1; }
        .dotted-underline { border-bottom: 1px dotted rgba(255,255,255,0.4); text-decoration: none; cursor: help; }
      `}</style>

      {/* Terminal Header */}
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '1px solid #1e293b', paddingBottom: '1rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.2rem', color: '#fff', letterSpacing: '1px', textTransform: 'uppercase' }}>Technical Alerts</h1>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', fontSize: '0.75rem', fontFamily: "'JetBrains Mono', monospace", color: '#94a3b8' }}>
            <span>ACTIVE: <span style={{ color: '#fff' }}>{allAlertsList.length}</span></span>
            <span>BULL: <span style={{ color: '#00E5FF' }}>{bullishCount}</span></span>
            <span>BEAR: <span style={{ color: '#FF3D00' }}>{bearishCount}</span></span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
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
          <div style={{ display: 'flex', gap: '0.5rem', fontFamily: "'JetBrains Mono', monospace" }}>
            <button
              onClick={() => setFilterBreakouts(!filterBreakouts)}
              style={{ fontSize: '0.7rem', fontWeight: filterBreakouts ? '800' : '500', padding: '0.3rem 0.6rem', background: filterBreakouts ? 'rgba(16,185,129,0.2)' : 'transparent', color: filterBreakouts ? '#10b981' : '#cbd5e1', border: `1px solid ${filterBreakouts ? '#10b981' : '#334155'}`, borderRadius: '4px', cursor: 'pointer', transition: 'all 0.2s' }}
              title="Show only stocks breaking above their 20-day resistance ceilings"
            >
              🚀 Breakouts
            </button>
            <button
              onClick={() => setShowLegend(!showLegend)}
              style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem', background: showLegend ? '#1e293b' : 'transparent', color: '#cbd5e1', border: '1px solid #334155', borderRadius: '4px', cursor: 'pointer' }}
            >
              {showLegend ? 'Close Guide' : '📖 How to read this'}
            </button>
            <span style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem', background: 'rgba(0,229,255,0.1)', color: '#00E5FF', border: '1px solid rgba(0,229,255,0.2)', borderRadius: '4px', display: 'flex', alignItems: 'center' }}>SYS_ON</span>
          </div>
        </div>
      </header>

      {/* Educational Cheatsheet Legend */}
      {showLegend && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', padding: '1.25rem', marginBottom: '1.5rem', color: '#cbd5e1', fontSize: '0.8rem', lineHeight: '1.5' }}>
          <h3 style={{ margin: '0 0 0.75rem 0', color: '#f8fafc', fontSize: '0.9rem' }}>Terminal Cheat Sheet</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
            <div>
              <strong style={{ color: '#00E5FF' }}>AVWAP DEV (Avg Cost Gap):</strong> Shows if the current price is higher (+) or lower (-) than the average price large institutions have paid over the last 20 days. <br /><em>Look for:</em> Trading heavily below this (-2% or more) can mean severe selling pressure; breaking above it indicates institutional support.
            </div>
            <div>
              <strong style={{ color: '#FF3D00' }}>BUY / SELL PRESSURE:</strong> A gauge mapping aggressive buying vs. selling. Moves right (Cyan) when buyers act fast. Moves left (Red) when sellers dump heavily.<br /><em>Look for:</em> Gauges pegged aggressively right (+0.50 to +1.0) generally confirm a rally's health.
            </div>
            <div>
              <strong style={{ color: '#10b981' }}>MOMENTUM SCORE & REGIME:</strong> The 0-100% score mixes trend alignment, RSI health, and big money flow. The Regime tells you if the stock is moving in a CLEAR DIRECTION (Strong Trend), swinging unpredictably (Wild Swings), or bouncing sideways (Range-Bound).
            </div>
            <div>
              <strong style={{ color: '#f59e0b' }}>PRICE LEVEL MAP (S/R):</strong> The slider at the bottom shows where the stock is currently trading (White line) compared to its 20-day deep low (S - Support floor) and 20-day high (R - Resistance ceiling). <br /><em>Look for:</em> If the needle is against the far right (R), the stock is breaking out!
            </div>
            <div style={{ gridColumn: '1 / -1', borderTop: '1px solid #334155', paddingTop: '1rem', marginTop: '0.25rem' }}>
              <strong style={{ color: '#ec4899', fontSize: '0.85rem' }}>TRADE PLAN — What Each Tag Means & What To Do:</strong>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginTop: '0.75rem' }}>
                <div>
                  <span style={{ color: '#10b981', fontWeight: 800 }}>BUY SEEN</span> — The algorithm sees a high-probability buying opportunity. Momentum, trend, and volume all align.<br />
                  <em>Action:</em> Consider entering a position. Use the TG (Target) as your profit goal and SL (Stop Loss) as your safety exit.
                </div>
                <div>
                  <span style={{ color: '#fcd34d', fontWeight: 800 }}>BREAKOUT (CAUTION)</span> — Price has punched above its 20-day ceiling, but the overall health score is moderate.<br />
                  <em>Action:</em> Watch closely for 1-2 days. If price holds above resistance with increasing volume, it confirms the breakout. Don't rush in yet.
                </div>
                <div>
                  <span style={{ color: '#fcd34d', fontWeight: 800 }}>BREAKOUT (WEAK)</span> — Price crossed resistance but technicals are poor. High chance of a "bull trap" (fake breakout that reverses).<br />
                  <em>Action:</em> Do NOT buy. Wait for the score to improve above 60% before considering entry.
                </div>
                <div>
                  <span style={{ color: '#f59e0b', fontWeight: 800 }}>HOLD / WAIT</span> — No clear edge. The stock isn't showing a strong enough setup in either direction.<br />
                  <em>Action:</em> If you own it, hold your position. If you're looking to buy, wait for a better setup (BUY SEEN or confirmed BREAKOUT).
                </div>
                <div>
                  <span style={{ color: '#f59e0b', fontWeight: 800 }}>HOLD (OVERBOUGHT)</span> — Momentum is strong, but RSI is stretched above 70. Buying here risks an immediate short-term pullback.<br />
                  <em>Action:</em> If you own it, hold and enjoy the ride. Do NOT buy new shares at this level — wait for RSI to cool below 65.
                </div>
                <div>
                  <span style={{ color: '#ef4444', fontWeight: 800 }}>SELL (AT RANGE)</span> — The stock is bouncing inside a fixed price box and has hit the ceiling. It doesn't have enough power to break through.<br />
                  <em>Action:</em> If you're in profit, book partial profits now. The ceiling usually pushes price back down. Do NOT buy here.
                </div>
                <div>
                  <span style={{ color: '#ef4444', fontWeight: 800 }}>AVOID</span> — Technical health is severely broken. Trend structure has collapsed or price is swinging wildly and unpredictably.<br />
                  <em>Action:</em> Stay away completely. If you own it, set a tight stop-loss at the SL level. Don't add more money. Reconsider only when the regime improves.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* List Layout */}
      {filteredStocks.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>NO SIGNALS MATCH QUERY</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Column Headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(200px, 1.2fr) minmax(240px, 1.5fr) minmax(130px, 1fr) minmax(120px, 0.6fr)', gap: '1rem', padding: '0 1rem 0.5rem 1rem', fontSize: '0.65rem', color: 'var(--text-secondary)', letterSpacing: '1px', fontWeight: 700 }}>
            <div onClick={() => requestSort('symbol')} className="sort-header" title="Filter alphabetically or by raw asset price">SYMBOL / PRICE {renderSortArrow('symbol')}</div>
            <div onClick={() => requestSort('vwap')} className="sort-header" title="Anchored volume weighted average price deviation and Relative Strength trends">CORE TECHNICALS <span className="info-icon">ⓘ</span> {renderSortArrow('vwap')}</div>
            <div onClick={() => requestSort('aggressor')} className="sort-header" style={{ justifyContent: 'center' }} title="Right (Cyan) = Aggressive buying. Left (Red) = Heavy institutional selling.">BUY/SELL PRESSURE <span className="info-icon">ⓘ</span> {renderSortArrow('aggressor')}</div>
            <div style={{ textAlign: 'center' }} title="Algorithmic entry and exit positioning">TRADE PLAN <span className="info-icon">ⓘ</span></div>
            <div onClick={() => requestSort('confidence')} className="sort-header" style={{ justifyContent: 'flex-end' }} title="Overall systemic conviction probability">MOMENTUM {renderSortArrow('confidence')}</div>
          </div>

          {filteredStocks.map(stock => {
            const isBullish = stock.alerts.some(a => a.severity === 'bullish')
            const isBearish = stock.alerts.some(a => a.severity === 'bearish')
            const dotColor = isBullish ? '#10b981' : isBearish ? '#ef4444' : '#f59e0b'

            // AVWAP DEV Logic
            const dev = stock.vwapDeviation || 0;
            const devColor = dev > 0.5 ? '#10b981' : dev < -0.5 ? '#ef4444' : 'var(--text-secondary)';

            // RSI Sparkline
            const rsiHistory = stock.rsiHistory || [];
            const sparkPoints = rsiHistory.map((val, idx) => {
              const x = (idx / (rsiHistory.length - 1 || 1)) * 40;
              const y = 20 - ((val / 100) * 20);
              return `${x},${y}`;
            }).join(' ');

            // Aggressor Delta Logic (-1 to +1)
            const agg = stock.aggressorDelta || 0;
            const rectWidth = Math.abs(agg) * 50;

            return (
              <div key={stock.symbol} className="quant-row" style={{ display: 'flex', flexDirection: 'column' }}>

                {/* Main Content Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(200px, 1.2fr) minmax(240px, 1.5fr) minmax(130px, 1fr) minmax(120px, 0.6fr)', gap: '1rem', padding: '0.6rem 1rem', alignItems: 'center' }}>

                  {/* Symbol & Price */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ width: '6px', height: '6px', background: dotColor, borderRadius: '50%' }}></span>
                      <Link to={`/instrument/${stock.token}?symbol=${stock.symbol}`} style={{ fontSize: '1rem', fontWeight: '800', color: '#f8fafc', textDecoration: 'none', letterSpacing: '0.5px' }}>
                        {stock.symbol}
                      </Link>
                    </div>
                    <div className="mono" style={{ fontSize: '0.85rem', color: '#cbd5e1', marginTop: '0.2rem', marginLeft: '0.9rem' }}>
                      {stock.price?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>

                  {/* Core Technicals */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span className="dotted-underline" style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }} title="Anchored VWAP Deviation: The gap between the current price and the 20-day institutional average cost basis.">AVWAP DEV</span>
                      <span className="mono" style={{ fontSize: '0.9rem', color: devColor, fontWeight: 700 }}>
                        {dev > 0 ? '+' : ''}{dev.toFixed(2)}%
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span className="dotted-underline" style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }} title="Relative Strength Index (14 Days) plotted alongside a 10-day historical sparkline to detect momentum direction.">RSI (14)</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span className="mono" style={{ fontSize: '0.9rem', color: stock.rsi > 70 ? '#ef4444' : stock.rsi < 30 ? '#10b981' : 'var(--text-secondary)', fontWeight: 700 }}>
                          {stock.rsi}
                        </span>
                        {rsiHistory.length > 0 && (
                          <svg width="40" height="20" style={{ overflow: 'visible' }}>
                            <polyline points={sparkPoints} fill="none" stroke="#475569" strokeWidth="1.5" />
                            {/* Current point */}
                            <circle cx="40" cy={20 - ((stock.rsi / 100) * 20)} r="2" fill={stock.rsi > 70 ? '#ef4444' : stock.rsi < 30 ? '#10b981' : '#cbd5e1'} />
                          </svg>
                        )}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }} title="Calculated using Money Flow Multipliers to gauge true aggressive accumulation (+ side) vs aggressive distribution (- side)">
                    <div style={{ width: '100%', maxWidth: '240px', height: '6px', background: '#1e293b', position: 'relative', borderRadius: '1px' }}>
                      {/* Center Point */}
                      <div style={{ position: 'absolute', left: '50%', top: '-2px', bottom: '-2px', width: '2px', background: '#64748b' }}></div>
                      {/* Crimson Left (Selling) */}
                      {agg < 0 && (
                        <div style={{ position: 'absolute', right: '50%', top: 0, height: '100%', width: `${rectWidth}%`, background: '#FF3D00' }}></div>
                      )}
                      {/* Cyan Right (Buying) */}
                      {agg > 0 && (
                        <div style={{ position: 'absolute', left: '50%', top: 0, height: '100%', width: `${rectWidth}%`, background: '#00E5FF' }}></div>
                      )}
                    </div>
                    <div className="mono" style={{ fontSize: '0.65rem', color: '#94a3b8', marginTop: '0.3rem', display: 'flex', justifyContent: 'space-between', width: '100%', maxWidth: '240px' }}>
                      <span>-1.0</span>
                      <span style={{ color: agg > 0 ? '#00E5FF' : agg < 0 ? '#FF3D00' : '#94a3b8' }}>{agg.toFixed(2)}</span>
                      <span>+1.0</span>
                    </div>
                  </div>

                  {/* Trade Plan */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.2rem' }}>
                    {(() => {
                      const tp = stock.tradePlan || { action: 'UNK', tgt: null, sl: null };
                      const actColor = tp.action === 'BUY SEEN' ? '#10b981'
                        : tp.action.includes('SELL') || tp.action === 'AVOID' ? '#ef4444'
                          : tp.action.includes('BREAKOUT') ? '#fcd34d'
                            : '#f59e0b';
                      return (
                        <>
                          <span title={tp.reason} style={{
                            fontSize: '0.65rem', fontWeight: 800, padding: '0.15rem 0.5rem',
                            border: `1px solid ${actColor}`, color: actColor, borderRadius: '4px', textShadow: `0 0 4px rgba(${actColor === '#10b981' ? '16,185,129' : actColor === '#ef4444' ? '239,68,68' : '245,158,11'}, 0.2)`, cursor: 'help'
                          }}>
                            {tp.action}
                          </span>

                          {stock.isBreakout && (
                            <div style={{ fontSize: '0.55rem', fontWeight: 800, color: '#fcd34d', background: 'rgba(252,211,77,0.15)', padding: '0.1rem 0.4rem', borderRadius: '3px', marginTop: '0.2rem', letterSpacing: '0.5px' }} title="Current price has shattered the 20-day resistance ceiling!">
                              🚀 BREAKOUT
                            </div>
                          )}

                          {(tp.tgt || tp.sl) && (
                            <div style={{ display: 'flex', gap: '0.6rem', fontSize: '0.55rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                              {tp.tgt && <span title="Target Exit Level">TG: ₹{tp.tgt}</span>}
                              {tp.sl && <span title="Suggested Stop Loss level" style={{ color: '#ef4444' }}>SL: ₹{tp.sl}</span>}
                            </div>
                          )}
                          <span style={{ fontSize: '0.5rem', color: '#64748b', fontWeight: 600, marginTop: '2px' }}>
                            ({stock.regime})
                          </span>
                        </>
                      )
                    })()}
                  </div>

                  {/* Confidence Score (Permanent) */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center' }} title="Algorithmic Conviction Score derived from AVWAP, SMA Alignments, and Institutional Money Flow Delta. Scores > 80% indicate extreme conviction.">
                    {(() => {
                      const conf = stock.confidence;
                      const cColor = conf > 75 ? '#10b981' : conf < 40 ? '#ef4444' : '#f59e0b';
                      const shadowAlpha = conf > 75 ? '16,185,129,0.4' : conf < 40 ? '239,68,68,0.4' : '245,158,11,0.4';
                      return (
                        <span className="mono" style={{ fontSize: '1.4rem', fontWeight: 800, color: cColor, textShadow: `0 0 8px rgba(${shadowAlpha})` }}>
                          {conf}%
                        </span>
                      );
                    })()}
                    <span style={{ fontSize: '0.55rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Conviction</span>
                  </div>

                </div>

                {/* 20-Day Range Tracker (Support / Resistance) */}
                <div style={{ width: '100%', padding: '0.4rem 1rem', background: 'rgba(0,0,0,0.15)', borderTop: '1px solid rgba(255,255,255,0.02)', display: 'flex', alignItems: 'center', gap: '0.8rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }} title="20-Day Price Range from deepest low (Support floor) to highest high (Resistance ceiling)">
                  {(() => {
                    if (!stock.support || !stock.resistance) return <span style={{ paddingLeft: '1rem' }}>AWAITING MAP DATA</span>;
                    const span = stock.resistance - stock.support;
                    if (span <= 0) return null;
                    const pPos = Math.max(0, Math.min(100, ((stock.price - stock.support) / span) * 100));

                    return (
                      <>
                        <span className="mono" style={{ color: '#f59e0b', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>S: ₹{stock.support.toFixed(1)}</span>

                        <div style={{ flex: 1, height: '4px', background: '#1e293b', borderRadius: '2px', position: 'relative' }}>
                          <div style={{ position: 'absolute', left: 0, width: `${pPos}%`, height: '100%', background: 'rgba(255,255,255,0.1)', borderRadius: '2px 0 0 2px' }}></div>
                          {/* CMP Marker */}
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
    </div>
  )
}

export default Alerts
