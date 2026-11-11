// ─── Relative volume for the instrument volume pane ─────────────────────────
//
// "Is today's volume high?" only has an answer relative to what THIS instrument
// normally trades, and only against bars of the same kind. Everything here is
// built on volumeStats from ./volumeThrust, which mirrors the registered
// `volume_thrust` detector — so a bar this pane calls heavy is measured with
// the same baseline (the 20 bars ending the bar BEFORE) as the bars the
// scorecard has rows for. No new threshold is introduced: brightness is
// continuous, and the only line drawn is the registered 2x.
//
// It replaces arithmetic that was wrong: the pane divided every bar by a
// single average of the last 20 bars of the whole series, so hovering a May
// bar compared it with November.

import { volumeStats, THRUST_MULT, AVG_PERIOD } from './volumeThrust.js'

const DAY_MS = 864e5

/**
 * The bars' interval, from the median gap between them. Weekends make a
 * daily series' gaps 1 or 3 days; the median stays 1.
 */
export function barInterval(data) {
  if (!Array.isArray(data) || data.length < 3) return null
  const t = data.map(d => Date.parse(d.date)).filter(Number.isFinite)
  if (t.length < 3) return null
  const gaps = t.slice(1).map((x, i) => (x - t[i]) / DAY_MS).sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  return median < 0.8 ? 'intraday' : median < 3.5 ? 'daily' : 'weekly'
}

/**
 * Per-bar ratio to its own trailing average, heavy flags at the registered
 * multiple, and a one-line summary of the latest bar.
 */
export function relativeVolume(data) {
  const s = volumeStats(data || [])
  const n = s.ratio.length
  const heavy = s.ratio.map(r => r != null && r >= THRUST_MULT)
  const ranked = s.ratio.filter(r => r != null)
  const lastRatio = n ? s.ratio[n - 1] : null
  const latest = lastRatio == null ? null : {
    ratio: lastRatio,
    heavy: heavy[n - 1],
    // Busier than this share of the OTHER measured bars in view.
    pctBusier: ranked.length > 1
      ? Math.round((ranked.slice(0, -1).filter(r => r < lastRatio).length / (ranked.length - 1)) * 100)
      : null,
  }
  return { avg: s.avg, ratio: s.ratio, heavy, thrust: s.thrust, latest, measured: ranked.length, period: AVG_PERIOD, mult: THRUST_MULT }
}

/** Bar brightness from its ratio: faint below average, solid at the registered multiple. */
export function barOpacity(ratio) {
  if (ratio == null) return 0.45
  if (ratio <= 1) return Math.max(0.25, 0.4 * ratio)
  return Math.min(1, 0.4 + (0.6 * (ratio - 1)) / (THRUST_MULT - 1))
}

// The regular session close per market. Daily bars for today exist before it,
// and their volume is still accumulating.
const SESSION = {
  US: { tz: 'America/New_York', closeMinutes: 16 * 60 },
  IN: { tz: 'Asia/Kolkata', closeMinutes: 15 * 60 + 30 },
}

function partsIn(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(x => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) }
}

/** True when the last bar is today's session and that session has not closed. */
export function sessionInProgress(lastDate, now = new Date(), market = 'IN') {
  const s = SESSION[market] || SESSION.IN
  const bar = new Date(lastDate)
  if (!Number.isFinite(+bar)) return false
  const at = partsIn(s.tz, now)
  return partsIn(s.tz, bar).day === at.day && at.minutes < s.closeMinutes
}
