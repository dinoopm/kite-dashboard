const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  TNX_RANGES, TNX_DEFAULT_RANGE, tnxRangeConfig,
  mapLegacyStatementRow, mergeStatementRows, secStatementRows,
} = require('./alpaca');

describe('treasury-10y ranges', () => {
  test('every range asks for at least as much history as the one below it', () => {
    const order = ['1M', '3M', '6M', '1Y', '2Y', '3Y', '4Y', '5Y', '10Y'];
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        TNX_RANGES[order[i]].days > TNX_RANGES[order[i - 1]].days,
        `${order[i]} must look back further than ${order[i - 1]}`,
      );
    }
  });

  test('switches to weekly bars only past the point daily gets too dense', () => {
    for (const r of ['1M', '3M', '6M', '1Y', '2Y']) {
      assert.equal(TNX_RANGES[r].interval, '1d', `${r} should still be daily`);
    }
    for (const r of ['3Y', '4Y', '5Y', '10Y']) {
      assert.equal(TNX_RANGES[r].interval, '1wk', `${r} should be weekly`);
    }
  });

  // An unknown range silently serves the default window while the response
  // still echoes the range that was asked for — six months of data captioned
  // "over 3Y". That is why the coverage test below exists.
  test('an unknown range falls back to the default window', () => {
    assert.deepEqual(tnxRangeConfig('7Y'), TNX_RANGES[TNX_DEFAULT_RANGE]);
    assert.deepEqual(tnxRangeConfig(undefined), TNX_RANGES[TNX_DEFAULT_RANGE]);
  });

  test('every range button the chart offers has a backend entry', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../frontend/src/components/TreasuryChart.jsx'), 'utf8');
    const m = src.match(/const RANGES = \[([^\]]+)\]/);
    assert.ok(m, 'could not find the RANGES list in TreasuryChart.jsx');
    const buttons = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.ok(buttons.length >= 9, `expected the full range row, got ${buttons.join(',')}`);
    for (const b of buttons) {
      assert.ok(TNX_RANGES[b], `chart offers "${b}" but the backend has no window for it`);
    }
  });
});

// ─── Income-statement merge ──────────────────────────────────────────────────
// Yahoo publishes the same statement through two endpoints and neither is
// reliably ahead: on 2026-08-07 fundamentalsTimeSeries had PLTR only to
// 2026-03-31 while quoteSummary had 2026-06-30, and for AAPL it was the other
// way round. The merge exists so the newest quarter shows up whichever endpoint
// happens to have it.

// PLTR's 2026-06-30 quarter exactly as quoteSummary served it — note that the
// fields Yahoo has no value for come back as 0, not null.
const PLTR_Q2_26 = {
  endDate: new Date('2026-06-30T00:00:00Z'),
  totalRevenue: 1935464000,
  costOfRevenue: 0,
  grossProfit: 0,
  totalOperatingExpenses: 0,
  operatingIncome: null,
  ebit: 0,
  incomeBeforeTax: null,
  incomeTaxExpense: 0,
  netIncome: 1061890000,
};

