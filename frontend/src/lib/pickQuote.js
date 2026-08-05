// ─── Choosing which exchange's quote to show ─────────────────────────────────
//
// A stock listed on both NSE and BSE has two order books, two previous closes
// and two instrument tokens. CGPOWER on 2026-08-03 closed at 826.10 on NSE and
// 850.00 on BSE — a 2.8% gap — while trading within 5 paise of the same price
// the next day. Quote the wrong book and the day's change is wrong by 3
// percentage points even though every number involved is real.
//
// A dozen places navigate to the instrument page (search, the basket table,
// alerts, peers, the journal, the RRG chart) and most cannot know which venue
// the user means. Asking each caller to pass an exchange failed exactly the way
// that always fails: the callers that were not updated kept being wrong, and
// silently.
//
// So the venue is derived from the token instead. Kite issues a distinct
// instrument_token per exchange, so the token already in the URL identifies the
// right book with no caller cooperation at all.

/**
 * The instrument keys worth asking for. Deduplicated, preferred venue first.
 * Both venues are requested because the caller's hint may be absent or wrong.
 */
export function quoteCandidates(symbol, exchange = 'NSE') {
  if (!symbol) return []
  const preferred = `${String(exchange || 'NSE').toUpperCase()}:${symbol}`
  return [...new Set([preferred, `NSE:${symbol}`, `BSE:${symbol}`])]
}

/**
 * Pick the quote that belongs to `token`.
 *
 * Order of preference, and each step exists for a reason:
 *   1. token match      — authoritative; the token IS the venue
 *   2. the hinted key   — for pages reached with an exchange but no real token
 *   3. anything present — so a link with neither still renders a price rather
 *                         than an empty card, which is what used to happen to
 *                         SIGMAADV: its instrument is SIGMAADV-BE, so the
 *                         NSE:SIGMAADV lookup returned nothing at all
 *
 * @param {Object} quotes  Kite's response, keyed "EXCHANGE:SYMBOL"
 * @param {Object} opts    { token, quoteKey }
 * @returns the chosen quote object, or null when there is nothing to show
 */
export function pickQuote(quotes, { token, quoteKey } = {}) {
  if (!quotes || typeof quotes !== 'object') return null
  const values = Object.values(quotes).filter(Boolean)
  if (!values.length) return null

  // Token 0 is the app's "unknown instrument" placeholder, not a real token.
  if (token != null && String(token) !== '0' && String(token) !== '') {
    const byToken = values.find(q => String(q?.instrument_token) === String(token))
    if (byToken) return byToken
  }
  if (quoteKey && quotes[quoteKey]) return quotes[quoteKey]
  return values[0]
}

/** Day change from a Kite quote, or null when the previous close is unusable. */
export function dayChangeFrom(quote) {
  const last = quote?.last_price
  const prev = quote?.ohlc?.close
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return null
  return { change: +(last - prev).toFixed(2), changePct: +(((last - prev) / prev) * 100).toFixed(2) }
}
