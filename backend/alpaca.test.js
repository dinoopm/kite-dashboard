const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  TNX_RANGES, TNX_DEFAULT_RANGE, tnxRangeConfig,
  mapLegacyStatementRow, mergeStatementRows,
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
