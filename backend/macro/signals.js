// ─── Macro regime scoring ────────────────────────────────────────────────────
//
// Turns the six-month readings from calc.js into five sub-signals and one
// composite. Pure — no fetching, no database — so every threshold is visible
// and the whole engine is testable without a network.
//
// Sign convention, and it is the easiest thing in here to get backwards:
//
//        -1 ............... 0 ............... +1
//     cooling            neutral        re-accelerating
//
// which means a STRONG LABOUR MARKET SCORES POSITIVE. Strong hiring and
// falling unemployment are inflationary pressure, so they push toward
// hike-risk. That inverts the equity-desk reflex that good jobs numbers are
// good news, and getting it wrong flips the whole panel.
//
// What this does NOT do is predict a rate decision. The FOMC weighs financial
// stability, credit conditions, global growth and politics, none of which are
// in here. The output is a BIAS from seven data series, and every label in
// this module says "bias", "risk" or "signal" — enforced by a test.
//
// Scores are continuous rather than bucketed on purpose: 2.49% and 2.51% are
// the same world, and a bucket boundary between them would make the panel
// lurch between regimes on a rounding difference.

const THRESHOLDS = {
  inflation: {
    // 6-month annualized core PCE, mapped onto [-1, +1]. 2.0 is the Fed's
    // target; 3.5 is where the 2021-23 episode ran and is treated as fully hot.
    cool6m: 2.0,
    hot6m: 3.5,
    // Momentum: 3-month annualized minus 6-month, in pp. Positive means the
    // recent pace is above the six-month pace, i.e. re-acceleration.
    momentumCool: -0.5,
    momentumHot: 0.5,
    momentumWeight: 0.35,
  },
  labour: {
    // Average monthly payroll change over 3 months, thousands. Roughly 50k is
    // near the pace that holds unemployment flat given current labour-force
    // growth; 200k+ is a genuinely tight market.
    payrollsCool: 50,
    payrollsHot: 200,
    // Unemployment: note the inversion — a RISE cools.
    unemploymentCoolPp: 0.4,
    unemploymentHotPp: -0.3,
    unemploymentWeight: 0.4,
  },
  wages: {
    // ~3.5% wage growth is the pace consistent with 2% inflation plus ~1.5%
    // productivity. Above ~4.5% it is hard to square with target unless
    // productivity has genuinely stepped up.
    yoyCool: 3.5,
    yoyHot: 4.5,
  },
  expectations: {
    // 5y5y forward breakeven. It sat near 2.1-2.3 through the anchored years;
    // above ~2.6 is where "anchored" starts to be arguable.
    levelCool: 2.15,
    levelHot: 2.60,
    changeCoolPp: -0.20,
    changeHotPp: 0.20,
    changeWeight: 0.30,
  },
  oil: {
    // Six-month percent change in WTI. Weighted lowest because energy passes
    // into headline fast but into CORE only weakly and with a long lag.
    rocCool: -15,
    rocHot: 25,
  },
  weights: {
    inflation: 0.45,
    labour: 0.25,
    wages: 0.15,
    expectations: 0.10,
    oil: 0.05,
  },
  regime: { coolingMax: -0.25, reaccelMin: 0.25 },
  confidence: { highMin: 0.75, mediumMin: 0.50 },
  // Measured in releases MISSED (see calc.releasesBehind), not calendar days —
  // a release lag is not staleness. Two missed releases is a real outage: for
  // a monthly series that is a whole quarter with no update.
  //
  // `maxForScoring` is the harder gate: a series that far behind is DROPPED
  // from its signal and the surviving inputs carry it, rather than a months-old
  // print contributing at full weight because nothing checked. Confidence
  // alone was not enough — it described the problem after the score had
  // already been computed from bad inputs.
  staleness: { maxReleasesBehind: 2, maxForScoring: 1 },
};

const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const num = (v) => (v != null && Number.isFinite(v) ? v : null);

/**
 * Is this series current enough to be scored at all?
 *
 * A series with no `releasesBehind` is treated as usable — the field is
 * computed by monitor.js and its absence means "not measured here", as in the
 * unit tests, not "stale". Refusing to score on a missing diagnostic would
 * make the engine fail closed on its own instrumentation.
 */
function isScorable(metric, { maxForScoring = THRESHOLDS.staleness.maxForScoring } = {}) {
  if (!metric) return false;
  const behind = num(metric.releasesBehind);
  return behind == null || behind <= maxForScoring;
}

