// ─── Does RRG rotation predict anything? ─────────────────────────────────────
//
// The chart invites a reading — a sector entering Leading is strong, one
// entering Lagging is weak, Improving comes before Leading — and until now the
// app has shown the picture without ever checking the reading. This module
// turns it into four claims that can be scored:
//
//   a sector ENTERS a quadrant (its completed-week point is in that quadrant
//   and was not in it the week before), and then over the next 4, 8 and 13
//   weeks it either beats its benchmark or does not.
//
// Entering Leading or Improving is the bullish claim; entering Weakening or
// Lagging is the warning. Measured as excess over the benchmark the RRG was
// drawn against, from the close of the entry week — the first price at which
// the entry was knowable.
//
// Rules that keep the count honest:
//
//   · Transitions, not states. A sector that sits in Leading for thirty weeks
//     fired once.
//   · Completed weeks only. The chart's last point is the week in progress;
//     a quadrant read off Tuesday is not that week's quadrant.
//   · A cooldown. A sector hovering on a boundary crosses it back and forth,
//     and each crossing is the same fact restated. An entry counts only if the
//     sector was outside that quadrant for the COOLDOWN_WEEKS before it.
//   · Distinct weeks are reported beside n. Sectors rotate together — when the
//     benchmark lurches, several cross in the same week for one reason — so n
//     overstates how much independent evidence there is, and the "is this
//     more than noise?" test below uses weeks, not firings.
//
// Nothing here fetches. Callers pass daily bars.

const { scoreSignal } = require('../signalScoring');
const { rrgSeries, resampleToWeekly, quadrantOf, weekComplete } = require('./series');
const { ruleFingerprint } = require('../signals/audit');

const COOLDOWN_WEEKS = 4;
const HORIZON_WEEKS = [4, 8, 13];
const HEADLINE_WEEKS = 8;
const MIN_N = 20;      // resolved firings before a direction is named at all
const MIN_WEEKS = 12;  // …spread over at least this many distinct weeks

const QUADRANTS = ['Leading', 'Weakening', 'Lagging', 'Improving'];
const DIRECTION = { Leading: 'bullish', Improving: 'bullish', Weakening: 'bearish', Lagging: 'bearish' };
const signalName = (market, quadrant) => `${market.toLowerCase()}_rrg_enter_${quadrant.toLowerCase()}`;

// Changes when the entry rule or the RRG arithmetic changes.
const RULE_VERSION = ruleFingerprint('rrg-rotation', [
  rrgSeries.toString(), quadrantOf.toString(), String(COOLDOWN_WEEKS),
]);

/**
 * Quadrant entries in one sector's series (completed weeks only, oldest
 * first). An entry needs COOLDOWN_WEEKS of history before it, all outside the
 * destination quadrant — so the first weeks of a series can never fire, which
 * is right: with no history, "entered" cannot be told from "was already in".
 */
function quadrantEntries(series, { cooldown = COOLDOWN_WEEKS } = {}) {
  const q = series.map(p => quadrantOf(p.rsRatio, p.rsMomentum));
  const out = [];
  for (let i = cooldown; i < series.length; i++) {
    if (q[i] === q[i - 1]) continue;
    let fresh = true;
    for (let k = 1; k <= cooldown; k++) if (q[i - k] === q[i]) { fresh = false; break; }
    if (!fresh) continue;
    out.push({ date: series[i].date, to: q[i], from: q[i - 1], rsRatio: series[i].rsRatio, rsMomentum: series[i].rsMomentum });
  }
  return out;
}

const round = (v, d = 2) => (v == null ? null : +v.toFixed(d));

/** scoreSignal's per-horizon stats, relabelled in weeks and rounded for display. */
function presentWeeks(stats) {
  return Object.entries(stats).map(([key, s]) => ({
    horizon: `${parseInt(key, 10)}w`,
    n: s.n, unresolved: s.unresolved,
    hitRatePct: round(s.hitRate == null ? null : s.hitRate * 100, 1),
    medianPct: round(s.medianPct), meanPct: round(s.meanPct),
    nExcess: s.nExcess,
    medianExcessPct: round(s.medianExcessPct), meanExcessPct: round(s.meanExcessPct),
    hitRateExcessPct: round(s.hitRateExcess == null ? null : s.hitRateExcess * 100, 1),
    medianMaxAdversePct: round(s.medianMaxAdversePct),
  }));
}

