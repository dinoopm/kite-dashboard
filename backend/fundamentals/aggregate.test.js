const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateQuarter,
  MIN_COUNT_COVERAGE_PCT, MIN_POOL_COVERAGE_PCT,
  BASE_FLOOR_FRACTION, POOL_NET_TO_GROSS_FLOOR,
  buybackThreshold,
} = require('./aggregate');

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// This file is the specification. Every fixture below discriminates ONE rule
// from the others: if a rule is deleted from aggregate.js, exactly one of these
// should go red. Fixtures that merely re-exercise a path another fixture
// already covers do not belong here.
//
// Numbers are deliberately round so an expected output can be verified by hand.

/** One quarterly row, shaped as the stored table hands it over. */
const row = (symbol, periodEnd, netProfit, extra = {}) => ({
  market: 'IN',
  symbol,
  periodType: 'quarter',
  periodEnd,
  label: periodEnd,
  netProfit,
  revenue: extra.revenue ?? netProfit * 10,
  operatingProfit: extra.operatingProfit ?? netProfit * 1.5,
  opm: extra.opm ?? 15,
  otherIncome: extra.otherIncome ?? 0,
  interest: extra.interest ?? 0,
  depreciation: extra.depreciation ?? 0,
  pbt: extra.pbt ?? netProfit / 0.75,
  taxPct: extra.taxPct ?? 25,
  eps: extra.eps ?? null,
  unit: extra.unit ?? 'INR_CR',
  basis: extra.basis ?? 'consolidated',
  backfilled: extra.backfilled ?? true,
  firstSeenAt: extra.firstSeenAt ?? null,
  ...extra,
});

/** A symbol's series: { '2026-06-30': 120, '2025-06-30': 100 } */
const series = (symbol, byDate, extra = {}) =>
  Object.entries(byDate).map(([d, np]) => row(symbol, d, np, extra));

const names = (list) => list.map(s => (typeof s === 'string' ? s : s.symbol));
const members = (...syms) => syms.map(symbol => ({ symbol }));

/** The common case: two symbols that both reported both periods, growing 20%. */
const simpleScope = () => ({
  rows: [
    ...series('AAA', { '2025-06-30': 100, '2026-06-30': 120 }),
    ...series('BBB', { '2025-06-30': 200, '2026-06-30': 240 }),
  ],
  constituents: members('AAA', 'BBB'),
  quarter: '2026-06',
});

describe('the ordinary case', () => {
  test('pool, median and coverage agree when every company grows alike', () => {
    const r = aggregateQuarter(simpleScope());
    assert.equal(r.yoy.poolGrowthPct, 20);
    assert.equal(r.yoy.medianGrowthPct, 20);
    assert.equal(r.coverage.reportedCount, 2);
    assert.equal(r.coverage.countPct, 100);
    assert.equal(r.coverage.poolPct, 100);
    assert.equal(r.coverage.sufficient, true);
    assert.equal(r.unit, 'INR_CR');
  });
});

// ── Trap 1: partial season ───────────────────────────────────────────────────
describe('trap 1 — same-store', () => {
  test('a company that has not reported yet does not drag the aggregate down', () => {
    const r = aggregateQuarter({
      rows: [
        ...series('AAA', { '2025-06-30': 100, '2026-06-30': 120 }),
        ...series('BBB', { '2025-06-30': 200, '2026-06-30': 240 }),
        // CCC reported a year ago but has not posted this quarter yet.
        ...series('CCC', { '2025-06-30': 700 }),
      ],
      constituents: members('AAA', 'BBB', 'CCC'),
      quarter: '2026-06',
    });
    // 360/300, NOT 360/1000 — CCC is absent from BOTH sides or from neither.
    assert.equal(r.yoy.poolGrowthPct, 20);
    assert.equal(r.yoy.n, 2);
    assert.equal(r.coverage.reportedCount, 2);
  });

  test('breadth is same-store too — an unreported company is not "shrank"', () => {
    const r = aggregateQuarter({
      rows: [
        ...series('AAA', { '2025-06-30': 100, '2026-06-30': 120 }),
        ...series('CCC', { '2025-06-30': 700 }),
      ],
      constituents: members('AAA', 'CCC'),
      quarter: '2026-06',
    });
    assert.equal(r.breadth.grew, 1);
    assert.equal(r.breadth.shrank, 0);
    assert.equal(Object.values(r.breadth).reduce((a, b) => a + b, 0), 1);
  });
});

