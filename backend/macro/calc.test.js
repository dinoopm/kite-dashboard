const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFredValue, findClosest, sixMonthsBefore, roc, changePp,
  annualizedRate, computeMetrics,
} = require('./calc');

describe('parseFredValue', () => {
  // FRED writes "." for a date with no observation — a holiday on a daily
  // series, or a month a series had not started. Coerced to 0 it would be a
  // crude oil price of zero and a -100% six-month move.
  test('turns FRED\'s missing marker into null, never zero', () => {
    assert.equal(parseFredValue('.'), null);
    assert.equal(parseFredValue(' . '), null);
    assert.equal(parseFredValue(''), null);
    assert.equal(parseFredValue(null), null);
  });

  test('parses ordinary numbers including negatives and zero', () => {
    assert.equal(parseFredValue('336.065'), 336.065);
    assert.equal(parseFredValue('-1.25'), -1.25);
    assert.equal(parseFredValue('0'), 0, 'a real zero is data, not a gap');
  });

  test('never lets NaN through', () => {
    assert.equal(parseFredValue('n/a'), null);
    assert.equal(parseFredValue('abc'), null);
  });
});

describe('sixMonthsBefore', () => {
  test('steps back six calendar months', () => {
    assert.equal(sixMonthsBefore('2026-08-07'), '2026-02-07');
  });

  // Naive minus-180-days lands on the wrong month; naive month arithmetic can
  // produce 2026-02-31, which Date silently rolls into March.
  test('clamps a month end that does not exist six months earlier', () => {
    assert.equal(sixMonthsBefore('2026-08-31'), '2026-02-28');
  });

  test('crosses a year boundary', () => {
    assert.equal(sixMonthsBefore('2026-03-15'), '2025-09-15');
  });
});

describe('findClosest', () => {
  const monthly = [
    { observation_date: '2026-01-01', value: 100 },
    { observation_date: '2026-02-01', value: 101 },
    { observation_date: '2026-06-01', value: 105 },
  ];

  test('picks the nearest observation inside the tolerance', () => {
    assert.equal(findClosest(monthly, '2026-02-07', 45).value, 101);
  });

  test('returns null when nothing lands inside the tolerance', () => {
    // Nothing within 45 days of 2026-04-10: Feb 1 is 68 days, Jun 1 is 52.
    assert.equal(findClosest(monthly, '2026-04-10', 45), null);
  });

  // A "six-month change" measured over eleven months is a wrong number, not a
  // stale one, so the tolerance is a hard gate rather than a preference.
  test('never reaches past the tolerance just to find something', () => {
    assert.equal(findClosest(monthly, '2025-06-01', 45), null);
  });

  test('skips null values rather than returning a gap as the match', () => {
    const withGap = [
      { observation_date: '2026-02-01', value: null },
      { observation_date: '2026-02-03', value: 99 },
    ];
    const hit = findClosest(withGap, '2026-02-01', 10);
    assert.equal(hit.value, 99);
    assert.equal(hit.date, '2026-02-03');
  });

  test('reports how far off the match landed', () => {
    assert.equal(findClosest(monthly, '2026-02-04', 45).offsetDays, 3);
  });
});

describe('roc and changePp', () => {
  test('roc is a percent change of a level', () => {
    assert.ok(Math.abs(roc(110, 100) - 10) < 1e-9);
    assert.ok(Math.abs(roc(85, 100) - -15) < 1e-9);
  });

  test('roc refuses a zero or missing base', () => {
    assert.equal(roc(110, 0), null);
    assert.equal(roc(110, null), null);
    assert.equal(roc(null, 100), null);
  });

  // The distinction the whole module exists for: unemployment 3.5 -> 4.2 is
  // +0.7pp. Percent ROC calls it +20%, which is not a quantity anyone in macro
  // uses and reads like a catastrophe.
  test('changePp is a percentage-point difference, not a ratio', () => {
    assert.ok(Math.abs(changePp(4.2, 3.5) - 0.7) < 1e-9);
    assert.ok(Math.abs(roc(4.2, 3.5) - 20) < 1e-9, 'the misleading alternative, for contrast');
  });

  // Percent ROC on a negative-to-more-negative move returns +100%: positive,
  // for a series that fell. Any UI colouring by sign shows green for
  // accelerating deflation.
  test('changePp keeps its sign where roc inverts it', () => {
    assert.ok(changePp(-1.0, -0.5) < 0, 'more deflation is a negative change');
    assert.ok(roc(-1.0, -0.5) > 0, 'roc says positive for the same move');
  });
});

