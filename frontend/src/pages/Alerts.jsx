import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
function Alerts() {
  const [alerts, setAlerts] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all') // 'all' | 'bullish' | 'bearish' | 'warning'
  const [expandedStocks, setExpandedStocks] = useState({})
  const [searchQuery, setSearchQuery] = useState('')

  const [cacheProgress, setCacheProgress] = useState(null)

  useEffect(() => {
    let pollInterval;
    
    const checkAndFetchAlerts = async () => {
      try {
        setError(null)
        // First check if cache is ready
        const statusRes = await fetch('http://localhost:3001/api/cache-status')
        if (!statusRes.ok) throw new Error('Failed to check cache status')
        const status = await statusRes.json()

        if (!status.ready) {
          setCacheProgress(`Warming up analysis engine... (${status.instrumentsCached}/${status.totalHoldings || '?'})`)
          // Trigger alerts endpoint so it safely kicks off the warmup if it hasn't started
          fetch('http://localhost:3001/api/alerts').catch(() => {})
          return // Still warming up, effect will poll again
        }

        // Cache is ready, fetch actual alerts
        const res = await fetch('http://localhost:3001/api/alerts')
        if (!res.ok) throw new Error('Failed to fetch alerts')
        const data = await res.json()
        setAlerts(data)
        setCacheProgress(null)
        setLoading(false)
        
        // Auto-expand the first stock
        if (data.length > 0) {
          setExpandedStocks({ [data[0].symbol]: true })
        }
        
        // Stop polling
        clearInterval(pollInterval)
        
      } catch (err) {
        setError(err.message)
        setLoading(false)
        clearInterval(pollInterval)
      }
    }

    // Run immediately
    setLoading(true)
    checkAndFetchAlerts()
    
    // Setup polling every 2 seconds until cache is ready
    pollInterval = setInterval(checkAndFetchAlerts, 2000)

    return () => clearInterval(pollInterval)
  }, [])

  if (loading || cacheProgress) return (
    <div className="dashboard-layout" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '50vh', gap: '1rem' }}>
      <div className="loader"></div>
      {cacheProgress && <p style={{ color: 'var(--accent)', fontWeight: 'bold' }}>{cacheProgress}</p>}
    </div>
  )
  
  if (error) return (
    <div className="dashboard-layout">
      <div className="glass-panel">
        <p className="negative">{error}</p>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
          Please ensure the backend is running and you are logged into Kite.
        </p>
      </div>
    </div>
  )

  const severityIcon = (severity) => {
    switch (severity) {
      case 'bullish': return '🟢'
      case 'bearish': return '🔴'
      case 'warning': return '🟡'
      case 'info': return '🔵'
      default: return '⚪'
    }
  }

  const severityBorder = (severity) => {
    switch (severity) {
      case 'bullish': return 'var(--success)'
      case 'bearish': return 'var(--danger)'
      case 'warning': return '#f39c12'
      case 'info': return 'var(--accent)'
      default: return 'var(--border)'
    }
  }

  const severityBg = (severity) => {
    switch (severity) {
      case 'bullish': return 'rgba(16, 185, 129, 0.08)'
      case 'bearish': return 'rgba(239, 68, 68, 0.08)'
      case 'warning': return 'rgba(243, 156, 18, 0.08)'
      case 'info': return 'rgba(0, 188, 212, 0.08)'
      default: return 'transparent'
    }
  }

  const typeLabel = (type) => {
    switch (type) {
      case 'rsi': return 'RSI'
      case 'sma_short': return 'Short-Term SMA'
      case 'sma_long': return 'Long-Term SMA'
      case 'cross': return 'SMA Crossover'
      default: return type
    }
  }

  // Count alerts by severity
  const allAlertsList = (alerts || []).flatMap(s => s.alerts.map(a => ({ ...a, symbol: s.symbol, price: s.price, rsi: s.rsi })))
  const bullishCount = allAlertsList.filter(a => a.severity === 'bullish').length
  const bearishCount = allAlertsList.filter(a => a.severity === 'bearish').length
  const warningCount = allAlertsList.filter(a => a.severity === 'warning').length
  const infoCount = allAlertsList.filter(a => a.severity === 'info').length

  // Filter stocks
  const filteredAlerts = (alerts || [])
    .filter(stock => stock.symbol.toLowerCase().includes(searchQuery.toLowerCase()))
    .map(stock => ({
      ...stock,
      alerts: stock.alerts.filter(a => filter === 'all' || a.severity === filter)
    }))
    .filter(stock => stock.alerts.length > 0)

  return (
    <div className="dashboard-layout">
      <header className="header" style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1>Portfolio Technical Alerts</h1>
          <p style={{ color: 'var(--text-secondary)' }}>Technical signals across your holdings based on RSI and SMA analysis</p>
        </div>
        <input 
          type="text" 
          placeholder="Search instrument..." 
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            padding: '0.6rem 1rem',
            borderRadius: '8px',
            border: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            color: 'var(--text-primary)',
            maxWidth: '300px',
            width: '100%',
            outline: 'none'
          }}
        />
      </header>

      {/* Summary Cards */}
      <section className="grid" style={{ marginBottom: '1.5rem', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <div
          className="glass-panel stat-card"
          onClick={() => setFilter('all')}
          style={{
            padding: '1.25rem',
            cursor: 'pointer',
            borderLeft: filter === 'all' ? '3px solid var(--accent)' : '3px solid transparent',
            opacity: filter === 'all' ? 1 : 0.7,
            transition: 'all 0.2s'
          }}
        >
          <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Total Technical Alerts</span>
          <span className="value" style={{ fontSize: '1.8rem', fontWeight: '700' }}>{allAlertsList.length}</span>
        </div>
        <div
          className="glass-panel stat-card"
          onClick={() => setFilter('bullish')}
          style={{
            padding: '1.25rem',
            cursor: 'pointer',
            borderLeft: filter === 'bullish' ? '3px solid var(--success)' : '3px solid transparent',
            opacity: filter === 'bullish' ? 1 : 0.7,
            transition: 'all 0.2s'
          }}
        >
          <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>🟢 Bullish</span>
          <span className="value positive" style={{ fontSize: '1.8rem', fontWeight: '700' }}>{bullishCount}</span>
        </div>
        <div
          className="glass-panel stat-card"
          onClick={() => setFilter('bearish')}
          style={{
            padding: '1.25rem',
            cursor: 'pointer',
            borderLeft: filter === 'bearish' ? '3px solid var(--danger)' : '3px solid transparent',
            opacity: filter === 'bearish' ? 1 : 0.7,
            transition: 'all 0.2s'
          }}
        >
          <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>🔴 Bearish</span>
          <span className="value negative" style={{ fontSize: '1.8rem', fontWeight: '700' }}>{bearishCount}</span>
        </div>
        <div
          className="glass-panel stat-card"
          onClick={() => setFilter('warning')}
          style={{
            padding: '1.25rem',
            cursor: 'pointer',
            borderLeft: filter === 'warning' ? '3px solid #f39c12' : '3px solid transparent',
            opacity: filter === 'warning' ? 1 : 0.7,
            transition: 'all 0.2s'
          }}
        >
          <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>🟡 Warning</span>
          <span className="value" style={{ fontSize: '1.8rem', fontWeight: '700', color: '#f39c12' }}>{warningCount}</span>
        </div>
        <div
          className="glass-panel stat-card"
          onClick={() => setFilter('info')}
          style={{
            padding: '1.25rem',
            cursor: 'pointer',
            borderLeft: filter === 'info' ? '3px solid var(--accent)' : '3px solid transparent',
            opacity: filter === 'info' ? 1 : 0.7,
            transition: 'all 0.2s'
          }}
        >
          <span className="label" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>🔵 Momentum</span>
          <span className="value" style={{ fontSize: '1.8rem', fontWeight: '700', color: 'var(--accent)' }}>{infoCount}</span>
        </div>
      </section>

      {/* Alert Cards */}
      {filteredAlerts.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>
            {filter === 'all'
              ? 'No technical alerts found. Make sure the backend cache has warmed up by visiting the Dashboard first.'
              : `No ${filter} technical alerts found in your portfolio.`}
          </p>
        </div>
      ) : (
        filteredAlerts.map((stock, stockIdx) => {
          const isExpanded = expandedStocks[stock.symbol] ?? false
          const toggleExpand = () => setExpandedStocks(prev => ({ ...prev, [stock.symbol]: !prev[stock.symbol] }))

          return (
          <section key={stock.symbol} className="glass-panel" style={{ marginBottom: '1rem' }}>
            <div
              onClick={toggleExpand}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{
                  display: 'inline-block',
                  transition: 'transform 0.2s',
                  transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  fontSize: '0.9rem',
                  color: 'var(--text-secondary)'
                }}>▶</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.2rem' }}>
                    <Link 
                      to={`/instrument/${stock.token}?symbol=${stock.symbol}`} 
                      style={{ color: 'var(--accent)', textDecoration: 'none' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {stock.symbol}
                    </Link>
                  </h3>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    CMP: ₹{stock.price?.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    {stock.rsi && <> &nbsp;|&nbsp; RSI: <span style={{ color: stock.rsi <= 30 ? 'var(--success)' : stock.rsi >= 70 ? 'var(--danger)' : 'var(--text-primary)' }}>{stock.rsi}</span></>}
                    &nbsp;|&nbsp; {stock.alerts.length} alert{stock.alerts.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {stock.alerts.some(a => a.severity === 'bullish') && <span style={{ background: 'rgba(16,185,129,0.15)', color: 'var(--success)', padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 'bold' }}>BULLISH</span>}
                {stock.alerts.some(a => a.severity === 'bearish') && <span style={{ background: 'rgba(239,68,68,0.15)', color: 'var(--danger)', padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 'bold' }}>BEARISH</span>}
                {stock.alerts.some(a => a.severity === 'warning') && <span style={{ background: 'rgba(243,156,18,0.15)', color: '#f39c12', padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 'bold' }}>WATCH</span>}
              </div>
            </div>

            {isExpanded && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
                {stock.alerts.map((alert, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                      padding: '0.75rem 1rem',
                      borderRadius: '8px',
                      borderLeft: `3px solid ${severityBorder(alert.severity)}`,
                      background: severityBg(alert.severity),
                      transition: 'all 0.2s'
                    }}
                  >
                    <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{severityIcon(alert.severity)}</span>
                    <div style={{ flex: 1 }}>
                      <span style={{
                        fontSize: '0.7rem',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        color: severityBorder(alert.severity),
                        fontWeight: 'bold',
                        display: 'block',
                        marginBottom: '0.25rem'
                      }}>
                        {typeLabel(alert.type)}
                      </span>
                      <span style={{ color: 'var(--text-primary)', fontSize: '0.9rem', lineHeight: '1.4' }}>
                        {alert.message}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          )
        })
      )}
    </div>
  )
}

export default Alerts