// ── Trap 2: two coverage numbers ─────────────────────────────────────────────
describe('trap 2 — coverage is two numbers', () => {
  // THE MISSING GIANT. This is the only fixture that tests the both-floors rule:
  // count coverage passes comfortably while the profit pool that reported is a
  // third of the sector. A single floor on count would wave this through.
  test('count coverage passes but pool coverage fails → insufficient', () => {
    const rows = [];
    const constituents = [];
    // Seven small names, each ₹10 Cr a year ago, all reported.
    for (let i = 0; i < 7; i++) {
      const s = `SMALL${i}`;
      rows.push(...series(s, { '2025-06-30': 10, '2026-06-30': 12 }));
      constituents.push({ symbol: s });
    }
    // Three giants, ₹100 Cr each a year ago, none reported yet.
    for (let i = 0; i < 3; i++) {
      const s = `GIANT${i}`;
      rows.push(...series(s, { '2025-06-30': 100 }));
      constituents.push({ symbol: s });
    }
    const r = aggregateQuarter({ rows, constituents, quarter: '2026-06' });
    assert.equal(r.coverage.countPct, 70);                        // 7 of 10 — passes
    assert.ok(Math.abs(r.coverage.poolPct - (70 / 370) * 100) < 0.1); // ~18.9% — fails
    assert.ok(r.coverage.poolPct < MIN_POOL_COVERAGE_PCT);
    assert.ok(r.coverage.countPct >= MIN_COUNT_COVERAGE_PCT);
    assert.equal(r.coverage.sufficient, false, 'both floors must clear');
    assert.match(r.verdict, /too little coverage/i);
  });
});

// ── Trap 3: dual-class ───────────────────────────────────────────────────────
describe('trap 3 — issuer dedupe by MERGING', () => {
  const dualClass = () => ({
    rows: [
      row('GOOG',  '2025-06-30', 100, { market: 'US', unit: 'USD', eps: 10 }),
      row('GOOG',  '2026-06-30', 120, { market: 'US', unit: 'USD', eps: 12 }),
      row('GOOGL', '2025-06-30', 100, { market: 'US', unit: 'USD', eps: 10 }),
      row('GOOGL', '2026-06-30', 120, { market: 'US', unit: 'USD', eps: 12 }),
      row('MSFT',  '2025-06-30', 100, { market: 'US', unit: 'USD', eps: 10 }),
      row('MSFT',  '2026-06-30', 100, { market: 'US', unit: 'USD', eps: 10 }),
    ],
    constituents: members('GOOG', 'GOOGL', 'MSFT'),
    quarter: '2026-06',
    issuerGroups: [['GOOG', 'GOOGL']],
    weights: { GOOG: 60, GOOGL: 40, MSFT: 100 },
    weightsAsOf: '2026-07-01',
  });

  test('financials are counted once, not twice', () => {
    const r = aggregateQuarter(dualClass());
    // Alphabet 100→120 and Microsoft 100→100: pool 200→220 = +10%.
    // Double-counting Alphabet would give 300→340 = +13.3%.
    assert.equal(r.yoy.poolGrowthPct, 10);
    assert.equal(r.yoy.n, 2, 'two issuers, not three symbols');
  });

  test('but the caps are SUMMED — dropping a row would halve the issuer weight', () => {
    const r = aggregateQuarter(dualClass());
    // Alphabet's weight must be 60+40=100, equal to Microsoft's, so the
    // weighted growth is the plain average of +20% and 0% → +10%.
    // Had GOOGL been dropped, Alphabet would carry 60 vs MSFT 100 and the
    // answer would be 7.5%.
    assert.equal(r.yoy.weightedGrowthPct, 10);
  });

  test('both share classes stay visible in the constituent rows, flagged', () => {
    const r = aggregateQuarter(dualClass());
    const goog = r.reporting.find(x => x.symbol === 'GOOG');
    const googl = r.reporting.find(x => x.symbol === 'GOOGL');
    assert.ok(goog && googl, 'display keeps both');
    assert.equal(googl.mergedInto, 'GOOG');
    assert.equal(goog.mergedInto, null);
  });
});