/**
 * Which of a signal's declared inputs actually contributed.
 *
 * Reported on every signal so a component computed from a subset says so
 * instead of looking like a full reading — the difference between "wages are
 * cooling" and "wages are cooling, on one of the two series that should say
 * so" is the whole point of showing it.
 */
function inputReport(declared, used) {
  return {
    inputsUsed: used.length,
    inputsTotal: declared.length,
    usedSeries: used,
    excluded: declared.filter(d => !used.includes(d)),
  };
}

/**
 * Map a reading onto [-1, +1] given the values that count as fully cool and
 * fully hot. `coolAt` may be the HIGHER number — unemployment cools as it
 * rises — so no direction is assumed.
 */
function scale(value, coolAt, hotAt) {
  const v = num(value);
  if (v == null || coolAt === hotAt) return v == null ? null : 0;
  return clamp(((v - coolAt) / (hotAt - coolAt)) * 2 - 1);
}

/**
 * Inflation — the heaviest weight, and the only signal that blends a level
 * with its momentum. 2.6% and falling is a different world from 2.6% and
 * rising, and a level-only score cannot tell them apart.
 *
 * Core PCE is preferred because it is the Fed's target measure; core CPI is
 * the fallback because it publishes about two weeks earlier, so there are
 * stretches where only CPI has the newest month. Which one was used is
 * reported, never silent — the two run at different levels.
 */
function inflationSignal({ corePce, coreCpi } = {}, opts = {}) {
  const T = THRESHOLDS.inflation;
  const declared = ['PCEPILFE', 'CPILFESL'];
  const usable = (m) => num(m?.annualized6m) != null && isScorable(m, opts);
  // A stale core PCE falls through to core CPI rather than being scored — the
  // fallback already exists for the two-week publication gap, and staleness is
  // the same problem for longer.
  const s = usable(corePce) ? corePce : usable(coreCpi) ? coreCpi : null;
  if (!s) {
    const anyPresent = num(corePce?.annualized6m) != null || num(coreCpi?.annualized6m) != null;
    return {
      score: null,
      used: null,
      reason: anyPresent ? 'core inflation series too stale to score' : 'no core inflation index available',
      ...inputReport(declared, []),
    };
  }

  const level = scale(s.annualized6m, T.cool6m, T.hot6m);
  const momentum = num(s.annualized3m) != null
    ? scale(s.annualized3m - s.annualized6m, T.momentumCool, T.momentumHot)
    : null;
  const score = momentum == null ? level : level * (1 - T.momentumWeight) + momentum * T.momentumWeight;

  return {
    score: clamp(score),
    used: s.seriesId ?? null,
    referenceMonth: s.latestDate ?? null,
    // Core PCE and core CPI are a PREFERENCE CHAIN, not two inputs to combine:
    // this signal always scores exactly one index. Reporting "1 of 2, CPILFESL
    // excluded" on a perfectly healthy reading would cry partial-inputs every
    // single day and make the notice worthless when it matters.
    ...inputReport([s.seriesId], [s.seriesId]),
    fellBackToCpi: s.seriesId === 'CPILFESL',
    preferredSeries: 'PCEPILFE',
    detail: {
      annualized6m: s.annualized6m ?? null,
      annualized3m: s.annualized3m ?? null,
      baseDate: s.sixMonthsAgoDate ?? null,
      baseValue: s.sixMonthsAgo ?? null,
      levelScore: level,
      momentumScore: momentum,
      fellBackToCpi: s.seriesId === 'CPILFESL',
    },
  };
}

/**
 * Labour — hiring pace and the direction of unemployment.
 *
 * Positive is a TIGHT market, i.e. inflationary pressure. See the sign note at
 * the top of the file.
 */
function labourSignal({ payrolls, unemployment } = {}, opts = {}) {
  const T = THRESHOLDS.labour;
  const declared = ['PAYEMS', 'UNRATE'];
  const payOk = num(payrolls?.avg3mChange) != null && isScorable(payrolls, opts);
  const unOk = num(unemployment?.changePp) != null && isScorable(unemployment, opts);

  const pay = payOk ? scale(payrolls.avg3mChange, T.payrollsCool, T.payrollsHot) : null;
  const un = unOk ? scale(unemployment.changePp, T.unemploymentCoolPp, T.unemploymentHotPp) : null;
  const used = [payOk && 'PAYEMS', unOk && 'UNRATE'].filter(Boolean);

  if (pay == null && un == null) {
    return { score: null, reason: 'no current labour data', ...inputReport(declared, used) };
  }
  // Dropping one input hands its share to the other rather than scoring it
  // zero — a missing series is not a neutral reading.
  const detail = {
    payrollsScore: pay, unemploymentScore: un,
    avg3mChangeThousands: payrolls?.avg3mChange ?? null,
    payrollsSeriesId: 'PAYEMS',
    monthlyChanges: payrolls?.monthlyChanges ?? [],
    unemploymentChangePp: unemployment?.changePp ?? null,
  };
  if (pay == null) return { score: un, ...inputReport(declared, used), detail: { ...detail, unemploymentOnly: true } };
  if (un == null) return { score: pay, ...inputReport(declared, used), detail: { ...detail, payrollsOnly: true } };
  return {
    score: clamp(pay * (1 - T.unemploymentWeight) + un * T.unemploymentWeight),
    ...inputReport(declared, used),
    detail,
  };
}

