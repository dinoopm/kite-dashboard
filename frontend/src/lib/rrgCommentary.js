// ─── Plain-language commentary for the Relative Rotation Graph ──────────────
//
// Reading an RRG tail means asking the same questions of every line: where is
// it, which way did it last move, how fast, did it cross a line, and has either
// axis just turned. This module answers them with arithmetic on the exact
// points the chart draws — same tail length, same scrub position — so the
// words can never disagree with the picture.
//
// It is deliberately DESCRIPTIVE. Textbook RRG reading says an Improving tail
// "should" rotate into Leading next. That is a claim about future prices, and
// rotation has no entry in backend/signals/registry.js, so no track record
// here. Every sentence is therefore past or present tense ("moved", "is
// sliding"), never "will". If rotation is ever registered and scored, the
// forecast belongs on its SignalScore badge, not in this prose.

export const QUADRANT_ORDER = ['Leading', 'Weakening', 'Lagging', 'Improving']

// One weekly step is noisy; two smooth it without lagging the picture much.
const HEADING_STEPS = 2
// A tail moving under a fifth of the group's typical step is described as
// holding still rather than given a direction it barely has.
const STILL_FRACTION = 0.2
// Pace compares the last two steps with the steps before them. 1.5x either
// way is the bar for calling it faster or slower — below that it is wobble.
const PACE_RATIO = 1.5
// Inside ~a third of the group's median distance from (100,100) a sector is
// moving roughly with the benchmark, and its quadrant label says little.
const NEAR_CENTRE_FRACTION = 0.35
// A crossing this recent is "fresh" in the summary.
const FRESH_WEEKS = 1

export function quadrantOf(rsRatio, rsMomentum) {
  if (rsRatio >= 100) return rsMomentum >= 100 ? 'Leading' : 'Weakening'
  return rsMomentum >= 100 ? 'Improving' : 'Lagging'
}

// The chart direction a step points in, as an 8-way compass word. Named by
// screen direction rather than "toward Leading", which reads as a forecast.
// Eight ways, not four: a tail moving straight up has a flat RS-Ratio, and a
// four-way compass would call that "up-right" and the headline would claim
// relative strength rose when it did not.
const COMPASS_8 = ['right', 'up-right', 'up', 'up-left', 'left', 'down-left', 'down', 'down-right']
export function compassOf(dx, dy) {
  const deg = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360
  return COMPASS_8[Math.round(deg / 45) % 8]
}

const dist = (a, b) => Math.hypot(b.rsRatio - a.rsRatio, b.rsMomentum - a.rsMomentum)
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// Counted back from the window's last week, which the panel header names — so
// "ago" stays true when the scrubber is parked in the past.
export const weeksAgoText = (w) => (w === 0 ? 'in the latest week' : `${plural(w, 'week')} ago`)

/** Mirrors RRGChart's getVisibleSeries (minus animation) so both read one window. */
export function tailWindow(series, tailLength, scrubEnd) {
  if (!Array.isArray(series) || series.length === 0) return { tail: [], endIdx: -1 }
  const endIdx = scrubEnd != null ? Math.min(scrubEnd, series.length - 1) : series.length - 1
  const startIdx = Math.max(0, endIdx - tailLength + 1)
  return { tail: series.slice(startIdx, endIdx + 1), endIdx }
}

/**
 * Consecutive points, counting back from endIdx, in the same quadrant. Uses
 * the whole series, not just the tail — "in Leading for 30 weeks" is the
 * useful fact even when the tail is 8 long. atLeast marks that the run hit the
 * start of the data, so the true figure may be longer.
 */
export function quadrantTenure(series, endIdx) {
  const q = quadrantOf(series[endIdx].rsRatio, series[endIdx].rsMomentum)
  let i = endIdx
  while (i > 0 && quadrantOf(series[i - 1].rsRatio, series[i - 1].rsMomentum) === q) i--
  return { count: endIdx - i + 1, atLeast: i === 0 }
}

/** Every quadrant change inside the tail, oldest first. weeksAgo counts from the tail's end. */
export function crossingsIn(tail) {
  const out = []
  for (let i = 1; i < tail.length; i++) {
    const from = quadrantOf(tail[i - 1].rsRatio, tail[i - 1].rsMomentum)
    const to = quadrantOf(tail[i].rsRatio, tail[i].rsMomentum)
    if (from !== to) out.push({ from, to, weeksAgo: tail.length - 1 - i })
  }
  return out
}

