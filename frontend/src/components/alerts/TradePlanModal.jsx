import { useEffect } from 'react'

// Trade plan explainer modal: verdict, TG/SL cards, R:R, regime notes.
// Renders nothing when `stock` is null.
function TradePlanModal({ stock, onClose }) {
  useEffect(() => {
    if (!stock) return
    const handleEsc = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [stock, onClose])

  if (!stock) return null

  const s = stock
  const tp = s.tradePlan || {}
  const action = tp.action || 'UNKNOWN'

  const isBuy = action === 'BUY SEEN' || action === 'ADD'
  const isBreakoutAct = action.includes('BREAKOUT')
  const isBearAct = action.includes('SELL') || action === 'AVOID'
  const isTrim = action === 'TRIM'
  const accentColor = isBuy ? '#10b981'
    : isBearAct ? '#ef4444'
      : isBreakoutAct ? '#fcd34d'
        : isTrim ? '#06b6d4'
          : '#f59e0b'

  const verdicts = {
    'BUY SEEN':           { headline: 'Clean buy setup', body: 'Momentum, trend alignment, volume, and reward/risk all line up. The engine sees a textbook entry here — but always confirm with your own thesis before clicking buy.' },
    'ADD':                { headline: 'Add to existing position', body: 'You already own this and a fresh buy setup just triggered. Consider scaling into your position — but stay within your sizing rules.' },
    'BREAKOUT (CAUTION)': { headline: 'Breakout, but unconfirmed', body: 'Price crossed the 20-day ceiling, but either volume is light (<1.5× avg) or conviction is moderate. Wait 1–2 sessions to see if the breakout holds with rising volume.' },
    'BREAKOUT (WEAK)':    { headline: 'Likely fakeout', body: 'Resistance was breached, but technicals AND volume are weak. High probability this is a bull trap — do not chase. Wait for momentum + volume to confirm.' },
    'HOLD / WAIT':        { headline: 'No clean edge yet', body: 'Either signals are mixed or the reward/risk is below the 1.5× minimum. If you own it, hold; if you don\'t, wait for a better setup.' },
    'HOLD (OVERBOUGHT)':  { headline: 'Strong but stretched', body: 'Momentum is good, but RSI is above 70. Hold what you own; do NOT add fresh capital here — wait for RSI to cool below 65.' },
    'TRIM':               { headline: 'Book partial profits', body: 'You are up significantly and the stock is overbought. The engine suggests trimming part of your position to lock in gains, while leaving a runner.' },
    'SELL (AT RANGE)':    { headline: 'Pinned at the ceiling', body: 'The stock is range-bound and pressed against the 20-day high. Range tops usually push price back. Book profits if you\'re long; do not buy here.' },
    'AVOID':              { headline: 'Stay out', body: 'Technicals are severely broken or volatility is erratic. Execution risk is high — wide stops, gap risk, asymmetric drawdowns. Sit this one out.' },
  }
  const v = verdicts[action] || { headline: action, body: 'See engine reason below.' }

  const tgUpsidePct = (tp.tgt && s.price) ? ((tp.tgt - s.price) / s.price) * 100 : null
  const slDownsidePct = (tp.sl && s.price) ? ((tp.sl - s.price) / s.price) * 100 : null

  const rr = tp.rrRatio
  let rrVerdict = '—'
  let rrColor = '#94a3b8'
  if (rr !== null && rr !== undefined) {
    if (rr >= 2)        { rrVerdict = 'Excellent — generous upside vs the risk taken.';    rrColor = '#10b981' }
    else if (rr >= 1.5) { rrVerdict = 'Acceptable — clears the 1.5× minimum.';            rrColor = '#06b6d4' }
    else if (rr >= 1)   { rrVerdict = 'Marginal — upside roughly equals downside.';        rrColor = '#f59e0b' }
    else                { rrVerdict = 'Poor — target is closer than stop. Skip or wait.';  rrColor = '#ef4444' }
  }

  const regimeNotes = {
    'STRONG TREND': 'Price has aligned moving averages and is moving in a clear direction. Trend-following plays (continuation, pullback buys) work best here.',
    'RANGE-BOUND':  'Price is oscillating between support and resistance with no directional bias. Buy near the floor, sell near the ceiling — do not chase breakouts that fail.',
    'WILD SWINGS':  'Volatility is elevated — sharp single-day moves or wide ATR. Wider stops are needed; gap risk is real. Position sizing should be smaller than usual.',
  }

  return (
    <div className="conv-modal-backdrop" onClick={onClose}>
      <div className="conv-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '560px' }}>
        {/* Header */}
        <div className="conv-modal-header">
          <div>
            <div style={{ fontSize: '0.65rem', color: '#94a3b8', letterSpacing: '1px', marginBottom: '0.25rem' }}>
              TRADE PLAN
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '1.1rem', fontWeight: 800, color: '#f8fafc' }}>{s.symbol}</span>
              <span style={{
                fontSize: '0.85rem', fontWeight: 800,
                padding: '0.2rem 0.6rem',
                border: `1px solid ${accentColor}`,
                color: accentColor,
                borderRadius: '4px'
              }}>
                {action}
              </span>
              <span className="mono" style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                ₹{s.price?.toFixed(2)}
              </span>
            </div>
          </div>
          <button className="conv-modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div className="conv-modal-body">
          {/* Verdict */}
          <div style={{
            padding: '0.75rem 0.85rem', borderRadius: '6px',
            background: 'rgba(255,255,255,0.02)', border: `1px solid ${accentColor}33`,
            marginBottom: '1rem'
          }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: accentColor, marginBottom: '0.35rem' }}>
              {v.headline}
            </div>
            <div style={{ fontSize: '0.72rem', color: '#cbd5e1', lineHeight: 1.55 }}>
              {v.body}
            </div>
          </div>

          {/* Why this tag */}
          {tp.reason && (
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.6rem', color: '#64748b', letterSpacing: '1px', fontWeight: 700, marginBottom: '0.4rem' }}>
                WHY THIS TAG (THIS STOCK)
              </div>
              <div style={{ fontSize: '0.72rem', color: '#94a3b8', lineHeight: 1.55, padding: '0.5rem 0.7rem', background: 'rgba(255,255,255,0.02)', borderLeft: `2px solid ${accentColor}`, borderRadius: '4px' }}>
                {tp.reason}
              </div>
            </div>
          )}

          {/* TG / SL cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '1rem' }}>
            <div style={{ padding: '0.65rem 0.75rem', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '6px' }}>
              <div style={{ fontSize: '0.55rem', color: '#10b981', letterSpacing: '1px', fontWeight: 700, marginBottom: '0.3rem' }}>TARGET (TG)</div>
              <div className="mono" style={{ fontSize: '1rem', fontWeight: 800, color: '#10b981' }}>
                {tp.tgt !== null && tp.tgt !== undefined ? `₹${tp.tgt}` : '—'}
              </div>
              {tgUpsidePct !== null && (
                <div style={{ fontSize: '0.6rem', color: '#94a3b8', marginTop: '0.25rem' }}>
                  {tgUpsidePct >= 0 ? '+' : ''}{tgUpsidePct.toFixed(2)}% from current price
                </div>
              )}
              <div style={{ fontSize: '0.62rem', color: '#cbd5e1', marginTop: '0.4rem', lineHeight: 1.5 }}>
                Where to take profits. Based on the 20-day ceiling (or, after a breakout, projected via ATR).
              </div>
            </div>
            <div style={{ padding: '0.65rem 0.75rem', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '6px' }}>
              <div style={{ fontSize: '0.55rem', color: '#ef4444', letterSpacing: '1px', fontWeight: 700, marginBottom: '0.3rem' }}>STOP LOSS (SL)</div>
              <div className="mono" style={{ fontSize: '1rem', fontWeight: 800, color: '#ef4444' }}>
                {tp.sl !== null && tp.sl !== undefined ? `₹${tp.sl}` : '—'}
              </div>
              {slDownsidePct !== null && (
                <div style={{ fontSize: '0.6rem', color: '#94a3b8', marginTop: '0.25rem' }}>
                  {slDownsidePct.toFixed(2)}% from current price
                </div>
              )}
              <div style={{ fontSize: '0.62rem', color: '#cbd5e1', marginTop: '0.4rem', lineHeight: 1.5 }}>
                Exit if price falls here. Set just below the 20-day floor (minus a small ATR buffer to avoid wicks).
              </div>
            </div>
          </div>

          {/* R:R */}
          <div style={{
            padding: '0.7rem 0.85rem', borderRadius: '6px',
            background: 'rgba(255,255,255,0.02)', border: `1px solid ${rrColor}33`,
            marginBottom: '1rem'
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '0.55rem', color: '#64748b', letterSpacing: '1px', fontWeight: 700, marginBottom: '0.2rem' }}>
                  REWARD : RISK
                </div>
                <div className="mono" style={{ fontSize: '1.1rem', fontWeight: 800, color: rrColor }}>
                  {rr !== null && rr !== undefined ? `${rr}×` : '—'}
                </div>
              </div>
              <div style={{ fontSize: '0.65rem', color: '#cbd5e1', maxWidth: '320px', textAlign: 'right', lineHeight: 1.5 }}>
                {rrVerdict}
              </div>
            </div>
            <div style={{ fontSize: '0.6rem', color: '#64748b', marginTop: '0.5rem', lineHeight: 1.5 }}>
              Formula: (TG − price) ÷ (price − SL). For every ₹1 you risk on the stop, this is how many ₹ the target offers. The engine demotes BUY SEEN to HOLD/WAIT when this drops below 1.5×.
            </div>
          </div>

          {/* Regime */}
          <div style={{ marginBottom: '0.5rem' }}>
            <div style={{ fontSize: '0.55rem', color: '#64748b', letterSpacing: '1px', fontWeight: 700, marginBottom: '0.35rem' }}>
              MARKET REGIME
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.4rem' }}>
              <span className="mono" style={{
                fontSize: '0.85rem', fontWeight: 800,
                color: s.regime === 'STRONG TREND' ? '#10b981' : s.regime === 'WILD SWINGS' ? '#ef4444' : '#f59e0b'
              }}>
                {s.regime}{s.regime === 'STRONG TREND' && s.trendDirection ? (s.trendDirection === 'BULL' ? ' ▲' : ' ▼') : ''}
              </span>
            </div>
            <div style={{ fontSize: '0.7rem', color: '#94a3b8', lineHeight: 1.55 }}>
              {regimeNotes[s.regime] || 'Regime unclassified.'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default TradePlanModal
