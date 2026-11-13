// ─── Words for the Money Flow history strip ─────────────────────────────────
//
// The backend replays the regime for the last 60 completed sessions and says
// when the current word began (riskRegime.js: regimeHistory / sinceFor). This
// turns that into the one line the panel shows, so "it was risk-off before"
// is answered on the panel rather than by asking.

const fmtDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const sessionsText = (n) => `${n} session${n === 1 ? '' : 's'}`

/** "NEUTRAL since 13 Nov — RISK-OFF before that, 22 Oct – 12 Nov (16 sessions)." */
export function sinceText(since, historyLength) {
  if (!since) return null
  const prev = since.previous
  const before = prev
    ? `${prev.label} before that, ${prev.from === prev.to ? fmtDay(prev.from) : `${fmtDay(prev.from)} – ${fmtDay(prev.to)}`} (${sessionsText(prev.sessions)}).`
    : ''
  if (since.since == null) {
    // Today's live read differs from the last settled session: it changed
    // today, and no completed session carries it yet.
    return `${since.label} as of today's live read${prev ? ` — ${before}` : '.'}`
  }
  if (since.atLeast) return `${since.label} for all of the last ${sessionsText(historyLength)}.`
  return `${since.label} since ${fmtDay(since.since)}${prev ? ` — ${before}` : '.'}`
}

/** How many times the word changed across the strip — its twitchiness, shown, not hidden. */
export function changesIn(history) {
  let n = 0
  for (let i = 1; i < (history?.length || 0); i++) if (history[i].label !== history[i - 1].label) n++
  return n
}

const signed = (v, d = 1) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`)

/** One cell's tooltip: the date, the word, and the three readings behind it. */
export function cellTitle(h) {
  return `${fmtDay(h.date)} · ${h.label}\n10Y ${h.yield?.toFixed(2)}% (${signed(h.yield1mo, 2)}pp in a month) · S&P vs Treasuries ${signed(h.spyTlt1mo)}pp · junk vs IG ${signed(h.hygLqd1mo)}pp`
}

export { fmtDay }