/**
 * Wage pressure. Composition shifts distort average hourly earnings — a wave
 * of low-wage hiring lowers the average without anyone taking a pay cut — so
 * this is weighted below the labour block rather than treated as a clean read.
 */
function wageSignal({ wages } = {}, opts = {}) {
  const T = THRESHOLDS.wages;
  const declared = ['CES0500000003'];
  if (num(wages?.yoyPct) == null) return { score: null, reason: 'no wage data', ...inputReport(declared, []) };
  if (!isScorable(wages, opts)) return { score: null, reason: 'wage series too stale to score', ...inputReport(declared, []) };
  return {
    score: scale(wages.yoyPct, T.yoyCool, T.yoyHot),
    ...inputReport(declared, declared),
    // annualized6m is computed from the LEVEL series, not from the rounded
    // one-decimal monthly prints — compounding those accumulates error.
    detail: { yoyPct: wages.yoyPct, annualized6m: wages.annualized6m ?? null, baseDate: wages.sixMonthsAgoDate ?? null },
  };
}

/**
 * Inflation expectations — the market's longer-run anchor. Level matters more
 * than the six-month move, because the whole point of an anchor is that it
 * should not drift; hence the smaller weight on change.
 */
function expectationsSignal({ expectations, expectationsSurvey } = {}, opts = {}) {
  const T = THRESHOLDS.expectations;
  // Only the market-based breakeven is SCORED. The Michigan survey is carried
  // for the narrative — households and markets routinely disagree, and that
  // disagreement is worth showing rather than averaging into one number — so
  // it is declared here as context, never as a weighted input. Folding it in
  // would be a recalibration, not a correctness fix.
  const declared = ['T5YIFR'];
  if (num(expectations?.latest) == null) return { score: null, reason: 'no breakeven data', ...inputReport(declared, []) };
  if (!isScorable(expectations, opts)) return { score: null, reason: 'breakeven series too stale to score', ...inputReport(declared, []) };

  const level = scale(expectations.latest, T.levelCool, T.levelHot);
  const change = num(expectations.changePp) != null
    ? scale(expectations.changePp, T.changeCoolPp, T.changeHotPp) : null;
  return {
    score: clamp(change == null ? level : level * (1 - T.changeWeight) + change * T.changeWeight),
    ...inputReport(declared, declared),
    detail: {
      latest: expectations.latest, changePp: expectations.changePp ?? null,
      levelScore: level, changeScore: change,
      // Surfaced so the panel can show the survey beside the market read
      // without implying it moved the score.
      survey: num(expectationsSurvey?.latest) == null ? null : {
        seriesId: 'MICH', latest: expectationsSurvey.latest,
        latestDate: expectationsSurvey.latestDate ?? null,
        releasesBehind: expectationsSurvey.releasesBehind ?? null,
        scored: false,
      },
    },
  };
}

/** Oil — the lightest weight: fast into headline, weak and slow into core. */
function oilSignal({ oil } = {}, opts = {}) {
  const T = THRESHOLDS.oil;
  const declared = ['DCOILWTICO'];
  if (num(oil?.rocPct) == null) return { score: null, reason: 'no oil data', ...inputReport(declared, []) };
  if (!isScorable(oil, opts)) return { score: null, reason: 'oil series too stale to score', ...inputReport(declared, []) };
  return {
    score: scale(oil.rocPct, T.rocCool, T.rocHot),
    ...inputReport(declared, declared),
    detail: { roc6mPct: oil.rocPct, baseDate: oil.sixMonthsAgoDate ?? null },
  };
}

const BIAS = { cooling: 'cut-compatible', neutral: 'hold-compatible', reaccelerating: 'hike-risk' };

