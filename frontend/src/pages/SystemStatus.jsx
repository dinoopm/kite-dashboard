import { useEffect, useMemo, useState } from 'react'
import { loadSystemStatus, STATE_META } from '../lib/systemStatus'

// ─── Status: is everything that should be running, running? ─────────────────
//
// Daily jobs, scorecards, data feeds, the GitHub scrapers, whether the running
// code matches the files on disk, and stray backend processes — each one ok,
// needs attention, broken, or not run yet. Read from /api/system-status
// (backend/systemStatus.js), which decides the states; this page only lays
// them out. Nothing here changes anything: where an action is needed, the
// check says what it is.

const GREY = 'var(--text-secondary)'
const GROUP_ORDER = ['Daily jobs', 'Scorecards', 'Data feeds', 'Backups', 'Scrapers (GitHub Actions)', 'Running code']

function Check({ c }) {
  const m = STATE_META[c.state] || STATE_META.unknown
  return (
    <li style={{ display: 'grid', gridTemplateColumns: '7.5rem minmax(0, 1fr)', gap: '0.2rem 0.8rem', padding: '0.55rem 0', borderTop: '1px solid rgba(255,255,255,0.05)', alignItems: 'baseline' }}>
      <span style={{ fontSize: '0.7rem', fontWeight: 700, color: m.color, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
        <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: m.color, marginRight: 6 }} />
        {m.label}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.86rem', fontWeight: 600 }}>{c.label}</div>
        <div style={{ fontSize: '0.8rem', color: GREY, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{c.summary}</div>
        {c.action && <div style={{ fontSize: '0.78rem', color: 'var(--text-primary)', marginTop: '0.2rem', overflowWrap: 'anywhere' }}>→ {c.action}</div>}
      </div>
    </li>
  )
}

export default function SystemStatus() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const pull = (force = false) => {
    setBusy(true)
    return loadSystemStatus({ force })
      .then(j => { setStatus(j); setError(null) })
      .catch(e => setError(e.message))
      .finally(() => setBusy(false))
  }
  useEffect(() => { pull() }, [])

  const groups = useMemo(() => {
    const by = {}
    for (const c of status?.checks || []) (by[c.group] ||= []).push(c)
    return [...GROUP_ORDER.filter(g => by[g]), ...Object.keys(by).filter(g => !GROUP_ORDER.includes(g))].map(g => [g, by[g]])
  }, [status])

  const counts = status?.counts || {}
  return (
    <div style={{ padding: '0.5rem 0', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <h2 style={{ margin: '0 0 0.25rem' }}>Status</h2>
      <p style={{ color: GREY, fontSize: '0.85rem', margin: '0 0 1rem', maxWidth: '900px' }}>
        Whether the jobs, scorecards, feeds and scrapers behind this app are working, and whether the code running is the code on disk.
        Anything broken also shows as a banner on every page.
      </p>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
        {['fail', 'warn', 'unknown', 'ok'].map(s => (
          <span key={s} className="glass-panel" style={{ padding: '0.5rem 0.9rem', borderLeft: `3px solid ${STATE_META[s].color}`, fontSize: '0.8rem' }}>
            <strong style={{ fontSize: '1.1rem', marginRight: 6 }}>{counts[s] ?? '–'}</strong>{STATE_META[s].label}
          </span>
        ))}
        <button type="button" onClick={() => pull(true)} disabled={busy}
          style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', padding: '0.45rem 0.9rem', cursor: busy ? 'wait' : 'pointer', fontSize: '0.8rem' }}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
        {status?.generatedAt && <span style={{ fontSize: '0.75rem', color: GREY }}>Checked {new Date(status.generatedAt).toLocaleTimeString()}{status.cached ? ' (cached)' : ''}</span>}
      </div>

      {error && <div className="glass-panel" style={{ padding: '0.8rem 1rem', color: '#fca5a5', marginBottom: '1rem' }}>Status could not be loaded: {error}</div>}
      {!status && !error && <div className="loader" />}

      {groups.map(([g, list]) => (
        <section key={g} className="glass-panel" style={{ padding: '0.9rem 1.1rem', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '0.95rem' }}>{g}</h3>
          <ul style={{ listStyle: 'none', margin: '0.4rem 0 0', padding: 0 }}>
            {list.map(c => <Check key={c.id} c={c} />)}
          </ul>
        </section>
      ))}
    </div>
  )
}