// ── Trap 4: overlapping universes ────────────────────────────────────────────
describe('trap 4 — dedupe by symbol before any union', () => {
  test('a symbol listed twice in the scope is counted once', () => {
    const r = aggregateQuarter({
      rows: [...series('AAA', { '2025-06-30': 100, '2026-06-30': 120 })],
      // AAA arrives twice: it sits in two sectors, or in both SPX and NDX.
      constituents: members('AAA', 'AAA'),
      quarter: '2026-06',
    });
    assert.equal(r.yoy.n, 1);
    assert.equal(r.coverage.constituents, 1);
    assert.equal(r.yoy.poolGrowthPct, 20);
  });
});

// ── Trap 5: the pool's own base ──────────────────────────────────────────────
describe('trap 5 — a near-zero or negative pool base', () => {
  test('a negative pool base suppresses the percentage and reports absolute Δ', () => {
    const r = aggregateQuarter({
      rows: [
        ...series('AAA', { '2025-06-30': -100, '2026-06-30': 50 }),
        ...series('BBB', { '2025-06-30': 40, '2026-06-30': 60 }),
      ],
      constituents: members('AAA', 'BBB'),
      quarter: '2026-06',
    });
    // Base is -60. A percentage here would be sign-inverted nonsense.
    assert.equal(r.yoy.poolGrowthPct, null);
    assert.equal(r.yoy.poolDeltaAbs, 170); // 110 - (-60)
    assert.equal(r.unit, 'INR_CR');
  });

  test('profits and losses that nearly cancel also suppress it', () => {
    const r = aggregateQuarter({
      rows: [
        ...series('AAA', { '2025-06-30': 1000, '2026-06-30': 1100 }),
        ...series('BBB', { '2025-06-30': -990, '2026-06-30': -900 }),
      ],
      constituents: members('AAA', 'BBB'),
      quarter: '2026-06',
    });
    // Net base 10 against a gross of 1990 — a 0.5% net-to-gross ratio. Any
    // percentage off that base is an artefact of two big numbers cancelling.
    assert.equal(r.yoy.poolGrowthPct, null);
    assert.equal(r.yoy.poolDeltaAbs, 190);
    assert.ok(POOL_NET_TO_GROSS_FLOOR > 0.005);
  });

  test('contribution percentages are suppressed with it', () => {
    const r = aggregateQuarter({
      rows: [
        ...series('AAA', { '2025-06-30': -100, '2026-06-30': 50 }),
        ...series('BBB', { '2025-06-30': 40, '2026-06-30': 60 }),
      ],
      constituents: members('AAA', 'BBB'),
      quarter: '2026-06',
    });
    for (const c of r.contributions) {
      assert.equal(c.sharePct, null, `${c.symbol} share must be suppressed`);
      assert.ok(Number.isFinite(c.delta), 'the absolute delta still stands');
    }
  });
});

// ── Trap 6: sign changes ─────────────────────────────────────────────────────
describe('trap 6 — crossing zero is not a percentage', () => {
  const crossers = () => aggregateQuarter({
    rows: [
      ...series('TURN', { '2025-06-30': -10, '2026-06-30': 5 }),
      ...series('FALL', { '2025-06-30': 10, '2026-06-30': -5 }),
      ...series('SINK', { '2025-06-30': -10, '2026-06-30': -20 }),
      ...series('GROW', { '2025-06-30': 100, '2026-06-30': 120 }),
      ...series('SHRK', { '2025-06-30': 100, '2026-06-30': 80 }),
    ],
    constituents: members('TURN', 'FALL', 'SINK', 'GROW', 'SHRK'),
    quarter: '2026-06',
  });

  test('classified into breadth, not turned into +150%', () => {
    const b = crossers().breadth;
    assert.deepEqual(b, { grew: 1, shrank: 1, lossToProfit: 1, profitToLoss: 1, lossToLoss: 1 });
  });

  test('excluded from the percentage statistics', () => {
    const r = crossers();
    // Only GROW (+20) and SHRK (-20) are eligible; median of those two is 0.
    assert.equal(r.yoy.n, 2);
    assert.equal(r.yoy.medianGrowthPct, 0);
  });

  test('but they still count in the pool, which handles signs correctly', () => {
    const r = crossers();
    // 190 → 180 = -5.26%. Dropping the crossers from the POOL would be wrong:
    // their profit is real, only their percentage is meaningless.
    assert.equal(Math.round(r.yoy.poolGrowthPct * 100) / 100, -5.26);
  });
});

