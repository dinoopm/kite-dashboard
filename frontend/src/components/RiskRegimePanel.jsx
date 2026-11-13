import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import SignalScore from './SignalScore'
import { sinceText, changesIn, cellTitle, fmtDay } from '../lib/regimeHistory'

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

// Strip colours follow the verdict badge: green / red for the two calls, a
// recessive grey for NEUTRAL so the eye lands on the stretches that said
// something.
const CELL = { 'RISK-ON': '#34d399', 'RISK-OFF': '#f87171', NEUTRAL: 'rgba(148,163,184,0.32)' }

/**
 * The last 60 sessions, one cell each, replayed from daily closes. Shown so
 * the current word has context ("since when, after what?") and so its
 * twitchiness is visible: a label that flips four times in a week reads very
 * differently from one that has held for a month.
 */
function RegimeHistory({ history, since }) {
  if (!history?.length) return null
  const flips = changesIn(history)
  const line = sinceText(since, history.length)
  const runs = []
  for (const h of history) {
    const last = runs[runs.length - 1]
    if (last && last.label === h.label) last.n++
    else runs.push({ label: h.label, n: 1, from: h.date })
  }
  const aria = `Money flow over the last ${history.length} sessions: ` + runs.map(r => `${r.label} for ${r.n} from ${fmtDay(r.from)}`).join(', ')
  return (
    <div style={{ marginTop: '0.8rem' }}>
      {line && <div style={{ fontSize: '0.78rem', color: 'var(--text-primary)', marginBottom: '0.4rem' }}>{line}</div>}
      <div role="img" aria-label={aria} style={{ display: 'flex', gap: '2px', height: '12px' }}>
        {history.map(h => (
          <span key={h.date} title={cellTitle(h)} style={{ flex: '1 1 0', minWidth: 0, borderRadius: '2px', background: CELL[h.label] || CELL.NEUTRAL, cursor: 'help' }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.3rem', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
        <span>{fmtDay(history[0].date)}</span>
        <span>{fmtDay(history[history.length - 1].date)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem 0.9rem', flexWrap: 'wrap', marginTop: '0.25rem', fontSize: '0.68rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        <span style={{ display: 'inline-flex', gap: '0.7rem', flexWrap: 'wrap' }}>
          {['RISK-ON', 'NEUTRAL', 'RISK-OFF'].map(l => (
            <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
              <i style={{ width: '9px', height: '9px', borderRadius: '2px', background: CELL[l], display: 'inline-block' }} />{l}
            </span>
          ))}
        </span>
        <span>
          {flips} change{flips === 1 ? '' : 's'} in {history.length} sessions. Replayed from daily closes with today's rules. From now on, each change is also recorded after the US close.
        </span>
      </div>
    </div>
  )
}

export default function RiskRegimePanel() {
  const [d, setD] = useState(null)

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
        {d.validation && <SignalScore signal="risk_regime" market="US" entry={d.validation} style={{ marginLeft: 'auto' }} />}
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

      <RegimeHistory history={d.history} since={d.since} />

      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.7rem', paddingTop: '0.6rem', borderTop: '1px solid var(--border)' }}>
        <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>🇮🇳 {d.indiaNote}</span>
        <Link to="/us/macro" style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}>US Macro →</Link>
      </div>
    </div>
  )
}