describe('annualizedRate', () => {
  // PLTR-style arithmetic check: 1% over three months compounds to ~4.06%/yr.
  test('annualizes a three-month index move', () => {
    const r = annualizedRate(101, 100, 3);
    assert.ok(Math.abs(r - 4.0604) < 0.001, `got ${r}`);
  });

  test('a six-month move at the same monthly pace annualizes to the same rate', () => {
    const monthly = Math.pow(1.02, 1 / 12);          // 2% a year, per month
    const three = annualizedRate(Math.pow(monthly, 3), 1, 3);
    const six = annualizedRate(Math.pow(monthly, 6), 1, 6);
    assert.ok(Math.abs(three - six) < 1e-6, 'same pace must give the same annual rate');
    assert.ok(Math.abs(three - 2) < 1e-6);
  });

  test('handles disinflation', () => {
    assert.ok(annualizedRate(99.5, 100, 6) < 0);
  });

  test('refuses a missing or non-positive base', () => {
    assert.equal(annualizedRate(101, 0, 3), null);
    assert.equal(annualizedRate(101, null, 3), null);
    assert.equal(annualizedRate(101, -5, 3), null);
  });
});

describe('computeMetrics', () => {
  // A monthly index rising 0.2% a month.
  const index = [];
  for (let m = 0; m < 24; m++) {
    const d = new Date(Date.UTC(2025, m, 1));
    index.push({ observation_date: d.toISOString().slice(0, 10), value: 100 * Math.pow(1.002, m) });
  }

  test('an index series gets annualized rates and a year-over-year', () => {
    const m = computeMetrics(index, { frequency: 'monthly', transform: 'index' });
    assert.ok(Math.abs(m.annualized3m - 2.4266) < 0.01, `3m was ${m.annualized3m}`);
    assert.ok(Math.abs(m.annualized6m - 2.4266) < 0.01, `6m was ${m.annualized6m}`);
    assert.ok(Math.abs(m.yoyPct - 2.4266) < 0.01, `yoy was ${m.yoyPct}`);
    assert.equal(m.changePp, null, 'an index level has no percentage-point reading');
  });

  test('a rate series gets a percentage-point change and no ROC', () => {
    const rate = [
      { observation_date: '2026-02-01', value: 3.5 },
      { observation_date: '2026-08-01', value: 4.2 },
    ];
    const m = computeMetrics(rate, { frequency: 'monthly', transform: 'rate', anchorDate: '2026-08-01' });
    assert.ok(Math.abs(m.changePp - 0.7) < 1e-9);
    assert.equal(m.rocPct, null, 'ROC on a rate is meaningless and must not be offered');
  });

  test('a price series gets ROC and no percentage-point change', () => {
    const price = [
      { observation_date: '2026-02-06', value: 70 },
      { observation_date: '2026-08-06', value: 84 },
    ];
    const m = computeMetrics(price, { frequency: 'daily', transform: 'price', anchorDate: '2026-08-06' });
    assert.ok(Math.abs(m.rocPct - 20) < 1e-9);
    assert.equal(m.changePp, null);
  });

  test('a count series reports an average monthly change in its own units', () => {
    const payrolls = [
      { observation_date: '2026-04-01', value: 158_600 },
      { observation_date: '2026-05-01', value: 158_700 },
      { observation_date: '2026-06-01', value: 158_800 },
      { observation_date: '2026-07-01', value: 158_900 },
    ];
    const m = computeMetrics(payrolls, { frequency: 'monthly', transform: 'count' });
    assert.ok(Math.abs(m.avg3mChange - 100) < 1e-9, `got ${m.avg3mChange}`);
    assert.equal(m.lastChange, 100);
  });

  test('reports staleness against the anchor date', () => {
    const m = computeMetrics(index, { frequency: 'monthly', transform: 'index', anchorDate: '2026-12-15' });
    assert.equal(m.latestDate, '2026-12-01');
    assert.equal(m.ageDays, 14);
  });

  test('survives an empty or all-null series without throwing', () => {
    assert.equal(computeMetrics([], { frequency: 'monthly', transform: 'index' }).latest, null);
    const nulls = [{ observation_date: '2026-01-01', value: null }];
    assert.equal(computeMetrics(nulls, { frequency: 'monthly', transform: 'index' }).latest, null);
  });

  // Six months of history is the minimum the feature claims to analyse; less
  // than that must read as "cannot say", not as a zero change.
  test('leaves the six-month readings null when history is too short', () => {
    const short = index.slice(-2);
    const m = computeMetrics(short, { frequency: 'monthly', transform: 'index' });
    assert.equal(m.annualized6m, null);
    assert.ok(m.annualized3m == null || Number.isFinite(m.annualized3m));
  });

  test('rejects an unknown transform rather than guessing one', () => {
    assert.throws(() => computeMetrics(index, { frequency: 'monthly', transform: 'wat' }), /transform/i);
  });
});

