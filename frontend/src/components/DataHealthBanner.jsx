import { useEffect, useState } from 'react'

// ─── Feed integrity banner ───────────────────────────────────────────────────
//
// nse_bhavcopy silently lost three sessions NSE actually traded, and every
// number derived from it kept rendering to two decimal places as if nothing
// had happened. Server-side logging catches that now, but a log nobody reads
// is not much better than no check at all — so when the price tables behind a
// page have holes, the page says so.
//
// Renders nothing when the feeds are whole, which should be the normal state.

let cache = null
let inflight = null

function loadHealth() {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetch('/api/data-health')
      .then(async r => {
        const j = await r.json()
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
        cache = j
        return j
      })
      .finally(() => { inflight = null })
  }
  return inflight
}

export default function DataHealthBanner() {
  const [health, setHealth] = useState(null)

  useEffect(() => {
    let on = true
    loadHealth().then(j => { if (on) setHealth(j) }).catch(() => {})
    return () => { on = false }
  }, [])

  if (!health || health.ok) return null
  const bad = health.feeds.filter(f => !f.ok)
  if (!bad.length) return null

  return (
    <div
      style={{
        border: '1px solid rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.08)',
        borderRadius: '8px', padding: '0.6rem 0.9rem', marginBottom: '1rem',
        fontSize: '0.78rem', color: '#fbbf24', lineHeight: 1.6,
      }}
    >
      <strong>Feed gaps — numbers on this page are computed over incomplete data.</strong>
      <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
        {bad.map(f => (
          <li key={f.table}>
            <span style={{ fontWeight: 600 }}>{f.label}</span>
            {f.error ? ` — health check failed: ${f.error}` : null}
            {f.stale ? ` — ${f.sessionsBehind} session(s) behind (last ${f.last})` : null}
            {f.gaps?.length ? ` — missing ${f.gaps.length} traded session(s): ${f.gaps.join(', ')}` : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
