import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

// Risk-On / Risk-Off gauge (/api/risk-regime): are stocks or bonds winning
// the money right now? Three deterministic signals — 10Y yield direction,
// stocks-vs-Treasuries, junk-vs-quality credit — into one verdict, refreshed
// daily. Answers "is money moving into bonds?" at a glance.
const TONE = {
  good: { color: '#34d399', border: 'rgba(52,211,153,0.45)', bg: 'rgba(52,211,153,0.06)' },
  neutral: { color: 'var(--text-secondary)', border: 'var(--border)', bg: 'transparent' },
  alert: { color: '#f87171', border: 'rgba(239,68,68,0.5)', bg: 'rgba(239,68,68,0.06)' },
}
const dot = (score) => (score > 0 ? '#34d399' : score < 0 ? '#f87171' : 'var(--text-secondary)')

export default function RiskRegimePanel() {
  const [d, setD] = useState(null)
  const navigate = useNavigate()

  useEffect(() => {
    let on = true
    fetch('/api/risk-regime')
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (on && j && !j.error) setD(j) })
      .catch(() => { })
    return () => { on = false }
  }, [])

  if (!d) return null
  const t = TONE[d.verdict.tone] || TONE.neutral

  return (
    <div className="glass-panel" style={{ padding: '1.1rem 1.3rem', marginBottom: '1.5rem', borderLeft: `3px solid ${t.color}`, background: t.bg }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.7rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>Money flow</span>
        <span style={{
          fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.5px',
          color: t.color, border: `1px solid ${t.border}`, borderRadius: '5px', padding: '0.1rem 0.5rem',
        }}>{d.verdict.label}</span>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>{d.verdict.text}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '0.6rem 1.4rem' }}>
        {d.gauges.map(g => (
          <div key={g.id} style={{ display: 'flex', gap: '0.55rem', alignItems: 'baseline' }}>
            <span style={{ flexShrink: 0, width: '8px', height: '8px', borderRadius: '50%', background: dot(g.score), position: 'relative', top: '-1px' }} />
            <div>
              <div style={{ fontSize: '0.78rem', fontWeight: 600 }}>
                {g.label} <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{g.value}</span>
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>{g.detail}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.7rem', paddingTop: '0.6rem', borderTop: '1px solid var(--border)' }}>
        <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>🇮🇳 {d.indiaNote}</span>
        <span onClick={() => navigate('/market-data/events')} style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--accent)', fontWeight: 600, cursor: 'pointer' }}>macro calendar →</span>
      </div>
    </div>
  )
}
