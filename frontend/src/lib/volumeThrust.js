// ─── Relative volume for the signal chart ────────────────────────────────────
//
// MIRRORS the `volume_thrust` detector in backend/signals/registry.js, the same
// way volMath.js mirrors lib/volatility.js — duplicated because the backend is
// CommonJS and this is an ES module.
//
// The duplication has teeth here in a way the volatility one does not. The
// chart puts a track-record badge next to these bars, and that badge reports
// the record of the BACKEND detector, scored from signal_emissions. If the two
// rules drift apart the badge starts describing a different signal than the one
// on screen — a worse failure than having no badge at all, because it looks
// like evidence. Change both, or neither.

export const THRUST_MULT = 2   // volume multiple of the 20-day baseline
export const AVG_PERIOD = 20   // baseline length, ending at the PREVIOUS bar
export const MIN_BARS = 22     // registry `minBars` for volume_thrust

/**
 * Per-bar volume statistics for an ascending OHLCV series.
 *
 * @returns {{volumes:number[], avg:(number|null)[], ratio:(number|null)[],
 *            elevated:boolean[], thrust:boolean[]}}
 *
 * Whether the instrument trades at all is not asked here — lib/volume.js's
 * hasTradedVolume already owns that question, and two ways to ask it would
 * eventually disagree.
 *
 * `elevated` is every bar that meets the bar (≥ THRUST_MULT × baseline, close
 * up). `thrust` is the subset that actually FIRES: the first such bar of a run.
 * Both are returned because the chart draws them differently — the distinction
 * between "heavy volume again today" and "a new call" is the thing most volume
 * panels blur, and it is the whole reason the backend records one row per run
 * rather than one per day.
 */
export function volumeStats(bars) {
  const n = bars.length
  const volumes = bars.map(b => (b.volume == null ? 0 : b.volume))

  // Prefix sums, so the baseline is the 20 bars ENDING AT i-1 — identical
  // arithmetic to buildSeries' vol20avg, current bar deliberately excluded.
  const prefix = new Array(n + 1).fill(0)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + volumes[i]
  const avg = new Array(n).fill(null)
  for (let i = AVG_PERIOD; i < n; i++) avg[i] = (prefix[i] - prefix[i - AVG_PERIOD]) / AVG_PERIOD

  const ratio = avg.map((a, i) => (a != null && a > 0 ? volumes[i] / a : null))

  const elevated = new Array(n).fill(false)
  for (let i = 1; i < n; i++) {
    elevated[i] = ratio[i] != null && ratio[i] >= THRUST_MULT && bars[i].close > bars[i - 1].close
  }

  // Below MIN_BARS the backend detector is not evaluated at all, so marking a
  // bar here would show a firing the scorecard has no row for.
  const thrust = new Array(n).fill(false)
  for (let i = MIN_BARS; i < n; i++) thrust[i] = elevated[i] && !elevated[i - 1]

  return { volumes, avg, ratio, elevated, thrust }
}

// Confirmation window for a golden cross, mirroring CONFIRM_WINDOW in
// backend/signals/registry.js. Zero would be too strict to mean anything: a
// 50-bar SMA turns days after the buying that moved it, so demanding the heavy
// day land exactly on the crossover bar would mostly measure SMA lag.
export const CONFIRM_WINDOW = 5

/**
 * Index of the most recent bar within `window` sessions of `i` that met the
 * volume bar, or -1.
 *
 * Reads `elevated`, not `thrust`: the run guard exists to stop one episode
 * being RECORDED four times, but for confirmation the question is only whether
 * heavy demand volume showed up recently, and the second day of a heavy run
 * answers that as well as the first.
 */
export function confirmedAt(stats, i, window = CONFIRM_WINDOW) {
  for (let k = i; k >= Math.max(1, i - window); k--) if (stats.elevated[k]) return k
  return -1
}
