import { useEffect, useState } from 'react'

// Track-record lookup for a registry signal. Split out of SignalScore.jsx so
// that file exports only a component (fast refresh) and so any other view can
// read a signal's record without rendering the badge.
//
// One fetch per page load, shared by every caller on it. The endpoint is cached
// server-side for an hour, so this is mostly about not firing twenty identical
// requests when twenty signals are on screen.
let cache = null
let inflight = null

export function loadScorecard() {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetch('/api/signals/scorecard')
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

/** The scored entry for one registry signal, or null while loading / on error. */
export function useSignalScore(signalName, { source } = {}) {
  const [state, setState] = useState({ entry: null, error: null, loading: true })

  useEffect(() => {
    let on = true
    loadScorecard()
      .then(j => {
        if (!on) return
        const matches = (j.signals || []).filter(s => s.signal === signalName)
        // Prefer recorded evidence when a signal has both — it was written
        // before the outcome existed, which reconstruction can never claim.
        const entry = (source && matches.find(s => s.source === source))
          || matches.find(s => s.source === 'recorded')
          || matches[0]
          || null
        setState({ entry, error: null, loading: false })
      })
      .catch(e => { if (on) setState({ entry: null, error: e.message, loading: false }) })
    return () => { on = false }
  }, [signalName, source])

  return state
}
