import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchWithAbort } from './useFetchWithAbort'
import { buildIndexComparison, COMPARISON_INDICES, parseKiteResponse } from '../lib/indexComparison'
import { comparisonStockDefinition } from '../lib/comparisonStock'

const EMPTY_STATES = {}

export default function useIndexComparison(data, timeframe, token) {
  const [selectedIndices, setSelected] = useState([])
  const [stockEnabled, setStockEnabled] = useState(false)
  const [stock, setStock] = useState(null)
  const indices = useMemo(() => {
    const custom = comparisonStockDefinition(stock, 'IN')
    return custom ? [...COMPARISON_INDICES, custom] : COMPARISON_INDICES
  }, [stock])
  const selected = useMemo(() => stockEnabled && stock && String(stock.token) !== String(token) ? [...selectedIndices, 'comparisonStock'] : selectedIndices, [selectedIndices, stockEnabled, stock, token])
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState({ context: null, states: {} })
  const cache = useRef(new Map())
  const selectionKey = selected.join(',')
  const context = `${token}/${timeframe}/${stock?.token || ''}`
  useEffect(() => {
    const ids = selectionKey.split(',').filter(Boolean)
    if (!ids.length) return
    const controller = new AbortController()
    const cacheKey = id => `${indices.find(index => index.id === id).token || id}/${timeframe}`
    let states = Object.fromEntries(ids.map(id => [id, cache.current.has(cacheKey(id))
      ? { bars: cache.current.get(cacheKey(id)) } : { loading: true }]))
    setResult({ context, states })
    const update = (id, state) => {
      if (controller.signal.aborted) return
      states = { ...states, [id]: state }
      setResult({ context, states })
    }
    const pending = indices.filter(index => ids.includes(index.id) && !states[index.id].bars)
    if (pending.length) (async () => {
      try {
        let quotes = {}
        let quoteFailed = false
        const quoteNeeded = pending.filter(index => !index.token)
        if (quoteNeeded.length) {
          try {
            const response = await fetchWithAbort('/api/quotes', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ instruments: quoteNeeded.map(index => index.key) }), signal: controller.signal,
            })
            const payload = await response.json()
            if (!response.ok) throw new Error(payload.error || `Index quotes failed (${response.status})`)
            quotes = parseKiteResponse(payload)
          } catch (error) {
            if (controller.signal.aborted) return
            quoteFailed = true
            for (const index of quoteNeeded) update(index.id, { error: error.name === 'RateLimitedError' ? 'Rate limited. Please wait before retrying.' : error.message })
          }
        }
        // Fetch sequentially to avoid bursting Kite's historical-data limit.
        for (const index of pending) {
          if (controller.signal.aborted) return
          if (quoteFailed && !index.token) continue
          try {
            const indexToken = index.token || quotes[index.key]?.instrument_token
            if (!indexToken) throw new Error('Index token unavailable')
            const res = await fetchWithAbort(`/api/historical/${indexToken}?tf=${encodeURIComponent(timeframe)}`, { signal: controller.signal })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || `Comparison history failed (${res.status})`)
            const bars = parseKiteResponse(json)
            if (!Array.isArray(bars) || !bars.length) throw new Error('No comparison history for this timeframe')
            if (controller.signal.aborted) return
            cache.current.set(cacheKey(index.id), bars)
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
  }, [selectionKey, timeframe, attempt, context, indices])

  const states = result.context === context ? result.states : EMPTY_STATES
  const comparison = useMemo(() => buildIndexComparison(data, Object.fromEntries(
    selected.filter(id => states[id]?.bars).map(id => [id, states[id].bars])
  ), timeframe === '1D'), [data, selected, states, timeframe])
  return { selected, states, comparison, indices,
    stock: { market: 'IN', exclude: token, instrument: stock, enabled: stockEnabled, choose: setStock, toggle: () => setStockEnabled(value => !value) },
    toggle: id => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]),
    retry: () => setAttempt(current => current + 1),
  }
}