describe('releasesBehind', () => {
  const { releasesBehind } = require('./calc');

  // The bug this exists for: a monthly series is stamped with its REFERENCE
  // month, and core PCE publishes ~30 days after that month ends. So a
  // perfectly current series is always 40-70 calendar days "old", and judging
  // freshness on raw age pinned the panel's confidence to "low" permanently.
  test('a monthly series as current as it can be is not behind', () => {
    // On 2026-08-09, core PCE's newest possible reference month is June.
    assert.equal(releasesBehind('2026-06-01', { frequency: 'monthly', releaseLagDays: 30, anchorDate: '2026-08-09' }), 0);
  });

  test('counts a monthly series that actually missed a release', () => {
    assert.equal(releasesBehind('2026-05-01', { frequency: 'monthly', releaseLagDays: 30, anchorDate: '2026-08-09' }), 1);
    assert.equal(releasesBehind('2026-04-01', { frequency: 'monthly', releaseLagDays: 30, anchorDate: '2026-08-09' }), 2);
  });

  // Payrolls publish five days after month end, so July is available on 9 Aug
  // while core PCE's July will not exist for another three weeks. The same
  // calendar age means different things for the two series.
  test('respects each series own release lag', () => {
    assert.equal(releasesBehind('2026-07-01', { frequency: 'monthly', releaseLagDays: 5, anchorDate: '2026-08-09' }), 0);
    assert.equal(releasesBehind('2026-06-01', { frequency: 'monthly', releaseLagDays: 5, anchorDate: '2026-08-09' }), 1);
  });

  test('daily series count in days, allowing for a weekend', () => {
    assert.equal(releasesBehind('2026-08-07', { frequency: 'daily', releaseLagDays: 1, anchorDate: '2026-08-09' }), 0);
    assert.ok(releasesBehind('2026-07-20', { frequency: 'daily', releaseLagDays: 1, anchorDate: '2026-08-09' }) > 2);
  });

  test('returns null without a date rather than pretending it is current', () => {
    assert.equal(releasesBehind(null, { frequency: 'monthly', releaseLagDays: 30 }), null);
  });
});

