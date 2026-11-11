// ─── Small honest arithmetic for the US VIX page ─────────────────────────────
//
// Nothing here forecasts anything. Each function turns a number the page
// already has into one a reader can use without doing the conversion in their
// head — and the freshness rows exist because, on 2026-11-03, the page showed
// four blocks with four different as-of dates (a 09:24 quote, closes through
// Nov 2, an assessment from Oct 30 and a CNN reading from Oct 26) without
// saying how far behind any of them was.

/** Share of values strictly below `x`, as a whole percent. */
export function percentileBelow(values, x) {
  const v = (values || []).filter(Number.isFinite)
  if (v.length < 2 || !Number.isFinite(x)) return null
  return Math.round((v.filter(n => n < x).length / v.length) * 100)
}

/**
 * The one-standard-deviation daily S&P 500 move VIX implies, in percent.
 *
 * VIX is quoted annualised; a trading day is 1/252 of a year, so the daily
 * figure is VIX / sqrt(252). This is the index's own definition restated, not a
 * prediction of the next move — VIX says nothing about direction.
 */
export function impliedDailyMovePct(vix) {
  return Number.isFinite(vix) && vix > 0 ? vix / Math.sqrt(252) : null
}

/** An instant as its New York calendar date; a plain date passes through. */
export function etDate(value) {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const d = new Date(value)
  if (!Number.isFinite(+d)) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

/** Sessions on the calendar after `date`. */
export function sessionsAfter(dates, date) {
  if (!date) return null
  return [...new Set(dates || [])].filter(d => d > date).length
}

// How many sessions each block may trail before that is news rather than how
// the source works. Today's close is not final until evening; HY OAS publishes
// about a session late and pins the whole assessment to its date.
const GRACE = { quote: 0, history: 1, severity: 2 }

/**
 * One row per block on the page: its date, how many sessions it trails, and
 * whether that is beyond its normal lag. The VIX history (including today's
 * provisional quote) is the session calendar.
 */
export function freshnessRows({ vix, severity, cnn }) {
  const dates = (vix?.series || []).map(p => p.date)
  const rows = []
  const add = (id, label, date, extra = {}) => {
    if (!date) return
    const behind = sessionsAfter(dates, date)
    rows.push({ id, label, date, behind, stale: extra.stale ?? behind > (GRACE[id] ?? 0), note: extra.note ?? null })
  }
  if (vix) {
    add('quote', 'VIX quote', vix.kind === 'daily-close' ? vix.asOf : etDate(vix.asOf))
    add('history', 'VIX daily closes', vix.historyAsOf)
  }
  if (severity) {
    const missing = severity.context?.waitingOn?.missing
    add('severity', 'Risk severity', severity.asOf, {
      note: missing?.length ? `waiting on ${missing.join(', ')}` : null,
    })
  }
  if (cnn) {
    add('cnn', 'CNN Fear & Greed', etDate(cnn.asOf), {
      // The backend owns this judgement: it knows CNN does not publish at weekends.
      stale: Boolean(cnn.stale),
      note: Number.isFinite(cnn.ageDays) ? `${cnn.ageDays} ${cnn.ageDays === 1 ? 'day' : 'days'} old` : null,
    })
  }
  return rows
}
