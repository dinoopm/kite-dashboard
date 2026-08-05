import { useEffect, useState } from 'react'

// ─── Protective stops, written to be read ────────────────────────────────────
//
// Read-only by construction: this component fetches and renders, has no path
// that can reach the broker, and has no Place button.
//
// The first version of this panel was two dense tables of percentages and the
// feedback was that it was hard to follow. So the rule here is that every
// number is next to a plain sentence saying what it means, and the jargon is
// gone: "trail" is an exit level, "breached" is already past it, "distance" is
// how far below today's price.
//
// The already-past list comes FIRST. It is the uncomfortable half and the
// important one — a position below its exit level is the live form of the
// pattern the journal recorded as NEWGEN, held 456 days to a -48% loss.

const GREY = 'var(--text-secondary)'
const RED = '#fca5a5'
const AMBER = '#fbbf24'
const GREEN = '#34d399'

const inr = (v) => (v == null ? '—' : `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`)
const price = (v) => (v == null ? '—' : `₹${Number(v).toLocaleString('en-IN')}`)

// Closer than this to today's price and an ordinary day's range takes it out.
const TIGHT_PCT = 2

export default function StopProposals() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [showSkipped, setShowSkipped] = useState(false)

  useEffect(() => {
    let on = true
    fetch('/api/orders/stop-proposals')
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j })
      .then(j => { if (on) setRows(j.proposals || []) })
      .catch(e => { if (on) setError(e.message) })
    return () => { on = false }
  }, [])

  const panel = (children) => (
    <section className="glass-panel animate-in" style={{ padding: '1.5rem' }}>{children}</section>
  )

  if (error) return panel(<p style={{ margin: 0, color: RED, fontSize: '0.85rem' }}>Could not load stop levels: {error}</p>)
  if (!rows) return panel(<p style={{ margin: 0, color: GREY, fontSize: '0.85rem' }}>Working out stop levels…</p>)
  if (!rows.length) {
    return panel(<>
      <h2 style={{ margin: '0 0 0.4rem', fontSize: '1.1rem' }}>Protective stops</h2>
      <p style={{ margin: 0, fontSize: '0.85rem', color: GREY }}>
        Nothing calculated yet. This runs once a session against your holdings, so levels appear after the next run.
      </p>
    </>)
  }

  const latest = rows[0]?.proposed_on
  const today = rows.filter(r => r.proposed_on === latest)
  const past = today.filter(r => r.status === 'breached').sort((a, b) => b.below_trail_pct - a.below_trail_pct)
  const ok = today.filter(r => r.status === 'proposed').sort((a, b) => b.distance_pct - a.distance_pct)
  const skipped = today.filter(r => r.status === 'rejected')

  const cell = { padding: '0.5rem 0.7rem', fontSize: '0.85rem', textAlign: 'right', whiteSpace: 'nowrap' }
  const th = { ...cell, color: GREY, fontWeight: 600, fontSize: '0.7rem' }
  const nameCell = { ...cell, textAlign: 'left', fontWeight: 600 }
  const sectionTitle = { fontSize: '0.95rem', fontWeight: 700, margin: '0 0 0.3rem' }
  const explain = { fontSize: '0.8rem', color: GREY, margin: '0 0 0.7rem', lineHeight: 1.6, maxWidth: '780px' }

  return (
    <section className="glass-panel animate-in" style={{ padding: '1.5rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.15rem' }}>Protective stops</h2>

      {/* One sentence a reader can act on, before any table. */}
      <p style={{ ...explain, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
        A stop is a price where you would sell to stop a loss getting worse. This works one out for each holding,
        by tracking how much the stock normally moves and sitting below that.
        {past.length > 0 && <> Right now <strong style={{ color: AMBER }}>{past.length} of your holdings have already fallen past
        that price</strong>, and {ok.length} have a level you could still use.</>}
      </p>
      <p style={{ ...explain, fontSize: '0.75rem' }}>
        Calculated {latest}. <strong>Nothing has been sent to your broker</strong> — this page only shows numbers,
        it cannot place anything. Not investment advice.
      </p>

      {/* ── Already past ─────────────────────────────────────────────────── */}
      {past.length > 0 && (
        <div style={{ margin: '1.5rem 0', borderLeft: `3px solid ${AMBER}`, paddingLeft: '1rem' }}>
          <h3 style={{ ...sectionTitle, color: AMBER }}>Already fallen past their stop ({past.length})</h3>
          <p style={explain}>
            These dropped through their stop price a while ago. There is no order to place — a sell order above
            today&apos;s price would go through immediately. The only real question is whether you still want to hold them,
            and that is yours to answer.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...th, textAlign: 'left' }}>Stock</th>
                <th style={th}>Price today</th>
                <th style={th}>Stop price it fell past</th>
                <th style={th}>How far past</th>
              </tr></thead>
              <tbody>
                {past.map(r => (
                  <tr key={r.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={nameCell}>{r.symbol} <span style={{ color: GREY, fontSize: '0.7rem', fontWeight: 400 }}>{r.exchange}</span></td>
                    <td style={cell}>{price(r.last_price)}</td>
                    <td style={{ ...cell, color: GREY }}>{price(r.breached_level)}</td>
                    <td style={{ ...cell, color: AMBER, fontWeight: 700 }}>{r.below_trail_pct}% below</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Usable levels ────────────────────────────────────────────────── */}
      {ok.length > 0 && (
        <div style={{ margin: '1.5rem 0', borderLeft: `3px solid ${GREEN}`, paddingLeft: '1rem' }}>
          <h3 style={{ ...sectionTitle, color: GREEN }}>Have a usable stop price ({ok.length})</h3>
          <p style={explain}>
            Still above their stop. The last column is what you would lose from today&apos;s price if the stock fell
            to the stop and you sold there — the cost of being wrong, in rupees. A real sale can be worse if the
            price jumps straight past it.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...th, textAlign: 'left' }}>Stock</th>
                <th style={th}>Shares</th>
                <th style={th}>Price today</th>
                <th style={th}>Stop price</th>
                <th style={th}>Room before it hits</th>
                <th style={th}>You would lose</th>
              </tr></thead>
              <tbody>
                {ok.map(r => {
                  const tight = r.distance_pct < TIGHT_PCT
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={nameCell}>{r.symbol} <span style={{ color: GREY, fontSize: '0.7rem', fontWeight: 400 }}>{r.exchange}</span></td>
                      <td style={{ ...cell, color: GREY }}>{r.quantity}</td>
                      <td style={cell}>{price(r.last_price)}</td>
                      <td style={{ ...cell, fontWeight: 700 }}>{price(r.trigger_price)}</td>
                      <td style={{ ...cell, color: tight ? AMBER : GREY }}>
                        {r.distance_pct}%
                        {tight && <span title="So close to today's price that a normal day's swing would trigger it"> ⚠ very close</span>}
                      </td>
                      <td style={{ ...cell, color: RED }}>{inr(r.worst_case_loss)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Skipped names are listed on purpose: "why is there no stop on X?" is
          the question that matters after a loss, and it should be answerable. */}
      {skipped.length > 0 && (
        <div style={{ marginTop: '1.25rem' }}>
          <button
            onClick={() => setShowSkipped(v => !v)}
            style={{ background: 'transparent', border: 'none', color: GREY, cursor: 'pointer', fontSize: '0.8rem', padding: 0 }}
          >
            {showSkipped ? '▾' : '▸'} {skipped.length} holdings had no stop worked out — why
          </button>
          {showSkipped && (
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem', fontSize: '0.8rem', color: GREY, lineHeight: 1.8 }}>
              {skipped.map(r => <li key={r.id}><strong>{r.symbol}</strong> — {r.reject_reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
