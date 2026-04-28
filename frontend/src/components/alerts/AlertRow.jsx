import { Link } from 'react-router-dom'
import { biasClass } from './biasClass'

// Renders a single technical-alert row. Used by both the Holdings page
// (Alerts.jsx) and the Sector Drilldown's Technical Alerts tab.
//
// Props:
//   stock            — alert object (see /api/alerts response shape)
//   onOpenConviction — () => void, called when the bullish-bias % is clicked
//   onOpenTradePlan  — () => void, called when the trade-plan tag is clicked
//   showHoldingsFields — when true (default), renders the qty / avg / P&L sub-block
function AlertRow({ stock, onOpenConviction, onOpenTradePlan, showHoldingsFields = true }) {
  const bias = biasClass(stock)
  const dotColor = bias === 'bullish' ? '#10b981' : bias === 'bearish' ? '#ef4444' : '#f59e0b'
  const dotGlyph = bias === 'bullish' ? '▲' : bias === 'bearish' ? '▼' : '■'

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
  const isBuyAction = tp.action === 'BUY SEEN' || tp.action === 'ADD'
  const isBreakoutAction = tp.action.includes('BREAKOUT')
  const isBearishAction = tp.action.includes('SELL') || tp.action === 'AVOID'
  const isTrimAction = tp.action === 'TRIM'
  const actColor = isBuyAction ? '#10b981'
    : isBearishAction ? '#ef4444'
      : isBreakoutAction ? '#fcd34d'
        : isTrimAction ? '#06b6d4'
          : '#f59e0b'
  const actGlyph = isBuyAction ? '▲ ' : isBearishAction ? '▼ ' : isTrimAction ? '✂ ' : ''

  const trendLabel = stock.regime === 'STRONG TREND' && stock.trendDirection
    ? (stock.trendDirection === 'BULL' ? 'STRONG TREND ▲' : 'STRONG TREND ▼')
    : stock.regime

  return (
    <div className="quant-row" style={{ display: 'flex', flexDirection: 'column' }}>
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
          <div className="mono" style={{ fontSize: '0.85rem', color: '#cbd5e1', marginTop: '0.2rem', marginLeft: '1.2rem', display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
            <span>{stock.price?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            {stock.dayChangePct !== null && stock.dayChangePct !== undefined && (
              <span
                title={`Today vs previous close${stock.prevClose ? ` (₹${stock.prevClose})` : ''}`}
                style={{
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  letterSpacing: '0.3px',
                  color: stock.dayChangePct > 0 ? '#10b981' : stock.dayChangePct < 0 ? '#ef4444' : '#94a3b8'
                }}
              >
                DAY {stock.dayChangePct > 0 ? '+' : ''}{stock.dayChangePct.toFixed(2)}%
              </span>
            )}
          </div>
          {showHoldingsFields && stock.quantity > 0 && (
            <div
              className="mono"
              style={{ fontSize: '0.6rem', color: '#94a3b8', marginTop: '0.2rem', marginLeft: '1.2rem', letterSpacing: '0.3px', display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}
              title={`Today's rupee impact ${stock.dayChangeRupee >= 0 ? '+' : '−'}₹${Math.abs(stock.dayChangeRupee || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}; lifetime ₹${(stock.pnl || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
            >
              <span>Qty {stock.quantity} @ ₹{stock.avgPrice?.toFixed(1)}</span>
              {stock.pnlPct !== null && stock.pnlPct !== undefined && (
                <span style={{
                  fontWeight: 700,
                  color: stock.pnlPct > 0 ? '#10b981' : stock.pnlPct < 0 ? '#ef4444' : '#94a3b8'
                }}>
                  {stock.pnlPct > 0 ? '+' : ''}{stock.pnlPct.toFixed(2)}%
                </span>
              )}
            </div>
          )}
        </div>

        {/* Core Technicals */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="dotted-underline" style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }} title="Price distance from the 20-day volume-weighted average. Positive = stretched above average (mean-reversion risk). This is NOT today's price change — see DAY % next to the price.">vs 20D AVG</span>
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
          {stock.volSurge !== undefined && stock.volSurge > 0 && (() => {
            const side = stock.volumeConfirmedSide
            const volColor = side === 'up' ? '#10b981'
              : side === 'down' ? '#ef4444'
                : '#94a3b8'
            const volGlyph = side === 'up' ? '✓'
              : side === 'down' ? '✗'
                : ''
            const volTitle = side === 'up'
              ? 'Accumulation confirmed — today up on ≥1.5× 20-day average volume'
              : side === 'down'
                ? 'Distribution confirmed — today down on ≥1.5× 20-day average volume (heavy selling)'
                : 'Volume below 1.5× 20-day average'
            return (
              <div className="mono" style={{ fontSize: '0.55rem', color: volColor, marginTop: '0.2rem', letterSpacing: '0.5px' }} title={volTitle}>
                VOL {stock.volSurge.toFixed(1)}× {volGlyph}
              </div>
            )
          })()}
        </div>

        {/* Trade Plan */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.2rem' }}>
          <span
            title={`${tp.reason}\n\nClick for full breakdown.`}
            onClick={onOpenTradePlan}
            style={{
              fontSize: '0.65rem', fontWeight: 800, padding: '0.15rem 0.5rem',
              border: `1px solid ${actColor}`, color: actColor, borderRadius: '4px',
              textShadow: `0 0 4px rgba(${actColor === '#10b981' ? '16,185,129' : actColor === '#ef4444' ? '239,68,68' : '245,158,11'}, 0.2)`,
              cursor: 'pointer', whiteSpace: 'nowrap',
              transition: 'transform 0.12s, filter 0.12s'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.06)'; e.currentTarget.style.filter = 'brightness(1.15)' }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.filter = 'brightness(1)' }}
          >
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
          onClick={onOpenConviction}
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
          <span
            style={{ fontSize: '0.55rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}
            title="Bullish bias: 0 = strongly bearish, 50 = balanced, 100 = strongly bullish. Click for breakdown."
          >
            Bullish Bias ⓘ
          </span>
        </div>
      </div>

      {/* 20-Day Range Tracker */}
      <div style={{ width: '100%', padding: '0.4rem 1.25rem', background: 'rgba(0,0,0,0.15)', borderTop: '1px solid rgba(255,255,255,0.02)', display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.65rem', color: 'var(--text-secondary)', boxSizing: 'border-box' }} title="20-day Donchian price range (prior 20 days, excluding today)">
        {(() => {
          if (!stock.support || !stock.resistance) return <span style={{ paddingLeft: '1rem' }}>AWAITING MAP DATA</span>
          const span = stock.resistance - stock.support
          if (span <= 0) return null
          const pPos = Math.max(0, Math.min(100, ((stock.price - stock.support) / span) * 100))
          const distToSupport    = ((stock.support    - stock.price) / stock.price) * 100
          const distToResistance = ((stock.resistance - stock.price) / stock.price) * 100

          return (
            <>
              <span
                className="mono"
                style={{ color: '#f59e0b', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: '0.35rem' }}
                title={`${distToSupport.toFixed(2)}% below current price — support floor`}
              >
                S: ₹{stock.support.toFixed(1)}
                <span style={{ color: '#94a3b8', fontWeight: 500, fontSize: '0.6rem' }}>
                  ({distToSupport.toFixed(2)}%)
                </span>
              </span>
              <div style={{ flex: 1, height: '4px', background: '#1e293b', borderRadius: '2px', position: 'relative' }}>
                <div style={{ position: 'absolute', left: 0, width: `${pPos}%`, height: '100%', background: 'rgba(255,255,255,0.1)', borderRadius: '2px 0 0 2px' }}></div>
                <div style={{ position: 'absolute', left: `${pPos}%`, top: '-4px', bottom: '-4px', width: '3px', background: '#f8fafc', borderRadius: '1px', transform: 'translateX(-50%)', boxShadow: '0 0 4px rgba(255,255,255,0.5)', zIndex: 5 }}></div>
              </div>
              <span
                className="mono"
                style={{ color: '#ef4444', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: '0.35rem' }}
                title={`${distToResistance.toFixed(2)}% above current price — resistance ceiling`}
              >
                R: ₹{stock.resistance.toFixed(1)}
                <span style={{ color: '#94a3b8', fontWeight: 500, fontSize: '0.6rem' }}>
                  (+{distToResistance.toFixed(2)}%)
                </span>
              </span>
            </>
          )
        })()}
      </div>
    </div>
  )
}

export default AlertRow