describe('mapLegacyStatementRow', () => {
  test('keeps the two figures Yahoo actually fills in', () => {
    const r = mapLegacyStatementRow(PLTR_Q2_26, true);
    assert.equal(r.revenue, 1935464000);
    assert.equal(r.netIncome, 1061890000);
    assert.equal(r.label, "Q2 '26");
    assert.equal(r.endDate, '2026-06-30');
  });

  // The whole reason this mapper is separate: read literally, PLTR would show
  // $0 gross profit and a 0% gross margin on 86%-margin revenue. A blank is
  // wrong-looking; a zero is wrong.
  test('treats Yahoo placeholder zeros as missing, not as zero', () => {
    const r = mapLegacyStatementRow(PLTR_Q2_26, true);
    for (const k of ['costOfRevenue', 'grossProfit', 'operatingExpense', 'operatingIncome', 'pretaxIncome', 'tax', 'eps']) {
      assert.equal(r[k], null, `${k} should be blank, not a fabricated zero`);
    }
    assert.equal(r.grossMargin, null);
    assert.equal(r.operatingMargin, null);
  });

  test('still derives the margin it has both sides for', () => {
    const r = mapLegacyStatementRow(PLTR_Q2_26, true);
    assert.ok(Math.abs(r.netMargin - 54.86) < 0.01, `net margin was ${r.netMargin}`);
  });

  // So the UI can mark the column rather than let it read as a data error.
  test('flags the row as partial', () => {
    assert.equal(mapLegacyStatementRow(PLTR_Q2_26, true).partial, true);
  });

  test('labels an annual row by year', () => {
    assert.equal(mapLegacyStatementRow(PLTR_Q2_26, false).label, 'FY 2026');
  });

  test('skips a row with neither revenue nor net income', () => {
    assert.equal(mapLegacyStatementRow({ endDate: new Date('2026-06-30Z'), totalRevenue: 0, netIncome: 0 }, true), null);
  });
});

describe('mergeStatementRows', () => {
  const ts = [
    { endDate: '2025-12-31', label: "Q4 '25", sortKey: 3, revenue: 1406802000, eps: 0.24 },
    { endDate: '2026-03-31', label: "Q1 '26", sortKey: 4, revenue: 1632583000, eps: 0.34 },
  ];
  const legacy = [
    { endDate: '2026-03-31', label: "Q1 '26", sortKey: 4, revenue: 1632583000, eps: null, partial: true },
    { endDate: '2026-06-30', label: "Q2 '26", sortKey: 5, revenue: 1935464000, eps: null, partial: true },
  ];

  test('appends the quarter only the legacy endpoint has', () => {
    const out = mergeStatementRows(ts, legacy);
    assert.deepEqual(out.map(r => r.endDate), ['2025-12-31', '2026-03-31', '2026-06-30']);
  });

  // The detailed source always wins where both have the period, or a full
  // column would be replaced by a two-field one.
  test('never lets a partial row overwrite a full one', () => {
    const out = mergeStatementRows(ts, legacy);
    const q1 = out.find(r => r.endDate === '2026-03-31');
    assert.equal(q1.eps, 0.34);
    assert.ok(!q1.partial);
  });

  test('returns the detailed rows untouched when legacy adds nothing', () => {
    assert.deepEqual(mergeStatementRows(ts, []), ts);
  });

  // AAPL on 2026-08-07: the legacy endpoint was a quarter BEHIND.
  test('survives a legacy source with nothing new to add', () => {
    const behind = [{ endDate: '2025-12-31', label: "Q4 '25", sortKey: 3, revenue: 1, partial: true }];
    assert.deepEqual(mergeStatementRows(ts, behind), ts);
  });

  test('works when the detailed source is empty', () => {
    assert.deepEqual(mergeStatementRows([], legacy).map(r => r.endDate), ['2026-03-31', '2026-06-30']);
  });

  test('keeps the result oldest-first', () => {
    const out = mergeStatementRows([ts[1]], [legacy[1], legacy[0]]);
    assert.deepEqual(out.map(r => r.sortKey), [4, 5]);
  });
});

