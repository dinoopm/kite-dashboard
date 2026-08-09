// ─── Reading the macro monitor in words ──────────────────────────────────────
//
// Pure derivations over the /api/macro/monitor payload. No fetching, no JSX, so
// the wording is testable and a change to it fails a test rather than a
// screenshot.
//
// Everything here is DERIVED. That is the point: a hand-written summary of this
// panel got it wrong. On 2026-08-09 the plausible sentence was "inflation
// pressure, offset by a cooling labour market" — but the contributions were
// inflation +0.135, wages -0.150, labour -0.079. The main offset was wage
// moderation, and it was LARGER than the pressure, which is the actual reason
// the composite sits below zero. Prose that is not computed will drift from the
// numbers next to it.
//
// Nothing here may assert what a central bank will do. The vocabulary is
// pressure / offset / risk / compatible, and a test enforces it.

const REGIME_WORD = {
  cooling: 'Cooling',
  neutral: 'Neutral',
  reaccelerating: 'Re-accelerating',
  unknown: 'Unknown',
};

const POLICY_WORD = {
  'cut-compatible': 'Cut-compatible',
  'hold-compatible': 'Hold-compatible',
  'hike-risk': 'Hike-risk',
};

// Human names for the scored components. Longer than the payload keys because
// "Labour" alone does not say which direction is which.
const COMPONENT_LABEL = {
  inflation: 'Inflation pressure',
  labour: 'Labour-market cooling',
  wages: 'Wage pressure',
  expectations: 'Inflation expectations',
  oil: 'Oil / energy risk',
};

// What each component is called when it appears mid-sentence.
const COMPONENT_PHRASE = {
  inflation: 'core inflation',
  labour: 'hiring and unemployment',
  wages: 'wage growth',
  expectations: 'inflation expectations',
  oil: 'oil prices',
};

const n2 = (v) => (v == null || !Number.isFinite(v) ? null : v.toFixed(2));

/** Where the score sits, in words, so the number never has to be interpreted alone. */
function directionWord(score) {
  if (score == null || !Number.isFinite(score)) return 'No reading';
  const a = Math.abs(score);
  const dir = score < 0 ? 'cooling' : 're-accelerating';
  if (a < 0.10) return `Slightly ${dir}`;
  if (a < 0.25) return dir.charAt(0).toUpperCase() + dir.slice(1);
  if (a < 0.60) return `Firmly ${dir}`;
  return `Strongly ${dir}`;
}

/**
 * Confidence, with the reason it is not higher.
 *
 * Three percentages side by side make the reader find the weak one. Naming it
 * is the whole value: agreement at 0.34 means the sub-signals point in opposite
 * directions, which is a completely different situation from a genuinely calm
 * reading, and it is the number a glance is most likely to miss.
 */
function confidenceConstraint(confidence) {
  if (!confidence) return null;
  const dims = [
    { key: 'agreement', v: confidence.agreement, text: 'indicators disagree' },
    { key: 'freshness', v: confidence.freshness, text: 'data is behind schedule' },
    { key: 'completeness', v: confidence.completeness, text: 'some series are missing' },
  ].filter(d => Number.isFinite(d.v));
  if (!dims.length) return null;
  const worst = dims.reduce((a, b) => (b.v < a.v ? b : a));
  if (worst.v >= 0.75) return { key: null, text: 'all inputs fresh and broadly agreeing', value: worst.v };
  return { key: worst.key, text: worst.text, value: worst.v };
}

/**
 * The three lines a reader needs before any bar: what is pushing, what is
 * pulling the other way, and what could move it next.
 *
 * Derived from the contributions rather than written, and it routinely
 * disagrees with intuition — see the note at the top of this file.
 */
function signalTriad(monitor) {
  const contributions = (monitor?.composite?.contributions || [])
    .filter(c => Number.isFinite(c.contribution));
  const positive = contributions.filter(c => c.contribution > 0).sort((a, b) => b.contribution - a.contribution);
  const negative = contributions.filter(c => c.contribution < 0).sort((a, b) => a.contribution - b.contribution);
  const next = monitor?.releases?.next || null;

  return {
    pressure: positive[0]
      ? { key: positive[0].key, label: COMPONENT_LABEL[positive[0].key] || positive[0].key, value: positive[0].contribution }
      : null,
    offset: negative[0]
      ? { key: negative[0].key, label: COMPONENT_LABEL[negative[0].key] || negative[0].key, value: negative[0].contribution }
      : null,
    risk: next ? { title: next.title, date: next.date, daysAway: next.daysAway } : null,
  };
}

/** `in 2 days` / `today` / `tomorrow`, computed at render so it cannot go stale. */
function countdown(daysAway) {
  if (daysAway == null || !Number.isFinite(daysAway)) return null;
  if (daysAway <= 0) return 'today';
  if (daysAway === 1) return 'tomorrow';
  return `in ${daysAway} days`;
}

