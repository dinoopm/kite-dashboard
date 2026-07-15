import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { fmtDate } from '../lib/formatDate'

// Morning briefing — deterministic "what changed since yesterday" composed by
// /api/briefing (backend/briefing.js): market flows + VIX, per-holding
// analytic deltas, quant-picks churn. Every item links to its source page.
const TONES = {
  good: '#34d399',
  warn: '#fbbf24',
  alert: '#f87171',
  neutral: 'var(--text-secondary)',
}

function Section({ title, items }) {
  if (!items?.length) return null
  return (
    <div className="glass-panel" style={{ padding: '1.1rem 1.4rem', marginBottom: '1.25rem' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--accent)', marginBottom: '0.7rem' }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {items.map((it, i) => (
          <Link key={i} to={it.link || '#'} style={{ textDecoration: 'none', display: 'flex', gap: '0.6rem', alignItems: 'baseline' }}>
            <span style={{ flexShrink: 0, width: '8px', height: '8px', borderRadius: '50%', background: TONES[it.tone] || TONES.neutral, position: 'relative', top: '-1px' }} />
            <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)', lineHeight: 1.55 }}>{it.text}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

export default function Briefing() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let on = true
    fetch('/api/briefing')
      .then(r => r.json())
      .then(j => { if (on) (j.error ? setError(j.error) : setData(j)) })
      .catch(e => on && setError(e.message))
    return () => { on = false }
  }, [])

  if (error) return <div className="glass-panel" style={{ padding: '1.5rem', color: '#f87171' }}>Briefing unavailable: {error}</div>
  if (!data) return <div className="loader" />

  return (
    <div className="dashboard-layout">
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0 }}>Morning Briefing</h1>
        <p style={{ margin: '0.3rem 0 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          {fmtDate(data.date)} · what changed since the last session — deterministic rules over your own data, not commentary
        </p>
      </div>

      {data.quiet ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <p style={{ margin: 0 }}>Nothing new to report.</p>
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
            Holding deltas appear from the second day onward — the first briefing seeds the baseline snapshot.
          </p>
        </div>
      ) : (
        <>
          <Section title="Your holdings — changes" items={data.holdings} />
          <Section title="Upcoming events — holdings & watchlists" items={data.events} />
          <Section title="Market" items={data.market} />
          <Section title="Quant picks churn" items={data.picks} />
          {!data.holdings?.length && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
              No changes on your holdings since the last snapshot{data.market?.length ? ' — market items above are standing context' : ''}.
            </p>
          )}
        </>
      )}
    </div>
  )
}