// ─── SEC XBRL statement extraction ───────────────────────────────────────────
// Yahoo's timeseries can be a quarter behind (see above) while the 10-Q is
// already public. These facts are PLTR's real 2026-06-30 quarter as filed on
// 2026-08-04, trimmed to the tags the statement needs, plus an amended earlier
// value to pin down which one wins.
const PLTR_FACTS = {
  facts: {
    'us-gaap': {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: { USD: [
          { start: '2026-04-01', end: '2026-06-30', val: 1935464000, form: '10-Q', filed: '2026-08-04' },
          { start: '2026-01-01', end: '2026-06-30', val: 3568047000, form: '10-Q', filed: '2026-08-04' }, // H1, must be ignored
          { start: '2026-01-01', end: '2026-03-31', val: 1632583000, form: '10-Q', filed: '2026-05-05' },
        ] },
      },
      CostOfRevenue: { units: { USD: [{ start: '2026-04-01', end: '2026-06-30', val: 296870000, form: '10-Q', filed: '2026-08-04' }] } },
      GrossProfit: { units: { USD: [{ start: '2026-04-01', end: '2026-06-30', val: 1638594000, form: '10-Q', filed: '2026-08-04' }] } },
      OperatingExpenses: { units: { USD: [{ start: '2026-04-01', end: '2026-06-30', val: 726590000, form: '10-Q', filed: '2026-08-04' }] } },
      OperatingIncomeLoss: { units: { USD: [{ start: '2026-04-01', end: '2026-06-30', val: 912004000, form: '10-Q', filed: '2026-08-04' }] } },
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: {
        units: { USD: [{ start: '2026-04-01', end: '2026-06-30', val: 1081345000, form: '10-Q', filed: '2026-08-04' }] },
      },
      IncomeTaxExpenseBenefit: { units: { USD: [{ start: '2026-04-01', end: '2026-06-30', val: 15383000, form: '10-Q', filed: '2026-08-04' }] } },
      NetIncomeLoss: { units: { USD: [
        { start: '2026-04-01', end: '2026-06-30', val: 1061890000, form: '10-Q', filed: '2026-08-04' },
        // An original filing later amended — the restated value must win.
        { start: '2026-01-01', end: '2026-03-31', val: 870000000, form: '10-Q', filed: '2026-05-05' },
        { start: '2026-01-01', end: '2026-03-31', val: 870527000, form: '10-Q/A', filed: '2026-06-01' },
      ] } },
      EarningsPerShareDiluted: { units: { 'USD/shares': [{ start: '2026-04-01', end: '2026-06-30', val: 0.41, form: '10-Q', filed: '2026-08-04' }] } },
    },
  },
};

describe('secStatementRows', () => {
  const rows = () => secStatementRows(PLTR_FACTS, true);

  test('builds the quarter Yahoo had not published', () => {
    const q2 = rows().find(r => r.endDate === '2026-06-30');
    assert.equal(q2.label, "Q2 '26");
    assert.equal(q2.revenue, 1935464000);
    assert.equal(q2.costOfRevenue, 296870000);
    assert.equal(q2.grossProfit, 1638594000);
    assert.equal(q2.operatingExpense, 726590000);
    assert.equal(q2.operatingIncome, 912004000);
    assert.equal(q2.pretaxIncome, 1081345000);
    assert.equal(q2.tax, 15383000);
    assert.equal(q2.netIncome, 1061890000);
    assert.equal(q2.eps, 0.41);
  });

  // The half-year column sits in the same tag with the same end date. Counting
  // it as the quarter would overstate revenue by 84%.
  test('ignores the year-to-date fact sharing the quarter end date', () => {
    assert.equal(rows().find(r => r.endDate === '2026-06-30').revenue, 1935464000);
  });

  test('prefers the most recently filed value for a restated period', () => {
    assert.equal(rows().find(r => r.endDate === '2026-03-31').netIncome, 870527000);
  });

  test('derives margins from the filed figures', () => {
    const q2 = rows().find(r => r.endDate === '2026-06-30');
    assert.ok(Math.abs(q2.grossMargin - 84.66) < 0.01, `gross margin was ${q2.grossMargin}`);
    assert.ok(Math.abs(q2.operatingMargin - 47.12) < 0.01, `operating margin was ${q2.operatingMargin}`);
    assert.ok(Math.abs(q2.netMargin - 54.86) < 0.01, `net margin was ${q2.netMargin}`);
  });

  // A full row, unlike the quoteSummary fallback — so it must not be marked.
  test('is a complete row, not a partial one', () => {
    assert.ok(!rows().find(r => r.endDate === '2026-06-30').partial);
    assert.equal(rows().find(r => r.endDate === '2026-06-30').source, 'SEC');
  });

  test('returns rows oldest-first', () => {
    assert.deepEqual(rows().map(r => r.endDate), ['2026-03-31', '2026-06-30']);
  });

  test('returns nothing for facts with no us-gaap block', () => {
    assert.deepEqual(secStatementRows({ facts: {} }, true), []);
    assert.deepEqual(secStatementRows(null, true), []);
  });

  // Annual durations are ~365 days, so the quarterly pass must not pick them up
  // and the annual pass must not pick up quarters.
  test('separates annual periods from quarterly ones', () => {
    const annualFacts = { facts: { 'us-gaap': { Revenues: { units: { USD: [
      { start: '2025-01-01', end: '2025-12-31', val: 5000000000, form: '10-K', filed: '2026-02-15' },
      { start: '2025-10-01', end: '2025-12-31', val: 1406802000, form: '10-K', filed: '2026-02-15' },
    ] } } } } };
    assert.deepEqual(secStatementRows(annualFacts, false).map(r => r.label), ['FY 2025']);
    assert.deepEqual(secStatementRows(annualFacts, true).map(r => r.label), ["Q4 '25"]);
  });
});

