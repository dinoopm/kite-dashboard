import { useEffect } from 'react'

// Bullish-bias breakdown modal. Shows the components that summed into the
// stock's confidence score. Renders nothing when `stock` is null.
function ConvictionModal({ stock, onClose }) {
  useEffect(() => {
    if (!stock) return
    const handleEsc = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [stock, onClose])

  if (!stock) return null

  // Reconstruct breakdown client-side if backend doesn't provide it
  const breakdown = stock.confBreakdown || (() => {
    const bd = [{ label: 'Base', value: 30 }]
    const rsi = stock.rsi
    if (rsi !== null && rsi !== undefined) {
      if (rsi > 40 && rsi < 70) bd.push({ label: 'RSI in healthy zone', value: 10 })
      if (rsi <= 30) bd.push({ label: 'RSI oversold (rebound setup)', value: 15 })
      if (rsi >= 75) bd.push({ label: 'RSI severely overbought', value: -10 })
    }
    if (stock.sma5 && stock.sma20) {
      if (stock.sma5 > stock.sma20) bd.push({ label: 'SMA5 > SMA20 (short-term momentum)', value: 15 })
      else bd.push({ label: 'SMA5 < SMA20 (short-term bearish)', value: -5 })
    }
    if (stock.sma50 && stock.sma200) {
      if (stock.sma50 > stock.sma200) bd.push({ label: 'SMA50 > SMA200 (golden state)', value: 10 })
      else {
        if (stock.price > stock.sma50 && stock.price > stock.sma200) bd.push({ label: 'Death cross (softened: price leads)', value: -5 })
        else bd.push({ label: 'Death cross', value: -10 })
      }
    }
    const vd = stock.vwapDeviation
    if (vd !== null && vd !== undefined) {
      if (vd > 0) bd.push({ label: 'Price above 20d VWAP', value: 10 })
      if (vd < -2) bd.push({ label: 'Deep below 20d VWAP', value: -10 })
    }
    const agg = stock.aggressorDelta || 0
    if (agg > 0.3) bd.push({ label: 'Strong accumulation (money flow)', value: 10 })
    if (agg < -0.2) bd.push({ label: 'Distribution (money flow)', value: -10 })
    if (stock.regime === 'STRONG TREND') {
      if (stock.trendDirection === 'BULL') bd.push({ label: 'Strong bullish trend', value: 5 })
      else if (stock.trendDirection === 'BEAR') bd.push({ label: 'Strong bearish trend', value: -5 })
    }
    if (stock.regime === 'WILD SWINGS') bd.push({ label: 'Volatile regime', value: -10 })
    if (stock.sma50 && stock.sma200 && stock.price > stock.sma50 && stock.price > stock.sma200) {
      bd.push({ label: 'Price leads both MAs', value: 10 })
    }
    return bd
  })()

  return (
    <div className="conv-modal-backdrop" onClick={onClose}>
      <div className="conv-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="conv-modal-header">
          <div>
            <div
              style={{ fontSize: '0.65rem', color: '#94a3b8', letterSpacing: '1px', marginBottom: '0.25rem' }}
              title="Bullish bias score: 0 = strongly bearish, 50 = balanced, 100 = strongly bullish. Not a confidence in the trade direction."
            >
              BULLISH BIAS BREAKDOWN
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
              <span style={{ fontSize: '1.1rem', fontWeight: 800, color: '#f8fafc' }}>{stock.symbol}</span>
              {(() => {
                const conf = stock.confidence
                const cColor = conf > 75 ? '#10b981' : conf < 40 ? '#ef4444' : '#f59e0b'
                return <span className="mono" style={{ fontSize: '1.6rem', fontWeight: 800, color: cColor }}>{conf}%</span>
              })()}
            </div>
          </div>
          <button className="conv-modal-close" onClick={onClose}>✕</button>
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
              Measures <strong style={{ color: '#f8fafc' }}>bullish bias</strong>, not direction-neutral confidence.
              Score starts at <span className="mono" style={{ color: '#f8fafc', fontWeight: 700 }}>30</span> (base); bullish signals add points, bearish signals subtract.
              Clamped to <span className="mono" style={{ color: '#f8fafc' }}>0–100</span>: <span style={{ color: '#ef4444' }}>&lt;40 bearish</span>, <span style={{ color: '#f59e0b' }}>40–75 mixed</span>, <span style={{ color: '#10b981' }}>&gt;75 bullish</span>.
            </div>
            <div className="mono" style={{ fontSize: '0.65rem', color: '#475569', marginTop: '0.5rem' }}>
              {breakdown.map(c => (c.value >= 0 ? `+${c.value}` : `${c.value}`)).join(' ')} = <span style={{ color: '#f8fafc', fontWeight: 700 }}>{breakdown.reduce((s, c) => s + c.value, 0)}</span> → clamped to <span style={{ color: stock.confidence > 75 ? '#10b981' : stock.confidence < 40 ? '#ef4444' : '#f59e0b', fontWeight: 800 }}>{stock.confidence}%</span>
            </div>
          </div>

          {/* Key metrics context */}
          <div style={{ marginTop: '1rem', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.6rem' }}>
            {[
              { label: 'RSI (14)', value: stock.rsi?.toFixed(1) || '—', color: stock.rsi > 70 ? '#ef4444' : stock.rsi < 30 ? '#10b981' : '#cbd5e1' },
              { label: 'VWAP Dev', value: stock.vwapDeviation !== null ? `${stock.vwapDeviation > 0 ? '+' : ''}${stock.vwapDeviation.toFixed(2)}%` : '—', color: stock.vwapDeviation > 0 ? '#10b981' : '#ef4444' },
              { label: 'Regime', value: stock.regime, color: stock.regime === 'STRONG TREND' ? '#10b981' : stock.regime === 'WILD SWINGS' ? '#ef4444' : '#f59e0b' },
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
}

export default ConvictionModal
