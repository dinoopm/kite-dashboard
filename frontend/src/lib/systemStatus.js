// Shared loader for /api/system-status. The banner and the Status page read
// the same answer; one in-flight request and a short cache keep the banner's
// polling from multiplying across pages.

let cache = null
let inflight = null
const TTL_MS = 2 * 60 * 1000

export function loadSystemStatus({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data)
  if (!inflight) {
    inflight = fetch(`/api/system-status${force ? '?force=1' : ''}`)
      .then(async r => {
        const j = await r.json()
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
        cache = { data: j, at: Date.now() }
        return j
      })
      .finally(() => { inflight = null })
  }
  return inflight
}

/** Only failures interrupt the user. Warnings live on the Status page. */
export const failures = (status) => (status?.checks || []).filter(c => c.state === 'fail')

export const STATE_META = {
  fail: { label: 'Broken', color: '#f87171', border: 'rgba(248,113,113,0.45)' },
  warn: { label: 'Needs attention', color: '#fbbf24', border: 'rgba(251,191,36,0.4)' },
  unknown: { label: 'Not run yet', color: '#94a3b8', border: 'var(--border)' },
  ok: { label: 'OK', color: '#34d399', border: 'rgba(52,211,153,0.35)' },
}
