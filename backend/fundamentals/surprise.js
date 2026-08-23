// ─── Beat/miss and estimate revisions ────────────────────────────────────────
//
// The forward-only half of the earnings work, and the half most able to lie.
//
// Yahoo exposes only the CURRENT consensus. A consensus read after a result has
// landed has already absorbed it, so scoring against one manufactures a perfect
// forecast out of nothing — and the pre-announcement figure for a past quarter
// is not recoverable from any source this app can reach. That is the same
// limitation, and the same conclusion, as analyst_target_upside in
// BLOCKED_SIGNALS: it can only be recorded forward, never reconstructed.
//
// So everything here is built to refuse. A backfilled row has no landing date
// worth the name, a snapshot dated the day of the announcement is not
// pre-announcement, and a scope with three weeks of history has nothing to say
// about hit rates. Each of those is a fixture in surprise.test.js.
//
// Pure: rows in, verdicts out, no fetching. The service layer supplies both.

// The consensus for a result is the latest snapshot STRICTLY BEFORE the result
// landed, joined on the stored end date within this tolerance. The relative
// label ('0q') cannot be used — it means a different quarter before and after a
// result — so the join goes through trend_end_date.
const MATCH_TOL_DAYS = 45;

// Screener reports as-reported EPS; Yahoo's consensus is normalized (adjusted).
// The two differ systematically and in one direction, so a hair-thin threshold
// would label every result a beat or a miss and none of it would mean anything.
// This band is an admission of that gap, not a statistical claim.
const INLINE_BAND = 0.02;   // ±2% of the consensus

// A consensus this small divides into nonsense — the same tiny-denominator
// problem the aggregator guards for growth rates.
const MIN_CONSENSUS_MAGNITUDE = 0.05;

// Two floors, both of which must clear before a hit rate is characterised.
const MIN_RECORDING_DAYS = 120;  // roughly one full results season plus a margin
const MIN_SAMPLE = 20;           // the same floor signalScoring applies

const DAY = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / DAY);

/**
 * The consensus that was standing when a result landed, or null.
 *
 * Null is a real answer here and is reported as `noConsensus` rather than being
 * quietly folded into "inline" — no data is not agreement.
 */
function matchConsensus(result, snapshots = [], { tolDays = MATCH_TOL_DAYS } = {}) {
  if (!result) return null;
  // A backfilled row's first_seen_at is when the bulk load ran, not when the
  // company reported, so "before it landed" cannot be evaluated at all.
  if (result.backfilled) return null;
  if (!result.firstSeenAt || !result.periodEnd) return null;

  const landed = String(result.firstSeenAt).slice(0, 10);
  let best = null;
  for (const s of snapshots) {
    if (s.symbol !== result.symbol) continue;
    if (!s.trendEndDate || s.epsAvg == null) continue;
    // Strictly before: a snapshot dated the landing day may already carry the
    // announcement.
    if (!(String(s.snapDate).slice(0, 10) < landed)) continue;
    if (Math.abs(daysBetween(s.trendEndDate, result.periodEnd)) > tolDays) continue;
    if (!best || s.snapDate > best.snapDate) best = s;
  }
  return best;
}

/** beat / miss / inline / noConsensus, by magnitude so a loss compares correctly. */
function classifySurprise(actualEps, consensusEps, { band = INLINE_BAND } = {}) {
  if (actualEps == null || consensusEps == null) {
    return { verdict: 'noConsensus', reason: 'no estimate to compare against', surprisePct: null };
  }
  if (Math.abs(consensusEps) < MIN_CONSENSUS_MAGNITUDE) {
    return { verdict: 'noConsensus', reason: 'consensus too small to divide by (near zero)', surprisePct: null };
  }
  // Divided by the MAGNITUDE, so "expected a 2.00 loss, delivered a 1.00 loss"
  // reads as the beat it is rather than being sign-flipped into a miss.
  const rel = (actualEps - consensusEps) / Math.abs(consensusEps);
  const surprisePct = +(rel * 100).toFixed(2);
  if (Math.abs(rel) <= band) return { verdict: 'inline', reason: null, surprisePct };
  return { verdict: rel > 0 ? 'beat' : 'miss', reason: null, surprisePct };
}

/**
 * One scope's beat/miss tally.
 *
 * The counts are always reported; only the CHARACTERISATION is withheld below
 * the floors, so a user can see the sample growing rather than an empty panel.
 */
