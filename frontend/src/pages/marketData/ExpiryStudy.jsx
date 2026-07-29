import { useEffect, useState } from 'react'
import { fmtDate } from '../../lib/formatDate'

// ─── F&O expiry: the date, and whether it means anything ─────────────────────
//
// Exists because "expiry week is volatile" is repeated everywhere and checked
// nowhere. The page leads with the measurement rather than the folklore, and
// stays grey when the measurement finds nothing — which, over 138 monthly
// expiries since 2015, is what it finds.
//
// Backed by /api/expiry-study (backend/expiryStudy.js).

const GREY = 'var(--text-secondary)'

const GROUPS = [
  { key: 'expiryDay', label: 'Expiry session', help: 'The monthly derivatives-expiry session itself, against every other session.' },
  { key: 'expiryWindow', label: 'Expiry window (±3)', help: 'The three sessions either side of expiry, plus expiry itself.' },
  { key: 'preExpiry', label: 'Run-up (3 before)', help: 'The sessions leading into expiry, where rollover happens.' },
]

const MEASURES = [
  { key: 'rangePct', label: 'Intraday range', help: '(high − low) / close. What the day actually felt like.' },
  { key: 'absRetPct', label: 'Absolute move', help: 'Close-to-close, direction ignored. What it did to a position held overnight.' },
  { key: 'retPct', label: 'Direction', help: 'Signed close-to-close return, reported as a gap in percentage points — a ratio would be meaningless around zero.' },
]

// Significance drives the colour, not effect size. A big difference that could
// be noise must not read as a finding.
const toneOf = (c) => {
  if (!c || c.underSampled || c.tStat == null) return GREY
  if (Math.abs(c.tStat) < 2) return GREY
  return c.tStat > 0 ? '#f87171' : '#34d399'
}

const effectOf = (c) => {
  if (!c || !c.n) return '—'
  if (c.signed) return c.diffPp == null ? '—' : `${c.diffPp >= 0 ? '+' : '−'}${Math.abs(c.diffPp).toFixed(2)} pp`
  if (c.ratio == null) return '—'
  const pct = Math.round(Math.abs(c.ratio - 1) * 100)
  return `${c.ratio >= 1 ? '+' : '−'}${pct}%`
}

export default function ExpiryStudy() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let on = true
    fetch('/api/expiry-study')
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j })
      .then(j => { if (on) setData(j) })
      .catch(e => { if (on) setError(e.message) })
    return () => { on = false }
  }, [])

  if (error) return <div className="glass-panel" style={{ padding: '1.5rem', color: '#f87171' }}>Expiry study unavailable: {error}</div>
  if (!data) return <div className="loader" />

  const cell = { padding: '0.5rem 0.7rem', fontSize: '0.85rem', textAlign: 'right' }
  const th = { ...cell, color: GREY, fontWeight: 600, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.5px' }
  const anySignificant = GROUPS.some(g => MEASURES.some(m => {
    const c = data.results?.[g.key]?.[m.key]
    return c && !c.underSampled && c.tStat != null && Math.abs(c.tStat) >= 2
  }))

  return (
    <div style={{ padding: '0.5rem 0' }}>
      <h2 style={{ margin: '0 0 0.25rem' }}>F&amp;O Expiry</h2>
      <p style={{ color: GREY, fontSize: '0.85rem', margin: '0 0 1.25rem', maxWidth: '900px' }}>
        Monthly derivatives expiry, and whether it actually moves the market. {data.index} volatility on expiry
        sessions measured against every other session since {fmtDate(data.period.from)}. <strong>For research only — not investment advice.</strong>
      </p>

      {/* Next expiry — the part that is simply a fact. */}
      {data.next && (
        <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--accent)' }}>Next monthly expiry</span>
          <span style={{ fontSize: '1.3rem', fontWeight: 800 }}>{fmtDate(data.next.date)}</span>
          {data.next.sessionsAway != null && (
            <span style={{ fontSize: '0.85rem', color: GREY }}>{data.next.sessionsAway} session{data.next.sessionsAway === 1 ? '' : 's'} away</span>
          )}
          {data.next.projected && (
            <span style={{ fontSize: '0.75rem', color: '#fbbf24' }} title="Derived as the last Thursday of the month. Holidays are not known in advance, so the exchange may pull it a session earlier.">
              projected — shifts earlier if that Thursday is a holiday
            </span>
          )}
        </div>
      )}

      {/* The verdict, stated before the table so it cannot be skimmed past. */}
      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', borderLeft: `3px solid ${anySignificant ? '#f87171' : '#4b5563'}` }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: GREY, marginBottom: '0.35rem' }}>Verdict</div>
        <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>
          {anySignificant
            ? 'At least one expiry window differs measurably from an ordinary session — see the table.'
            : `No measurable expiry effect. Across ${data.expiries.count} monthly expiries since ${fmtDate(data.period.from)}, none of the differences are distinguishable from noise.`}
        </div>
        <div style={{ fontSize: '0.75rem', color: GREY, marginTop: '0.4rem' }}>
          Colour follows significance (|t| ≥ 2), not effect size — a large difference that could be noise stays grey.
        </div>
      </div>

      <div className="glass-panel" style={{ padding: '0.4rem', overflowX: 'auto', marginBottom: '1rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Group</th>
              {MEASURES.map(m => (
                <th key={m.key} style={th} title={m.help} colSpan={2}>{m.label}</th>
              ))}
              <th style={th}>n</th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map(g => (
              <tr key={g.key} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <td style={{ ...cell, textAlign: 'left', fontWeight: 600 }} title={g.help}>{g.label}</td>
                {MEASURES.map(m => {
                  const c = data.results?.[g.key]?.[m.key]
                  return [
                    <td key={`${m.key}-e`} style={{ ...cell, color: toneOf(c), fontWeight: 700 }}>{effectOf(c)}</td>,
                    <td key={`${m.key}-t`} style={{ ...cell, color: GREY, fontSize: '0.75rem' }} title="Welch's t on the difference of means. |t| ≥ 2 is the usual bar for 'distinguishable from zero'.">
                      t={c?.tStat ?? '—'}
                    </td>,
                  ]
                })}
                <td style={{ ...cell, color: GREY }}>{data.results?.[g.key]?.rangePct?.n ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Is the expiry rule itself still right? */}
      {data.ruleCheck && (
        <div className="glass-panel" style={{ padding: '0.85rem 1.25rem', marginBottom: '1rem', fontSize: '0.8rem', color: GREY }}>
          <strong style={{ color: data.ruleCheck.looksRight ? '#34d399' : '#fbbf24' }}>
            {data.ruleCheck.looksRight ? '✓ Expiry rule looks right' : '⚠ Expiry rule may have drifted'}
          </strong>
          {' — '}derived expiry sessions trade {data.ruleCheck.ratio}× the median volume of an ordinary session
          ({data.ruleCheck.expirySessions} expiry vs {data.ruleCheck.otherSessions} other).
          Dates are derived as the last traded Thursday of the month; if NSE changes that, this ratio collapses toward 1.0.
        </div>
      )}

      <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.72rem', color: GREY, fontStyle: 'italic', lineHeight: 1.7 }}>
        {data.caveats.map((c, i) => <li key={i}>{c}</li>)}
      </ul>
    </div>
  )
}