/**
 * The paragraph under the headline: why the composite reads the way it does.
 *
 * Built from the two largest contributions and whether they offset, because
 * "close to neutral" has two very different causes — everything quiet, or
 * strong forces cancelling — and the composite alone cannot tell them apart.
 */
function explain(monitor) {
  const c = monitor?.composite;
  if (!c || c.score == null) {
    return 'Not enough current data to read a regime. The indicator detail below shows what is available.';
  }
  const { pressure, offset } = signalTriad(monitor);
  const parts = [];

  if (pressure && offset) {
    const dominant = Math.abs(offset.value) > Math.abs(pressure.value) ? 'offset' : 'pressure';
    parts.push(
      `${cap(COMPONENT_PHRASE[pressure.key] || pressure.key)} is adding upward pressure, while ${COMPONENT_PHRASE[offset.key] || offset.key} is pulling the other way.`
    );
    const gap = Math.abs(Math.abs(offset.value) - Math.abs(pressure.value));
    if (gap < 0.05) {
      parts.push('The two are close to balanced, which is what holds the composite near the middle of its range.');
    } else if (dominant === 'offset') {
      parts.push(`The ${COMPONENT_PHRASE[offset.key] || 'offsetting'} side is currently the larger of the two, which is why the composite sits below zero.`);
    } else {
      parts.push(`The ${COMPONENT_PHRASE[pressure.key] || 'pressure'} side is currently the larger of the two, which is why the composite sits above zero.`);
    }
  } else if (pressure) {
    parts.push(`${cap(COMPONENT_PHRASE[pressure.key] || pressure.key)} is adding upward pressure, with nothing currently offsetting it.`);
  } else if (offset) {
    parts.push(`${cap(COMPONENT_PHRASE[offset.key] || offset.key)} is easing, with no component currently pushing the other way.`);
  }

  const conf = confidenceConstraint(monitor.confidence);
  if (conf?.key === 'agreement') {
    parts.push('The components disagree sharply, so a near-zero score here means offsetting forces rather than a settled picture.');
  }

  const next = monitor?.releases?.next;
  if (next) {
    parts.push(`${next.title} lands ${countdown(next.daysAway)} and is the next thing that could move this.`);
  }
  return parts.join(' ');
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * What would move the reading, computed against the thresholds that produced it.
 *
 * Only for components that are actually scoring, and phrased as conditions on
 * observable data — never as a claim about what any central bank would then do.
 */
function whatWouldChange(monitor) {
  const T = monitor?.thresholds;
  const out = [];
  if (!T) return out;

  const infl = monitor.signals?.inflation;
  const a6 = infl?.detail?.annualized6m;
  if (Number.isFinite(a6)) {
    if (a6 > T.inflation.hot6m) {
      out.push(`Core inflation is running at ${n2(a6)}% on a 6-month annualized basis, above the ${n2(T.inflation.hot6m)}% upper marker. Falling back under ${n2(T.inflation.hot6m)}% would ease the largest single source of pressure; under ${n2(T.inflation.cool6m)}% would remove it.`);
    } else if (a6 < T.inflation.cool6m) {
      out.push(`Core inflation at ${n2(a6)}% is below the ${n2(T.inflation.cool6m)}% marker. A sustained move back above ${n2(T.inflation.hot6m)}% would restore it as a source of pressure.`);
    } else {
      out.push(`Core inflation at ${n2(a6)}% sits between the ${n2(T.inflation.cool6m)}% and ${n2(T.inflation.hot6m)}% markers. Crossing either would move the heaviest component decisively.`);
    }
  }

  const lab = monitor.signals?.labour?.detail;
  if (Number.isFinite(lab?.avg3mChangeThousands)) {
    out.push(`Hiring is averaging ${fmtK(lab.avg3mChangeThousands)} a month against a ${T.labour.payrollsCool}k cooling marker and ${T.labour.payrollsHot}k tightening marker. A run back above ${T.labour.payrollsHot}k, or a further slide with unemployment rising, would move the labour component to the opposite side.`);
  }

  const wag = monitor.signals?.wages?.detail;
  if (Number.isFinite(wag?.yoyPct)) {
    out.push(`Wage growth at ${n2(wag.yoyPct)}% year-over-year is below the ${n2(T.wages.yoyCool)}% pace considered consistent with target. Back above ${n2(T.wages.yoyHot)}% would turn the current largest offset into a source of pressure.`);
  }

  const exp = monitor.signals?.expectations?.detail;
  if (Number.isFinite(exp?.latest)) {
    out.push(`Long-run inflation expectations are ${n2(exp.latest)}%. A move above ${n2(T.expectations.levelHot)}% would mark them as drifting rather than anchored.`);
  }
  return out;
}

const fmtK = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v)}k`);

/**
 * Freshness as a status word rather than a raw date.
 *
 * "Context only" wins over everything: an unscored series being a release
 * behind is not a problem to act on, and flagging it as one is what led a
 * reviewer to conclude a stale survey print was moving the score.
 */
function freshnessStatus(indicator, maxForScoring = 1) {
  if (!indicator) return { label: 'Unknown', tone: 'muted' };
  if (indicator.scored === false) return { label: 'Context only', tone: 'muted' };
  const behind = indicator.releasesBehind;
  if (behind == null) return { label: 'Fresh', tone: 'ok' };
  if (behind === 0) return { label: 'Fresh', tone: 'ok' };
  if (behind <= maxForScoring) return { label: 'One release behind', tone: 'warn' };
  return { label: 'Stale', tone: 'bad' };
}

/** The six-month headline, always naming which calculation produced it. */
function sixMonthRead(ind) {
  if (!ind) return { value: '—', label: '' };
  if (ind.transform === 'index' && Number.isFinite(ind.annualized6m)) {
    return { value: `${signed(ind.annualized6m)}%`, label: '6m annualized' };
  }
  if (ind.transform === 'rate' && Number.isFinite(ind.changePp)) {
    return { value: `${signed(ind.changePp)}pp`, label: '6m change' };
  }
  if (ind.transform === 'price' && Number.isFinite(ind.rocPct)) {
    return { value: `${signed(ind.rocPct)}%`, label: '6m percent change' };
  }
  if (ind.transform === 'count' && Number.isFinite(ind.avg3mChange)) {
    return { value: fmtK(ind.avg3mChange), label: '3m average per month' };
  }
  return { value: '—', label: 'no six-month reading' };
}

const signed = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`);

