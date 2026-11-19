import { useState, useEffect } from 'react'
import { fetchWithAbort } from './useFetchWithAbort'

// Fetches the strategy registry once. Shared by the Instrument tab and the
// basket page so both render the same schema-driven controls.
export function useStrategies() {
  const [strategies, setStrategies] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      try {
        const res = await fetchWithAbort('/api/backtest/strategies', { signal: controller.signal })
        const data = await res.json()
        if (Array.isArray(data?.strategies)) setStrategies(data.strategies)
        else setError('Failed to load strategies')
      } catch (e) {
        if (e.name === 'AbortError') return
        setError(e.message)
      }
    })()
    return () => controller.abort()
  }, [])
  return { strategies, error }
}
