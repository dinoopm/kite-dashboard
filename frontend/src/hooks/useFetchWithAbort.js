import { useState, useEffect, useCallback, useRef } from 'react'

const DEFAULT_TIMEOUT_MS = 60_000

const backoffState = new Map()

export function getBackoffDelay(url) {
  const entry = backoffState.get(url)
  if (!entry) return 0
  const remaining = entry.until - Date.now()
  return remaining > 0 ? remaining : 0
}

function recordBackoff(url, retryAfterSeconds) {
  const entry = backoffState.get(url) || { attempts: 0, until: 0 }
  entry.attempts += 1
  const explicit = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0
  const exponential = Math.min(60_000, 2_000 * (2 ** (entry.attempts - 1)))
  entry.until = Date.now() + Math.max(explicit, exponential)
  backoffState.set(url, entry)
  return entry.until - Date.now()
}

function clearBackoff(url) {
  backoffState.delete(url)
}

function combineSignals(signals) {
  const valid = signals.filter(Boolean)
  if (valid.length === 0) return undefined
  if (valid.length === 1) return valid[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid)
  const controller = new AbortController()
  for (const s of valid) {
    if (s.aborted) { controller.abort(s.reason); break }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}

export async function fetchWithAbort(url, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = {}) {
  const cooldown = getBackoffDelay(url)
  if (cooldown > 0) {
    const err = new Error('rate_limited')
    err.name = 'RateLimitedError'
    err.retryAfter = cooldown
    throw err
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const composed = combineSignals([signal, timeoutSignal])
  const res = await fetch(url, { ...init, signal: composed })

  if (res.status === 429) {
    const headerVal = res.headers.get('Retry-After')
    const retryAfterSeconds = headerVal ? parseFloat(headerVal) : NaN
    const delay = recordBackoff(url, retryAfterSeconds)
    const err = new Error('rate_limited')
    err.name = 'RateLimitedError'
    err.retryAfter = delay
    err.status = 429
    throw err
  }

  if (res.ok) clearBackoff(url)

  return res
}

export function useFetchWithAbort(url, { deps = [], skip = false, parser = (r) => r.json() } = {}) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(!skip)
  const refetchTrigger = useRef(0)
  const [, force] = useState(0)

  const refetch = useCallback(() => {
    refetchTrigger.current += 1
    force((n) => n + 1)
  }, [])

  useEffect(() => {
    if (skip || !url) { setLoading(false); return }
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await fetchWithAbort(url, { signal: controller.signal })
        const json = await parser(res)
        if (active) { setData(json); setLoading(false) }
      } catch (e) {
        if (!active) return
        if (e.name === 'AbortError') return
        setError(e)
        setLoading(false)
      }
    })()
    return () => { active = false; controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, skip, ...deps, refetchTrigger.current])

  return { data, error, loading, refetch }
}