function scopeSurprise({ results = [], snapshots = [], recordingSince = null, asOf = null } = {}) {
  const tally = { beat: 0, miss: 0, inline: 0, noConsensus: 0 };
  const detail = [];
  for (const r of results) {
    const c = matchConsensus(r, snapshots);
    const verdict = c
      ? classifySurprise(r.eps, c.epsAvg)
      : { verdict: 'noConsensus', reason: 'no pre-announcement consensus recorded', surprisePct: null };
    tally[verdict.verdict]++;
    detail.push({
      symbol: r.symbol,
      actualEps: r.eps ?? null,
      consensusEps: c ? c.epsAvg : null,
      consensusAsOf: c ? c.snapDate : null,
      analysts: c ? c.analysts ?? null : null,
      ...verdict,
    });
  }

  const resolved = tally.beat + tally.miss + tally.inline;
  const today = asOf || new Date().toISOString().slice(0, 10);
  const recordingDays = recordingSince ? daysBetween(today, recordingSince) : 0;
  const longEnough = recordingDays >= MIN_RECORDING_DAYS;
  const bigEnough = resolved >= MIN_SAMPLE;

  return {
    ...tally,
    n: resolved,
    recordingSince,
    recordingDays,
    sufficient: longEnough && bigEnough,
    note: !recordingSince
      ? 'No consensus has been recorded yet. Beat/miss can only be captured forward — it cannot be reconstructed for past quarters.'
      : !longEnough
        ? `Recording began ${recordingSince}, ${recordingDays} days ago — too little history to characterise a hit rate.`
        : !bigEnough
          ? `Only ${resolved} results have a pre-announcement consensus — too few to judge.`
          : `${tally.beat} beat, ${tally.miss} missed, ${tally.inline} in line across ${resolved} results.`,
    basisNote: 'Reported EPS is as-reported; the consensus is normalized (adjusted), so the two are not on identical bases. Differences inside ±2% are called in line rather than treated as surprises.',
    detail,
  };
}

/**
 * Are forward estimates being raised or cut?
 *
 * Both readings must be for the SAME forecast period. Comparing this quarter's
 * estimate against next quarter's would read as a violent revision when nothing
 * has moved at all — the same trap as resolving a relative period label, one
 * level up.
 */
function revisionBreadth(snapshots = [], { asOf = null, windowDays = 30, minSymbols = MIN_SAMPLE } = {}) {
  const today = asOf || new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.parse(today) - windowDays * DAY).toISOString().slice(0, 10);

  // (symbol, trendEndDate) -> readings in the window, so the pair compared is
  // always the same forecast period.
  const series = new Map();
  for (const s of snapshots) {
    if (s.epsAvg == null || !s.trendEndDate) continue;
    const d = String(s.snapDate).slice(0, 10);
    if (d < cutoff || d > today) continue;
    const key = `${s.symbol}|${s.trendEndDate}`;
    if (!series.has(key)) series.set(key, []);
    series.get(key).push({ ...s, snapDate: d });
  }

  let raised = 0, cut = 0, unchanged = 0;
  const seen = new Set();
  for (const [key, list] of series) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.snapDate.localeCompare(b.snapDate));
    const first = list[0], last = list[list.length - 1];
    if (first.snapDate === last.snapDate) continue;
    const symbol = key.split('|')[0];
    // One vote per symbol: a company with estimates for four forward quarters
    // should not outvote one with a single covered quarter.
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    if (last.epsAvg > first.epsAvg) raised++;
    else if (last.epsAvg < first.epsAvg) cut++;
    else unchanged++;
  }

  const n = raised + cut + unchanged;
  return {
    raised, cut, unchanged, n, windowDays,
    sufficient: n >= minSymbols,
    note: n >= minSymbols
      ? `${raised} raised, ${cut} cut over ${windowDays} days.`
      : `${n} symbols have two readings ${windowDays} days apart — too few to characterise revisions yet.`,
  };
}

module.exports = {
  matchConsensus, classifySurprise, scopeSurprise, revisionBreadth,
  INLINE_BAND, MIN_CONSENSUS_MAGNITUDE, MIN_RECORDING_DAYS, MIN_SAMPLE, MATCH_TOL_DAYS,
};