/**
 * The badge. Blunt on purpose:
 *   · below MIN_N resolved firings or MIN_WEEKS distinct weeks → "too few";
 *   · if the share that beat the benchmark is within what coin flips over
 *     that many WEEKS would produce → "no clear edge", in grey, whatever the
 *     median's sign. A +0.3% median on ninety clustered firings is not a
 *     finding, and green would say it was;
 *   · otherwise the median excess, with the bearish claims using the
 *     held / refuted states so a warning that worked is never painted the
 *     colour that means "beat the index".
 */
function headlineFor(rows, { direction, benchmark, weeks, source }) {
  const mid = rows.find(r => r.horizon === `${HEADLINE_WEEKS}w`) || rows[0];
  const provenance = source === 'reconstructed'
    ? 'Reconstructed: the RRG was rebuilt from stored daily prices and the entries found after the fact. Faithful — each week uses only earlier data — but not the same evidence as a row written the week it happened.'
    : 'Recorded the week it happened, before the outcome existed.';
  if (!mid || !mid.n) {
    return { state: 'no-data', text: 'No resolved entries yet', detail: `Nothing has fired long enough ago to have an outcome.\n\n${provenance}` };
  }
  if (mid.n < MIN_N || weeks < MIN_WEEKS) {
    return { state: 'thin', text: `n=${mid.n} — too few to judge`, detail: `${mid.n} resolved entries across ${weeks} distinct weeks. Needs ${MIN_N}+ entries over ${MIN_WEEKS}+ weeks before a direction means anything.\n\n${provenance}` };
  }
  const edge = mid.medianExcessPct;
  const beat = mid.hitRateExcessPct;
  // Short on purpose: four of these sit in a row, and on a phone a badge that
  // names the benchmark and horizon in full does not fit. The row's caption
  // carries those.
  const sign = `${edge > 0 ? '+' : ''}${edge}% (n=${mid.n})`;
  const measured = `Over the ${HEADLINE_WEEKS} weeks after entry, the median sector ${edge > 0 ? 'beat' : 'lagged'} ${benchmark} by ${Math.abs(edge)}%; ${beat}% of entries beat it. ${mid.n} resolved entries across ${weeks} distinct weeks.`;
  const others = rows.filter(r => r !== mid && r.n).map(r => `${r.horizon}: median ${r.medianExcessPct > 0 ? '+' : ''}${r.medianExcessPct}% (${r.hitRateExcessPct}% beat, n=${r.n})`).join(' · ');
  const tail = `${others ? `\n\nOther horizons — ${others}.` : ''}\n\n${provenance}`;

  // Two standard errors of a fair coin over `weeks` independent draws.
  const noise = 100 / Math.sqrt(weeks);
  if (Math.abs(beat - 50) < noise) {
    return { state: 'thin', text: `no clear edge (${edge > 0 ? '+' : ''}${edge}%, n=${mid.n})`, detail: `${measured}\n\nThat beat-rate is within ±${noise.toFixed(0)} points of a coin flip for ${weeks} independent weeks, so this is not distinguishable from chance.${tail}` };
  }
  if (direction === 'bearish') {
    const held = edge < 0;
    return { state: held ? 'held' : 'refuted', text: `${sign} — warning ${held ? 'held' : 'did not hold'}`, detail: `${measured}\n\nEntering this quadrant is read as a warning, so lagging ${benchmark} is the reading holding and beating it is the reading failing.${tail}` };
  }
  return { state: edge > 0 ? 'positive' : 'negative', text: sign, detail: `${measured}${tail}` };
}