// ── Trap 7: tiny denominators ────────────────────────────────────────────────
describe('trap 7 — a base too small to divide by', () => {
  test('a rounding-error base is excluded from growth statistics', () => {
    const rows = [];
    const constituents = [];
    for (let i = 0; i < 6; i++) {
      const s = `BIG${i}`;
      rows.push(...series(s, { '2025-06-30': 500, '2026-06-30': 550 }));
      constituents.push({ symbol: s });
    }
    rows.push(...series('TINY', { '2025-06-30': 0.2, '2026-06-30': 20 })); // +9,900%
    constituents.push({ symbol: 'TINY' });

    const r = aggregateQuarter({ rows, constituents, quarter: '2026-06' });
    assert.equal(r.yoy.medianGrowthPct, 10, 'the giant outlier must not move the median');
    assert.ok(names(r.excluded).includes('TINY'));
    assert.equal(r.excluded.find(e => e.symbol === 'TINY').reason, 'base-below-floor');
    assert.ok(BASE_FLOOR_FRACTION > 0 && BASE_FLOOR_FRACTION < 1);
  });
});

// ── Trap 8: match by date, three ways ────────────────────────────────────────
describe('trap 8 — periods pair by DATE, never by counting rows', () => {
  test('YoY: a missing year-ago quarter excludes the symbol', () => {
    const r = aggregateQuarter({
      rows: [
        ...series('AAA', { '2025-06-30': 100, '2026-06-30': 120 }),
        // BBB skipped Jun 2025 entirely. Counting back four rows would silently
        // pair Jun 2026 against Mar 2025 and call it a year.
        ...series('BBB', { '2025-03-31': 200, '2026-06-30': 240 }),
      ],
      constituents: members('AAA', 'BBB'),
      quarter: '2026-06',
    });
    assert.equal(r.yoy.n, 1);
    assert.equal(r.excluded.find(e => e.symbol === 'BBB').reason, 'no-yoy-match');
  });

  test('QoQ: a missing prior quarter excludes it the same way', () => {
    const r = aggregateQuarter({
      rows: [
        ...series('AAA', { '2026-03-31': 110, '2026-06-30': 120, '2025-06-30': 100 }),
        // CCC has no Mar 2026, so its QoQ has nothing to pair against — even
        // though its YoY is fine.
        ...series('CCC', { '2025-06-30': 200, '2026-06-30': 240 }),
      ],
      constituents: members('AAA', 'CCC'),
      quarter: '2026-06',
    });
    assert.equal(r.yoy.n, 2, 'both have a year-ago match');
    assert.equal(r.qoq.n, 1, 'only AAA has a prior-quarter match');
  });

  test('TTM: seven quarters plus a gap fails on SPACING, not on count', () => {
    // Eight rows, so a count check passes — but Dec 2024 is missing and Mar 2024
    // stands in its place, leaving a 6-month hole.
    const dates = ['2024-09-30', '2025-03-31', '2025-06-30', '2025-09-30',
                   '2025-12-31', '2026-03-31', '2026-06-30', '2024-06-30'];
    const byDate = {};
    dates.forEach((d, i) => { byDate[d] = 100 + i; });
    const r = aggregateQuarter({
      rows: series('AAA', byDate),
      constituents: members('AAA'),
      quarter: '2026-06',
    });
    assert.equal(r.ttm, null, 'a gap in the trailing window makes TTM unavailable');
  });

  test('TTM is available when eight quarters are properly spaced', () => {
    const byDate = {};
    // 12 clean quarters back from Jun 2026.
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(2026, 5, 30));
      d.setUTCMonth(d.getUTCMonth() - 3 * i);
      byDate[d.toISOString().slice(0, 10)] = 100;
    }
    const r = aggregateQuarter({
      rows: series('AAA', byDate),
      constituents: members('AAA'),
      quarter: '2026-06',
    });
    assert.ok(r.ttm, 'eight properly spaced quarters is enough');
    assert.equal(r.ttm.poolGrowthPct, 0);
  });
});

