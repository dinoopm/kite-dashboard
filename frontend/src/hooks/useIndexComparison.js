import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchWithAbort } from './useFetchWithAbort'
import { buildIndexComparison, COMPARISON_INDICES, parseKiteResponse } from '../lib/indexComparison'

const EMPTY_STATES = {}

export default function useIndexComparison(data, timeframe, token) {
  const [selected, setSelected] = useState([])
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState({ timeframe: null, states: {} })
  const cache = useRef(new Map())
  const selectionKey = selected.join(',')
  useEffect(() => {
    const ids = selectionKey.split(',').filter(Boolean)
    if (!ids.length) return
    const controller = new AbortController()
    let states = Object.fromEntries(ids.map(id => [id, cache.current.has(`${id}/${timeframe}`)
      ? { bars: cache.current.get(`${id}/${timeframe}`) } : { loading: true }]))
    setResult({ timeframe, states })
    const update = (id, state) => {
      if (controller.signal.aborted) return
      states = { ...states, [id]: state }
      setResult({ timeframe, states })
    }
    const pending = COMPARISON_INDICES.filter(index => ids.includes(index.id) && !states[index.id].bars)
    if (pending.length) (async () => {
      try {
        const response = await fetchWithAbort('/api/quotes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruments: pending.map(index => index.key) }), signal: controller.signal,
        })
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error || `Index quotes failed (${response.status})`)
        const quotes = parseKiteResponse(payload)
        // Fetch sequentially to avoid bursting Kite's historical-data limit.
        for (const index of pending) {
          if (controller.signal.aborted) return
          try {
            const indexToken = quotes[index.key]?.instrument_token
            if (!indexToken) throw new Error('Index token unavailable')
            const res = await fetchWithAbort(`/api/historical/${indexToken}?tf=${encodeURIComponent(timeframe)}`, { signal: controller.signal })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || `Index history failed (${res.status})`)
            const bars = parseKiteResponse(json)
            if (!Array.isArray(bars) || !bars.length) throw new Error('No index history for this timeframe')
            if (controller.signal.aborted) return
            cache.current.set(`${index.id}/${timeframe}`, bars)
            update(index.id, { bars })
          } catch (error) {
            if (controller.signal.aborted) return
            update(index.id, { error: error.name === 'RateLimitedError' ? 'Rate limited. Please wait before retrying.' : error.message })
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return
        for (const index of pending) update(index.id, { error: error.name === 'RateLimitedError' ? 'Rate limited. Please wait before retrying.' : error.message })
      }
    })()
    return () => controller.abort()
  }, [selectionKey, timeframe, attempt, token])

  const states = result.timeframe === timeframe ? result.states : EMPTY_STATES
  const comparison = useMemo(() => buildIndexComparison(data, Object.fromEntries(
    selected.filter(id => states[id]?.bars).map(id => [id, states[id].bars])
  ), timeframe === '1D'), [data, selected, states, timeframe])
  return { selected, states, comparison,
    toggle: id => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]),
    retry: () => setAttempt(current => current + 1),
  }
}
