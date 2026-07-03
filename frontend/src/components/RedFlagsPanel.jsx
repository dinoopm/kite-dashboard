import { useState, useEffect } from 'react'

// Manipulation red-flag banner shared by the India and US instrument pages.
// Each market has its own endpoint and data source — India:
// /api/red-flags/:symbol (NSE feeds + bhavcopy delivery data); US:
// /api/us/red-flags/:symbol (Alpaca daily bars — the US has no delivery or
// bulk-deal disclosures, so its checks are price/volume-based) — but both
// return the same shape: { flags: [{ id, severity, title, detail }], source }.
// Deterministic heuristics, not verdicts: a flag means "look closer", and the
// quiet all-clear line means none of the known trap patterns matched.
export default function RedFlagsPanel({ url }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let alive = true
    setData(null)
    fetch(url)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (alive) setData(j) })
      .catch(() => { })
    return () => { alive = false }
  }, [url])

  if (!data || data.error) return null

  const flags = data.flags || []
  if (!flags.length) {
    return (
      <div title={`Checks run: ${(data.checks || []).join(', ')} · Source: ${data.source}`}
        style={{ margin: '0 0 1rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
        <span style={{ color: '#34d399' }}>✓</span> No manipulation red flags detected
      </div>
    )
  }

  const hasRed = flags.some(f => f.severity === 'red')
  return (
    <section className="glass-panel" style={{
      padding: '1rem 1.25rem', marginBottom: '1.25rem',
      border: `1px solid ${hasRed ? 'rgba(239,68,68,0.5)' : 'rgba(251,191,36,0.45)'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: hasRed ? '#fca5a5' : '#fbbf24' }}>
          ⚠ {flags.length} red flag{flags.length > 1 ? 's' : ''} detected
        </span>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginLeft: 'auto' }} title={`Checks run: ${(data.checks || []).join(', ')}`}>
          {data.source}{data.asOf ? ` · as of ${data.asOf}` : ''}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
        {flags.map(f => (
          <div key={f.id} style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline' }}>
            <span style={{
              flexShrink: 0, fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
              color: f.severity === 'red' ? '#fca5a5' : '#fbbf24',
              border: `1px solid ${f.severity === 'red' ? 'rgba(239,68,68,0.5)' : 'rgba(251,191,36,0.45)'}`,
              borderRadius: '4px', padding: '0.05rem 0.35rem',
            }}>{f.severity === 'red' ? 'red' : 'caution'}</span>
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{f.title}</div>
              <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{f.detail}</div>
            </div>
          </div>
        ))}
      </div>
      <p style={{ margin: '0.7rem 0 0', fontSize: '0.68rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
        Deterministic heuristics over recent trading data — a prompt to look closer, not a verdict. Not investment advice.
      </p>
    </section>
  )
}
