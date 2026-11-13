// ─── US prices outside the regular session ──────────────────────────────────
//
// Alpaca's daily bar does not roll until the regular session opens. Before the
// open on Friday, "the latest bar" is Thursday's and its "previous close" is
// Wednesday's. Anything priced off Friday's pre-market prints therefore has to
// use Thursday's close as its baseline, or it counts two days as one.

import { etDate } from './vixPage.js'

/** The close an intraday view's return should be measured from. */
export function intradayBase(bars, quote) {
  if (!bars?.length) return null
  const session = etDate(bars[bars.length - 1].date)
  if (quote?.barDate && session > quote.barDate) return quote.last ?? null
  return quote?.prevClose ?? null
}

const SESSION_LABEL = { 'pre-market': 'Pre-market', 'after-hours': 'After hours' }
const FEED_NOTE = { delayed_sip: '15-min delayed', yahoo: 'Yahoo' }

/**
 * The out-of-hours column a table needs; null during the regular session, when
 * it would be a column of dashes. Pre-market takes the name as soon as any row
 * has it: before the open, a thin name's newest print can still be last night's.
 */
export function extendedColumn(rows) {
  const sessions = (rows ?? []).map(r => r.ext?.session).filter(Boolean)
  if (!sessions.length) return null
  const session = sessions.includes('pre-market') ? 'pre-market' : sessions[0]
  return { session, label: SESSION_LABEL[session] ?? session }
}

/**
 * The print a row shows in that column: null when the row's newest print is
 * from the other session (last night's after-hours under a Pre-market header
 * is not a pre-market price). Sorting goes through this too, so a column is
 * never ordered by numbers it is showing as dashes.
 */
export function extendedFor(row, column) {
  return column && row?.ext?.session === column.session ? row.ext : null
}

/** How to describe an out-of-hours print; null when there is none. */
export function extendedQuoteLine(extended, now = new Date()) {
  if (!extended) return null
  const at = new Date(extended.asOf)
  const time = at.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
  // Friday's last print is still the newest one on Sunday, and should say so.
  const day = etDate(extended.asOf) === etDate(now.toISOString())
    ? ''
    : `${at.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' })} `
  return {
    label: SESSION_LABEL[extended.session] ?? extended.session,
    when: `${day}${time} ET`,
    note: FEED_NOTE[extended.feed] ?? null,
  }
}
