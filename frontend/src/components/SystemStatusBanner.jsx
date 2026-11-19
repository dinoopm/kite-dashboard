import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { loadSystemStatus, failures } from '../lib/systemStatus'

// ─── App-wide alert for things that have stopped working ────────────────────
//
// The app used to report only success. A job that failed wrote to a terminal
// nobody reads; a scorecard that failed made its badges vanish, so the page
// looked normal. This sits under the navbar on every page and appears ONLY
// when something is broken now (state "fail") — pending restarts and stray
// processes are warnings, shown on the Status page, because an alert that is
// always on is an alert nobody reads.
//
// Re-checks every 10 minutes while the tab is open. A failed status fetch is
// silent: the banner reports the app's health, not its own.

const POLL_MS = 10 * 60 * 1000

export default function SystemStatusBanner() {
  const [status, setStatus] = useState(null)
  const location = useLocation()

  useEffect(() => {
    let on = true
    const pull = () => loadSystemStatus().then(j => { if (on) setStatus(j) }).catch(() => {})
    pull()
    const timer = setInterval(() => { if (!document.hidden) pull() }, POLL_MS)
    return () => { on = false; clearInterval(timer) }
  }, [])

  const bad = failures(status)
  if (!bad.length || location.pathname === '/status') return null

  return (
    <div role="alert" style={{
      border: '1px solid rgba(248,113,113,0.45)', background: 'rgba(248,113,113,0.08)', borderRadius: '8px',
      padding: '0.55rem 0.9rem', margin: '0 0 1rem', fontSize: '0.8rem', color: '#fca5a5',
      display: 'flex', gap: '0.4rem 1rem', flexWrap: 'wrap', alignItems: 'baseline',
    }}>
      <strong>{bad.length} thing{bad.length === 1 ? ' has' : 's have'} stopped working:</strong>
      <span style={{ flex: '1 1 320px', color: 'var(--text-primary)' }}>
        {bad.slice(0, 3).map(c => `${c.label} — ${c.summary}`).join(' · ')}{bad.length > 3 ? ` · and ${bad.length - 3} more` : ''}
      </span>
      <Link to="/status" style={{ color: '#fca5a5', fontWeight: 700, whiteSpace: 'nowrap' }}>See status →</Link>
    </div>
  )
}