/**
 * Has this axis recently reversed? The current run of same-direction weekly
 * steps against the opposite run before it. Reported only while the new run
 * is young (≤ 3 weeks — after that it is simply the trend) and the old one
 * was a real run (≥ 2 weeks — one step back is a wiggle).
 *
 * A step under a fifth of the axis's median weekly move counts as flat and
 * breaks a run, so a 0.1-point tick after ten weeks of 0.6-point falls is not
 * announced as a turn.
 */
const TURN_MAX_NEW = 3
const TURN_MIN_OLD = 2
const FLAT_FRACTION = 0.2
const TURN_LOOKBACK = 26
export function axisTurn(series, endIdx, axis) {
  if (endIdx < 3) return null
  const diffs = []
  for (let i = Math.max(1, endIdx - TURN_LOOKBACK + 1); i <= endIdx; i++) diffs.push(series[i][axis] - series[i - 1][axis])
  const eps = FLAT_FRACTION * median(diffs.map(Math.abs))
  const dir = (d) => (Math.abs(d) <= eps ? 0 : Math.sign(d))
  let j = diffs.length - 1
  const s0 = dir(diffs[j])
  if (s0 === 0) return null
  let weeks = 0
  while (j >= 0 && dir(diffs[j]) === s0) { weeks++; j-- }
  let after = 0
  while (j >= 0 && dir(diffs[j]) === -s0) { after++; j-- }
  if (weeks > TURN_MAX_NEW || after < TURN_MIN_OLD) return null
  return { axis, dir: s0 > 0 ? 'up' : 'down', weeks, after }
}

/** Faster or slower than earlier in the tail. Needs two recent and two earlier steps. */
export function paceOf(tail) {
  if (tail.length < 5) return null
  const steps = tail.slice(1).map((p, i) => dist(tail[i], p))
  const recent = mean(steps.slice(-2))
  const earlier = mean(steps.slice(0, -2))
  if (earlier === 0) return recent > 0 ? 'accelerating' : 'steady'
  const r = recent / earlier
  return r >= PACE_RATIO ? 'accelerating' : r <= 1 / PACE_RATIO ? 'slowing' : 'steady'
}

// Headline by (where it is) × (which way it moved over the last two weeks),
// in plain words — no "axes", "momentum" or "relative strength". The chart
// already speaks RRG; the headline is for someone who doesn't.
//
// The vocabulary maps onto the two coordinates:
//   RS-Ratio ≥ 100      → "beating {B}"; below → "behind {B}".
//   RS-Ratio rising     → the lead grows / the gap closes; falling → the reverse.
//   RS-Momentum         → how fast that is happening. The backend computes it
//                         as RS-Ratio over its own moving average, so it acts
//                         as RS-Ratio's rate of change (the standard RRG
//                         reading), and a move where both coordinates go the
//                         same way (up-right, down-left) is "faster" (or
//                         "picking up speed"), and one where they split
//                         (down-right, up-left) is "but more slowly". A test
//                         holds every diagonal to that rule.
// Hand-written rather than generated, so each can be checked as English and as
// RRG. Diagonals depend on the quadrant ("Still beating" only makes sense in
// Weakening); straight moves (one coordinate flat) read the same in either
// quadrant on that side of 100, so they are keyed by side.
const HEADLINES = {
  'Leading:up-right': 'Beating {B}, and the lead is growing faster.',
  'Leading:down-right': 'Beating {B}; the lead is still growing, but more slowly.',
  'Leading:down-left': 'Beating {B}, but the lead is now shrinking, and faster.',
  'Leading:up-left': 'Beating {B}; the lead is shrinking, but more slowly.',
  'Weakening:up-right': 'Still beating {B}, and the lead is growing again, picking up speed.',
  'Weakening:down-right': 'Still beating {B}; the lead is growing, but more slowly.',
  'Weakening:down-left': 'Still beating {B}, but the lead is shrinking, and faster.',
  'Weakening:up-left': 'Still beating {B}; the lead is shrinking, but more slowly.',
  'Lagging:up-right': 'Behind {B}, but has started catching up, picking up speed.',
  'Lagging:down-right': 'Behind {B}; the gap is closing, but more slowly.',
  'Lagging:down-left': 'Behind {B}, and the gap is widening faster.',
  'Lagging:up-left': 'Behind {B}; the gap is still widening, but more slowly.',
  'Improving:up-right': 'Behind {B}, but closing the gap, and faster.',
  'Improving:down-right': 'Behind {B}; still closing the gap, but more slowly.',
  'Improving:down-left': 'Behind {B}; the catch-up has reversed and the gap is widening faster.',
  'Improving:up-left': 'Behind {B}; the gap is widening again, but more slowly.',
  'ahead:up': 'Beating {B}; the lead held steady while recent weeks picked up.',
  'ahead:down': 'Beating {B}; the lead held steady while recent weeks softened.',
  'ahead:right': 'Beating {B}, and the lead is growing at a steady pace.',
  'ahead:left': 'Beating {B}, but the lead is shrinking at a steady pace.',
  'behind:up': 'Behind {B}; the gap held steady while recent weeks picked up.',
  'behind:down': 'Behind {B}; the gap held steady while recent weeks softened.',
  'behind:right': 'Behind {B}, but closing the gap at a steady pace.',
  'behind:left': 'Behind {B}, and the gap is widening at a steady pace.',
}
const STILL_HEADLINES = {
  Leading: 'Beating {B}, with little change lately.',
  Weakening: 'Still beating {B}, with little change lately.',
  Lagging: 'Behind {B}, with little change lately.',
  Improving: 'Behind {B}, with little change lately.',
}
const sideOf = (quadrant) => (quadrant === 'Leading' || quadrant === 'Weakening' ? 'ahead' : 'behind')
export function headlineFor(quadrant, compass) {
  if (compass === 'still') return STILL_HEADLINES[quadrant]
  return HEADLINES[`${quadrant}:${compass}`] || HEADLINES[`${sideOf(quadrant)}:${compass}`]
}