// ── Trap 9: financials ───────────────────────────────────────────────────────
describe('trap 9 — banks get their own bridge, never the industrial one', () => {
  const bank = () => aggregateQuarter({
    rows: [
      ...series('HDFCBANK',
        { '2025-06-30': 100, '2026-06-30': 130 },
        { isFinancial: true, provisions: 20, interest: 400 }),
    ],
    constituents: members('HDFCBANK'),
    quarter: '2026-06',
  });

  test('the industrial steps are absent', () => {
    const steps = bank().bridge.map(s => s.step);
    assert.ok(!steps.includes('opm'), 'operating margin is meaningless for a lender');
    assert.ok(!steps.includes('interestDep'), 'interest is a revenue line here');
  });

  test('and it says so rather than relabelling', () => {
    const r = bank();
    assert.equal(r.bridgeKind, 'financial');
    assert.ok(r.bridgeNote && /provision|lender|bank/i.test(r.bridgeNote));
  });
});

// ── Trap 12: EPS rounding sets the share-count threshold ─────────────────────
describe('trap 12 — the buyback threshold scales with EPS precision', () => {
  test('a flat 2% would be pure noise on a ₹0.30 EPS', () => {
    // ±0.005 on 0.30 is 1.67%, doubled across two periods is 3.33%.
    assert.ok(buybackThreshold(0.30) > 0.03);
    assert.equal(+buybackThreshold(0.30).toFixed(4), +(2 * 0.005 / 0.30).toFixed(4));
  });

  test('and 2% is the floor once EPS is large enough to be precise', () => {
    assert.equal(buybackThreshold(50), 0.02);
    assert.equal(buybackThreshold(0.50), 0.02, 'exactly the crossover');
  });

  test('a share-count move inside the noise band raises no flag', () => {
    const r = aggregateQuarter({
      rows: [
        row('PENNY', '2025-06-30', 100, { eps: 0.30 }),
        row('PENNY', '2026-06-30', 120, { eps: 0.36 }),
      ],
      constituents: members('PENNY'),
      quarter: '2026-06',
    });
    // Implied shares 333.3 → 333.3: identical, but any rounding wobble here is
    // under the adaptive threshold, so no buyback/dilution claim is made.
    assert.ok(!(r.flags.PENNY || []).includes('buyback'));
    assert.ok(!(r.flags.PENNY || []).includes('dilution'));
  });
});

// ── Trap 13: bases and units ─────────────────────────────────────────────────
describe('trap 13 — a basis or unit switch is rejected, not computed', () => {
  test('consolidated vs standalone between the two periods is excluded', () => {
    const r = aggregateQuarter({
      rows: [
        row('AAA', '2025-06-30', 100, { basis: 'standalone' }),
        row('AAA', '2026-06-30', 300, { basis: 'consolidated' }),
        ...series('BBB', { '2025-06-30': 100, '2026-06-30': 120 }),
      ],
      constituents: members('AAA', 'BBB'),
      quarter: '2026-06',
    });
    // AAA's "+200%" is an artefact of switching to the group accounts.
    assert.equal(r.excluded.find(e => e.symbol === 'AAA').reason, 'basis-mismatch');
    assert.equal(r.yoy.poolGrowthPct, 20);
  });

  test('a unit switch is rejected the same way', () => {
    const r = aggregateQuarter({
      rows: [
        row('AAA', '2025-06-30', 100, { unit: 'USD' }),
        row('AAA', '2026-06-30', 120, { unit: 'INR_CR' }),
        ...series('BBB', { '2025-06-30': 100, '2026-06-30': 120 }),
      ],
      constituents: members('AAA', 'BBB'),
      quarter: '2026-06',
    });
    assert.equal(r.excluded.find(e => e.symbol === 'AAA').reason, 'unit-mismatch');
  });
});

