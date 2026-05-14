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
  // New strategy verdicts take precedence in the colour map.
  const isStrongBuy = tp.action === 'STRONG BUY'
  const isTrendingWait = tp.action === 'TRENDING (WAIT)'
  const isBearishExit = tp.action === 'BEARISH / EXIT'
  const isWeakening = tp.action === 'WEAKENING'
  const isBuyAction = tp.action === 'BUY SEEN' || tp.action === 'ADD'
  const isBreakoutAction = tp.action.includes('BREAKOUT')
  const isBearishAction = isBearishExit || tp.action.includes('SELL') || tp.action === 'AVOID'
  const isTrimAction = tp.action === 'TRIM'
  const actColor = isStrongBuy ? '#14F195'           // neon teal
    : isTrendingWait ? '#FBBF24'                     // amber
    : isBearishExit ? '#FB7185'                      // muted coral
    : isWeakening ? '#FCD34D'                        // soft yellow — caution, not exit
    : isBuyAction ? '#10b981'
    : isBearishAction ? '#ef4444'
    : isBreakoutAction ? '#fcd34d'
    : isTrimAction ? '#06b6d4'
    : '#f59e0b'
  // Pill background: subtle tint of action colour for strategy verdicts so they pop.
  const actBg = isStrongBuy ? 'rgba(20,241,149,0.12)'
    : isTrendingWait ? 'rgba(251,191,36,0.12)'
    : isBearishExit ? 'rgba(251,113,133,0.12)'
    : isWeakening ? 'rgba(252,211,77,0.10)'
    : 'transparent'
  const actGlyph = isStrongBuy ? '🟢 '
    : isTrendingWait ? '🟡 '
    : isBearishExit ? '🔴 '
    : isWeakening ? '⚠ '
    : isBuyAction ? '▲ '
    : isBearishAction ? '▼ '
    : isTrimAction ? '✂ '
    : ''

  const trendLabel = stock.regime === 'STRONG TREND' && stock.trendDirection
    ? (stock.trendDirection === 'BULL' ? 'STRONG TREND ▲' : 'STRONG TREND ▼')
    : stock.regime

  // ─── Tactical (short-term) signal — derived from intraday-flavoured fields.
  // Strategic verdict lives in tp.action; this is the day-trader companion.
  const tactical = (() => {
    let score = 0
    if (stock.dayChangePct > 0.5) score += 1
    else if (stock.dayChangePct < -0.5) score -= 1
    if (dev > 0.5) score += 1
    else if (dev < -0.5) score -= 1
    if (agg > 0.2) score += 1
    else if (agg < -0.2) score -= 1
    if (stock.rsi != null) {
      if (stock.rsi > 75) score -= 0.5
      else if (stock.rsi < 25) score += 0.5
    }
    if (score >= 1.5)  return { label: 'INTRADAY LONG',  color: '#10b981', glyph: '▲' }
    if (score >= 0.5)  return { label: 'TILT UP',         color: '#34d399', glyph: '↗' }
    if (score <= -1.5) return { label: 'INTRADAY SHORT',  color: '#ef4444', glyph: '▼' }
    if (score <= -0.5) return { label: 'TILT DOWN',       color: '#f87171', glyph: '↘' }
    return                  { label: 'NEUTRAL',           color: '#94a3b8', glyph: '■' }
  })()

  // ─── Compact "Triggered by …" chip — keyword-classify tp.reason.
  const reasonChip = (() => {
    const r = (tp.reason || '').toLowerCase()
    if (r.includes('supertrend flipped red but smart signal')) return 'ST red, Smart still holds'
    if (r.includes('supertrend') && (r.includes('flipped red') || r.includes('just flipped'))) return 'Supertrend flip'
    if (r.includes('supertrend') && r.includes('red')) return 'Supertrend bearish'
    if (r.includes('supertrend green') || r.includes('200 ema')) return 'Trend + EMA confluence'
    if (r.includes('overbought') || r.includes('stretched')) return 'RSI overheated'
    if (r.includes('false breakout') || r.includes('bull trap')) return 'False breakout risk'
    if (r.includes('breakout') && r.includes('volume')) return 'Volume breakout'
    if (r.includes('breakout')) return 'Range breakout'
    if (r.includes('wild swings') || r.includes('erratic')) return 'Wild swings'
    if (r.includes('strict technical ceiling')) return 'Range compression'
    if (r.includes('reward/risk is only')) return 'R:R too thin'
    if (r.includes('book') && r.includes('partial')) return 'Book partials'
    if (r.includes('no asymmetric edge')) return 'No edge'
    return null
  })()

  // ─── SMART SIGNAL — backend-computed (computeStockAlert), with client-side
  // fallback so the UI stays robust if a payload doesn't carry the field yet.
  //   score = 0.4·Supertrend + 0.3·RSI-slope + 0.3·Volume-surge
  //   Soft penalty: −0.3 if filter (Supertrend GREEN ∧ 40 ≤ RSI ≤ 60) fails.
  const smart = (() => {
    const colorFor = (score) =>
      score >= 0.80 ? '#10b981'
      : score >= 0.65 ? '#f59e0b'
      : score >= 0.45 ? '#94a3b8'
      : '#ef4444'
    const glyphFor = (score) =>
      score >= 0.80 ? '⚡'
      : score >= 0.65 ? '⌛'
      : score >= 0.45 ? '◯'
      : '⛔'

    // Backend payload path — preferred.
    if (stock.smartSignal && typeof stock.smartSignal.score === 'number') {
      const s = stock.smartSignal
      return {
        score: s.score, label: s.label, filterPass: s.filterPass,
        supertrendState: s.supertrendState, rsiSlope: s.rsiSlope, volScore: s.volScore,
        color: colorFor(s.score), glyph: glyphFor(s.score)
      }
    }

    // Fallback — compute from raw fields (older backend / unit-testable path).
    const st = stock.supertrend
    const rsi = stock.rsi
    const rsiHist = stock.rsiHistory || []
    const volSurge = stock.volSurge != null ? stock.volSurge : 1.0
    let supertrendState = 0
    if (st?.signal === 'BULL') supertrendState = st.flippedToBull ? 1.0 : 0.9
    let rsiSlope = 0.5
    if (rsiHist.length >= 5) {
      const delta = rsiHist[rsiHist.length - 1] - rsiHist[rsiHist.length - 5]
      rsiSlope = Math.max(0, Math.min(1, (delta + 15) / 30))
    }
    const volScore = Math.max(0, Math.min(1, (volSurge - 0.8) / 2.2))
    let score = 0.4 * supertrendState + 0.3 * rsiSlope + 0.3 * volScore
    const filterPass = st?.signal === 'BULL' && rsi != null && rsi >= 40 && rsi <= 60
    if (!filterPass) score -= 0.3
    score = Math.max(0, Math.min(1, score))
    const label =
      score >= 0.80 ? 'STRONG CONVICTION'
      : score >= 0.65 ? 'WAIT FOR CONFIRMATION'
      : score >= 0.45 ? 'WEAK SETUP'
      : 'NO TRADE'
    return {
      score, label, filterPass, supertrendState, rsiSlope, volScore,
      color: colorFor(score), glyph: glyphFor(score)
    }
  })()

  // ─── R:R Gauge — segmented bar with break-even (1.0×) and target (2.0×) ticks.
  const RRGauge = ({ rr }) => {
    if (rr == null) return null
    const warn = rr < 1.0
    const fillPct = (Math.min(Math.max(rr, 0), 3) / 3) * 100
    const color = warn ? '#ef4444' : rr < 1.5 ? '#f59e0b' : rr < 2 ? '#06b6d4' : '#10b981'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', width: '100%', maxWidth: '150px' }}
           title={`Reward-to-risk: ${rr.toFixed(2)}× · ticks at 1.0× (break-even) and 2.0× (target).${warn ? ' Below 1.0× — risk exceeds reward.' : ''}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '0.5rem', letterSpacing: '0.6px', color: 'var(--text-secondary)' }}>
          <span style={{ textTransform: 'uppercase' }}>R:R</span>
          <span className="mono" style={{ color, fontWeight: 800, fontSize: '0.62rem' }}>
            {warn && <span style={{ marginRight: '2px' }}>⚠</span>}{rr.toFixed(2)}×
          </span>
        </div>
        <div style={{ position: 'relative', height: '4px', background: '#0b1220', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${fillPct}%`, background: color, boxShadow: warn ? '0 0 6px rgba(239,68,68,0.55)' : 'none', transition: 'width 0.2s' }} />
          <div style={{ position: 'absolute', left: '33.33%', top: '-2px', bottom: '-2px', width: '1px', background: warn ? '#fbbf24' : '#64748b' }} title="1.0× break-even" />
          <div style={{ position: 'absolute', left: '66.66%', top: '-2px', bottom: '-2px', width: '1px', background: '#64748b' }} title="2.0× target" />
        </div>
      </div>
    )
  }

  // ─── Smart-Signal-driven entry block — disables Buy-flavoured actions
  // when the Smart Signal verdict is below the WEAK band (score < 0.45).
  const isBuyFlavoured = isStrongBuy || isBuyAction || isBreakoutAction || isTrendingWait
  const smartBlocksEntry = isBuyFlavoured && smart.score < 0.45

  return (
    <div className="quant-row" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* 3-column grid — progressive disclosure, Smart Signal as hero */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(280px, 1.3fr) minmax(420px, 2fr)', gap: '1.25rem', padding: '0.8rem 1.25rem', alignItems: 'stretch' }}>

        {/* ═══ Col 1: IDENTITY ═══════════════════════════════════════ */}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '0.3rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: dotColor, fontSize: '0.7rem', fontWeight: 800, width: '10px', textAlign: 'center' }}>{dotGlyph}</span>
            <Link to={`/instrument/${stock.token}?symbol=${stock.symbol}`} style={{ fontSize: '1rem', fontWeight: 800, color: '#f8fafc', textDecoration: 'none', letterSpacing: '0.5px' }}>
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
          <div className="mono" style={{ fontSize: '0.85rem', color: '#cbd5e1', marginLeft: '1.2rem', display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
            <span>{stock.price?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            {stock.dayChangePct != null && (
              <span style={{
                fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.3px',
                color: stock.dayChangePct > 0 ? '#10b981' : stock.dayChangePct < 0 ? '#ef4444' : '#94a3b8'
              }}>
                DAY {stock.dayChangePct > 0 ? '+' : ''}{stock.dayChangePct.toFixed(2)}%
              </span>
            )}
          </div>
          {showHoldingsFields && stock.quantity > 0 && (
            <div
              className="mono"
              style={{ fontSize: '0.6rem', color: '#94a3b8', marginLeft: '1.2rem', letterSpacing: '0.3px', display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}
              title={`Today's rupee impact ${stock.dayChangeRupee >= 0 ? '+' : '−'}₹${Math.abs(stock.dayChangeRupee || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}; lifetime ₹${(stock.pnl || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
            >
              <span>Qty {stock.quantity} @ ₹{stock.avgPrice?.toFixed(1)}</span>
              {stock.pnlPct != null && (
                <span style={{ fontWeight: 700, color: stock.pnlPct > 0 ? '#10b981' : stock.pnlPct < 0 ? '#ef4444' : '#94a3b8' }}>
                  {stock.pnlPct > 0 ? '+' : ''}{stock.pnlPct.toFixed(2)}%
                </span>
              )}
            </div>
          )}
          {/* Bullish Bias — demoted to small secondary metric. */}
          <div
            className="conviction-click"
            onClick={onOpenConviction}
            title="Click for bullish-bias breakdown"
            style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', marginLeft: '1.2rem', marginTop: '0.15rem' }}
          >
            <span style={{ fontSize: '0.5rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Bullish Bias</span>
            {(() => {
              const conf = stock.confidence
              const cColor = conf > 75 ? '#10b981' : conf < 40 ? '#ef4444' : '#f59e0b'
              return <span className="mono" style={{ fontSize: '0.85rem', fontWeight: 800, color: cColor }}>{conf}%</span>
            })()}
          </div>
        </div>

        {/* ═══ Col 2: SMART SIGNAL — HERO ════════════════════════════ */}
        <div
          title={
            `Action Score = 0.4·Supertrend + 0.3·RSI-slope + 0.3·Volume\n` +
            `  Supertrend State : ${smart.supertrendState.toFixed(2)}\n` +
            `  RSI Slope (5-bar): ${smart.rsiSlope.toFixed(2)}\n` +
            `  Volume Surge     : ${smart.volScore.toFixed(2)}\n` +
            (smart.filterPass
              ? `Filter PASSED  (Supertrend GREEN ∧ 40 ≤ RSI ≤ 60)`
              : `Filter FAILED — −0.30 penalty (need Supertrend GREEN ∧ 40 ≤ RSI ≤ 60)`)
          }
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: '0.35rem', padding: '0.6rem',
            borderRadius: '6px',
            background: smart.score >= 0.8 ? `${smart.color}0d` : 'rgba(255,255,255,0.015)',
            border: `1px solid ${smart.score >= 0.8 ? `${smart.color}33` : 'rgba(255,255,255,0.04)'}`,
            boxShadow: smart.score >= 0.8 ? `inset 0 0 12px ${smart.color}1f` : 'none'
          }}
        >
          <span style={{ fontSize: '0.55rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1.5px', fontWeight: 700 }}>
            ✨ Smart Signal
          </span>
          <span style={{
            fontSize: '0.7rem', fontWeight: 800, padding: '0.2rem 0.7rem',
            border: `1px solid ${smart.color}`, color: smart.color, borderRadius: '4px',
            background: `${smart.color}1a`,
            letterSpacing: '0.6px', whiteSpace: 'nowrap',
            boxShadow: smart.score >= 0.8 ? `0 0 10px ${smart.color}66` : 'none'
          }}>
            {smart.glyph} {smart.label}
          </span>
          {/* Hero score number */}
          <div className="mono" style={{
            fontSize: '2.4rem', fontWeight: 800, color: smart.color, lineHeight: 1,
            textShadow: smart.score >= 0.8 ? `0 0 14px ${smart.color}55` : 'none',
            letterSpacing: '-1px'
          }}>
            {smart.score.toFixed(2)}
          </div>
          {/* Gauge */}
          <div style={{ width: '100%', maxWidth: '200px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <div style={{ position: 'relative', height: '5px', background: '#0b1220', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '1px' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${smart.score * 100}%`, background: smart.color, transition: 'width 0.2s' }} />
              <div style={{ position: 'absolute', left: '45%', top: '-2px', bottom: '-2px', width: '1px', background: '#475569' }} />
              <div style={{ position: 'absolute', left: '65%', top: '-2px', bottom: '-2px', width: '1px', background: '#64748b' }} />
              <div style={{ position: 'absolute', left: '80%', top: '-2px', bottom: '-2px', width: '1px', background: '#10b981' }} />
            </div>
            <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.48rem', color: '#475569', letterSpacing: '0.4px' }}>
              <span>0.00</span><span>0.45</span><span>0.65</span><span>0.80</span><span>1.00</span>
            </div>
          </div>
          <span style={{ fontSize: '0.5rem', color: '#64748b', letterSpacing: '0.4px', fontStyle: 'italic' }}>
            {smart.filterPass ? '✓ Filter passed' : '⚠ Filter blocked'} · hover for math
          </span>
        </div>

        {/* ═══ Col 3: ANALYSIS (Strategic + Tactical merged) ═════════ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', justifyContent: 'center' }}>
          <span style={{ fontSize: '0.55rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1.5px', fontWeight: 700 }}>
            ◆ Analysis
          </span>

          {/* Compact technicals strip */}
          <div style={{ display: 'flex', gap: '1.2rem', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.65rem' }}>
            {/* RSI + sparkline + ST badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span style={{ fontSize: '0.55rem', color: '#64748b', letterSpacing: '0.4px' }}>RSI</span>
              <span className="mono" style={{ fontWeight: 700, color: stock.rsi > 70 ? '#ef4444' : stock.rsi < 30 ? '#10b981' : '#cbd5e1' }}>
                {stock.rsi}
              </span>
              {rsiHistory.length > 0 && (
                <svg width="36" height="16" style={{ overflow: 'visible' }}>
                  <polyline points={sparkPoints} fill="none" stroke="#475569" strokeWidth="1.3" />
                  <circle cx="36" cy={20 - ((lastRsi / 100) * 20)} r="1.8" fill={lastRsi > 70 ? '#ef4444' : lastRsi < 30 ? '#10b981' : '#cbd5e1'} />
                </svg>
              )}
              {stock.supertrend && (() => {
                const isBull = stock.supertrend.signal === 'BULL'
                const color = isBull ? '#14F195' : '#FB7185'
                return (
                  <span
                    title={`SuperTrend(10,3): ${isBull ? 'Uptrend' : 'Downtrend'} · line ₹${stock.supertrend.line?.toFixed?.(2) ?? '—'}${stock.supertrend.flippedToBull ? ' · just flipped GREEN' : stock.supertrend.flippedToBear ? ' · just flipped RED' : ''}`}
                    style={{
                      padding: '0.08rem 0.35rem', borderRadius: '3px',
                      fontSize: '0.55rem', fontWeight: 800, letterSpacing: '0.5px', color,
                      background: isBull ? 'rgba(20,241,149,0.10)' : 'rgba(251,113,133,0.10)',
                      border: `1px solid ${isBull ? 'rgba(20,241,149,0.45)' : 'rgba(251,113,133,0.45)'}`,
                      boxShadow: isBull ? '0 0 6px rgba(20,241,149,0.30)' : 'none'
                    }}
                  >
                    ST{stock.supertrend.flippedToBull ? '⚡' : ''}
                  </span>
                )
              })()}
            </div>
            {/* VWAP deviation */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }} title="Price distance from the 20-day volume-weighted average.">
              <span style={{ fontSize: '0.55rem', color: '#64748b', letterSpacing: '0.4px' }}>vs 20D VWAP</span>
              <span className="mono" style={{ fontWeight: 700, color: devColor }}>
                {dev > 0 ? '+' : ''}{dev.toFixed(2)}%
              </span>
            </div>
            {/* Money flow inline gauge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} title="Chaikin-style money flow index: +1 = heavy accumulation, -1 = heavy distribution.">
              <span style={{ fontSize: '0.55rem', color: '#64748b', letterSpacing: '0.4px' }}>FLOW</span>
              <div style={{ width: '70px', height: '4px', background: '#1e293b', position: 'relative' }}>
                <div style={{ position: 'absolute', left: '50%', top: '-1.5px', bottom: '-1.5px', width: '1px', background: '#64748b' }} />
                {agg < 0 && <div style={{ position: 'absolute', right: '50%', top: 0, height: '100%', width: `${rectWidth}%`, background: '#FF3D00' }} />}
                {agg > 0 && <div style={{ position: 'absolute', left: '50%',  top: 0, height: '100%', width: `${rectWidth}%`, background: '#00E5FF' }} />}
              </div>
              <span className="mono" style={{ fontSize: '0.55rem', color: agg > 0 ? '#00E5FF' : agg < 0 ? '#FF3D00' : '#94a3b8', fontWeight: 700 }}>
                {agg > 0 ? '+' : ''}{agg.toFixed(2)}
              </span>
              {stock.volSurge != null && stock.volSurge > 0 && (() => {
                const side = stock.volumeConfirmedSide
                const volColor = side === 'up' ? '#10b981' : side === 'down' ? '#ef4444' : '#94a3b8'
                const volGlyph = side === 'up' ? '✓' : side === 'down' ? '✗' : ''
                return (
                  <span className="mono" style={{ fontSize: '0.55rem', color: volColor, letterSpacing: '0.3px' }}>
                    VOL {stock.volSurge.toFixed(1)}× {volGlyph}
                  </span>
                )
              })()}
            </div>
          </div>

          {/* Verdict + targets — disabled-styled when Smart Signal blocks entry */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap',
            opacity: smartBlocksEntry ? 0.45 : 1,
            filter: smartBlocksEntry ? 'grayscale(80%)' : 'none',
            transition: 'opacity 0.15s, filter 0.15s'
          }}>
            <span
              title={smartBlocksEntry
                ? `Smart Signal (${smart.score.toFixed(2)}) blocks this entry. ${tp.reason}`
                : `${tp.reason}\n\nClick for full breakdown.`}
              onClick={smartBlocksEntry ? undefined : onOpenTradePlan}
              style={{
                fontSize: '0.68rem', fontWeight: 800, padding: '0.2rem 0.6rem',
                border: `1px solid ${actColor}`, color: actColor, borderRadius: '4px',
                background: actBg,
                textShadow: smartBlocksEntry ? 'none' : `0 0 4px rgba(${actColor === '#10b981' ? '16,185,129' : actColor === '#ef4444' ? '239,68,68' : actColor === '#14F195' ? '20,241,149' : actColor === '#FB7185' ? '251,113,133' : actColor === '#FBBF24' ? '251,191,36' : actColor === '#FCD34D' ? '252,211,77' : '245,158,11'}, 0.2)`,
                cursor: smartBlocksEntry ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                transition: 'transform 0.12s, filter 0.12s', pointerEvents: smartBlocksEntry ? 'none' : 'auto'
              }}
            >
              {actGlyph}{tp.action}
            </span>
            {reasonChip && (
              <span title={tp.reason} style={{ fontSize: '0.55rem', color: '#94a3b8', fontStyle: 'italic', letterSpacing: '0.3px' }}>
                Triggered by <span style={{ color: '#cbd5e1', fontStyle: 'normal', fontWeight: 600 }}>{reasonChip}</span>
              </span>
            )}
            {stock.isBreakout && (() => {
              const SHORT = { '3y': '3Y', '2y': '2Y', '1y': '1Y', '6m': '6M', '3m': '3M', '1m': '1M' }
              const winKey = stock.activeBreakoutWindow?.key
              const winShort = SHORT[winKey] || ''
              return (
                <span style={{ fontSize: '0.55rem', fontWeight: 800, color: '#fcd34d', background: 'rgba(252,211,77,0.15)', padding: '0.1rem 0.4rem', borderRadius: '3px', letterSpacing: '0.5px' }}>
                  🚀 {winShort ? `${winShort} ` : ''}BREAKOUT
                </span>
              )
            })()}
          </div>

          {smartBlocksEntry && (
            <div style={{
              fontSize: '0.55rem', color: '#f87171', letterSpacing: '0.5px',
              border: '1px solid rgba(248,113,113,0.3)', background: 'rgba(248,113,113,0.06)',
              padding: '0.2rem 0.5rem', borderRadius: '3px', alignSelf: 'flex-start',
              fontWeight: 600
            }} title={`Smart Signal score is ${smart.score.toFixed(2)} (< 0.45). Entry actions are disabled to prevent buying into a hostile regime.`}>
              ⛔ Smart Signal blocks new entries
            </div>
          )}

          {/* TG / SL / RR — only when entry not blocked */}
          {!smartBlocksEntry && (tp.tgt || tp.sl) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <div className="mono" style={{ display: 'flex', gap: '0.7rem', fontSize: '0.6rem', color: 'var(--text-secondary)' }}>
                {tp.tgt && <span title="Target exit level">TG ₹{tp.tgt}</span>}
                {tp.sl && <span title="Suggested stop loss" style={{ color: '#ef4444' }}>SL ₹{tp.sl}</span>}
              </div>
              {tp.rrRatio != null && <RRGauge rr={tp.rrRatio} />}
            </div>
          )}

          {/* Tactical inline — single line, secondary */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.55rem', color: '#64748b', letterSpacing: '0.3px' }}>
            <span style={{ textTransform: 'uppercase', fontWeight: 700 }}>Tactical</span>
            <span style={{
              padding: '0.06rem 0.4rem', border: `1px solid ${tactical.color}`, color: tactical.color,
              borderRadius: '3px', fontWeight: 700, letterSpacing: '0.5px',
              fontSize: '0.55rem'
            }}>
              {tactical.glyph} {tactical.label}
            </span>
            {stock.dayChangePct != null && <span className="mono">DAY {stock.dayChangePct > 0 ? '+' : ''}{stock.dayChangePct.toFixed(2)}%</span>}
            <span className="mono">· VWAP {dev > 0 ? '+' : ''}{dev.toFixed(1)}%</span>
            <span>· {trendLabel}</span>
          </div>
        </div>
      </div>

      {/* Multi-Window Breakout Ladder */}
      <div style={{ width: '100%', padding: '0.35rem 1.25rem 0.45rem', background: 'rgba(0,0,0,0.15)', borderTop: '1px solid rgba(255,255,255,0.02)', boxSizing: 'border-box' }}>
        {(() => {
          const windows = stock.windowLevels
          const SHORT = { '3y': '3Y', '2y': '2Y', '1y': '1Y', '6m': '6M', '3m': '3M', '1m': '1M' }

          // Fallback: no windowLevels — show old 20-day bar
          if (!windows || windows.length === 0) {
            if (!stock.support || !stock.resistance) return <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', paddingLeft: '1rem' }}>AWAITING MAP DATA</span>
            const span = stock.resistance - stock.support
            if (span <= 0) return null
            const pPos = Math.max(0, Math.min(100, ((stock.price - stock.support) / span) * 100))
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                <span className="mono" style={{ color: '#f59e0b', fontWeight: 600, whiteSpace: 'nowrap' }}>S: ₹{stock.support.toFixed(1)}</span>
                <div style={{ flex: 1, height: '4px', background: '#1e293b', borderRadius: '2px', position: 'relative' }}>
                  <div style={{ position: 'absolute', left: 0, width: `${pPos}%`, height: '100%', background: 'rgba(255,255,255,0.1)', borderRadius: '2px 0 0 2px' }} />
                  <div style={{ position: 'absolute', left: `${pPos}%`, top: '-4px', bottom: '-4px', width: '3px', background: '#f8fafc', borderRadius: '1px', transform: 'translateX(-50%)', boxShadow: '0 0 4px rgba(255,255,255,0.5)', zIndex: 5 }} />
                </div>
                <span className="mono" style={{ color: '#ef4444', fontWeight: 600, whiteSpace: 'nowrap' }}>R: ₹{stock.resistance.toFixed(1)}</span>
              </div>
            )
          }

          // Find overall bounds: 3Y high (windows[0]) down to lowest low
          const overallHigh = windows[0]?.high
          const rawLow = Math.min(...windows.map(w => w.low).filter(v => v != null && v > 0))
          const overallLow = isFinite(rawLow) ? rawLow : stock.support
          if (!overallHigh || !overallLow || overallHigh <= overallLow) return null

          const span = overallHigh - overallLow
          const toPos = (val) => Math.max(0, Math.min(100, ((val - overallLow) / span) * 100))
          const pricePos = toPos(stock.price)

          const broken = windows.filter(w => w.isBreakingOut).map(w => SHORT[w.key]).join(' ')

          // Longest broken window (windows are ordered 3y → 1m).
          const longestBroken = windows.find(w => w.isBreakingOut) ?? null
          // Shortest unbroken window above price = nearest overhead resistance.
          const nextOverhead = [...windows].reverse().find(w => !w.isBreakingOut && w.high) ?? null

          // Group ticks into position-clusters so labels never overlap.
          // Within a cluster the LONGEST tenor wins the label slot — by definition
          // the longest cleared/approached implies the shorter ones too.
          const TENOR_ORDER = ['3y', '2y', '1y', '6m', '3m', '1m'] // longest → shortest
          const CLUSTER_GAP = 7 // % of bar width — labels closer than this collapse
          const sortedTicks = windows
            .filter(w => w.high != null)
            .map(w => ({ ...w, _pos: toPos(w.high) }))
            .sort((a, b) => a._pos - b._pos)
          const clusters = []
          for (const t of sortedTicks) {
            const last = clusters[clusters.length - 1]
            if (last && t._pos - last.maxPos <= CLUSTER_GAP) {
              last.windows.push(t)
              last.maxPos = t._pos
            } else {
              clusters.push({ windows: [t], minPos: t._pos, maxPos: t._pos })
            }
          }
          const longestInCluster = (c) => c.windows
            .slice()
            .sort((a, b) => TENOR_ORDER.indexOf(a.key) - TENOR_ORDER.indexOf(b.key))[0]

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              {/* Bar row */}
              <div style={{ position: 'relative', height: '16px' }}>
                {/* Track */}
                <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: '5px', background: '#1e293b', borderRadius: '3px', transform: 'translateY(-50%)' }} />
                {/* Filled region behind price */}
                <div style={{ position: 'absolute', top: '50%', left: 0, width: `${pricePos}%`, height: '5px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px 0 0 3px', transform: 'translateY(-50%)' }} />
                {/* Window high ticks */}
                {windows.map(w => {
                  if (!w.high) return null
                  const pos = toPos(w.high)
                  const isApproaching = !w.isBreakingOut && w.distancePct !== null && w.distancePct > 0 && w.distancePct <= 3
                  const tickColor = w.isBreakingOut ? '#10b981' : isApproaching ? '#fcd34d' : '#64748b'
                  const glow = w.isBreakingOut ? '0 0 4px rgba(16,185,129,0.6)' : isApproaching ? '0 0 4px rgba(252,211,77,0.5)' : 'none'
                  return (
                    <div
                      key={w.key}
                      title={`${SHORT[w.key]} high: ₹${w.high.toFixed(1)} — ${w.isBreakingOut ? 'broken ✓' : w.distancePct !== null ? `+${w.distancePct.toFixed(1)}% away` : ''}`}
                      style={{ position: 'absolute', left: `${pos}%`, top: 0, bottom: 0, width: '3px', background: tickColor, transform: 'translateX(-50%)', zIndex: 3, boxShadow: glow, borderRadius: '1px' }}
                    />
                  )
                })}
                {/* Price marker */}
                <div style={{ position: 'absolute', left: `${pricePos}%`, top: '-2px', bottom: '-2px', width: '3px', background: '#f8fafc', transform: 'translateX(-50%)', boxShadow: '0 0 6px rgba(255,255,255,0.7)', zIndex: 5, borderRadius: '1px' }} />
              </div>

              {/* Cluster labels — one label per cluster at its centroid */}
              <div style={{ position: 'relative', height: '12px' }}>
                {clusters.map((c, i) => {
                  const head = longestInCluster(c)
                  const centroid = (c.minPos + c.maxPos) / 2
                  const isApproaching = !head.isBreakingOut && head.distancePct !== null && head.distancePct > 0 && head.distancePct <= 3
                  const labelColor = head.isBreakingOut ? '#10b981' : isApproaching ? '#fcd34d' : '#94a3b8'
                  // If a cluster covers >1 tenor, show the longest with a "+" suffix to hint at more
                  const suffix = c.windows.length > 1 ? '·' : ''
                  return (
                    <span
                      key={`cluster-${i}-${head.key}`}
                      title={c.windows.map(w => `${SHORT[w.key]} ₹${w.high.toFixed(1)}${w.isBreakingOut ? ' ✓' : w.distancePct !== null ? ` (+${w.distancePct.toFixed(1)}%)` : ''}`).join('  ·  ')}
                      style={{
                        position: 'absolute',
                        left: `${centroid}%`,
                        top: 0,
                        transform: 'translateX(-50%)',
                        fontSize: '0.62rem',
                        color: labelColor,
                        fontWeight: head.isBreakingOut ? 800 : isApproaching ? 700 : 600,
                        whiteSpace: 'nowrap',
                        lineHeight: 1,
                        textShadow: '0 0 3px rgba(0,0,0,0.9)',
                        letterSpacing: '0.3px'
                      }}
                    >
                      {SHORT[head.key]}{suffix}
                    </span>
                  )
                })}
              </div>

              {/* Floor · status · ceiling */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '0.62rem', gap: '0.6rem' }}>
                <span className="mono" style={{ color: '#94a3b8' }} title="3-year low (range floor)">₹{overallLow.toFixed(0)}</span>

                <span style={{ display: 'flex', gap: '0.7rem', alignItems: 'baseline' }}>
                  {longestBroken && (
                    <span className="mono" style={{ color: '#10b981', fontWeight: 700, letterSpacing: '0.3px' }} title={`Price has cleared the ${longestBroken.label} high at ₹${longestBroken.high.toFixed(1)}. All shorter windows are also broken.`}>
                      ✓ {SHORT[longestBroken.key]} cleared
                    </span>
                  )}
                  {nextOverhead && (
                    <span className="mono" style={{ color: '#fcd34d', fontWeight: 600, letterSpacing: '0.3px' }} title={`Next overhead: ${nextOverhead.label} high at ₹${nextOverhead.high.toFixed(1)}, ${nextOverhead.distancePct.toFixed(1)}% away`}>
                      ↑ {SHORT[nextOverhead.key]} +{nextOverhead.distancePct.toFixed(1)}%
                    </span>
                  )}
                  {!longestBroken && !nextOverhead && (
                    <span style={{ color: '#94a3b8' }}>—</span>
                  )}
                </span>

                <span className="mono" title={`3-year high — ₹${overallHigh.toFixed(1)}`} style={{ color: windows[0].isBreakingOut ? '#10b981' : '#cbd5e1', fontWeight: 600 }}>
                  3Y ₹{overallHigh.toFixed(0)}
                </span>
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

export default AlertRow