/**
 * One sector's read. `group` carries the cross-sectional yardsticks
 * (typicalStep, typicalDistance) so "barely moving" and "near the centre"
 * scale with the universe — Indian sector indices sit within a few points of
 * 100 where US industry ETFs swing thirty.
 */
export function describeTail(series, { tailLength, scrubEnd = null, benchmark = 'the benchmark', group = {} } = {}) {
  const { tail, endIdx } = tailWindow(series, tailLength, scrubEnd)
  if (tail.length === 0) return null
  const latest = tail[tail.length - 1]
  const first = tail[0]
  const quadrant = quadrantOf(latest.rsRatio, latest.rsMomentum)
  const B = benchmark
  const fill = (s) => s.replaceAll('{B}', B)

  let heading = null
  if (tail.length >= 2) {
    const steps = Math.min(HEADING_STEPS, tail.length - 1)
    const from = tail[tail.length - 1 - steps]
    const dx = latest.rsRatio - from.rsRatio
    const dy = latest.rsMomentum - from.rsMomentum
    const perStep = Math.hypot(dx, dy) / steps
    const still = perStep === 0 || (group.typicalStep > 0 && perStep < STILL_FRACTION * group.typicalStep)
    heading = {
      compass: still ? 'still' : compassOf(dx, dy),
      // Screen angle in degrees, 0 = right, positive = counter-clockwise (up).
      angle: Math.atan2(dy, dx) * 180 / Math.PI,
      dx, dy, steps,
    }
  }

  const crossings = crossingsIn(tail)
  const lastCrossing = crossings.length ? crossings[crossings.length - 1] : null
  const tenure = quadrantTenure(series, endIdx)
  const turn = axisTurn(series, endIdx, 'rsMomentum') || axisTurn(series, endIdx, 'rsRatio')
  const pace = paceOf(tail)
  const distance = Math.hypot(latest.rsRatio - 100, latest.rsMomentum - 100)
  const nearCentre = group.typicalDistance > 0 && distance < NEAR_CENTRE_FRACTION * group.typicalDistance
  const weeks = tail.length - 1

  const headline = !heading
    ? fill(`${sideOf(quadrant) === 'ahead' ? 'Beating' : 'Behind'} {B} — only one week of data in this window.`)
    : fill(headlineFor(quadrant, heading.compass))

  const facts = []
  if (lastCrossing && lastCrossing.to === quadrant) {
    facts.push({ kind: 'crossing', text: `Moved from ${lastCrossing.from} into ${lastCrossing.to} ${weeksAgoText(lastCrossing.weeksAgo)}.` })
  } else {
    facts.push({ kind: 'tenure', text: `In ${quadrant} for ${tenure.atLeast ? `${tenure.count}+ weeks` : plural(tenure.count, 'week')}.` })
  }
  if (crossings.length >= 2) {
    const route = [crossings[0].from, ...crossings.map(c => c.to)].join(' → ')
    facts.push({ kind: 'route', text: `Path over ${plural(weeks, 'week')}: ${route}.` })
  }
  if (turn) {
    // Named as the card's stat rows name them, so the fact points at a number.
    const axisName = turn.axis === 'rsMomentum' ? 'Momentum' : 'RS-Ratio'
    const was = turn.dir === 'up' ? 'falling' : 'rising'
    const text = turn.weeks === 1
      ? `${axisName} turned ${turn.dir} in the latest week after ${was} for ${plural(turn.after, 'week')}.`
      : `${axisName} has ${turn.dir === 'up' ? 'risen' : 'fallen'} for ${turn.weeks} weeks after ${was} for ${plural(turn.after, 'week')}.`
    facts.push({ kind: 'turn', text })
  }
  // A still tail's headline already says it stopped; "slowed" would repeat it.
  if (pace === 'accelerating') facts.push({ kind: 'pace', text: 'Recent weekly moves on the chart are bigger than earlier ones.' })
  else if (pace === 'slowing' && heading?.compass !== 'still') facts.push({ kind: 'pace', text: 'Recent weekly moves on the chart are smaller than earlier ones.' })
  if (nearCentre) facts.push({ kind: 'centre', text: fill('Near the centre of the chart — doing about the same as {B}.') })

  return {
    quadrant, latest, first, weeks,
    delta: { rsRatio: latest.rsRatio - first.rsRatio, rsMomentum: latest.rsMomentum - first.rsMomentum },
    move: Math.hypot(latest.rsRatio - first.rsRatio, latest.rsMomentum - first.rsMomentum),
    distance, nearCentre, heading, pace, crossings, lastCrossing, tenure, turn,
    headline, facts, tail,
  }
}