// ─── Reference-data checks ───────────────────────────────────────────────────
// Values pulled from FRED on 2026-08-09 and asserted exactly, so a future
// refactor that reintroduces positional indexing or an off-by-one month fails
// here rather than on the dashboard.
describe('against verified FRED reference data', () => {
  const monthly = (pairs) => pairs.map(([d, v]) => ({ observation_date: d, value: v }));

  // Core PCE, 2017=100, SA. The base MUST be 2025-12, exactly six months
  // before the 2026-06 latest — not 2025-11, and not a positional offset.
  test('core PCE six-month annualized lands on the December base', () => {
    const m = computeMetrics(monthly([
      ['2025-11-01', 127.469], ['2025-12-01', 127.886], ['2026-01-01', 128.455],
      ['2026-02-01', 128.961], ['2026-03-01', 129.343], ['2026-04-01', 129.663],
      ['2026-05-01', 130.094], ['2026-06-01', 130.266],
    ]), { frequency: 'monthly', transform: 'index', anchorDate: '2026-08-09' });

    assert.equal(m.sixMonthsAgoDate, '2025-12-01', 'base month must be December, not November');
    assert.equal(m.sixMonthsAgo, 127.886);
    assert.ok(Math.abs(m.annualized6m - 3.7567) < 0.01, `expected 3.76 from the December base, got ${m.annualized6m}`);
  });

  // Same code path, same base month, independently checkable: core CPI.
  test('core CPI six-month annualized lands on the same December base', () => {
    const m = computeMetrics(monthly([
      ['2025-11-01', 331.043], ['2025-12-01', 331.814], ['2026-01-01', 332.793],
      ['2026-02-01', 333.512], ['2026-03-01', 334.165], ['2026-04-01', 335.423],
      ['2026-05-01', 336.121], ['2026-06-01', 336.065],
    ]), { frequency: 'monthly', transform: 'index', anchorDate: '2026-08-09' });

    assert.equal(m.sixMonthsAgoDate, '2025-12-01');
    assert.ok(Math.abs(m.annualized6m - 2.5786) < 0.01, `expected 2.58, got ${m.annualized6m}`);
  });

  test('unemployment six-month change is in percentage points', () => {
    const m = computeMetrics(monthly([
      ['2026-01-01', 4.3], ['2026-02-01', 4.2], ['2026-03-01', 4.2],
      ['2026-04-01', 4.2], ['2026-05-01', 4.3], ['2026-06-01', 4.2], ['2026-07-01', 4.1],
    ]), { frequency: 'monthly', transform: 'rate', anchorDate: '2026-08-09' });

    assert.equal(m.sixMonthsAgoDate, '2026-01-01');
    assert.ok(Math.abs(m.changePp - -0.2) < 1e-9, `expected -0.20pp, got ${m.changePp}`);
  });

  // Average hourly earnings, computed from the LEVEL series. Compounding the
  // rounded one-decimal monthly prints [0.3,0.2,0.2,0.2,0.3,0.1] gives ~2.62%;
  // the levels give 2.55%. The levels are right — the monthly prints are
  // rounded to a hundredth of a percent and the error accumulates over six of
  // them.
  test('wage growth comes from the level series, not the rounded monthly prints', () => {
    const m = computeMetrics(monthly([
      ['2026-01-01', 37.15], ['2026-02-01', 37.27], ['2026-03-01', 37.35],
      ['2026-04-01', 37.41], ['2026-05-01', 37.49], ['2026-06-01', 37.60], ['2026-07-01', 37.62],
    ]), { frequency: 'monthly', transform: 'index', anchorDate: '2026-08-09' });

    assert.equal(m.sixMonthsAgoDate, '2026-01-01');
    assert.ok(Math.abs(m.annualized6m - 2.546) < 0.01, `expected 2.55 from levels, got ${m.annualized6m}`);
  });

  // Total nonfarm. The 3-month average must be the mean of the last three
  // month-over-month FIRST DIFFERENCES of the level series.
  test('total nonfarm payrolls average the last three monthly changes', () => {
    const m = computeMetrics(monthly([
      ['2026-03-01', 158650], ['2026-04-01', 158798], ['2026-05-01', 158861],
      ['2026-06-01', 158881], ['2026-07-01', 158858],
    ]), { frequency: 'monthly', transform: 'count', anchorDate: '2026-08-09' });

    assert.deepEqual(m.monthlyChanges.map(c => c.change), [63, 20, -23]);
    assert.ok(Math.abs(m.avg3mChange - 20) < 1e-9, `expected +20.0k, got ${m.avg3mChange}`);
    assert.equal(m.lastChange, -23);
  });

  // The distinction the payrolls card has to make visible: the same three
  // months on PRIVATE payrolls average double the total-nonfarm figure,
  // because government was shedding jobs.
  test('private payrolls over the same months average 40.3k, not 20k', () => {
    const m = computeMetrics(monthly([
      ['2026-03-01', 135317], ['2026-04-01', 135467], ['2026-05-01', 135528],
      ['2026-06-01', 135558], ['2026-07-01', 135588],
    ]), { frequency: 'monthly', transform: 'count', anchorDate: '2026-08-09' });

    assert.deepEqual(m.monthlyChanges.map(c => c.change), [61, 30, 30]);
    assert.ok(Math.abs(m.avg3mChange - 40.333) < 0.01, `expected 40.3k, got ${m.avg3mChange}`);
  });

  // The reason the average is now date-matched rather than rows[length-4].
  test('a missing month does not silently become a four-month average', () => {
    const m = computeMetrics(monthly([
      ['2026-03-01', 158650], ['2026-04-01', 158798],
      /* May missing */ ['2026-06-01', 158881], ['2026-07-01', 158858],
    ]), { frequency: 'monthly', transform: 'count', anchorDate: '2026-08-09' });
    assert.equal(m.avg3mChange, null, 'an incomplete window must report nothing, not a wrong average');
  });
});

