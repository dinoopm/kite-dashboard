import { useEffect, useState } from 'react'

// ─── Protective stops: what the rule says about the current book ─────────────
//
// Read-only by construction. This component fetches and renders; it has no
// path that can reach the broker, and there is no Place button yet — that is a
// separate, explicitly confirmed action gated behind ORDERS_ENABLED.
//
// The breached list comes FIRST, deliberately. It is the more important half
// and the less comfortable one: a position already below its trailing stop is
// the live form of the pattern the journal recorded as NEWGEN — held 456 days
// to a -48% loss. Burying that under a tidy list of placeable orders would
// invert the point of the feature.
//
// Backed by /api/orders/stop-proposals (backend/orders/stopProposals.js). The
// rule itself was chosen by measurement, not preference: backend/stopStudy.js
// replayed all 49 closed round trips under ten candidates.

const GREY = 'var(--text-secondary)'
const RED = '#fca5a5'
const AMBER = '#fbbf24'

const inr = (v) => (v == null ? '—' : `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`)

// A stop this close to spot will be taken out by an ordinary day's range. The
// backend's 0.5% floor lets these through; flagging them is cheaper than
// arguing about the floor, and leaves the judgement with the reader.
const TIGHT_PCT = 2

export default function StopProposals() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [showRejected, setShowRejected] = useState(false)

  useEffect(() => {
    let on = true
    fetch('/api/orders/stop-proposals')
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j })
      .then(j => { if (on) setRows(j.proposals || []) })
      .catch(e => { if (on) setError(e.message) })
    return () => { on = false }
  }, [])

  if (error) {
    return (
      <section className="glass-panel" style={{ padding: '1.25rem', marginTop: '1.5rem', color: RED, fontSize: '0.85rem' }}>
        Protective stops unavailable: {error}
      </section>
    )
  }
  if (!rows) return null
  if (!rows.length) return null

  const latest = rows[0]?.proposed_on
  const today = rows.filter(r => r.proposed_on === latest)
  const proposed = today.filter(r => r.status === 'proposed').sort((a, b) => b.distance_pct - a.distance_pct)
  const breached = today.filter(r => r.status === 'breached').sort((a, b) => b.below_trail_pct - a.below_trail_pct)
  const rejected = today.filter(r => r.status === 'rejected')

  const cell = { padding: '0.45rem 0.7rem', fontSize: '0.82rem', textAlign: 'right', whiteSpace: 'nowrap' }
  const th = { ...cell, color: GREY, fontWeight: 600, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.5px' }

  return (
    <section className="glass-panel animate-in" style={{ padding: '1.25rem', marginTop: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8rem', flexWrap: 'wrap', marginBottom: '0.2rem' }}>
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Protective stops</h2>
        <span style={{ fontSize: '0.72rem', color: GREY }}>
          {latest} · rule {today[0]?.rule} · {proposed.length} placeable, {breached.length} breached, {rejected.length} skipped
        </span>
      </div>
      <p style={{ margin: '0 0 1rem', fontSize: '0.75rem', color: GREY }}>
        Levels only — <strong>nothing has been sent to your broker</strong>, and this page cannot send anything.
        The rule (4× ATR trail) was picked by replaying all closed round trips, not by preference. <strong>Not investment advice.</strong>
      </p>

      {/* Breached first: the uncomfortable half is the important half. */}
      {breached.length > 0 && (
        <div style={{ marginBottom: '1.25rem', borderLeft: `3px solid ${AMBER}`, paddingLeft: '0.9rem' }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: AMBER, marginBottom: '0.4rem' }}>
            Already through the trail — no order proposed
          </div>
          <div style={{ fontSize: '0.75rem', color: GREY, marginBottom: '0.5rem' }}>
            These fell past their stop some time ago. A stop placed above the current price would execute immediately,
            so nothing is proposed — the question here is whether to still be holding, which the app does not answer for you.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...th, textAlign: 'left' }}>Symbol</th>
                <th style={th}>Last</th><th style={th}>Trail</th><th style={th}>Below</th>
              </tr></thead>
              <tbody>
                {breached.map(r => (
                  <tr key={r.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={{ ...cell, textAlign: 'left', fontWeight: 600 }}>
                      {r.symbol} <span style={{ color: GREY, fontSize: '0.7rem' }}>{r.exchange}</span>
                    </td>
                    <td style={cell}>{r.last_price}</td>
                    <td style={{ ...cell, color: GREY }}>{r.breached_level}</td>
                    <td style={{ ...cell, color: AMBER, fontWeight: 700 }}>−{r.below_trail_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {proposed.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: GREY, marginBottom: '0.4rem' }}>
            Placeable stop levels
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={{ ...th, textAlign: 'left' }}>Symbol</th>
              <th style={th}>Qty</th>
              <th style={th}>Last</th>
              <th style={th}>Stop</th>
              <th style={th} title="How far the stop sits below the current price">Distance</th>
              <th style={th} title="What it costs from here if the stop fills at its trigger. Real fills can be worse in a gap.">If it fills</th>
            </tr></thead>
            <tbody>
              {proposed.map(r => {
                const tight = r.distance_pct < TIGHT_PCT
                return (
                  <tr key={r.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={{ ...cell, textAlign: 'left', fontWeight: 600 }}>
                      {r.symbol} <span style={{ color: GREY, fontSize: '0.7rem' }}>{r.exchange}</span>
                    </td>
                    <td style={{ ...cell, color: GREY }}>{r.quantity}</td>
                    <td style={cell}>{r.last_price}</td>
                    <td style={{ ...cell, fontWeight: 700 }}>{r.trigger_price}</td>
                    <td style={{ ...cell, color: tight ? AMBER : GREY }}>
                      {r.distance_pct}%{tight && <span title={`Inside ${TIGHT_PCT}% of spot — an ordinary day's range will take this out`}> ⚠</span>}
                    </td>
                    <td style={{ ...cell, color: RED }}>{inr(r.worst_case_loss)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Skipped names are listed on purpose: "why is there no stop on X?" is
          the question that matters after a loss, and it should be answerable. */}
      {rejected.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <button
            onClick={() => setShowRejected(v => !v)}
            style={{ background: 'transparent', border: 'none', color: GREY, cursor: 'pointer', fontSize: '0.75rem', padding: 0 }}
          >
            {showRejected ? '▾' : '▸'} {rejected.length} skipped — why
          </button>
          {showRejected && (
            <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem', fontSize: '0.75rem', color: GREY, lineHeight: 1.7 }}>
              {rejected.map(r => <li key={r.id}><strong>{r.symbol}</strong> — {r.reject_reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