/**
 * Commentary for every sector plus the cross-sectional summary. `sectors` is
 * the RRG payload's array ({ key, name, series }).
 */
export function buildRotationCommentary(sectors, { tailLength, scrubEnd = null, benchmark } = {}) {
  const usable = (sectors || []).filter(s => Array.isArray(s.series) && s.series.length > 0)
  // Yardsticks first: the group's median recent step and median distance.
  const recentSteps = []
  const distances = []
  for (const s of usable) {
    const { tail } = tailWindow(s.series, tailLength, scrubEnd)
    if (tail.length >= 2) {
      const k = Math.min(HEADING_STEPS, tail.length - 1)
      recentSteps.push(dist(tail[tail.length - 1 - k], tail[tail.length - 1]) / k)
    }
    const l = tail[tail.length - 1]
    distances.push(Math.hypot(l.rsRatio - 100, l.rsMomentum - 100))
  }
  const group = { typicalStep: median(recentSteps), typicalDistance: median(distances) }
  const reads = usable
    .map(s => {
      const read = describeTail(s.series, { tailLength, scrubEnd, benchmark, group })
      return read && { key: s.key, name: s.name, ...read }
    })
    .filter(Boolean)
  return { reads, group }
}

/** The at-a-glance numbers, over whichever reads the panel is showing. */
export function summarizeRotation(reads) {
  const counts = Object.fromEntries(QUADRANT_ORDER.map(q => [q, 0]))
  for (const r of reads) counts[r.quadrant]++
  const maxBy = (xs, f) => xs.reduce((best, x) => (best == null || f(x) > f(best) ? x : best), null)
  const leading = reads.filter(r => r.quadrant === 'Leading')
  const lagging = reads.filter(r => r.quadrant === 'Lagging')
  return {
    total: reads.length,
    counts,
    ahead: reads.filter(r => r.latest.rsRatio >= 100).length,
    // "Strongest" = furthest from the centre inside Leading, i.e. most ahead on both axes.
    strongest: maxBy(leading, r => r.distance),
    weakest: maxBy(lagging, r => r.distance),
    biggestMove: maxBy(reads.filter(r => r.weeks > 0), r => r.move),
    fresh: reads
      .filter(r => r.lastCrossing && r.lastCrossing.weeksAgo <= FRESH_WEEKS && r.lastCrossing.to === r.quadrant)
      .sort((a, b) => a.lastCrossing.weeksAgo - b.lastCrossing.weeksAgo),
  }
}

/**
 * Is the tail's last point a week still being traded? Weekly keys are the
 * Friday of the week, so a key on or after today means the bar is partial and
 * the dot will keep moving until the close.
 */
export function weekInProgress(dateKey, now = new Date()) {
  if (!dateKey) return false
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return String(dateKey).slice(0, 10) >= today
}

export const SORTS = {
  rotation: (a, b) => QUADRANT_ORDER.indexOf(a.quadrant) - QUADRANT_ORDER.indexOf(b.quadrant) || b.distance - a.distance,
  movers: (a, b) => b.move - a.move,
  recent: (a, b) => (a.lastCrossing?.weeksAgo ?? Infinity) - (b.lastCrossing?.weeksAgo ?? Infinity) || b.move - a.move,
}
