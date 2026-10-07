import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchWithAbort } from './useFetchWithAbort'
import { buildIndexComparison } from '../lib/indexComparison'
import { fetchUsComparisonBars, US_COMPARISON_INDICES } from '../lib/usIndexComparison'
import { comparisonStockDefinition } from '../lib/comparisonStock'

const EMPTY_STATES = {}

export default function useUsIndexComparison(data, range, symbol, extended) {
  const [selectedIndices, setSelected] = useState([])
  const [stockEnabled, setStockEnabled] = useState(false)
  const [stock, setStock] = useState(null)
  const indices = useMemo(() => {
    const custom = comparisonStockDefinition(stock, 'US')
    return custom ? [...US_COMPARISON_INDICES, custom] : US_COMPARISON_INDICES
  }, [stock])
  const selected = useMemo(() => stockEnabled && stock && stock.symbol !== symbol ? [...selectedIndices, 'comparisonStock'] : selectedIndices, [selectedIndices, stockEnabled, stock, symbol])
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState({ context: null, states: {} })
  const cache = useRef(new Map())
  const selectionKey = selected.join(',')
  const sessionKey = range === '1D' && extended ? 'extended' : 'regular'
  const context = `${symbol}/${range}/${sessionKey}/${stock?.symbol || ''}`

  useEffect(() => {
    const ids = selectionKey.split(',').filter(Boolean)
    if (!ids.length) return
    const controller = new AbortController()
    const cacheKey = id => `${indices.find(index => index.id === id).symbol}/${range}/${sessionKey}`
    const ttl = range === '1D' ? 60_000 : 10 * 60_000
    let states = Object.fromEntries(ids.map(id => {
      const hit = cache.current.get(cacheKey(id))
      return [id, hit && Date.now() - hit.at < ttl ? { bars: hit.bars } : { loading: true }]
    }))
    setResult({ context, states })
    const update = (id, state) => {
      if (controller.signal.aborted) return
      states = { ...states, [id]: state }
      setResult({ context, states })
    }
    // Only selected proxies are requested. Individual errors leave the stock
    // and any other successfully loaded comparison usable.
    for (const index of indices.filter(index => ids.includes(index.id) && !states[index.id].bars)) {
      fetchUsComparisonBars(index.symbol, range, sessionKey === 'extended', { fetcher: fetchWithAbort, signal: controller.signal })
        .then(bars => {
          if (controller.signal.aborted) return
          cache.current.set(cacheKey(index.id), { bars, at: Date.now() })
          update(index.id, { bars })
        })
        .catch(error => {
          if (controller.signal.aborted) return
          update(index.id, { error: error.name === 'RateLimitedError' ? 'Rate limited. Please wait before retrying.' : error.message })
        })
    }
    return () => controller.abort()
  }, [selectionKey, range, sessionKey, context, attempt, indices])

  const states = result.context === context ? result.states : EMPTY_STATES
  const comparison = useMemo(() => buildIndexComparison(data, Object.fromEntries(
    selected.filter(id => states[id]?.bars).map(id => [id, states[id].bars])
  ), range === '1D'), [data, selected, states, range])
  return { selected, states, comparison, indices,
    stock: { market: 'US', exclude: symbol, instrument: stock, enabled: stockEnabled, choose: setStock, toggle: () => setStockEnabled(value => !value) },
    toggle: id => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]),
    retry: () => setAttempt(current => current + 1),
  }
}