/**
 * Weighted composite of the five sub-signals.
 *
 * A missing sub-signal is DROPPED and the surviving weights renormalised, not
 * scored as 0. Scoring it 0 would pull the composite toward Neutral, so a
 * broken feed would render as a genuine "things are balanced" reading — the
 * failure mode this codebase keeps running into, where absent data looks like
 * a real answer.
 */
function compositeScore(signals = {}) {
  const W = THRESHOLDS.weights;
  let weighted = 0;
  let totalWeight = 0;
  const raw = [];

  for (const [key, weight] of Object.entries(W)) {
    const score = num(signals[key]?.score);
    raw.push({ key, weight, score });
    if (score == null) continue;
    weighted += score * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) {
    return { score: null, regime: 'unknown', bias: null, coverage: 0,
      contributions: raw.map(c => ({ ...c, contribution: null })) };
  }

  const score = weighted / totalWeight;
  const { coolingMax, reaccelMin } = THRESHOLDS.regime;
  const regime = score <= coolingMax ? 'cooling' : score >= reaccelMin ? 'reaccelerating' : 'neutral';

  return {
    score,
    regime,
    bias: BIAS[regime],
    coverage: totalWeight,
    // Renormalised so the UI's contribution bars sum to the headline score.
    contributions: raw.map(c => ({
      ...c,
      contribution: c.score == null ? null : (c.score * c.weight) / totalWeight,
    })),
  };
}

/**
 * How much to trust the reading, from three independent things.
 *
 * Agreement is the one that matters most and the one a single headline number
 * hides: inflation at +0.9 against labour at -0.9 averages to a
 * confident-looking 0 that means "violently conflicting", not "balanced".
 */
function confidence(signals = {}, composite = {}, metrics = {}) {
  const T = THRESHOLDS;

  // Freshness is measured in RELEASES MISSED, not calendar days. A monthly
  // series carries its reference month, and core PCE publishes ~30 days after
  // that month ends, so a perfectly current reading is always 40-70 days old.
  // Scoring that as stale marked every monthly series permanently behind and
  // pinned this panel to "low" forever — which teaches the reader to ignore
  // the field that is supposed to flag a genuine outage.
  const behind = Object.values(metrics)
    .filter(m => m && num(m.releasesBehind) != null)
    .map(m => Math.max(0, 1 - m.releasesBehind / T.staleness.maxReleasesBehind));
  const freshness = behind.length ? behind.reduce((a, b) => a + b, 0) / behind.length : 0;

  const completeness = num(composite.coverage) != null ? composite.coverage : 0;

  // Dispersion of the sub-signals, normalised. The widest possible spread is
  // ±1, so a standard deviation of 1 means maximal disagreement.
  const scores = Object.values(signals).map(s => num(s?.score)).filter(v => v != null);
  let agreement = 0;
  if (scores.length >= 2) {
    const m = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sd = Math.sqrt(scores.reduce((s, v) => s + (v - m) ** 2, 0) / scores.length);
    agreement = clamp(1 - sd, 0, 1);
  } else if (scores.length === 1) {
    agreement = 0.5;   // one signal cannot agree or disagree with anything
  }

  const score = freshness * 0.3 + completeness * 0.3 + agreement * 0.4;
  let level = score >= T.confidence.highMin ? 'high'
    : score >= T.confidence.mediumMin ? 'medium' : 'low';

  // Freshness CAPS the level rather than merely contributing to it. Averaged
  // in, complete and agreeing indicators can carry a stale reading to "medium"
  // — but five series that all stopped updating four months ago agree only
  // about the past, and confidently describing a regime from them is the
  // failure this panel is supposed to make visible.
  if (freshness < 0.34) level = 'low';
  else if (freshness < 0.67 && level === 'high') level = 'medium';

  return {
    score: +score.toFixed(3),
    level,
    freshness: +freshness.toFixed(3),
    completeness: +completeness.toFixed(3),
    agreement: +agreement.toFixed(3),
  };
}

/** The whole engine: metrics in, signals + composite + confidence out. */
function buildSignals(metrics = {}, opts = {}) {
  const signals = {
    inflation: inflationSignal(metrics, opts),
    labour: labourSignal(metrics, opts),
    wages: wageSignal(metrics, opts),
    expectations: expectationsSignal(metrics, opts),
    oil: oilSignal(metrics, opts),
  };
  const composite = compositeScore(signals);
  return { signals, composite, confidence: confidence(signals, composite, metrics) };
}

module.exports = {
  THRESHOLDS, scale, isScorable, inputReport,
  inflationSignal, labourSignal, wageSignal, expectationsSignal, oilSignal,
  compositeScore, confidence, buildSignals,
};