/**
 * Score rotation for a universe.
 *
 * @param {Object<string, Array>} dailyBySymbol  daily bars per sector symbol
 * @param {Array} benchDaily                     the benchmark's daily bars
 * @param {Object} opts  { market, benchmark, now, labels, recorded }
 *   recorded: [{ signal, symbol, date }] rows read back from signal_emissions,
 *   scored separately and never pooled with the reconstruction.
 */
function scoreRotation(dailyBySymbol, benchDaily, { market = 'US', benchmark = 'SPY', now = new Date(), recorded = [] } = {}) {
  const done = (w) => weekComplete(w.date, now);
  const benchWeekly = resampleToWeekly(benchDaily).filter(done);
  const weeklyBySymbol = {};
  const entriesByQuadrant = Object.fromEntries(QUADRANTS.map(q => [q, []]));
  let firstWeek = null, lastWeek = null, sectors = 0;

  for (const [symbol, daily] of Object.entries(dailyBySymbol)) {
    const series = rrgSeries(daily, benchDaily).filter(done);
    if (!series.length) continue;
    sectors++;
    weeklyBySymbol[symbol] = resampleToWeekly(daily).filter(done);
    if (!firstWeek || series[0].date < firstWeek) firstWeek = series[0].date;
    if (!lastWeek || series[series.length - 1].date > lastWeek) lastWeek = series[series.length - 1].date;
    for (const e of quadrantEntries(series)) entriesByQuadrant[e.to].push({ symbol, ...e });
  }

  const build = (quadrant, emissions, source) => {
    const stats = scoreSignal(emissions, weeklyBySymbol, { horizons: HORIZON_WEEKS, benchmark: benchWeekly });
    const horizons = presentWeeks(stats);
    const resolved = emissions.filter(e => {
      const s = weeklyBySymbol[e.symbol];
      const i = s ? s.findIndex(b => b.date === e.date) : -1;
      return i >= 0 && i + HEADLINE_WEEKS < s.length;
    });
    const weeks = new Set(resolved.map(e => e.date)).size;
    return {
      signal: signalName(market, quadrant), quadrant, direction: DIRECTION[quadrant], source, ruleVersion: RULE_VERSION,
      firings: emissions.length, symbols: new Set(emissions.map(e => e.symbol)).size, weeks,
      firstFired: emissions.length ? emissions.map(e => e.date).sort()[0] : null,
      horizons,
      headline: headlineFor(horizons, { direction: DIRECTION[quadrant], benchmark, weeks, source }),
    };
  };

  const signals = [];
  for (const quadrant of QUADRANTS) {
    signals.push(build(quadrant, entriesByQuadrant[quadrant], 'reconstructed'));
    const name = signalName(market, quadrant);
    signals.push(build(quadrant, recorded.filter(r => r.signal === name), 'recorded'));
  }
  return {
    market, benchmark, ruleVersion: RULE_VERSION,
    params: { horizonWeeks: HORIZON_WEEKS, headlineWeeks: HEADLINE_WEEKS, cooldownWeeks: COOLDOWN_WEEKS, minN: MIN_N, minWeeks: MIN_WEEKS },
    coverage: { sectors, firstWeek, lastWeek },
    signals,
  };
}

/**
 * The entries of ONE completed week, for recording. `week` is its Friday.
 * Returns [] when that week is not the last completed one in the data — a
 * recorder must never write a week it is looking back on.
 */
function entriesForWeek(dailyBySymbol, benchDaily, week, { now = new Date() } = {}) {
  const out = [];
  for (const [symbol, daily] of Object.entries(dailyBySymbol)) {
    const series = rrgSeries(daily, benchDaily).filter(w => weekComplete(w.date, now));
    if (!series.length || series[series.length - 1].date !== week) continue;
    const last = quadrantEntries(series).filter(e => e.date === week);
    for (const e of last) out.push({ symbol, ...e, prev: series[series.length - 2] || null });
  }
  return out;
}

module.exports = {
  quadrantEntries, scoreRotation, entriesForWeek, headlineFor, signalName,
  QUADRANTS, DIRECTION, COOLDOWN_WEEKS, HORIZON_WEEKS, HEADLINE_WEEKS, MIN_N, MIN_WEEKS, RULE_VERSION,
};
