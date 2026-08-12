// ─── Financial conditions, read separately ───────────────────────────────────
//
// The panel's caveat used to say the FOMC weighs financial stability and credit
// conditions and that neither was an input here. They are measured now — but as
// their OWN read, not folded into the inflation-labour composite.
//
// That separation is deliberate and worth stating, because merging would have
// been easier:
//
//   · "Is inflation cooling?" and "is money easy?" are different questions. A
//     single number answering both answers neither clearly.
//   · The composite's weights sum to 1.0 across five components. Adding more
//     means redistributing, which changes the score for reasons that have
//     nothing to do with the data and makes every snapshot already recorded in
//     macro_signal_snapshots non-comparable with today's.
//   · This block therefore has no weight, no contribution and no path into
//     `composite`. It is a second gauge on the same dashboard.
//
// One threshold here is not a judgement call, which is why NFCI was chosen over
// alternatives: the index is normalised so ZERO IS THE HISTORICAL AVERAGE by
// construction. Loose-versus-tight needs no invented cut-off. The credit-spread
// bands are ordinary chosen thresholds and are marked as such.

const THRESHOLDS = {
  // NFCI is a z-score against its own history, so the natural mapping is one
  // standard deviation to each rail: -1 sd reads as fully loose, +1 sd as
  // fully tight. A ±0.25 band was tried first and was useless — NFCI at -0.55
  // clamped instantly, so the gauge sat at exactly -1.000 and moved for
  // nothing. A dial pinned to the rail carries no information.
  nfci: { looseAt: -1.0, tightAt: 1.0 },
  // High-yield OAS. Post-2000 it has run from roughly 2.5pp at the easiest to
  // well past 10pp in a crisis, with a median near 4-5. The band spans the
  // usable range rather than the median, for the same anti-saturation reason.
  // Chosen, not swept — the same standing caveat as the squeeze thresholds.
  creditSpread: { easyAt: 2.5, stressedAt: 8.0 },
};

const num = (v) => (v != null && Number.isFinite(v) ? v : null);
const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Map onto [-1, +1] where -1 is loose/easy and +1 is tight/stressed. */
function scale(value, looseAt, tightAt) {
  const v = num(value);
  if (v == null || looseAt === tightAt) return null;
  return clamp(((v - looseAt) / (tightAt - looseAt)) * 2 - 1);
}

/**
 * One read of the financial backdrop.
 *
 * Returns null components rather than zeros when a series is missing, for the
 * same reason the composite does: absent data must not read as "average".
 */
function financialRead(metrics = {}, T = THRESHOLDS) {
  const nfci = metrics.financialConditions;
  const credit = metrics.creditSpread;
  const curve = metrics.yieldCurve;

  const nfciScore = scale(nfci?.latest, T.nfci.looseAt, T.nfci.tightAt);
  const creditScore = scale(credit?.latest, T.creditSpread.easyAt, T.creditSpread.stressedAt);

  const parts = [nfciScore, creditScore].filter(v => v != null);
  const score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;

  const state = score == null ? 'unknown'
    : score <= -0.25 ? 'loose'
      : score >= 0.25 ? 'tight' : 'neutral';

  return {
    score,
    state,
    inputsUsed: parts.length,
    inputsTotal: 2,
    components: {
      nfci: nfci?.latest == null ? null : {
        seriesId: 'NFCI', value: nfci.latest, changePp: nfci.changePp ?? null, score: nfciScore,
      },
      creditSpread: credit?.latest == null ? null : {
        seriesId: 'BAMLH0A0HYM2', value: credit.latest, changePp: credit.changePp ?? null, score: creditScore,
      },
      // Carried but never scored: the inversion-to-recession lead time is long
      // and variable enough that scoring it would be a claim this app cannot
      // support. Shown because the rates backdrop is worth seeing.
      yieldCurve: curve?.latest == null ? null : {
        seriesId: 'T10Y2Y', value: curve.latest, changePp: curve.changePp ?? null,
        inverted: curve.latest < 0, scored: false,
      },
    },
    thresholds: T,
  };
}

/** One sentence, derived, in the panel's vocabulary. */
function describeFinancial(read) {
  if (!read || read.score == null) return 'No current reading on financial conditions.';
  const c = read.components;
  const bits = [];
  if (c.nfci) {
    bits.push(`the Chicago Fed index is ${c.nfci.value.toFixed(2)}, ${c.nfci.value < 0 ? 'looser' : 'tighter'} than its historical average`);
  }
  if (c.creditSpread) {
    bits.push(`high-yield spreads are ${c.creditSpread.value.toFixed(2)}pp over Treasuries`);
  }
  const head = read.state === 'loose' ? 'Financial conditions are easier than average'
    : read.state === 'tight' ? 'Financial conditions are tighter than average'
      : 'Financial conditions are close to average';
  const curve = c.yieldCurve
    ? ` The 10s-2s curve is ${c.yieldCurve.value >= 0 ? `positive at ${c.yieldCurve.value.toFixed(2)}pp` : `inverted at ${c.yieldCurve.value.toFixed(2)}pp`}, shown as context rather than scored.`
    : '';
  // Says what it is NOT, because a loose reading sitting under an inflation
  // panel invites being read as a rate call.
  return `${head} — ${bits.join(', and ')}. This is a separate read and does not feed the macro score above.${curve}`;
}

module.exports = { THRESHOLDS, financialRead, describeFinancial, scale };
