import { useEffect, useState } from 'react'

// Track-record lookup for a registry signal. Split out of SignalScore.jsx so
// that file exports only a component (fast refresh) and so any other view can
// read a signal's record without rendering the badge.
//
// One fetch per market per page load. India's scorecard and the US one are
// different endpoints measured on different prices; keeping them in one cache
// would let a badge read the wrong market's numbers.
const ENDPOINT = { IN: '/api/signals/scorecard', US: '/api/us/stock-picks/scorecard' }
const cache = {}
const inflight = {}

export function loadScorecard(market = 'IN') {
  const url = ENDPOINT[market] || ENDPOINT.IN
  if (cache[url]) return Promise.resolve(cache[url])
  if (!inflight[url]) {
    inflight[url] = fetch(url)
      .then(async r => {
        const j = await r.json()
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
        cache[url] = j
        return j
      })
      .finally(() => { delete inflight[url] })
  }
  return inflight[url]
}

/** The scored entry for one registry signal, or null while loading / on error. */
export function useSignalScore(signalName, { source, market = 'IN' } = {}) {
  const [state, setState] = useState({ entry: null, error: null, loading: true })

  useEffect(() => {
    let on = true
    loadScorecard(market)
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
  }, [signalName, source, market])

  return state
}