// ─── Seasonal adjustment is part of the series identity ──────────────────────
// A validation report attributed CPIAUCNS values to CPIAUCSL and concluded the
// dashboard was showing an NSA print. Both series are pinned here so the
// confusion cannot survive a code change either.
describe('headline CPI: seasonally adjusted vs not', () => {
  const monthly = (pairs) => pairs.map(([d, v]) => ({ observation_date: d, value: v }));
  const opts = { frequency: 'monthly', transform: 'index', anchorDate: '2026-08-09' };

  // CPIAUCSL — the series actually ingested, and what the panel shows.
  test('CPIAUCSL annualizes to 4.05% off the December base', () => {
    const m = computeMetrics(monthly([
      ['2025-12-01', 326.031], ['2026-01-01', 326.588], ['2026-02-01', 327.460],
      ['2026-03-01', 330.293], ['2026-04-01', 332.407], ['2026-05-01', 333.979],
      ['2026-06-01', 332.568],
    ]), opts);
    assert.equal(m.latest, 332.568);
    assert.equal(m.sixMonthsAgo, 326.031);
    assert.ok(Math.abs(m.annualized6m - 4.0505) < 0.01, `expected 4.05, got ${m.annualized6m}`);
  });

  // CPIAUCNS — same concept, no seasonal adjustment. Annualizing it over
  // Dec->Jun spans HALF A SEASONAL CYCLE, so the 6.2% it produces is mostly
  // the spring price upswing, not underlying inflation. This is why the
  // catalogue ingests the SA series, and why the 6.2% figure quoted against
  // CPIAUCSL was really this series.
  test('CPIAUCNS gives 6.2% over the same window — seasonality, not inflation', () => {
    const m = computeMetrics(monthly([
      ['2025-12-01', 324.054], ['2026-01-01', 325.252], ['2026-02-01', 326.785],
      ['2026-03-01', 330.213], ['2026-04-01', 333.020], ['2026-05-01', 335.123],
      ['2026-06-01', 333.952],
    ]), opts);
    assert.ok(Math.abs(m.annualized6m - 6.2018) < 0.02, `expected ~6.20, got ${m.annualized6m}`);
    assert.ok(m.annualized6m - 4.0505 > 2, 'the SA/NSA gap over this window is over 2pp — not a rounding matter');
  });
});

// ─── The disputed core PCE figure ────────────────────────────────────────────
// Reported three times as "should be 3.69%". The formula is not in question —
// both assertions below use the same function. The INPUT is: FRED serves
// 127.886 for PCEPILFE 2025-12 in every vintage from 2026-02 through 2026-07,
// checked directly via the vintage_date parameter. 127.929 appears in none of
// them, and is not headline PCE (128.576) either.
describe('core PCE: the formula is right, the disputed input is the difference', () => {
  const annualize = (latest, base) => annualizedRate(latest, base, 6);

  test('FRED\'s actual December value gives 3.76%', () => {
    assert.ok(Math.abs(annualize(130.266, 127.886) - 3.7567) < 0.01);
  });

  // Same function, the reviewer's base: it does produce their number. So a
  // failure here would mean the arithmetic was wrong; it passing means the
  // arithmetic is right and the disagreement is purely about which December
  // value is real.
  test('the reported base would give 3.69% through the same function', () => {
    assert.ok(Math.abs(annualize(130.266, 127.929) - 3.687) < 0.01);
  });

  // 0.043 index points, which is why this is easy to argue about and worth
  // pinning rather than re-deriving.
  test('the two bases differ by less than a twentieth of an index point', () => {
    assert.ok(Math.abs(127.929 - 127.886) < 0.05);
  });
});