/** One-line reading of an indicator, in the panel's vocabulary. */
function interpretIndicator(ind, thresholds) {
  if (!ind) return '';
  const T = thresholds || {};
  switch (ind.key) {
    case 'corePce':
    case 'coreCpi': {
      const v = ind.annualized6m;
      if (!Number.isFinite(v)) return 'No current reading';
      if (v > (T.inflation?.hot6m ?? 3.5)) return 'Above target — inflationary';
      if (v < (T.inflation?.cool6m ?? 2.0)) return 'Below target — disinflationary';
      return 'Near target';
    }
    case 'payrolls': {
      const v = ind.avg3mChange;
      if (!Number.isFinite(v)) return 'No current reading';
      if (v < (T.labour?.payrollsCool ?? 50)) return 'Hiring moderating';
      if (v > (T.labour?.payrollsHot ?? 200)) return 'Hiring strong — tightening';
      return 'Hiring steady';
    }
    case 'unemployment': {
      const v = ind.changePp;
      if (!Number.isFinite(v)) return 'No current reading';
      if (v > 0.1) return 'Labour market loosening';
      if (v < -0.1) return 'Labour market tightening';
      return 'Labour market steady';
    }
    case 'wages': {
      // Scored on year-over-year, but the six-month column shows the annualized
      // pace — two different numbers for the same series. Naming the basis stops
      // a reader matching the verdict to the figure beside it.
      const v = ind.yoyPct;
      if (!Number.isFinite(v)) return 'No current reading';
      const basis = ` (${v.toFixed(2)}% YoY, the scored basis)`;
      if (v > (T.wages?.yoyHot ?? 4.5)) return `Above target-consistent pace${basis}`;
      if (v < (T.wages?.yoyCool ?? 3.5)) return `Consistent with target${basis}`;
      return `Slightly above target-consistent pace${basis}`;
    }
    case 'oil': {
      const v = ind.rocPct;
      if (!Number.isFinite(v)) return 'No current reading';
      if (v > (T.oil?.rocHot ?? 25)) return 'Rising sharply — upside risk';
      if (v < (T.oil?.rocCool ?? -15)) return 'Falling — disinflationary';
      return 'Range-bound';
    }
    case 'expectations': {
      const v = ind.latest;
      if (!Number.isFinite(v)) return 'No current reading';
      if (v > (T.expectations?.levelHot ?? 2.6)) return 'Drifting above anchor';
      if (v < (T.expectations?.levelCool ?? 2.15)) return 'Well anchored';
      return 'Anchored';
    }
    case 'expectationsSurvey': return 'Households above market-implied';
    case 'headlineCpi': return 'Includes food and energy';
    default: return '';
  }
}

/** Why an unscored series is unscored — always answerable, never blank. */
function contextReason(ind) {
  if (!ind || ind.scored !== false) return null;
  if (ind.key === 'expectationsSurvey') {
    return ind.releasesBehind > 0
      ? 'Survey-based and one release behind. Carried for contrast with the market-implied measure, never scored.'
      : 'Survey-based. Carried for contrast with the market-implied measure, never scored.';
  }
  if (ind.key === 'headlineCpi') return 'Core measures drive the score; counting headline too would double-count energy alongside the oil component.';
  return 'Carried for context, not scored.';
}

export {
  REGIME_WORD, POLICY_WORD, COMPONENT_LABEL, COMPONENT_PHRASE,
  directionWord, confidenceConstraint, signalTriad, countdown,
  explain, whatWouldChange, freshnessStatus, sixMonthRead,
  interpretIndicator, contextReason, signed, fmtK,
};