// ── Trap 14: renames ─────────────────────────────────────────────────────────
describe('trap 14 — a renamed symbol has not "failed to report"', () => {
  test('the alias resolves both periods to one company', () => {
    const r = aggregateQuarter({
      rows: [
        row('OLDNAME', '2025-06-30', 100),
        row('NEWNAME', '2026-06-30', 120),
      ],
      constituents: members('NEWNAME'),
      quarter: '2026-06',
      aliases: { OLDNAME: 'NEWNAME' },
    });
    assert.equal(r.yoy.n, 1);
    assert.equal(r.yoy.poolGrowthPct, 20);
    assert.equal(r.coverage.reportedCount, 1);
    assert.equal(r.excluded.length, 0);
  });
});

// ── The weight vintage ───────────────────────────────────────────────────────
describe('the weighted aggregate needs an as-of weight vector', () => {
  test('one weight vector is applied to BOTH sides of the ratio', () => {
    const r = aggregateQuarter({
      rows: [
        row('BIG',   '2025-06-30', 100, { eps: 10 }),
        row('BIG',   '2026-06-30', 200, { eps: 20 }),
        row('SMALL', '2025-06-30', 100, { eps: 10 }),
        row('SMALL', '2026-06-30', 100, { eps: 10 }),
      ],
      constituents: members('BIG', 'SMALL'),
      quarter: '2026-06',
      weights: { BIG: 90, SMALL: 10 },
      weightsAsOf: '2026-07-01',
    });
    // Same weights top and bottom, so this is a clean weighted earnings ratio
    // and BIG's doubling dominates. Applying year-ago weights underneath would
    // blend earnings change with weight drift.
    assert.ok(r.yoy.weightedGrowthPct > r.yoy.poolGrowthPct);
  });

  test('quarters predating the snapshot era get no weighted number at all', () => {
    const r = aggregateQuarter({
      ...simpleScope(),
      weights: { AAA: 50, BBB: 50 },
      // The only snapshot we hold is a year after this quarter closed, so there
      // is no contemporaneous weight vector to apply to either side.
      weightsAsOf: '2027-06-01',
    });
    assert.equal(r.yoy.weightedGrowthPct, null);
    assert.match(r.weightNote || '', /no as-of weight|predates/i);
  });
});

// ── The two invariants ───────────────────────────────────────────────────────
describe('invariants', () => {
  const mixed = () => aggregateQuarter({
    rows: [
      ...series('AAA', { '2025-06-30': 100, '2026-06-30': 150 }),
      ...series('BBB', { '2025-06-30': 200, '2026-06-30': 180 }),
      ...series('CCC', { '2025-06-30': 50,  '2026-06-30': 90 }),
    ],
    constituents: members('AAA', 'BBB', 'CCC'),
    quarter: '2026-06',
  });

  test('contributions sum exactly to pool growth', () => {
    const r = mixed();
    const summed = r.contributions.reduce((a, c) => a + c.sharePct, 0);
    assert.ok(Math.abs(summed - r.yoy.poolGrowthPct) < 1e-9,
      `${summed} vs ${r.yoy.poolGrowthPct}`);
  });

  test('the bridge closes to current net profit, residual included', () => {
    const r = mixed();
    const base = r.bridgeBase;
    const walked = r.bridge.reduce((a, s) => a + s.delta, base);
    assert.ok(Math.abs(walked - r.bridgeClose) < 1e-6, `${walked} vs ${r.bridgeClose}`);
    assert.ok(r.bridge.some(s => s.step === 'residual'),
      'the interaction residual is shown, never absorbed into another step');
  });

  test('the sector bridge is the sum of the same-store company bridges', () => {
    const r = mixed();
    assert.equal(r.bridgeBase, 350);   // 100 + 200 + 50
    assert.equal(r.bridgeClose, 420);  // 150 + 180 + 90
  });
});

