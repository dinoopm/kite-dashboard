import { useEffect, useState } from 'react'

// ─── Fetch JSON for a URL, keyed to that URL ─────────────────────────────────
//
// The same dozen lines were written by hand in thirteen places: when the URL
// changes, reset loading / error / data to their empty values, then fetch,
// then set the result. React's newer lint rules flag the reset because it is
// a setState inside an effect, which renders twice for every change — and
// each copy had drifted slightly (some treated an HTTP error as data).
//
// Here nothing is reset. The result is stored WITH the URL it answers, and
// read back only if it matches the URL being asked for now: a new URL simply
// has no matching result yet, which is exactly "loading". A late response for
// an old URL is ignored, so a quick symbol switch can never show the previous
// symbol's numbers.
//
// readResult is the pure half, so the rule is tested (useFetchJson.test.js).

/**
 * What the caller sees for `url`, given the last stored result.
 *   loading  true until a result for THIS url has arrived
 *   data     the parsed body, or null
 *   error    a message, or null
 * A null / empty url means "not asked": not loading, no data.
 */
export function readResult(stored, url) {
  if (!url) return { data: null, error: null, loading: false }
  if (!stored || stored.url !== url) return { data: null, error: null, loading: true }
  return { data: stored.data, error: stored.error, loading: false }
}

/**
 * How a response becomes a stored result. An HTTP error, or a body carrying an
 * `error` field (the backend's convention), is an error with that message.
 * Pure, so it is tested alongside readResult.
 */
export function toResult(url, { ok, status, body }) {
  if (body && typeof body === 'object' && body.error) return { url, data: null, error: String(body.error) }
  if (!ok) return { url, data: null, error: `HTTP ${status}` }
  return { url, data: body ?? null, error: null }
}

/** `timeoutMs`, if given, aborts a request that takes longer; it then reports an error. */
export function useFetchJson(url, { timeoutMs = null } = {}) {
  const [stored, setStored] = useState(null)

  useEffect(() => {
    if (!url) return undefined
    let on = true
    fetch(url, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined)
      .then(async r => {
        let body = null
        try { body = await r.json() } catch { /* a non-JSON body: no data */ }
        return toResult(url, { ok: r.ok, status: r.status, body })
      })
      .catch(e => ({ url, data: null, error: e.message || 'request failed' }))
      .then(result => { if (on) setStored(result) })
    return () => { on = false }
  }, [url, timeoutMs])

  return readResult(stored, url)
}