describe('mergeStatementRows — keeping the table the right shape', () => {
  const ts = [
    { endDate: '2025-12-31', label: "Q4 '25", sortKey: Date.parse('2025-12-31'), revenue: 1 },
    { endDate: '2026-03-31', label: "Q1 '26", sortKey: Date.parse('2026-03-31'), revenue: 2 },
  ];

  // Apple's fiscal quarters end on a Saturday and Yahoo normalises to month
  // end, so the same quarter arrives as 2026-03-28 and 2026-03-31. Keyed on
  // the exact date they both survived and the table showed one quarter twice.
  test('treats period ends a few days apart as the same period', () => {
    const sec = [{ endDate: '2026-03-28', label: "Q1 '26", sortKey: Date.parse('2026-03-28'), revenue: 2 }];
    assert.deepEqual(mergeStatementRows(ts, sec), ts);
  });

  test('still appends a genuinely later period ending off-month', () => {
    const sec = [{ endDate: '2026-06-27', label: "Q2 '26", sortKey: Date.parse('2026-06-27'), revenue: 3 }];
    assert.deepEqual(mergeStatementRows(ts, sec).map(r => r.endDate), ['2025-12-31', '2026-03-31', '2026-06-27']);
  });

  // SEC carries years of filings. The fallback exists to extend the series
  // forward to periods the primary has not published, not to rewrite its
  // history — appending everything turned a 6-column table into 22 (72 for
  // AAPL), which is a different page, not a fixed one.
  test('does not backfill history older than the primary source', () => {
    const sec = [
      { endDate: '2021-03-31', label: "Q1 '21", sortKey: Date.parse('2021-03-31'), revenue: 0 },
      { endDate: '2021-06-30', label: "Q2 '21", sortKey: Date.parse('2021-06-30'), revenue: 0 },
      { endDate: '2026-06-30', label: "Q2 '26", sortKey: Date.parse('2026-06-30'), revenue: 3 },
    ];
    assert.deepEqual(mergeStatementRows(ts, sec).map(r => r.endDate), ['2025-12-31', '2026-03-31', '2026-06-30']);
  });

  // Yahoo down entirely: the fallback has to carry the tab, but capped to
  // roughly the window Yahoo would have returned rather than every filing.
  test('caps the fallback when there is no primary data at all', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      endDate: `20${10 + i}-06-30`, label: `Q2 '${10 + i}`, sortKey: Date.parse(`20${10 + i}-06-30`), revenue: i,
    }));
    const out = mergeStatementRows([], many);
    assert.equal(out.length, 8);
    assert.equal(out[out.length - 1].endDate, '2039-06-30', 'keeps the most recent, not the oldest');
  });
});