// ── The verdict is a template, never free text ───────────────────────────────
describe('the verdict makes no interpretive claim', () => {
  test('it states the measurement and nothing about what to do', () => {
    const r = aggregateQuarter(simpleScope());
    assert.match(r.verdict, /20/);
    assert.ok(!/bullish|bearish|buy|sell|strong|weak|attractive/i.test(r.verdict),
      `verdict must stay descriptive, got: ${r.verdict}`);
  });
});

// ─── The payload surface the UI depends on ───────────────────────────────────
//
// The page and the aggregator are developed in different files and can drift
// apart silently: a renamed field shows up as a blank cell, not an error. This
// pins the fields Earnings.jsx actually reads.
describe('the shape the page reads', () => {
  const r = aggregateQuarter({
    rows: [
      ...series('AAA', { '2025-06-30': 100, '2026-03-31': 110, '2026-06-30': 150 }),
      ...series('BBB', { '2025-06-30': 200, '2026-03-31': 190, '2026-06-30': 180 }),
    ],
    constituents: members('AAA', 'BBB'),
    quarter: '2026-06',
  });

  test('every field the sector table renders is present', () => {
    for (const path of ['quarter', 'unit', 'verdict', 'yoy.poolGrowthPct', 'yoy.poolDeltaAbs',
      'yoy.weightedGrowthPct', 'yoy.medianGrowthPct', 'coverage.reportedCount',
      'coverage.constituents', 'coverage.countPct', 'coverage.poolPct', 'coverage.sufficient']) {
      const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), r);
      assert.ok(v !== undefined, `${path} is missing from the payload`);
    }
  });

  test('breadth carries exactly the five states the legend draws', () => {
    assert.deepEqual(Object.keys(r.breadth).sort(),
      ['grew', 'lossToLoss', 'lossToProfit', 'profitToLoss', 'shrank']);
  });

  test('the drill-down panels have their arrays', () => {
    for (const key of ['bridge', 'contributions', 'reporting', 'excluded']) {
      assert.ok(Array.isArray(r[key]), `${key} must be an array the panel can map over`);
    }
    assert.ok(r.bridge.every(s => 'step' in s && 'delta' in s));
    assert.ok(r.contributions.every(c => 'symbol' in c && 'delta' in c && 'sharePct' in c));
    assert.ok(r.reporting.every(x => 'symbol' in x && 'reported' in x && 'mergedInto' in x));
  });

  test('the sequential block carries its own caveat, so the UI cannot omit it', () => {
    assert.ok(r.qoq.caveat && /seasonal/i.test(r.qoq.caveat));
  });

  test('bridgeBase and bridgeClose are present for the waterfall header', () => {
    assert.equal(typeof r.bridgeBase, 'number');
    assert.equal(typeof r.bridgeClose, 'number');
  });
});

// The Phase 3 panel reads these off the same report object, so they belong in
// the surface test alongside everything else the page renders.
describe('the surprise panel\'s shape', () => {
  const { scopeSurprise, revisionBreadth } = require('./surprise');

  test('an empty scope still returns a readable, non-null panel', () => {
    const s = scopeSurprise({ results: [], snapshots: [], recordingSince: null });
    for (const k of ['beat', 'miss', 'inline', 'noConsensus', 'n', 'sufficient', 'note', 'basisNote']) {
      assert.ok(s[k] !== undefined, `${k} missing`);
    }
    assert.equal(s.sufficient, false);
    assert.match(s.note, /forward/i, 'the empty state has to explain itself, not just be blank');

    const rev = revisionBreadth([], {});
    assert.equal(rev.n, 0);
    assert.ok(rev.note);
  });
});

describe('a market with nothing ingested', () => {
  test('says what is wrong instead of dereferencing undefined', () => {
    assert.throws(
      () => aggregateQuarter({ rows: [], constituents: [{ symbol: 'AAPL' }], quarter: undefined }),
      /needs a quarter like/,
      'the US table is empty until its ingest runs — that must not read as a crash');
  });
});
